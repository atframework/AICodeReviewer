import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ResolvedSearchTgrepConfig } from "@aicr/core";
import type { WorkspaceLayout } from "@aicr/core";

/**
 * tgrep code-search cache manager (architecture §3.17).
 *
 * Why a workspace-level checkout: the per-run source tree (`runs/<id>/source`)
 * only contains changed files and is deleted after every run, so an index
 * anchored there would be both incomplete and short-lived. Instead each
 * workspace owns one persistent cache under `<instanceRoot>/.tgrep-cache/`:
 *
 * - `checkout/` — a full working tree of the reviewed head, refreshed via
 *   `git archive <rev> | tar -x` whenever the head revision changes (and on
 *   TTL expiry). tgrep's own watcher then refreshes the index incrementally.
 * - `index/`    — the tgrep on-disk trigram index (`--index-path`).
 * - `meta.json` — schema version, head revision, timestamps, server pid.
 *
 * A long-lived `tgrep serve` (poll mode) per workspace keeps the index warm
 * across runs. The checkout is mounted read-only into container sandboxes so
 * every agent CLI (and the native-llm `aicr.search_code` tool) searches the
 * same per-repository index. All failures degrade to "unavailable" — the
 * review still runs with plain `rg` / `aicr.fetch_more_context`.
 *
 * Cleanup: a periodic sweep deletes caches unused for `cleanup_after_days`;
 * orphaned servers from a previous AICR process are reaped via the recorded
 * pid (tgrep's own `serve.lock` prevents two servers on one index).
 */

export const TGREP_CACHE_DIR_NAME = ".tgrep-cache";

/** Slug for external `search.tgrep.data_dir` caches (one directory per workspace). */
export function tgrepCacheSlug(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[._]+|[._]+$/gu, "");
  const hash = createHash("sha256").update(workspaceId).digest("hex").slice(0, 8);
  return `${safe.slice(0, 80) || "workspace"}-${hash}`;
}
const META_FILE = "meta.json";
const CHECKOUT_DIR = "checkout";
const INDEX_DIR = "index";
/** tgrep status polling while the initial index build completes. */
const INDEX_READY_TIMEOUT_MS = 120_000;
const SERVE_POLL_INTERVAL_SECONDS = 2;

export interface TgrepSearchHandle {
  readonly enabled: boolean;
  readonly state: "ready" | "degraded";
  /** Cache root holding `checkout/` and `index/` (host path). */
  readonly cacheRoot: string;
  /** Full checkout of the reviewed head (host path). */
  readonly checkoutDir: string;
  /** tgrep index directory (host path). */
  readonly indexDir: string;
  readonly detail?: string;
}

export interface TgrepPrepareInput {
  readonly workspaceId: string;
  readonly layout: WorkspaceLayout;
  /** Git clone cache (object store) holding the reviewed revision. */
  readonly sourceRoot: string;
  readonly revision: string;
}

interface CacheMeta {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly revision?: string;
  readonly lastUsedAt: string;
  readonly lastIndexedAt?: string;
  readonly serverPid?: number;
}

interface ActiveServer {
  readonly child: ChildProcess;
  readonly startedAt: number;
}

export interface TgrepIndexManagerOptions {
  readonly config: ResolvedSearchTgrepConfig;
  readonly spawnProcess?: typeof spawn;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly logger?: (record: {
    level: "info" | "warn";
    msg: string;
    [key: string]: unknown;
  }) => void;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class TgrepIndexManager {
  private readonly config: ResolvedSearchTgrepConfig;
  private readonly spawnProcess: typeof spawn;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly log: NonNullable<TgrepIndexManagerOptions["logger"]>;
  private readonly servers = new Map<string, ActiveServer>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: TgrepIndexManagerOptions) {
    this.config = options.config;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.now = options.now ?? Date.now;
    this.log =
      options.logger ??
      ((record) => console[record.level](JSON.stringify(record)));
  }

  cacheRootFor(input: { workspaceId: string; layout: WorkspaceLayout }): string {
    return this.config.dataDir !== undefined
      ? join(this.config.dataDir, tgrepCacheSlug(input.workspaceId))
      : join(input.layout.instanceRoot, TGREP_CACHE_DIR_NAME);
  }

  /** Prepare (or refresh) the workspace index; never throws for env failures. */
  async prepare(input: TgrepPrepareInput): Promise<TgrepSearchHandle> {
    const cacheRoot = this.cacheRootFor(input);
    const base = {
      enabled: this.config.enabled,
      cacheRoot,
      checkoutDir: join(cacheRoot, CHECKOUT_DIR),
      indexDir: join(cacheRoot, INDEX_DIR),
    };
    if (!this.config.enabled)
      return { ...base, state: "degraded", detail: "disabled" };
    return this.serialize(input.workspaceId, async () => {
      try {
        return await this.prepareLocked(input, cacheRoot, base);
      } catch (error) {
        this.log({
          level: "warn",
          msg: "tgrep index unavailable; review falls back to plain search",
          workspaceId: input.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ...base,
          state: "degraded" as const,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  private async prepareLocked(
    input: TgrepPrepareInput,
    cacheRoot: string,
    base: {
      enabled: boolean;
      cacheRoot: string;
      checkoutDir: string;
      indexDir: string;
    },
  ): Promise<TgrepSearchHandle> {
    await mkdir(cacheRoot, { recursive: true });
    const meta = await this.readMeta(cacheRoot);
    const expired =
      meta?.lastIndexedAt !== undefined &&
      this.now() - Date.parse(meta.lastIndexedAt) > this.config.indexTtlMs;
    const revisionChanged = meta?.revision !== input.revision;

    // Reap a server orphaned by a previous AICR process before touching the
    // index; tgrep refuses to start on a live serve.lock.
    if (meta?.serverPid !== undefined && !this.isProcessAlive(meta.serverPid)) {
      await this.stopRecordedServer(cacheRoot, meta.serverPid);
    }

    if (revisionChanged || expired || meta === undefined) {
      await this.refreshCheckout(
        input.sourceRoot,
        input.revision,
        base.checkoutDir,
      );
      // A rebuilt checkout invalidates the running server's view; restart so
      // startup reconciliation re-reads changed files promptly.
      await this.stopServer(input.workspaceId);
    }

    let server = this.servers.get(input.workspaceId);
    if (server && !this.isProcessAlive(server.child.pid ?? -1)) {
      this.servers.delete(input.workspaceId);
      server = undefined;
    }
    if (!server) {
      server = await this.startServer(
        input.workspaceId,
        base.checkoutDir,
        base.indexDir,
      );
      this.servers.set(input.workspaceId, server);
      await this.waitForIndex(
        input.workspaceId,
        base.checkoutDir,
        base.indexDir,
      );
    }

    const timestamp = new Date(this.now()).toISOString();
    const nextMeta: CacheMeta = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      revision: input.revision,
      lastUsedAt: timestamp,
      lastIndexedAt:
        revisionChanged || expired || meta === undefined
          ? timestamp
          : (meta.lastIndexedAt ?? timestamp),
      ...(server.child.pid !== undefined
        ? { serverPid: server.child.pid }
        : {}),
    };
    await this.writeMeta(cacheRoot, nextMeta);
    return { ...base, state: "ready" };
  }

  /** Periodic cleanup: reap dead servers and expire external-root caches. */
  async sweep(): Promise<void> {
    for (const [workspaceId, server] of [...this.servers]) {
      if (!this.isProcessAlive(server.child.pid ?? -1))
        this.servers.delete(workspaceId);
    }
    if (this.config.dataDir === undefined) return;
    let entries;
    try {
      entries = await readdir(this.config.dataDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await this.sweepCacheRoot(join(this.config.dataDir, entry.name));
    }
  }

  /** Remove one workspace cache after the workspace itself was deleted. */
  async removeCache(input: { workspaceId: string; layout: WorkspaceLayout }): Promise<void> {
    const cacheRoot = this.cacheRootFor(input);
    const meta = await this.readMeta(cacheRoot);
    if (meta?.serverPid !== undefined && this.isProcessAlive(meta.serverPid)) {
      try {
        process.kill(meta.serverPid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await rm(cacheRoot, { recursive: true, force: true });
  }

  /** Sweep every cache root under a workspaces root (startup housekeeping). */
  async sweepWorkspacesRoot(workspacesRoot: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(workspacesRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.sweepInstanceRoot(join(workspacesRoot, entry.name));
    }
  }

  private async sweepInstanceRoot(root: string): Promise<void> {
    // Layouts differ (legacy `<root>/<id>` vs isolated `<root>/instances/<id>`);
    // walk shallowly and only touch directories that actually hold a cache.
    const candidates = [root, join(root, "instances")];
    for (const candidate of candidates) {
      let entries;
      try {
        entries = await readdir(candidate, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(candidate, entry.name);
        if (entry.name === TGREP_CACHE_DIR_NAME) {
          await this.sweepCacheRoot(dir);
        } else if (entry.name !== "instances") {
          await this.sweepCacheRoot(join(dir, TGREP_CACHE_DIR_NAME));
        }
      }
    }
  }

  private async sweepCacheRoot(cacheRoot: string): Promise<void> {
    const meta = await this.readMeta(cacheRoot);
    if (!meta) return;
    const lastUsed = Date.parse(meta.lastUsedAt);
    if (
      !Number.isFinite(lastUsed) ||
      this.now() - lastUsed < this.config.cleanupAfterMs
    )
      return;
    if (meta.serverPid !== undefined && this.isProcessAlive(meta.serverPid))
      return;
    if ([...this.servers.keys()].includes(meta.workspaceId)) return;
    await rm(cacheRoot, { recursive: true, force: true }).catch(() => {});
    this.log({
      level: "info",
      msg: "tgrep cache expired and removed",
      workspaceId: meta.workspaceId,
      cacheRoot,
    });
  }

  async dispose(): Promise<void> {
    for (const workspaceId of [...this.servers.keys()]) {
      await this.stopServer(workspaceId);
    }
  }

  private serialize<T>(
    workspaceId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(workspaceId, next);
    void next
      .finally(() => {
        if (this.locks.get(workspaceId) === next)
          this.locks.delete(workspaceId);
      })
      .catch(() => {});
    return next as Promise<T>;
  }

  /** Full checkout of `revision` from the clone cache into `checkoutDir`. */
  private async refreshCheckout(
    sourceRoot: string,
    revision: string,
    checkoutDir: string,
  ): Promise<void> {
    const staging = `${checkoutDir}.staging`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await this.runCommand(
        "git",
        ["--git-dir", sourceRoot, "archive", revision],
        staging,
      );
      await rm(checkoutDir, { recursive: true, force: true });
      await rename(staging, checkoutDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** `git archive <rev>` piped into `tar -x` inside the staging directory. */
  private runCommand(
    command: string,
    args: readonly string[],
    extractDir: string,
  ): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const producer = this.spawnProcess(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const consumer = this.spawnProcess("tar", ["-x", "-C", extractDir], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      producer.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      consumer.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      producer.stdout?.pipe(consumer.stdin!);
      const timer = setTimeout(() => {
        producer.kill("SIGKILL");
        consumer.kill("SIGKILL");
        rejectPromise(new Error("git archive checkout timed out"));
      }, this.config.buildTimeoutMs);
      let producerDone = false;
      let consumerDone = false;
      let failed = false;
      const fail = (message: string): void => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        producer.kill("SIGKILL");
        consumer.kill("SIGKILL");
        rejectPromise(new Error(message));
      };
      const maybeFinish = (): void => {
        if (producerDone && consumerDone && !failed) {
          clearTimeout(timer);
          resolvePromise();
        }
      };
      producer.on("error", () =>
        fail(`cannot execute ${command}; tgrep indexing requires git`),
      );
      consumer.on("error", () =>
        fail("cannot execute tar; tgrep checkout extraction requires tar"),
      );
      producer.on("exit", (code) => {
        if (code !== 0) {
          fail(
            `git archive failed (${stderr.trim().split("\n")[0] ?? `exit ${code}`})`,
          );
          return;
        }
        producerDone = true;
        maybeFinish();
      });
      consumer.on("exit", (code) => {
        if (code !== 0) {
          fail(
            `tar extraction failed (${stderr.trim().split("\n")[0] ?? `exit ${code}`})`,
          );
          return;
        }
        consumerDone = true;
        maybeFinish();
      });
    });
  }

  private async startServer(
    workspaceId: string,
    checkoutDir: string,
    indexDir: string,
  ): Promise<ActiveServer> {
    await mkdir(indexDir, { recursive: true });
    const child = this.spawnProcess(
      "tgrep",
      [
        "serve",
        checkoutDir,
        "--index-path",
        indexDir,
        "--watch-mode",
        "poll",
        "--poll-interval",
        String(SERVE_POLL_INTERVAL_SECONDS),
      ],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    child.on("error", () => {
      this.servers.delete(workspaceId);
    });
    if (child.pid === undefined) {
      throw new Error(
        "tgrep serve did not start (is the tgrep binary installed in the image?)",
      );
    }
    this.log({
      level: "info",
      msg: "tgrep server started",
      workspaceId,
      pid: child.pid,
      checkoutDir,
      indexDir,
    });
    return { child, startedAt: this.now() };
  }

  private async stopServer(workspaceId: string): Promise<void> {
    const server = this.servers.get(workspaceId);
    this.servers.delete(workspaceId);
    const pid = server?.child.pid;
    if (pid === undefined || !this.isProcessAlive(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private async stopRecordedServer(
    cacheRoot: string,
    pid: number,
  ): Promise<void> {
    // The recorded process is dead; only tgrep's lock needs clearing. tgrep
    // removes a stale serve.lock itself on startup, so nothing to do here
    // beyond logging the reap for observability.
    this.log({
      level: "info",
      msg: "reaped orphaned tgrep server record",
      cacheRoot,
      pid,
    });
  }

  private async waitForIndex(
    workspaceId: string,
    checkoutDir: string,
    indexDir: string,
  ): Promise<void> {
    const deadline = this.now() + INDEX_READY_TIMEOUT_MS;
    for (;;) {
      const status = await this.runTgrepStatus(checkoutDir, indexDir);
      if (status !== undefined && /Indexing:\s+complete/u.test(status)) return;
      if (this.now() >= deadline) {
        this.log({
          level: "warn",
          msg: "tgrep initial index still building; searches will scan until complete",
          workspaceId,
        });
        return;
      }
      await delay(2_000);
    }
  }

  private runTgrepStatus(
    checkoutDir: string,
    indexDir: string,
  ): Promise<string | undefined> {
    return new Promise((resolvePromise) => {
      const child = this.spawnProcess(
        "tgrep",
        ["status", checkoutDir, "--index-path", indexDir],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise(undefined);
      }, 15_000);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolvePromise(undefined);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolvePromise(code === 0 ? stdout : undefined);
      });
    });
  }

  private async readMeta(cacheRoot: string): Promise<CacheMeta | undefined> {
    try {
      return JSON.parse(
        await readFile(join(cacheRoot, META_FILE), "utf8"),
      ) as CacheMeta;
    } catch {
      return undefined;
    }
  }

  private async writeMeta(cacheRoot: string, meta: CacheMeta): Promise<void> {
    const target = join(cacheRoot, META_FILE);
    const staging = `${target}.tmp`;
    await writeFile(staging, JSON.stringify(meta, null, 2), "utf8");
    await rename(staging, target);
  }
}

/**
 * Task-context guidance injected into every review with a ready index.
 * `sandboxCheckoutDir` is the read-only mount path visible to the agent
 * (container sandboxes); native sandboxes use the host checkout path.
 */
export function buildTgrepGuidance(
  handle: TgrepSearchHandle,
  sandboxCacheRoot?: string,
): string {
  if (!handle.enabled || handle.state !== "ready") {
    return "Code search: the tgrep index is unavailable for this run; use `rg` on materialized files and `aicr.fetch_more_context` for specific paths.";
  }
  const checkoutDir = sandboxCacheRoot
    ? `${sandboxCacheRoot}/checkout`
    : handle.checkoutDir;
  const indexDir = sandboxCacheRoot
    ? `${sandboxCacheRoot}/index`
    : handle.indexDir;
  return [
    "Code search: this repository has a persistent per-workspace tgrep trigram index covering the full reviewed head (not only the changed files).",
    `- Search via the aicr.search_code tool (pattern, optional path_glob/case_insensitive/max_results), or shell: tgrep --index-path ${indexDir} -- "<pattern>" ${checkoutDir}`,
    `- The indexed full checkout is at ${checkoutDir} (read-only reference; the changed files you report on still live in the run's source directory).`,
    "Prefer the index for repository-wide or repeated searches; the index refreshes asynchronously, so verify the exact current line with aicr.fetch_more_context or rg before reporting a problem.",
  ].join("\n");
}

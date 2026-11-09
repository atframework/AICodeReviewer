import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import type { ResolvedSearchTgrepConfig, WorkspaceLayout } from "@aicr/core";

export const TGREP_CACHE_DIR_NAME = ".tgrep-cache";
export const TGREP_SANDBOX_MOUNT_PATH = "/workspace/tgrep-cache";
const SANDBOX_CHECKOUT = `${TGREP_SANDBOX_MOUNT_PATH}/checkout`;
const SANDBOX_INDEX = `${TGREP_SANDBOX_MOUNT_PATH}/index`;
const READY_FILE = "ready.json";
const SNAPSHOT_PREFIX = "aicr-tgrep-";

export interface TgrepSearchHandle {
  readonly enabled: boolean;
  readonly state: "ready" | "degraded";
  readonly cacheRoot: string;
  readonly checkoutDir: string;
  readonly indexDir: string;
  readonly sandboxIndexDir?: string;
  readonly detail?: string;
  readonly release?: () => void;
}

export interface TgrepPrepareInput {
  readonly workspaceId: string;
  readonly layout: WorkspaceLayout;
  /** The ordinary --no-checkout clone used by the Git adapter. */
  readonly sourceRoot: string;
  readonly revision: string;
  readonly signal?: AbortSignal | undefined;
}

interface SnapshotMeta {
  readonly identity: string;
  readonly revision: string;
  readonly builtAt: number;
}

export interface TgrepIndexManagerOptions {
  readonly config: ResolvedSearchTgrepConfig;
  readonly spawnProcess?: typeof spawn;
  readonly now?: () => number;
  readonly logger?: (record: {
    level: "warn";
    msg: string;
    [key: string]: unknown;
  }) => void;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function snapshotPaths(cacheRoot: string) {
  return {
    cacheRoot,
    checkoutDir: join(cacheRoot, "checkout"),
    indexDir: join(cacheRoot, "index"),
    sandboxIndexDir: join(cacheRoot, "sandbox-index"),
  };
}

function waitForCommand(child: ChildProcess, command: string): Promise<void> {
  return new Promise((resolveCommand, reject) => {
    child.once("error", () => reject(new Error(`${command} could not run`)));
    child.once("close", (code) => {
      if (code === 0) resolveCommand();
      else reject(new Error(`${command} failed (exit ${code})`));
    });
  });
}

/**
 * Share immutable Git snapshots between reviews of the same source and head.
 * A review holds its snapshot through follow-ups and sandbox teardown. Cache
 * storage is local to the server, like the Git clone and run directories.
 */
export class TgrepIndexManager {
  private readonly config: ResolvedSearchTgrepConfig;
  private readonly spawnProcess: typeof spawn;
  private readonly now: () => number;
  private readonly log: NonNullable<TgrepIndexManagerOptions["logger"]>;
  private readonly leases = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: TgrepIndexManagerOptions) {
    this.config = options.config;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? Date.now;
    this.log =
      options.logger ?? ((record) => console.warn(JSON.stringify(record)));
  }

  cacheRootFor(input: {
    workspaceId: string;
    layout: WorkspaceLayout;
  }): string {
    if (this.config.dataDir === undefined)
      return join(input.layout.instanceRoot, TGREP_CACHE_DIR_NAME);
    const safeId = input.workspaceId.replace(/[^A-Za-z0-9_-]+/gu, "_");
    const hash = createHash("sha256")
      .update(resolve(input.layout.instanceRoot))
      .digest("hex")
      .slice(0, 16);
    return join(this.config.dataDir, `${safeId.slice(0, 80)}-${hash}`);
  }

  async prepare(input: TgrepPrepareInput): Promise<TgrepSearchHandle> {
    const cacheRoot = this.cacheRootFor(input);
    const degraded = {
      ...snapshotPaths(cacheRoot),
      enabled: this.config.enabled,
      state: "degraded" as const,
    };
    if (!this.config.enabled) return { ...degraded, detail: "disabled" };

    return this.serialize(cacheRoot, async () => {
      try {
        input.signal?.throwIfAborted();
        await mkdir(cacheRoot, { recursive: true });
        if (!(await lstat(cacheRoot)).isDirectory())
          throw new Error("tgrep cache must be a directory, without symlinks");
        const identity = await realpath(input.sourceRoot);
        let snapshot = await this.findSnapshot(
          cacheRoot,
          identity,
          input.revision,
        );
        if (snapshot === undefined) {
          snapshot = await this.buildSnapshot(cacheRoot, identity, input);
        }
        const now = new Date(this.now());
        await utimes(join(snapshot, READY_FILE), now, now);
        return {
          ...snapshotPaths(snapshot),
          enabled: true,
          state: "ready",
          release: this.lease(snapshot),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log({
          level: "warn",
          msg: "tgrep index unavailable; review falls back to plain search",
          workspaceId: input.workspaceId,
          error: detail,
        });
        return { ...degraded, detail };
      }
    });
  }

  private async findSnapshot(
    cacheRoot: string,
    identity: string,
    revision: string,
  ): Promise<string | undefined> {
    let latest: { path: string; builtAt: number } | undefined;
    for (const name of await directories(cacheRoot)) {
      if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
      const path = join(cacheRoot, name);
      const meta = (await readJson(join(path, READY_FILE))) as
        SnapshotMeta | undefined;
      if (
        meta?.identity === identity &&
        meta.revision === revision &&
        this.now() - meta.builtAt < this.config.indexTtlMs &&
        (!latest || meta.builtAt > latest.builtAt)
      ) {
        const { indexDir, sandboxIndexDir, checkoutDir } = snapshotPaths(path);
        const available = await Promise.all(
          [
            checkoutDir,
            join(indexDir, "meta.json"),
            join(sandboxIndexDir, "meta.json"),
          ].map((item) => stat(item).catch(() => undefined)),
        );
        if (available.every(Boolean)) latest = { path, builtAt: meta.builtAt };
      }
    }
    return latest?.path;
  }

  private async buildSnapshot(
    cacheRoot: string,
    identity: string,
    input: TgrepPrepareInput,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(this.config.buildTimeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    await this.run("tgrep", ["--version"], signal);
    // tgrep records the absolute checkout root, so build at its final path.
    // ready.json is written last. Readers ignore incomplete generations.
    const snapshot = await mkdtemp(join(cacheRoot, SNAPSHOT_PREFIX));
    const { checkoutDir, indexDir, sandboxIndexDir } = snapshotPaths(snapshot);
    try {
      await mkdir(checkoutDir);
      await this.archive(input.sourceRoot, input.revision, checkoutDir, signal);
      await this.run(
        "tgrep",
        [
          "index",
          "--no-ignore",
          "--hidden",
          "--index-path",
          indexDir,
          checkoutDir,
        ],
        signal,
      );
      await this.createSandboxIndex(indexDir, sandboxIndexDir);
      signal.throwIfAborted();
      const meta: SnapshotMeta = {
        identity,
        revision: input.revision,
        builtAt: this.now(),
      };
      await writeFile(join(snapshot, READY_FILE), JSON.stringify(meta));
      return snapshot;
    } catch (error) {
      await rm(snapshot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async createSandboxIndex(
    indexDir: string,
    sandboxIndexDir: string,
  ): Promise<void> {
    // tgrep v1.2.7 resolves IndexMeta.root_path before using an on-disk index.
    // Share the immutable posting files and give the sandbox its own metadata.
    const meta = (await readJson(join(indexDir, "meta.json"))) as
      { root_path?: unknown; complete?: unknown } | undefined;
    if (typeof meta?.root_path !== "string" || meta.complete !== true)
      throw new Error("tgrep did not publish a complete index");
    await mkdir(sandboxIndexDir);
    for (const name of [
      "files.bin",
      "files-extra.bin",
      "index.bin",
      "lookup.bin",
    ]) {
      const source = join(indexDir, name);
      const target = join(sandboxIndexDir, name);
      try {
        await link(source, target);
      } catch (error) {
        if (
          !["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        await copyFile(source, target);
      }
    }
    await writeFile(
      join(sandboxIndexDir, "meta.json"),
      JSON.stringify({ ...meta, root_path: SANDBOX_CHECKOUT }),
    );
  }

  private async run(
    command: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await waitForCommand(
      this.spawnProcess(command, args, {
        signal,
        killSignal: "SIGKILL",
        stdio: "ignore",
      }),
      `${command} ${args[0]}`,
    );
  }

  private async archive(
    sourceRoot: string,
    revision: string,
    checkoutDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const producer = this.spawnProcess(
      "git",
      [
        "-C",
        sourceRoot,
        "archive",
        "--format=tar",
        "--end-of-options",
        revision,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const consumer = this.spawnProcess("tar", ["-x", "-C", checkoutDir], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const jobs = [
      waitForCommand(producer, "git archive"),
      waitForCommand(consumer, "tar extraction"),
      pipeline(producer.stdout!, consumer.stdin!, { signal }),
    ];
    try {
      await Promise.all(jobs);
    } catch (error) {
      producer.kill("SIGKILL");
      consumer.kill("SIGKILL");
      await Promise.allSettled(jobs);
      throw error;
    }
  }

  private lease(snapshot: string): () => void {
    this.leases.set(snapshot, (this.leases.get(snapshot) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.leases.get(snapshot) ?? 1;
      if (count === 1) this.leases.delete(snapshot);
      else this.leases.set(snapshot, count - 1);
    };
  }

  async sweep(): Promise<void> {
    if (this.config.dataDir === undefined) return;
    for (const name of await directories(this.config.dataDir)) {
      await this.sweepCacheRoot(join(this.config.dataDir, name));
    }
  }

  async sweepWorkspacesRoot(workspacesRoot: string): Promise<void> {
    for (const name of await directories(workspacesRoot)) {
      const path = join(workspacesRoot, name);
      if (name === TGREP_CACHE_DIR_NAME) await this.sweepCacheRoot(path);
      else if (
        ![
          "source",
          "agent",
          "runs",
          "tmp",
          "context-repos",
          "templates",
          ".metadata",
        ].includes(name)
      )
        await this.sweepWorkspacesRoot(path);
    }
  }

  private async sweepCacheRoot(cacheRoot: string): Promise<void> {
    await this.serialize(cacheRoot, async () => {
      const snapshots: { path: string; lastUsed: number; identity?: string }[] =
        [];
      for (const name of await directories(cacheRoot)) {
        if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
        const path = join(cacheRoot, name);
        const readyPath = join(path, READY_FILE);
        const [ready, meta] = await Promise.all([
          stat(readyPath).catch(() => undefined),
          readJson(readyPath) as Promise<SnapshotMeta | undefined>,
        ]);
        const lastUsed = ready ?? (await stat(path).catch(() => undefined));
        if (lastUsed)
          snapshots.push({
            path,
            lastUsed: lastUsed.mtimeMs,
            ...(typeof meta?.identity === "string"
              ? { identity: meta.identity }
              : {}),
          });
      }
      const retained = new Set<string>();
      for (const snapshot of snapshots.sort(
        (a, b) => b.lastUsed - a.lastUsed,
      )) {
        const superseded =
          snapshot.identity !== undefined && retained.has(snapshot.identity);
        if (snapshot.identity !== undefined) retained.add(snapshot.identity);
        if (
          !this.leases.has(snapshot.path) &&
          (superseded ||
            this.now() - snapshot.lastUsed >= this.config.cleanupAfterMs)
        ) {
          await rm(snapshot.path, { recursive: true, force: true });
        }
      }
      // Retire the old daemon-based layout after its retention period. Never
      // signal a PID from disk, which may have been reused by another process.
      const legacyFile = join(cacheRoot, "meta.json");
      const legacy = (await readJson(legacyFile)) as
        { schemaVersion?: number; lastUsedAt?: string } | undefined;
      if (
        legacy?.schemaVersion === 1 &&
        legacy.lastUsedAt &&
        this.now() - Date.parse(legacy.lastUsedAt) >= this.config.cleanupAfterMs
      ) {
        await rm(join(cacheRoot, "checkout"), { recursive: true, force: true });
        await rm(join(cacheRoot, "index"), { recursive: true, force: true });
        await rm(legacyFile, { force: true });
      }
    });
  }

  private async serialize<T>(
    cacheRoot: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(cacheRoot) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(cacheRoot, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(cacheRoot) === next) this.locks.delete(cacheRoot);
    }
  }
}

export function tgrepSearchPaths(
  handle: TgrepSearchHandle,
  container: boolean,
) {
  return container
    ? { checkoutDir: SANDBOX_CHECKOUT, indexDir: SANDBOX_INDEX }
    : { checkoutDir: handle.checkoutDir, indexDir: handle.indexDir };
}

/** Advertise only the search surfaces usable by this review route. */
export function buildTgrepGuidance(
  handle: TgrepSearchHandle | undefined,
  route: "host-tools" | "native" | "container",
): string {
  if (
    handle?.state !== "ready" ||
    (route === "container" && handle.sandboxIndexDir === undefined)
  ) {
    return "Indexed search is unavailable for this run. Use read-only search on materialized files if you have shell access, or request specific paths with aicr.fetch_more_context.";
  }
  const { checkoutDir, indexDir } = tgrepSearchPaths(
    handle,
    route === "container",
  );
  return [
    "Indexed search is available for this Git revision. Use aicr.search_code to locate related source. Its results are excerpts, so read the relevant current source before reporting.",
    ...(route === "host-tools"
      ? [
          "Submit aicr.search_code as a JSON tool call and wait for its results in the next pass.",
        ]
      : [
          `Read-only Git snapshot at ${JSON.stringify(checkoutDir)}. If tgrep is installed in this sandbox, use tgrep --hidden --index-path ${JSON.stringify(indexDir)} -- "<pattern>" ${JSON.stringify(checkoutDir)}.`,
          "If the sandbox cannot execute indexed search, submit aicr.search_code using the JSON tool-call format and wait for the host result in the next pass.",
        ]),
  ].join("\n");
}

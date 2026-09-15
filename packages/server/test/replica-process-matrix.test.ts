/**
 * Independent-process publish/crash-recovery matrix (P7): the replica fault
 * scenarios of replica-fault-matrix.test.ts replayed across REAL OS child
 * server processes (tsx-loaded repo source, see test/fixtures/replica-child.mts)
 * driven over real HTTP, with a child-side activation barrier for crash timing.
 *
 * Leg 1 (always): two child replicas A/B over one shared SQLite config file
 *   (+ shared receipts file, admin sessions in the same config DB). Covers
 *   cross-process adoption without a refresh call and a SIGKILL in the
 *   commit→install publish window with post-restart convergence and
 *   cross-process operationId dedup. The child acknowledges the exact
 *   commit-before-install barrier before the parent kills it.
 * Leg 2 (skipIf no postgres binaries): a throwaway initdb cluster on a
 *   scratch port is SIGKILLed under child C — a REAL network outage, not a
 *   mocked rejection — then restarted on the same port; C must 503
 *   (config_unavailable/store_unavailable) during the outage with zero
 *   external fetch attempts (control-file shim) and recover pinned to the
 *   same revision snapshot.
 * Leg 3 (skipIf no redis-server): the same outage shape against a dedicated
 *   appendonly redis-server child; the pre-outage head must survive the
 *   SIGKILL and C must recover pinned to it.
 *
 * Child protocol: argv = JSON config path; stdout emits
 * {"event":"ready","port":N}; SIGTERM is graceful (see replica-child.mts).
 * Wall budget: ~120 s for the whole file.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  configSnapshotId,
  createPgConfigStore,
  createRedisConfigStore,
  createSqliteConfigStore,
  type ConfigStore,
} from "@aicr/core";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CHILD_ENTRY = join(REPO_ROOT, "packages/server/test/fixtures/replica-child.mts");

const NAMESPACE = "replica-process";
const DIGEST = "d".repeat(64);
const WEBHOOK_SECRET = "replica-process-secret";
const ADMIN = { username: "admin", password: "admin-password" };

// Hyper-V excluded port ranges on this workstation (never rebind these).
const EXCLUDED_PORT_RANGES: readonly (readonly [number, number])[] = [
  [49455, 49554],
  [50000, 50059],
  [54081, 54180],
  [55682, 56482],
];

/**
 * Real wall-clock waits are unavoidable in this file by design: every poll
 * awaits a condition owned by a SEPARATE OS process (child server boot,
 * postgres crash recovery, redis AOF reload, cross-process SQLite
 * visibility). Fake timers cannot advance another process's clock, and the
 * awaited conditions (readiness log lines, port status, durable store
 * state) are all real — see pollUntil/startChild/startPostgres.
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve: wake } = Promise.withResolvers<void>();
  setTimeout(wake, ms);
  return promise;
}

async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    if (port > 0 && !EXCLUDED_PORT_RANGES.some(([lo, hi]) => port >= lo && port <= hi)) return port;
  }
}

// ---------------------------------------------------------------------------
// Child server process management
// ---------------------------------------------------------------------------

type ConfigStoreSpec =
  | { kind: "sqlite"; path: string }
  | { kind: "pg"; url: string; schema?: string }
  | { kind: "redis"; url: string; prefix?: string };

interface ChildConfig {
  port: number;
  namespace: string;
  fileDigest: string;
  baseDir: string;
  webhookSecret: string;
  admin: { username: string; password: string };
  configStore: ConfigStoreSpec;
  receipts: { path: string };
  controlFile?: string;
  pauseBeforeInstallRevision?: number;
}

interface ChildHandle {
  readonly proc: ChildProcess;
  readonly port: number;
  readonly base: string;
  output(): string;
  /** SIGKILL and await exit. */
  kill(): Promise<void>;
}

const children: ChildHandle[] = [];

function writeChildConfig(dir: string, name: string, config: ChildConfig): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

async function startChild(configPath: string, port: number): Promise<ChildHandle> {
  const proc = spawn(process.execPath, ["--import", "tsx", CHILD_ENTRY, configPath], {
    cwd: REPO_ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
  proc.stderr?.on("data", (chunk: Buffer) => { output += String(chunk); });
  const handle: ChildHandle = {
    proc,
    port,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    async kill() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = once(proc, "exit");
      proc.kill("SIGKILL");
      await exited;
    },
  };
  const deadline = Date.now() + 60_000;
  while (!output.includes('"event":"ready"')) {
    if (proc.exitCode !== null) {
      throw new Error(`replica child exited before ready (code ${proc.exitCode}):\n${output}`);
    }
    if (Date.now() > deadline) {
      await handle.kill();
      throw new Error(`replica child did not become ready within 60s:\n${output}`);
    }
    await sleep(100);
  }
  children.push(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// Real-HTTP client helpers
// ---------------------------------------------------------------------------

async function login(base: string): Promise<string> {
  const response = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string };
  return body.token;
}

function publishBody(operationId: string, providerId: string, baseRevision: number | null): string {
  return JSON.stringify({
    baseRevision,
    fileDigest: DIGEST,
    operationId,
    operations: [
      { op: "create", collection: "providers", record: { id: providerId, name: providerId, enabled: true, value: { id: providerId, kind: "ollama" } } },
    ],
  });
}

async function publishChangeset(base: string, token: string, operationId: string, providerId: string, baseRevision: number | null): Promise<Response> {
  return fetch(`${base}/api/admin/config/changesets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: publishBody(operationId, providerId, baseRevision),
  });
}

let pushCounter = 0;

/** Distinct coverage per call: identical pushes dedup to the first receipt. */
function giteaPushPayload(): string {
  pushCounter += 1;
  const head = createHmac("sha1", "coverage").update(`${Date.now()}-${pushCounter}`).digest("hex");
  return JSON.stringify({
    ref: "refs/heads/main",
    before: "1".repeat(40),
    after: head,
    repository: { full_name: "owent/example" },
    pusher: { login: "owent", email: "owent@example.com" },
    commits: [{ id: head }],
  });
}

interface WebhookResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

async function postPush(base: string): Promise<WebhookResult> {
  const payload = giteaPushPayload();
  const response = await fetch(`${base}/webhooks/gitea`, {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      "x-gitea-event": "push",
      "x-gitea-signature": createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex"),
    },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { status: response.status, body };
}

function receiptIdOf(result: WebhookResult): string {
  const processing = result.body?.["processing"] as { receiptId?: string } | undefined;
  expect(processing?.receiptId, `webhook must return a receipt id: ${JSON.stringify(result.body)}`).toBeTypeOf("string");
  return processing!.receiptId!;
}

async function receiptSnapshot(base: string, token: string, receiptId: string): Promise<string | null> {
  const response = await fetch(`${base}/api/admin/auto-commit/receipts/${receiptId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { receipt?: { configSnapshotId?: string | null } };
  return body.receipt?.configSnapshotId ?? null;
}

interface OperationStatus {
  readonly httpStatus: number;
  readonly status?: string;
  readonly revision?: { revision?: number };
}

async function getOperation(base: string, token: string, operationId: string): Promise<OperationStatus> {
  const response = await fetch(`${base}/api/admin/config/operations/${operationId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({})) as { status?: string; revision?: { revision?: number } };
  return { httpStatus: response.status,
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.revision !== undefined ? { revision: body.revision } : {}),
  };
}

async function readyzStatus(base: string): Promise<number> {
  const response = await fetch(`${base}/readyz`);
  return response.status;
}

// ---------------------------------------------------------------------------
// Polling helpers (bounded, descriptive)
// ---------------------------------------------------------------------------

async function pollUntil<T>(description: string, timeoutMs: number, step: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await step();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`poll timed out (${timeoutMs}ms): ${description}${lastError instanceof Error ? ` — last error: ${lastError.message}` : ""}`);
    }
    await sleep(250);
  }
}

/**
 * Post pushes to a child until one is admitted (202) whose receipt pins a
 * snapshot accepted by `match`. Returns the pinned snapshot id.
 */
async function pollWebhookSnapshot(
  base: string,
  token: string,
  description: string,
  timeoutMs: number,
  match: (snapshot: string | null) => boolean,
): Promise<string | null> {
  return pollUntil(description, timeoutMs, async () => {
    const result = await postPush(base).catch(() => undefined);
    if (!result || result.status !== 202) return undefined;
    const snapshot = await receiptSnapshot(base, token, receiptIdOf(result));
    return match(snapshot) ? snapshot : undefined;
  });
}

async function pollWebhook503(base: string, description: string, timeoutMs: number): Promise<WebhookResult> {
  return pollUntil(description, timeoutMs, async () => {
    const result = await postPush(base).catch(() => undefined);
    return result && result.status === 503 ? result : undefined;
  });
}

/** Expected snapshot id of a committed revision, computed from the durable record. */
async function expectedSnapshotOf(store: ConfigStore, revision: number): Promise<string> {
  const record = await store.readRevision(NAMESPACE, revision);
  expect(record, `revision ${revision} must be readable`).not.toBeNull();
  return configSnapshotId(record!);
}

// ---------------------------------------------------------------------------
// Backend binary probes and daemon management
// ---------------------------------------------------------------------------

function probePath(binary: string): string | undefined {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [binary], { encoding: "utf8" });
  if (probe.status !== 0) return undefined;
  const first = probe.stdout.split(/\r?\n/u).map(line => line.trim()).find(line => line.length > 0);
  return first && existsSync(first) ? first : undefined;
}

interface PgBinaries {
  readonly dir: string;
  readonly initdb: string;
  readonly postgres: string;
  readonly pgCtl: string;
}

function findPostgresBinaries(): PgBinaries | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates: string[] = [];
  const onPath = probePath(`initdb${ext}`) ?? probePath("initdb");
  if (onPath) candidates.push(dirname(onPath));
  candidates.push(join(homedir(), "scoop", "apps", "postgresql", "current", "bin"));
  for (const dir of candidates) {
    const binaries = {
      dir,
      initdb: join(dir, `initdb${ext}`),
      postgres: join(dir, `postgres${ext}`),
      pgCtl: join(dir, `pg_ctl${ext}`),
    };
    if (existsSync(binaries.initdb) && existsSync(binaries.postgres)) return binaries;
  }
  return undefined;
}

function findRedisServer(): string | undefined {
  const fromEnv = process.env.AICR_REDIS_SERVER_EXECUTABLE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return probePath(process.platform === "win32" ? "redis-server.exe" : "redis-server") ?? probePath("redis-server");
}

interface DaemonHandle {
  readonly proc: ChildProcess;
  output(): string;
  /** Forced tree kill (real outage). */
  kill(): Promise<void>;
  /** Graceful stop (cleanup path). */
  stop(): Promise<void>;
}

const daemons: DaemonHandle[] = [];

async function killProcessTree(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, "exit").catch(() => undefined);
  if (process.platform === "win32") {
    // /T: postgres children die with the postmaster so the port is freed.
    await execFileAsync("taskkill", ["/PID", String(proc.pid), "/T", "/F"]).catch(() => undefined);
  } else {
    proc.kill("SIGKILL");
  }
  await Promise.race([exited, sleep(10_000)]);
}

async function startPostgres(binaries: PgBinaries, dataDir: string, port: number): Promise<DaemonHandle> {
  // lc_messages=C: the readiness marker below is the English log line; the
  // default locale on this workstation renders it in zh-CN (GBK bytes).
  const proc = spawn(binaries.postgres, [
    "-D", dataDir, "-p", String(port),
    "-c", "listen_addresses=127.0.0.1",
    "-c", "lc_messages=C",
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_MESSAGES: "C" },
  });
  let output = "";
  proc.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
  proc.stderr?.on("data", (chunk: Buffer) => { output += String(chunk); });
  const handle: DaemonHandle = {
    proc,
    output: () => output,
    async kill() { await killProcessTree(proc); },
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      await execFileAsync(binaries.pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "20"]).catch(async () => {
        await killProcessTree(proc);
      });
    },
  };
  const deadline = Date.now() + 60_000;
  while (!output.includes("ready to accept connections")) {
    if (proc.exitCode !== null) throw new Error(`postgres exited before ready (code ${proc.exitCode}):\n${output}`);
    if (Date.now() > deadline) {
      await handle.kill();
      throw new Error(`postgres did not become ready within 60s:\n${output}`);
    }
    await sleep(100);
  }
  daemons.push(handle);
  return handle;
}

/** `D:\\x\\y` → `/cygdrive/d/x/y` for MSYS2/cygwin redis builds. */
function toCygdrive(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(path);
  const slashed = path.replaceAll("\\", "/");
  return match ? `/cygdrive/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}` : slashed;
}

function writeRedisConf(dir: string, port: number, pathForm: "native" | "cygdrive"): string {
  const path = join(dir, "redis.conf");
  writeFileSync(path, [
    `port ${port}`,
    "bind 127.0.0.1",
    `dir ${pathForm === "cygdrive" ? toCygdrive(dir) : dir.replaceAll("\\", "/")}`,
    "appendonly yes",
    "appendfsync everysec",
    'save ""',
    "",
  ].join("\n"));
  return path;
}

async function startRedis(executable: string, confPath: string, dir: string, port: number): Promise<DaemonHandle> {
  const makeHandle = (proc: ChildProcess, getOutput: () => string): DaemonHandle => ({
    proc,
    output: getOutput,
    async kill() { await killProcessTree(proc); },
    async stop() { await killProcessTree(proc); },
  });
  let output = "";
  const capture = (chunk: Buffer): void => { output += String(chunk); };
  const spawnRedis = (confArg: string): ChildProcess => {
    const proc = spawn(executable, [confArg], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout?.on("data", capture);
    proc.stderr?.on("data", capture);
    return proc;
  };
  let confArg = confPath;
  let proc = spawnRedis(confArg);
  let deadline = Date.now() + 30_000;
  for (;;) {
    if (output.includes("Ready to accept connections")) break;
    if (proc.exitCode !== null) {
      // Scoop/MSYS2 redis builds interpret Windows paths in the cygwin
      // namespace; retry once with /cygdrive forms (conf arg AND the dir
      // directive inside the conf).
      if (process.platform === "win32" && confArg === confPath && output.includes("can't open config file")) {
        writeRedisConf(dir, port, "cygdrive");
        confArg = toCygdrive(confPath);
        output = "";
        proc = spawnRedis(confArg);
        deadline = Date.now() + 30_000;
        continue;
      }
      throw new Error(`redis-server exited before ready (code ${proc.exitCode}):\n${output}`);
    }
    if (Date.now() > deadline) {
      const stalled = makeHandle(proc, () => output);
      await stalled.kill();
      throw new Error(`redis-server did not become ready within 30s:\n${output}`);
    }
    await sleep(100);
  }
  const handle = makeHandle(proc, () => output);
  daemons.push(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// Shared teardown
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const testStores: ConfigStore[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await child.kill().catch(() => undefined);
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  for (const store of testStores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

function freshDir(tag: string): string {
  const scratch = join(REPO_ROOT, "build", "tmp");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, `aicr-process-matrix-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

function sqliteChildConfig(dir: string, name: string, port: number, pauseBeforeInstallRevision?: number): { configPath: string; configDb: string; receiptsDb: string } {
  const configDb = join(dir, "config.sqlite");
  const receiptsDb = join(dir, "receipts.sqlite");
  const configPath = writeChildConfig(dir, name, {
    port,
    namespace: NAMESPACE,
    fileDigest: DIGEST,
    baseDir: dir,
    webhookSecret: WEBHOOK_SECRET,
    admin: ADMIN,
    configStore: { kind: "sqlite", path: configDb },
    receipts: { path: receiptsDb },
    ...(pauseBeforeInstallRevision !== undefined ? { pauseBeforeInstallRevision } : {}),
  });
  return { configPath, configDb, receiptsDb };
}

// ---------------------------------------------------------------------------
// Leg 1: cross-process adoption + crash recovery (SQLite shared)
// ---------------------------------------------------------------------------

describe("independent-process publish/crash recovery", () => {
  it("leg 1: cross-process adoption and SIGKILL crash-window recovery over shared SQLite", async () => {
    const dir = freshDir("sqlite");
    const portA = await freePort();
    const portB = await freePort();
    const childAConfig = sqliteChildConfig(dir, "child-a.json", portA, 2);
    const childBConfig = sqliteChildConfig(dir, "child-b.json", portB);

    // Dedicated test-side connection: reads the shared store without any
    // server refresh call, WAL reader beside the two child writers.
    const probeStore = await createSqliteConfigStore({ path: childAConfig.configDb });
    testStores.push(probeStore);

    const [a, b] = await Promise.all([
      startChild(childAConfig.configPath, portA),
      startChild(childBConfig.configPath, portB),
    ]);

    const tokenA = await login(a.base);

    // Baseline: B accepts a push pinned to the pre-publication generation.
    const baselineSnapshot = await pollWebhookSnapshot(b.base, tokenA, "B baseline webhook", 15_000, () => true);

    // A publishes revision 1 over real login+changeset HTTP.
    const published = await publishChangeset(a.base, tokenA, "op-revision-1", "db-main", null);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ status: "committed", revision: { revision: 1 } });
    const snapshot1 = await expectedSnapshotOf(probeStore, 1);

    // WITHOUT any refresh call, B's webhook admission adopts rev 1 and pins
    // its snapshot on the receipt.
    const adopted = await pollWebhookSnapshot(b.base, tokenA, "B adoption of rev 1", 15_000, snapshot => snapshot === snapshot1);
    expect(adopted).toBe(snapshot1);
    expect(adopted).not.toBe(baselineSnapshot);

    // A acknowledges its blocked install only AFTER the real rev-2 commit.
    // The response must remain pending, so this cannot pass by killing a
    // process that has already installed and returned success.
    let responseSettled = false;
    const inFlight = publishChangeset(a.base, tokenA, "op-revision-2", "db-second", 1).then(
      response => { responseSettled = true; return { response }; },
      (error: unknown) => { responseSettled = true; return { error }; },
    );
    await pollUntil("A blocked before revision 2 activation", 10_000, async () =>
      a.output().includes('"event":"before-install","revision":2') ? true : undefined);
    expect((await probeStore.readHead(NAMESPACE))?.activeRevision).toBe(2);
    expect(responseSettled).toBe(false);
    await a.kill();
    const settled = await inFlight;
    expect(settled).toHaveProperty("error");

    // Restart A without the test barrier, on the same port and persisted files.
    sqliteChildConfig(dir, "child-a.json", portA);
    const a2 = await startChild(childAConfig.configPath, portA);

    const revisions = await probeStore.listRevisions(NAMESPACE, { limit: 10 });

    // Exactly one rev-2 revision across both processes — no duplicate.
    expect(revisions).toHaveLength(2);
    expect(revisions.filter(revision => revision.revision === 2)).toHaveLength(1);
    const snapshot2 = await expectedSnapshotOf(probeStore, 2);

    // Retrying the same operationId against B dedups: same committed result,
    // and still no third revision.
    const deduped = await publishChangeset(b.base, tokenA, "op-revision-2", "db-second", 1);
    expect(deduped.status).toBe(200);
    expect(await deduped.json()).toMatchObject({ status: "committed", revision: { revision: 2 } });
    expect(await probeStore.listRevisions(NAMESPACE, { limit: 10 })).toHaveLength(2);

    // The restarted A reports the operation committed (a transient
    // committed_activating → committed convergence is allowed).
    const operation = await pollUntil("A reports op-revision-2 committed", 20_000, async () => {
      const status = await getOperation(a2.base, tokenA, "op-revision-2").catch(() => undefined);
      if (!status) return undefined;
      if (status.httpStatus === 202) {
        expect(status.status).toBe("committed_activating");
        return undefined;
      }
      return status.httpStatus === 200 ? status : undefined;
    });
    expect(operation.status).toBe("committed");
    expect(operation.revision?.revision).toBe(2);

    // A's webhook now 202s pinned to rev 2's snapshot.
    const pinned = await pollWebhookSnapshot(a2.base, tokenA, "A pinned to rev 2", 15_000, snapshot => snapshot === snapshot2);
    expect(pinned).toBe(snapshot2);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Leg 2: real network outage against a throwaway postgres child
  // -------------------------------------------------------------------------

  const PG_BINARIES = findPostgresBinaries();

  it.skipIf(!PG_BINARIES)("leg 2: real postgres outage — 503 without external work, recovery pinned to the same revision", async () => {
    const binaries = PG_BINARIES!;
    const dir = freshDir("pg");
    const dataDir = join(dir, "pgdata");
    const pwfile = join(dir, "pgpass.txt");
    writeFileSync(pwfile, "aicr\n");
    await execFileAsync(binaries.initdb, [
      "-D", dataDir, "-U", "aicr", "--pwfile", pwfile, "-A", "scram-sha-256", "-E", "UTF8", "--no-sync",
      // Pin English server messages in postgresql.conf (see startPostgres).
      "--lc-messages=C",
    ], { timeout: 120_000, windowsHide: true, env: { ...process.env, LC_MESSAGES: "C" } });

    const pgPort = await freePort();
    const pgUrl = `postgres://aicr:aicr@127.0.0.1:${pgPort}/postgres`;
    const pg = await startPostgres(binaries, dataDir, pgPort);

    const controlFile = join(dir, "fetch-control.log");
    const port = await freePort();
    const configPath = writeChildConfig(dir, "child-c.json", {
      port,
      namespace: NAMESPACE,
      fileDigest: DIGEST,
      baseDir: dir,
      webhookSecret: WEBHOOK_SECRET,
      admin: ADMIN,
      configStore: { kind: "pg", url: pgUrl, schema: "matrix" },
      receipts: { path: join(dir, "receipts.sqlite") },
      controlFile,
    });
    const c = await startChild(configPath, port);
    const token = await login(c.base);

    // Test-side observer on the scratch cluster (ours; schema-isolated).
    const probeStore = await createPgConfigStore({ connection: { url: pgUrl }, schema: "matrix" });
    testStores.push(probeStore);

    // Baseline, then publish rev 1 and let C adopt it.
    const baselineSnapshot = await pollWebhookSnapshot(c.base, token, "C baseline webhook", 15_000, () => true);
    const published = await publishChangeset(c.base, token, "op-pg-rev1", "db-main", null);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ status: "committed", revision: { revision: 1 } });
    const snapshot1 = await expectedSnapshotOf(probeStore, 1);
    const pinnedBefore = await pollWebhookSnapshot(c.base, token, "C pinned to rev 1", 15_000, snapshot => snapshot === snapshot1);
    expect(pinnedBefore).toBe(snapshot1);
    expect(pinnedBefore).not.toBe(baselineSnapshot);

    // REAL outage: forced tree kill of the throwaway cluster (never mocked).
    await pg.kill();

    // During the outage every admission fails: webhook 503s with
    // config_unavailable / store_unavailable, and readyz agrees.
    const rejected = await pollWebhook503(c.base, "C webhook 503 during pg outage", 20_000);
    expect(rejected.body).toMatchObject({ accepted: false, reason: "config_unavailable" });
    expect(String(rejected.body?.["message"])).toContain("store_unavailable");
    await pollUntil("C readyz 503 during pg outage", 10_000, async () =>
      (await readyzStatus(c.base).catch(() => 0)) === 503 ? true : undefined);

    // The 503 happens at the admission barrier, BEFORE any profile/provider
    // work: the child's fetch shim recorded zero external attempts.
    const externalAttempts = existsSync(controlFile) ? readFileSync(controlFile, "utf8").trim() : "";
    expect(externalAttempts).toBe("");

    // Restart the cluster on the same port; C reconnects and recovers pinned
    // to the same revision snapshot.
    await startPostgres(binaries, dataDir, pgPort);
    const pinnedAfter = await pollWebhookSnapshot(c.base, token, "C recovered pinned to rev 1", 30_000, snapshot => snapshot === snapshot1);
    expect(pinnedAfter).toBe(snapshot1);
    expect(await readyzStatus(c.base)).toBe(200);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Leg 3: redis availability against a dedicated redis-server child
  // -------------------------------------------------------------------------

  const REDIS_SERVER = findRedisServer();

  it.skipIf(!REDIS_SERVER)("leg 3: redis outage — 503, then recovery pinned to the pre-outage head (data survived)", async () => {
    const executable = REDIS_SERVER!;
    const dir = freshDir("redis");
    const redisPort = await freePort();
    const confPath = writeRedisConf(dir, redisPort, "native");
    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    const redis = await startRedis(executable, confPath, dir, redisPort);

    const port = await freePort();
    const configPath = writeChildConfig(dir, "child-d.json", {
      port,
      namespace: NAMESPACE,
      fileDigest: DIGEST,
      baseDir: dir,
      webhookSecret: WEBHOOK_SECRET,
      admin: ADMIN,
      configStore: { kind: "redis", url: redisUrl, prefix: "matrix:" },
      receipts: { path: join(dir, "receipts.sqlite") },
    });
    const d = await startChild(configPath, port);
    const token = await login(d.base);

    const probeStore = await createRedisConfigStore({ connection: { url: redisUrl }, prefix: "matrix:" });
    testStores.push(probeStore);

    // Publish rev 1 and let D adopt it.
    const published = await publishChangeset(d.base, token, "op-redis-rev1", "db-main", null);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ status: "committed", revision: { revision: 1 } });
    const snapshot1 = await expectedSnapshotOf(probeStore, 1);
    const pinnedBefore = await pollWebhookSnapshot(d.base, token, "D pinned to rev 1", 15_000, snapshot => snapshot === snapshot1);
    expect(pinnedBefore).toBe(snapshot1);

    // Real outage: SIGKILL the dedicated redis-server.
    await redis.kill();
    const rejected = await pollWebhook503(d.base, "D webhook 503 during redis outage", 20_000);
    expect(rejected.body).toMatchObject({ accepted: false, reason: "config_unavailable" });
    await pollUntil("D readyz 503 during redis outage", 10_000, async () =>
      (await readyzStatus(d.base).catch(() => 0)) === 503 ? true : undefined);

    // Restart on the same port against the same appendonly directory: the
    // pre-outage head survived, and D recovers pinned to it.
    await startRedis(executable, confPath, dir, redisPort);
    expect((await probeStore.readHead(NAMESPACE))?.activeRevision).toBe(1);
    const pinnedAfter = await pollWebhookSnapshot(d.base, token, "D recovered pinned to rev 1", 30_000, snapshot => snapshot === snapshot1);
    expect(pinnedAfter).toBe(snapshot1);
    expect(await readyzStatus(d.base)).toBe(200);
  }, 150_000);
});

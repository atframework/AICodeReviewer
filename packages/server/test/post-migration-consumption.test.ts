/**
 * P7 combination acceptance: after an old-data database is upgraded in place
 * by the CURRENT code (migrations applied at open), a full server bootstrapped
 * against that database consumes a NEW signed webhook event through a real
 * review — per config/store backend.
 *
 * Three legs, one file, disjoint seeding:
 * - sqlite (ungated): ONE file holding (a) the business store at the real
 *   001–006 ledger plus legacy review-run rows (the M02 fixture state) and
 *   (b) the config namespace at the real 001 ledger plus a valid revision-1
 *   document and immutable snapshot in the 001 shape (the E08 fixture state).
 *   Bootstrap must advance both ledgers (007–010 business, 002 config),
 *   preserve legacy accounting while expiring old details, and a signed PR webhook must drive a review
 *   whose HTTP requests carry the MIGRATED revision's provider base_url and
 *   model. A changeset-API publish of revision 2 (model swap) then drives a
 *   second webhook on the new head.
 * - postgres (AICR_PG_TEST_URL): one random schema seeded with the business
 *   STORE_MIGRATION_PLAN fully applied, one legacy review_runs row, and the
 *   config 001 ledger + seeds; the server bootstraps with
 *   storage.database.kind=postgres (schema pinned via the connection string's
 *   `options` startup parameter) and passes the same new-event consumption
 *   assertions.
 * - redis (redis-server executable on PATH or AICR_REDIS_SERVER_EXECUTABLE):
 *   a DEDICATED child redis-server (scratch port, appendonly always, tmp dir)
 *   backs the config store; revision 1 is published through the real
 *   changeset API, the child is SIGKILLed and restarted on the same port/dir,
 *   and a signed webhook then consumes the pre-restart revision — proving
 *   service-restart persistence and post-restart consumption in one flow.
 *
 * External HTTP is intercepted by a fetch spy and the VCS layer uses a
 * deterministic fixture; agent CLI/sandbox execution is disabled to select
 * the direct-LLM path (same seams as config-e2e-publish-review.test.ts).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { freeLoopbackPort as findFreePort } from "./fixtures/loopback-port.js";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFIG_RESOLVER_VERSION,
  CONFIG_STORE_MIGRATIONS,
  CONFIG_STORE_NAMESPACE,
  MigrationRunner,
  PG_CONFIG_STORE_MIGRATIONS,
  configSnapshotId,
  contentHashOf,
  createPgConfigMigrationStore,
  createPgConfigStore,
  createRedisConfigStore,
  createSqliteConfigStore,
  createSqliteMigrationStore,
  parseConfigDocumentText,
  prepareConfigPublication,
  type ConfigChangesetOperation,
  type ConfigStore,
  type LoadedConfigDocument,
} from "@aicr/core";
import {
  STORE_MIGRATION_PLAN,
  STORE_SQLITE_MIGRATIONS,
  closeStoreDb,
  createStoreDb,
  getRecentRuns,
  getOverviewStats,
} from "@aicr/store";
import { parseUnifiedDiff, type ChangeRange } from "@aicr/vcs";
import { bootstrapServerApp } from "../src/bootstrap.js";
import { createServerApp, type ServerAppOptions } from "../src/index.js";
import type {
  DiffCapableVcsAdapter,
  ReviewOrchestrationContext,
  ServerReviewOrchestrationOptions,
} from "../src/review-orchestrator.js";

// better-sqlite3 and pg are dependencies of @aicr/store (not of @aicr/server);
// anchor the require at the store package so raw seeding connections resolve.
const storeRequire = createRequire(new URL("../../store/package.json", import.meta.url));

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T & { immediate: T };
  close(): void;
}
const Database = storeRequire("better-sqlite3") as new (path: string) => SqliteDatabase;

interface PgQueryResult {
  readonly rows: Record<string, unknown>[];
}
interface PgClient {
  query(text: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}
const PgPoolCtor = storeRequire("pg").Pool as new (config: {
  connectionString: string;
  max: number;
  options?: string;
}) => PgPool;

const NAMESPACE = "post-migration-consumption";
const T0 = 1_800_000_000_000;
const SUMMARY_SENTINEL = "post-migration review summary sentinel.";
const REDIS_URL_ENV = "AICR_POST_MIGRATION_REDIS_URL";

const PG_TEST_URL = process.env.AICR_PG_TEST_URL;
const describePg = PG_TEST_URL ? describe : describe.skip;

function resolveRedisServerExecutable(): string | undefined {
  const fromEnv = process.env.AICR_REDIS_SERVER_EXECUTABLE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    for (const name of ["redis-server.exe", "redis-server"]) {
      const candidate = join(entry, name);
      if (existsSync(candidate)) {
        const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
        if (!probe.error && probe.status === 0) return candidate;
      }
    }
  }
  return undefined;
}
const REDIS_SERVER_EXECUTABLE = resolveRedisServerExecutable();
const describeRedisServer = REDIS_SERVER_EXECUTABLE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// File document: same raw source for bootstrap and for the seeded revision —
// feeding the publish a different document than the server conceals bugs.
// ---------------------------------------------------------------------------

const FILE_DOCUMENT = {
  llm: {
    providers: [
      { id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
    ],
    model_chain: { default: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }] },
  },
  triggers: [
    { name: "gitea-internal", kind: "gitea", base_url: "https://gitea.example.com", webhook_secret_env: "GITEA_SECRET" },
  ],
};

function fileText(options: {
  readonly database: unknown;
  readonly cache: unknown;
  readonly backend: "storage" | "redis";
  readonly objectRoot: string;
}): string {
  return JSON.stringify({
    ...FILE_DOCUMENT,
    llm: { ...FILE_DOCUMENT.llm, model_catalog: { enabled: false } },
    storage: {
      database: options.database,
      cache: options.cache,
      object: { kind: "filesystem", filesystem: { root: options.objectRoot } },
      retention: { deleted_project_grace_days: 30 },
    },
    queue: { kind: "memory" },
    admin: { username_env: "AICR_ADMIN_USERNAME", password_env: "AICR_ADMIN_PASSWORD" },
    config_sources: {
      database: { enabled: true, backend: options.backend, namespace: NAMESPACE },
      runtime: { refresh_interval_seconds: 5 },
    },
  });
}

// ---------------------------------------------------------------------------
// Shared per-test state and cleanup (mirrors config-e2e-publish-review).
// ---------------------------------------------------------------------------

let dir: string;
let bootstrapped: ServerAppOptions | undefined;
const extraClosers: Array<() => Promise<void>> = [];
const children: ChildProcess[] = [];
const originalEnv: Record<string, string | undefined> = {};
const MANAGED_ENV = [
  "OPENAI_API_KEY",
  "GITEA_TOKEN",
  "GITEA_SECRET",
  "AICR_ADMIN_USERNAME",
  "AICR_ADMIN_PASSWORD",
  REDIS_URL_ENV,
];

beforeEach(() => {
  mkdirSync("build/tmp", { recursive: true });
  dir = mkdtempSync(join(process.cwd(), "build/tmp/aicr-post-migration-"));
  for (const name of MANAGED_ENV) {
    originalEnv[name] = process.env[name];
  }
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GITEA_TOKEN = "test-token";
  process.env.GITEA_SECRET = "test-secret";
  process.env.AICR_ADMIN_USERNAME = "admin";
  process.env.AICR_ADMIN_PASSWORD = "admin-password";
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (bootstrapped) {
    await bootstrapped.closeAutoCommit?.();
    // The dynamic-config store doubles as the session store; one close frees
    // the handles so Windows can remove the temp directory.
    await bootstrapped.sessionStore?.close();
    if (bootstrapped.store) await closeStoreDb(bootstrapped.store);
    bootstrapped = undefined;
  }
  for (const closer of extraClosers.splice(0)) {
    await closer().catch(() => undefined);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) {
      const { promise, resolve } = Promise.withResolvers<void>();
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
      await promise;
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function bootstrapParsed(file: LoadedConfigDocument): Promise<ServerAppOptions> {
  const options = await bootstrapServerApp({
    config: file.config,
    baseSystemPrompt: "test",
    baseDir: dir,
    configDocument: { document: file.document, digest: file.digest },
  });
  bootstrapped = options;
  return options;
}

/** Tracks an extra store handle so afterEach closes it exactly once. */
function trackStore<T extends ConfigStore>(store: T): T {
  extraClosers.push(() => store.close());
  return store;
}

// ---------------------------------------------------------------------------
// Changeset API publish + signed webhook (config-e2e-publish-review pattern).
// ---------------------------------------------------------------------------

async function publishOperations(
  options: ServerAppOptions,
  store: ConfigStore,
  operations: readonly ConfigChangesetOperation[],
): Promise<void> {
  const app = createServerApp(options);
  const login = await app.request("/api/admin/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  expect(login.status).toBe(200);
  const { token } = await login.json() as { token: string };
  const head = await store.readHead(NAMESPACE);
  const response = await app.request("/api/admin/config/changesets", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({
    baseRevision: head?.activeRevision ?? null,
    operationId: `op-${Math.random().toString(36).slice(2, 10)}`,
    fileDigest: options.configApi!.fileDigest,
    operations,
  }) });
  const result: unknown = await response.json();
  expect(result).toMatchObject({ status: "committed" });
  expect(response.status).toBe(200);
}

interface WebhookRunSummary {
  readonly status?: string;
  readonly problemCount?: number;
  readonly configVersion?: {
    readonly configSnapshotId?: string | null;
    readonly databaseRevision?: number | null;
    readonly fileDigest?: string | null;
    readonly routeId?: string;
  };
}

interface WebhookResponseBody {
  readonly accepted?: boolean;
  readonly outcome?: string;
  readonly reviewRun?: WebhookRunSummary;
}

async function postPullRequest(options: ServerAppOptions): Promise<{ status: number; body: WebhookResponseBody }> {
  const app = createServerApp({ ...options, asyncTriggers: false, reviewOrchestration: reviewOptions(options, createFakeVcs()) });
  const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/repo" },
    pull_request: { number: 7, base: { sha: "base", ref: "main" }, head: { sha: "head", ref: "feature" }, user: { login: "owent" } } });
  const response = await app.request("/webhooks/gitea", { method: "POST", body, headers: {
    "content-type": "application/json", "x-gitea-event": "pull_request",
    "x-gitea-signature": createHmac("sha256", "test-secret").update(body).digest("hex"),
  } });
  return { status: response.status, body: await response.json() as WebhookResponseBody };
}

// ---------------------------------------------------------------------------
// Fetch spy: every external call is captured; unknown URLs fail fast.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

function stubFetch(captured: CapturedRequest[]): void {
  vi.stubGlobal("fetch", async (url: string | URL, init?: { method?: string; body?: string }) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    captured.push({ method, url: target, ...(body !== undefined ? { body } : {}) });
    if (target.includes("/chat/completions")) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: SUMMARY_SENTINEL }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    }
    if (target.includes("/reviews")) {
      return new Response(JSON.stringify({ id: 7 }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in test: ${method} ${target}`);
  });
}

/** Narrowed one-off field read on a captured JSON body (type guard, no cast trust). */
function bodyField(request: CapturedRequest | undefined, key: string): unknown {
  const body = request?.body;
  if (body && typeof body === "object" && key in body) {
    return (body as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Deterministic VCS seam; model clients and publishers use the intercepted HTTP path. */
function createFakeVcs(): DiffCapableVcsAdapter {
  return {
    kind: "git",
    async listChanges(): Promise<ChangeRange> {
      return { baseRevision: "base", headRevision: "head", files: ["src/app.ts"] };
    },
    async fetchScoped(range: ChangeRange, ws: { id: string; sourceDir: string }) {
      const filePath = join(ws.sourceDir, "src/app.ts");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, "const value = oldValue();\ncommitBeforeReturn();\n", "utf8");
      return { workspaceId: ws.id, rootDir: ws.sourceDir, fetchedFiles: [...range.files] };
    },
    async fetchExtraContext(req: { path: string }) {
      return { path: req.path, content: "extra context" };
    },
    async diff() {
      return parseUnifiedDiff(
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1,2 @@",
          " const value = oldValue();",
          "+commitBeforeReturn();",
        ].join("\n"),
      );
    },
  };
}

/**
 * Production orchestration options with two test-only substitutions applied
 * AFTER the production optionsResolver ran: the VCS adapter is faked and the
 * agent CLI/sandbox path is disabled, selecting the direct-LLM completion
 * path whose HTTP request the fetch spy captures.
 */
function reviewOptions(options: ServerAppOptions, vcs: DiffCapableVcsAdapter): ServerReviewOrchestrationOptions {
  const base = options.reviewOrchestration!;
  const resolve = base.optionsResolver!;
  const { agentAdapter: _baseAgent, sandboxFactory: _baseSandbox, ...baseRest } = base;
  return {
    ...baseRest,
    optionsResolver: async (context: ReviewOrchestrationContext) => {
      const resolved = await resolve(context);
      const { agentAdapter: _agent, sandboxFactory: _sandbox, ...rest } = resolved;
      return { ...rest, vcs, vcsFactory: () => vcs };
    },
  };
}

// ---------------------------------------------------------------------------
// Config entity operations (same shapes as the e2e publish harness).
// ---------------------------------------------------------------------------

function workspaceOperation(): ConfigChangesetOperation {
  return { op: "create", collection: "workspaces", record: { id: "ws", name: "ws", enabled: true, value: { source_repo: { trigger: "gitea-internal", repo: "acme/repo" } } } };
}

function providerOperation(id: string, baseUrl: string): ConfigChangesetOperation {
  // No api_key_env: an env reference would require a config_sources.secret_refs
  // grant; the test provider needs no credential at all.
  return { op: "create", collection: "providers", record: { id, name: id, enabled: true, value: { id, kind: "openai_compatible", base_url: baseUrl } } };
}

function modelGroupOperation(id: string, providerId: string, model: string): ConfigChangesetOperation {
  return { op: "create", collection: "model_groups", record: { id, name: id, enabled: true, value: [{ provider: providerId, model, role: "heavy" }] } };
}

function giteaChannelOperation(id: string, baseUrl: string): ConfigChangesetOperation {
  return { op: "create", collection: "channels", record: { id, name: id, enabled: true, value: { name: id, kind: "gitea_pr_review", trigger: "gitea-internal", base_url: baseUrl, review_update_strategy: "always_new", no_problems: { action: "publish" } } } };
}

function routeOperation(id: string, priority: number, targetKinds: readonly string[], summaryChannels: readonly string[]): ConfigChangesetOperation {
  return {
    op: "create", collection: "routes",
    record: {
      id, name: id, enabled: true,
      value: { id, enabled: true, priority, workspace: "ws", match: { triggers: ["gitea-internal"], target_kinds: [...targetKinds] }, outputs: { line_comments: [], summary: [...summaryChannels] } },
    },
  };
}

/** The full provider → model group → channel → route chain a review consumes. */
function reviewChainOperations(ids: {
  readonly provider: string;
  readonly providerBase: string;
  readonly group: string;
  readonly model: string;
  readonly channel: string;
  readonly channelBase: string;
  readonly route: string;
}): ConfigChangesetOperation[] {
  return [
    workspaceOperation(),
    providerOperation(ids.provider, ids.providerBase),
    modelGroupOperation(ids.group, ids.provider, ids.model),
    { op: "set", path: ["llm", "default_model_chain"], value: ids.group },
    giteaChannelOperation(ids.channel, ids.channelBase),
    routeOperation(ids.route, 10, ["pull_request"], [ids.channel]),
  ];
}

// ---------------------------------------------------------------------------
// Legacy-state seeding.
// ---------------------------------------------------------------------------

const LEGACY_IDS = {
  provider: "p-legacy",
  providerBase: "http://127.0.0.1:9411/v1",
  group: "g-legacy",
  model: "model-legacy",
  channel: "c-legacy",
  channelBase: "http://127.0.0.1:9421",
  route: "r-legacy",
} as const;

interface SeedRevision {
  readonly document: unknown;
  readonly effective: unknown;
  readonly documentHash: string;
  readonly snapshotHash: string;
  readonly snapshotId: string;
  readonly fileDigest: string;
}

/**
 * The revision-1 chain a pre-002 program would have published: prepared with
 * the SAME file document and digest the server later bootstraps with, so the
 * seeded content hashes and snapshot id are the production identities. The
 * document format matches what the production config API writes today
 * (formatVersion 2 — route records require it); the "old" in this fixture is
 * the 001 LEDGER state (no config_runtime_state table), not the document
 * format.
 */
function prepareSeedRevision(file: LoadedConfigDocument): SeedRevision {
  const prepared = prepareConfigPublication({
    namespace: NAMESPACE,
    baseRevision: null,
    operationId: "op-legacy-1",
    actor: "admin@example.com",
    file: file.document,
    fileDigest: file.digest,
    current: {},
    formatVersion: 2,
    operations: reviewChainOperations(LEGACY_IDS),
  });
  const documentHash = contentHashOf(prepared.document);
  const snapshotHash = contentHashOf(prepared.effective);
  const snapshotId = configSnapshotId({
    namespace: NAMESPACE,
    revision: 1,
    contentHash: documentHash,
    fileDigest: file.digest,
    formatVersion: 2,
  });
  return {
    document: prepared.document,
    effective: prepared.effective,
    documentHash,
    snapshotHash,
    snapshotId,
    fileDigest: file.digest,
  };
}


/** The M02 fixture state: real 001–006 DDL + name-ledger rows + legacy business rows. */
function seedBusinessLegacySqlite(dbPath: string): void {
  const historical = STORE_SQLITE_MIGRATIONS.slice(0, 6);
  expect(historical.map((step) => step.name)).toEqual([
    "001_initial",
    "002_reflection_memory",
    "003_model_catalog",
    "004_reflection_occurrence",
    "005_review_run_prompt_estimate",
    "006_llm_usage_cache_tokens",
  ]);
  const sqlite = new Database(dbPath);
  try {
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
    const mark = sqlite.prepare("INSERT INTO _migrations (name) VALUES (?)");
    for (const step of historical) {
      sqlite.exec(step.sql);
      mark.run(step.name);
    }
    // Business data in the 001-era shape (no vcs_kind/head_committed_at).
    sqlite.prepare(
      `INSERT INTO projects (workspace_id, trigger_name, repo_ref, display_name, created_at)
       VALUES ('ws-legacy', 'gitea', 'owner/legacy', 'Legacy project', 1700000000000)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO review_runs (id, project_id, event_id, workspace_id, trigger_name, provider, provider_model,
         status, attempt, started_at, finished_at, tokens_in, tokens_out, branch, head_sha)
       VALUES ('legacy-run', 1, 'evt-1', 'ws-legacy', 'gitea', 'openai', 'gpt-x',
         'succeeded', 1, 1700000001000, 1700000005000, 111, 22, 'main', 'legacy-sha')`,
    ).run();
  } finally {
    sqlite.close();
  }
}

/** The E08 fixture state: real 001 config step via the runner + 001-shape rows. */
async function seedConfigLegacySqlite001(dbPath: string, seed: SeedRevision): Promise<void> {
  const step001 = CONFIG_STORE_MIGRATIONS[0]!;
  const step002 = CONFIG_STORE_MIGRATIONS[1]!;
  expect(step001.id).toBe("001_config_initial");
  expect(step002.id).toBe("002_config_runtime_state");
  const db = new Database(dbPath);
  try {
    // A plan that stops at version 1: exactly what a pre-002 program ran.
    await new MigrationRunner(createSqliteMigrationStore(db), [
      { namespace: CONFIG_STORE_NAMESPACE, targetVersion: 1, steps: [step001] },
    ], { now: () => T0 }).apply();
    db.prepare(
      `INSERT INTO config_revisions (
         namespace, revision, parent_revision, format_version, document, content_hash,
         file_digest, created_at, actor, operation_id
       ) VALUES (?, 1, NULL, 2, ?, ?, ?, ?, 'admin@example.com', 'op-legacy-1')`,
    ).run(NAMESPACE, JSON.stringify(seed.document), seed.documentHash, seed.fileDigest, T0);
    db.prepare(
      `INSERT INTO config_heads (namespace, active_revision, generation) VALUES (?, 1, 1)`,
    ).run(NAMESPACE);
    db.prepare(
      `INSERT INTO config_audit (
         id, namespace, operation_id, before_revision, after_revision, action,
         entity_refs, redacted_diff, actor, timestamp
       ) VALUES ('audit-legacy-1', ?, 'op-legacy-1', NULL, 1, 'publish', '[]', '{}', 'admin@example.com', ?)`,
    ).run(NAMESPACE, T0);
    db.prepare(
      `INSERT INTO config_runtime_snapshots (
         id, namespace, file_digest, database_revision, resolver_version,
         sanitized_effective_config, content_hash, created_at, pinned, ref_count
       ) VALUES (?, ?, ?, 1, ${CONFIG_RESOLVER_VERSION}, ?, ?, ?, 0, 0)`,
    ).run(seed.snapshotId, NAMESPACE, seed.fileDigest, JSON.stringify(seed.effective), seed.snapshotHash, T0);
  } finally {
    db.close();
  }
}

/** Shared new-event consumption assertions for the sqlite and postgres legs. */
async function expectReviewOnRevision(
  options: ServerAppOptions,
  captured: CapturedRequest[],
  expectation: {
    readonly providerBase: string;
    readonly channelBase: string;
    readonly model: string;
    readonly databaseRevision: number;
    readonly snapshotId?: string;
    readonly fileDigest: string;
    readonly routeId: string;
  },
): Promise<WebhookResponseBody> {
  const { status, body } = await postPullRequest(options);
  expect(status).toBe(202);
  expect(body.accepted).toBe(true);
  expect(body.outcome).toBe("reviewed");
  expect(body.reviewRun?.status).toBe("published");
  expect(body.reviewRun?.problemCount).toBe(0);
  expect(body.reviewRun?.configVersion).toEqual({
    configSnapshotId: expectation.snapshotId ?? expect.any(String),
    databaseRevision: expectation.databaseRevision,
    fileDigest: expectation.fileDigest,
    routeId: expectation.routeId,
  });
  // The exact request sequence: one LLM chat call against the revision's
  // provider/model, then one output POST against the revision's channel.
  expect(captured.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: "POST", url: `${expectation.providerBase}/chat/completions` },
    { method: "POST", url: `${expectation.channelBase}/api/v1/repos/acme/repo/pulls/7/reviews` },
  ]);
  expect(bodyField(captured[0], "model")).toBe(expectation.model);
  expect(Array.isArray(bodyField(captured[0], "messages"))).toBe(true);
  expect(bodyField(captured[1], "event")).toBe("COMMENT");
  expect(bodyField(captured[1], "body")).toContain(SUMMARY_SENTINEL);
  return body;
}

async function expectPersistedRun(
  options: ServerAppOptions,
  expectation: { readonly model: string; readonly totalRuns: number; readonly prunedRuns?: number },
): Promise<void> {
  const runs = await getRecentRuns(options.store!, 10);
  expect(runs).toHaveLength(expectation.totalRuns - (expectation.prunedRuns ?? 0));
  expect((await getOverviewStats(options.store!)).reviewCount).toBe(expectation.totalRuns);
  const persisted = runs.find((run) => run.providerModel === expectation.model);
  expect(persisted).toBeDefined();
  expect(persisted).toMatchObject({
    workspaceId: "ws",
    triggerName: "gitea-internal",
    status: "succeeded",
    headSha: "head",
    vcsKind: "git",
  });
}

/** Revision 2: a pure model swap on the seeded/live model group. */
function modelSwapOperation(groupId: string, providerId: string, model: string): ConfigChangesetOperation {
  return { op: "update", collection: "model_groups", recordId: groupId, value: [{ provider: providerId, model, role: "heavy" }] };
}

// ---------------------------------------------------------------------------
// SQLite leg (ungated): one file, both legacy ledgers, real upgrade at open.
// ---------------------------------------------------------------------------

describe("post-migration consumption [sqlite]", () => {
  it("upgrades the combined old-data file in place and serves new webhook reviews on revisions 1 and 2", async () => {
    const dbPath = join(dir, "combined.sqlite");
    seedBusinessLegacySqlite(dbPath);
    const file = parseConfigDocumentText(fileText({
      database: { kind: "sqlite", sqlite: { path: dbPath }, migrate: "auto" },
      cache: { kind: "memory" },
      backend: "storage",
      objectRoot: join(dir, "objects"),
    }));
    const seed = prepareSeedRevision(file);
    await seedConfigLegacySqlite001(dbPath, seed);

    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const options = await bootstrapParsed(file);
    const publishStore = trackStore(await createSqliteConfigStore({ path: dbPath }));

    // Both ledgers advanced exactly once: business 007–010 appended to the
    // historical 001–006 names; config 002 appended to the historical 001.
    const probe = new Database(dbPath);
    try {
      const businessLedger = (probe.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[])
        .map((row) => row.name);
      expect(businessLedger).toEqual(STORE_SQLITE_MIGRATIONS.map((step) => step.name));
      const configLedger = (probe.prepare(
        "SELECT id FROM schema_migrations WHERE namespace = ? ORDER BY to_version",
      ).all(CONFIG_STORE_NAMESPACE) as { id: string }[]).map((row) => row.id);
      expect(configLedger).toEqual([CONFIG_STORE_MIGRATIONS[0]!.id, CONFIG_STORE_MIGRATIONS[1]!.id]);
      // Legacy business rows intact, byte-level counters untouched.
      const legacyRow = probe.prepare(
        "SELECT tokens_in, tokens_out FROM review_runs WHERE id = 'legacy-run'",
      ).get() as { tokens_in: number; tokens_out: number };
      expect(legacyRow).toEqual({ tokens_in: 111, tokens_out: 22 });
    } finally {
      probe.close();
    }
    const legacyRuns = await getRecentRuns(options.store!, 10);
    expect(legacyRuns).toHaveLength(0); // Six-month default removes the 2023 display details.
    expect((await getOverviewStats(options.store!)).reviewCount).toBe(1);
    expect(options.store!.kind).toBe("sqlite");
    if (options.store!.kind === "sqlite") expect(options.store!.sqlite.prepare(
      "SELECT branch, head_sha, history_pruned FROM review_runs WHERE id = 'legacy-run'",
    ).get()).toEqual({ branch: null, head_sha: null, history_pruned: 1 });

    // New signed webhook event → review consumes the MIGRATED revision 1.
    const head1 = await publishStore.readHead(NAMESPACE);
    expect(head1?.activeRevision).toBe(1);
    await expectReviewOnRevision(options, captured, {
      providerBase: LEGACY_IDS.providerBase,
      channelBase: LEGACY_IDS.channelBase,
      model: LEGACY_IDS.model,
      databaseRevision: 1,
      snapshotId: seed.snapshotId,
      fileDigest: file.digest,
      routeId: LEGACY_IDS.route,
    });
    await expectPersistedRun(options, { model: LEGACY_IDS.model, totalRuns: 2, prunedRuns: 1 });

    // Publish revision 2 through the real changeset API (model swap), then a
    // second webhook consumes the new head exclusively.
    await publishOperations(options, publishStore, [
      modelSwapOperation(LEGACY_IDS.group, LEGACY_IDS.provider, "model-v2"),
    ]);
    const head2 = await publishStore.readHead(NAMESPACE);
    expect(head2?.activeRevision).toBe(2);
    captured.length = 0;
    const run2 = await expectReviewOnRevision(options, captured, {
      providerBase: LEGACY_IDS.providerBase,
      channelBase: LEGACY_IDS.channelBase,
      model: "model-v2",
      databaseRevision: 2,
      fileDigest: file.digest,
      routeId: LEGACY_IDS.route,
    });
    expect(run2.reviewRun?.configVersion?.configSnapshotId).not.toBe(seed.snapshotId);
    await expectPersistedRun(options, { model: "model-v2", totalRuns: 3, prunedRuns: 1 });
    await options.closeAutoCommit?.();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// PostgreSQL leg (live service): random schema, full business plan + config 001.
// ---------------------------------------------------------------------------

describePg("post-migration consumption [postgres]", () => {
  const schemas: string[] = [];

  afterEach(async () => {
    if (schemas.length === 0) return;
    const pool = new PgPoolCtor({ connectionString: PG_TEST_URL!, max: 1 });
    try {
      for (const schema of schemas.splice(0)) {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await pool.end();
    }
  });

  it("serves new webhook reviews on the migrated revision 1 and published revision 2", async () => {
    const schema = `test_${randomUUID().replace(/-/g, "_")}`;
    schemas.push(schema);
    const searchPath = `-c search_path="${schema}"`;
    const schemaUrl = `${PG_TEST_URL!}?options=${encodeURIComponent(searchPath)}`;

    // Seed: business STORE_MIGRATION_PLAN fully applied (real runner via the
    // production store factory), one legacy review_runs row, config 001 only.
    const business = await createStoreDb({ kind: "postgres", url: PG_TEST_URL!, schema, migrationMode: "auto" });
    await closeStoreDb(business);

    const file = parseConfigDocumentText(fileText({
      database: { kind: "postgres", postgres: { url: schemaUrl }, migrate: "auto" },
      cache: { kind: "memory" },
      backend: "storage",
      objectRoot: join(dir, "objects"),
    }));
    const seed = prepareSeedRevision(file);

    const setup = new PgPoolCtor({ connectionString: PG_TEST_URL!, max: 1, options: searchPath });
    const client = await setup.connect();
    try {
      await client.query(
        `INSERT INTO projects (workspace_id, trigger_name, repo_ref, display_name, created_at)
         VALUES ('ws-legacy', 'gitea', 'owner/legacy', 'Legacy project', 1700000000000)`,
      );
      await client.query(
        `INSERT INTO review_runs (id, project_id, event_id, workspace_id, trigger_name, provider, provider_model,
           status, attempt, started_at, finished_at, tokens_in, tokens_out, branch, head_sha)
         VALUES ('legacy-run', 1, 'evt-1', 'ws-legacy', 'gitea', 'openai', 'gpt-x',
           'succeeded', 1, 1700000001000, 1700000005000, 111, 22, 'main', 'legacy-sha')`,
      );
      const step001 = PG_CONFIG_STORE_MIGRATIONS[0]!;
      const step002 = PG_CONFIG_STORE_MIGRATIONS[1]!;
      expect(step001.id).toBe("001_pg_config_initial");
      expect(step002.id).toBe("002_pg_config_runtime_state");
      // A plan that stops at version 1: exactly what a pre-002 program ran.
      await new MigrationRunner(createPgConfigMigrationStore(client), [
        { namespace: CONFIG_STORE_NAMESPACE, targetVersion: 1, steps: [step001] },
      ], { now: () => T0 }).apply();
      await client.query(
        `INSERT INTO config_revisions (
           namespace, revision, parent_revision, format_version, document, content_hash,
           file_digest, created_at, actor, operation_id
         ) VALUES ($1, 1, NULL, 2, $2::jsonb, $3, $4, $5, 'admin@example.com', 'op-legacy-1')`,
        [NAMESPACE, JSON.stringify(seed.document), seed.documentHash, seed.fileDigest, T0],
      );
      await client.query(
        `INSERT INTO config_heads (namespace, active_revision, generation) VALUES ($1, 1, 1)`,
        [NAMESPACE],
      );
      await client.query(
        `INSERT INTO config_audit (
           id, namespace, operation_id, before_revision, after_revision, action,
           entity_refs, redacted_diff, actor, timestamp
         ) VALUES ('audit-legacy-1', $1, 'op-legacy-1', NULL, 1, 'publish', '[]'::jsonb, '{}'::jsonb, 'admin@example.com', $2)`,
        [NAMESPACE, T0],
      );
      await client.query(
        `INSERT INTO config_runtime_snapshots (
           id, namespace, file_digest, database_revision, resolver_version,
           sanitized_effective_config, content_hash, created_at, pinned, ref_count
         ) VALUES ($1, $2, $3, 1, ${CONFIG_RESOLVER_VERSION}, $4::jsonb, $5, $6, FALSE, 0)`,
        [seed.snapshotId, NAMESPACE, seed.fileDigest, JSON.stringify(seed.effective), seed.snapshotHash, T0],
      );
    } finally {
      client.release();
      await setup.end();
    }

    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const options = await bootstrapParsed(file);
    const publishStore = trackStore(await createPgConfigStore({ connection: { url: PG_TEST_URL! }, schema }));

    // Ledgers: business fully applied at seed time (nothing new at bootstrap);
    // config 002 appended to the seeded 001.
    const probe = new PgPoolCtor({ connectionString: PG_TEST_URL!, max: 1, options: searchPath });
    try {
      const configLedger = await probe.query(
        "SELECT id FROM schema_migrations WHERE namespace = $1 ORDER BY to_version",
        [CONFIG_STORE_NAMESPACE],
      );
      expect(configLedger.rows.map((row) => row.id)).toEqual([
        PG_CONFIG_STORE_MIGRATIONS[0]!.id,
        PG_CONFIG_STORE_MIGRATIONS[1]!.id,
      ]);
      const storeLedger = await probe.query(
        "SELECT id FROM schema_migrations WHERE namespace = $1 ORDER BY to_version",
        [STORE_MIGRATION_PLAN.namespace],
      );
      expect(storeLedger.rows.map((row) => row.id)).toEqual(STORE_MIGRATION_PLAN.steps.map((step) => step.id));
      const legacyRow = await probe.query(
        "SELECT tokens_in, tokens_out FROM review_runs WHERE id = 'legacy-run'",
      );
      expect(legacyRow.rows).toEqual([{ tokens_in: 111, tokens_out: 22 }]);
    } finally {
      await probe.end();
    }
    const legacyRuns = await getRecentRuns(options.store!, 10);
    expect(legacyRuns).toHaveLength(0);
    expect((await getOverviewStats(options.store!)).reviewCount).toBe(1);
    expect(options.store!.kind).toBe("postgres");
    if (options.store!.kind === "postgres") expect((await options.store!.pool.query(
      "SELECT branch, head_sha, history_pruned FROM review_runs WHERE id = 'legacy-run'",
    )).rows).toEqual([{ branch: null, head_sha: null, history_pruned: true }]);

    // New signed webhook event → review consumes the MIGRATED revision 1.
    const head1 = await publishStore.readHead(NAMESPACE);
    expect(head1?.activeRevision).toBe(1);
    await expectReviewOnRevision(options, captured, {
      providerBase: LEGACY_IDS.providerBase,
      channelBase: LEGACY_IDS.channelBase,
      model: LEGACY_IDS.model,
      databaseRevision: 1,
      snapshotId: seed.snapshotId,
      fileDigest: file.digest,
      routeId: LEGACY_IDS.route,
    });
    await expectPersistedRun(options, { model: LEGACY_IDS.model, totalRuns: 2, prunedRuns: 1 });

    // Publish revision 2 through the real changeset API, then a second
    // webhook consumes the new head exclusively.
    await publishOperations(options, publishStore, [
      modelSwapOperation(LEGACY_IDS.group, LEGACY_IDS.provider, "model-v2"),
    ]);
    const head2 = await publishStore.readHead(NAMESPACE);
    expect(head2?.activeRevision).toBe(2);
    captured.length = 0;
    const run2 = await expectReviewOnRevision(options, captured, {
      providerBase: LEGACY_IDS.providerBase,
      channelBase: LEGACY_IDS.channelBase,
      model: "model-v2",
      databaseRevision: 2,
      fileDigest: file.digest,
      routeId: LEGACY_IDS.route,
    });
    expect(run2.reviewRun?.configVersion?.configSnapshotId).not.toBe(seed.snapshotId);
    await expectPersistedRun(options, { model: "model-v2", totalRuns: 3, prunedRuns: 1 });
    await options.closeAutoCommit?.();
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Redis leg: dedicated child redis-server, SIGKILL + restart persistence.
// ---------------------------------------------------------------------------

function redisArgs(port: number, redisDir: string): string[] {
  // appendfsync=always: a SIGKILL must never lose the published revision.
  return [
    "--port", String(port),
    "--bind", "127.0.0.1",
    "--appendonly", "yes",
    "--appendfsync", "always",
    "--dir", redisDir,
    "--save", "",
  ];
}

async function startRedisChild(port: number, redisDir: string): Promise<ChildProcess> {
  const child = spawn(REDIS_SERVER_EXECUTABLE!, redisArgs(port, redisDir), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { output += String(chunk); });
  // Readiness is event-driven (stdout banner / early exit); the setTimeout is
  // only a failure deadline so a wedged child cannot hang the suite.
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error(`redis-server readiness timeout: ${output}`)), 20_000);
  const onData = () => {
    if (output.includes("Ready to accept connections")) {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve();
    }
  };
  const onExit = (code: number | null) => {
    clearTimeout(timer);
    reject(new Error(`redis-server exited before readiness (code ${code}): ${output}`));
  };
  child.stdout?.on("data", onData);
  child.on("exit", onExit);
  await promise;
  return child;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.kill("SIGKILL");
  await promise;
}

describeRedisServer("post-migration consumption [redis]", () => {
  it("a revision published before a redis-server SIGKILL/restart is consumed by a new webhook review after the restart", async () => {
    const redisDir = join(dir, "redis-data");
    mkdirSync(redisDir, { recursive: true });
    const port = await findFreePort();
    const redisUrl = `redis://127.0.0.1:${port}`;
    let redisChild = await startRedisChild(port, redisDir);
    process.env[REDIS_URL_ENV] = redisUrl;

    // Business store: fresh sqlite (created by the bootstrap). Config store:
    // the dedicated child redis.
    const file = parseConfigDocumentText(fileText({
      database: { kind: "sqlite", sqlite: { path: join(dir, "business.sqlite") }, migrate: "auto" },
      cache: { kind: "redis", redis: { url_env: REDIS_URL_ENV } },
      backend: "redis",
      objectRoot: join(dir, "objects"),
    }));
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const options = await bootstrapParsed(file);
    const publishStore = trackStore(await createRedisConfigStore({ connection: { url: redisUrl } }));

    // Seed revision 1 through the REAL changeset API against the running server.
    const live = {
      provider: "p-live",
      providerBase: "http://127.0.0.1:9511/v1",
      group: "g-live",
      model: "model-live",
      channel: "c-live",
      channelBase: "http://127.0.0.1:9521",
      route: "r-live",
    } as const;
    await publishOperations(options, publishStore, reviewChainOperations(live));
    const head1 = await publishStore.readHead(NAMESPACE);
    expect(head1?.activeRevision).toBe(1);
    const preKill = await options.runtimeConfig!.admission();
    expect(preKill.databaseRevision).toBe(1);
    expect(preKill.snapshotId).not.toBeNull();

    // SIGKILL the service (no graceful shutdown flush) and restart it on the
    // same port and data dir; the AOF is the only durability source.
    await killChild(redisChild);
    redisChild = await startRedisChild(port, redisDir);

    // Persistence proof through a FRESH client: the pre-restart revision head
    // and its pinned snapshot survived the SIGKILL.
    const probe = await createRedisConfigStore({ connection: { url: redisUrl } });
    try {
      const head = await probe.readHead(NAMESPACE);
      expect(head?.activeRevision).toBe(1);
      const snapshot = await probe.readSnapshot(preKill.snapshotId!);
      expect(snapshot).toMatchObject({ namespace: NAMESPACE, databaseRevision: 1 });
    } finally {
      await probe.close();
    }

    // The still-running server's own store reconnects; admission re-reads the
    // durable head and must settle on the pre-restart generation. The retry
    // backoff is real time by necessity: the reconnect happens inside the
    // server's ioredis client on the platform clock, across a process
    // boundary fake timers cannot reach (integration exception).
    let admitted: typeof preKill | undefined;
    for (let attempt = 0; attempt < 100 && admitted === undefined; attempt += 1) {
      try {
        admitted = await options.runtimeConfig!.admission();
      } catch {
        const { promise: backoff, resolve: resume } = Promise.withResolvers<void>();
        setTimeout(resume, 150);
        await backoff;
      }
    }
    expect(admitted?.snapshotId).toBe(preKill.snapshotId);
    expect(admitted?.databaseRevision).toBe(1);

    // Post-restart consumption: a new signed webhook drives a full review on
    // the pre-restart revision; the run record lands in the sqlite store.
    const body = await expectReviewOnRevision(options, captured, {
      providerBase: live.providerBase,
      channelBase: live.channelBase,
      model: live.model,
      databaseRevision: 1,
      snapshotId: preKill.snapshotId!,
      fileDigest: file.digest,
      routeId: live.route,
    });
    expect(body.reviewRun?.configVersion?.configSnapshotId).toBe(preKill.snapshotId);
    await expectPersistedRun(options, { model: live.model, totalRuns: 1 });
    await options.closeAutoCommit?.();
    await killChild(redisChild);
  }, 120_000);
});

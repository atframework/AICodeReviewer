/**
 * E01/E02/E04(c): publication → review execution end-to-end evidence (P7).
 *
 * E01: one changeset publishes provider + model group + output channel +
 *   route; a real review run for a PR event then proves the integrated chain
 *   by its captured HTTP requests (LLM URL/model, output URL, count, order)
 *   and by the run's pinned config version — never by "published" status.
 * E02: a changeset published mid-flight (LLM response blocked on a deferred
 *   gate) never leaks into the in-flight run: run 1 keeps every old
 *   endpoint/model/channel, run 2 uses the new head exclusively.
 * E04(c): route target_kinds attribute each event kind to its own channel —
 *   pull_request → gitea PR review channel, push → feishu bot webhook — with
 *   no cross-posts.
 *
 * External HTTP is intercepted by a fetch spy and the VCS layer uses a
 * deterministic fixture. Agent CLI/sandbox execution is disabled to select
 * the direct-LLM path. These substitutions use the production
 * optionsResolver seam so model-route resolution, generation pinning and
 * output publishing stay on the production code path.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReviewEvent, parseConfigDocumentText, type ConfigChangesetOperation, type ConfigStore } from "@aicr/core";
import { createSqliteConfigStore } from "@aicr/core";
import type { AppConfig } from "@aicr/core";
import { closeStoreDb } from "@aicr/store";
import { parseUnifiedDiff, type ChangeRange } from "@aicr/vcs";
import { bootstrapServerApp } from "../src/bootstrap.js";
import { createServerApp, runTriggerProcessing, type ServerAppOptions } from "../src/index.js";
import type {
  DiffCapableVcsAdapter,
  ReviewOrchestrationContext,
  ServerReviewOrchestrationOptions,
} from "../src/review-orchestrator.js";

const NAMESPACE = "gen-e2e-publish-review";
const SUMMARY_SENTINEL = "E2E review summary sentinel: all checks passed.";
const FEISHU_WEBHOOK_ENV = "FEISHU_E2E_WEBHOOK_URL";
const FEISHU_WEBHOOK_URL = "http://127.0.0.1:9302/open-apis/bot/v2/hook/e2e-push";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    llm: {
      providers: [
        { id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
      ],
      default_model_chain: "default",
      model_chain: { default: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }] },
      model_catalog: {
        enabled: false,
        source_url: "https://models.dev/api.json",
        refresh_interval_hours: 24,
        fetch_timeout_ms: 10000,
        offline: false,
        apply_to_model_spec: true,
        cache: { backend: "memory" },
        overrides: {},
      },
    },
    triggers: [
      { name: "gitea-internal", kind: "gitea", base_url: "https://gitea.example.com", token_env: "GITEA_TOKEN", webhook_secret_env: "GITEA_SECRET" },
    ],
    outputs: { template_engine: "handlebars", channels: [] },
    review: {},
    agent: {
      default: "kilo",
      timeout_seconds: 1800,
      auto_approve: true,
      sandbox: {},
      context_compaction: { auto: true, prune: true },
      web_search: { enabled: false, providers: [], exclude: [], credentials: {} },
    },
    queue: { kind: "memory" },
    server: {},
    compression: {},
    workspaces: { cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 }, defaults: {}, instances: {} },
    storage: {
      // Same file as the test's publish store: the manager adopts commits
      // from a second connection, like a real second replica would.
      database: { kind: "sqlite", sqlite: { path: join(dir, "config.sqlite") }, migrate: "auto" },
      cache: { kind: "memory" },
      object: { kind: "filesystem", filesystem: { root: "/tmp/aicr-objects" } },
      retention: { deleted_project_grace_days: 30 },
    },
    admin: { username_env: "AICR_ADMIN_USERNAME", password_env: "AICR_ADMIN_PASSWORD" },
    config_sources: {
      database: { enabled: true, backend: "storage", namespace: NAMESPACE },
      runtime: { refresh_interval_seconds: 5 },
    },
    ...overrides,
  } as unknown as AppConfig;
}

const FILE_DOCUMENT = {
  config_sources: { secret_refs: [
    { env: "GITHUB_DYN_SECRET", target: ["triggers", "github-dyn", "webhook_secret_env"], destinations: { kind: "github" } },
    // Authorizes the published feishu_bot channel's webhook env reference
    // (exact destination signature required by the publish secret policy).
    { env: "FEISHU_E2E_WEBHOOK_URL", target: ["outputs", "channels", "c-push", "webhook_url_env"], destinations: { kind: "feishu_bot", webhook_url_env: "FEISHU_E2E_WEBHOOK_URL" } },
  ] },
  llm: {
    providers: [{ id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" }],
    model_chain: { default: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }] },
  },
  triggers: [{ name: "gitea-internal", kind: "gitea", base_url: "https://gitea.example.com", webhook_secret_env: "GITEA_SECRET" }],
};

let dir: string;
let store: ConfigStore;
let bootstrapped: ServerAppOptions | undefined;
const originalEnv: Record<string, string | undefined> = {};
const MANAGED_ENV = ["OPENAI_API_KEY", "GITEA_TOKEN", "GITEA_SECRET", "AICR_ADMIN_USERNAME", "AICR_ADMIN_PASSWORD", FEISHU_WEBHOOK_ENV];

beforeEach(async () => {
  mkdirSync("build/tmp", { recursive: true });
  dir = mkdtempSync(join(process.cwd(), "build/tmp/aicr-e2e-publish-review-"));
  for (const name of MANAGED_ENV) {
    originalEnv[name] = process.env[name];
  }
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GITEA_TOKEN = "test-token";
  process.env.GITEA_SECRET = "test-secret";
  process.env.AICR_ADMIN_USERNAME = "admin";
  process.env.AICR_ADMIN_PASSWORD = "admin-password";
  process.env[FEISHU_WEBHOOK_ENV] = FEISHU_WEBHOOK_URL;
  store = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
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
    // the sqlite handles so Windows can remove the temp directory.
    await bootstrapped.sessionStore?.close();
    if (bootstrapped.store) await closeStoreDb(bootstrapped.store);
    bootstrapped = undefined;
  }
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly options: ServerAppOptions;
}

async function bootstrap(config: AppConfig): Promise<Harness> {
  // Bootstrap and publication must originate from the same raw file. Feeding
  // defaults or a second, credential-free document conceals integration bugs.
  const file = parseConfigDocumentText(JSON.stringify({ ...FILE_DOCUMENT,
    storage: config.storage, admin: config.admin, queue: config.queue,
    config_sources: { ...config.config_sources, ...FILE_DOCUMENT.config_sources },
    llm: { ...FILE_DOCUMENT.llm, model_catalog: { enabled: false } },
  }));
  const options = await bootstrapServerApp({
    config: file.config,
    baseSystemPrompt: "test",
    baseDir: dir,
    configDocument: {
      document: file.document,
      digest: file.digest,
    },
  });
  bootstrapped = options;
  return { options };
}

async function publishOperations(operations: readonly ConfigChangesetOperation[]): Promise<void> {
  const app = createServerApp(bootstrapped!);
  const login = await app.request("/api/admin/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  expect(login.status).toBe(200);
  const { token } = await login.json() as { token: string };
  const head = await store.readHead(NAMESPACE);
  const response = await app.request("/api/admin/config/changesets", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({
    baseRevision: head?.activeRevision ?? null,
    operationId: `op-${Math.random().toString(36).slice(2, 10)}`,
    fileDigest: bootstrapped!.configApi!.fileDigest,
    operations,
  }) });
  const result: unknown = await response.json();
  expect(result).toMatchObject({ status: "committed" });
  expect(response.status).toBe(200);
}

async function postPullRequest(options: ServerAppOptions, vcs: DiffCapableVcsAdapter) {
  const app = createServerApp({ ...options, asyncTriggers: false, reviewOrchestration: reviewOptions(options, vcs) });
  const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/repo" },
    pull_request: { number: 7, base: { sha: "base", ref: "main" }, head: { sha: "head", ref: "feature" }, user: { login: "owent" } } });
  const response = await app.request("/webhooks/gitea", { method: "POST", body, headers: {
    "content-type": "application/json", "x-gitea-event": "pull_request",
    "x-gitea-signature": createHmac("sha256", "test-secret").update(body).digest("hex"),
  } });
  const result = await response.json() as Awaited<ReturnType<typeof runTriggerProcessing>>;
  expect(response.status).toBe(202);
  return result;
}

// ---------------------------------------------------------------------------
// Fetch spy: every external call is captured; unknown URLs fail fast.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

interface FetchGate {
  /** Block the FIRST chat/completions request on this promise (E02). */
  readonly holdFirstChat?: Promise<void>;
  readonly onFirstChat?: () => void;
}

function stubFetch(captured: CapturedRequest[], gate: FetchGate = {}): void {
  let chatCalls = 0;
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
      chatCalls += 1;
      if (chatCalls === 1 && gate.holdFirstChat) {
        gate.onFirstChat?.();
        await gate.holdFirstChat;
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: SUMMARY_SENTINEL }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    }
    if (target.includes("/reviews")) {
      return new Response(JSON.stringify({ id: 7 }), { headers: { "content-type": "application/json" } });
    }
    if (target === FEISHU_WEBHOOK_URL) {
      return new Response(JSON.stringify({ code: 0, msg: "ok" }), { headers: { "content-type": "application/json" } });
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
 * AFTER the production optionsResolver ran (so generation pinning, model
 * routing and output-publisher resolution are all production behavior):
 * the VCS adapter is faked and the agent CLI/sandbox path is disabled, which
 * selects the direct-LLM completion path whose HTTP call the spy captures.
 */
function reviewOptions(options: ServerAppOptions, vcs: DiffCapableVcsAdapter): ServerReviewOrchestrationOptions {
  const base = options.reviewOrchestration!;
  const resolve = base.optionsResolver!;
  // Strip the agent CLI path at BOTH layers: the bootstrap fallback carries
  // sandboxFactory/agentAdapter and so does the per-generation resolved layer;
  // without a sandbox the orchestrator takes the direct-LLM completion path
  // whose HTTP request the fetch spy captures.
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

function pullRequestEvent() {
  return createReviewEvent({
    triggerName: "gitea-internal",
    provider: "gitea",
    workspaceId: "ws",
    targetKind: "pull_request",
    repoRef: "acme/repo",
    baseSha: "base",
    headSha: "head",
    author: { username: "owent" },
    reason: "gitea:opened",
    rawEventName: "pull_request",
  });
}

function pushEvent() {
  return createReviewEvent({
    triggerName: "gitea-internal",
    provider: "gitea",
    workspaceId: "ws",
    targetKind: "push",
    repoRef: "acme/repo",
    branch: "main",
    baseSha: "base",
    headSha: "head",
    author: { username: "owent" },
    reason: "gitea:push",
    rawEventName: "push",
  });
}

function workspaceOperation() {
  return { op: "create" as const, collection: "workspaces" as const, record: { id: "ws", name: "ws", enabled: true, value: { source_repo: { trigger: "gitea-internal", repo: "acme/repo" } } } };
}

function providerOperation(id: string, baseUrl: string) {
  // No api_key_env: an env reference would require a matching
  // config_sources.secret_refs grant per destination (see the feishu grant in
  // FILE_DOCUMENT); the dummy provider needs no credential at all.
  return { op: "create" as const, collection: "providers" as const, record: { id, name: id, enabled: true, value: { id, kind: "openai_compatible", base_url: baseUrl } } };
}

function modelGroupOperation(id: string, providerId: string, model: string) {
  return { op: "create" as const, collection: "model_groups" as const, record: { id, name: id, enabled: true, value: [{ provider: providerId, model, role: "heavy" }] } };
}

function giteaChannelOperation(id: string, baseUrl: string) {
  return { op: "create" as const, collection: "channels" as const, record: { id, name: id, enabled: true, value: { name: id, kind: "gitea_pr_review", trigger: "gitea-internal", base_url: baseUrl, review_update_strategy: "always_new", no_problems: { action: "publish" } } } };
}

function routeOperation(id: string, priority: number, targetKinds: readonly string[], summaryChannels: readonly string[]) {
  return {
    op: "create" as const, collection: "routes" as const,
    record: {
      id, name: id, enabled: true,
      value: { id, enabled: true, priority, workspace: "ws", match: { triggers: ["gitea-internal"], target_kinds: [...targetKinds] }, outputs: { line_comments: [], summary: [...summaryChannels] } },
    },
  };
}

describe("config publication → review execution e2e", () => {
  it("E01: published provider/model/channel/route chain drives one review run end to end", async () => {
    const providerBase = "http://127.0.0.1:9011/v1";
    const channelBase = "http://127.0.0.1:9021";
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      workspaceOperation(),
      providerOperation("p-e01", providerBase),
      modelGroupOperation("g-e01", "p-e01", "model-e01"),
      { op: "set", path: ["llm", "default_model_chain"], value: "g-e01" },
      giteaChannelOperation("c-e01", channelBase),
      routeOperation("r-e01", 10, ["pull_request"], ["c-e01"]),
    ]);
    const head = await store.readHead(NAMESPACE);
    expect(head?.activeRevision).toBe(1);

    const result = await postPullRequest(options, createFakeVcs());
    const generation = options.runtimeConfig!.current();

    expect(result.outcome).toBe("reviewed");
    expect(result.reviewRun?.status).toBe("published");
    expect(result.reviewRun?.problemCount).toBe(0);
    // §7: the run is pinned to the published head, not merely "published".
    expect(result.reviewRun?.configVersion).toEqual({
      configSnapshotId: generation.snapshotId,
      databaseRevision: head?.activeRevision,
      fileDigest: options.configApi!.fileDigest,
      routeId: "r-e01",
    });
    // The exact request sequence: one LLM chat call against the published
    // provider/model, then one output POST against the published channel.
    expect(captured.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: `${providerBase}/chat/completions` },
      { method: "POST", url: `${channelBase}/api/v1/repos/acme/repo/pulls/7/reviews` },
    ]);
    expect(bodyField(captured[0], "model")).toBe("model-e01");
    expect(Array.isArray(bodyField(captured[0], "messages"))).toBe(true);
    expect(bodyField(captured[1], "event")).toBe("COMMENT");
    expect(bodyField(captured[1], "body")).toContain(SUMMARY_SENTINEL);
    await options.closeAutoCommit?.();
  });

  it("E02: a mid-flight changeset never leaks into the in-flight run", async () => {
    const oldProviderBase = "http://127.0.0.1:9101/v1";
    const newProviderBase = "http://127.0.0.1:9102/v2";
    const oldChannelBase = "http://127.0.0.1:9201";
    const newChannelBase = "http://127.0.0.1:9202";
    const captured: CapturedRequest[] = [];
    let firstChatStarted!: () => void;
    const firstChatArrived = new Promise<void>((resolve) => { firstChatStarted = resolve; });
    let releaseFirstChat!: () => void;
    const firstChatGate = new Promise<void>((resolve) => { releaseFirstChat = resolve; });
    stubFetch(captured, { holdFirstChat: firstChatGate, onFirstChat: firstChatStarted });
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      workspaceOperation(),
      providerOperation("p-e02", oldProviderBase),
      modelGroupOperation("g-e02", "p-e02", "model-old"),
      { op: "set", path: ["llm", "default_model_chain"], value: "g-e02" },
      giteaChannelOperation("c-e02", oldChannelBase),
      routeOperation("r-e02", 10, ["pull_request"], ["c-e02"]),
    ]);
    const generationOld = await options.runtimeConfig!.admission();
    const headOld = await store.readHead(NAMESPACE);

    const run1Promise = postPullRequest(options, createFakeVcs());
    try {
    // Run 1 is now blocked inside the LLM completion against the OLD provider.
    await firstChatArrived;
    // Swap provider base_url + model + channel URL underneath the live run.
    await publishOperations([
      { op: "update", collection: "providers", recordId: "p-e02", value: { id: "p-e02", kind: "openai_compatible", base_url: newProviderBase } },
      { op: "update", collection: "model_groups", recordId: "g-e02", value: [{ provider: "p-e02", model: "model-new", role: "heavy" }] },
      { op: "update", collection: "channels", recordId: "c-e02", value: { name: "c-e02", kind: "gitea_pr_review", trigger: "gitea-internal", base_url: newChannelBase, review_update_strategy: "always_new", no_problems: { action: "publish" } } },
    ]);
    const generationNew = await options.runtimeConfig!.admission();
    const headNew = await store.readHead(NAMESPACE);
    expect(generationNew.snapshotId).not.toBe(generationOld.snapshotId);
    expect(headNew?.activeRevision).toBe(2);

    releaseFirstChat();
    const run1 = await run1Promise;
    const run1Requests = captured.splice(0, captured.length);

    const run2 = await postPullRequest(options, createFakeVcs());
    const run2Requests = captured.splice(0, captured.length);

    // Run 1 stayed fully on the pre-publish generation: old provider URL,
    // old model, old channel URL — the new values appear nowhere.
    expect(run1.reviewRun?.configVersion).toMatchObject({
      configSnapshotId: generationOld.snapshotId,
      databaseRevision: headOld?.activeRevision,
    });
    expect(run1Requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: `${oldProviderBase}/chat/completions` },
      { method: "POST", url: `${oldChannelBase}/api/v1/repos/acme/repo/pulls/7/reviews` },
    ]);
    expect(bodyField(run1Requests[0], "model")).toBe("model-old");
    expect(run1Requests.some(request => request.url.includes("9102") || request.url.includes("9202"))).toBe(false);
    expect(JSON.stringify(run1Requests)).not.toContain("model-new");

    // Run 2, admitted after the swap, uses the new head exclusively.
    expect(run2.reviewRun?.configVersion).toMatchObject({
      configSnapshotId: generationNew.snapshotId,
      databaseRevision: headNew?.activeRevision,
    });
    expect(run2Requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: `${newProviderBase}/chat/completions` },
      { method: "POST", url: `${newChannelBase}/api/v1/repos/acme/repo/pulls/7/reviews` },
    ]);
    expect(bodyField(run2Requests[0], "model")).toBe("model-new");
    expect(run2Requests.some(request => request.url.includes("9101") || request.url.includes("9201"))).toBe(false);
    expect(JSON.stringify(run2Requests)).not.toContain("model-old");
    } finally {
      releaseFirstChat();
      await run1Promise.catch(() => undefined);
    }
    await options.closeAutoCommit?.();
  });

  it("E04(c): route target_kinds attribute pull_request and push to their own channels", async () => {
    const providerBase = "http://127.0.0.1:9311/v1";
    const prChannelBase = "http://127.0.0.1:9301";
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      workspaceOperation(),
      providerOperation("p-e04", providerBase),
      modelGroupOperation("g-e04", "p-e04", "model-e04"),
      { op: "set", path: ["llm", "default_model_chain"], value: "g-e04" },
      giteaChannelOperation("c-pr", prChannelBase),
      { op: "create", collection: "channels", record: { id: "c-push", name: "c-push", enabled: true, value: { name: "c-push", kind: "feishu_bot", webhook_url_env: FEISHU_WEBHOOK_ENV } } },
      routeOperation("r-pr", 10, ["pull_request"], ["c-pr"]),
      routeOperation("r-push", 20, ["push"], ["c-push"]),
    ]);
    const generation = await options.runtimeConfig!.admission();
    const orchestration = reviewOptions(options, createFakeVcs());

    const prRun = await runTriggerProcessing(
      "gitea",
      "pull_request",
      { pull_request: { number: 7 } },
      pullRequestEvent(),
      undefined,
      orchestration,
      undefined,
      { runId: "run-e04-pr", configSnapshotId: generation.snapshotId },
    );
    const prRequests = captured.splice(0, captured.length);

    const pushRun = await runTriggerProcessing(
      "gitea",
      "push",
      { ref: "refs/heads/main", before: "base", after: "head" },
      pushEvent(),
      undefined,
      orchestration,
      undefined,
      { runId: "run-e04-push", configSnapshotId: generation.snapshotId },
    );
    const pushRequests = captured.splice(0, captured.length);

    // PR output lands on the PR channel only; the push channel stays silent.
    expect(prRun.reviewRun?.configVersion?.routeId).toBe("r-pr");
    expect(prRequests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: `${providerBase}/chat/completions` },
      { method: "POST", url: `${prChannelBase}/api/v1/repos/acme/repo/pulls/7/reviews` },
    ]);
    expect(prRequests.some(request => request.url === FEISHU_WEBHOOK_URL)).toBe(false);

    // Push output lands on the push (feishu bot) channel only; no PR cross-post.
    expect(pushRun.reviewRun?.configVersion?.routeId).toBe("r-push");
    expect(pushRequests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: `${providerBase}/chat/completions` },
      { method: "POST", url: FEISHU_WEBHOOK_URL },
    ]);
    expect(pushRequests.some(request => request.url.startsWith(prChannelBase))).toBe(false);
    expect(bodyField(pushRequests[1], "msg_type")).toBe("interactive");
    await options.closeAutoCommit?.();
  });
});

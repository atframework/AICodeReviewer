/**
 * E01/E02/E04: publication → review execution end-to-end evidence (P7).
 *
 * E01: one changeset publishes provider + model group + output channel +
 *   route; a real review run for a PR event then proves the integrated chain
 *   by its captured HTTP requests (LLM URL/model, output URL, count, order)
 *   and by the run's pinned config version — never by "published" status.
 * E02: a changeset published mid-flight (LLM response blocked on a deferred
 *   gate) never leaks into the in-flight run: run 1 keeps every old
 *   endpoint/model/channel/agent option, run 2 uses the new head
 *   exclusively — including a route-body switch to a second channel and
 *   republished agent globals (timeout/web_search/auto_approve), proven from
 *   the per-run resolved options.
 * E04: one match-rule workspace definition and one route serve two Git
 *   projects on two gitea triggers; each run resolves the same route/model
 *   but its own workspace instance, its owning trigger's output URL and that
 *   trigger's outbound token — no cross-posts.
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

import { createReviewEvent, parseConfigDocumentText, type ConfigChangesetOperation, type ConfigStore, type ReviewEvent } from "@aicr/core";
import { createSqliteConfigStore } from "@aicr/core";
import type { AppConfig } from "@aicr/core";
import { closeStoreDb, getRecentRuns } from "@aicr/store";
import { parseUnifiedDiff, type ChangeRange } from "@aicr/vcs";
import { bootstrapServerApp, createOutputPublisherResolverFromConfig } from "../src/bootstrap.js";
import { GithubAppTokenService } from "../src/github-app-token.js";
import { createServerApp, runTriggerProcessing, type ServerAppOptions, type TriggerProcessingResult } from "../src/index.js";
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
      { name: "gitea-main", kind: "gitea", base_url: "http://127.0.0.1:9401", token_env: "GITEA_TOKEN", webhook_secret_env: "GITEA_SECRET" },
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
    // Published gitea_pr_review channels carry no token of their own: they
    // inherit the file trigger's outbound token, and each inheritance needs
    // its exact destination signature authorized (publish secret policy).
    { env: "GITEA_TOKEN", target: ["outputs", "channels", "c-e01", "token_env"], destinations: { kind: "gitea_pr_review", trigger: "gitea-main", base_url: "http://127.0.0.1:9021", trigger_destination: { kind: "gitea", base_url: "http://127.0.0.1:9401" } } },
    { env: "GITEA_TOKEN", target: ["outputs", "channels", "c-e02", "token_env"], destinations: { kind: "gitea_pr_review", trigger: "gitea-main", base_url: "http://127.0.0.1:9201", trigger_destination: { kind: "gitea", base_url: "http://127.0.0.1:9401" } } },
    { env: "GITEA_TOKEN", target: ["outputs", "channels", "c-e02-b", "token_env"], destinations: { kind: "gitea_pr_review", trigger: "gitea-main", base_url: "http://127.0.0.1:9202", trigger_destination: { kind: "gitea", base_url: "http://127.0.0.1:9401" } } },
    { env: "GITEA_TOKEN", target: ["outputs", "channels", "c-pr", "token_env"], destinations: { kind: "gitea_pr_review", trigger: "gitea-main", base_url: "http://127.0.0.1:9301", trigger_destination: { kind: "gitea", base_url: "http://127.0.0.1:9401" } } },
    { env: "GITEA_TOKEN", target: ["outputs", "channels", "c-e04w", "token_env"], destinations: { kind: "gitea_pr_review", trigger: "gitea-main", trigger_destination: { kind: "gitea", base_url: "http://127.0.0.1:9401" } } },
    { env: "GITEA_TOKEN_ALT", target: ["outputs", "channels", "c-e04w", "token_env"], destinations: { kind: "gitea_pr_review", trigger: "gitea-alt", trigger_destination: { kind: "gitea", base_url: "http://127.0.0.1:9402" } } },
    { env: "GITLAB_TOKEN", target: ["outputs", "channels", "c-e05", "token_env"], destinations: { kind: "gitlab_mr_review", trigger: "gitlab-main", trigger_destination: { kind: "gitlab", base_url: "http://127.0.0.1:9501" } } },
    { env: "GITLAB_TOKEN_ALT", target: ["outputs", "channels", "c-e05", "token_env"], destinations: { kind: "gitlab_mr_review", trigger: "gitlab-alt", trigger_destination: { kind: "gitlab", base_url: "http://127.0.0.1:9502" } } },
  ] },
  llm: {
    providers: [{ id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" }],
    model_chain: { default: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }] },
  },
  triggers: [
    { name: "gitea-main", kind: "gitea", base_url: "http://127.0.0.1:9401", token_env: "GITEA_TOKEN", webhook_secret_env: "GITEA_SECRET" },
    // Second host profile (E04): own base_url, token and webhook secret.
    { name: "gitea-alt", kind: "gitea", base_url: "http://127.0.0.1:9402", token_env: "GITEA_TOKEN_ALT", webhook_secret_env: "GITEA_SECRET_ALT" },
    { name: "gitlab-main", kind: "gitlab", base_url: "http://127.0.0.1:9501", token_env: "GITLAB_TOKEN", webhook_secret_env: "GITLAB_SECRET" },
    { name: "gitlab-alt", kind: "gitlab", base_url: "http://127.0.0.1:9502", token_env: "GITLAB_TOKEN_ALT", webhook_secret_env: "GITLAB_SECRET_ALT" },
  ],
};

let dir: string;
let store: ConfigStore;
let bootstrapped: ServerAppOptions | undefined;
const originalEnv: Record<string, string | undefined> = {};
const MANAGED_ENV = ["OPENAI_API_KEY", "GITEA_TOKEN", "GITEA_TOKEN_ALT", "GITEA_SECRET", "GITEA_SECRET_ALT", "GITLAB_TOKEN", "GITLAB_TOKEN_ALT", "GITLAB_SECRET", "GITLAB_SECRET_ALT", "AICR_ADMIN_USERNAME", "AICR_ADMIN_PASSWORD", FEISHU_WEBHOOK_ENV];

beforeEach(async () => {
  mkdirSync("build/tmp", { recursive: true });
  dir = mkdtempSync(join(process.cwd(), "build/tmp/aicr-e2e-publish-review-"));
  for (const name of MANAGED_ENV) {
    originalEnv[name] = process.env[name];
  }
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GITEA_TOKEN = "token-one";
  process.env.GITEA_TOKEN_ALT = "token-two";
  process.env.GITEA_SECRET = "test-secret";
  process.env.GITEA_SECRET_ALT = "test-secret-alt";
  process.env.GITLAB_TOKEN = "gitlab-token-one";
  process.env.GITLAB_TOKEN_ALT = "gitlab-token-two";
  process.env.GITLAB_SECRET = "gitlab-secret-one";
  process.env.GITLAB_SECRET_ALT = "gitlab-secret-two";
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

interface PullRequestTarget {
  readonly repo?: string;
  readonly prNumber?: number;
  /** Webhook secret of the owning trigger (E04); defaults to gitea-main's. */
  readonly secret?: string;
}

/** The synchronous webhook response: run summary plus the translated event. */
type PullRequestRunResult = TriggerProcessingResult & {
  readonly reviewEvent?: ReviewEvent;
};

async function postPullRequest(
  options: ServerAppOptions,
  vcs: DiffCapableVcsAdapter,
  target: PullRequestTarget = {},
  onResolved?: (snapshot: ResolvedRunSnapshot) => void,
  preserveAgentSelection = false,
): Promise<PullRequestRunResult> {
  const app = createServerApp({ ...options, asyncTriggers: false, reviewOrchestration: reviewOptions(options, vcs, onResolved, preserveAgentSelection) });
  const body = JSON.stringify({ action: "opened", repository: { full_name: target.repo ?? "acme/repo" },
    pull_request: { number: target.prNumber ?? 7, base: { sha: "base", ref: "main" }, head: { sha: "head", ref: "feature" }, user: { login: "owent" } } });
  const response = await app.request("/webhooks/gitea", { method: "POST", body, headers: {
    "content-type": "application/json", "x-gitea-event": "pull_request",
    "x-gitea-signature": createHmac("sha256", target.secret ?? "test-secret").update(body).digest("hex"),
  } });
  const result = await response.json() as PullRequestRunResult;
  expect(response.status).toBe(202);
  return result;
}

// ---------------------------------------------------------------------------
// Fetch spy: every external call is captured; unknown URLs fail fast.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  /** Request headers, lowercased (E04 outbound-credential attribution). */
  readonly headers: Readonly<Record<string, string>>;
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
    const headers: Record<string, string> = {};
    const rawHeaders = (init as { headers?: Record<string, string> } | undefined)?.headers;
    if (rawHeaders) {
      new Headers(rawHeaders).forEach((value, key) => { headers[key] = value; });
    }
    captured.push({ method, url: target, headers, ...(body !== undefined ? { body } : {}) });
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
    if (target.includes("/reviews") || target.includes("/notes")) {
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
 * Per-run resolved execution plan snapshot (E02): the agent fields the pinned
 * generation actually resolved, captured as data before the test seam strips
 * the agent CLI path. H03 proves these flow into real bundles; here they
 * prove per-generation resolution across a mid-flight publish.
 */
interface ResolvedRunSnapshot {
  readonly agentKind: string | undefined;
  readonly agentTimeoutMs: number | undefined;
  readonly agentAutoApprove: boolean | undefined;
  readonly webSearchEnabled: boolean | undefined;
}

/**
 * Production orchestration options with two test-only substitutions applied
 * AFTER the production optionsResolver ran (so generation pinning, model
 * routing and output-publisher resolution are all production behavior):
 * the VCS adapter is faked and the agent CLI/sandbox path is disabled, which
 * selects the direct-LLM completion path whose HTTP call the spy captures.
 */
function reviewOptions(
  options: ServerAppOptions,
  vcs: DiffCapableVcsAdapter,
  onResolved?: (snapshot: ResolvedRunSnapshot) => void,
  preserveAgentSelection = false,
): ServerReviewOrchestrationOptions {
  const base = options.reviewOrchestration!;
  const resolve = base.optionsResolver!;
  // Strip the agent CLI path at BOTH layers: the bootstrap fallback carries
  // sandboxFactory/agentAdapter and so does the per-generation resolved layer;
  // without a sandbox the orchestrator takes the direct-LLM completion path
  // whose HTTP request the fetch spy captures.
  const { agentAdapter: _baseAgent, sandboxFactory: _baseSandbox, ...withoutBaseAgent } = base;
  const baseRest = preserveAgentSelection ? base : withoutBaseAgent;
  return {
    ...baseRest,
    optionsResolver: async (context: ReviewOrchestrationContext) => {
      const resolved = await resolve(context);
      onResolved?.({
        agentKind: resolved.agentAdapter?.kind,
        agentTimeoutMs: resolved.agentTimeoutMs,
        agentAutoApprove: resolved.agentAutoApprove,
        webSearchEnabled: resolved.webSearch?.enabled,
      });
      const { agentAdapter: _agent, sandboxFactory: _sandbox, ...withoutResolvedAgent } = resolved;
      const rest = preserveAgentSelection ? resolved : withoutResolvedAgent;
      return { ...rest, vcs, vcsFactory: () => vcs };
    },
  };
}

function pullRequestEvent() {
  return createReviewEvent({
    triggerName: "gitea-main",
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
    triggerName: "gitea-main",
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
  return { op: "create" as const, collection: "workspaces" as const, record: { id: "ws", name: "ws", enabled: true, value: { source_repo: { trigger: "gitea-main", repo: "acme/repo" } } } };
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
  return { op: "create" as const, collection: "channels" as const, record: { id, name: id, enabled: true, value: { name: id, kind: "gitea_pr_review", trigger: "gitea-main", base_url: baseUrl, review_update_strategy: "always_new", no_problems: { action: "publish" } } } };
}

function routeOperation(id: string, priority: number, targetKinds: readonly string[], summaryChannels: readonly string[]) {
  return {
    op: "create" as const, collection: "routes" as const,
    record: {
      id, name: id, enabled: true,
      value: { id, enabled: true, priority, workspace: "ws", match: { triggers: ["gitea-main"], target_kinds: [...targetKinds] }, outputs: { line_comments: [], summary: [...summaryChannels] } },
    },
  };
}

describe("config publication → review execution e2e", () => {
  it.each([
    [{ object_kind: "merge_request", object_attributes: { iid: 9, id: 999 } }, 9],
    [{ object_kind: "note", object_attributes: { iid: 333 }, merge_request: { iid: 10, id: 999 } }, 10],
    [{ object_kind: "merge_request", object_attributes: { id: 999 } }, null],
    [{ object_kind: "merge_request", object_attributes: { iid: 0 } }, null],
    [{ object_kind: "merge_request", object_attributes: { iid: 1.5 } }, null],
  ])("uses only the GitLab MR IID for payload %j", async (payload, iid) => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const { config } = parseConfigDocumentText(JSON.stringify({
      triggers: [{ name: "gl", kind: "gitlab", base_url: "http://127.0.0.1:9501", token_env: "GITLAB_TOKEN" }],
      outputs: { channels: [{ name: "mr", kind: "gitlab_mr_review", no_problems: { action: "publish" } }], routes: { default: { summary: ["mr"] } } },
    }));
    const publisher = await createOutputPublisherResolverFromConfig(config)({
      provider: "gitlab", eventName: "Merge Request Hook", payload,
      reviewEvent: createReviewEvent({ triggerName: "gl", provider: "gitlab", workspaceId: "ws", targetKind: "pull_request", repoRef: "group/sub/service", author: {}, reason: "gitlab:review" }),
    });
    if (iid === null) {
      expect(publisher).toBeUndefined();
      expect(captured).toEqual([]);
    } else {
      expect(publisher?.publishSummary).toBeTypeOf("function");
      await publisher!.publishSummary!(SUMMARY_SENTINEL, []);
      expect(captured.map(entry => entry.url)).toEqual([`http://127.0.0.1:9501/api/v4/projects/group%2Fsub%2Fservice/merge_requests/${iid}/notes`]);
    }
  });

  it("resolves a GitHub App token for each output's explicit trigger and target repository", async () => {
    const serviceA = new GithubAppTokenService({ appId: "1", privateKey: "unused-test-key" });
    const serviceB = new GithubAppTokenService({ appId: "2", privateKey: "unused-test-key" });
    const tokenA = vi.spyOn(serviceA, "getInstallationTokenForRepo").mockResolvedValue("app-a-token");
    const tokenB = vi.spyOn(serviceB, "getInstallationTokenForRepo").mockResolvedValue("app-b-token");
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const { config } = parseConfigDocumentText(JSON.stringify({
      triggers: [
        { name: "app-a", kind: "github", base_url: "https://github.com", app: { app_id: "1", private_key_env: "APP_A_KEY" } },
        { name: "app-b", kind: "github", base_url: "https://github.enterprise.example", app: { app_id: "2", private_key_env: "APP_B_KEY" } },
      ],
      outputs: { channels: [{ name: "review", kind: "github_pr_review", trigger: "app-b", owner: "target", repo: "repo", review_update_strategy: "always_new", no_problems: { action: "publish" } }],
        routes: { default: { line_comments: ["review"], summary: ["review"] } } },
    }));
    const publisher = await createOutputPublisherResolverFromConfig(config, { appTokenServices: new Map([["app-a", serviceA], ["app-b", serviceB]]) })({
      provider: "github", eventName: "pull_request", payload: { pull_request: { number: 7 } },
      reviewEvent: createReviewEvent({ triggerName: "app-a", provider: "github", workspaceId: "ws", targetKind: "pull_request", repoRef: "source/repo", author: {}, reason: "github:review" }),
    });
    await publisher!.publishSummary!(SUMMARY_SENTINEL, []);
    expect(tokenA).not.toHaveBeenCalled();
    expect(tokenB.mock.calls).toEqual([["target", "repo"]]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://github.enterprise.example/api/v3/repos/target/repo/pulls/7/reviews");
    expect(captured[0]?.headers.authorization).toBe("Bearer app-b-token");
  });

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
      { op: "set", path: ["agent", "default"], value: "native-llm" },
      giteaChannelOperation("c-e01", channelBase),
      routeOperation("r-e01", 10, ["pull_request"], ["c-e01"]),
    ]);
    const head = await store.readHead(NAMESPACE);
    expect(head?.activeRevision).toBe(1);

    let resolvedAgentKind: string | undefined;
    const result = await postPullRequest(options, createFakeVcs(), {}, snapshot => {
      resolvedAgentKind = snapshot.agentKind;
    }, true);
    const generation = options.runtimeConfig!.current();

    expect(result.outcome).toBe("reviewed");
    expect(result.reviewRun?.status).toBe("published");
    expect(result.reviewRun?.problemCount).toBe(0);
    expect(resolvedAgentKind).toBeUndefined();
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

  it("M17: shutdown drains an accepted asynchronous review through publication and rejects later admissions", async () => {
    let release!: () => void, entered!: () => void;
    const holdFirstChat = new Promise<void>(resolve => { release = resolve; });
    const firstChat = new Promise<void>(resolve => { entered = resolve; });
    const captured: CapturedRequest[] = [];
    stubFetch(captured, { holdFirstChat, onFirstChat: entered });
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      workspaceOperation(), providerOperation("p-drain", "http://127.0.0.1:9011/v1"),
      modelGroupOperation("g-drain", "p-drain", "model-drain"),
      { op: "set", path: ["llm", "default_model_chain"], value: "g-drain" },
      giteaChannelOperation("c-e01", "http://127.0.0.1:9021"), routeOperation("r-drain", 10, ["pull_request"], ["c-e01"]),
    ]);
    const app = createServerApp({ ...options, asyncTriggers: true, reviewOrchestration: reviewOptions(options, createFakeVcs()) });
    const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/repo" },
      pull_request: { number: 7, base: { sha: "base", ref: "main" }, head: { sha: "head", ref: "feature" }, user: { login: "owent" } } });
    const send = () => app.request("/webhooks/gitea", { method: "POST", body, headers: {
      "content-type": "application/json", "x-gitea-event": "pull_request",
      "x-gitea-signature": createHmac("sha256", "test-secret").update(body).digest("hex"),
    } });
    let closing: Promise<void> | undefined;
    try {
      expect((await send()).status).toBe(202);
      await firstChat;
      let closed = false;
      closing = options.closeAutoCommit!().then(() => { closed = true; });
      expect((await app.request("/readyz")).status).toBe(503);
      expect((await send()).status).toBe(503);
      expect(options.runtimeConfig!.status()).toMatchObject({ draining: true, pendingTasks: 1 });
      expect(closed).toBe(false);
      release();
      await closing;
      expect(options.runtimeConfig!.status()).toMatchObject({ activeLeases: 0, pendingTasks: 0 });
      expect(await getRecentRuns(options.store!, 10)).toEqual([expect.objectContaining({ status: "succeeded", providerModel: "model-drain" })]);
      expect(captured.map(entry => entry.url)).toEqual([
        "http://127.0.0.1:9011/v1/chat/completions", "http://127.0.0.1:9021/api/v1/repos/acme/repo/pulls/7/reviews",
      ]);
    } finally { release(); await closing; }
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
      // Agent globals managed by the database (architecture §3.15): run 1 must pin
      // these exact published values, not schema defaults.
      { op: "set", path: ["agent", "timeout_seconds"], value: 1800 },
      { op: "set", path: ["agent", "auto_approve"], value: true },
      { op: "set", path: ["agent", "web_search", "enabled"], value: false },
    ]);
    const generationOld = await options.runtimeConfig!.admission();
    const headOld = await store.readHead(NAMESPACE);

    const resolvedRuns: ResolvedRunSnapshot[] = [];
    const run1Promise = postPullRequest(options, createFakeVcs(), {}, (snapshot) => resolvedRuns.push(snapshot));
    try {
    // Run 1 is now blocked inside the LLM completion against the OLD provider.
    await firstChatArrived;
    // Swap provider base_url + model, switch the route body to a SECOND
    // gitea_pr_review channel with a different URL, and republish the agent
    // globals — all underneath the live run.
    await publishOperations([
      { op: "update", collection: "providers", recordId: "p-e02", value: { id: "p-e02", kind: "openai_compatible", base_url: newProviderBase } },
      { op: "update", collection: "model_groups", recordId: "g-e02", value: [{ provider: "p-e02", model: "model-new", role: "heavy" }] },
      giteaChannelOperation("c-e02-b", newChannelBase),
      { op: "update", collection: "routes", recordId: "r-e02", value: { id: "r-e02", enabled: true, priority: 10, workspace: "ws", match: { triggers: ["gitea-main"], target_kinds: ["pull_request"] }, outputs: { line_comments: [], summary: ["c-e02-b"] } } },
      { op: "set", path: ["agent", "timeout_seconds"], value: 91 },
      { op: "set", path: ["agent", "auto_approve"], value: false },
      { op: "set", path: ["agent", "web_search", "enabled"], value: true },
    ]);
    const generationNew = await options.runtimeConfig!.admission();
    const headNew = await store.readHead(NAMESPACE);
    expect(generationNew.snapshotId).not.toBe(generationOld.snapshotId);
    expect(headNew?.activeRevision).toBe(2);

    releaseFirstChat();
    const run1 = await run1Promise;
    const run1Requests = captured.splice(0, captured.length);
    const run1Resolved = resolvedRuns.splice(0, resolvedRuns.length);

    const run2 = await postPullRequest(options, createFakeVcs(), {}, (snapshot) => resolvedRuns.push(snapshot));
    const run2Requests = captured.splice(0, captured.length);
    const run2Resolved = resolvedRuns.splice(0, resolvedRuns.length);

    // Run 1 stayed fully on the pre-publish generation: old provider URL,
    // old model, old channel URL, old agent options — the new values appear
    // nowhere. The resolved execution plan is asserted as data: one resolver
    // call per run, old channel c-e02 still bound to the route.
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
    expect(run1Resolved).toEqual([
      { agentKind: "kilo", agentTimeoutMs: 1_800_000, agentAutoApprove: true, webSearchEnabled: false },
    ]);

    // Run 2, admitted after the swap, uses the new head exclusively: the
    // route body now points at channel c-e02-b and the republished agent
    // globals resolve into the run's execution plan.
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
    expect(run2Resolved).toEqual([
      { agentKind: "kilo", agentTimeoutMs: 91_000, agentAutoApprove: false, webSearchEnabled: true },
    ]);
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

  it("E05: fork MR reviews preserve target subgroups and the accepting profile's outbound token", async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      providerOperation("p-e05", "http://127.0.0.1:9511/v1"),
      modelGroupOperation("g-e05", "p-e05", "model-e05"),
      { op: "create", collection: "workspaces", record: { id: "services", name: "services", enabled: true, value: {
        model_chain: "g-e05", match: [{ triggers: ["gitlab-main", "gitlab-alt"], source: { repo_ref: { glob: "group/sub/*" } } }],
        work_path: "{{segment gitlab.project}}/{{segment gitlab.target_project_id}}",
      } } },
      { op: "create", collection: "channels", record: { id: "c-e05", name: "c-e05", enabled: true,
        value: { name: "c-e05", kind: "gitlab_mr_review", no_problems: { action: "publish" } } } },
      { op: "create", collection: "routes", record: { id: "r-e05", name: "r-e05", enabled: true, value: {
        id: "r-e05", workspace: "services", match: { triggers: ["gitlab-main", "gitlab-alt"], target_kinds: ["pull_request"] },
        outputs: { line_comments: [], summary: ["c-e05"] },
      } } },
    ]);
    const app = createServerApp({ ...options, asyncTriggers: false, reviewOrchestration: reviewOptions(options, createFakeVcs()) });
    const instances: string[] = [];
    for (const [trigger, port, secret, token, project, iid] of [
      ["gitlab-main", 9501, "gitlab-secret-one", "gitlab-token-one", 12, 9],
      ["gitlab-alt", 9502, "gitlab-secret-two", "gitlab-token-two", 13, 10],
    ] as const) {
      const response = await app.request("/webhooks/gitlab", { method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": secret },
        body: JSON.stringify({ object_kind: "merge_request", project: { id: project, path_with_namespace: "group/sub/service", default_branch: "main" },
          object_attributes: { iid, action: "open", source_project_id: 44, target_project_id: project,
            source_branch: "feature/fork-change", target_branch: "main", diff_refs: { base_sha: "base", head_sha: "head" }, last_commit: { id: "head" },
            source: { id: 44, path_with_namespace: "fork-owner/service" }, target: { id: project, path_with_namespace: "group/sub/service" } },
          user: { username: "fork-dev" } }),
      });
      const run = await response.json() as PullRequestRunResult;
      expect(response.status).toBe(202);
      expect(run.outcome).toBe("reviewed");
      expect(run.reviewRun?.status).toBe("published");
      expect(run.reviewRun?.configVersion).toMatchObject({ databaseRevision: 1, routeId: "r-e05" });
      expect(run.reviewEvent).toMatchObject({ triggerName: trigger, repoRef: "group/sub/service", branch: "feature/fork-change", targetBranch: "main" });
      const resolution = run.reviewEvent?.resolution;
      if (resolution?.kind !== "match") throw new Error("expected match binding");
      instances.push(resolution.binding.instanceId);
      expect(resolution.binding.workPath).toBe(`service/${project}`);
      expect(captured.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: "POST", url: "http://127.0.0.1:9511/v1/chat/completions" },
        { method: "POST", url: `http://127.0.0.1:${port}/api/v4/projects/group%2Fsub%2Fservice/merge_requests/${iid}/notes` },
      ]);
      expect(bodyField(captured[0], "model")).toBe("model-e05");
      expect(captured[1]?.headers["private-token"]).toBe(token);
      expect(bodyField(captured[1], "body")).toContain(SUMMARY_SENTINEL);
      captured.length = 0;
    }
    expect(new Set(instances).size).toBe(2);
  });

  it("E04: one match-rule definition attributes model, output URL and outbound token per owning trigger", async () => {
    const providerBase = "http://127.0.0.1:9411/v1";
    const mainBase = "http://127.0.0.1:9401";
    const altBase = "http://127.0.0.1:9402";
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    const { options } = await bootstrap(makeConfig());
    // ONE changeset: provider P, model group G assigned to the match-rule
    // workspace definition, channel C and route R bound to that definition.
    // The definition itself is published (file-owned entities are read-only,
    // so a changeset could never bind G to a file-owned definition).
    await publishOperations([
      { op: "create", collection: "workspaces", record: { id: "services", name: "services", enabled: true, value: {
        model_chain: "g-e04w",
        match: [{ triggers: ["gitea-main", "gitea-alt"], source: { repo_ref: { glob: "acme/*" } } }],
        work_path: "{{segment source.namespace}}/{{segment source.repository}}",
      } } },
      providerOperation("p-e04w", providerBase),
      modelGroupOperation("g-e04w", "p-e04w", "model-e04w"),
      // No trigger/base_url/owner/repo pins on the channel: the run's owning
      // trigger supplies host and credential, the event supplies the repo.
      { op: "create", collection: "channels", record: { id: "c-e04w", name: "c-e04w", enabled: true, value: { name: "c-e04w", kind: "gitea_pr_review", review_update_strategy: "always_new", no_problems: { action: "publish" } } } },
      { op: "create", collection: "routes", record: { id: "r-e04w", name: "r-e04w", enabled: true, value: {
        id: "r-e04w", enabled: true, priority: 10, workspace: "services",
        match: { triggers: ["gitea-main", "gitea-alt"], target_kinds: ["pull_request"] },
        outputs: { line_comments: [], summary: ["c-e04w"] },
      } } },
    ]);
    const generation = await options.runtimeConfig!.admission();
    const head = await store.readHead(NAMESPACE);

    const runA = await postPullRequest(options, createFakeVcs(), { repo: "acme/service-a", prNumber: 7 });
    const runARequests = captured.splice(0, captured.length);
    const runB = await postPullRequest(options, createFakeVcs(), { repo: "acme/service-b", prNumber: 9, secret: "test-secret-alt" });
    const runBRequests = captured.splice(0, captured.length);

    const bindingOf = (run: PullRequestRunResult) => {
      const resolution = run.reviewEvent?.resolution;
      if (resolution?.kind !== "match") throw new Error("expected a match resolution on the run's review event");
      return resolution.binding;
    };

    // Both runs reviewed and published through the SAME rule.
    expect(runA.outcome).toBe("reviewed");
    expect(runB.outcome).toBe("reviewed");
    expect(runA.reviewRun?.status).toBe("published");
    expect(runB.reviewRun?.status).toBe("published");

    // (i) One definition, but a distinct workspace instance and work path
    // per repository.
    expect(runA.reviewEvent).toMatchObject({ triggerName: "gitea-main", workspaceId: "services", repoRef: "acme/service-a" });
    expect(runB.reviewEvent).toMatchObject({ triggerName: "gitea-alt", workspaceId: "services", repoRef: "acme/service-b" });
    const bindingA = bindingOf(runA);
    const bindingB = bindingOf(runB);
    expect(bindingA.definitionId).toBe("services");
    expect(bindingB.definitionId).toBe("services");
    expect(bindingA.instanceId).not.toBe(bindingB.instanceId);
    expect(bindingA.workPath).toBe("acme/service-a");
    expect(bindingB.workPath).toBe("acme/service-b");

    // (iv) Same routeId and snapshot (one rule, one pinned generation);
    // the repoRef differs per run.
    expect(runA.reviewRun?.configVersion).toMatchObject({
      configSnapshotId: generation.snapshotId,
      databaseRevision: head?.activeRevision,
      routeId: "r-e04w",
    });
    expect(runB.reviewRun?.configVersion).toMatchObject({
      configSnapshotId: generation.snapshotId,
      databaseRevision: head?.activeRevision,
      routeId: "r-e04w",
    });

    // (ii) Both chat bodies carry G's model against P's endpoint…
    expect(runARequests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: `${providerBase}/chat/completions` },
      { method: "POST", url: `${mainBase}/api/v1/repos/acme/service-a/pulls/7/reviews` },
    ]);
    expect(runBRequests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: `${providerBase}/chat/completions` },
      { method: "POST", url: `${altBase}/api/v1/repos/acme/service-b/pulls/9/reviews` },
    ]);
    expect(bodyField(runARequests[0], "model")).toBe("model-e04w");
    expect(bodyField(runBRequests[0], "model")).toBe("model-e04w");

    // (iii) …while each output POST lands on the OWNING trigger's host with
    // THAT trigger's outbound token.
    expect(bodyField(runARequests[1], "event")).toBe("COMMENT");
    expect(bodyField(runBRequests[1], "event")).toBe("COMMENT");
    expect(runARequests[1]?.headers.authorization).toBe("token token-one");
    expect(runBRequests[1]?.headers.authorization).toBe("token token-two");

    // (v) No cross-posts: neither run touched the other trigger's host.
    expect(runARequests.some(request => request.url.includes("9402"))).toBe(false);
    expect(runBRequests.some(request => request.url.includes("9401"))).toBe(false);
    await options.closeAutoCommit?.();
  });
});

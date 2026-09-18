/**
 * Bootstrap ↔ RuntimeConfigManager integration tests (P4): a published
 * revision changes what the next task actually consumes — model routes pick
 * up new providers/endpoints (H01/H02), the fixed dispatcher picks up new
 * triggers (H06), analysis selection honors workspace agent/sandbox layers
 * (H03/H04), and the review path policy resolver reflects workspace layers
 * (H05). Backed by a real SQLite config store wired through
 * `config_sources.database.enabled`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReviewEvent, prepareConfigPublication, publishConfig, previewConfigRoute, type ConfigStore } from "@aicr/core";
import { createSqliteConfigStore } from "@aicr/core";
import type { AppConfig } from "@aicr/core";
import { closeStoreDb, createStoreDb } from "@aicr/store";
import { bootstrapServerApp } from "../src/bootstrap.js";
import { resolveTriggerRetryConfig, runTriggerProcessing, type ServerAppOptions } from "../src/index.js";
import { RuntimeConfigManager } from "../src/runtime-config.js";
import { AutoCommitScheduler } from "../src/auto-commit-scheduler.js";
import { materializeRuntimeBundle } from "@aicr/agents";
import * as modelCatalog from "../src/model-catalog-service.js";

const NAMESPACE = "gen-test";

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
  config_sources: { secret_refs: [{ env: "GITHUB_DYN_SECRET", target: ["triggers", "github-dyn", "webhook_secret_env"], destinations: { kind: "github" } }] },
  llm: {
    providers: [{ id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" }],
    model_chain: { default: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }] },
  },
  triggers: [{ name: "gitea-internal", kind: "gitea", base_url: "https://gitea.example.com" }],
};

let dir: string;
let store: ConfigStore;
let bootstrapped: ServerAppOptions | undefined;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aicr-runtime-generation-"));
  for (const name of ["OPENAI_API_KEY", "GITEA_TOKEN", "GITEA_SECRET", "AICR_ADMIN_USERNAME", "AICR_ADMIN_PASSWORD"]) {
    originalEnv[name] = process.env[name];
  }
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GITEA_TOKEN = "test-token";
  process.env.GITEA_SECRET = "test-secret";
  process.env.AICR_ADMIN_USERNAME = "admin";
  process.env.AICR_ADMIN_PASSWORD = "admin-password";
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
  }
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly options: ServerAppOptions;
}

async function bootstrap(config: AppConfig, fileDocument = FILE_DOCUMENT): Promise<Harness> {
  const options = await bootstrapServerApp({
    config,
    baseSystemPrompt: "test",
    baseDir: dir,
    configDocument: {
      document: fileDocument,
      digest: "d".repeat(64),
    },
  });
  bootstrapped = options;
  return { options };
}

async function publishOperations(operations: Parameters<typeof prepareConfigPublication>[0]["operations"], fileDocument = FILE_DOCUMENT): Promise<void> {
  const head = await store.readHead(NAMESPACE);
  const prepared = prepareConfigPublication({
    namespace: NAMESPACE,
    baseRevision: head?.activeRevision ?? null,
    operationId: `op-${Math.random().toString(36).slice(2, 10)}`,
    actor: "test",
    file: fileDocument,
    fileDigest: "d".repeat(64),
    current: head === null ? {} : ((await store.readRevision(NAMESPACE, head.activeRevision))?.document ?? {}),
    operations,
    formatVersion: 2,
  });
  const result = await publishConfig(store, prepared, {});
  if (result.status !== "committed") throw new Error(`publish failed: ${result.status}`);
}

describe("runtime config generation integration (bootstrap)", () => {
  it("pins document rendering and shared overrides, then resets globals to file and schema defaults", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === "string") bodies.push(init.body);
      return new Response(JSON.stringify({ id: 7 }), { headers: { "content-type": "application/json" } });
    });
    const file = { ...FILE_DOCUMENT, agent: { timeout_seconds: 120 }, review: { max_files: 17 },
      queue: { retry: { attempts: 2, backoff: { kind: "constant", base_ms: 99 } } } };
    const { options } = await bootstrap(makeConfig(), file);
    await publishOperations([
      { op: "create", collection: "prompts", record: { id: "base", name: "base", enabled: true, value: "---\nname: Base\n---\nOld base" } },
      { op: "create", collection: "prompts", record: { id: "extra", name: "extra", enabled: true, value: "---\nname: Extra\n---\nOld extra" } },
      { op: "create", collection: "templates", record: { id: "summary", name: "summary", enabled: true, value: "---\nname: Summary\n---\nOld template {{summary}}" } },
      { op: "create", collection: "workspaces", record: { id: "ws", name: "ws", enabled: true, value: {
        source_repo: { trigger: "gitea-internal", repo: "acme/repo" }, prompt: { system_prompt: "base", extra_system_prompt: "extra" } } } },
      { op: "create", collection: "channels", record: { id: "out", name: "out", enabled: true, value: { name: "out", kind: "gitea_pr_review",
        trigger: "gitea-internal", templates: { summary: "summary" }, review_update_strategy: "always_new", no_problems: { action: "publish" } } } },
      { op: "set", path: ["outputs", "routes", "default"], value: { summary: ["out"] } },
    ], file);
    const old = await options.runtimeConfig!.admission();
    const event = createReviewEvent({ triggerName: "gitea-internal", provider: "gitea", workspaceId: "ws", targetKind: "pull_request", repoRef: "acme/repo", author: {}, reason: "test" });
    const context = { reviewEvent: event, payload: { pull_request: { number: 7 } }, provider: "gitea" as const, eventName: "pull_request", configSnapshotId: old.snapshotId };
    const resolve = options.reviewOrchestration!.optionsResolver!;
    await publishOperations([
      { op: "update", collection: "prompts", recordId: "base", value: "New base" },
      { op: "update", collection: "prompts", recordId: "extra", value: "New extra" },
      { op: "update", collection: "templates", recordId: "summary", value: "New template {{summary}}" },
      { op: "set", path: ["agent", "timeout_seconds"], value: 45 },
      { op: "set", path: ["agent", "auto_approve"], value: false },
      { op: "set", path: ["review", "max_files"], value: 3 },
      { op: "set", path: ["queue", "retry", "attempts"], value: 5 },
    ], file);
    const next = await options.runtimeConfig!.admission();
    const oldOptions = await resolve(context);
    const newContext = { ...context, configSnapshotId: next.snapshotId };
    const newOptions = await resolve(newContext);
    for (const [run, prefix, timeout, maxFiles] of [[oldOptions, "Old", 120_000, 17], [newOptions, "New", 45_000, 3]] as const) {
      expect(await run.baseSystemPromptResolver!("ws")).toBe(`${prefix} base`);
      expect(await run.extraSystemPromptResolver!("ws")).toBe(`${prefix} extra`);
      expect(run.agentTimeoutMs).toBe(timeout);
      expect(run.reviewPolicyResolver!("ws")?.max_files).toBe(maxFiles);
    }
    expect(newOptions.agentAutoApprove).toBe(false);
    expect(resolveTriggerRetryConfig(old.config)).toMatchObject({ attempts: 2, backoff: { base_ms: 99 } });
    expect(resolveTriggerRetryConfig(next.config)).toMatchObject({ attempts: 5, backoff: { base_ms: 99 } });
    await (await oldOptions.outputPublisherResolver!(context))!.publishSummary!("sentinel");
    await (await newOptions.outputPublisherResolver!(newContext))!.publishSummary!("sentinel");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("Old template sentinel");
    expect(bodies[1]).toContain("New template sentinel");
    expect(bodies.join("\n")).not.toContain("name: Summary");
    await publishOperations(["agent", "review"].map(key => ({ op: "unset" as const, path: [key] })).concat([
      { op: "unset", path: ["queue", "retry"] },
    ]), file);
    const reset = await options.runtimeConfig!.admission();
    const resetOptions = await resolve({ ...context, configSnapshotId: reset.snapshotId });
    expect(resetOptions.agentTimeoutMs).toBe(120_000);
    expect(resetOptions.agentAutoApprove).toBe(true);
    expect(resetOptions.reviewPolicyResolver!("ws")?.max_files).toBe(17);
    expect(resolveTriggerRetryConfig(reset.config)).toMatchObject({ attempts: 2 });
    expect((await resolve(newContext)).agentTimeoutMs).toBe(45_000);
  });

  it("R08/R13/H07: preview and actual publishers follow pinned v2 routes, including explicit empty output", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { requests.push(String(url)); return new Response(JSON.stringify({ id: 7 }), { headers: { "content-type": "application/json" } }); });
    const { options } = await bootstrap(makeConfig());
    const route = { id: "route", enabled: true, priority: 10, workspace: "ws", match: { triggers: ["gitea-internal"], target_kinds: ["pull_request"] }, outputs: { line_comments: [], summary: ["first"] } };
    await publishOperations([
      { op: "create", collection: "workspaces", record: { id: "ws", name: "ws", enabled: true, value: { source_repo: { trigger: "gitea-internal", repo: "acme/repo" } } } },
      ...["first", "second"].map(name => ({ op: "create" as const, collection: "channels" as const,
        record: { id: name, name, enabled: true, value: { name, kind: "gitea_pr_review", trigger: "gitea-internal", base_url: `https://${name}.example`, review_update_strategy: "always_new", no_problems: { action: "publish" } } } })),
      { op: "create", collection: "routes", record: { id: "route", name: "route", enabled: true, value: route } },
    ]);
    const old = await options.runtimeConfig!.admission();
    const event = createReviewEvent({ triggerName: "gitea-internal", provider: "gitea", workspaceId: "ws", targetKind: "pull_request",
      repoRef: "acme/repo", author: {}, reason: "test" });
    const context = { reviewEvent: event, payload: { pull_request: { number: 7 } }, provider: "gitea" as const, eventName: "pull_request", configSnapshotId: old.snapshotId };
    expect(previewConfigRoute(old.config, { triggerName: event.triggerName, targetKind: event.targetKind, repoRef: event.repoRef })).toMatchObject({ status: "matched", routeRuleId: "route", workspace: "ws" });
    const resolve = options.reviewOrchestration!.optionsResolver!;
    const first = await resolve(context);
    await publishOperations([{ op: "update", collection: "routes", recordId: "route", value: { ...route, outputs: { line_comments: [], summary: ["second"] } } }]);
    const next = await options.runtimeConfig!.admission();
    const second = await resolve({ ...context, configSnapshotId: next.snapshotId });
    await (await first.outputPublisherResolver!(context))!.publishSummary!("old sentinel");
    await (await second.outputPublisherResolver!(context))!.publishSummary!("new sentinel");
    expect(requests.some(url => url.startsWith("https://first.example/"))).toBe(true);
    expect(requests.some(url => url.startsWith("https://second.example/"))).toBe(true);
    const count = requests.length;
    await publishOperations([{ op: "update", collection: "routes", recordId: "route", value: { ...route, outputs: { line_comments: [], summary: [] } } }]);
    const closed = await options.runtimeConfig!.admission();
    const quiet = await resolve({ ...context, configSnapshotId: closed.snapshotId });
    expect(await quiet.outputPublisherResolver!(context)).toBeUndefined();
    expect(requests).toHaveLength(count);
  });

  it("H02/H06: published triage policy reaches its actual client and explicit empty events disables it", async () => {
    const requests: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      requests.push({ url: String(url), ...init });
      if (String(url).includes("chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "close", category: "spam", reason: "fixture" }) } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      return new Response(JSON.stringify({ number: 7, title: "fixture", body: "fixture", state: "open", user: { login: "user" }, comments: 0 }));
    });
    const { options } = await bootstrap(makeConfig());
    const workspace = { source_repo: { trigger: "gitea-internal", repo: "acme/repo" }, triage: { enabled: true, dry_run: true, custom_prompt: "triage-sentinel", categories_close: ["spam"], events: ["issues"] } };
    await publishOperations([{ op: "create", collection: "workspaces", record: { id: "ws", name: "ws", enabled: true, value: workspace } }]);
    const generation = await options.runtimeConfig!.admission();
    const event = createReviewEvent({ triggerName: "gitea-internal", provider: "gitea", workspaceId: "ws", targetKind: "issue", repoRef: "acme/repo", changedFiles: ["7"], author: {}, reason: "test" });
    const result = await options.runtimeConfig!.withGeneration(generation, () => runTriggerProcessing("gitea", "issues", {}, event, undefined, undefined, options.issueTriage));
    expect(result.triage?.decision.action).toBe("close");
    expect(requests.some(request => request.body?.includes("triage-sentinel"))).toBe(true);
    expect(requests.some(request => request.url.includes("/repos/acme/repo/issues/7"))).toBe(true);
    const count = requests.length;
    await publishOperations([{ op: "update", collection: "workspaces", recordId: "ws", value: { ...workspace, triage: { ...workspace.triage, events: [] } } }]);
    const latest = await options.runtimeConfig!.admission();
    const skipped = await options.runtimeConfig!.withGeneration(latest, () => runTriggerProcessing("gitea", "issues", {}, event, undefined, undefined, options.issueTriage));
    expect(skipped.outcome).toBe("skipped");
    expect(requests).toHaveLength(count);
  });

  it.each(["kilo", "opencode", "oh-my-pi", "claude-code", "copilot-cli", "zoo", "pi"] as const)("H03: %s consumes published workspace agent/search in its real bundle", async kind => {
    const { options } = await bootstrap(makeConfig());
    const workspace = { source_repo: { trigger: "gitea-internal", repo: "acme/repo" }, agent: { default: kind, web_search: { enabled: false } } };
    await publishOperations([
      { op: "create", collection: "workspaces", record: { id: "ws", name: "ws", enabled: true, value: workspace } },
      { op: "set", path: ["llm", "model_catalog"], value: { enabled: true, offline: true, cache: { backend: "memory" },
        overrides: { "openai-prod/gpt-4o": { context_window: 16000, max_output_tokens: 512 } } } },
    ]);
    const generation = await options.runtimeConfig!.admission();
    const context = { reviewEvent: createReviewEvent({ triggerName: "gitea-internal", provider: "gitea", workspaceId: "ws", repoRef: "acme/repo", targetKind: "pull_request", author: {}, reason: "test" }),
      provider: "gitea" as const, eventName: "pull_request", payload: {}, configSnapshotId: generation.snapshotId };
    const resolve = options.reviewOrchestration!.optionsResolver!;
    const old = await resolve(context);
    await publishOperations([{ op: "update", collection: "workspaces", recordId: "ws", value: { ...workspace,
      agent: { default: kind, timeout_seconds: 91, auto_approve: false, web_search: { enabled: true } } } }]);
    const latest = await options.runtimeConfig!.admission();
    const current = await resolve({ ...context, configSnapshotId: latest.snapshotId });
    const oldBundle = await materializeRuntimeBundle({ adapter: old.agentAdapter!, model: old.model!, workingDir: join(dir, `old-${kind}`), webSearch: old.webSearch });
    const newBundle = await materializeRuntimeBundle({ adapter: current.agentAdapter!, model: current.model!, workingDir: join(dir, `new-${kind}`), webSearch: current.webSearch });
    expect(newBundle.manifest.agentKind).toBe(kind);
    expect(oldBundle.manifest.webSearch?.enabled).toBe(false);
    expect(newBundle.manifest.webSearch?.mode).toBe(["zoo", "pi"].includes(kind) ? "not_applicable" : ["claude-code", "copilot-cli"].includes(kind) ? "delegated" : "injected");
    expect(current.agentTimeoutMs).toBe(91_000);
    expect(current.agentAutoApprove).toBe(false);
    if (kind === "kilo") {
      expect(oldBundle.envVars.KILO_ENABLE_EXA).toBeUndefined();
      expect(newBundle.envVars.KILO_ENABLE_EXA).toBe("1");
    }
    const command = current.agentAdapter!.buildCommand("review", { task: "review", workingDir: newBundle.workingDir,
      model: current.model!, autoApprove: current.agentAutoApprove, webSearch: current.webSearch });
    expect(command.length).toBeGreaterThan(0);
    expect((await resolve(context)).webSearch?.enabled).toBe(false);
  });

  it("H02/H17: catalog overrides and daily budget change without resetting billed spend", async () => {
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      { op: "create", collection: "workspaces", record: { id: "ws", name: "ws", enabled: true, value: { source_repo: { trigger: "gitea-internal", repo: "acme/repo" } } } },
      { op: "set", path: ["llm", "model_catalog"], value: { enabled: true, offline: true, cache: { backend: "memory" }, overrides: { "openai-prod/gpt-4o": { context_window: 12345 } } } },
      { op: "set", path: ["llm", "budget", "per_repo_daily_usd"], value: 2 },
    ]);
    const generation = await options.runtimeConfig!.admission();
    const context = { reviewEvent: createReviewEvent({ triggerName: "gitea-internal", provider: "gitea", workspaceId: "ws", repoRef: "acme/repo", targetKind: "pull_request", author: {}, reason: "test" }),
      provider: "gitea" as const, eventName: "pull_request", payload: {}, configSnapshotId: generation.snapshotId };
    const resolve = options.reviewOrchestration!.optionsResolver!;
    const first = await resolve(context);
    expect(first.model?.contextWindow).toBe(12345);
    first.onAgentCost!(1);
    await publishOperations([
      { op: "set", path: ["llm", "model_catalog", "overrides"], value: { "openai-prod/gpt-4o": { context_window: 23456 } } },
      { op: "set", path: ["llm", "budget", "per_repo_daily_usd"], value: 0.5 },
    ]);
    const latest = await options.runtimeConfig!.admission();
    const next = await resolve({ ...context, configSnapshotId: latest.snapshotId });
    expect(next.model?.contextWindow).toBe(23456);
    expect((await resolve(context)).model?.contextWindow).toBe(12345);
    await expect(next.beforeAgentCall!(next.model!)).rejects.toThrow("budget exceeded");
  });

  it("does not propagate a request generation into the shared scheduler timer", async () => {
    const { options } = await bootstrap(makeConfig());
    const manager = options.runtimeConfig!;
    const first = await manager.admission();
    const observed: (string | null)[] = [];
    const tick = vi.spyOn(AutoCommitScheduler.prototype, "tick").mockImplementation(async () => {
      observed.push(manager.current().snapshotId);
    });
    vi.useFakeTimers();
    try {
      await publishOperations([{ op: "create", collection: "providers", record: { id: "later", name: "later", enabled: true,
        value: { id: "later", kind: "ollama" } } }]);
      const latest = await manager.admission();
      await manager.withGeneration(first, async () => {
        await options.autoCommit!.accept({ provider: "gitea", eventName: "push", now: Date.now(),
          reviewEvent: createReviewEvent({ provider: "gitea", triggerName: "gitea-internal", workspaceId: "ws", repoRef: "acme/x",
            targetKind: "push", branch: "main", baseSha: "a", headSha: "b", author: {}, reason: "gitea:push" }) });
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every(snapshotId => snapshotId === latest.snapshotId)).toBe(true);
    } finally {
      await options.closeAutoCommit?.();
      vi.clearAllTimers();
      vi.useRealTimers();
      tick.mockRestore();
    }
  });

  it("H02/H08: catalog observations remain pinned after restart and upstream metadata changes", async () => {
    let window = 12345;
    let fetches = 0;
    vi.spyOn(modelCatalog, "createHttpModelCatalogFetcher").mockReturnValue(async () => {
      fetches++;
      const provider = { id: "openai", name: "OpenAI", models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o", limit: { context: window, output: 1024 } } } };
      return { body: JSON.stringify({ openai: provider, "openai-prod": { ...provider, id: "openai-prod" } }) };
    });
    const { options } = await bootstrap(makeConfig());
    await publishOperations([{ op: "set", path: ["llm", "model_catalog"], value: {
      enabled: true, source_url: "https://catalog.example/models.json", cache: { backend: "memory" }, offline: false,
    } }]);
    const first = await options.runtimeConfig!.admission();
    expect(options.reviewOrchestration!.modelOptionsResolver!().model.contextWindow).toBe(12345);
    await options.closeAutoCommit?.();
    await options.sessionStore?.close();
    if (options.store) await closeStoreDb(options.store);
    window = 54321;
    const { options: restarted } = await bootstrap(makeConfig());
    expect(fetches).toBeGreaterThanOrEqual(2);
    expect(restarted.reviewOrchestration!.modelOptionsResolver!().model.contextWindow).toBe(12345);
    await publishOperations([{ op: "set", path: ["llm", "model_catalog", "fetch_timeout_ms"], value: 2000 }]);
    await restarted.runtimeConfig!.admission();
    expect(restarted.reviewOrchestration!.modelOptionsResolver!().model.contextWindow).toBe(54321);
    const old = await restarted.runtimeConfig!.resolveGeneration(first.snapshotId);
    await restarted.runtimeConfig!.withGeneration(old, async () => {
      expect(restarted.reviewOrchestration!.modelOptionsResolver!().model.contextWindow).toBe(12345);
    });
  });
  it("keeps config administration available when only statistics initialization fails", async () => {
    const stats = createStoreDb(join(dir, "config.sqlite"));
    stats.sqlite.prepare("INSERT INTO _migrations (name) VALUES (?)").run("999_unknown");
    await closeStoreDb(stats);
    const { options } = await bootstrap(makeConfig());
    expect(options.store).toBeUndefined();
    expect(options.observability?.sessionStore).toBeDefined();
    expect(options.configApi?.store).toBeDefined();
    await expect(options.runtimeConfig!.admission()).resolves.toBeDefined();
  });
  it.each(["p4", "svn"] as const)("keeps a dispatcher for %s introduced after startup", async (kind) => {
    const { options } = await bootstrap(makeConfig());
    await publishOperations([{ op: "create", collection: "triggers", record: { id: "new-trigger", name: "new-trigger", enabled: true,
      value: { name: "new-trigger", kind, ...(kind === "svn" ? { repository_url: "https://svn.example/repo" } : {}) } } }]);
    await options.runtimeConfig!.admission();
    expect(typeof options[kind]).toBe("function");
    const profiles = await (options[kind] as () => readonly { triggerName: string }[])();
    expect(profiles.map(profile => profile.triggerName)).toContain("new-trigger");
  });
  it("exposes the manager, config API options, and provider-based webhook sources", async () => {
    const { options } = await bootstrap(makeConfig());
    expect(options.runtimeConfig).toBeDefined();
    expect(options.configApi).toBeDefined();
    expect(typeof options.gitea).toBe("function");
    const giteaProfiles = await (options.gitea as unknown as () => Promise<readonly { triggerName: string }[]>)();
    expect(giteaProfiles.map((profile) => profile.triggerName)).toEqual(["gitea-internal"]);
    await options.closeAutoCommit?.();
  });

  it("H01/H02: publishing a provider + model group changes the next task's model route", async () => {
    const requests: { url: string; model: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "{}") as { model: string };
      requests.push({ url: String(url), model: body.model });
      return new Response(JSON.stringify(String(url).includes("/api/chat")
        ? { message: { role: "assistant", content: "new-route" }, done: true, prompt_eval_count: 2, eval_count: 1 }
        : { choices: [{ message: { content: "old-route" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } });
    });
    const config = makeConfig();
    const { options } = await bootstrap(config);

    const before = options.reviewOrchestration!.modelOptionsResolver!();
    expect(before.model.providerId).toBe("openai-prod");
    expect(before.model.modelId).toBe("gpt-4o");

    await publishOperations([
      { op: "create", collection: "providers", record: { id: "db-vertex", name: "db-vertex", enabled: true, value: { id: "db-vertex", kind: "ollama" } } },
      { op: "create", collection: "model_groups", record: { id: "thorough", name: "thorough", enabled: true, value: [{ provider: "db-vertex", model: "llama3", role: "heavy" }] } },
      { op: "set", path: ["llm", "default_model_chain"], value: "thorough" },
    ]);
    await options.runtimeConfig!.admission();

    const after = options.reviewOrchestration!.modelOptionsResolver!();
    expect(after.model.providerId).toBe("db-vertex");
    expect(after.model.modelId).toBe("llama3");
    await before.llm.complete({ model: before.model, messages: [{ role: "user", content: "old-sentinel" }] });
    await after.llm.complete({ model: after.model, messages: [{ role: "user", content: "new-sentinel" }] });
    expect(requests).toEqual([
      { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
      { url: "http://127.0.0.1:11434/v1/chat/completions", model: "llama3" },
    ]);
    await options.closeAutoCommit?.();
  });

  it("H06: a published trigger appears in the dispatcher on the next request", async () => {
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      { op: "create", collection: "triggers", record: { id: "github-dyn", name: "github-dyn", enabled: true, value: { name: "github-dyn", kind: "github", webhook_secret_env: "GITHUB_DYN_SECRET" } } },
    ]);
    await options.runtimeConfig!.admission();
    const githubProfiles = await (options.github as unknown as () => Promise<readonly { triggerName: string }[]>)();
    expect(githubProfiles.map((profile) => profile.triggerName)).toEqual(["github-dyn"]);
    await options.closeAutoCommit?.();
  });

  it("H03/H04/H05: optionsResolver reflects workspace analysis layers from the pinned generation", async () => {
    const config = makeConfig({
      workspaces: {
        cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
        defaults: {},
        instances: {
          "ws-agent": { source_repo: { trigger: "gitea-internal", repo: "acme/x" } },
          "ws-sandbox": { source_repo: { trigger: "gitea-internal", repo: "acme/y" } },
        },
      },
    } as Partial<AppConfig>);
    const { options } = await bootstrap(config);

    await publishOperations([
      { op: "create", collection: "workspaces", record: { id: "ws-agent", name: "ws-agent", enabled: true, value: { source_repo: { trigger: "gitea-internal", repo: "acme/x" }, agent: { default: "opencode" } } } },
      { op: "create", collection: "workspaces", record: { id: "ws-sandbox", name: "ws-sandbox", enabled: true, value: { source_repo: { trigger: "gitea-internal", repo: "acme/y" }, sandbox: { kind: "native" }, review: { max_files: 3, include: ["src/*"] } } } },
    ]);
    await options.runtimeConfig!.admission();

    const resolver = options.reviewOrchestration!.optionsResolver!;
    const baseContext = {
      reviewEvent: { workspaceId: "ws-agent", triggerName: "gitea-internal", repoRef: "acme/x" },
      payload: undefined,
      provider: "gitea",
      eventName: "push",
    } as never;
    const agentRun = await resolver(baseContext);
    expect(agentRun.agentAdapter?.kind).toBe("opencode");
    await publishOperations([{ op: "update", collection: "workspaces", recordId: "ws-agent", value: {
      source_repo: { trigger: "gitea-internal", repo: "acme/x" }, agent: { default: "native-llm" },
    } }]);
    await options.runtimeConfig!.admission();
    const directRun = await resolver(baseContext);
    expect(agentRun.agentAdapter?.kind).toBe("opencode");
    expect(directRun.agentAdapter).toBeUndefined();
    expect(directRun.sandboxFactory).toBeUndefined();

    const sandboxContext = {
      reviewEvent: { workspaceId: "ws-sandbox", triggerName: "gitea-internal", repoRef: "acme/y" },
      payload: undefined,
      provider: "gitea",
      eventName: "push",
    } as never;
    const sandboxRun = await resolver(sandboxContext);
    // Layered merge: the workspace include/max_files override globals; the
    // global default exclude list is inherited.
    expect(sandboxRun.reviewPolicyResolver?.("ws-sandbox")).toEqual({
      include: ["src/*"],
      exclude: ["**/vendor/**", "**/*.min.js", "**/*.lock"],
      max_files: 3,
    });
    // The sandbox factory honors the merged workspace layer (native here).
    const sandbox = await sandboxRun.sandboxFactory!();
    expect(sandbox.kind).toBe("native");
    await options.closeAutoCommit?.();
  });

  it("selects the direct LLM path from the global agent setting", async () => {
    const config = makeConfig();
    config.agent.default = "native-llm";
    const { options } = await bootstrap(config);
    expect(options.reviewOrchestration?.agentAdapter).toBeUndefined();
    expect(options.reviewOrchestration?.sandboxFactory).toBeUndefined();
    await options.closeAutoCommit?.();
  });

  it("admission fails closed when the active revision mismatches the file digest (H18)", async () => {
    const { options } = await bootstrap(makeConfig());
    await publishOperations([
      { op: "create", collection: "providers", record: { id: "db-x", name: "db-x", enabled: true, value: { id: "db-x", kind: "ollama" } } },
    ]);
    // A second process with a DIFFERENT file digest cannot adopt the head…
    // simulate by constructing a manager view over the same store with a
    // different digest through the exported manager contract.
    const driftedDigest = "e".repeat(64);
    const head = await store.readHead(NAMESPACE);
    expect(head?.activeRevision).toBe(1);
    // The running manager's own file is unchanged: still admitting.
    await expect(options.runtimeConfig!.admission()).resolves.toBeDefined();
    const drifted = new RuntimeConfigManager({ fileConfig: makeConfig(), fileDocument: FILE_DOCUMENT,
      fileDigest: driftedDigest, store, namespace: NAMESPACE, baseDir: dir });
    await expect(drifted.admission()).rejects.toMatchObject({ code: "file_config_mismatch" });
    drifted.close();
    await options.closeAutoCommit?.();
  });
});

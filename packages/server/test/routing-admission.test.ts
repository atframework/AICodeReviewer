import { createMemoryAutoCommitStore, parseConfigDocumentText, type AppConfig, type AutoCommitStore } from "@aicr/core";
import type { VcsAdapter } from "@aicr/vcs";
import { describe, expect, it, vi } from "vitest";

import { AutoCommitRuntime } from "../src/auto-commit-runtime.js";
import type { WorkspaceRuntime } from "../src/workspace-runtime.js";
import { AutoCommitScheduler } from "../src/auto-commit-scheduler.js";
import { resolveP4TriggerConfigs, resolveSvnTriggerConfigs } from "../src/bootstrap.js";
import { createServerApp } from "../src/index.js";
import { buildP4RoutingEnvelope, p4ProfileConsistentWithPayload } from "../src/p4-webhook.js";
import { RoutingReceiptResolver } from "../src/routing-resolver.js";
import { createWorkspaceRuntime } from "../src/workspace-runtime.js";

const P4_MATCH_YAML = `
triggers:
  - name: p4-main
    kind: p4
    streams: ["//depot/main", "//depot/dev"]
workspaces:
  instances:
    depot-main:
      match:
        - triggers: [p4-main]
          source:
            repo_ref: { glob: "//depot/main" }
`;

const SVN_MATCH_YAML = `
triggers:
  - name: svn-main
    kind: svn
    repository_url: "http://svn.example.com/repo"
    project_roots:
      - { prefix: /projectA, project: project-a }
      - { prefix: /projectB, project: project-b }
workspaces:
  instances:
    project-a:
      match:
        - triggers: [svn-main]
          source:
            repo_ref: { glob: "http://svn.example.com/repo/projectA" }
`;

function p4Setup(yaml: string = P4_MATCH_YAML, getConfigSnapshotId?: () => string | null) {
  const config = parseConfigDocumentText(yaml).config;
  const workspaceRuntime = createWorkspaceRuntime(config, "/tmp/aicr-routing-test");
  const store = createMemoryAutoCommitStore();
  const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}), ...(getConfigSnapshotId ? { getConfigSnapshotId } : {}) });
  const configs = resolveP4TriggerConfigs(config, undefined, workspaceRuntime);
  return { config, workspaceRuntime, store, runtime, configs };
}

describe("p4 routing admission (architecture §3.10, W14)", () => {
  it("keeps direct legacy handling when only a later profile is consistent", async () => {
    const app = createServerApp({ p4: [
      { triggerName: "first", workspaceId: "first", depot: "//first/main" },
      { triggerName: "second", workspaceId: "second", depot: "//second/main" },
    ] });
    const response = await app.request("/triggers/p4", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ change: "7", depot_path: "//second/main", user: "alice" }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, reviewEvent: { triggerName: "second", workspaceId: "second" } });
  });

  it.each(["p4", "svn"] as const)("never falsely accepts multiple %s profiles without a receipt writer", async (provider) => {
    const profiles = ["first", "second"].map((name) => ({ triggerName: name, workspaceId: name, repositoryUrl: `https://svn.example/${name}` }));
    const app = createServerApp({ [provider]: profiles });
    const response = await app.request(`/triggers/${provider}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change: "7", revision: "7" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false });
  });

  it.each(["p4", "svn"] as const)("returns retryable failure for a multiple-profile %s persistence error", async (provider) => {
    const profiles = ["first", "second"].map((name) => ({ triggerName: name, workspaceId: name, repositoryUrl: `https://svn.example/${name}` }));
    const app = createServerApp({ [provider]: profiles, autoCommit: { accept: async () => { throw new Error("write failed"); } } });
    const response = await app.request(`/triggers/${provider}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change: "7", revision: "7" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "persistence_failed" });
  });
  it("persists a routing receipt for a match-referenced multi-stream profile and dedupes replays", async () => {
    const { store, runtime, configs } = p4Setup();
    expect(configs).toHaveLength(1);
    expect(configs[0]!.resolveWorkspace).toBeDefined();
    expect(configs[0]!.streams).toEqual(["//depot/main", "//depot/dev"]);
    const app = createServerApp({ p4: configs, autoCommit: runtime, asyncTriggers: true });

    const payload = JSON.stringify({ change: "7001", user: "alice", client: "alice-ws", depot_path: "//depot/main" });
    const response = await app.request("/triggers/p4", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; processing?: { routingIds?: string[] } };

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.processing?.routingIds).toHaveLength(1);

    const routingId = body.processing!.routingIds![0]!;
    const pending = await store.readDueRoutingReceipts(Date.now() + 60_000, 10);
    expect(pending.map((record) => record.routingId)).toContain(routingId);
    const record = pending.find((entry) => entry.routingId === routingId)!;
    expect(record.provider).toBe("p4");
    expect(record.triggerName).toBe("p4-main");
    expect((record.envelope as { revision: string }).revision).toBe("7001");
    // No formal receipts exist yet: conversion is the scheduler's stage C.
    expect(record.convertedReceiptIds).toEqual([]);

    const replay = await app.request("/triggers/p4", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const replayBody = (await replay.json()) as { processing?: { routingIds?: string[] } };
    expect(replayBody.processing?.routingIds).toEqual([routingId]);
    const afterReplay = await store.readDueRoutingReceipts(Date.now() + 60_000, 10);
    expect(afterReplay.filter((entry) => entry.routingId === routingId)).toHaveLength(1);
  });

  it("answers 202 repository_not_configured when no profile matches the submitted depot", async () => {
    const { store, runtime, configs } = p4Setup();
    const app = createServerApp({ p4: configs, autoCommit: runtime, asyncTriggers: true });

    const response = await app.request("/triggers/p4", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change: "7002", depot_path: "//elsewhere/main" }),
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("repository_not_configured");
    expect(await store.readDueRoutingReceipts(Date.now() + 60_000, 10)).toEqual([]);
  });

  it("rejects structurally invalid payloads before any persistence", async () => {
    const { store, runtime, configs } = p4Setup();
    const app = createServerApp({ p4: configs, autoCommit: runtime, asyncTriggers: true });

    const response = await app.request("/triggers/p4", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "alice" }),
    });

    expect(response.status).toBe(400);
    expect(await store.readDueRoutingReceipts(Date.now() + 60_000, 10)).toEqual([]);
  });

  it("svn match-referenced profile admits post-commit into the routing stage", async () => {
    const config = parseConfigDocumentText(SVN_MATCH_YAML).config;
    const workspaceRuntime = createWorkspaceRuntime(config, "/tmp/aicr-routing-test");
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const configs = resolveSvnTriggerConfigs(config, undefined, workspaceRuntime);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.projectRoots).toHaveLength(2);
    const app = createServerApp({ svn: configs, autoCommit: runtime, asyncTriggers: true });

    const response = await app.request("/triggers/svn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "4321", author: "bob", files: ["/projectA/src/main.c"] }),
    });
    const body = (await response.json()) as { accepted: boolean; processing?: { routingIds?: string[] } };

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.processing?.routingIds).toHaveLength(1);
    const pending = await store.readDueRoutingReceipts(Date.now() + 60_000, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.provider).toBe("svn");
  });
});

function fakeAdapter(record: {
  revision: string;
  p4User?: string;
  p4Client?: string;
  changedPaths: readonly string[];
  /** Stream reported by `p4 describe` (E06); may disagree with the submitted scope. */
  stream?: string;
  /** describe-reported user/client when they must diverge from the changelist metadata (E06). */
  describeUser?: string;
  describeClient?: string;
}): VcsAdapter {
  return {
    kind: "p4",
    describeSource: async () => ({
      server: "p4.example:1666",
      user: record.describeUser ?? record.p4User ?? null,
      client: record.describeClient ?? record.p4Client ?? null,
      stream: record.stream ?? null,
    }),
    listChanges: () => Promise.reject(new Error("unused")),
    fetchScoped: () => Promise.reject(new Error("unused")),
    fetchExtraContext: () => Promise.reject(new Error("unused")),
    listCommitMetadataPage: () =>
      Promise.resolve({
        vcs: "p4",
        records: [
          {
            revision: record.revision,
            orderKey: record.revision.padStart(12, "0"),
            parents: [],
            ...(record.p4User !== undefined ? { p4User: record.p4User } : {}),
            ...(record.p4Client !== undefined ? { p4Client: record.p4Client } : {}),
            changedPaths: record.changedPaths,
          },
        ],
        status: "complete",
      }),
  } as VcsAdapter;
}

describe("routing receipt resolver (architecture §3.10 stage C, W13/W14/W15)", () => {
  it.each(["outside", "root", "incomplete"])("honors verified SVN roots: %s", async (scenario) => {
    const config = parseConfigDocumentText(SVN_MATCH_YAML).config;
    const workspaceRuntime = createWorkspaceRuntime(config, "/tmp/aicr-routing-test");
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const adapter = fakeAdapter({ revision: "4", changedPaths: scenario === "outside" ? ["/unrelated/app.c"] : ["/projectA/app.c"] });
    if (scenario === "incomplete") {
      const fetch = adapter.listCommitMetadataPage!;
      adapter.listCommitMetadataPage = async (query) => { const page = await fetch(query); return { ...page,
        records: page.records.map((record) => ({ ...record, changedPathsComplete: false })) }; };
    }
    const resolveForSource = vi.fn(() => ({ kind: "legacy_binding" as const, definitionId: "project-a" }));
    const resolver = new RoutingReceiptResolver({ store, config, runtime, workspaceRuntime: { ...workspaceRuntime, resolveForSource }, adapterFor: () => adapter,
      profileFor: () => ({ workspaceId: "unused", repositoryUrl: "http://svn.example.com/repo",
        projectRoots: [{ prefix: scenario === "root" ? "/" : "/projectA", project: "project-a" }] }) });
    const accepted = await runtime.acceptRouting({ provider: "svn", triggerName: "svn-main", eventName: "post-commit", envelope: { revision: "4" }, now: 1000 });
    await resolver.resolveDue(2000);
    const record = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(record?.convertedReceiptIds).toHaveLength(scenario === "root" ? 1 : 0);
    expect(record?.completedAt).toBe(scenario === "incomplete" ? null : 2000);
    expect(resolveForSource).toHaveBeenCalledTimes(scenario === "root" ? 1 : 0);
  });
  it("does not treat a sibling depot prefix as a configured scope", () => {
    expect(p4ProfileConsistentWithPayload({ triggerName: "p4", workspaceId: "ws", streams: ["//depot/main/..."] },
      { revision: "1", depotPath: "//depot/mainly" })).toBe(false);
    expect(p4ProfileConsistentWithPayload({ triggerName: "p4", workspaceId: "ws", streams: ["//depot/main/..."] },
      { revision: "1", files: ["//depot/main/app.cc"] })).toBe(true);
  });

  it.each(["later-scope", "outside-scopes", "depot-only"])("resolves metadata without first-scope fallback: %s", async (scenario) => {
    const { config, workspaceRuntime, store, runtime } = p4Setup();
    const scope = scenario === "later-scope" ? "//depot/dev" : scenario === "outside-scopes" ? "//outside/project" : "//depot/main";
    const adapter = fakeAdapter({ revision: "7010", changedPaths: [`${scope}/app.cc`] });
    const fetch = adapter.listCommitMetadataPage!;
    const queried: string[] = [];
    adapter.listCommitMetadataPage = async (query) => {
      queried.push(query.scopeRef);
      return query.scopeRef === "//depot/main" && scenario === "later-scope"
        ? { vcs: "p4", status: "complete", records: [] }
        : fetch(query);
    };
    const resolver = new RoutingReceiptResolver({ store, config, runtime, workspaceRuntime, adapterFor: () => adapter,
      profileFor: () => scenario === "depot-only" ? { workspaceId: "unused", depotPath: "//depot/main" }
        : { workspaceId: "unused", scopes: ["//depot/main", "//depot/dev"] } });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: { revision: "7010" }, now: 1000 });
    await resolver.resolveDue(2000);
    const completed = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(completed?.completedAt).toBe(2000);
    expect(completed?.convertedReceiptIds).toHaveLength(scenario === "depot-only" ? 1 : 0);
    if (scenario === "later-scope") expect(queried).toContain("//depot/dev");
  });
  it("converts a pending routing receipt into a formal receipt with the pinned resolution", async () => {
    let snapshot = "cfg-admitted";
    const { config, workspaceRuntime, store, runtime } = p4Setup(P4_MATCH_YAML, () => snapshot);
    const adapter = fakeAdapter({ revision: "7001", p4User: "alice", changedPaths: ["//depot/main/src/app.cc"] });
    const resolver = new RoutingReceiptResolver({
      store,
      config,
      runtime,
      workspaceRuntime,
      adapterFor: () => adapter,
      profileFor: (triggerName, _provider) => {
        const profile = resolveP4TriggerConfigs(config, triggerName, workspaceRuntime)[0];
        return profile
          ? { workspaceId: profile.workspaceId, ...(profile.streams ? { scopes: profile.streams } : {}) }
          : undefined;
      },
    });

    const envelope = buildP4RoutingEnvelope({ change: "7001", user: "alice", client: "alice-ws", depot_path: "//depot/main" });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: envelope!, now: 1000 });
    snapshot = "cfg-published-later";
    expect(await resolver.resolveDue(2000)).toBeUndefined();

    const completed = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(completed?.completedAt).toBe(2000);
    expect(completed?.convertedReceiptIds).toHaveLength(1);

    const receipt = await store.getReceipt(completed!.convertedReceiptIds[0]!);
    expect(receipt?.receipt.workspaceId).toBe("depot-main");
    expect(receipt?.receipt.scopeRef).toBe("//depot/main");
    expect(receipt?.receipt.configSnapshotId).toBe("cfg-admitted");
    // Resolution is pinned on the durable receipt for the execution layout.
    expect(receipt?.receipt.resolution).toMatchObject({ kind: "match", definitionId: "depot-main" });

    // Idempotent: a second pass produces no new receipts and no error.
    expect(await resolver.resolveDue(3000)).toBeUndefined();
    const again = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(again?.convertedReceiptIds).toEqual(completed?.convertedReceiptIds);
  });

  it("freezes the first interpretation: a later config change never re-resolves a pending receipt (V14)", async () => {
    const { config, workspaceRuntime, store, runtime } = p4Setup();
    const adapter = fakeAdapter({ revision: "7002", p4User: "alice", changedPaths: ["//depot/main/src/app.cc"] });
    // Config "changes" between attempts: the second interpretation would
    // bind a different workspace.
    const resolutions = [
      { kind: "match", definitionId: "depot-main", binding: { definitionId: "depot-main", instanceId: "i-old", workPath: "old" }, variables: {} },
      { kind: "match", definitionId: "depot-other", binding: { definitionId: "depot-other", instanceId: "i-new", workPath: "new" }, variables: {} },
    ];
    let resolveCalls = 0;
    const shiftingRuntime = {
      ...workspaceRuntime,
      resolveForSource: (..._args: Parameters<typeof workspaceRuntime.resolveForSource>) => {
        const picked = resolutions[Math.min(resolveCalls, resolutions.length - 1)]!;
        resolveCalls += 1;
        return picked as ReturnType<typeof workspaceRuntime.resolveForSource>;
      },
    };
    // First conversion attempt freezes the interpretation, then crashes
    // before the formal receipt is written.
    const accept = runtime.accept.bind(runtime);
    vi.spyOn(runtime, "accept").mockImplementation(accept)
      .mockRejectedValueOnce(new Error("store crashed mid-conversion"));
    const resolver = new RoutingReceiptResolver({
      store,
      config,
      runtime,
      workspaceRuntime: shiftingRuntime,
      adapterFor: () => adapter,
      profileFor: (triggerName, _provider) => {
        const profile = resolveP4TriggerConfigs(config, triggerName, workspaceRuntime)[0];
        return profile
          ? { workspaceId: profile.workspaceId, ...(profile.streams ? { scopes: profile.streams } : {}) }
          : undefined;
      },
    });

    const envelope = buildP4RoutingEnvelope({ change: "7002", user: "alice", client: "alice-ws", depot_path: "//depot/main" });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: envelope!, now: 1000 });

    // Attempt 1 fails after freezing; the record stays due for retry.
    await resolver.resolveDue(2000);
    const pending = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(pending?.completedAt).toBeNull();
    expect(pending?.resolution).not.toBeNull();

    // Attempt 2 (e.g. after restart with edited rules) must replay the freeze.
    adapter.listCommitMetadataPage = async () => { throw new Error("VCS unavailable after restart"); };
    await resolver.resolveDue(60_000);
    const completed = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(completed?.completedAt).toBe(60_000);
    expect(completed?.convertedReceiptIds).toHaveLength(1);
    expect(resolveCalls).toBe(1);

    const receipt = await store.getReceipt(completed!.convertedReceiptIds[0]!);
    expect(receipt?.receipt.workspaceId).toBe("depot-main");
    expect(receipt?.receipt.resolution).toMatchObject({ definitionId: "depot-main", binding: { instanceId: "i-old" } });
  });

  it("a changelist under an unmatched scope completes visibly instead of being dropped", async () => {
    const { config, workspaceRuntime, store, runtime } = p4Setup();
    // Files only touch //depot/dev; the match rule only covers //depot/main.
    const adapter = fakeAdapter({ revision: "7003", changedPaths: ["//depot/dev/tool/x.py"] });
    const resolver = new RoutingReceiptResolver({
      store,
      config,
      runtime,
      workspaceRuntime,
      adapterFor: () => adapter,
      profileFor: (triggerName) => {
        const profile = resolveP4TriggerConfigs(config, triggerName, workspaceRuntime)[0];
        return profile
          ? { workspaceId: profile.workspaceId, ...(profile.streams ? { scopes: profile.streams } : {}) }
          : undefined;
      },
    });

    const envelope = buildP4RoutingEnvelope({ change: "7003", depot_path: "//depot/dev" });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: envelope!, now: 1000 });

    await resolver.resolveDue(2000);

    const completed = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(completed?.completedAt).toBe(2000);
    expect(completed?.convertedReceiptIds).toEqual([]);
    expect(completed?.note).toContain("//depot/dev");
    expect(completed?.note).toContain("no match rule");
  });

  it("retries metadata failures with backoff and goes terminal after the attempt budget", async () => {
    const { config, workspaceRuntime, store, runtime } = p4Setup();
    const unavailable = {
      kind: "p4",
      listChanges: () => Promise.reject(new Error("unused")),
      fetchScoped: () => Promise.reject(new Error("unused")),
      fetchExtraContext: () => Promise.reject(new Error("unused")),
      listCommitMetadataPage: () =>
        Promise.resolve({ vcs: "p4", records: [], status: "unavailable", unavailableReason: "p4d offline" }),
    } as unknown as VcsAdapter;
    const resolver = new RoutingReceiptResolver({
      store,
      config,
      runtime,
      workspaceRuntime,
      adapterFor: () => unavailable,
      profileFor: (triggerName) => {
        const profile = resolveP4TriggerConfigs(config, triggerName, workspaceRuntime)[0];
        return profile
          ? { workspaceId: profile.workspaceId, ...(profile.streams ? { scopes: profile.streams } : {}) }
          : undefined;
      },
      maxAttempts: 2,
      baseRetryMs: 10_000,
    });

    const envelope = buildP4RoutingEnvelope({ change: "7004", depot_path: "//depot/main" });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: envelope!, now: 1000 });

    const retryAt = await resolver.resolveDue(2000);
    expect(retryAt).toBe(2000 + 10_000);
    let record = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(record?.attempts).toBe(1);
    expect(record?.terminalError).toBeNull();

    // Not due yet → no-op; at retryAt the second failure turns terminal.
    expect(await resolver.resolveDue(2000 + 5_000)).toBeUndefined();
    const terminal = await resolver.resolveDue(2000 + 10_000);
    expect(terminal).toBeUndefined();
    record = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(record?.terminalError).toContain("p4d offline");
    expect(record?.completedAt).toBeNull();
  });
});

const P4_STREAM_YAML = `
triggers:
  - name: p4-main
    kind: p4
    streams: ["//depot/main", "//depot/dev"]
workspaces:
  instances:
    depot-main:
      match:
        - triggers: [p4-main]
          source:
            repo_ref: { glob: "//depot/main" }
      work_path: '{{segment (default p4.stream_name "no-stream")}}'
`;

describe("p4 stream routing variables (E06)", () => {
  function streamResolver(config: AppConfig, workspaceRuntime: WorkspaceRuntime,
    store: AutoCommitStore, runtime: AutoCommitRuntime, adapter: VcsAdapter, maxAttempts?: number) {
    return new RoutingReceiptResolver({
      store,
      config,
      runtime,
      workspaceRuntime,
      adapterFor: () => adapter,
      profileFor: (triggerName) => {
        const profile = resolveP4TriggerConfigs(config, triggerName, workspaceRuntime)[0];
        return profile
          ? { workspaceId: profile.workspaceId, ...(profile.streams ? { scopes: profile.streams } : {}) }
          : undefined;
      },
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    });
  }

  it("carries a describe stream inside the submitted scope into the converted variables", async () => {
    const { config, workspaceRuntime, store, runtime } = p4Setup(P4_STREAM_YAML);
    const adapter = fakeAdapter({ revision: "7101", p4User: "alice", p4Client: "alice-ws",
      changedPaths: ["//depot/main/src/app.cc"], stream: "//depot/main" });
    const resolver = streamResolver(config, workspaceRuntime, store, runtime, adapter);

    const envelope = buildP4RoutingEnvelope({ change: "7101", user: "alice", client: "alice-ws", depot_path: "//depot/main" });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: envelope!, now: 1000 });
    expect(await resolver.resolveDue(2000)).toBeUndefined();

    const completed = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(completed?.completedAt).toBe(2000);
    expect(completed?.convertedReceiptIds).toHaveLength(1);

    const receipt = await store.getReceipt(completed!.convertedReceiptIds[0]!);
    const resolution = receipt?.receipt.resolution;
    if (resolution?.kind !== "match") throw new Error("expected a match resolution on the converted receipt");
    expect(resolution.variables).toMatchObject({
      p4: {
        stream: "//depot/main",
        stream_name: "main",
        depot: "depot",
        depot_path: "//depot/main",
        scope: "//depot/main",
        change: "7101",
        user: "alice",
        client: "alice-ws",
      },
    });
    // work_path renders the verified stream name, not a fallback.
    expect(resolution.binding.workPath).toBe("main");
  });

  it("never trusts a describe stream recorded outside the submitted scope", async () => {
    const { config, workspaceRuntime, store, runtime } = p4Setup(P4_STREAM_YAML);
    const adapter = fakeAdapter({ revision: "7102", p4User: "alice", p4Client: "alice-ws",
      changedPaths: ["//depot/main/src/app.cc"], stream: "//elsewhere/dev" });
    const resolver = streamResolver(config, workspaceRuntime, store, runtime, adapter);

    const envelope = buildP4RoutingEnvelope({ change: "7102", user: "alice", client: "alice-ws", depot_path: "//depot/main" });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: envelope!, now: 1000 });
    expect(await resolver.resolveDue(2000)).toBeUndefined();

    const completed = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(completed?.convertedReceiptIds).toHaveLength(1);

    const receipt = await store.getReceipt(completed!.convertedReceiptIds[0]!);
    const resolution = receipt?.receipt.resolution;
    if (resolution?.kind !== "match") throw new Error("expected a match resolution on the converted receipt");
    expect(resolution.variables).toMatchObject({ p4: { stream: null, stream_name: null, depot_path: "//depot/main" } });
    expect(resolution.binding.workPath).toBe("no-stream");
  });

  it.each(["user", "client"] as const)("a describe %s conflicting with the changelist metadata fails durably", async (field) => {
    const { config, workspaceRuntime, store, runtime } = p4Setup(P4_STREAM_YAML);
    const adapter = fakeAdapter({ revision: "7103", p4User: "alice", p4Client: "alice-ws",
      changedPaths: ["//depot/main/src/app.cc"],
      ...(field === "user" ? { describeUser: "mallory" } : { describeClient: "mallory-ws" }) });
    // One attempt: the conflict must surface as the terminal error verbatim.
    const resolver = streamResolver(config, workspaceRuntime, store, runtime, adapter, 1);

    const envelope = buildP4RoutingEnvelope({ change: "7103", user: "alice", client: "alice-ws", depot_path: "//depot/main" });
    const accepted = await runtime.acceptRouting({ provider: "p4", triggerName: "p4-main", eventName: "change-commit", envelope: envelope!, now: 1000 });
    expect(await resolver.resolveDue(2000)).toBeUndefined();

    const record = await store.getRoutingReceipt(accepted.receipt.routingId);
    expect(record?.terminalError).toContain("Conflicting P4 changelist user/client metadata");
    expect(record?.completedAt).toBeNull();
    expect(record?.convertedReceiptIds).toEqual([]);
    // The conflict is detected before any per-scope interpretation freezes.
    expect(record?.resolution).toBeNull();
  });
});

describe("scheduler tick integration (W14)", () => {
  it("runs the routing resolver before expansion on every tick", async () => {
    const store = createMemoryAutoCommitStore();
    const resolveDue = vi.fn(async () => undefined);
    const scheduler = new AutoCommitScheduler({
      store,
      getPolicy: () => {
        throw new Error("no policy needed for an empty tick");
      },
      getAdapter: () => undefined,
      routingResolver: { resolveDue },
      executeBatch: () => Promise.resolve(),
    });

    await scheduler.tick();

    expect(resolveDue).toHaveBeenCalledTimes(1);
  });
});

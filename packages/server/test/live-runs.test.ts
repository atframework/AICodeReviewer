import { describe, expect, it } from "vitest";

import { createLiveRunRegistry, type LiveRunStart } from "../src/live-runs.js";

function makeStart(overrides: Partial<LiveRunStart> = {}): LiveRunStart {
  return {
    runId: "run-1",
    source: "webhook",
    provider: "gitea",
    eventName: "pull_request",
    workspaceId: "ws",
    triggerName: "gitea",
    repoRef: "owner/repo",
    targetKind: "pull_request",
    modelProviderId: "openai",
    modelId: "gpt-4o",
    attempt: 1,
    ...overrides,
  };
}

describe("createLiveRunRegistry", () => {
  it("registers a run as preparing with empty metrics", () => {
    const tick = 1_000;
    const registry = createLiveRunRegistry(() => new Date(tick));

    registry.start(makeStart());

    expect(registry.size).toBe(1);
    const [entry] = registry.list();
    expect(entry).toMatchObject({
      runId: "run-1",
      source: "webhook",
      phase: "preparing",
      metrics: {},
      attempt: 1,
      startedAt: new Date(1_000).toISOString(),
      lastUpdatedAt: new Date(1_000).toISOString(),
    });
  });

  it("isolates overlapping attempts and reuses only released worker slots", () => {
    let tick = 1_000;
    const registry = createLiveRunRegistry(() => new Date(tick));
    const first = registry.start(makeStart());
    tick = 5_000;
    const second = registry.start(makeStart({ attempt: 2 }));
    expect(second).not.toBe(first);
    expect(registry.list().map((entry) => entry.workerId)).toEqual([1, 2]);
    registry.finish(first);
    registry.update(first, { phase: "publishing" });
    const [entry] = registry.list();
    expect(entry?.phase).toBe("preparing");
    expect(entry?.attempt).toBe(2);
    expect(entry?.startedAt).toBe(new Date(5_000).toISOString());
    registry.start(makeStart({ runId: "other" }));
    expect(registry.list().map((entry) => entry.workerId)).toEqual([1, 2]);
  });

  it("applies phase, estimate, and metrics updates with a fresh timestamp", () => {
    let tick = 1_000;
    const registry = createLiveRunRegistry(() => new Date(tick));
    const executionId = registry.start(makeStart());

    tick = 2_000;
    registry.update(executionId, { phase: "analyzing" });
    tick = 3_000;
    registry.update(executionId, {
      promptTokenEstimate: 12_345,
      metrics: {
        promptTokens: 2_000,
        completionTokens: 300,
        cachedPromptTokens: 1_500,
        requestCount: 2,
        estimatedCostUsd: 0.0123,
        usageSource: "agent_stdout",
      },
    });

    const [entry] = registry.list();
    expect(entry?.phase).toBe("analyzing");
    expect(entry?.promptTokenEstimate).toBe(12_345);
    expect(entry?.metrics).toMatchObject({
      promptTokens: 2_000,
      cachedPromptTokens: 1_500,
      requestCount: 2,
      usageSource: "agent_stdout",
    });
    expect(entry?.lastUpdatedAt).toBe(new Date(3_000).toISOString());
    expect(entry?.metricsUpdatedAt).toBe(new Date(3_000).toISOString());
    tick = 4_000;
    registry.update(executionId, { phase: "publishing" });
    expect(registry.list()[0]?.metricsUpdatedAt).toBe(new Date(3_000).toISOString());
  });

  it("ignores updates for unknown run ids", () => {
    const registry = createLiveRunRegistry();
    registry.update("missing", { phase: "publishing" });
    expect(registry.size).toBe(0);
  });

  it("removes entries on finish and lists worker slots in order", () => {
    let tick = 1_000;
    const registry = createLiveRunRegistry(() => new Date(tick));
    const b = registry.start(makeStart({ runId: "run-b" }));
    tick = 500;
    const a = registry.start(makeStart({ runId: "run-a" }));
    tick = 1_500;
    const c = registry.start(makeStart({ runId: "run-c" }));

    expect(registry.list().map((entry) => entry.runId)).toEqual(["run-b", "run-a", "run-c"]);

    registry.finish(a);
    registry.finish(b);
    registry.finish("missing");
    expect(registry.list().map((entry) => entry.runId)).toEqual(["run-c"]);
    registry.finish(c);
    expect(registry.size).toBe(0);
  });

  it("returns detached snapshots and copies metric patches", () => {
    const registry = createLiveRunRegistry();
    const id = registry.start(makeStart());
    const metrics = { totalTokens: 123 };
    registry.update(id, { metrics });
    metrics.totalTokens = 456;
    const snapshot = registry.list();
    Object.assign(snapshot[0]!.metrics, { totalTokens: 789 });
    Object.assign(snapshot[0]!, { phase: "publishing" });
    expect(registry.list()[0]).toMatchObject({ phase: "preparing", metrics: { totalTokens: 123 } });
  });
});

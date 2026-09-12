import type { ReviewProvider, ReviewVcsKind } from "@aicr/core";
import { randomUUID } from "node:crypto";

/**
 * In-memory registry of review analyses currently executing in this process.
 * The server is single-process (no cluster/worker threads), so a Map is the
 * full source of truth for the dashboard Live panel; entries are registered
 * when `runReviewOrchestration` starts and removed when it settles, so a
 * restart simply shows an empty panel. Completed runs are NOT written here —
 * they persist to the observability store and appear in Recent Runs.
 */

export type LiveRunPhase = "preparing" | "analyzing" | "publishing";

export type LiveRunSource = "webhook" | "auto_commit";

export interface LiveRunMetrics {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  /** Cache-hit input tokens; already included in `promptTokens`. */
  readonly cachedPromptTokens?: number;
  /** Cache-write input tokens; already included in `promptTokens`. */
  readonly cacheCreationTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly requestCount?: number;
  readonly retryCount?: number;
  readonly fallbackCount?: number;
  /** Same semantics as ReviewOrchestrationUsageSource ("llm_gateway" | "agent_stdout" | "mixed"). */
  readonly usageSource?: string;
}

export interface LiveRunStart {
  readonly runId: string;
  readonly source: LiveRunSource;
  readonly provider: ReviewProvider;
  readonly eventName: string;
  readonly workspaceId: string;
  readonly triggerName: string | null;
  readonly repoRef: string;
  readonly targetKind: string;
  readonly branch?: string;
  readonly headSha?: string;
  readonly vcsKind?: ReviewVcsKind;
  /** ISO-8601 commit time of headSha, filled in once the fetch resolves it. */
  readonly headCommittedAt?: string;
  readonly title?: string;
  readonly url?: string;
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly agentKind?: string;
  readonly attempt: number;
}

export interface LiveRunEntry extends LiveRunStart {
  /** Distinguishes overlapping attempts of the same persisted run. */
  readonly executionId: string;
  /** Process-local analysis slot, reused only after its execution settles. */
  readonly workerId: number;
  readonly startedAt: string;
  readonly phase: LiveRunPhase;
  readonly promptTokenEstimate?: number;
  readonly compressed?: boolean;
  readonly metrics: LiveRunMetrics;
  readonly lastUpdatedAt: string;
  readonly metricsUpdatedAt?: string;
}

export interface LiveRunUpdate {
  readonly phase?: LiveRunPhase;
  readonly promptTokenEstimate?: number;
  readonly compressed?: boolean;
  readonly metrics?: LiveRunMetrics;
  readonly headCommittedAt?: string;
  readonly headSha?: string;
  readonly vcsKind?: ReviewVcsKind;
  readonly modelProviderId?: string;
  readonly modelId?: string;
  readonly agentKind?: string | null;
}

export interface LiveRunRegistry {
  /**
   * Registers an execution as preparing and returns its unique handle.
   * A persisted runId may recur; updates and cleanup are fenced by this handle.
   */
  start(entry: LiveRunStart): string;
  update(executionId: string, patch: LiveRunUpdate): void;
  finish(executionId: string): void;
  /** Detached snapshot ordered by worker slot; safe to serialize directly. */
  list(): LiveRunEntry[];
  readonly size: number;
}

export function createLiveRunRegistry(now: () => Date = () => new Date()): LiveRunRegistry {
  const entries = new Map<string, LiveRunEntry>();

  return {
    start(entry) {
      const timestamp = now().toISOString();
      const executionId = randomUUID();
      const occupied = new Set([...entries.values()].map((run) => run.workerId));
      let workerId = 1;
      while (occupied.has(workerId)) workerId++;
      entries.set(executionId, {
        ...entry,
        executionId,
        workerId,
        startedAt: timestamp,
        phase: "preparing",
        metrics: {},
        lastUpdatedAt: timestamp,
      });
      return executionId;
    },
    update(executionId, patch) {
      const existing = entries.get(executionId);
      if (!existing) {
        return;
      }
      entries.set(executionId, {
        ...existing,
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.promptTokenEstimate !== undefined ? { promptTokenEstimate: patch.promptTokenEstimate } : {}),
        ...(patch.compressed !== undefined ? { compressed: patch.compressed } : {}),
        ...(patch.metrics !== undefined ? { metrics: { ...patch.metrics }, metricsUpdatedAt: now().toISOString() } : {}),
        ...(patch.headCommittedAt !== undefined ? { headCommittedAt: patch.headCommittedAt } : {}),
        ...(patch.headSha !== undefined ? { headSha: patch.headSha } : {}),
        ...(patch.vcsKind !== undefined ? { vcsKind: patch.vcsKind } : {}),
        ...(patch.modelProviderId !== undefined ? { modelProviderId: patch.modelProviderId } : {}),
        ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
        ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind ?? "" } : {}),
        lastUpdatedAt: now().toISOString(),
      });
    },
    finish(executionId) {
      entries.delete(executionId);
    },
    list() {
      return [...entries.values()]
        .sort((a, b) => a.workerId - b.workerId)
        .map((entry) => ({ ...entry, metrics: { ...entry.metrics } }));
    },
    get size() {
      return entries.size;
    },
  };
}

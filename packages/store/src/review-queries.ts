import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { historyCutoff } from "@aicr/core";

import type { PgStoreDb, StoreDb } from "./database.js";
import { storeHistoryRetention } from "./history-retention.js";
import { imReplyOutbox, imReviewRequests, llmUsage, projects, reviewRuns, webhookEvents, type RunStatus } from "./schema.js";
import { updateRunStatus } from "./stats.js";
import { imReplyOutbox as imReplyOutboxPg, imReviewRequests as imReviewRequestsPg, llmUsage as llmUsagePg, projects as projectsPg, reviewRuns as reviewRunsPg, webhookEvents as webhookEventsPg } from "./schema.pg.js";

/**
 * IM query commands (IM-11 query surface): bounded read-only views over the
 * retained review history, LLM usage and trigger events. All listings respect
 * the history-retention window — pruned or aged-out records simply stop
 * appearing ("不存在或已移除" semantics).
 */

export interface ImQueryRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly repoRef: string;
  readonly triggerName: string | null;
  readonly provider: string | null;
  readonly providerModel: string | null;
  readonly status: string;
  readonly problemCount: number;
  readonly durationMs: number | null;
  readonly startedAt: Date | null;
  readonly targetKind: string | null;
  readonly targetUrl: string | null;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly vcsKind: string | null;
  readonly headCommittedAt: Date | null;
  readonly error: string | null;
  readonly skipReason: string | null;
}

export const ACTIVE_RUN_STATUSES = ["queued", "preparing", "analyzing", "publishing"] as const;

export interface ImQueryRunFilter {
  readonly workspaceId?: string | undefined;
  readonly sourceTrigger?: string | undefined;
  readonly statusIn?: readonly string[] | undefined;
  readonly repoRef?: string | undefined;
  readonly headSha?: string | undefined;
  /** SQL LIKE pattern against target_url (PR/MR lookup). */
  readonly targetUrlPattern?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ImQueryTriggerEvent {
  readonly receivedAt: Date;
  readonly provider: string | null;
  readonly eventName: string | null;
  readonly workspaceId: string | null;
  readonly repoRef: string | null;
  readonly targetKind: string | null;
  readonly targetUrl: string | null;
  readonly branch: string | null;
  readonly decision: string;
  readonly reason: string | null;
}

export interface ImQueryLlmUsageRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensTotal: number;
  readonly cachedTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number | null;
  readonly retryCount: number;
  readonly latencyMs: number | null;
}

function clampLimit(limit: number | undefined, offset = 0): number {
  const value = limit ?? 20;
  return Math.max(0, Math.min(value, 200) - offset);
}

/** Review runs newest-first, joined with repo identity, within retention. */
export async function listImQueryRuns(store: StoreDb, filter: ImQueryRunFilter = {}): Promise<readonly ImQueryRun[]> {
  const limit = clampLimit(filter.limit);
  if (store.kind === "postgres") {
    const rows = await store.db
      .select(runColumnsPg)
      .from(reviewRunsPg)
      .innerJoin(projectsPg, eq(reviewRunsPg.projectId, projectsPg.id))
      .where(and(
        eq(reviewRunsPg.historyPruned, false),
        ...(filter.workspaceId !== undefined ? [eq(reviewRunsPg.workspaceId, filter.workspaceId)] : []),
        ...(filter.sourceTrigger !== undefined ? [eq(projectsPg.triggerName, filter.sourceTrigger)] : []),
        ...(filter.statusIn !== undefined ? [inArray(reviewRunsPg.status, filter.statusIn as RunStatus[])] : []),
        ...(filter.repoRef !== undefined ? [eq(projectsPg.repoRef, filter.repoRef)] : []),
        ...(filter.headSha !== undefined ? [eq(reviewRunsPg.headSha, filter.headSha)] : []),
        ...(filter.targetUrlPattern !== undefined ? [sql`${reviewRunsPg.targetUrl} LIKE ${filter.targetUrlPattern}`] : []),
      ))
      .orderBy(desc(reviewRunsPg.startedAt), desc(reviewRunsPg.id))
      .limit(limit);
    return rows;
  }
  const rows = store.db
    .select(runColumns)
    .from(reviewRuns)
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(and(
      eq(reviewRuns.historyPruned, false),
      ...(filter.workspaceId !== undefined ? [eq(reviewRuns.workspaceId, filter.workspaceId)] : []),
      ...(filter.sourceTrigger !== undefined ? [eq(projects.triggerName, filter.sourceTrigger)] : []),
      ...(filter.statusIn !== undefined ? [inArray(reviewRuns.status, filter.statusIn as RunStatus[])] : []),
      ...(filter.repoRef !== undefined ? [eq(projects.repoRef, filter.repoRef)] : []),
      ...(filter.headSha !== undefined ? [eq(reviewRuns.headSha, filter.headSha)] : []),
      ...(filter.targetUrlPattern !== undefined ? [sql`${reviewRuns.targetUrl} LIKE ${filter.targetUrlPattern}`] : []),
    ))
    .orderBy(desc(reviewRuns.startedAt), desc(reviewRuns.id))
    .limit(limit)
    .all();
  return rows;
}

/** Recent trigger events (the commits/PRs that arrived and were accepted). */
export async function listImQueryTriggerEvents(
  store: StoreDb,
  filter: { readonly targetKind: "commit" | "pull_request"; readonly workspaceId?: string | undefined; readonly sourceTrigger?: string | undefined; readonly repoRef?: string | undefined; readonly branch?: string | undefined; readonly limit?: number | undefined },
): Promise<readonly ImQueryTriggerEvent[]> {
  const limit = clampLimit(filter.limit);
  const decisions = ["executed", "deferred"] as const;
  if (store.kind === "postgres") {
    const pg = store as PgStoreDb;
    const policy = storeHistoryRetention(pg)?.events;
    return pg.db
      .select({
        receivedAt: webhookEventsPg.receivedAt,
        provider: webhookEventsPg.provider,
        eventName: webhookEventsPg.eventName,
        workspaceId: webhookEventsPg.workspaceId,
        repoRef: webhookEventsPg.repoRef,
        targetKind: webhookEventsPg.targetKind,
        targetUrl: webhookEventsPg.targetUrl,
        branch: webhookEventsPg.branch,
        decision: webhookEventsPg.decision,
        reason: webhookEventsPg.reason,
      })
      .from(webhookEventsPg)
      .where(and(
        inArray(webhookEventsPg.decision, decisions),
        eq(webhookEventsPg.targetKind, filter.targetKind),
        ...(policy ? [gte(webhookEventsPg.receivedAt, new Date(historyCutoff(policy)))] : []),
        ...(filter.workspaceId !== undefined ? [eq(webhookEventsPg.workspaceId, filter.workspaceId)] : []),
        ...(filter.sourceTrigger !== undefined ? [eq(webhookEventsPg.triggerName, filter.sourceTrigger)] : []),
        ...(filter.repoRef !== undefined ? [eq(webhookEventsPg.repoRef, filter.repoRef)] : []),
        ...(filter.branch !== undefined ? [eq(webhookEventsPg.branch, filter.branch)] : []),
      ))
      .orderBy(desc(webhookEventsPg.receivedAt), desc(webhookEventsPg.id))
      .limit(limit);
  }
  const policy = storeHistoryRetention(store)?.events;
  return store.db
    .select({
      receivedAt: webhookEvents.receivedAt,
      provider: webhookEvents.provider,
      eventName: webhookEvents.eventName,
      workspaceId: webhookEvents.workspaceId,
      repoRef: webhookEvents.repoRef,
      targetKind: webhookEvents.targetKind,
      targetUrl: webhookEvents.targetUrl,
      branch: webhookEvents.branch,
      decision: webhookEvents.decision,
      reason: webhookEvents.reason,
    })
    .from(webhookEvents)
    .where(and(
      inArray(webhookEvents.decision, decisions),
      eq(webhookEvents.targetKind, filter.targetKind),
      ...(policy ? [gte(webhookEvents.receivedAt, new Date(historyCutoff(policy)))] : []),
      ...(filter.workspaceId !== undefined ? [eq(webhookEvents.workspaceId, filter.workspaceId)] : []),
      ...(filter.sourceTrigger !== undefined ? [eq(webhookEvents.triggerName, filter.sourceTrigger)] : []),
      ...(filter.repoRef !== undefined ? [eq(webhookEvents.repoRef, filter.repoRef)] : []),
      ...(filter.branch !== undefined ? [eq(webhookEvents.branch, filter.branch)] : []),
    ))
    .orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id))
    .limit(limit)
    .all();
}

/** Per-provider LLM usage rows for one run (token/cache/request detail). */
export async function listImQueryLlmUsage(store: StoreDb, runId: string): Promise<readonly ImQueryLlmUsageRow[]> {
  const columns = {
    providerId: llmUsage.providerId,
    modelId: llmUsage.modelId,
    requestCount: llmUsage.requestCount,
    tokensIn: llmUsage.tokensIn,
    tokensOut: llmUsage.tokensOut,
    tokensTotal: llmUsage.tokensTotal,
    cachedTokens: llmUsage.cachedTokens,
    cacheCreationTokens: llmUsage.cacheCreationTokens,
    costUsd: llmUsage.costUsd,
    retryCount: llmUsage.retryCount,
    latencyMs: llmUsage.latencyMs,
  };
  if (store.kind === "postgres") {
    return store.db.select({
      providerId: llmUsagePg.providerId,
      modelId: llmUsagePg.modelId,
      requestCount: llmUsagePg.requestCount,
      tokensIn: llmUsagePg.tokensIn,
      tokensOut: llmUsagePg.tokensOut,
      tokensTotal: llmUsagePg.tokensTotal,
      cachedTokens: llmUsagePg.cachedTokens,
      cacheCreationTokens: llmUsagePg.cacheCreationTokens,
      costUsd: llmUsagePg.costUsd,
      retryCount: llmUsagePg.retryCount,
      latencyMs: llmUsagePg.latencyMs,
    }).from(llmUsagePg).where(eq(llmUsagePg.runId, runId));
  }
  return store.db.select(columns).from(llmUsage).where(eq(llmUsage.runId, runId)).all();
}

const runColumns = {
  id: reviewRuns.id,
  workspaceId: reviewRuns.workspaceId,
  repoRef: projects.repoRef,
  triggerName: reviewRuns.triggerName,
  provider: reviewRuns.provider,
  providerModel: reviewRuns.providerModel,
  status: reviewRuns.status,
  problemCount: reviewRuns.problemCount,
  durationMs: reviewRuns.durationMs,
  startedAt: reviewRuns.startedAt,
  targetKind: reviewRuns.targetKind,
  targetUrl: reviewRuns.targetUrl,
  branch: reviewRuns.branch,
  headSha: reviewRuns.headSha,
  vcsKind: reviewRuns.vcsKind,
  headCommittedAt: reviewRuns.headCommittedAt,
  error: reviewRuns.error,
  skipReason: reviewRuns.skipReason,
};

const runColumnsPg = {
  id: reviewRunsPg.id,
  workspaceId: reviewRunsPg.workspaceId,
  repoRef: projectsPg.repoRef,
  triggerName: reviewRunsPg.triggerName,
  provider: reviewRunsPg.provider,
  providerModel: reviewRunsPg.providerModel,
  status: reviewRunsPg.status,
  problemCount: reviewRunsPg.problemCount,
  durationMs: reviewRunsPg.durationMs,
  startedAt: reviewRunsPg.startedAt,
  targetKind: reviewRunsPg.targetKind,
  targetUrl: reviewRunsPg.targetUrl,
  branch: reviewRunsPg.branch,
  headSha: reviewRunsPg.headSha,
  vcsKind: reviewRunsPg.vcsKind,
  headCommittedAt: reviewRunsPg.headCommittedAt,
  error: reviewRunsPg.error,
  skipReason: reviewRunsPg.skipReason,
};

/** Exact workspace-id or repo-ref lookup for wildcard alias resolution (A15d). */
export async function findImQueryProjectByAlias(
  store: StoreDb,
  alias: string,
): Promise<{ readonly workspaceId: string; readonly triggerName: string | null; readonly repoRef: string } | undefined> {
  if (store.kind === "postgres") {
    const rows = await store.db
      .select({ workspaceId: projectsPg.workspaceId, triggerName: projectsPg.triggerName, repoRef: projectsPg.repoRef })
      .from(projectsPg)
      .where(and(sql`${projectsPg.deletedAt} IS NULL`, sql`(${projectsPg.workspaceId} = ${alias} OR ${projectsPg.repoRef} = ${alias})`))
      .orderBy(desc(projectsPg.id))
      .limit(1);
    return rows[0];
  }
  const rows = store.db
    .select({ workspaceId: projects.workspaceId, triggerName: projects.triggerName, repoRef: projects.repoRef })
    .from(projects)
    .where(and(sql`${projects.deletedAt} IS NULL`, sql`(${projects.workspaceId} = ${alias} OR ${projects.repoRef} = ${alias})`))
    .orderBy(desc(projects.id))
    .limit(1)
    .all();
  return rows[0];
}

/**
 * Marks in-flight rows left by a previous process as failed (single-process
 * executions cannot survive a restart); returns the swept count.
 */
export async function failActiveReviewRuns(store: StoreDb, error: string): Promise<number> {
  const active = await listImQueryRuns(store, { statusIn: ACTIVE_RUN_STATUSES, limit: 200 });
  for (const run of active) {
    await updateRunStatus(store, run.id, "failed", { error });
  }
  return active.length;
}

/** Admin listing: recent IM review requests, newest first (IM-18, X08). */
export async function listImReviewRequestsForAdmin(store: StoreDb, limit = 50, offset = 0): Promise<readonly {
  readonly requestId: string;
  readonly state: string;
  readonly errorCode: string | null;
  readonly workspaceId: string;
  readonly repoRef: string;
  readonly requestedRevision: string;
  readonly requestedByType: string;
  readonly requestedById: string;
  readonly connectionIdentity: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}[]> {
  const bounded = Math.max(0, Math.min(limit, 200));
  const columns = {
    requestId: imReviewRequests.requestId,
    state: imReviewRequests.state,
    errorCode: imReviewRequests.errorCode,
    workspaceId: imReviewRequests.workspaceId,
    repoRef: imReviewRequests.repoRef,
    requestedRevision: imReviewRequests.requestedRevision,
    requestedByType: imReviewRequests.requestedByType,
    requestedById: imReviewRequests.requestedById,
    connectionIdentity: imReviewRequests.connectionIdentity,
    createdAt: imReviewRequests.createdAt,
    updatedAt: imReviewRequests.updatedAt,
  };
  if (store.kind === "postgres") {
    return store.db.select({
      requestId: imReviewRequestsPg.requestId,
      state: imReviewRequestsPg.state,
      errorCode: imReviewRequestsPg.errorCode,
      workspaceId: imReviewRequestsPg.workspaceId,
      repoRef: imReviewRequestsPg.repoRef,
      requestedRevision: imReviewRequestsPg.requestedRevision,
      requestedByType: imReviewRequestsPg.requestedByType,
      requestedById: imReviewRequestsPg.requestedById,
      connectionIdentity: imReviewRequestsPg.connectionIdentity,
      createdAt: imReviewRequestsPg.createdAt,
      updatedAt: imReviewRequestsPg.updatedAt,
    }).from(imReviewRequestsPg).orderBy(desc(imReviewRequestsPg.updatedAt)).limit(bounded).offset(offset);
  }
  void columns;
  return store.db.select({
    requestId: imReviewRequests.requestId,
    state: imReviewRequests.state,
    errorCode: imReviewRequests.errorCode,
    workspaceId: imReviewRequests.workspaceId,
    repoRef: imReviewRequests.repoRef,
    requestedRevision: imReviewRequests.requestedRevision,
    requestedByType: imReviewRequests.requestedByType,
    requestedById: imReviewRequests.requestedById,
    connectionIdentity: imReviewRequests.connectionIdentity,
    createdAt: imReviewRequests.createdAt,
    updatedAt: imReviewRequests.updatedAt,
  }).from(imReviewRequests).orderBy(desc(imReviewRequests.updatedAt)).limit(bounded).offset(offset).all();
}

/** Admin listing: recent reply-outbox notifications, newest first (IM-18). */
export async function listImReplyOutboxForAdmin(store: StoreDb, limit = 50, offset = 0): Promise<readonly {
  readonly operationId: string;
  readonly requestId: string | null;
  readonly destinationIdentity: string;
  readonly operationKind: string;
  readonly state: string;
  readonly attempts: number;
  readonly updatedAt: Date;
}[]> {
  const bounded = Math.max(0, Math.min(limit, 200));
  if (store.kind === "postgres") {
    return store.db.select({
      operationId: imReplyOutboxPg.operationId,
      requestId: imReplyOutboxPg.requestId,
      destinationIdentity: imReplyOutboxPg.destinationIdentity,
      operationKind: imReplyOutboxPg.operationKind,
      state: imReplyOutboxPg.state,
      attempts: imReplyOutboxPg.attempts,
      updatedAt: imReplyOutboxPg.updatedAt,
    }).from(imReplyOutboxPg).orderBy(desc(imReplyOutboxPg.updatedAt)).limit(bounded).offset(offset);
  }
  return store.db.select({
    operationId: imReplyOutbox.operationId,
    requestId: imReplyOutbox.requestId,
    destinationIdentity: imReplyOutbox.destinationIdentity,
    operationKind: imReplyOutbox.operationKind,
    state: imReplyOutbox.state,
    attempts: imReplyOutbox.attempts,
    updatedAt: imReplyOutbox.updatedAt,
  }).from(imReplyOutbox).orderBy(desc(imReplyOutbox.updatedAt)).limit(bounded).offset(offset).all();
}

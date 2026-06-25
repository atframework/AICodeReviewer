import { and, desc, eq, gte, lt, lte, sql, sum, count, avg } from "drizzle-orm";

import type { StoreDb } from "./database.js";
import {
  projects,
  reviewRuns,
  codeMetrics,
  llmUsage,
  outputEvents,
  dailyRollups,
  type RunStatus,
} from "./schema.js";

export interface ReviewRunInsert {
  id: string;
  eventId: string;
  workspaceId: string;
  triggerName: string | null;
  repoRef?: string | null;
  displayName?: string | null;
  provider: string | null;
  providerModel: string | null;
  status: RunStatus;
  attempt?: number;
  startedAt?: Date;
  finishedAt?: Date;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string | null;
  skipReason?: string | null;
  compressed?: boolean | null;
  originalTokenEstimate?: number | null;
  compressedTokenEstimate?: number | null;
  diffFileCount?: number | null;
  changedFileCount?: number | null;
  problemCount?: number;
  summaryCount?: number;
  dispatchCount?: number;
  durationMs?: number | null;
  targetKind?: string | null;
  targetUrl?: string | null;
  branch?: string | null;
  headSha?: string | null;
  codeMetrics?: CodeMetricsInsert;
  llmUsages?: LlmUsageInsert[];
}

export interface CodeMetricsInsert {
  filesChanged?: number;
  linesAdded?: number;
  linesDeleted?: number;
  bytesAnalyzed?: number;
  filesAnalyzed?: number;
}

export interface LlmUsageInsert {
  providerId: string;
  modelId: string;
  requestCount?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensTotal?: number;
  costUsd?: number;
  retryCount?: number;
  fallbackCount?: number;
  failureCount?: number;
  latencyMs?: number;
}

export interface OutputEventInsert {
  channelKind: string;
  eventType: string;
  issueCreated?: boolean;
  commentCreated?: boolean;
  timestamp?: Date;
}

export function insertReviewRun(store: StoreDb, run: ReviewRunInsert): void {
  const projectId = upsertProject(store, {
    workspaceId: run.workspaceId,
    triggerName: run.triggerName ?? "",
    repoRef: run.repoRef ?? "",
    displayName: run.displayName ?? null,
  });

  const startedAt = run.startedAt ?? new Date();

  store.db.insert(reviewRuns).values({
    id: run.id,
    projectId,
    eventId: run.eventId,
    workspaceId: run.workspaceId,
    triggerName: run.triggerName,
    provider: run.provider,
    providerModel: run.providerModel,
    status: run.status,
    ...(run.attempt ? { attempt: run.attempt } : {}),
    startedAt,
    finishedAt: run.finishedAt,
    ...(run.costUsd != null ? { costUsd: run.costUsd } : {}),
    ...(run.tokensIn != null ? { tokensIn: run.tokensIn } : {}),
    ...(run.tokensOut != null ? { tokensOut: run.tokensOut } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.skipReason ? { skipReason: run.skipReason } : {}),
    ...(run.compressed != null ? { compressed: run.compressed } : {}),
    ...(run.originalTokenEstimate != null ? { originalTokenEstimate: run.originalTokenEstimate } : {}),
    ...(run.compressedTokenEstimate != null ? { compressedTokenEstimate: run.compressedTokenEstimate } : {}),
    ...(run.diffFileCount != null ? { diffFileCount: run.diffFileCount } : {}),
    ...(run.changedFileCount != null ? { changedFileCount: run.changedFileCount } : {}),
    problemCount: run.problemCount ?? 0,
    summaryCount: run.summaryCount ?? 0,
    dispatchCount: run.dispatchCount ?? 0,
    ...(run.durationMs != null ? { durationMs: run.durationMs } : {}),
    ...(run.targetKind ? { targetKind: run.targetKind } : {}),
    ...(run.targetUrl ? { targetUrl: run.targetUrl } : {}),
    ...(run.branch ? { branch: run.branch } : {}),
    ...(run.headSha ? { headSha: run.headSha } : {}),
  }).run();

  if (run.codeMetrics) {
    const cm = run.codeMetrics;
    store.db.insert(codeMetrics).values({
      runId: run.id,
      filesChanged: cm.filesChanged ?? 0,
      linesAdded: cm.linesAdded ?? 0,
      linesDeleted: cm.linesDeleted ?? 0,
      bytesAnalyzed: cm.bytesAnalyzed ?? 0,
      filesAnalyzed: cm.filesAnalyzed ?? 0,
    }).run();
  }

  if (run.llmUsages && run.llmUsages.length > 0) {
    for (const usage of run.llmUsages) {
      store.db.insert(llmUsage).values({
        runId: run.id,
        providerId: usage.providerId,
        modelId: usage.modelId,
        requestCount: usage.requestCount ?? 1,
        tokensIn: usage.tokensIn ?? 0,
        tokensOut: usage.tokensOut ?? 0,
        tokensTotal: usage.tokensTotal ?? 0,
        ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
        retryCount: usage.retryCount ?? 0,
        fallbackCount: usage.fallbackCount ?? 0,
        failureCount: usage.failureCount ?? 0,
        ...(usage.latencyMs != null ? { latencyMs: usage.latencyMs } : {}),
      }).run();
    }
  }

  recomputeDailyRollup(store, projectId, toUtcDateString(startedAt));
}

export function insertOutputEvents(
  store: StoreDb,
  runId: string,
  events: OutputEventInsert[],
): void {
  for (const event of events) {
    store.db.insert(outputEvents).values({
      runId,
      channelKind: event.channelKind,
      eventType: event.eventType,
      issueCreated: event.issueCreated ?? false,
      commentCreated: event.commentCreated ?? false,
      timestamp: event.timestamp ?? new Date(),
    }).run();
  }

  const run = store.db
    .select({ projectId: reviewRuns.projectId, startedAt: reviewRuns.startedAt })
    .from(reviewRuns)
    .where(eq(reviewRuns.id, runId))
    .get();
  if (run) {
    recomputeDailyRollup(store, run.projectId, toUtcDateString(run.startedAt ?? new Date()));
  }
}

export function updateRunStatus(
  store: StoreDb,
  runId: string,
  status: RunStatus,
  extra?: {
    error?: string;
    skipReason?: string;
    problemCount?: number;
    summaryCount?: number;
    dispatchCount?: number;
    durationMs?: number;
    costUsd?: number;
    tokensIn?: number;
    tokensOut?: number;
    finishedAt?: Date;
  },
): void {
  store.db
    .update(reviewRuns)
    .set({
      status,
      ...(extra?.error ? { error: extra.error } : {}),
      ...(extra?.skipReason ? { skipReason: extra.skipReason } : {}),
      ...(extra?.problemCount != null ? { problemCount: extra.problemCount } : {}),
      ...(extra?.summaryCount != null ? { summaryCount: extra.summaryCount } : {}),
      ...(extra?.dispatchCount != null ? { dispatchCount: extra.dispatchCount } : {}),
      ...(extra?.durationMs != null ? { durationMs: extra.durationMs } : {}),
      ...(extra?.costUsd != null ? { costUsd: extra.costUsd } : {}),
      ...(extra?.tokensIn != null ? { tokensIn: extra.tokensIn } : {}),
      ...(extra?.tokensOut != null ? { tokensOut: extra.tokensOut } : {}),
      finishedAt: extra?.finishedAt ?? new Date(),
    })
    .where(eq(reviewRuns.id, runId))
    .run();
}

function upsertProject(
  store: StoreDb,
  identity: { workspaceId: string; triggerName: string; repoRef: string; displayName?: string | null },
): number {
  const existing = store.db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, identity.workspaceId),
        eq(projects.triggerName, identity.triggerName),
        eq(projects.repoRef, identity.repoRef),
        sql`${projects.deletedAt} IS NULL`,
      ),
    )
    .get();

  if (existing) {
    if (identity.displayName) {
      store.db
        .update(projects)
        .set({ displayName: identity.displayName })
        .where(eq(projects.id, existing.id))
        .run();
    }
    return existing.id;
  }

  const result = store.db
    .insert(projects)
    .values({
      workspaceId: identity.workspaceId,
      triggerName: identity.triggerName,
      repoRef: identity.repoRef,
      createdAt: new Date(),
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    })
    .run();

  return Number(result.lastInsertRowid);
}

export interface TimeWindowStats {
  reviewCount: number;
  successCount: number;
  failureCount: number;
  skipCount: number;
  problemRunCount: number;
  problemTotal: number;
  issueCreatedCount: number;
  filesChangedTotal: number;
  linesAddedTotal: number;
  linesDeletedTotal: number;
  bytesAnalyzedTotal: number;
  llmRequestTotal: number;
  tokensInTotal: number;
  tokensOutTotal: number;
  tokensTotalTotal: number;
  costUsdTotal: number;
  avgDurationMs: number | null;
}

export interface ProjectStats extends TimeWindowStats {
  projectId: number;
  workspaceId: string;
  triggerName: string;
  repoRef: string;
  displayName: string | null;
}

export interface ProviderModelStats {
  providerId: string;
  modelId: string;
  requestCount: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  costUsd: number | null;
  retryCount: number;
  fallbackCount: number;
  failureCount: number;
  avgLatencyMs: number | null;
}

export function getOverviewStats(
  store: StoreDb,
  since?: Date,
): TimeWindowStats {
  const conditions = since ? [gte(reviewRuns.startedAt, since)] : [];

  const base = store.db
    .select({
      reviewCount: count(),
      successCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'succeeded' OR ${reviewRuns.status} = 'published' THEN 1 ELSE 0 END`),
      failureCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'failed' THEN 1 ELSE 0 END`),
      skipCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'skipped' THEN 1 ELSE 0 END`),
      problemRunCount: sum(sql`CASE WHEN ${reviewRuns.problemCount} > 0 THEN 1 ELSE 0 END`),
      problemTotal: sum(reviewRuns.problemCount),
      avgDurationMs: avg(reviewRuns.durationMs),
    })
    .from(reviewRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .get();

  const issueBase = store.db
    .select({
      issueCreatedCount: sum(sql`CASE WHEN ${outputEvents.issueCreated} = 1 THEN 1 ELSE 0 END`),
    })
    .from(outputEvents)
    .where(since ? gte(outputEvents.timestamp, since) : undefined)
    .get();

  const codeBase = store.db
    .select({
      filesChangedTotal: sum(codeMetrics.filesChanged),
      linesAddedTotal: sum(codeMetrics.linesAdded),
      linesDeletedTotal: sum(codeMetrics.linesDeleted),
      bytesAnalyzedTotal: sum(codeMetrics.bytesAnalyzed),
    })
    .from(codeMetrics)
    .innerJoin(reviewRuns, eq(codeMetrics.runId, reviewRuns.id))
    .where(since ? gte(reviewRuns.startedAt, since) : undefined)
    .get();

  const llmBase = store.db
    .select({
      llmRequestTotal: sum(llmUsage.requestCount),
      tokensInTotal: sum(llmUsage.tokensIn),
      tokensOutTotal: sum(llmUsage.tokensOut),
      tokensTotalTotal: sum(llmUsage.tokensTotal),
      costUsdTotal: sum(llmUsage.costUsd),
    })
    .from(llmUsage)
    .innerJoin(reviewRuns, eq(llmUsage.runId, reviewRuns.id))
    .where(since ? gte(reviewRuns.startedAt, since) : undefined)
    .get();

  return {
    reviewCount: Number(base?.reviewCount ?? 0),
    successCount: Number(base?.successCount ?? 0),
    failureCount: Number(base?.failureCount ?? 0),
    skipCount: Number(base?.skipCount ?? 0),
    problemRunCount: Number(base?.problemRunCount ?? 0),
    problemTotal: Number(base?.problemTotal ?? 0),
    issueCreatedCount: Number(issueBase?.issueCreatedCount ?? 0),
    filesChangedTotal: Number(codeBase?.filesChangedTotal ?? 0),
    linesAddedTotal: Number(codeBase?.linesAddedTotal ?? 0),
    linesDeletedTotal: Number(codeBase?.linesDeletedTotal ?? 0),
    bytesAnalyzedTotal: Number(codeBase?.bytesAnalyzedTotal ?? 0),
    llmRequestTotal: Number(llmBase?.llmRequestTotal ?? 0),
    tokensInTotal: Number(llmBase?.tokensInTotal ?? 0),
    tokensOutTotal: Number(llmBase?.tokensOutTotal ?? 0),
    tokensTotalTotal: Number(llmBase?.tokensTotalTotal ?? 0),
    costUsdTotal: Number(llmBase?.costUsdTotal ?? 0),
    avgDurationMs: base?.avgDurationMs != null ? Math.round(Number(base.avgDurationMs)) : null,
  };
}

export function getProjectStats(
  store: StoreDb,
  since?: Date,
): ProjectStats[] {
  const runConditions = [sql`${projects.deletedAt} IS NULL`];
  if (since) runConditions.push(gte(reviewRuns.startedAt, since));

  const rows = store.db
    .select({
      projectId: projects.id,
      workspaceId: projects.workspaceId,
      triggerName: projects.triggerName,
      repoRef: projects.repoRef,
      displayName: projects.displayName,
      reviewCount: count(),
      successCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'succeeded' OR ${reviewRuns.status} = 'published' THEN 1 ELSE 0 END`),
      failureCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'failed' THEN 1 ELSE 0 END`),
      skipCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'skipped' THEN 1 ELSE 0 END`),
      problemRunCount: sum(sql`CASE WHEN ${reviewRuns.problemCount} > 0 THEN 1 ELSE 0 END`),
      problemTotal: sum(reviewRuns.problemCount),
      avgDurationMs: avg(reviewRuns.durationMs),
    })
    .from(reviewRuns)
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(and(...runConditions))
    .groupBy(projects.id, projects.workspaceId, projects.triggerName, projects.repoRef, projects.displayName)
    .orderBy(desc(count()))
    .all();

  const codeRows = store.db
    .select({
      projectId: projects.id,
      filesChangedTotal: sum(codeMetrics.filesChanged),
      linesAddedTotal: sum(codeMetrics.linesAdded),
      linesDeletedTotal: sum(codeMetrics.linesDeleted),
      bytesAnalyzedTotal: sum(codeMetrics.bytesAnalyzed),
    })
    .from(codeMetrics)
    .innerJoin(reviewRuns, eq(codeMetrics.runId, reviewRuns.id))
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(and(...runConditions))
    .groupBy(projects.id)
    .all();

  const outputRows = store.db
    .select({
      projectId: projects.id,
      issueCreatedCount: sum(sql`CASE WHEN ${outputEvents.issueCreated} = 1 THEN 1 ELSE 0 END`),
    })
    .from(outputEvents)
    .innerJoin(reviewRuns, eq(outputEvents.runId, reviewRuns.id))
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(and(...runConditions))
    .groupBy(projects.id)
    .all();

  const llmRows = store.db
    .select({
      projectId: projects.id,
      llmRequestTotal: sum(llmUsage.requestCount),
      tokensInTotal: sum(llmUsage.tokensIn),
      tokensOutTotal: sum(llmUsage.tokensOut),
      tokensTotalTotal: sum(llmUsage.tokensTotal),
      costUsdTotal: sum(llmUsage.costUsd),
    })
    .from(llmUsage)
    .innerJoin(reviewRuns, eq(llmUsage.runId, reviewRuns.id))
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(and(...runConditions))
    .groupBy(projects.id)
    .all();

  const codeByProject = new Map(codeRows.map((row) => [row.projectId, row]));
  const outputByProject = new Map(outputRows.map((row) => [row.projectId, row]));
  const llmByProject = new Map(llmRows.map((row) => [row.projectId, row]));

  return rows.map((row) => ({
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    triggerName: row.triggerName,
    repoRef: row.repoRef,
    displayName: row.displayName,
    reviewCount: Number(row.reviewCount),
    successCount: Number(row.successCount),
    failureCount: Number(row.failureCount),
    skipCount: Number(row.skipCount),
    problemRunCount: Number(row.problemRunCount),
    problemTotal: Number(row.problemTotal),
    issueCreatedCount: Number(outputByProject.get(row.projectId)?.issueCreatedCount ?? 0),
    filesChangedTotal: Number(codeByProject.get(row.projectId)?.filesChangedTotal ?? 0),
    linesAddedTotal: Number(codeByProject.get(row.projectId)?.linesAddedTotal ?? 0),
    linesDeletedTotal: Number(codeByProject.get(row.projectId)?.linesDeletedTotal ?? 0),
    bytesAnalyzedTotal: Number(codeByProject.get(row.projectId)?.bytesAnalyzedTotal ?? 0),
    llmRequestTotal: Number(llmByProject.get(row.projectId)?.llmRequestTotal ?? 0),
    tokensInTotal: Number(llmByProject.get(row.projectId)?.tokensInTotal ?? 0),
    tokensOutTotal: Number(llmByProject.get(row.projectId)?.tokensOutTotal ?? 0),
    tokensTotalTotal: Number(llmByProject.get(row.projectId)?.tokensTotalTotal ?? 0),
    costUsdTotal: Number(llmByProject.get(row.projectId)?.costUsdTotal ?? 0),
    avgDurationMs: row.avgDurationMs != null ? Math.round(Number(row.avgDurationMs)) : null,
  }));
}

export function getProviderModelStats(
  store: StoreDb,
  since?: Date,
): ProviderModelStats[] {
  const conditions = since ? [gte(reviewRuns.startedAt, since)] : [];

  const rows = store.db
    .select({
      providerId: llmUsage.providerId,
      modelId: llmUsage.modelId,
      requestCount: sum(llmUsage.requestCount),
      tokensIn: sum(llmUsage.tokensIn),
      tokensOut: sum(llmUsage.tokensOut),
      tokensTotal: sum(llmUsage.tokensTotal),
      costUsd: sum(llmUsage.costUsd),
      retryCount: sum(llmUsage.retryCount),
      fallbackCount: sum(llmUsage.fallbackCount),
      failureCount: sum(llmUsage.failureCount),
      avgLatencyMs: avg(llmUsage.latencyMs),
    })
    .from(llmUsage)
    .innerJoin(reviewRuns, eq(llmUsage.runId, reviewRuns.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(llmUsage.providerId, llmUsage.modelId)
    .orderBy(desc(sum(llmUsage.requestCount)))
    .all();

  return rows.map((row) => ({
    providerId: row.providerId,
    modelId: row.modelId,
    requestCount: Number(row.requestCount),
    tokensIn: Number(row.tokensIn),
    tokensOut: Number(row.tokensOut),
    tokensTotal: Number(row.tokensTotal),
    costUsd: row.costUsd != null ? Number(row.costUsd) : null,
    retryCount: Number(row.retryCount),
    fallbackCount: Number(row.fallbackCount),
    failureCount: Number(row.failureCount),
    avgLatencyMs: row.avgLatencyMs != null ? Math.round(Number(row.avgLatencyMs)) : null,
  }));
}

export function getRecentRuns(
  store: StoreDb,
  limit: number,
): Array<{
  id: string;
  workspaceId: string;
  triggerName: string | null;
  provider: string | null;
  providerModel: string | null;
  status: string;
  problemCount: number;
  durationMs: number | null;
  startedAt: Date | null;
  targetKind: string | null;
}> {
  return store.db
    .select({
      id: reviewRuns.id,
      workspaceId: reviewRuns.workspaceId,
      triggerName: reviewRuns.triggerName,
      provider: reviewRuns.provider,
      providerModel: reviewRuns.providerModel,
      status: reviewRuns.status,
      problemCount: reviewRuns.problemCount,
      durationMs: reviewRuns.durationMs,
      startedAt: reviewRuns.startedAt,
      targetKind: reviewRuns.targetKind,
    })
    .from(reviewRuns)
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(sql`${projects.deletedAt} IS NULL`)
    .orderBy(desc(reviewRuns.startedAt))
    .limit(limit)
    .all();
}

export function softDeleteMissingProjects(
  store: StoreDb,
  activeIdentities: ReadonlyArray<{ workspaceId: string; triggerName: string; repoRef: string }>,
): number {
  if (activeIdentities.length === 0) {
    const result = store.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(sql`${projects.deletedAt} IS NULL`)
      .run();
    return Number(result.changes);
  }

  const conditions = activeIdentities.map((id) =>
    sql`(${projects.workspaceId} = ${id.workspaceId} AND ${projects.triggerName} = ${id.triggerName} AND ${projects.repoRef} = ${id.repoRef})`,
  );

  const result = store.db
    .update(projects)
    .set({ deletedAt: new Date() })
    .where(
      and(
        sql`${projects.deletedAt} IS NULL`,
        sql`NOT (${sql.join(conditions, sql` OR `)})`,
      ),
    )
    .run();

  return Number(result.changes);
}

export function hardDeleteExpiredProjects(
  store: StoreDb,
  graceDays: number,
): number {
  const cutoffMs = Date.now() - graceDays * 24 * 60 * 60 * 1000;

  const result = store.sqlite
    .prepare("DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ?")
    .run(cutoffMs);

  return Number(result.changes);
}

export function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface DailyRollupRow {
  projectId: number;
  date: string;
  reviewCount: number;
  successCount: number;
  failureCount: number;
  skipCount: number;
  problemRunCount: number;
  problemTotal: number;
  issueCreatedCount: number;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  bytesAnalyzed: number;
  llmRequestCount: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  costUsd: number | null;
}

function dayRange(date: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${date}T00:00:00.000Z`));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export function recomputeDailyRollup(
  store: StoreDb,
  projectId: number,
  date: string,
): void {
  const { start, end } = dayRange(date);
  const windowWhere = and(
    eq(reviewRuns.projectId, projectId),
    gte(reviewRuns.startedAt, start),
    lt(reviewRuns.startedAt, end),
  );

  const runBase = store.db
    .select({
      reviewCount: count(),
      successCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'succeeded' OR ${reviewRuns.status} = 'published' THEN 1 ELSE 0 END`),
      failureCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'failed' THEN 1 ELSE 0 END`),
      skipCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'skipped' THEN 1 ELSE 0 END`),
      problemRunCount: sum(sql`CASE WHEN ${reviewRuns.problemCount} > 0 THEN 1 ELSE 0 END`),
      problemTotal: sum(reviewRuns.problemCount),
    })
    .from(reviewRuns)
    .where(windowWhere)
    .get();

  const reviewCount = Number(runBase?.reviewCount ?? 0);

  const rollupWhere = and(eq(dailyRollups.projectId, projectId), eq(dailyRollups.date, date));

  if (reviewCount === 0) {
    store.db.delete(dailyRollups).where(rollupWhere).run();
    return;
  }

  const codeBase = store.db
    .select({
      filesChanged: sum(codeMetrics.filesChanged),
      linesAdded: sum(codeMetrics.linesAdded),
      linesDeleted: sum(codeMetrics.linesDeleted),
      bytesAnalyzed: sum(codeMetrics.bytesAnalyzed),
    })
    .from(codeMetrics)
    .innerJoin(reviewRuns, eq(codeMetrics.runId, reviewRuns.id))
    .where(windowWhere)
    .get();

  const outputBase = store.db
    .select({
      issueCreatedCount: sum(sql`CASE WHEN ${outputEvents.issueCreated} = 1 THEN 1 ELSE 0 END`),
    })
    .from(outputEvents)
    .innerJoin(reviewRuns, eq(outputEvents.runId, reviewRuns.id))
    .where(windowWhere)
    .get();

  const llmBase = store.db
    .select({
      llmRequestCount: sum(llmUsage.requestCount),
      tokensIn: sum(llmUsage.tokensIn),
      tokensOut: sum(llmUsage.tokensOut),
      tokensTotal: sum(llmUsage.tokensTotal),
      costUsd: sum(llmUsage.costUsd),
    })
    .from(llmUsage)
    .innerJoin(reviewRuns, eq(llmUsage.runId, reviewRuns.id))
    .where(windowWhere)
    .get();

  store.sqlite.transaction(() => {
    store.db.delete(dailyRollups).where(rollupWhere).run();
    store.db
      .insert(dailyRollups)
      .values({
        projectId,
        date,
        reviewCount,
        successCount: Number(runBase?.successCount ?? 0),
        failureCount: Number(runBase?.failureCount ?? 0),
        skipCount: Number(runBase?.skipCount ?? 0),
        problemRunCount: Number(runBase?.problemRunCount ?? 0),
        problemTotal: Number(runBase?.problemTotal ?? 0),
        issueCreatedCount: Number(outputBase?.issueCreatedCount ?? 0),
        filesChanged: Number(codeBase?.filesChanged ?? 0),
        linesAdded: Number(codeBase?.linesAdded ?? 0),
        linesDeleted: Number(codeBase?.linesDeleted ?? 0),
        bytesAnalyzed: Number(codeBase?.bytesAnalyzed ?? 0),
        llmRequestCount: Number(llmBase?.llmRequestCount ?? 0),
        tokensIn: Number(llmBase?.tokensIn ?? 0),
        tokensOut: Number(llmBase?.tokensOut ?? 0),
        tokensTotal: Number(llmBase?.tokensTotal ?? 0),
        costUsd: llmBase?.costUsd != null ? Number(llmBase.costUsd) : null,
      })
      .run();
  })();
}

export function getDailyRollups(
  store: StoreDb,
  filter?: { projectId?: number; since?: string; until?: string },
): DailyRollupRow[] {
  const conditions = [];
  if (filter?.projectId != null) conditions.push(eq(dailyRollups.projectId, filter.projectId));
  if (filter?.since) conditions.push(gte(dailyRollups.date, filter.since));
  if (filter?.until) conditions.push(lte(dailyRollups.date, filter.until));

  const rows = store.db
    .select()
    .from(dailyRollups)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(dailyRollups.date, dailyRollups.projectId)
    .all();

  return rows.map((row) => ({
    projectId: row.projectId,
    date: row.date,
    reviewCount: row.reviewCount,
    successCount: row.successCount,
    failureCount: row.failureCount,
    skipCount: row.skipCount,
    problemRunCount: row.problemRunCount,
    problemTotal: row.problemTotal,
    issueCreatedCount: row.issueCreatedCount,
    filesChanged: row.filesChanged,
    linesAdded: row.linesAdded,
    linesDeleted: row.linesDeleted,
    bytesAnalyzed: row.bytesAnalyzed,
    llmRequestCount: row.llmRequestCount,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    tokensTotal: row.tokensTotal,
    costUsd: row.costUsd,
  }));
}

/**
 * PostgreSQL branch of the stats/recording consumer contract (stats.ts).
 * Queries mirror the sqlite implementations against the pg schema mirror
 * (schema.pg.ts); differences are dialect-only: promise-based execution,
 * RETURNING instead of lastInsertRowid/changes, native boolean comparisons,
 * and transactions via drizzle's async tx API.
 */

import { and, avg, count, desc, DrizzleQueryError, eq, gte, inArray, lt, lte, sql, sum } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";

import type { PgStoreDb } from "./database.js";
import {
  codeMetrics,
  dailyRollups,
  llmUsage,
  outputEvents,
  projects,
  reviewRuns,
} from "./schema.pg.js";
import type * as pgSchema from "./schema.pg.js";
import type {
  CodeMetricsInsert,
  DailyRollupRow,
  OutputEventInsert,
  ProjectStats,
  ProviderModelStats,
  RecentRunStats,
  ReviewRunInsert,
  TimeWindowStats,
} from "./stats.js";
import { dayRange, toUtcDateString } from "./stats.js";
import type { RunStatus } from "./schema.js";

/** Query executor shared by standalone calls and transaction bodies. */
type PgExecutor =
  | PgStoreDb["db"]
  | PgTransaction<NodePgQueryResultHKT, typeof pgSchema, ExtractTablesWithRelations<typeof pgSchema>>;

async function upsertProjectPg(
  db: PgExecutor,
  identity: { workspaceId: string; triggerName: string; repoRef: string; displayName?: string | null },
): Promise<number> {
  // Matches the idx_projects_identity partial unique index predicate.
  const identityWhere = and(
    eq(projects.workspaceId, identity.workspaceId),
    eq(projects.triggerName, identity.triggerName),
    eq(projects.repoRef, identity.repoRef),
    sql`${projects.deletedAt} IS NULL`,
  );
  const existing = (await db.select({ id: projects.id }).from(projects).where(identityWhere))[0];

  if (existing) {
    if (identity.displayName) {
      await db
        .update(projects)
        .set({ displayName: identity.displayName })
        .where(eq(projects.id, existing.id));
    }
    return existing.id;
  }

  // ON CONFLICT DO NOTHING keeps a concurrent creator of the same identity
  // (idx_projects_identity) from surfacing as a run-level 23505.
  const inserted = (
    await db
      .insert(projects)
      .values({
        workspaceId: identity.workspaceId,
        triggerName: identity.triggerName,
        repoRef: identity.repoRef,
        createdAt: new Date(),
        ...(identity.displayName ? { displayName: identity.displayName } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: projects.id })
  )[0];
  if (inserted) return inserted.id;

  // Lost the insert race: the winner has committed by now, so re-read its row.
  const winner = (await db.select({ id: projects.id }).from(projects).where(identityWhere))[0];
  if (!winner) {
    throw new Error(
      `project identity ${identity.workspaceId}/${identity.triggerName}/${identity.repoRef} vanished after an insert conflict`,
    );
  }
  if (identity.displayName) {
    await db
      .update(projects)
      .set({ displayName: identity.displayName })
      .where(eq(projects.id, winner.id));
  }
  return winner.id;
}

/**
 * Atomic dedup variant: records the run only when its id is absent; returns
 * false when the row already exists (or a concurrent insert won the race on
 * the review_runs primary key). The whole accounting runs in one transaction,
 * so a mid-write failure rolls back completely and a checkpoint retry can
 * safely replay it.
 */
export async function insertReviewRunOncePg(store: PgStoreDb, run: ReviewRunInsert): Promise<boolean> {
  try {
    return await store.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: reviewRuns.id })
        .from(reviewRuns)
        .where(eq(reviewRuns.id, run.id));
      if (existing.length > 0) return false;
      await insertReviewRunOn(tx, run);
      return true;
    });
  } catch (error) {
    // Only the review_runs primary key tolerates 23505 (a concurrent insert of
    // the same run id won the race); any other unique violation is a real
    // failure and must propagate.
    const pgError = (error instanceof DrizzleQueryError ? error.cause : error) as { code?: string | undefined; constraint?: string | undefined };
    if (pgError.code === "23505" && pgError.constraint === "review_runs_pkey") return false;
    throw error;
  }
}

export async function insertReviewRunPg(store: PgStoreDb, run: ReviewRunInsert): Promise<void> {
  await store.db.transaction(async (tx) => {
    await insertReviewRunOn(tx, run);
  });
}

async function insertReviewRunOn(db: PgExecutor, run: ReviewRunInsert): Promise<void> {
  const projectId = await upsertProjectPg(db, {
    workspaceId: run.workspaceId,
    triggerName: run.triggerName ?? "",
    repoRef: run.repoRef ?? "",
    displayName: run.displayName ?? null,
  });

  const startedAt = run.startedAt ?? new Date();

  await db.insert(reviewRuns).values({
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
    ...(run.promptTokenEstimate != null ? { promptTokenEstimate: run.promptTokenEstimate } : {}),
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
    ...(run.vcsKind ? { vcsKind: run.vcsKind } : {}),
    ...(run.headCommittedAt ? { headCommittedAt: run.headCommittedAt } : {}),
  });

  if (run.codeMetrics) {
    const cm: CodeMetricsInsert = run.codeMetrics;
    await db.insert(codeMetrics).values({
      runId: run.id,
      filesChanged: cm.filesChanged ?? 0,
      linesAdded: cm.linesAdded ?? 0,
      linesDeleted: cm.linesDeleted ?? 0,
      bytesAnalyzed: cm.bytesAnalyzed ?? 0,
      filesAnalyzed: cm.filesAnalyzed ?? 0,
    });
  }

  if (run.llmUsages && run.llmUsages.length > 0) {
    for (const usage of run.llmUsages) {
      await db.insert(llmUsage).values({
        runId: run.id,
        providerId: usage.providerId,
        modelId: usage.modelId,
        requestCount: usage.requestCount ?? 1,
        tokensIn: usage.tokensIn ?? 0,
        tokensOut: usage.tokensOut ?? 0,
        tokensTotal: usage.tokensTotal ?? 0,
        cachedTokens: usage.cachedTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
        retryCount: usage.retryCount ?? 0,
        fallbackCount: usage.fallbackCount ?? 0,
        failureCount: usage.failureCount ?? 0,
        ...(usage.latencyMs != null ? { latencyMs: usage.latencyMs } : {}),
      });
    }
  }

  await recomputeDailyRollupOn(db, projectId, toUtcDateString(startedAt));
}

export async function insertOutputEventsPg(
  store: PgStoreDb,
  runId: string,
  events: OutputEventInsert[],
): Promise<void> {
  for (const event of events) {
    await store.db.insert(outputEvents).values({
      runId,
      channelKind: event.channelKind,
      eventType: event.eventType,
      issueCreated: event.issueCreated ?? false,
      commentCreated: event.commentCreated ?? false,
      timestamp: event.timestamp ?? new Date(),
    });
  }

  const run = (
    await store.db
      .select({ projectId: reviewRuns.projectId, startedAt: reviewRuns.startedAt })
      .from(reviewRuns)
      .where(eq(reviewRuns.id, runId))
  )[0];
  if (run) {
    await recomputeDailyRollupPg(store, run.projectId, toUtcDateString(run.startedAt ?? new Date()));
  }
}

export async function updateRunStatusPg(
  store: PgStoreDb,
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
): Promise<void> {
  await store.db
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
    .where(eq(reviewRuns.id, runId));
}

export async function getOverviewStatsPg(
  store: PgStoreDb,
  since?: Date,
): Promise<TimeWindowStats> {
  const conditions = since ? [gte(reviewRuns.startedAt, since)] : [];

  const base = (
    await store.db
      .select({
        reviewCount: count(),
        successCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'succeeded' OR ${reviewRuns.status} = 'published' THEN 1 ELSE 0 END`),
        failureCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'failed' THEN 1 ELSE 0 END`),
        skipCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'skipped' THEN 1 ELSE 0 END`),
        problemRunCount: sum(sql`CASE WHEN ${reviewRuns.problemCount} > 0 THEN 1 ELSE 0 END`),
        problemTotal: sum(reviewRuns.problemCount),
        avgDurationMs: avg(reviewRuns.durationMs),
        promptTokenEstimateTotal: sum(reviewRuns.promptTokenEstimate),
      })
      .from(reviewRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
  )[0];

  const issueBase = (
    await store.db
      .select({
        issueCreatedCount: sum(sql`CASE WHEN ${outputEvents.issueCreated} THEN 1 ELSE 0 END`),
      })
      .from(outputEvents)
      .where(since ? gte(outputEvents.timestamp, since) : undefined)
  )[0];

  const codeBase = (
    await store.db
      .select({
        filesChangedTotal: sum(codeMetrics.filesChanged),
        linesAddedTotal: sum(codeMetrics.linesAdded),
        linesDeletedTotal: sum(codeMetrics.linesDeleted),
        bytesAnalyzedTotal: sum(codeMetrics.bytesAnalyzed),
      })
      .from(codeMetrics)
      .innerJoin(reviewRuns, eq(codeMetrics.runId, reviewRuns.id))
      .where(since ? gte(reviewRuns.startedAt, since) : undefined)
  )[0];

  const llmBase = (
    await store.db
      .select({
        llmRequestTotal: sum(llmUsage.requestCount),
        tokensInTotal: sum(llmUsage.tokensIn),
        tokensOutTotal: sum(llmUsage.tokensOut),
        tokensTotalTotal: sum(llmUsage.tokensTotal),
        cachedTokensInTotal: sum(llmUsage.cachedTokens),
        cacheCreationTokensTotal: sum(llmUsage.cacheCreationTokens),
        costUsdTotal: sum(llmUsage.costUsd),
      })
      .from(llmUsage)
      .innerJoin(reviewRuns, eq(llmUsage.runId, reviewRuns.id))
      .where(since ? gte(reviewRuns.startedAt, since) : undefined)
  )[0];

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
    cachedTokensInTotal: Number(llmBase?.cachedTokensInTotal ?? 0),
    cacheCreationTokensTotal: Number(llmBase?.cacheCreationTokensTotal ?? 0),
    costUsdTotal: Number(llmBase?.costUsdTotal ?? 0),
    avgDurationMs: base?.avgDurationMs != null ? Math.round(Number(base.avgDurationMs)) : null,
    promptTokenEstimateTotal: Number(base?.promptTokenEstimateTotal ?? 0),
  };
}

export async function getProjectStatsPg(
  store: PgStoreDb,
  since?: Date,
): Promise<ProjectStats[]> {
  const runConditions = since ? [gte(reviewRuns.startedAt, since)] : [];
  const whereClause = runConditions.length > 0 ? and(...runConditions) : undefined;

  const rows = await store.db
    .select({
      projectId: projects.id,
      workspaceId: projects.workspaceId,
      triggerName: projects.triggerName,
      repoRef: projects.repoRef,
      displayName: projects.displayName,
      isActive: sql<boolean>`${projects.deletedAt} IS NULL`,
      reviewCount: count(),
      successCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'succeeded' OR ${reviewRuns.status} = 'published' THEN 1 ELSE 0 END`),
      failureCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'failed' THEN 1 ELSE 0 END`),
      skipCount: sum(sql`CASE WHEN ${reviewRuns.status} = 'skipped' THEN 1 ELSE 0 END`),
      problemRunCount: sum(sql`CASE WHEN ${reviewRuns.problemCount} > 0 THEN 1 ELSE 0 END`),
      problemTotal: sum(reviewRuns.problemCount),
      avgDurationMs: avg(reviewRuns.durationMs),
      promptTokenEstimateTotal: sum(reviewRuns.promptTokenEstimate),
    })
    .from(reviewRuns)
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(whereClause)
    .groupBy(projects.id, projects.workspaceId, projects.triggerName, projects.repoRef, projects.displayName, projects.deletedAt)
    .orderBy(desc(count()));

  const codeRows = await store.db
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
    .where(whereClause)
    .groupBy(projects.id);

  const outputRows = await store.db
    .select({
      projectId: projects.id,
      issueCreatedCount: sum(sql`CASE WHEN ${outputEvents.issueCreated} THEN 1 ELSE 0 END`),
    })
    .from(outputEvents)
    .innerJoin(reviewRuns, eq(outputEvents.runId, reviewRuns.id))
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(whereClause)
    .groupBy(projects.id);

  const llmRows = await store.db
    .select({
      projectId: projects.id,
      llmRequestTotal: sum(llmUsage.requestCount),
      tokensInTotal: sum(llmUsage.tokensIn),
      tokensOutTotal: sum(llmUsage.tokensOut),
      tokensTotalTotal: sum(llmUsage.tokensTotal),
      cachedTokensInTotal: sum(llmUsage.cachedTokens),
      cacheCreationTokensTotal: sum(llmUsage.cacheCreationTokens),
      costUsdTotal: sum(llmUsage.costUsd),
    })
    .from(llmUsage)
    .innerJoin(reviewRuns, eq(llmUsage.runId, reviewRuns.id))
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .where(whereClause)
    .groupBy(projects.id);

  const codeByProject = new Map(codeRows.map((row) => [row.projectId, row]));
  const outputByProject = new Map(outputRows.map((row) => [row.projectId, row]));
  const llmByProject = new Map(llmRows.map((row) => [row.projectId, row]));

  return rows.map((row) => ({
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    triggerName: row.triggerName,
    repoRef: row.repoRef,
    displayName: row.displayName,
    isActive: row.isActive === true || Number(row.isActive) === 1,
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
    cachedTokensInTotal: Number(llmByProject.get(row.projectId)?.cachedTokensInTotal ?? 0),
    cacheCreationTokensTotal: Number(llmByProject.get(row.projectId)?.cacheCreationTokensTotal ?? 0),
    costUsdTotal: Number(llmByProject.get(row.projectId)?.costUsdTotal ?? 0),
    avgDurationMs: row.avgDurationMs != null ? Math.round(Number(row.avgDurationMs)) : null,
    promptTokenEstimateTotal: Number(row.promptTokenEstimateTotal ?? 0),
  }));
}

export async function getProviderModelStatsPg(
  store: PgStoreDb,
  since?: Date,
): Promise<ProviderModelStats[]> {
  const conditions = since ? [gte(reviewRuns.startedAt, since)] : [];

  const rows = await store.db
    .select({
      providerId: llmUsage.providerId,
      modelId: llmUsage.modelId,
      requestCount: sum(llmUsage.requestCount),
      tokensIn: sum(llmUsage.tokensIn),
      tokensOut: sum(llmUsage.tokensOut),
      tokensTotal: sum(llmUsage.tokensTotal),
      cachedTokensIn: sum(llmUsage.cachedTokens),
      cacheCreationTokens: sum(llmUsage.cacheCreationTokens),
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
    .orderBy(desc(sum(llmUsage.requestCount)));

  return rows.map((row) => ({
    providerId: row.providerId,
    modelId: row.modelId,
    requestCount: Number(row.requestCount),
    tokensIn: Number(row.tokensIn),
    tokensOut: Number(row.tokensOut),
    tokensTotal: Number(row.tokensTotal),
    cachedTokensIn: Number(row.cachedTokensIn),
    cacheCreationTokens: Number(row.cacheCreationTokens),
    costUsd: row.costUsd != null ? Number(row.costUsd) : null,
    retryCount: Number(row.retryCount),
    fallbackCount: Number(row.fallbackCount),
    failureCount: Number(row.failureCount),
    avgLatencyMs: row.avgLatencyMs != null ? Math.round(Number(row.avgLatencyMs)) : null,
  }));
}

export async function getRecentRunsPg(
  store: PgStoreDb,
  limit: number,
): Promise<RecentRunStats[]> {
  const runs = await store.db
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
      branch: reviewRuns.branch,
      headSha: reviewRuns.headSha,
      vcsKind: reviewRuns.vcsKind,
      headCommittedAt: reviewRuns.headCommittedAt,
    })
    .from(reviewRuns)
    .innerJoin(projects, eq(reviewRuns.projectId, projects.id))
    .orderBy(desc(reviewRuns.startedAt))
    .limit(limit);

  if (runs.length === 0) {
    return runs;
  }

  const usageRows = await store.db
    .select({
      runId: llmUsage.runId,
      tokensIn: sum(llmUsage.tokensIn),
      tokensOut: sum(llmUsage.tokensOut),
      tokensTotal: sum(llmUsage.tokensTotal),
      cachedTokens: sum(llmUsage.cachedTokens),
      cacheCreationTokens: sum(llmUsage.cacheCreationTokens),
    })
    .from(llmUsage)
    .where(inArray(llmUsage.runId, runs.map((run) => run.id)))
    .groupBy(llmUsage.runId);

  const usageByRun = new Map(usageRows.map((row) => [row.runId, row]));

  return runs.map((run) => {
    const usage = usageByRun.get(run.id);
    if (!usage) {
      return run;
    }
    return {
      ...run,
      llmUsage: {
        tokensIn: Number(usage.tokensIn),
        tokensOut: Number(usage.tokensOut),
        tokensTotal: Number(usage.tokensTotal),
        cachedTokens: Number(usage.cachedTokens),
        cacheCreationTokens: Number(usage.cacheCreationTokens),
      },
    };
  });
}

export async function softDeleteMissingProjectsPg(
  store: PgStoreDb,
  activeIdentities: ReadonlyArray<{ workspaceId: string; triggerName: string; repoRef: string }>,
  activeMatchWorkspaceIds: readonly string[] = [],
): Promise<number> {
  if (activeIdentities.length === 0 && activeMatchWorkspaceIds.length === 0) {
    const updated = await store.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(sql`${projects.deletedAt} IS NULL`)
      .returning({ id: projects.id });
    return updated.length;
  }

  const conditions = activeIdentities.map((id) =>
    sql`(${projects.workspaceId} = ${id.workspaceId} AND ${projects.triggerName} = ${id.triggerName} AND ${projects.repoRef} = ${id.repoRef})`,
  );
  // A match definition does not enumerate its projects in source_repo. Keep
  // discovered projects until the definition is removed; never infer deletion
  // from the absence of a static binding (branch-specific rules need snapshots).
  conditions.push(...activeMatchWorkspaceIds.map((id) => sql`${projects.workspaceId} = ${id}`));

  const updated = await store.db
    .update(projects)
    .set({ deletedAt: new Date() })
    .where(
      and(
        sql`${projects.deletedAt} IS NULL`,
        sql`NOT (${sql.join(conditions, sql` OR `)})`,
      ),
    )
    .returning({ id: projects.id });

  return updated.length;
}

export async function hardDeleteExpiredProjectsPg(
  store: PgStoreDb,
  graceDays: number,
): Promise<number> {
  const cutoffMs = Date.now() - graceDays * 24 * 60 * 60 * 1000;

  const deleted = await store.db
    .delete(projects)
    .where(
      and(
        sql`${projects.deletedAt} IS NOT NULL`,
        lte(projects.deletedAt, new Date(cutoffMs)),
      ),
    )
    .returning({ id: projects.id });

  return deleted.length;
}

export async function recomputeDailyRollupPg(
  store: PgStoreDb,
  projectId: number,
  date: string,
): Promise<void> {
  await store.db.transaction(async (tx) => {
    await recomputeDailyRollupOn(tx, projectId, date);
  });
}

async function recomputeDailyRollupOn(db: PgExecutor, projectId: number, date: string): Promise<void> {
  // Every caller holds a transaction. Serialize before reading aggregates,
  // so a waiting writer sees the preceding writer's committed run. NO KEY
  // UPDATE remains compatible with the FK KEY SHARE locks on new runs.
  await db.execute(sql`SELECT id FROM ${projects} WHERE id = ${projectId} FOR NO KEY UPDATE`);
  const { start, end } = dayRange(date);
  const windowWhere = and(
    eq(reviewRuns.projectId, projectId),
    gte(reviewRuns.startedAt, start),
    lt(reviewRuns.startedAt, end),
  );

  const runBase = (
    await db
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
  )[0];

  const reviewCount = Number(runBase?.reviewCount ?? 0);

  if (reviewCount === 0) {
    await db
      .delete(dailyRollups)
      .where(and(eq(dailyRollups.projectId, projectId), eq(dailyRollups.date, date)));
    return;
  }

  const codeBase = (
    await db
      .select({
        filesChanged: sum(codeMetrics.filesChanged),
        linesAdded: sum(codeMetrics.linesAdded),
        linesDeleted: sum(codeMetrics.linesDeleted),
        bytesAnalyzed: sum(codeMetrics.bytesAnalyzed),
      })
      .from(codeMetrics)
      .innerJoin(reviewRuns, eq(codeMetrics.runId, reviewRuns.id))
      .where(windowWhere)
  )[0];

  const outputBase = (
    await db
      .select({
        issueCreatedCount: sum(sql`CASE WHEN ${outputEvents.issueCreated} THEN 1 ELSE 0 END`),
      })
      .from(outputEvents)
      .innerJoin(reviewRuns, eq(outputEvents.runId, reviewRuns.id))
      .where(windowWhere)
  )[0];

  const llmBase = (
    await db
      .select({
        llmRequestCount: sum(llmUsage.requestCount),
        tokensIn: sum(llmUsage.tokensIn),
        tokensOut: sum(llmUsage.tokensOut),
        tokensTotal: sum(llmUsage.tokensTotal),
        cachedTokens: sum(llmUsage.cachedTokens),
        cacheCreationTokens: sum(llmUsage.cacheCreationTokens),
        costUsd: sum(llmUsage.costUsd),
      })
      .from(llmUsage)
      .innerJoin(reviewRuns, eq(llmUsage.runId, reviewRuns.id))
      .where(windowWhere)
  )[0];

  const aggregates = {
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
    cachedTokens: Number(llmBase?.cachedTokens ?? 0),
    cacheCreationTokens: Number(llmBase?.cacheCreationTokens ?? 0),
    costUsd: llmBase?.costUsd != null ? Number(llmBase.costUsd) : null,
  };

  // Upsert (idx_daily_rollups_project_date) instead of delete+insert: two
  // transactions recording runs for the same project day must both commit,
  // not fail the loser with a 23505.
  await db
    .insert(dailyRollups)
    .values({ projectId, date, ...aggregates })
    .onConflictDoUpdate({
      target: [dailyRollups.projectId, dailyRollups.date],
      set: aggregates,
    });
}

export async function getDailyRollupsPg(
  store: PgStoreDb,
  filter?: { projectId?: number; since?: string; until?: string },
): Promise<DailyRollupRow[]> {
  const conditions = [];
  if (filter?.projectId != null) conditions.push(eq(dailyRollups.projectId, filter.projectId));
  if (filter?.since) conditions.push(gte(dailyRollups.date, filter.since));
  if (filter?.until) conditions.push(lte(dailyRollups.date, filter.until));

  const rows = await store.db
    .select()
    .from(dailyRollups)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(dailyRollups.date, dailyRollups.projectId);

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
    cachedTokens: row.cachedTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    costUsd: row.costUsd,
  }));
}

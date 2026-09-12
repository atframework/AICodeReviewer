/**
 * PostgreSQL field-level mirror of the SQLite schema (schema.ts). Same table
 * names, same column names, same semantics:
 * - epoch-millisecond timestamps stay integer (bigint here, Date-mapped);
 * - SQLite 0/1 boolean columns become native boolean;
 * - SQLite REAL becomes double precision (float8, matching SQLite's width).
 * The migration DDL in pg-migrations.ts is the source of truth for the
 * physical layout; this module is the drizzle query-time view.
 */

import {
  boolean,
  customType,
  doublePrecision,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

import type { RunStatus, WebhookEventDecision, ReviewDeferralStatus } from "./schema.js";

/** Epoch milliseconds stored in a bigint column, exposed as a Date. */
const epochMs = customType<{ data: Date; driverData: string }>({
  dataType: () => "bigint",
  toDriver: (value: Date) => String(value.getTime()),
  fromDriver: (value: string) => new Date(Number(value)),
});

export const projects = pgTable("projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: text("workspace_id").notNull(),
  triggerName: text("trigger_name").notNull(),
  repoRef: text("repo_ref").notNull(),
  displayName: text("display_name"),
  createdAt: epochMs("created_at").notNull(),
  deletedAt: epochMs("deleted_at"),
});

export const reviewRuns = pgTable("review_runs", {
  id: text("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  triggerName: text("trigger_name"),
  provider: text("provider"),
  providerModel: text("provider_model"),
  status: text("status").$type<RunStatus>().notNull(),
  attempt: integer("attempt").notNull().default(1),
  startedAt: epochMs("started_at"),
  finishedAt: epochMs("finished_at"),
  costUsd: doublePrecision("cost_usd"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  error: text("error"),
  skipReason: text("skip_reason"),
  compressed: boolean("compressed"),
  originalTokenEstimate: integer("original_token_estimate"),
  compressedTokenEstimate: integer("compressed_token_estimate"),
  promptTokenEstimate: integer("prompt_token_estimate"),
  diffFileCount: integer("diff_file_count"),
  changedFileCount: integer("changed_file_count"),
  problemCount: integer("problem_count").notNull().default(0),
  summaryCount: integer("summary_count").notNull().default(0),
  dispatchCount: integer("dispatch_count").notNull().default(0),
  durationMs: integer("duration_ms"),
  targetKind: text("target_kind"),
  targetUrl: text("target_url"),
  branch: text("branch"),
  headSha: text("head_sha"),
  vcsKind: text("vcs_kind"),
  headCommittedAt: epochMs("head_committed_at"),
});

export const codeMetrics = pgTable("code_metrics", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  runId: text("run_id")
    .notNull()
    .references(() => reviewRuns.id, { onDelete: "cascade" }),
  filesChanged: integer("files_changed").notNull().default(0),
  linesAdded: integer("lines_added").notNull().default(0),
  linesDeleted: integer("lines_deleted").notNull().default(0),
  bytesAnalyzed: integer("bytes_analyzed").notNull().default(0),
  filesAnalyzed: integer("files_analyzed").notNull().default(0),
});

export const llmUsage = pgTable("llm_usage", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  runId: text("run_id")
    .notNull()
    .references(() => reviewRuns.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  requestCount: integer("request_count").notNull().default(1),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  tokensTotal: integer("tokens_total").notNull().default(0),
  costUsd: doublePrecision("cost_usd"),
  retryCount: integer("retry_count").notNull().default(0),
  fallbackCount: integer("fallback_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  latencyMs: integer("latency_ms"),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
});

export const webhookEvents = pgTable("webhook_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  receivedAt: epochMs("received_at").notNull(),
  provider: text("provider"),
  eventName: text("event_name"),
  workspaceId: text("workspace_id"),
  triggerName: text("trigger_name"),
  repoRef: text("repo_ref"),
  targetKind: text("target_kind"),
  targetUrl: text("target_url"),
  branch: text("branch"),
  decision: text("decision").$type<WebhookEventDecision>().notNull(),
  reason: text("reason"),
  detail: text("detail"),
});

export const reviewDeferrals = pgTable("review_deferrals", {
  dedupKey: text("dedup_key").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  provider: text("provider").notNull(),
  eventName: text("event_name").notNull(),
  reviewEvent: text("review_event").notNull(),
  payload: text("payload"),
  notBefore: epochMs("not_before").notNull(),
  status: text("status").$type<ReviewDeferralStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: epochMs("created_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

export const outputEvents = pgTable("output_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  runId: text("run_id")
    .notNull()
    .references(() => reviewRuns.id, { onDelete: "cascade" }),
  channelKind: text("channel_kind").notNull(),
  eventType: text("event_type").notNull(),
  issueCreated: boolean("issue_created").notNull().default(false),
  commentCreated: boolean("comment_created").notNull().default(false),
  timestamp: epochMs("timestamp").notNull(),
});

export const dailyRollups = pgTable("daily_rollups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  reviewCount: integer("review_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  skipCount: integer("skip_count").notNull().default(0),
  problemRunCount: integer("problem_run_count").notNull().default(0),
  problemTotal: integer("problem_total").notNull().default(0),
  issueCreatedCount: integer("issue_created_count").notNull().default(0),
  filesChanged: integer("files_changed").notNull().default(0),
  linesAdded: integer("lines_added").notNull().default(0),
  linesDeleted: integer("lines_deleted").notNull().default(0),
  bytesAnalyzed: integer("bytes_analyzed").notNull().default(0),
  llmRequestCount: integer("llm_request_count").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  tokensTotal: integer("tokens_total").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
  costUsd: doublePrecision("cost_usd"),
});

export const reflectionMemory = pgTable("reflection_memory", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: text("workspace_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  content: text("content").notNull(),
  sourceRunId: text("source_run_id"),
  createdAt: epochMs("created_at").notNull(),
  expiresAt: epochMs("expires_at"),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
});

export const modelCatalog = pgTable("model_catalog", {
  catalogId: text("catalog_id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  data: text("data").notNull(),
  source: text("source"),
  fetchedAt: epochMs("fetched_at").notNull(),
});

export const modelCatalogSource = pgTable("model_catalog_source", {
  sourceUrl: text("source_url").primaryKey(),
  lastRefreshedAt: epochMs("last_refreshed_at").notNull(),
  etag: text("etag"),
});

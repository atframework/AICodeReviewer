import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runStatusValues = [
  "queued",
  "preparing",
  "analyzing",
  "publishing",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "skipped",
] as const;

export type RunStatus = (typeof runStatusValues)[number];

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspaceId: text("workspace_id").notNull(),
  triggerName: text("trigger_name").notNull(),
  repoRef: text("repo_ref").notNull(),
  displayName: text("display_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
});

export const reviewRuns = sqliteTable("review_runs", {
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
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  costUsd: real("cost_usd"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  error: text("error"),
  skipReason: text("skip_reason"),
  compressed: integer("compressed", { mode: "boolean" }),
  originalTokenEstimate: integer("original_token_estimate"),
  compressedTokenEstimate: integer("compressed_token_estimate"),
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
});

export const codeMetrics = sqliteTable("code_metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id")
    .notNull()
    .references(() => reviewRuns.id, { onDelete: "cascade" }),
  filesChanged: integer("files_changed").notNull().default(0),
  linesAdded: integer("lines_added").notNull().default(0),
  linesDeleted: integer("lines_deleted").notNull().default(0),
  bytesAnalyzed: integer("bytes_analyzed").notNull().default(0),
  filesAnalyzed: integer("files_analyzed").notNull().default(0),
});

export const llmUsage = sqliteTable("llm_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id")
    .notNull()
    .references(() => reviewRuns.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  requestCount: integer("request_count").notNull().default(1),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  tokensTotal: integer("tokens_total").notNull().default(0),
  costUsd: real("cost_usd"),
  retryCount: integer("retry_count").notNull().default(0),
  fallbackCount: integer("fallback_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  latencyMs: integer("latency_ms"),
});

export const outputEvents = sqliteTable("output_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id")
    .notNull()
    .references(() => reviewRuns.id, { onDelete: "cascade" }),
  channelKind: text("channel_kind").notNull(),
  eventType: text("event_type").notNull(),
  issueCreated: integer("issue_created", { mode: "boolean" }).notNull().default(false),
  commentCreated: integer("comment_created", { mode: "boolean" }).notNull().default(false),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
});

export const dailyRollups = sqliteTable("daily_rollups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  costUsd: real("cost_usd"),
});

export const reflectionMemory = sqliteTable("reflection_memory", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspaceId: text("workspace_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  content: text("content").notNull(),
  sourceRunId: text("source_run_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
});

import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

/** In-flight (non-terminal) run statuses: the lifecycle marker view. */
export const ACTIVE_RUN_STATUSES = ["queued", "preparing", "analyzing", "publishing"] as const;

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
  historyPruned: integer("history_pruned", { mode: "boolean" }).notNull().default(false),
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
  reviewEventJson: text("review_event_json"),
  /** VCS family of the analyzed revision ("git" | "svn" | "p4"); drives revision formatting. */
  vcsKind: text("vcs_kind"),
  /** Commit time of the analyzed head revision, when the VCS adapter could resolve it. */
  headCommittedAt: integer("head_committed_at", { mode: "timestamp_ms" }),
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
  cachedTokens: integer("cached_tokens").notNull().default(0),
  cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
});

export const webhookEventDecisionValues = [
  "executed",
  "deferred",
  "queued",
  "timeout",
  "duplicate",
  "deduplicated",
  "ignored",
  "rejected",
] as const;

export type WebhookEventDecision = (typeof webhookEventDecisionValues)[number];

export const webhookEvents = sqliteTable("webhook_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
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

export const reviewDeferralStatusValues = ["pending", "claimed"] as const;

export type ReviewDeferralStatus = (typeof reviewDeferralStatusValues)[number];

export const reviewDeferrals = sqliteTable("review_deferrals", {
  dedupKey: text("dedup_key").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  provider: text("provider").notNull(),
  eventName: text("event_name").notNull(),
  reviewEvent: text("review_event").notNull(),
  payload: text("payload"),
  notBefore: integer("not_before", { mode: "timestamp_ms" }).notNull(),
  status: text("status").$type<ReviewDeferralStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  cachedTokens: integer("cached_tokens").notNull().default(0),
  cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
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
  occurrenceCount: integer("occurrence_count").notNull().default(1),
});

export const modelCatalog = sqliteTable("model_catalog", {
  catalogId: text("catalog_id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  data: text("data").notNull(),
  source: text("source"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});

export const modelCatalogSource = sqliteTable("model_catalog_source", {
  sourceUrl: text("source_url").primaryKey(),
  lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp_ms" }).notNull(),
  etag: text("etag"),
});


// ---------------------------------------------------------------------------
// IM tables (IM design §7.3, implementation spec §4). Physical layout lives in
// the 011_im_tables migration; these are the drizzle query-time views.
// ---------------------------------------------------------------------------

export const imInbox = sqliteTable("im_inbox", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  connectionIdentity: text("connection_identity").notNull(),
  deliveryKind: text("delivery_kind").notNull(),
  deliveryKey: text("delivery_key").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  digestVersion: integer("digest_version").notNull().default(1),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  status: text("status").notNull(),
  requestId: text("request_id"),
});

export const imReviewRequests = sqliteTable("im_review_requests", {
  requestId: text("request_id").primaryKey(),
  runId: text("run_id").notNull(),
  namespace: text("namespace").notNull(),
  bindingId: text("binding_id").notNull(),
  connectionIdentity: text("connection_identity").notNull(),
  requestedByType: text("requested_by_type").notNull(),
  requestedById: text("requested_by_id").notNull(),
  conversationJson: text("conversation_json").notNull(),
  workspaceId: text("workspace_id").notNull(),
  sourceTrigger: text("source_trigger").notNull(),
  repoRef: text("repo_ref").notNull(),
  requestedRevision: text("requested_revision").notNull(),
  resolvedRevision: text("resolved_revision"),
  baseRevision: text("base_revision"),
  configSnapshotId: text("config_snapshot_id").notNull(),
  configFileDigest: text("config_file_digest").notNull(),
  configVersionJson: text("config_version_json").notNull(),
  state: text("state").notNull(),
  attemptsByPhaseJson: text("attempts_by_phase_json").notNull().default('{}'),
  resumePhase: text("resume_phase"),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  leaseOwner: text("lease_owner"),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
  fence: integer("fence").notNull().default(0),
  dispatchSeq: integer("dispatch_seq").notNull().default(0),
  checkpointJson: text("checkpoint_json"),
  errorCode: text("error_code"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const imActiveTargets = sqliteTable("im_active_targets", {
  namespace: text("namespace").notNull(),
  workspaceInstance: text("workspace_instance").notNull(),
  sourceIdentity: text("source_identity").notNull(),
  revision: text("revision").notNull(),
  requestId: text("request_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey(table.namespace, table.workspaceInstance, table.sourceIdentity, table.revision),
]);

export const imActions = sqliteTable("im_actions", {
  actionId: text("action_id").primaryKey(),
  namespace: text("namespace").notNull(),
  connectionIdentity: text("connection_identity").notNull(),
  issuedConfigVersion: text("issued_config_version").notNull(),
  sourceMessageId: text("source_message_id"),
  sourceTaskId: text("source_task_id"),
  conversationJson: text("conversation_json"),
  recipientId: text("recipient_id"),
  bindingId: text("binding_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  sourceTrigger: text("source_trigger").notNull(),
  repoRef: text("repo_ref").notNull(),
  revision: text("revision").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedRequestId: text("consumed_request_id"),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const imConversations = sqliteTable("im_conversations", {
  namespace: text("namespace").notNull(),
  connectionIdentity: text("connection_identity").notNull(),
  conversationKind: text("conversation_kind").notNull(),
  /** Empty string normalizes direct conversations into the unique key. */
  conversationId: text("conversation_id").notNull().default(''),
  capabilitiesJson: text("capabilities_json"),
  discoveredAt: integer("discovered_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (table) => [
  primaryKey(table.namespace, table.connectionIdentity, table.conversationKind, table.conversationId),
]);

export const imReplyOutbox = sqliteTable("im_reply_outbox", {
  operationId: text("operation_id").primaryKey(),
  namespace: text("namespace").notNull(),
  requestId: text("request_id"),
  actionId: text("action_id"),
  destinationIdentity: text("destination_identity").notNull(),
  operationKind: text("operation_kind").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  state: text("state").notNull(),
  expiry: integer("expiry", { mode: "timestamp_ms" }),
  sealedReplyCredential: text("sealed_reply_credential"),
  compactReceipt: text("compact_receipt"),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  attempts: integer("attempts").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
  fence: integer("fence").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const imRateLimits = sqliteTable("im_rate_limits", {
  namespace: text("namespace").notNull(),
  bucketKey: text("bucket_key").notNull(),
  windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
  count: integer("count").notNull(),
}, (table) => [
  primaryKey(table.namespace, table.bucketKey, table.windowStart),
]);

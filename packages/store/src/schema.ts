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
] as const;

export type RunStatus = (typeof runStatusValues)[number];

export const reviewRuns = sqliteTable("review_runs", {
  id: text("id").primaryKey(),
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
});
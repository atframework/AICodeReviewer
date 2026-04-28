import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const reviewRuns = sqliteTable("review_runs", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull().default(1),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  costUsd: real("cost_usd"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  error: text("error"),
});
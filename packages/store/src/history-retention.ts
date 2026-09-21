import { historyCutoff, type HistoryRetention, type HistoryRetentionPolicy } from "@aicr/core";
import type { StoreDb } from "./database.js";

const policies = new WeakMap<StoreDb, () => HistoryRetention>();

/** Bootstrap supplies a live, unpinned view; standalone store callers can opt in. */
export function configureHistoryRetention(store: StoreDb, read: () => HistoryRetention): void {
  policies.set(store, read);
}

export function storeHistoryRetention(store: StoreDb): HistoryRetention | undefined {
  return policies.get(store)?.();
}

/**
 * Keep the accounting facts and primary key needed by aggregate statistics and
 * checkpoint deduplication. Irreversibly erase the display details, in bounded
 * chunks; the partial history index contains only retained rows.
 */
export async function pruneRecentRunHistory(store: StoreDb, policy?: HistoryRetentionPolicy, now = Date.now()): Promise<number> {
  policy ??= storeHistoryRetention(store)?.recent_runs;
  if (!policy) return 0;
  const cutoff = historyCutoff(policy, now);
  const visible = store.kind === "postgres" ? "false" : "0";
  const hidden = store.kind === "postgres" ? "true" : "1";
  const parameters = store.kind === "postgres" ? ["$1", "$2"] : ["?", "?"];
  const query = `WITH expired AS (
      SELECT id FROM review_runs WHERE history_pruned = ${visible} AND started_at < ${parameters[0]}
      ORDER BY started_at, id LIMIT 500
    ), overflow AS (
      SELECT id FROM review_runs WHERE history_pruned = ${visible}
      ORDER BY started_at DESC, id DESC LIMIT 500 OFFSET ${parameters[1]}
    ) UPDATE review_runs SET history_pruned = ${hidden}, event_id = '',
    error = NULL, skip_reason = NULL, target_url = NULL, target_kind = NULL,
    branch = NULL, head_sha = NULL, vcs_kind = NULL, head_committed_at = NULL
    WHERE history_pruned = ${visible} AND id IN (
      SELECT id FROM expired UNION SELECT id FROM overflow LIMIT 500
    )`;
  if (store.kind === "postgres") return (await store.pool.query(query, [cutoff, policy.max_count])).rowCount ?? 0;
  return store.sqlite.prepare(query).run(cutoff, policy.max_count).changes;
}

export async function pruneEventHistory(store: StoreDb, keep?: number, now = Date.now()): Promise<number> {
  const policy = storeHistoryRetention(store)?.events;
  const cutoff = policy ? historyCutoff(policy, now) : Number.MIN_SAFE_INTEGER;
  keep ??= policy?.max_count ?? 2000;
  const parameters = store.kind === "postgres" ? ["$1", "$2"] : ["?", "?"];
  const query = `WITH expired AS (
    SELECT id FROM webhook_events WHERE received_at < ${parameters[0]}
    ORDER BY received_at, id LIMIT 500
  ), overflow AS (
    SELECT id FROM webhook_events ORDER BY received_at DESC, id DESC LIMIT 500 OFFSET ${parameters[1]}
  ) DELETE FROM webhook_events WHERE id IN (
    SELECT id FROM expired UNION SELECT id FROM overflow LIMIT 500
  )`;
  if (store.kind === "postgres") return (await store.pool.query(query, [cutoff, keep])).rowCount ?? 0;
  return store.sqlite.prepare(query).run(cutoff, keep).changes;
}

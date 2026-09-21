import { historyCutoff, type AutoCommitStore, type HistoryRetention } from "@aicr/core";
import { configureHistoryRetention, pruneRecentRunHistory, pruneWebhookEvents, type StoreDb } from "@aicr/store";

/** One bounded sweep, shared by the timer and admin reads; drained before close. */
export function createHistoryMaintenance(options: {
  store?: StoreDb | undefined;
  batches: AutoCommitStore;
  policy: () => HistoryRetention;
}): { sweep: () => Promise<void>; stop: () => Promise<void> } {
  if (options.store) configureHistoryRetention(options.store, options.policy);
  let pending: Promise<void> | undefined;
  let stopped = false;
  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const policy = options.policy();
      const now = Date.now();
      if (options.store) {
        await pruneRecentRunHistory(options.store, policy.recent_runs, now);
        await pruneWebhookEvents(options.store, undefined, now);
      }
      await options.batches.pruneBatchHistory(policy.queue.max_count, historyCutoff(policy.queue, now));
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(() => {
    void sweep().catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", msg: "history retention sweep failed",
      error: error instanceof Error ? error.message : String(error) })));
  }, 60_000);
  timer.unref();
  return { sweep, async stop() {
    stopped = true;
    clearInterval(timer);
    // The sweep caller observes failures. Shutdown only needs settled IO;
    // failed cleanup must not prevent the queue/store resources from closing.
    await pending?.catch(() => {});
  } };
}

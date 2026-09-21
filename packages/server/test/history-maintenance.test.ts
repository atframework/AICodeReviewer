import { createMemoryAutoCommitStore, resolveHistoryRetention } from "@aicr/core";
import { describe, expect, it, vi } from "vitest";
import { createHistoryMaintenance } from "../src/history-maintenance.js";

describe("history maintenance lifecycle", () => {
  it.each([false, true])("coalesces sweeps and drains pending IO before stopping (failure=%s)", async fail => {
    vi.useFakeTimers();
    const batches = createMemoryAutoCommitStore();
    const pending = Promise.withResolvers<number>();
    const prune = vi.spyOn(batches, "pruneBatchHistory").mockReturnValue(pending.promise);
    const maintenance = createHistoryMaintenance({ batches, policy: () => resolveHistoryRetention() });
    try {
      const sweep = maintenance.sweep();
      const observed = sweep.catch(() => {});
      expect(maintenance.sweep()).toBe(sweep);
      let drained = false;
      const stopping = maintenance.stop().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(drained).toBe(false);
      if (fail) pending.reject(new Error("store unavailable"));
      else pending.resolve(0);
      await stopping;
      await observed;
      await maintenance.sweep();
      expect(drained).toBe(true);
      expect(prune).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(0);
      await maintenance.stop();
      vi.useRealTimers();
    }
  });
});

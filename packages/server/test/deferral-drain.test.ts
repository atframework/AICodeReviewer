import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReviewEvent } from "@aicr/core";
import { closeStoreDb, createStoreDb, listPendingReviewDeferrals } from "@aicr/store";
import { expect, it, vi } from "vitest";
import { ReviewDeferralManager } from "../src/deferral-manager.js";

it("persists accepted work during drain without waking it, then resumes once after reopening", async () => {
  const root = resolve("build/tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "deferral-drain-"));
  const path = join(dir, "store.sqlite");
  let store = createStoreDb(path);
  const manager = new ReviewDeferralManager({ store });
  let recovered: ReviewDeferralManager | undefined;
  const resume = vi.fn();
  manager.resumeHandler = resume;
  vi.useFakeTimers();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const target = {
    provider: "gitea" as const, eventName: "pull_request", decoded: { head: "accepted-head" },
    configSnapshotId: "accepted-config",
    reviewEvent: createReviewEvent({ provider: "gitea", triggerName: "git", workspaceId: "ws",
      targetKind: "pull_request", repoRef: "owner/repo", branch: "topic", reason: "opened", author: {} }),
  };
  try {
    manager.stop();
    const persisted = manager.defer(target, Date.now() + 1000, true);
    await manager.drain();
    await persisted;
    await vi.advanceTimersByTimeAsync(2000);
    expect(resume).not.toHaveBeenCalled();
    expect(await listPendingReviewDeferrals(store)).toHaveLength(1);
    await closeStoreDb(store);
    store = createStoreDb(path);
    recovered = new ReviewDeferralManager({ store });
    recovered.resumeHandler = resume;
    await recovered.recover();
    await vi.advanceTimersByTimeAsync(1);
    await recovered.drain();
    expect(resume).toHaveBeenCalledExactlyOnceWith(target);
    expect(await listPendingReviewDeferrals(store)).toEqual([]);
  } finally {
    await manager.drain();
    await recovered?.drain();
    await closeStoreDb(store);
    info.mockRestore();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});

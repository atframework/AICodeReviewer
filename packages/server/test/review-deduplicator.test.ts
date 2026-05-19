import { describe, it, expect } from "vitest";

import { createReviewDeduplicator } from "../src/review-deduplicator.js";
import type { ReviewEvent } from "@aicr/core";

function makeReviewEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    triggerName: "test-trigger",
    provider: "github",
    workspaceId: "test-workspace",
    targetKind: "pull_request",
    repoRef: "owner/repo",
    reason: "test",
    ...overrides,
  } as ReviewEvent;
}

describe("createReviewDeduplicator", () => {
  it("allows scheduling when no review is running", () => {
    const dedup = createReviewDeduplicator();
    const event = makeReviewEvent();

    expect(dedup.trySchedule(event)).toBe(true);
    expect(dedup.isRunning(event)).toBe(true);
  });

  it("deduplicates when same target is already running", () => {
    const dedup = createReviewDeduplicator();
    const event1 = makeReviewEvent({ branch: "feature-branch", headSha: "abc123" });
    const event2 = makeReviewEvent({ branch: "feature-branch", headSha: "def456" });

    expect(dedup.trySchedule(event1)).toBe(true);
    expect(dedup.trySchedule(event2)).toBe(false);
    expect(dedup.isRunning(event2)).toBe(true);
  });

  it("allows concurrent reviews for different targets", () => {
    const dedup = createReviewDeduplicator();
    const event1 = makeReviewEvent({ repoRef: "owner/repo-a", headSha: "abc" });
    const event2 = makeReviewEvent({ repoRef: "owner/repo-b", headSha: "def" });

    expect(dedup.trySchedule(event1)).toBe(true);
    expect(dedup.trySchedule(event2)).toBe(true);
    expect(dedup.isRunning(event1)).toBe(true);
    expect(dedup.isRunning(event2)).toBe(true);
  });

  it("returns pending target on completion and removes running state", () => {
    const dedup = createReviewDeduplicator();
    const runningEvent = makeReviewEvent({ branch: "feature", headSha: "abc" });
    const pendingEvent = makeReviewEvent({ branch: "feature", headSha: "def" });

    dedup.trySchedule(runningEvent);
    dedup.setPending({
      provider: "github",
      eventName: "issue_comment",
      decoded: {},
      reviewEvent: pendingEvent,
    });

    const pending = dedup.markCompleted(runningEvent);
    expect(pending).not.toBeUndefined();
    expect(pending?.reviewEvent.headSha).toBe("def");
    expect(dedup.isRunning(runningEvent)).toBe(false);
  });

  it("overwrites pending target when set multiple times", () => {
    const dedup = createReviewDeduplicator();
    const runningEvent = makeReviewEvent({ branch: "feature", headSha: "abc" });
    const pendingEvent1 = makeReviewEvent({ branch: "feature", headSha: "def" });
    const pendingEvent2 = makeReviewEvent({ branch: "feature", headSha: "ghi" });

    dedup.trySchedule(runningEvent);
    dedup.setPending({
      provider: "github",
      eventName: "issue_comment",
      decoded: {},
      reviewEvent: pendingEvent1,
    });
    dedup.setPending({
      provider: "github",
      eventName: "issue_comment",
      decoded: {},
      reviewEvent: pendingEvent2,
    });

    const pending = dedup.markCompleted(runningEvent);
    expect(pending?.reviewEvent.headSha).toBe("ghi");
  });

  it("returns undefined on completion when no pending target exists", () => {
    const dedup = createReviewDeduplicator();
    const event = makeReviewEvent({ headSha: "abc" });

    dedup.trySchedule(event);
    const pending = dedup.markCompleted(event);

    expect(pending).toBeUndefined();
    expect(dedup.isRunning(event)).toBe(false);
  });

  it("uses provider, repoRef, targetKind, and branch in dedup key", () => {
    const dedup = createReviewDeduplicator();
    const event1 = makeReviewEvent({
      provider: "github",
      repoRef: "owner/repo",
      targetKind: "pull_request",
      branch: "feature-a",
      headSha: "head1",
    });
    const event2 = makeReviewEvent({
      provider: "github",
      repoRef: "owner/repo",
      targetKind: "pull_request",
      branch: "feature-b",
      headSha: "head2",
    });

    expect(dedup.trySchedule(event1)).toBe(true);
    expect(dedup.trySchedule(event2)).toBe(true);
    expect(dedup.isRunning(event1)).toBe(true);
    expect(dedup.isRunning(event2)).toBe(true);
  });

  it("prioritizes branch over changing URLs and SHAs", () => {
    const dedup = createReviewDeduplicator();
    const event1 = makeReviewEvent({
      branch: "feature-a",
      url: "https://github.example/owner/repo/pull/1",
      headSha: "head-1",
    });
    const event2 = makeReviewEvent({
      branch: "feature-a",
      url: "https://github.example/owner/repo/pull/1#discussion_r2",
      headSha: "head-2",
    });

    expect(dedup.trySchedule(event1)).toBe(true);
    expect(dedup.trySchedule(event2)).toBe(false);
  });

  it("uses URL as a fallback identity before SHA for comment-triggered reviews", () => {
    const dedup = createReviewDeduplicator();
    const event1 = makeReviewEvent({
      reason: "github:comment_review",
      url: "https://api.github.com/repos/owner/repo/pulls/1",
    });
    const event2 = makeReviewEvent({
      reason: "github:comment_review",
      url: "https://api.github.com/repos/owner/repo/pulls/2",
    });
    const event3 = makeReviewEvent({
      reason: "github:comment_review",
      url: "https://api.github.com/repos/owner/repo/pulls/1",
    });

    expect(dedup.trySchedule(event1)).toBe(true);
    expect(dedup.trySchedule(event2)).toBe(true);
    expect(dedup.trySchedule(event3)).toBe(false);
  });

  it("isolates same repo and branch across triggers and workspaces", () => {
    const dedup = createReviewDeduplicator();
    const event1 = makeReviewEvent({
      triggerName: "github-core",
      workspaceId: "core-workspace",
      branch: "feature-a",
    });
    const event2 = makeReviewEvent({
      triggerName: "github-partner",
      workspaceId: "partner-workspace",
      branch: "feature-a",
    });

    expect(dedup.trySchedule(event1)).toBe(true);
    expect(dedup.trySchedule(event2)).toBe(true);
  });

  it("treats different repoRefs as different targets", () => {
    const dedup = createReviewDeduplicator();
    const event1 = makeReviewEvent({ repoRef: "owner/repo-a", headSha: "abc" });
    const event2 = makeReviewEvent({ repoRef: "owner/repo-b", headSha: "abc" });

    expect(dedup.trySchedule(event1)).toBe(true);
    expect(dedup.trySchedule(event2)).toBe(true);
  });
});

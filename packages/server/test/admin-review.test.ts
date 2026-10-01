import { describe, expect, it } from "vitest";
import type { ImQueryRun } from "@aicr/store";
import { adminReReviewEvent } from "../src/admin-review.js";

const event = { provider: "gitlab", workspaceId: "ws", triggerName: "git", targetKind: "pull_request",
  repoRef: "org/service", sourceRepoRef: "fork/service", targetRepoRef: "org/service",
  baseSha: "base", headSha: "head", branch: "feature", targetBranch: "main",
  url: "https://git.example/org/service/-/merge_requests/42", title: "Fix", author: { username: "dev" }, reason: "webhook" };
const row = { workspaceId: "ws", triggerName: "git", repoRef: "org/service", headSha: "head", branch: "feature",
  targetKind: "pull_request", targetUrl: event.url, reviewEventJson: JSON.stringify(event) } as ImQueryRun;

describe("admin re-review target", () => {
  it("preserves the original PR/MR range, fork identity and target branch", () => {
    expect(adminReReviewEvent(row, "gitlab")).toMatchObject({ ...event, reason: "admin:rereview" });
  });
  it("rejects missing or corrupt historical event data instead of reviewing another range", () => {
    expect(adminReReviewEvent({ ...row, reviewEventJson: null }, "gitlab")).toBeUndefined();
    expect(() => adminReReviewEvent({ ...row, reviewEventJson: JSON.stringify({ ...event, repoRef: "other/repo" }) }, "gitlab"))
      .toThrow("identity");
    expect(() => adminReReviewEvent({ ...row, reviewEventJson: "broken" }, "gitlab")).toThrow();
  });
  it("preserves commit ranges and refuses to guess a historical head-only range", () => {
    expect(adminReReviewEvent({ ...row, targetKind: "commit", reviewEventJson: null }, "gitlab"))
      .toBeUndefined();
    expect(adminReReviewEvent({ ...row, targetKind: "commit", reviewEventJson: JSON.stringify({ ...event, targetKind: "commit" }) }, "gitlab"))
      .toMatchObject({ targetKind: "commit", baseSha: "base", headSha: "head", reason: "admin:rereview" });
    expect(() => adminReReviewEvent(row, "github")).toThrow("identity");
  });
});

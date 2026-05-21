import { describe, expect, it } from "vitest";

import {
  outputsPackageName,
  getHighestSeverity,
  renderProblemMarkdown,
  createGiteaPullRequestReviewDispatcher,
  createGithubPullRequestReviewDispatcher,
  createGithubIssueDispatcher,
  createGithubProblemIssueDispatcher,
  createGitlabMergeRequestReviewDispatcher,
  createGiteaIssueDispatcher,
  createGiteaProblemIssueDispatcher,
  createFeishuBotDispatcher,
  createWeComBotDispatcher,
  OutputDispatchError,
  computeScopeFingerprint,
  parseOwnersContent,
  matchOwnersForFile,
} from "../src/index.js";

describe("@aicr/outputs", () => {
  it("exports the package name", () => {
    expect(outputsPackageName).toBe("@aicr/outputs");
  });

  it("exports getHighestSeverity", () => {
    expect(getHighestSeverity).toBeDefined();
  });

  it("exports renderProblemMarkdown", () => {
    expect(renderProblemMarkdown).toBeDefined();
  });

  it("exports dispatch creators", () => {
    expect(createGiteaPullRequestReviewDispatcher).toBeDefined();
    expect(createGithubPullRequestReviewDispatcher).toBeDefined();
    expect(createGithubIssueDispatcher).toBeDefined();
    expect(createGithubProblemIssueDispatcher).toBeDefined();
    expect(createGitlabMergeRequestReviewDispatcher).toBeDefined();
    expect(createGiteaIssueDispatcher).toBeDefined();
    expect(createGiteaProblemIssueDispatcher).toBeDefined();
    expect(createFeishuBotDispatcher).toBeDefined();
    expect(createWeComBotDispatcher).toBeDefined();
  });

  it("exports OutputDispatchError", () => {
    expect(OutputDispatchError).toBeDefined();
  });

  it("exports utility functions", () => {
    expect(computeScopeFingerprint).toBeDefined();
    expect(parseOwnersContent).toBeDefined();
    expect(matchOwnersForFile).toBeDefined();
  });
});

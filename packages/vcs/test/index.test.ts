import { describe, expect, it } from "vitest";

import {
  vcsPackageName,
  parseUnifiedDiff,
  changedFilesFromDiff,
  createGitVcsAdapter,
  createP4VcsAdapter,
  createSvnVcsAdapter,
} from "../src/index.js";

describe("@aicr/vcs", () => {
  it("exports the package name", () => {
    expect(vcsPackageName).toBe("@aicr/vcs");
  });

  it("exports diff utilities", () => {
    expect(parseUnifiedDiff).toBeDefined();
    expect(changedFilesFromDiff).toBeDefined();
  });

  it("exports VCS adapter creators", () => {
    expect(createGitVcsAdapter).toBeDefined();
    expect(createP4VcsAdapter).toBeDefined();
    expect(createSvnVcsAdapter).toBeDefined();
  });
});

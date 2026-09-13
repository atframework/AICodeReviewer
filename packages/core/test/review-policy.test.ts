/**
 * Review path policy tests (P4/H05): include/exclude/max_files applied to
 * changed paths with the repository path glob semantics.
 */
import { describe, expect, it } from "vitest";

import { applyReviewPathPolicy } from "../src/review-policy.js";

describe("applyReviewPathPolicy", () => {
  it("keeps every path when no policy fields are set", () => {
    const result = applyReviewPathPolicy(["a.ts", "b/c.ts"], {});
    expect(result.paths).toEqual(["a.ts", "b/c.ts"]);
    expect(result.excluded).toEqual([]);
    expect(result.truncated).toEqual([]);
  });

  it("default include matches everything (schema default equivalent)", () => {
    const result = applyReviewPathPolicy(["src/x.ts"], { include: ["**/*"] });
    expect(result.paths).toEqual(["src/x.ts"]);
  });

  it("include narrows to matching paths only", () => {
    const result = applyReviewPathPolicy(
      ["src/a.ts", "docs/readme.md", "deep/nested/module.ts"],
      { include: ["src/*"] },
    );
    // One star selects immediate children only.
    expect(result.paths).toEqual(["src/a.ts"]);
    expect(result.excluded).toEqual(["docs/readme.md", "deep/nested/module.ts"]);
  });

  it("exclude removes matching paths after include", () => {
    const result = applyReviewPathPolicy(
      ["src/a.ts", "src/vendor/lib.ts", "src/a.min.js"],
      { exclude: ["**/vendor/**", "**/*.min.js"] },
    );
    expect(result.paths).toEqual(["src/a.ts"]);
    expect(result.excluded).toEqual(["src/vendor/lib.ts", "src/a.min.js"]);
  });

  it("max_files truncates in VCS order and reports the tail separately", () => {
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];
    const result = applyReviewPathPolicy(paths, { max_files: 2 });
    expect(result.paths).toEqual(["a.ts", "b.ts"]);
    expect(result.excluded).toEqual([]);
    expect(result.truncated).toEqual(["c.ts", "d.ts"]);
  });

  it("max_files equal to the count keeps everything", () => {
    const result = applyReviewPathPolicy(["a.ts", "b.ts"], { max_files: 2 });
    expect(result.paths).toEqual(["a.ts", "b.ts"]);
    expect(result.truncated).toEqual([]);
  });

  it("max_files zero drops every path but keeps them visible as truncated", () => {
    const result = applyReviewPathPolicy(["a.ts"], { max_files: 0 });
    expect(result.paths).toEqual([]);
    expect(result.truncated).toEqual(["a.ts"]);
  });

  it("combined policy: exclude first, then the cap counts survivors only", () => {
    const result = applyReviewPathPolicy(
      ["a.ts", "vendor/x.ts", "b.ts", "c.ts"],
      { exclude: ["vendor/**"], max_files: 2 },
    );
    expect(result.paths).toEqual(["a.ts", "b.ts"]);
    expect(result.excluded).toEqual(["vendor/x.ts"]);
    expect(result.truncated).toEqual(["c.ts"]);
  });

  it("empty path list is a no-op", () => {
    const result = applyReviewPathPolicy([], { include: ["src/*"], exclude: ["x"], max_files: 5 });
    expect(result.paths).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.truncated).toEqual([]);
  });

  it("keeps root files and distinguishes vendor directories from similar names", () => {
    const result = applyReviewPathPolicy(["root.ts", "src/a.ts", "vendor/x.ts", "src/vendor/x.ts", "src/vendorAdapter.ts"],
      { include: ["**/*"], exclude: ["**/vendor/**"] });
    expect(result.paths).toEqual(["root.ts", "src/a.ts", "src/vendorAdapter.ts"]);
    expect(result.excluded).toEqual(["vendor/x.ts", "src/vendor/x.ts"]);
  });

  it("single star does not include nested directories and Windows paths normalize", () => {
    expect(applyReviewPathPolicy(["src/a.ts", "src/deep/b.ts", "src\\c.ts"], { include: ["src/*.ts"] }).paths)
      .toEqual(["src/a.ts", "src\\c.ts"]);
  });
});

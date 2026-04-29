import { describe, expect, it } from "vitest";

import { changedFilesFromDiff, parseUnifiedDiff } from "../src/diff.js";

describe("parseUnifiedDiff", () => {
  it("parses modified file hunks with old and new line numbers", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,4 @@ export function main()",
        " context",
        "-old line",
        "+new line",
        "+another new line",
      ].join("\n"),
    );

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.status).toBe("modified");
    expect(diff.files[0]?.oldPath).toBe("src/app.ts");
    expect(diff.files[0]?.newPath).toBe("src/app.ts");
    expect(diff.files[0]?.hunks[0]?.section).toBe("export function main()");
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { kind: "context", content: "context", oldLine: 1, newLine: 1 },
      { kind: "delete", content: "old line", oldLine: 2 },
      { kind: "add", content: "new line", newLine: 2 },
      { kind: "add", content: "another new line", newLine: 3 },
    ]);
  });

  it("detects added and deleted files from /dev/null headers", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "+export const value = 1;",
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const old = true;",
      ].join("\n"),
    );

    expect(diff.files.map((file) => file.status)).toEqual(["added", "deleted"]);
    expect(diff.files[0]?.newPath).toBe("new.ts");
    expect(diff.files[0]?.oldPath).toBeUndefined();
    expect(diff.files[1]?.oldPath).toBe("old.ts");
    expect(diff.files[1]?.newPath).toBeUndefined();
  });

  it("detects rename headers and returns unique changed files", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 95%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        "@@ -1 +1 @@",
        "-oldName();",
        "+newName();",
      ].join("\n"),
    );

    expect(diff.files[0]?.status).toBe("renamed");
    expect(diff.files[0]?.oldPath).toBe("src/old.ts");
    expect(diff.files[0]?.newPath).toBe("src/new.ts");
    expect(changedFilesFromDiff(diff)).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("records no-newline markers without advancing line counters", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ].join("\n"),
    );

    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { kind: "delete", content: "old", oldLine: 1 },
      { kind: "no_newline", content: "\\ No newline at end of file" },
      { kind: "add", content: "new", newLine: 1 },
      { kind: "no_newline", content: "\\ No newline at end of file" },
    ]);
  });

  it("detects copied files from copy headers", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/src/orig.ts b/src/copy.ts",
        "similarity index 100%",
        "copy from src/orig.ts",
        "copy to src/copy.ts",
        "--- a/src/orig.ts",
        "+++ b/src/copy.ts",
        "@@ -1 +1 @@",
        "-origContent();",
        "+copiedContent();",
      ].join("\n"),
    );

    expect(diff.files[0]?.status).toBe("copied");
    expect(diff.files[0]?.oldPath).toBe("src/orig.ts");
    expect(diff.files[0]?.newPath).toBe("src/copy.ts");
  });

  it("parses a plain diff without diff --git prefix", () => {
    const diff = parseUnifiedDiff(
      [
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1,2 +1,3 @@",
        " line1",
        "-removed",
        "+added",
        "+extra",
      ].join("\n"),
    );

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.oldPath).toBe("old.ts");
    expect(diff.files[0]?.newPath).toBe("new.ts");
    expect(diff.files[0]?.hunks[0]?.lines).toHaveLength(4);
  });

  it("handles CRLF line endings in the diff", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\r\n"),
    );

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { kind: "delete", content: "old", oldLine: 1 },
      { kind: "add", content: "new", newLine: 1 },
    ]);
  });

  it("returns empty files for an empty diff", () => {
    const diff = parseUnifiedDiff("");

    expect(diff.files).toEqual([]);
  });

  it("handles quoted paths with special characters", () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git "a/src/space file.ts" "b/src/space file.ts"',
        "--- a/src/space file.ts",
        "+++ b/src/space file.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.newPath).toBe("src/space file.ts");
  });

  it("handles hunk headers without comma counts (defaults to 1)", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -5 +5,2 @@",
        " ctx",
        "+added",
      ].join("\n"),
    );

    expect(diff.files[0]?.hunks[0]?.oldLines).toBe(1);
    expect(diff.files[0]?.hunks[0]?.newLines).toBe(2);
  });

  it("deduces added status from /dev/null old path", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/brand-new.ts b/brand-new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/brand-new.ts",
        "@@ -0,0 +1,2 @@",
        "+line1();",
        "+line2();",
      ].join("\n"),
    );

    expect(diff.files[0]?.status).toBe("added");
    expect(diff.files[0]?.oldPath).toBeUndefined();
    expect(diff.files[0]?.newPath).toBe("brand-new.ts");
  });

  it("returns multiple files in order", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/c.ts b/c.ts",
        "--- a/c.ts",
        "+++ b/c.ts",
        "@@ -1 +1 @@",
        "-c",
        "+d",
      ].join("\n"),
    );

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]?.oldPath).toBe("a.ts");
    expect(diff.files[1]?.oldPath).toBe("c.ts");
  });

  it("parses multiple files with different statuses in a single diff", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/added.ts b/added.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1 @@",
        "+new content",
        "diff --git a/modified.ts b/modified.ts",
        "--- a/modified.ts",
        "+++ b/modified.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/deleted.ts b/deleted.ts",
        "deleted file mode 100644",
        "--- a/deleted.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-removed",
      ].join("\n"),
    );

    expect(diff.files).toHaveLength(3);
    expect(diff.files[0]?.status).toBe("added");
    expect(diff.files[1]?.status).toBe("modified");
    expect(diff.files[2]?.status).toBe("deleted");
  });

  it("handles a diff with only context lines and no changes", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/unchanged.ts b/unchanged.ts",
        "--- a/unchanged.ts",
        "+++ b/unchanged.ts",
        "@@ -1,3 +1,3 @@",
        " line1",
        " line2",
        " line3",
      ].join("\n"),
    );

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.status).toBe("modified");
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { kind: "context", content: "line1", oldLine: 1, newLine: 1 },
      { kind: "context", content: "line2", oldLine: 2, newLine: 2 },
      { kind: "context", content: "line3", oldLine: 3, newLine: 3 },
    ]);
  });

  it("infers added status from /dev/null without new file mode header", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/x.ts b/x.ts",
        "--- /dev/null",
        "+++ b/x.ts",
        "@@ -0,0 +1 @@",
        "+only",
      ].join("\n"),
    );

    expect(diff.files[0]?.status).toBe("added");
    expect(diff.files[0]?.oldPath).toBeUndefined();
    expect(diff.files[0]?.newPath).toBe("x.ts");
  });

  it("infers deleted status from /dev/null without deleted file mode header", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/y.ts b/y.ts",
        "--- a/y.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-only",
      ].join("\n"),
    );

    expect(diff.files[0]?.status).toBe("deleted");
    expect(diff.files[0]?.oldPath).toBe("y.ts");
    expect(diff.files[0]?.newPath).toBeUndefined();
  });

  it("falls back to literal slice when a quoted path is not valid JSON", () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git "a/bad\\path.ts" "b/bad\\path.ts"',
        "--- a/ignored.ts",
        "+++ b/ignored.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );

    // The diff --git header path is malformed JSON ("\\p" is invalid escape);
    // parser should fall back to stripping quotes literally rather than throwing.
    expect(diff.files).toHaveLength(1);
  });

  it("returns unique changed files even when oldPath equals newPath", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/same.ts b/same.ts",
        "--- a/same.ts",
        "+++ b/same.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );

    expect(changedFilesFromDiff(diff)).toEqual(["same.ts"]);
  });

  it("handles a file with no hunks", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/mode-change.ts b/mode-change.ts",
        "old mode 100644",
        "new mode 100755",
      ].join("\n"),
    );

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.hunks).toEqual([]);
    expect(diff.files[0]?.rawHeaders).toContain("old mode 100644");
  });
});

describe("changedFilesFromDiff", () => {
  it("deduplicates paths from renamed files", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/old.ts b/new.ts",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );

    const files = changedFilesFromDiff(diff);
    expect(files).toHaveLength(2);
    expect(files).toContain("old.ts");
    expect(files).toContain("new.ts");
  });

  it("returns empty array for empty diff", () => {
    expect(changedFilesFromDiff({ files: [] })).toEqual([]);
  });
});

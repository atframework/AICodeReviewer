import { describe, expect, it } from "vitest";
import { createReviewEvent } from "@aicr/core";

import { P4VcsAdapter, type P4CommandResult, type P4CommandRunner } from "../src/p4.js";

/**
 * Batch net-diff tests (design §6.5/G03). Every multi-line fixture below is
 * a byte-accurate capture from a real p4d 2025.1 server (evidence:
 * build/logs/auto-commit/p4-fixtures/, history CL1-CL7 with add/edit/
 * delete/move/binary cases). Documented-but-wrong assumptions the captures
 * correct:
 * - `path@=N` is rejected ("A revision range cannot be used here"); the
 *   state-as-of-CL syntax is `path@N`.
 * - Default (non-`-u`) output enumerates ALL pairs with `====` headers;
 *   `-u` omits add/delete/binary pairs entirely, so the enumeration pass is
 *   authoritative for the file set and `-u` only supplies content hunks.
 * - Add/delete entries get their hunk synthesized from `p4 print` of the
 *   surviving endpoint (design §6: 按已核验动作和端点内容转换); binary
 *   payloads (NUL probe) and empty files stay hunkless.
 * - A delete header closes with `===` (three equals), not `====`.
 * - `identical` pairs (same revision at both endpoints) are not changes.
 */

// p4 diff2 //depot/...@1 //depot/...@3 — add + two content pairs.
const diff2Range1to3 = `==== <none> - //depot/bin.dat#1 ====
==== //depot/src/a.txt#1 (text) - //depot/src/a.txt#2 (text) ==== content
1c1
< alpha v1
---
> alpha v2
2a3
> extra a2
==== //depot/src/b.txt#1 (text) - //depot/src/b.txt#2 (text) ==== content
1c1,2
< beta v1
---
> beta v2
> new beta line
`;

// p4 diff2 -u //depot/...@1 //depot/...@3 — only the content pairs appear.
const diff2Unified1to3 = `--- //depot/src/a.txt\t2026-09-09 10:42:40.000000000 0800
+++ //depot/src/a.txt\t2026-09-09 10:42:40.000000000 0800
@@ -1,2 +1,3 @@
-alpha v1
+alpha v2
 shared line
+extra a2
--- //depot/src/b.txt\t2026-09-09 10:42:40.000000000 0800
+++ //depot/src/b.txt\t2026-09-09 10:42:40.000000000 0800
@@ -1,1 +1,2 @@
-beta v1
+beta v2
+new beta line
`;

// p4 diff2 //depot/...@1 //depot/...@5 — adds + deletes only; a move shows
// as delete+add. Note the three-equals closer on the delete headers.
const diff2Range1to5 = `==== <none> - //depot/bin.dat#1 ====
==== //depot/src/a.txt#1 - <none> ===
==== //depot/src/b.txt#1 - <none> ===
==== <none> - //depot/src/renamed/a.txt#1 ====
`;

// p4 diff2 //depot/...@5 //depot/...@7 — binary content pair, one add, and
// an identical pair that must not surface as a change.
const diff2Range5to7 = `==== //depot/bin.dat#1 (binary) - //depot/bin.dat#2 (binary) ==== content
(... files differ ...)
==== <none> - //depot/docs/b.md#1 ====
==== //depot/src/renamed/a.txt#1 (text) - //depot/src/renamed/a.txt#1 (text) ==== identical
`;
// p4 diff2 //depot/...@5 //depot/...@8 — binary content pair, one add, one
// text content pair (ed-script payload).
const diff2Range5to8 = `==== //depot/bin.dat#1 (binary) - //depot/bin.dat#2 (binary) ==== content
(... files differ ...)
==== <none> - //depot/docs/b.md#1 ====
==== //depot/src/renamed/a.txt#1 (text) - //depot/src/renamed/a.txt#2 (text) ==== content
1c1
< alpha v2
---
> alpha v3
`;

// p4 diff2 -u //depot/...@5 //depot/...@8 — the binary pair degrades to a
// bare line before the text block; the add never appears.
const diff2Unified5to8 = `Binary files //depot/bin.dat#1 and //depot/bin.dat#2 differ
--- //depot/src/renamed/a.txt\t2026-09-09 10:44:54.000000000 0800
+++ //depot/src/renamed/a.txt\t2026-09-09 11:10:22.000000000 0800
@@ -1,3 +1,3 @@
-alpha v2
+alpha v3
 shared line
 extra a2
`;
// p4 diff2 -u //depot/...@5 //depot/...@7 — binary pairs degrade to a bare
// line outside any ---/+++ block.
const diff2Unified5to7 = `Binary files //depot/bin.dat#1 and //depot/bin.dat#2 differ
`;

// p4 diff2 //depot/...@0 //depot/...@5 — a file added and deleted inside
// the range nets to nothing (never existed before, absent after).
const diff2Range0to5 = `==== <none> - //depot/bin.dat#1 ====
==== <none> - //depot/src/renamed/a.txt#1 ====
`;

// p4 describe -du 3 — real single-CL output: adds have no Differences
// block; text edits show `==== path#rev (type) ====` + bare @@ hunks.
const describeDu3 = `Change 3 by alice@ws-main on 2026/09/09 18:42:40

	A3 binary+edit b

Affected files ...

... //depot/bin.dat#1 add
... //depot/src/b.txt#2 edit

Differences ...

==== //depot/src/b.txt#2 (text) ====

@@ -1,1 +1,2 @@
-beta v1
+beta v2
+new beta line
`;
function createRunner(handlers: {
  diff2?: (args: readonly string[]) => P4CommandResult;
  describe?: (args: readonly string[]) => P4CommandResult;
  print?: (args: readonly string[]) => P4CommandResult;
}): { p4: P4CommandRunner; callLog: string[] } {
  const callLog: string[] = [];
  const p4: P4CommandRunner = async (args) => {
    callLog.push(args.join(" "));
    if (args.includes("diff2") && handlers.diff2) {
      return handlers.diff2(args);
    }
    if (args.includes("describe") && handlers.describe) {
      return handlers.describe(args);
    }
    if (args.includes("print") && handlers.print) {
      return handlers.print(args);
    }
    return { stdout: "", stderr: "" };
  };
  return { p4, callLog };
}

function makeAdapter(p4: P4CommandRunner, depot = "//depot"): P4VcsAdapter {
  return new P4VcsAdapter({ repositoryDir: "/tmp/test", depot, p4 });
}

describe("P4VcsAdapter batch net diff (diff2)", () => {
  it("diffs endpoint states with enumeration pass plus -u pass for content pairs", async () => {
    const { p4, callLog } = createRunner({
      diff2: (args) => args.includes("-u")
        ? { stdout: diff2Unified1to3, stderr: "" }
        : { stdout: diff2Range1to3, stderr: "" },
      print: () => ({ stdout: "PK\0\u0003\u0004binary-bytes", stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const result = await adapter.diff({
      baseRevision: "1",
      headRevision: "3",
      files: ["src/a.txt", "src/b.txt", "bin.dat"],
    });

    // Compact enumeration, then one -u per selected text pair and one endpoint
    // print per add/delete pair; never describe, never a whole-server //...
    // scan, and never the rejected @=N form.
    expect(callLog).toEqual([
      "diff2 -Od -q //depot/...@1 //depot/...@3",
      "print -q //depot/bin.dat@3",
      "diff2 -u //depot/src/a.txt@1 //depot/src/a.txt@3",
      "diff2 -u //depot/src/b.txt@1 //depot/src/b.txt@3",
    ]);
    expect(callLog.every((call) => !call.includes("@="))).toBe(true);

    const byPath = new Map(result.files.map((file) => [file.newPath ?? file.oldPath, file]));
    expect([...byPath.keys()].sort()).toEqual(["bin.dat", "src/a.txt", "src/b.txt"]);

    const modified = byPath.get("src/a.txt");
    expect(modified?.status).toBe("modified");
    expect(modified?.hunks).toHaveLength(1);
    expect(modified?.hunks[0]?.lines.map((line) => line.kind)).toEqual(
      expect.arrayContaining(["delete", "add", "context"]),
    );
    expect(modified?.hunks[0]?.lines.some((line) => line.kind === "add" && line.content.includes("extra a2"))).toBe(true);

    // Binary add: printed endpoint content fails the NUL probe, so the
    // entry stays hunkless but is never dropped.
    const added = byPath.get("bin.dat");
    expect(added?.status).toBe("added");
    expect(added?.oldPath).toBeUndefined();
    expect(added?.hunks).toEqual([]);
  });
  it("parses add/delete-only ranges with three-equals delete headers and synthesized endpoint content", async () => {
    const { p4, callLog } = createRunner({
      diff2: () => ({ stdout: diff2Range1to5, stderr: "" }),
      print: (args) => {
        const target = args[args.length - 1] ?? "";
        if (target.startsWith("//depot/bin.dat")) return { stdout: "PK\0\u0003\u0004bin", stderr: "" };
        if (target.startsWith("//depot/src/a.txt")) return { stdout: "alpha v1\nshared line\n", stderr: "" };
        if (target.startsWith("//depot/src/b.txt")) return { stdout: "beta v1\n", stderr: "" };
        return { stdout: "alpha v2\nshared line\nextra a2\n", stderr: "" };
      },
    });
    const adapter = makeAdapter(p4);

    const result = await adapter.diff({
      baseRevision: "1",
      headRevision: "5",
      files: ["bin.dat", "src/a.txt", "src/b.txt", "src/renamed/a.txt"],
    });

    // No content pairs → the -u pass is skipped entirely; one endpoint
    // print per add/delete pair in enumeration order.
    expect(callLog).toEqual([
      "diff2 -Od -q //depot/...@1 //depot/...@5",
      "print -q //depot/bin.dat@5",
      "print -q //depot/src/a.txt@1",
      "print -q //depot/src/b.txt@1",
      "print -q //depot/src/renamed/a.txt@5",
    ]);

    const byPath = new Map(result.files.map((file) => [file.newPath ?? file.oldPath, file]));
    expect(byPath.get("src/a.txt")?.status).toBe("deleted");
    expect(byPath.get("src/a.txt")?.newPath).toBeUndefined();
    expect(byPath.get("src/a.txt")?.hunks[0]?.lines.map((line) => [line.kind, line.content])).toEqual([
      ["delete", "alpha v1"],
      ["delete", "shared line"],
    ]);
    expect(byPath.get("src/b.txt")?.status).toBe("deleted");
    expect(byPath.get("src/b.txt")?.hunks[0]?.lines).toHaveLength(1);
    // The move surfaces as delete(src/a.txt) + add(src/renamed/a.txt), and
    // the added side carries the moved file's content.
    const moved = byPath.get("src/renamed/a.txt");
    expect(moved?.status).toBe("added");
    expect(moved?.hunks[0]?.lines.map((line) => line.kind)).toEqual(["add", "add", "add"]);
    expect(byPath.get("bin.dat")?.status).toBe("added");
    expect(byPath.get("bin.dat")?.hunks).toEqual([]);
  });

  it("nets out files added and deleted inside the batch range", async () => {
    const { p4 } = createRunner({
      diff2: () => ({ stdout: diff2Range0to5, stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const result = await adapter.diff({ baseRevision: "0", headRevision: "5", files: [] });

    // src/a.txt (added CL1, moved CL5) and src/b.txt (added CL1, deleted
    // CL4) never produce <none>-vs-<none> pairs on a real server; the net
    // diff is exactly the two surviving adds.
    expect(result.files.map((file) => file.newPath).sort()).toEqual(["bin.dat", "src/renamed/a.txt"]);
  });

  it("keeps binary content pairs hunkless and skips identical pairs", async () => {
    const { p4, callLog } = createRunner({
      diff2: (args) => args.includes("-u")
        ? { stdout: diff2Unified5to8, stderr: "" }
        : { stdout: diff2Range5to8, stderr: "" },
      print: () => ({ stdout: "bob docs\n", stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const result = await adapter.diff({ baseRevision: "5", headRevision: "8", files: [] });

    // A text content pair exists, so the -u pass runs and its bare
    // `Binary files ... differ` line is tolerated; the add prints its
    // endpoint content.
    expect(callLog).toEqual([
      "diff2 -Od -q //depot/...@5 //depot/...@8",
      "print -q //depot/docs/b.md@8",
      "diff2 -u //depot/src/renamed/a.txt@5 //depot/src/renamed/a.txt@8",
    ]);

    const byPath = new Map(result.files.map((file) => [file.newPath ?? file.oldPath, file]));
    expect([...byPath.keys()].sort()).toEqual(["bin.dat", "docs/b.md", "src/renamed/a.txt"]);
    const binary = byPath.get("bin.dat");
    expect(binary?.status).toBe("modified");
    expect(binary?.hunks).toEqual([]);
    const added = byPath.get("docs/b.md");
    expect(added?.status).toBe("added");
    expect(added?.hunks[0]?.lines).toEqual([expect.objectContaining({ kind: "add", content: "bob docs" })]);
    expect(byPath.get("src/renamed/a.txt")?.status).toBe("modified");
    expect(byPath.get("src/renamed/a.txt")?.hunks).toHaveLength(1);
  });
  it("skips the -u pass when the range has no text content pairs", async () => {
    const { p4, callLog } = createRunner({
      diff2: () => ({ stdout: diff2Range5to7, stderr: "" }),
      print: () => ({ stdout: "bob docs\n", stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const result = await adapter.diff({ baseRevision: "5", headRevision: "7", files: [] });

    // Binary pair + add + identical: no text content pair → one diff2 call
    // plus the add's endpoint print.
    expect(callLog).toEqual([
      "diff2 -Od -q //depot/...@5 //depot/...@7",
      "print -q //depot/docs/b.md@7",
    ]);
    const byPath = new Map(result.files.map((file) => [file.newPath ?? file.oldPath, file]));
    // src/renamed/a.txt (`identical`) is not a change.
    expect([...byPath.keys()].sort()).toEqual(["bin.dat", "docs/b.md"]);
    expect(byPath.get("bin.dat")?.hunks).toEqual([]);
    expect(byPath.get("docs/b.md")?.hunks[0]?.lines).toEqual([expect.objectContaining({ kind: "add" })]);
  });
  it("filters the scoped diff2 result to the candidate member files", async () => {
    const { p4, callLog } = createRunner({
      diff2: (args) => {
        if (args.includes("-u")) {
          if (args.some((arg) => arg.includes("...") || arg.includes("src/b.txt"))) {
            throw new Error("excluded file exceeds stdout maxBuffer");
          }
          return { stdout: diff2Unified1to3, stderr: "" };
        }
        if (!args.includes("-Od") || !args.includes("-q")) {
          throw new Error("identical depot headers exceed stdout maxBuffer");
        }
        return { stdout: diff2Range1to3, stderr: "" };
      },
      print: () => { throw new Error("excluded binary exceeds stdout maxBuffer"); },
    });
    const adapter = makeAdapter(p4);

    const result = await adapter.diff({
      baseRevision: "1",
      headRevision: "3",
      files: ["src/a.txt"],
    });

    expect(result.files.map((file) => file.newPath ?? file.oldPath)).toEqual(["src/a.txt"]);
    expect(result.files[0]?.hunks).toHaveLength(1);
    expect(callLog).toEqual([
      "diff2 -Od -q //depot/...@1 //depot/...@3",
      "diff2 -u //depot/src/a.txt@1 //depot/src/a.txt@3",
    ]);
  });

  it("lists the whole batch range when its head only changes excluded files", async () => {
    const { p4, callLog } = createRunner({
      diff2: () => ({ stdout: diff2Range1to3, stderr: "" }),
      describe: () => ({ stdout: "... //depot/bin.dat#1 add\n", stderr: "" }),
    });
    const adapter = new P4VcsAdapter({
      repositoryDir: "/tmp/test", depot: "//depot", p4,
      watchPath: ["src"], includeCrFile: ["**/*.txt"], excludeCrFile: ["**/b.txt"],
    });
    const result = await adapter.listChanges(createReviewEvent({
      triggerName: "p4", provider: "p4", workspaceId: "ws", targetKind: "commit",
      author: { username: "alice" }, reason: "auto-commit:batch:test",
      repoRef: "//depot", baseSha: "1", headSha: "3", changedFiles: ["bin.dat"],
    }));
    expect(result).toEqual({ baseRevision: "1", headRevision: "3", files: ["src/a.txt"] });
    expect(callLog).toEqual(["diff2 -Od -q //depot/...@1 //depot/...@3"]);
  });

  it("propagates batch file enumeration failure instead of reporting no changed files", async () => {
    const { p4 } = createRunner({
      diff2: () => { throw new Error("stdout maxBuffer length exceeded"); },
    });
    await expect(makeAdapter(p4).listChanges(createReviewEvent({
      triggerName: "p4", provider: "p4", workspaceId: "ws", targetKind: "commit",
      author: { username: "alice" }, reason: "auto-commit:batch:test",
      repoRef: "//depot", baseSha: "1", headSha: "3",
    }))).rejects.toThrow("stdout maxBuffer length exceeded");
  });

  it("throws when the -u pass drops a content pair reported by enumeration", async () => {
    const { p4 } = createRunner({
      diff2: (args) => args.includes("-u")
        ? { stdout: diff2Unified5to7, stderr: "" } // binary-only output: both text pairs missing
        : { stdout: diff2Range1to3, stderr: "" },
    });
    const adapter = makeAdapter(p4);

    await expect(adapter.diff({
      baseRevision: "1",
      headRevision: "3",
      files: [],
    })).rejects.toThrow(/missing from -u output/u);
  });

  it("keeps the single-CL describe -du path when base equals head or is absent", async () => {
    const { p4, callLog } = createRunner({
      describe: () => ({ stdout: describeDu3, stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const noBase = await adapter.diff({ headRevision: "3", files: ["src/b.txt"] });
    expect(noBase.files[0]?.newPath).toBe("src/b.txt");
    expect(noBase.files[0]?.hunks).toHaveLength(1);

    const sameBase = await adapter.diff({ baseRevision: "3", headRevision: "3", files: ["src/b.txt"] });
    expect(sameBase.files[0]?.newPath).toBe("src/b.txt");

    expect(callLog.filter((call) => call.includes("diff2"))).toHaveLength(0);
    expect(callLog.filter((call) => call.includes("describe -du 3"))).toHaveLength(2);
  });

  it("throws on a missing endpoint CL instead of returning an empty diff", async () => {
    const { p4 } = createRunner({
      diff2: () => {
        throw new Error("Invalid changelist number 99999.");
      },
    });
    const adapter = makeAdapter(p4);

    await expect(adapter.diff({
      baseRevision: "1",
      headRevision: "99999",
      files: ["src/a.txt"],
    })).rejects.toThrow(/Invalid changelist number/u);
  });

  it("throws when diff2 output has no recognizable file headers", async () => {
    const { p4 } = createRunner({
      diff2: () => ({ stdout: "//depot/... - must refer to client workspace.\n", stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    await expect(adapter.diff({
      baseRevision: "1",
      headRevision: "3",
      files: ["src/a.txt"],
    })).rejects.toThrow(/parse failure/u);
  });

  it("throws on a malformed diff2 block header", async () => {
    const { p4 } = createRunner({
      diff2: () => ({ stdout: "==== not-a-depot-path ====\n@@ -1,1 +1,1 @@\n-x\n+y\n", stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    await expect(adapter.diff({
      baseRevision: "1",
      headRevision: "3",
      files: ["src/a.txt"],
    })).rejects.toThrow(/unrecognized header/u);
  });

  it("treats empty diff2 output as a genuinely empty range", async () => {
    const { p4 } = createRunner({
      diff2: () => ({ stdout: "", stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const result = await adapter.diff({
      baseRevision: "1",
      headRevision: "3",
      files: ["src/a.txt"],
    });

    expect(result.files).toEqual([]);
  });

  it("refuses a batch diff without a configured depot scope", async () => {
    const { p4, callLog } = createRunner({});
    const adapter = new P4VcsAdapter({ repositoryDir: "/tmp/test", p4 });

    await expect(adapter.diff({
      baseRevision: "1",
      headRevision: "3",
      files: ["src/a.txt"],
    })).rejects.toThrow(/configured depot scope/u);
    expect(callLog).toHaveLength(0);
  });

  it("rejects non-numeric batch endpoints", async () => {
    const { p4, callLog } = createRunner({});
    const adapter = makeAdapter(p4);

    await expect(adapter.diff({
      baseRevision: "main",
      headRevision: "3",
      files: ["src/a.txt"],
    })).rejects.toThrow(/numeric changelist endpoints/u);
    expect(callLog).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";

import { P4VcsAdapter, type P4CommandResult, type P4CommandRunner } from "../src/p4.js";

/**
 * Mock-runner fixtures based on the documented `p4 changes` /
 * `p4 describe -s` text formats:
 * https://help.perforce.com/helix-core/server-apps/cmdref/current/content/CmdRef/p4_changes.html
 * https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_describe.html
 * No live Perforce server is involved; the fixtures below are the formats
 * these references document.
 */

const changesOutput = `Change 1003 on 2026/05/07 by alice@alice-ws 'Third change'
Change 1002 on 2026/05/06 by bob@bob-ws 'Second change'
Change 1001 on 2026/05/05 by carol@carol-ws 'First change'
`;

const describeOutput = `Change 1001 by carol@carol-ws on 2026/05/05 09:00:00

\tFirst change

Affected files ...

... //depot/main/src/a.cpp#1 add

Change 1002 by bob@bob-ws on 2026/05/06 10:00:00

\tSecond change

Affected files ...

... //depot/main/src/a.cpp#2 edit
... //depot/main/src/b.h#1 add

Change 1003 by alice@alice-ws on 2026/05/07 11:00:00

\tThird change

Affected files ...

... //depot/main/src/c.md#1 add
`;

function createRunner(handlers: {
  changes?: (args: readonly string[]) => P4CommandResult;
  describe?: (args: readonly string[]) => P4CommandResult;
}): { p4: P4CommandRunner; calls: readonly string[]; callLog: string[] } {
  const callLog: string[] = [];
  const p4: P4CommandRunner = async (args) => {
    callLog.push(args.join(" "));
    if (args.includes("changes") && handlers.changes) {
      return handlers.changes(args);
    }
    if (args.includes("describe") && handlers.describe) {
      return handlers.describe(args);
    }
    return { stdout: "", stderr: "" };
  };
  return { p4, calls: callLog, callLog };
}

function makeAdapter(p4: P4CommandRunner): P4VcsAdapter {
  return new P4VcsAdapter({ repositoryDir: "/tmp/test", p4 });
}

describe("P4VcsAdapter.listCommitMetadataPage", () => {
  it("parses user@client, returns oldest-first order, and reads batched describe paths", async () => {
    const { p4, callLog } = createRunner({
      changes: () => ({ stdout: changesOutput, stderr: "" }),
      describe: () => ({ stdout: describeOutput, stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const page = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      baseRevision: "1000",
      headRevision: "1003",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("complete");
    expect(page.nextCursor).toBeUndefined();
    expect(page.records.map((record) => record.revision)).toEqual(["1001", "1002", "1003"]);
    expect(page.records.map((record) => record.p4User)).toEqual(["carol", "bob", "alice"]);
    expect(page.records.map((record) => record.p4Client)).toEqual(["carol-ws", "bob-ws", "alice-ws"]);
    expect(page.records.map((record) => record.parents)).toEqual([[], [], []]);
    expect(page.records[0]?.changedPaths).toEqual(["//depot/main/src/a.cpp"]);
    expect(page.records[1]?.changedPaths).toEqual(["//depot/main/src/a.cpp", "//depot/main/src/b.h"]);

    // One bounded changes command for the scope range, one batched describe.
    const changesCalls = callLog.filter((call) => call.includes("changes"));
    expect(changesCalls).toHaveLength(1);
    expect(changesCalls[0]).toContain("changes -s submitted");
    expect(changesCalls[0]).toContain("//depot/main/...@>1000,@<=1003");
    const describeCalls = callLog.filter((call) => call.includes("describe"));
    expect(describeCalls).toHaveLength(1);
    expect(describeCalls[0]).toContain("describe -s 1001 1002 1003");
  });

  it("paginates with a resumable cursor and no overlap", async () => {
    const { p4 } = createRunner({
      changes: (args) => {
        const range = args[args.length - 1] ?? "";
        if (range.includes("@>1002")) {
          return {
            stdout: "Change 1003 on 2026/05/07 by alice@alice-ws 'Third change'\n",
            stderr: "",
          };
        }
        return { stdout: changesOutput, stderr: "" };
      },
      describe: () => ({ stdout: "", stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const first = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      baseRevision: "1000",
      headRevision: "1003",
      maxRecords: 2,
      maxBytes: 1_048_576,
    });
    expect(first.status).toBe("partial");
    expect(first.records.map((record) => record.revision)).toEqual(["1001", "1002"]);
    expect(first.nextCursor).toBe("1002");

    const second = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      baseRevision: "1000",
      headRevision: "1003",
      maxRecords: 2,
      maxBytes: 1_048_576,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.status).toBe("complete");
    expect(second.nextCursor).toBeUndefined();
    expect(second.records.map((record) => record.revision)).toEqual(["1003"]);

    const all = [...first.records, ...second.records].map((record) => record.revision);
    expect(all).toEqual(["1001", "1002", "1003"]);
  });

  it("marks permission-hidden history as unavailable instead of an empty range", async () => {
    const { p4 } = createRunner({
      changes: () => {
        throw Object.assign(new Error("p4 changes failed: access denied"), {
          stderr: "Access denied: user lacks permission",
        });
      },
    });
    const adapter = makeAdapter(p4);

    const page = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/secret/...",
      headRevision: "1003",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("unavailable");
    expect(page.records).toEqual([]);
    expect(page.unavailableReason).toMatch(/Access denied/u);
  });

  it("maps empty or missing user/client identity parts to undefined", async () => {
    const { p4 } = createRunner({
      changes: () => ({
        stdout: [
          "Change 7 on 2026/05/07 by @qa-client 'Missing user'",
          "Change 6 on 2026/05/06 by unknown-identity 'Missing client separator'",
        ].join("\n"),
        stderr: "",
      }),
    });
    const adapter = makeAdapter(p4);

    const page = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      headRevision: "7",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("complete");
    expect(page.records.map((record) => record.revision)).toEqual(["6", "7"]);
    const first = page.records[0];
    expect(first?.p4User).toBeUndefined();
    expect(first?.p4Client).toBeUndefined();
    expect("p4User" in (first ?? {})).toBe(false);
    const second = page.records[1];
    expect(second?.p4User).toBeUndefined();
    expect(second?.p4Client).toBe("qa-client");
  });

  it("emits zero-padded lexicographically sortable order keys", async () => {
    const { p4 } = createRunner({
      changes: () => ({
        stdout: [
          "Change 10000 on 2026/05/08 by dave@dave-ws 'Five digits'",
          "Change 999 on 2026/05/07 by alice@alice-ws 'Three digits'",
          "Change 42 on 2026/05/06 by bob@bob-ws 'Two digits'",
        ].join("\n"),
        stderr: "",
      }),
    });
    const adapter = makeAdapter(p4);

    const page = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      headRevision: "10000",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.records.map((record) => record.orderKey)).toEqual([
      "000000000042",
      "000000000999",
      "000000010000",
    ]);
    const orderKeys = page.records.map((record) => record.orderKey);
    expect([...orderKeys].sort()).toEqual(orderKeys);
  });

  it("skips the describe read and leaves changedPaths empty on a tiny byte budget", async () => {
    const { p4, callLog } = createRunner({
      changes: () => ({ stdout: changesOutput, stderr: "" }),
    });
    const adapter = makeAdapter(p4);

    const page = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      headRevision: "1003",
      maxRecords: 256,
      maxBytes: 1024,
    });

    expect(page.status).toBe("complete");
    expect(page.records).toHaveLength(3);
    expect(page.records.every((record) => record.changedPaths.length === 0)).toBe(true);
    // Source fields still parse — continuity never depends on the path summary.
    expect(page.records[0]?.p4User).toBe("carol");
    expect(callLog.filter((call) => call.includes("describe"))).toHaveLength(0);
  });

  it("leaves changedPaths empty when the advisory describe fails", async () => {
    const { p4 } = createRunner({
      changes: () => ({ stdout: changesOutput, stderr: "" }),
      describe: () => {
        throw new Error("p4 describe failed: access denied");
      },
    });
    const adapter = makeAdapter(p4);

    const page = await adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      headRevision: "1003",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("complete");
    expect(page.records.map((record) => record.p4User)).toEqual(["carol", "bob", "alice"]);
    expect(page.records.every((record) => record.changedPaths.length === 0)).toBe(true);
  });

  it("rejects invalid revisions and cursors", async () => {
    const adapter = makeAdapter(async () => ({ stdout: "", stderr: "" }));
    await expect(adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      headRevision: "main",
      maxRecords: 256,
      maxBytes: 1_048_576,
    })).rejects.toThrow(/changelist number/u);
    await expect(adapter.listCommitMetadataPage({
      scopeRef: "//depot/main/...",
      headRevision: "1003",
      cursor: "abc",
      maxRecords: 256,
      maxBytes: 1_048_576,
    })).rejects.toThrow(/Invalid P4 metadata cursor/u);
    await expect(adapter.listCommitMetadataPage({
      scopeRef: "refs/heads/main",
      headRevision: "1003",
      maxRecords: 256,
      maxBytes: 1_048_576,
    })).rejects.toThrow(/depot path/u);
  });
});

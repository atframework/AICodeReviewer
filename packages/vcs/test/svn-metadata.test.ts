import { describe, expect, it } from "vitest";

import { createSvnVcsAdapter, type SvnCommandRunner } from "../src/svn.js";

/**
 * Mock-runner fixtures (design test matrix VCS row: SVN uses documented
 * `svn log --xml -v` output shapes; no live SVN service is involved).
 * Fixtures follow the svnbook XML log format: <log> root, <logentry
 * revision="N"> with <author>, <paths><path action="…">text</path></paths>,
 * and <msg>.
 */

const scopeUrl = "https://svn.example.com/repos/project/trunk";

function logXml(entries: readonly string[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<log>`,
    ...entries,
    `</log>`,
  ].join("\n");
}

function logentry(
  revision: number,
  options: { author?: string | null; paths?: readonly string[] } = {},
): string {
  const authorXml = options.author === null || options.author === undefined
    ? ""
    : `<author>${options.author}</author>`;
  const pathsXml = (options.paths ?? []).map(
    (path) => `<path action="M">${path}</path>`,
  );
  return [
    `<logentry revision="${revision}">`,
    authorXml,
    `<date>2026-09-01T00:00:00.000000Z</date>`,
    `<paths>`,
    ...pathsXml,
    `</paths>`,
    `<msg>change ${revision}</msg>`,
    `</logentry>`,
  ].filter((line) => line.length > 0).join("\n");
}

describe("SvnVcsAdapter.listCommitMetadataPage", () => {
  it("parses svn:author and keeps it undefined when the commit has no author", async () => {
    const calls: string[][] = [];
    const svn: SvnCommandRunner = async (args) => {
      calls.push([...args]);
      return {
        stdout: logXml([
          logentry(11, { author: "alice", paths: ["/trunk/src/app.ts"] }),
          logentry(12, { author: null, paths: ["/trunk/src/anon.ts"] }),
          logentry(13, { author: "", paths: ["/trunk/src/empty.ts"] }),
        ]),
        stderr: "",
      };
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: scopeUrl, svn });

    const page = await adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      baseRevision: "10",
      headRevision: "13",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("complete");
    expect(page.records).toHaveLength(3);
    expect(page.records[0]?.svnAuthor).toBe("alice");
    // Missing <author> and empty <author></author> both stay undefined —
    // never a substituted default identity.
    expect(page.records[1]?.svnAuthor).toBeUndefined();
    expect(page.records[1]).not.toHaveProperty("svnAuthor");
    expect(page.records[2]?.svnAuthor).toBeUndefined();
    expect(page.records[2]).not.toHaveProperty("svnAuthor");
    expect(calls[0]).toEqual([
      "--non-interactive",
      "log",
      "--xml",
      "-v",
      "--limit",
      "257",
      "-r",
      "11:13",
      `${scopeUrl}@13`,
    ]);
  });

  it("emits records oldest-first with lexicographically sortable order keys", async () => {
    // Fixture intentionally lists entries newest-first; record order must
    // come from the adapter, not the wire order.
    const svn: SvnCommandRunner = async () => ({
      stdout: logXml([
        logentry(9, { author: "carol", paths: ["/trunk/c.ts"] }),
        logentry(7, { author: "alice", paths: ["/trunk/a.ts"] }),
        logentry(8, { author: "bob" }),
      ]),
      stderr: "",
    });
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: scopeUrl, svn });

    const page = await adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      headRevision: "9",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("complete");
    expect(page.records.map((record) => record.revision)).toEqual(["7", "8", "9"]);
    const orderKeys = page.records.map((record) => record.orderKey);
    expect(orderKeys).toEqual(["000000000007", "000000000008", "000000000009"]);
    expect([...orderKeys].sort()).toEqual(orderKeys);
    expect(page.records.every((record) => record.parents.length === 0)).toBe(true);
    // Changed paths keep the raw repository-root path text, action dropped.
    expect(page.records[0]?.changedPaths).toEqual(["/trunk/a.ts"]);
    expect(page.records[1]?.changedPaths).toEqual([]);
  });

  it("paginates with an exact resumable cursor — no overlap, no gaps", async () => {
    const calls: string[][] = [];
    const svn: SvnCommandRunner = async (args) => {
      calls.push([...args]);
      const range = args[args.indexOf("-r") + 1];
      if (range === "11:14") {
        // --limit maxRecords + 1 = 3: the extra entry only signals partial.
        return {
          stdout: logXml([
            logentry(11, { author: "alice", paths: ["/trunk/a.ts"] }),
            logentry(12, { author: "bob", paths: ["/trunk/b.ts"] }),
            logentry(13, { author: "carol", paths: ["/trunk/c.ts"] }),
          ]),
          stderr: "",
        };
      }
      if (range === "13:14") {
        return {
          stdout: logXml([
            logentry(13, { author: "carol", paths: ["/trunk/c.ts"] }),
            logentry(14, { author: "dan", paths: ["/trunk/d.ts"] }),
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected range ${String(range)}`);
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: scopeUrl, svn });

    const first = await adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      baseRevision: "10",
      headRevision: "14",
      maxRecords: 2,
      maxBytes: 1_048_576,
    });

    expect(first.status).toBe("partial");
    expect(first.records.map((record) => record.revision)).toEqual(["11", "12"]);
    expect(first.nextCursor).toBe("12");
    expect(calls[0]).toContain(`${scopeUrl}@14`);

    const second = await adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      baseRevision: "10",
      headRevision: "14",
      cursor: first.nextCursor,
      maxRecords: 2,
      maxBytes: 1_048_576,
    });

    expect(second.status).toBe("complete");
    expect(second.nextCursor).toBeUndefined();
    expect(second.records.map((record) => record.revision)).toEqual(["13", "14"]);
    expect(calls[1]?.[calls[1].indexOf("-r") + 1]).toBe("13:14");

    const all = [...first.records, ...second.records].map((record) => record.revision);
    expect(all).toEqual(["11", "12", "13", "14"]);
  });

  it("reports unavailable with the svn error text when the range cannot be read", async () => {
    const svn: SvnCommandRunner = async () => {
      const error = new Error("svn: E175002: The OPTIONS request failed") as Error & { stderr: string };
      error.stderr = "svn: E175002: The server sent a 403 (Forbidden)";
      throw error;
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: scopeUrl, svn });

    const page = await adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      baseRevision: "10",
      headRevision: "13",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    // Permission-hidden history is an explicit blocker, never an empty range.
    expect(page.status).toBe("unavailable");
    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.unavailableReason).toContain("E175002");
    expect(page.unavailableReason).toContain("403");
  });

  it("reports unavailable for a nonexistent endpoint revision (E200009)", async () => {
    const svn: SvnCommandRunner = async () => {
      throw new Error(`svn: E200009: File or directory '/' is not valid at revision '999'`);
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: scopeUrl, svn });

    const page = await adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      headRevision: "999",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("unavailable");
    expect(page.unavailableReason).toContain("E200009");
  });

  it("decodes XML entities in authors and paths; empty author element stays undefined", async () => {
    const stdout = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<log>`,
      `<logentry revision="5">`,
      `<author>a&amp;b &lt;tag&gt; &#x40;&#65;</author>`,
      `<date>2026-09-01T00:00:00.000000Z</date>`,
      `<paths>`,
      `<path action="M">/trunk/src/a&amp;b.ts</path>`,
      `<path action="A">/trunk/src/&lt;weird&gt;.ts</path>`,
      `</paths>`,
      `<msg>x</msg>`,
      `</logentry>`,
      `<logentry revision="6">`,
      `<author></author>`,
      `<date>2026-09-01T00:00:01.000000Z</date>`,
      `<paths>`,
      `</paths>`,
      `<msg>y</msg>`,
      `</logentry>`,
      `</log>`,
    ].join("\n");
    const svn: SvnCommandRunner = async () => ({ stdout, stderr: "" });
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: scopeUrl, svn });

    const page = await adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      baseRevision: "4",
      headRevision: "6",
      maxRecords: 256,
      maxBytes: 1_048_576,
    });

    expect(page.status).toBe("complete");
    expect(page.records[0]?.svnAuthor).toBe("a&b <tag> @A");
    expect(page.records[0]?.changedPaths).toEqual(["/trunk/src/a&b.ts", "/trunk/src/<weird>.ts"]);
    expect(page.records[1]?.svnAuthor).toBeUndefined();
    expect(page.records[1]).not.toHaveProperty("svnAuthor");
  });

  it("rejects malformed revision endpoints and cursors", async () => {
    const adapter = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl: scopeUrl,
      svn: async () => ({ stdout: "", stderr: "" }),
    });

    await expect(adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      headRevision: "HEAD",
      maxRecords: 256,
      maxBytes: 1_048_576,
    })).rejects.toThrow(/Invalid SVN metadata head revision/u);
    await expect(adapter.listCommitMetadataPage({
      scopeRef: scopeUrl,
      headRevision: "13",
      cursor: "12:garbage",
      maxRecords: 256,
      maxBytes: 1_048_576,
    })).rejects.toThrow(/Invalid SVN metadata cursor/u);
  });
});

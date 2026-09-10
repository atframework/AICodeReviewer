import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { P4VcsAdapter } from "../src/p4.js";

// Opt in with a local p4d executable. All server data and client files remain
// under build/, and every command names the isolated loopback server explicitly.
const p4d = process.env.AICR_P4D_TEST_EXECUTABLE;

describe.skipIf(!p4d)("P4 local server metadata and endpoint diff", () => {
  it("keeps User+Client and compares snapshots across disjoint file changes", async () => {
    const base = resolve("build/tmp/p4-live-acceptance");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "run-"));
    const serverRoot = join(root, "server");
    const clientRoot = join(root, "client");
    await mkdir(serverRoot);
    await mkdir(clientRoot);
    const port = "127.0.0.1:18669";
    const server = spawn(resolve(p4d!), ["-r", serverRoot, "-p", port, "-L", join(root, "server.log")], {
      cwd: serverRoot, windowsHide: true, stdio: "ignore",
    });
    const p4 = (args: readonly string[], input?: string): string => execFileSync("p4", [
      "-p", port, "-u", "alice", "-c", "task-main", ...args,
    ], { cwd: clientRoot, encoding: "utf8", ...(input !== undefined ? { input } : {}), stdio: ["pipe", "pipe", "pipe"] });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try { p4(["info"]); ready = true; break; } catch { await delay(100); }
      }
      expect(ready).toBe(true);
      p4(["client", "-i"], `Client: task-main\nOwner: alice\nRoot: ${clientRoot}\nView:\n\t//depot/... //task-main/...\n`);
      await writeFile(join(clientRoot, "a.txt"), "a1\n");
      await writeFile(join(clientRoot, "b.txt"), "b1\n");
      // The scoop-style p4 launcher on some Windows setups drops the child
      // CWD, so add uses absolute local paths and later commands depot paths.
      p4(["add", join(clientRoot, "a.txt"), join(clientRoot, "b.txt")]);
      p4(["submit", "-d", "baseline"]);
      p4(["edit", "//depot/a.txt"]);
      await writeFile(join(clientRoot, "a.txt"), "a2\n");
      p4(["submit", "-d", "A1"]);
      p4(["edit", "//depot/b.txt"]);
      await writeFile(join(clientRoot, "b.txt"), "b2\n");
      p4(["submit", "-d", "A2"]);
      const raw = p4(["diff2", "-u", "//depot/...@1", "//depot/...@3"]);
      await writeFile(join(root, "snapshot-diff.txt"), raw);
      const adapter = new P4VcsAdapter({ repositoryDir: clientRoot, port, user: "alice", workspace: "task-main", depot: "//depot" });
      const page = await adapter.listCommitMetadataPage({ scopeRef: "//depot/...", baseRevision: "1", headRevision: "3", maxRecords: 1, maxBytes: 1_048_576 });
      expect(page.status).toBe("partial");
      expect(page.records.map((record) => [record.revision, record.p4User, record.p4Client])).toEqual([["2", "alice", "task-main"]]);
      const tail = await adapter.listCommitMetadataPage({ scopeRef: "//depot/...", baseRevision: "1", headRevision: "3", cursor: page.nextCursor, maxRecords: 1, maxBytes: 1_048_576 });
      expect(tail.status).toBe("complete");
      expect(tail.records.map((record) => record.revision)).toEqual(["3"]);
      const diff = await adapter.diff({ baseRevision: "1", headRevision: "3", files: ["a.txt", "b.txt"] });
      expect(diff.files.map((file) => file.newPath).sort()).toEqual(["a.txt", "b.txt"]);
      expect(diff.files.every((file) => file.status === "modified" && file.hunks.length > 0)).toBe(true);
    } finally {
      try { p4(["admin", "stop"]); } finally { server.kill(); }
    }
  }, 30_000);
});

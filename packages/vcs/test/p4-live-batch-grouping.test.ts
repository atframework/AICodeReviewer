import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { P4VcsAdapter } from "../src/p4.js";

// Opt in with a local p4d executable (AICR_P4D_TEST_EXECUTABLE). All server
// data and client files stay under build/, on an isolated loopback port.
// History mirrors the design's A/B grouping scenario: A1..A5 by
// alice@task-main (add/edit/binary+edit/delete/move) then B1 by
// bob@task-b — P4 source grouping must always include Client.
const p4d = process.env.AICR_P4D_TEST_EXECUTABLE;

describe.skipIf(!p4d)("P4 local server source grouping and endpoint actions", () => {
  it("groups alice streak separately from bob and reports real endpoint actions", async () => {
    const base = resolve("build/tmp/p4-live-grouping");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "run-"));
    const serverRoot = join(root, "server");
    const clientA = join(root, "client-a");
    const clientB = join(root, "client-b");
    await mkdir(serverRoot);
    await mkdir(clientA);
    await mkdir(clientB);
    const port = "127.0.0.1:18670";
    const server = spawn(resolve(p4d!), ["-r", serverRoot, "-p", port, "-L", join(root, "server.log")], {
      cwd: serverRoot, windowsHide: true, stdio: "ignore",
    });
    const p4 = (user: string, client: string, args: readonly string[], input?: string): string =>
      execFileSync("p4", ["-p", port, "-u", user, "-c", client, ...args], {
        cwd: clientA, encoding: "utf8", ...(input !== undefined ? { input } : {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try { p4("alice", "task-main", ["info"]); ready = true; break; } catch { await delay(100); }
      }
      expect(ready).toBe(true);
      p4("alice", "task-main", ["client", "-i"],
        `Client: task-main\nOwner: alice\nRoot: ${clientA}\nView:\n\t//depot/... //task-main/...\n`);
      p4("bob", "task-b", ["client", "-i"],
        `Client: task-b\nOwner: bob\nRoot: ${clientB}\nView:\n\t//depot/... //task-b/...\n`);

      const A = (args: readonly string[]) => p4("alice", "task-main", args);
      const B = (args: readonly string[]) => p4("bob", "task-b", args);

      // CL1 A1: add a.txt + b.txt
      await writeFile(join(clientA, "a.txt"), "alpha v1\n");
      await writeFile(join(clientA, "b.txt"), "beta v1\n");
      A(["add", join(clientA, "a.txt"), join(clientA, "b.txt")]);
      A(["submit", "-d", "A1"]);
      // CL2 A2: binary add
      await writeFile(join(clientA, "bin.dat"), Buffer.from([0x00, 0x01, 0x42, 0xff]));
      A(["add", "-t", "binary", join(clientA, "bin.dat")]);
      A(["submit", "-d", "A2"]);
      // CL3 A3: delete b.txt
      A(["delete", "//depot/b.txt"]);
      A(["submit", "-d", "A3"]);
      // CL4 A4: move a.txt -> renamed/a.txt (p4d 2025.1 requires the source
      // opened for edit before move; observed, not documented).
      A(["edit", "//depot/a.txt"]);
      A(["move", "//depot/a.txt", "//depot/renamed/a.txt"]);
      A(["submit", "-d", "A4"]);
      // CL5 B1: bob on a different client — same depot, different source.
      B(["sync", "//depot/..."]);
      await writeFile(join(clientB, "notes.md"), "bob\n");
      B(["add", join(clientB, "notes.md")]);
      B(["submit", "-d", "B1"]);

      const adapter = new P4VcsAdapter({
        repositoryDir: clientA, port, user: "alice", workspace: "task-main", depot: "//depot",
      });

      // Metadata: User+Client recorded per CL; bob never collapses into the
      // alice streak (P4 grouping is User+Client, never User-only).
      const page = await adapter.listCommitMetadataPage({
        scopeRef: "//depot", headRevision: "5", maxRecords: 64, maxBytes: 1_048_576,
      });
      expect(page.status).toBe("complete");
      expect(page.records.map((r) => [r.revision, r.p4User, r.p4Client])).toEqual([
        ["1", "alice", "task-main"],
        ["2", "alice", "task-main"],
        ["3", "alice", "task-main"],
        ["4", "alice", "task-main"],
        ["5", "bob", "task-b"],
      ]);

      // Batch @0..@4 (the alice streak): net diff = a.txt renamed add +
      // bin.dat add; b.txt (added CL1, deleted CL3) nets out.
      const batchDiff = await adapter.diff({ baseRevision: "0", headRevision: "4", files: [] });
      const byPath = new Map(batchDiff.files.map((f) => [f.newPath ?? f.oldPath, f]));
      expect([...byPath.keys()].sort()).toEqual(["bin.dat", "renamed/a.txt"]);
      expect(byPath.get("bin.dat")?.status).toBe("added");
      expect(byPath.get("bin.dat")?.hunks).toEqual([]);

      // Batch @1..@4 covers the delete and the move endpoints.
      const midDiff = await adapter.diff({ baseRevision: "1", headRevision: "4", files: [] });
      const mid = new Map(midDiff.files.map((f) => [f.newPath ?? f.oldPath, f]));
      expect(mid.get("b.txt")?.status).toBe("deleted");
      expect(mid.get("a.txt")?.status).toBe("deleted");
      expect(mid.get("renamed/a.txt")?.status).toBe("added");
    } finally {
      try { p4("alice", "task-main", ["admin", "stop"]); } finally { server.kill(); }
    }
  }, 45_000);
});

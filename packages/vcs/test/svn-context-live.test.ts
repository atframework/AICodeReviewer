import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { materializeContextRepositories } from "../src/context-repos.js";
import { SvnVcsAdapter } from "../src/svn.js";

const repositoryUrl = process.env.AICR_SVN_TEST_URL;

describe.skipIf(repositoryUrl === undefined)("SVN network context repository", () => {
  it("exports pinned and HEAD content, reads network diff, and cleans failed/stale aliases", async () => {
    if (!repositoryUrl) throw new Error("AICR_SVN_TEST_URL must not be empty.");
    const url = new URL(repositoryUrl);
    if (url.protocol !== "svn:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/repo/trunk") {
      throw new Error("Use the disposable with-svn.sh fixture URL.");
    }
    const base = resolve("build/tmp");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "svn-context-"));
    try {
      const pinned = await materializeContextRepositories({ contextReposRoot: root, repos: [
        { alias: "lib", kind: "svn", repository_url: repositoryUrl, revision: 1 },
      ] });
      expect(pinned[0]).toMatchObject({ status: "ok", resolvedRevision: "1", fileCount: 1 });
      expect(await readFile(join(root, "lib/content.txt"), "utf8")).toBe("first revision\n");
      expect(await readdir(join(root, "lib"))).toEqual(["content.txt"]);
      const head = await materializeContextRepositories({ contextReposRoot: root, repos: [
        { alias: "latest", kind: "svn", repository_url: repositoryUrl },
      ] });
      expect(head[0]).toMatchObject({ status: "ok", resolvedRevision: "2", fileCount: 1 });
      expect(await readFile(join(root, "latest/content.txt"), "utf8")).toBe("second revision\n");
      expect(await readdir(root)).toEqual(["latest"]);
      const adapter = new SvnVcsAdapter({ repositoryDir: root, repositoryUrl });
      const diff = await adapter.diff({ baseRevision: "1", headRevision: "2", files: ["content.txt"] });
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]).toMatchObject({ newPath: "content.txt", status: "modified" });
      const failed = await materializeContextRepositories({ contextReposRoot: root, warn: () => {}, repos: [
        { alias: "broken", kind: "svn", repository_url: `${repositoryUrl}/missing` },
      ] });
      expect(failed[0]?.status).toBe("failed");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGitVcsAdapter, type GitCommandRunner } from "../src/git.js";
import { P4VcsAdapter, type P4CommandRunner } from "../src/p4.js";
import { createSvnVcsAdapter, type SvnCommandRunner } from "../src/svn.js";

/**
 * `VcsAdapter.fetchRevisionCommittedAt` contract tests. Git runs against a
 * real local repository (pitfall: parsers are validated against the real
 * tool); svn/p4 use mock runners with the documented `svn log --xml` and
 * `p4 -ztag describe -s` output shapes. Every adapter must stay advisory:
 * unreadable revisions and malformed output resolve to `undefined`, never
 * throw.
 */

const scopeUrl = "https://svn.example.com/repos/project/trunk";

describe("GitVcsAdapter.fetchRevisionCommittedAt", () => {
  it("returns the committer date of a real commit as ISO-8601 UTC", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-stamp-"));
    try {
      const env = {
        ...process.env,
        GIT_COMMITTER_NAME: "Commit Bot",
        GIT_COMMITTER_EMAIL: "bot@example.com",
        GIT_AUTHOR_NAME: "Fallback Author",
        GIT_AUTHOR_EMAIL: "fallback@example.com",
        GIT_COMMITTER_DATE: "2026-09-01T08:30:00Z",
      };
      const git = (args: readonly string[]): string =>
        execFileSync("git", [...args], { cwd: tempDir, env, encoding: "utf8" }).trim();
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Test"]);
      git(["config", "user.email", "test@example.com"]);
      await mkdir(join(tempDir, "src"), { recursive: true });
      execFileSync("git", ["-C", tempDir, "commit", "--allow-empty", "-m", "stamp"], { env });
      const head = git(["rev-parse", "HEAD"]);

      const adapter = createGitVcsAdapter({ repositoryDir: tempDir });
      await expect(adapter.fetchRevisionCommittedAt(head)).resolves.toBe("2026-09-01T08:30:00.000Z");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes a non-UTC %cI offset to UTC and passes the expected argv", async () => {
    const calls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: "2026-09-10T08:00:00+08:00\n", stderr: "" };
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    await expect(adapter.fetchRevisionCommittedAt("abc123")).resolves.toBe("2026-09-10T00:00:00.000Z");
    expect(calls).toEqual([
      ["-C", expect.stringMatching(/repo$/u), "log", "-1", "--format=%cI", "--end-of-options", "abc123", "--"],
    ]);
  });

  it("returns undefined for garbage output and for git failures", async () => {
    const garbage = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      git: async () => ({ stdout: "not-a-date\n", stderr: "" }),
    });
    await expect(garbage.fetchRevisionCommittedAt("abc123")).resolves.toBeUndefined();

    const failing = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      git: async () => {
        throw new Error("fatal: ambiguous argument 'abc123': unknown revision");
      },
    });
    await expect(failing.fetchRevisionCommittedAt("abc123")).resolves.toBeUndefined();
  });
});

describe("SvnVcsAdapter.fetchRevisionCommittedAt", () => {
  it("parses svn:date from the pegged single-revision log", async () => {
    const calls: string[][] = [];
    const svn: SvnCommandRunner = async (args) => {
      calls.push([...args]);
      return {
        stdout: [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<log>`,
          `<logentry revision="42">`,
          `<author>alice</author>`,
          `<date>2026-09-01T12:34:56.789012Z</date>`,
          `<msg>change 42</msg>`,
          `</logentry>`,
          `</log>`,
        ].join("\n"),
        stderr: "",
      };
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: scopeUrl, svn });

    await expect(adapter.fetchRevisionCommittedAt("42")).resolves.toBe("2026-09-01T12:34:56.789Z");
    expect(calls[0]).toEqual([
      "--non-interactive",
      "log",
      "--xml",
      "--limit",
      "1",
      "-r",
      "42:42",
      `${scopeUrl}@42`,
    ]);
  });

  it("returns undefined when svn:date is unset, the revision is not numeric, or svn fails", async () => {
    const noDate = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl: scopeUrl,
      svn: async () => ({
        stdout: `<log><logentry revision="42"><author>alice</author><msg>x</msg></logentry></log>`,
        stderr: "",
      }),
    });
    await expect(noDate.fetchRevisionCommittedAt("42")).resolves.toBeUndefined();

    let called = false;
    const nonNumeric = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl: scopeUrl,
      svn: async () => {
        called = true;
        return { stdout: "", stderr: "" };
      },
    });
    await expect(nonNumeric.fetchRevisionCommittedAt("abc")).resolves.toBeUndefined();
    expect(called).toBe(false);

    const failing = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl: scopeUrl,
      svn: async () => {
        throw new Error("svn: E160013: path not found");
      },
    });
    await expect(failing.fetchRevisionCommittedAt("42")).resolves.toBeUndefined();
  });
});

describe("P4VcsAdapter.fetchRevisionCommittedAt", () => {
  it("never labels a pending changelist time as a commit time", async () => {
    const adapter = new P4VcsAdapter({ repositoryDir: "/tmp/test", p4: async () => ({
      stdout: "... change 42\r\n... time 1700000000\r\n... status pending\r\n", stderr: "",
    }) });
    await expect(adapter.fetchRevisionCommittedAt("42")).resolves.toBeUndefined();
  });

  it("accepts tagged output with Windows line endings", async () => {
    const adapter = new P4VcsAdapter({ repositoryDir: "/tmp/test", p4: async () => ({
      stdout: "... change 42\r\n... time 1700000000\r\n... status submitted\r\n", stderr: "",
    }) });
    await expect(adapter.fetchRevisionCommittedAt("42")).resolves.toBe(new Date(1700000000000).toISOString());
  });
  const ztagDescribe = [
    "... change 12345",
    "... user alice",
    "... client alice-ws",
    "... time 1700000000",
    "... status submitted",
    "... changeType public",
    "... desc First change",
    "... depotFile //depot/main/src/a.cpp",
    "... action1 add",
    "",
  ].join("\n");

  it("parses the ztag time field of p4 describe -s", async () => {
    const callLog: string[] = [];
    const p4: P4CommandRunner = async (args) => {
      callLog.push(args.join(" "));
      return { stdout: ztagDescribe, stderr: "" };
    };
    const adapter = new P4VcsAdapter({ repositoryDir: "/tmp/test", p4 });

    await expect(adapter.fetchRevisionCommittedAt("12345"))
      .resolves.toBe(new Date(1700000000 * 1000).toISOString());
    expect(callLog[0]).toContain("-ztag describe -s 12345");
  });

  it("returns undefined when the time field is absent, the change is not numeric, or p4 fails", async () => {
    const noTime = new P4VcsAdapter({
      repositoryDir: "/tmp/test",
      p4: async () => ({ stdout: "... change 12345\n... user alice\n", stderr: "" }),
    });
    await expect(noTime.fetchRevisionCommittedAt("12345")).resolves.toBeUndefined();

    let called = false;
    const nonNumeric = new P4VcsAdapter({
      repositoryDir: "/tmp/test",
      p4: async () => {
        called = true;
        return { stdout: "", stderr: "" };
      },
    });
    await expect(nonNumeric.fetchRevisionCommittedAt("abc")).resolves.toBeUndefined();
    expect(called).toBe(false);

    const failing = new P4VcsAdapter({
      repositoryDir: "/tmp/test",
      p4: async () => {
        throw new Error("Change 12345 unknown.");
      },
    });
    await expect(failing.fetchRevisionCommittedAt("12345")).resolves.toBeUndefined();
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextRepositoryConfig } from "@aicr/core";

import {
  materializeContextRepositories,
  type ContextRepoCommandRunner,
} from "../src/context-repos.js";

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}

function createRecordingRunner(
  handler?: (call: RecordedCall) => { stdout?: string | Buffer; stderr?: string } | Error,
): { run: ContextRepoCommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: ContextRepoCommandRunner = async (command, args, options) => {
    const call: RecordedCall = {
      command,
      args,
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.env ? { env: options.env } : {}),
    };
    calls.push(call);
    const response = handler?.(call) ?? {};
    if (response instanceof Error) {
      throw response;
    }
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  return { run, calls };
}

describe("materializeContextRepositories", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aicr-context-repos-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const gitRepo: ContextRepositoryConfig = {
    alias: "shared-lib",
    kind: "git",
    url: "https://github.com/org/shared-lib.git",
    ref: "main",
    token_env: "SHARED_LIB_TOKEN",
  };

  it("clones git repos shallowly with the token in GIT_CONFIG env instead of argv or the remote URL", async () => {
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args.includes("rev-parse")) {
        return { stdout: "abc123\n" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [gitRepo],
      run,
      resolveEnv: (name) => (name === "SHARED_LIB_TOKEN" ? "secret-token" : undefined),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.resolvedRevision).toBe("abc123");

    const clone = calls.find((call) => call.args.includes("clone"));
    expect(clone).toBeDefined();
    expect(clone?.args.some((arg) => arg.includes("secret-token"))).toBe(false);
    expect(clone?.env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: token secret-token",
    });
    expect(clone?.args).toContain("--depth");
    expect(clone?.args).toContain("--branch");
    expect(clone?.args).toContain("main");
    expect(clone?.args).toContain("https://github.com/org/shared-lib.git");
  });

  it("wipes the target directory between clone attempts so transient retries can succeed", async () => {
    let cloneAttempts = 0;
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args.includes("clone")) {
        cloneAttempts += 1;
        if (cloneAttempts === 1) {
          return new Error("fatal: unable to access 'https://example': Could not resolve host: example");
        }
      }
      if (call.args.includes("rev-parse")) {
        return { stdout: "abc999\n" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [gitRepo],
      run,
      resolveEnv: () => undefined,
    });

    expect(results[0]?.status).toBe("ok");
    expect(cloneAttempts).toBe(2);
    expect(calls.filter((call) => call.args.includes("clone"))).toHaveLength(2);
  });

  it("omits auth headers for git repos without a token or with a non-http URL", async () => {
    const sshRepo: ContextRepositoryConfig = {
      alias: "ssh-lib",
      kind: "git",
      url: "git@github.com:org/ssh-lib.git",
      token_env: "SHARED_LIB_TOKEN",
    };
    const { run, calls } = createRecordingRunner();

    await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{ ...gitRepo, token_env: undefined }, sshRepo],
      run,
      resolveEnv: () => "secret-token",
    });

    const clones = calls.filter((call) => call.args.includes("clone"));
    expect(clones).toHaveLength(2);
    for (const clone of clones) {
      expect(clone.args.some((arg) => arg.includes("extraHeader"))).toBe(false);
    }
  });

  it("scrubs tokens from git errors and marks the repo failed without aborting others", async () => {
    const warn = vi.fn();
    const { run } = createRecordingRunner((call) => {
      if (call.args.includes("clone") && call.args.some((arg) => arg.includes("broken"))) {
        return new Error(
          "Command failed: git -c http.extraHeader=Authorization: Bearer secret-token clone https://example.com/broken.git\nfatal: unable to connect",
        );
      }
      if (call.args.includes("rev-parse")) {
        return { stdout: "def456\n" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [
        { ...gitRepo, alias: "broken", url: "https://example.com/broken.git" },
        { ...gitRepo, alias: "healthy", url: "https://example.com/healthy.git" },
      ],
      run,
      resolveEnv: () => "secret-token",
      warn,
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).not.toContain("secret-token");
    expect(results[1]?.status).toBe("ok");
    expect(results[1]?.resolvedRevision).toBe("def456");

    const warnEntry = warn.mock.calls[0]?.[0] as { msg: string; error: string };
    expect(warnEntry.msg).toBe("context repository materialization failed");
    expect(warnEntry.error).not.toContain("secret-token");
  });

  it("exports svn repos with a pinned revision and reports it", async () => {
    const { run, calls } = createRecordingRunner();
    const svnRepo: ContextRepositoryConfig = {
      alias: "svn-lib",
      kind: "svn",
      repository_url: "https://svn.example.com/repos/lib/trunk",
      revision: 1234,
    };

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [svnRepo],
      run,
    });

    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.resolvedRevision).toBe("1234");

    const exportCall = calls.find((call) => call.args[0] === "export");
    expect(exportCall?.args).toContain("--no-auth-cache");
    expect(exportCall?.args).toContain("--revision");
    expect(exportCall?.args).toContain("1234");
    expect(exportCall?.args).toContain("https://svn.example.com/repos/lib/trunk");
  });

  it("queries remote HEAD revision for unpinned svn exports", async () => {
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args[0] === "info") {
        return { stdout: "5678\n" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{
        alias: "svn-lib",
        kind: "svn",
        repository_url: "https://svn.example.com/repos/lib/trunk",
      }],
      run,
    });

    expect(results[0]?.resolvedRevision).toBe("5678");
    expect(calls.some((call) => call.args[0] === "info")).toBe(true);
  });

  it("exports p4 depots via files+print without running p4 sync", async () => {
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args.includes("files")) {
        return {
          stdout: [
            "//depot/lib/src/a.c#3 - edit change 6244 (text)",
            "//depot/lib/src/b.c#2 - delete change 6244 (text)",
            "//depot/lib/include/a.h#1 - add change 6200 (text)",
          ].join("\n"),
        };
      }
      if (call.args.includes("print")) {
        const target = call.args[call.args.length - 1] ?? "";
        return { stdout: `content of ${target}` };
      }
      if (call.args.includes("changes")) {
        return { stdout: "Change 6244 on 2026/08/20 by user@client 'latest'" };
      }
      return {};
    });

    const p4Repo: ContextRepositoryConfig = {
      alias: "p4-lib",
      kind: "p4",
      port: "ssl:p4.example.com:1666",
      user_env: "P4USER",
      ticket_env: "P4TICKET",
      depot_path: "//depot/lib/...",
    };

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [p4Repo],
      run,
      resolveEnv: (name) => (name === "P4USER" ? "bot" : name === "P4TICKET" ? "ticket-value" : undefined),
    });

    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.resolvedRevision).toBe("6244");
    expect(results[0]?.fileCount).toBe(2);

    expect(calls.some((call) => call.args.includes("trust"))).toBe(false);
    expect(calls.some((call) => call.args.includes("sync"))).toBe(false);

    const printed = calls
      .filter((call) => call.args.includes("print"))
      .map((call) => call.args[call.args.length - 1])
      .sort();
    expect(printed).toEqual([
      "//depot/lib/include/a.h",
      "//depot/lib/src/a.c",
    ]);

    const content = await readFile(join(tempDir, "p4-lib", "src", "a.c"), "utf8");
    expect(content).toBe("content of //depot/lib/src/a.c");

    const loginEnv = calls.find((call) => call.args.includes("files"))?.env;
    expect(loginEnv).toEqual({ P4PASSWD: "ticket-value" });
  });

  it("skips p4 move/delete entries instead of failing the whole repo", async () => {
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args.includes("files")) {
        return {
          stdout: [
            "//depot/lib/moved.c#5 - move/delete change 6300 (text)",
            "//depot/lib/kept.c#2 - edit change 6300 (text)",
          ].join("\n"),
        };
      }
      if (call.args.includes("print")) {
        return { stdout: "kept" };
      }
      if (call.args.includes("changes")) {
        return { stdout: "Change 6300 on 2026/08/21 by u@c 'x'" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{ alias: "p4-lib", kind: "p4", depot_path: "//depot/lib/..." }],
      run,
      resolveEnv: () => undefined,
    });

    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.fileCount).toBe(1);
    const printed = calls.filter((call) => call.args.includes("print"));
    expect(printed.map((call) => call.args[call.args.length - 1])).toEqual(["//depot/lib/kept.c"]);
  });

  it("writes p4 binary files byte-faithfully via buffer stdout", async () => {
    const binaryBytes = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x80]);
    const { run } = createRecordingRunner((call) => {
      if (call.args.includes("files")) {
        return { stdout: "//depot/lib/blob.bin#1 - add change 1 (binary)" };
      }
      if (call.args.includes("print")) {
        return { stdout: binaryBytes };
      }
      if (call.args.includes("changes")) {
        return { stdout: "Change 1 on 2026/08/21 by u@c 'x'" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{ alias: "p4-lib", kind: "p4", depot_path: "//depot/lib/..." }],
      run,
      resolveEnv: () => undefined,
    });

    expect(results[0]?.status).toBe("ok");
    const written = await readFile(join(tempDir, "p4-lib", "blob.bin"));
    expect(Buffer.compare(written, binaryBytes)).toBe(0);
  });

  it("retries p4 commands after trust and falls back to trust -y -f on fingerprint rotation", async () => {
    let filesAttempts = 0;
    const trustCalls: string[][] = [];
    const { run } = createRecordingRunner((call) => {
      if (call.args.includes("trust")) {
        trustCalls.push([...call.args]);
        if (trustCalls.length === 1) {
          return new Error("P4PORT IDENTIFICATION HAS CHANGED");
        }
        return {};
      }
      if (call.args.includes("files")) {
        filesAttempts += 1;
        if (filesAttempts === 1) {
          return new Error("The authenticity of 'p4.example.com:1666' can't be established");
        }
        return { stdout: "//depot/lib/a.c#1 - add change 1 (text)" };
      }
      if (call.args.includes("print")) {
        return { stdout: "x" };
      }
      if (call.args.includes("changes")) {
        return { stdout: "Change 1 on 2026/08/21 by u@c 'x'" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{
        alias: "p4-lib",
        kind: "p4",
        port: "ssl:p4.example.com:1666",
        depot_path: "//depot/lib/...",
      }],
      run,
      resolveEnv: () => undefined,
    });

    expect(results[0]?.status).toBe("ok");
    expect(trustCalls.map((args) => args.slice(args.indexOf("trust") + 1).join(" "))).toEqual(["-y", "-y -f"]);
    expect(filesAttempts).toBe(2);
  });

  it("retries p4 login when the session or ticket has expired", async () => {
    let filesAttempts = 0;
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args.includes("files")) {
        filesAttempts += 1;
        if (filesAttempts === 1) {
          return new Error("Your session has expired, please login again.");
        }
        return { stdout: "//depot/lib/a.c#1 - add change 1 (text)" };
      }
      if (call.args.includes("print")) {
        return { stdout: "x" };
      }
      if (call.args.includes("changes")) {
        return { stdout: "Change 1 on 2026/08/21 by u@c 'x'" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{
        alias: "p4-lib",
        kind: "p4",
        port: "p4.example.com:1666",
        user_env: "P4USER",
        password_env: "P4PASS",
        depot_path: "//depot/lib/...",
      }],
      run,
      resolveEnv: (name) => (name === "P4USER" ? "bot" : name === "P4PASS" ? "pw" : undefined),
    });

    expect(results[0]?.status).toBe("ok");
    expect(calls.some((call) => call.args.includes("login") && call.stdin === "pw\n")).toBe(true);
  });

  it("fails fast when a p4 depot exceeds the file count cap", async () => {
    const listing = Array.from(
      { length: 5001 },
      (_, index) => `//depot/lib/f${index}.c#1 - add change 1 (text)`,
    ).join("\n");
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args.includes("files")) {
        return { stdout: listing };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{ alias: "p4-lib", kind: "p4", depot_path: "//depot/lib/..." }],
      run,
      resolveEnv: () => undefined,
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("5001 files");
    expect(calls.some((call) => call.args.includes("print"))).toBe(false);
  });

  it("sweeps stale alias directories and cleans up failed materializations", async () => {
    const staleDir = join(tempDir, "old-alias");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "leftover.txt"), "stale");

    const warn = vi.fn();
    const { run } = createRecordingRunner(() => new Error("fatal: Could not resolve host"));

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{ alias: "new-alias", kind: "git", url: "https://example.com/a.git" }],
      run,
      resolveEnv: () => undefined,
      warn,
    });

    expect(results[0]?.status).toBe("failed");
    await expect(readdir(staleDir)).rejects.toThrow();
    await expect(readdir(join(tempDir, "new-alias"))).rejects.toThrow();
    expect(warn.mock.calls.some(([entry]) =>
      (entry as { msg?: string }).msg === "removing stale context repository directory"
    )).toBe(true);
  });

  it("retries p4 with login once on authentication errors", async () => {
    let filesAttempts = 0;
    const { run, calls } = createRecordingRunner((call) => {
      if (call.args.includes("files")) {
        filesAttempts += 1;
        if (filesAttempts === 1) {
          return new Error("Perforce password (P4PASSWD) invalid or unset.");
        }
        return { stdout: "//depot/lib/a.c#1 - add change 1 (text)" };
      }
      if (call.args.includes("print")) {
        return { stdout: "x" };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{
        alias: "p4-lib",
        kind: "p4",
        port: "p4.example.com:1666",
        user_env: "P4USER",
        password_env: "P4PASS",
        depot_path: "//depot/lib/...",
      }],
      run,
      resolveEnv: (name) => (name === "P4USER" ? "bot" : name === "P4PASS" ? "pw" : undefined),
    });

    expect(results[0]?.status).toBe("ok");
    const login = calls.find((call) => call.args.includes("login"));
    expect(login?.stdin).toBe("pw\n");
  });

  it("enforces the max_mb cap and removes oversized materializations", async () => {
    const bigContent = "x".repeat(1024 * 1024 + 1);
    const { run } = createRecordingRunner((call) => {
      if (call.args.includes("files")) {
        return { stdout: "//depot/lib/big.bin#1 - add change 1 (binary)" };
      }
      if (call.args.includes("print")) {
        return { stdout: bigContent };
      }
      return {};
    });

    const results = await materializeContextRepositories({
      contextReposRoot: tempDir,
      repos: [{
        alias: "p4-lib",
        kind: "p4",
        depot_path: "//depot/lib/...",
        max_mb: 1,
      }],
      run,
      resolveEnv: () => undefined,
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("exceeded the size cap during p4 export");
    await expect(readdir(join(tempDir, "p4-lib"))).rejects.toThrow();
  });
});

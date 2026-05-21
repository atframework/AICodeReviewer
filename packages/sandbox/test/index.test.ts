import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, afterEach } from "vitest";

import {
  sandboxPackageName,
  createNativeSandboxBackend,
  createDockerSandboxBackend,
  ALLOWED_COMMANDS,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_TIMEOUT_MS,
  GRACE_PERIOD_MS,
} from "../src/index.js";
import type { SandboxWorkspaceLayout } from "../src/types.js";

describe("@aicr/sandbox", () => {
  it("exports the package name", () => {
    expect(sandboxPackageName).toBe("@aicr/sandbox");
  });

  describe("exports constants", () => {
    it("exports ALLOWED_COMMANDS with expected entries", () => {
      expect(ALLOWED_COMMANDS.has("git")).toBe(true);
      expect(ALLOWED_COMMANDS.has("node")).toBe(true);
      expect(ALLOWED_COMMANDS.has("kilo")).toBe(true);
      expect(ALLOWED_COMMANDS.has("rm")).toBe(false);
      expect(ALLOWED_COMMANDS.has("sudo")).toBe(false);
    });

    it("exports DEFAULT_SANDBOX_IMAGE", () => {
      expect(DEFAULT_SANDBOX_IMAGE).toBe("ghcr.io/owent/aicr-agent:latest");
    });

    it("exports DEFAULT_TIMEOUT_MS", () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
    });

    it("exports GRACE_PERIOD_MS", () => {
      expect(GRACE_PERIOD_MS).toBe(5_000);
    });
  });
});

describe("createNativeSandboxBackend", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
    );
    tempDirs.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "aicr-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("creates a backend with kind 'native'", () => {
    const backend = createNativeSandboxBackend();
    expect(backend.kind).toBe("native");
  });

  it("spawns an allowed command and captures output", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    const result = await backend.spawn({
      command: ["node", "-e", "console.log('hello sandbox')"],
      cwd,
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello sandbox");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("captures stderr", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    const result = await backend.spawn({
      command: ["node", "-e", "process.stderr.write('err output')"],
      cwd,
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("err output");
  });

  it("rejects commands not in the allow list", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    await expect(
      backend.spawn({
        command: ["rm", "-rf", "/"],
        cwd,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow('not in the allowed list');
  });

  it("rejects empty command", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    await expect(
      backend.spawn({
        command: [],
        cwd,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("must not be empty");
  });

  it("supports custom allowed commands", async () => {
    const custom = new Set(["echo"]);
    const backend = createNativeSandboxBackend({ allowedCommands: custom });
    const cwd = await makeTempDir();

    await expect(
      backend.spawn({
        command: ["node", "-e", "console.log('test')"],
        cwd,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("not in the allowed list");
  });

  it("handles non-zero exit codes", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    const result = await backend.spawn({
      command: ["node", "-e", "process.exit(42)"],
      cwd,
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(42);
  });

  it("passes environment variables", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    const result = await backend.spawn({
      command: ["node", "-e", "console.log(process.env.AICR_TEST_VAR)"],
      cwd,
      env: { AICR_TEST_VAR: "injected-value" },
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("injected-value");
  });

  it("passes stdin to the process", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    const result = await backend.spawn({
      command: ["node", "-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log('got:'+d))"],
      cwd,
      stdin: "test-input",
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("got:test-input");
  });

  it("closes stdin even when no input is provided", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    const result = await backend.spawn({
      command: ["node", "-e", "process.stdin.on('end',()=>console.log('closed'));process.stdin.resume()"],
      cwd,
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("closed");
    expect(result.timedOut).toBe(false);
  });

  it("times out long-running processes", async () => {
    const backend = createNativeSandboxBackend();
    const cwd = await makeTempDir();

    const result = await backend.spawn({
      command: ["node", "-e", "setTimeout(() => {}, 60000)"],
      cwd,
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  describe("materializeFs", () => {
    it("creates agent and tmp directories", async () => {
      const base = await makeTempDir();
      const backend = createNativeSandboxBackend();
      const layout: SandboxWorkspaceLayout = {
        agentDir: join(base, "agent"),
        tmpDir: join(base, "tmp"),
      };

      const result = await backend.materializeFs(layout);

      expect(result.agentDir).toBe(join(base, "agent"));
      expect(result.tmpDir).toBe(join(base, "tmp"));
      expect(result.mountSpecs).toHaveLength(2);
      expect(result.mountSpecs[0]?.containerPath).toBe("/workspace/agent");
      expect(result.mountSpecs[1]?.containerPath).toBe("/workspace/tmp");
    });

    it("includes source mount when sourceDir is provided", async () => {
      const base = await makeTempDir();
      const backend = createNativeSandboxBackend();
      const layout: SandboxWorkspaceLayout = {
        sourceDir: join(base, "source"),
        agentDir: join(base, "agent"),
        tmpDir: join(base, "tmp"),
      };

      const result = await backend.materializeFs(layout);

      expect(result.mountSpecs).toHaveLength(3);
      const sourceMount = result.mountSpecs.find((m) => m.containerPath === "/workspace/source");
      expect(sourceMount).toBeDefined();
      expect(sourceMount?.readOnly).toBe(true);
    });

    it("includes extra mounts", async () => {
      const base = await makeTempDir();
      const backend = createNativeSandboxBackend();
      const layout: SandboxWorkspaceLayout = {
        agentDir: join(base, "agent"),
        tmpDir: join(base, "tmp"),
        extraMounts: [
          { hostPath: "/data/config", containerPath: "/config", readOnly: true },
        ],
      };

      const result = await backend.materializeFs(layout);

      expect(result.mountSpecs).toHaveLength(3);
      const extraMount = result.mountSpecs.find((m) => m.containerPath === "/config");
      expect(extraMount).toBeDefined();
    });
  });

  describe("teardown", () => {
    it("does not throw", async () => {
      const backend = createNativeSandboxBackend();
      await expect(backend.teardown()).resolves.toBeUndefined();
    });
  });
});

describe("createDockerSandboxBackend", () => {
  it("uses materialized source, agent, and tmp mounts when spawning", async () => {
    const calls: { engine: string; args: readonly string[] }[] = [];
    const backend = createDockerSandboxBackend({
      kind: "docker",
      image: "aicr-test-image",
      commandRunner: async (engine, args) => {
        calls.push({ engine, args });
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    });
    const base = await mkdtemp(join(tmpdir(), "aicr-docker-sandbox-"));

    try {
      await backend.materializeFs({
        sourceDir: join(base, "source"),
        agentDir: join(base, "agent"),
        tmpDir: join(base, "tmp"),
      });

      await backend.spawn({
        command: ["node", "agent.js"],
        cwd: join(base, "agent"),
      });

      expect(calls[0]?.engine).toBe("docker");
      expect(calls[0]?.args).toEqual(
        expect.arrayContaining([
          "--workdir",
          "/workspace/agent",
          "-v",
          `${join(base, "source")}:/workspace/source:ro`,
          "-v",
          `${join(base, "agent")}:/workspace/agent:rw`,
          "-v",
          `${join(base, "tmp")}:/workspace/tmp:rw`,
        ]),
      );
    } finally {
      await backend.teardown();
      await rm(base, { recursive: true, force: true });
    }
  });
});

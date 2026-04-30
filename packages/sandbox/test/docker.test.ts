import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { preflightSandbox, createDockerSandboxBackend } from "../src/docker.js";

describe("createDockerSandboxBackend", () => {
  it("creates a backend with kind 'docker'", () => {
    const backend = createDockerSandboxBackend();
    expect(backend.kind).toBe("docker");
  });

  it("uses default image when none specified", () => {
    const backend = createDockerSandboxBackend();
    expect(backend.kind).toBe("docker");
  });

  it("uses custom image when specified", () => {
    const backend = createDockerSandboxBackend({ image: "custom:latest" });
    expect(backend.kind).toBe("docker");
  });

  it("defaults engine to 'auto'", () => {
    const backend = createDockerSandboxBackend();
    expect(backend.engine).toBe("auto");
  });

  it("sets engine to 'podman' when configured", () => {
    const backend = createDockerSandboxBackend({ engine: "podman" });
    expect(backend.engine).toBe("podman");
  });

  it("uses podman CLI when the backend kind is podman", async () => {
    const calls: string[] = [];
    const backend = createDockerSandboxBackend({
      kind: "podman",
      commandRunner: async (engine) => {
        calls.push(engine);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });

    const result = await backend.spawn({
      command: ["node", "-e", "console.log('ok')"],
      cwd: "/tmp/aicr-agent",
      timeoutMs: 1000,
    });

    expect(backend.kind).toBe("podman");
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(["podman"]);
  });

  it("rejects disallowed commands before invoking the container engine", async () => {
    let invoked = false;
    const backend = createDockerSandboxBackend({
      commandRunner: async () => {
        invoked = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.spawn({
        command: ["rm", "-rf", "/"],
        cwd: "/tmp/aicr-agent",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("not in the allowed list");
    expect(invoked).toBe(false);
  });

  it("rejects shell-wrapped escape commands before invoking the container engine", async () => {
    let invoked = false;
    const backend = createDockerSandboxBackend({
      commandRunner: async () => {
        invoked = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.spawn({
        command: ["sh", "-c", "rm -rf /workspace/source"],
        cwd: "/tmp/aicr-agent",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("not in the allowed list");
    expect(invoked).toBe(false);
  });

  it("keeps generated env files outside the mounted agent workspace", async () => {
    const base = await mkdtemp(join(tmpdir(), "aicr-docker-env-"));
    const agentDir = join(base, "agent");
    let envFilePath: string | undefined;
    const backend = createDockerSandboxBackend({
      commandRunner: async (_engine, args) => {
        const envFileIndex = args.indexOf("--env-file");
        envFilePath = typeof args[envFileIndex + 1] === "string"
          ? args[envFileIndex + 1]
          : undefined;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });

    try {
      await backend.materializeFs({ agentDir, tmpDir: join(base, "tmp") });
      await backend.spawn({
        command: ["node", "agent.js"],
        cwd: agentDir,
        env: { AICR_SECRET: "super-secret" },
        timeoutMs: 1000,
      });

      expect(envFilePath).toBeDefined();
      expect(envFilePath?.startsWith(agentDir)).toBe(false);
    } finally {
      await backend.teardown();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("cleans generated env files when the container runner throws", async () => {
    const base = await mkdtemp(join(tmpdir(), "aicr-docker-env-error-"));
    let envFilePath: string | undefined;
    const backend = createDockerSandboxBackend({
      commandRunner: async (_engine, args) => {
        const envFileIndex = args.indexOf("--env-file");
        envFilePath = typeof args[envFileIndex + 1] === "string"
          ? args[envFileIndex + 1]
          : undefined;
        throw new Error("container failed to start");
      },
    });

    try {
      await expect(
        backend.spawn({
          command: ["node", "agent.js"],
          cwd: join(base, "agent"),
          env: { AICR_SECRET: "super-secret" },
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("container failed to start");

      expect(envFilePath).toBeDefined();
      expect(existsSync(envFilePath!)).toBe(false);
    } finally {
      await backend.teardown();
      await rm(base, { recursive: true, force: true });
    }
  });

  describe("materializeFs", () => {
    it("creates mount specs with correct structure", async () => {
      const backend = createDockerSandboxBackend();
      const layout = {
        agentDir: "/tmp/test-agent",
        tmpDir: "/tmp/test-tmp",
      };

      const result = await backend.materializeFs(layout);

      expect(result.agentDir).toBe("/tmp/test-agent");
      expect(result.tmpDir).toBe("/tmp/test-tmp");
      expect(result.mountSpecs).toHaveLength(2);
      expect(result.mountSpecs[0]?.readOnly).toBe(false);
      expect(result.mountSpecs[1]?.readOnly).toBe(false);
    });

    it("spawns containers with network disabled and without host container socket mounts", async () => {
      const calls: Array<{ args: readonly string[] }> = [];
      const backend = createDockerSandboxBackend({
        commandRunner: async (_engine, args) => {
          calls.push({ args });
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      });
      const base = await mkdtemp(join(tmpdir(), "aicr-docker-isolation-"));

      try {
        await backend.materializeFs({
          sourceDir: join(base, "source"),
          agentDir: join(base, "agent"),
          tmpDir: join(base, "tmp"),
        });

        await backend.spawn({
          command: ["node", "agent.js"],
          cwd: join(base, "agent"),
          timeoutMs: 1000,
        });

        const args = calls[0]?.args ?? [];
        expect(args).toEqual(expect.arrayContaining(["--network", "none"]));
        expect(args.join(" ")).not.toContain("/var/run/docker.sock");
        expect(args.join(" ")).not.toContain("/run/podman/podman.sock");
      } finally {
        await backend.teardown();
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  describe("teardown", () => {
    it("does not throw", async () => {
      const backend = createDockerSandboxBackend();
      await expect(backend.teardown()).resolves.toBeUndefined();
    });
  });
});

describe("preflightSandbox", () => {
  it("returns a result with available boolean", async () => {
    const result = await preflightSandbox();
    expect(typeof result.available).toBe("boolean");
    expect(result.engine === "docker" || result.engine === "podman").toBe(true);
  });

  it("checks only podman when podman is explicitly requested", async () => {
    const calls: string[] = [];
    const result = await preflightSandbox("podman", async (engine) => {
      calls.push(engine);
      return { stdout: "podman version 5.0.0", stderr: "", exitCode: 0 };
    });

    expect(result).toEqual({ engine: "podman", available: true, version: "5.0.0" });
    expect(calls).toEqual(["podman"]);
  });

  it("falls back from docker to podman in auto mode", async () => {
    const calls: string[] = [];
    const result = await preflightSandbox("auto", async (engine) => {
      calls.push(engine);
      if (engine === "docker") {
        return { stdout: "", stderr: "missing", exitCode: 1 };
      }
      return { stdout: "podman version 5.0.0", stderr: "", exitCode: 0 };
    });

    expect(result).toEqual({ engine: "podman", available: true, version: "5.0.0" });
    expect(calls).toEqual(["docker", "podman"]);
  });
});

import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  SandboxBackend,
  SandboxEngine,
  SandboxKind,
  SandboxSpawnOptions,
  SandboxSpawnResult,
  SandboxWorkspaceLayout,
  SandboxMaterializeResult,
  SandboxMountSpec,
} from "./types.js";
import { parseAllowedCommand } from "./command.js";
import { ALLOWED_COMMANDS, DEFAULT_SANDBOX_IMAGE, DEFAULT_TIMEOUT_MS, GRACE_PERIOD_MS } from "./types.js";

type ContainerEngine = "docker" | "podman";

interface ContainerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

interface ContainerCommandOptions {
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

export type ContainerCommandRunner = (
  engine: ContainerEngine,
  args: readonly string[],
  options?: ContainerCommandOptions,
) => Promise<ContainerCommandResult>;

export interface DockerSandboxOptions {
  readonly kind?: Extract<SandboxKind, "docker" | "podman" | "docker_socket">;
  readonly image?: string;
  readonly engine?: SandboxEngine;
  readonly networkAllowlist?: readonly string[];
  readonly commandAllowlist?: ReadonlySet<string>;
  readonly commandRunner?: ContainerCommandRunner;
}

const execContainerCommand: ContainerCommandRunner = async function execContainerCommand(
  engine,
  args: readonly string[],
  options?: {
    readonly timeoutMs?: number;
    readonly stdin?: string;
  },
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolvePromise) => {
    const proc = spawn(engine, args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", () => {
      finish(1);
    });

    proc.on("close", (code) => {
      finish(code);
    });

    if (options?.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    if (options?.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, options.timeoutMs);
    }
  });
};

export async function preflightSandbox(
  engine?: SandboxEngine,
  commandRunner: ContainerCommandRunner = execContainerCommand,
): Promise<{ readonly engine: "docker" | "podman"; readonly available: boolean; readonly version?: string }> {
  const tryEngine = async (name: "docker" | "podman") => {
    const result = await commandRunner(name, ["--version"]);
    if (result.exitCode === 0) {
      const match = /\d+\.\d+\.\d+/.exec(result.stdout);
      const version = match?.[0];
      if (version) {
        return { engine: name, available: true, version };
      }
      return { engine: name, available: true };
    }
    return { engine: name, available: false };
  };

  if (engine === "podman") {
    return tryEngine("podman");
  }

  if (engine === "docker") {
    return tryEngine("docker");
  }

  const dockerResult = await tryEngine("docker");
  if (dockerResult.available) return dockerResult;

  return tryEngine("podman");
}

export function createDockerSandboxBackend(options: DockerSandboxOptions = {}): SandboxBackend {
  const kind = options.kind ?? "docker";
  const engine = kind === "podman" ? "podman" : options.engine ?? "auto";
  const containerCli: ContainerEngine = engine === "podman" ? "podman" : "docker";
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const allowedCommands = options.commandAllowlist ?? ALLOWED_COMMANDS;
  const commandRunner = options.commandRunner ?? execContainerCommand;
  const containerIds: string[] = [];
  let envFiles: string[] = [];
  let activeMounts: readonly SandboxMountSpec[] = [];

  return {
    kind,
    engine,

    async spawn(spawnOptions: SandboxSpawnOptions): Promise<SandboxSpawnResult> {
      parseAllowedCommand(spawnOptions.command, allowedCommands);
      const containerName = `aicr-${randomUUID().slice(0, 12)}`;
      const timeoutMs = spawnOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const start = Date.now();

      const envArgs: string[] = [];

      if (spawnOptions.env) {
        const envFilePath = join(
          spawnOptions.cwd,
          `.aicr-env-${containerName}`,
        );
        const envLines = Object.entries(spawnOptions.env)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");
        await writeFile(envFilePath, envLines, "utf8");
        envFiles.push(envFilePath);
        envArgs.push("--env-file", envFilePath);
      }

      const volumeArgs = activeMounts.length > 0
        ? activeMounts.flatMap((mount) => [
            "-v",
            `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}`,
          ])
        : ["-v", `${spawnOptions.cwd}:/workspace/agent:rw`];

      const dockerArgs = [
        "run",
        "--name", containerName,
        "--rm",
        "--init",
        "--network", "none",
        ...envArgs,
        ...volumeArgs,
        image,
        ...spawnOptions.command,
      ];

      const effectiveTimeout = timeoutMs + GRACE_PERIOD_MS;
      const result = await commandRunner(containerCli, dockerArgs, {
        timeoutMs: effectiveTimeout,
        ...(spawnOptions.stdin ? { stdin: spawnOptions.stdin } : {}),
      });

      containerIds.push(containerName);

      await cleanupEnvFiles();

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.exitCode === null,
        durationMs: Date.now() - start,
      };
    },

    async materializeFs(layout: SandboxWorkspaceLayout): Promise<SandboxMaterializeResult> {
      await mkdir(layout.agentDir, { recursive: true });
      await mkdir(layout.tmpDir, { recursive: true });

      const mountSpecs: SandboxMountSpec[] = [
        { hostPath: layout.agentDir, containerPath: "/workspace/agent", readOnly: false },
        { hostPath: layout.tmpDir, containerPath: "/workspace/tmp", readOnly: false },
      ];

      if (layout.sourceDir) {
        mountSpecs.push({
          hostPath: layout.sourceDir,
          containerPath: "/workspace/source",
          readOnly: true,
        });
      }

      if (layout.extraMounts) {
        mountSpecs.push(...layout.extraMounts);
      }

      activeMounts = mountSpecs;

      return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs };
    },

    async teardown(): Promise<void> {
      await cleanupEnvFiles();

      for (const id of containerIds) {
        try {
          await commandRunner(containerCli, ["rm", "-f", id], { timeoutMs: 10_000 });
        } catch {
          // best-effort cleanup
        }
      }
      containerIds.length = 0;
      activeMounts = [];
    },
  };

  async function cleanupEnvFiles(): Promise<void> {
    const files = envFiles;
    envFiles = [];
    await Promise.all(files.map((f) => unlink(f).catch(() => {})));
  }
}

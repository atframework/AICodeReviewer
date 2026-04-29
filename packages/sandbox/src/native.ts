import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import type {
  SandboxBackend,
  SandboxKind,
  SandboxSpawnOptions,
  SandboxSpawnResult,
  SandboxWorkspaceLayout,
  SandboxMaterializeResult,
  SandboxMountSpec,
} from "./types.js";
import { parseAllowedCommand } from "./command.js";
import { ALLOWED_COMMANDS, DEFAULT_TIMEOUT_MS, GRACE_PERIOD_MS } from "./types.js";

export function createNativeSandboxBackend(
  options: { readonly allowedCommands?: ReadonlySet<string> } = {},
): SandboxBackend {
  const allowedCommands = options.allowedCommands ?? ALLOWED_COMMANDS;

  return {
    kind: "native" as SandboxKind,

    async spawn(spawnOptions: SandboxSpawnOptions): Promise<SandboxSpawnResult> {
      const { command, args } = parseAllowedCommand(spawnOptions.command, allowedCommands);
      const timeoutMs = spawnOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const start = Date.now();

      return new Promise<SandboxSpawnResult>((resolvePromise) => {
        const proc = spawn(command, args, {
          cwd: spawnOptions.cwd,
          env: { ...process.env, ...spawnOptions.env },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const timers: { main?: ReturnType<typeof setTimeout>; kill?: ReturnType<typeof setTimeout> } = {};

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          if (timers.main !== undefined) clearTimeout(timers.main);
          if (timers.kill !== undefined) clearTimeout(timers.kill);
          resolvePromise({
            exitCode,
            stdout,
            stderr,
            timedOut,
            durationMs: Date.now() - start,
          });
        };

        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        proc.on("error", (error: Error) => {
          stderr += `\nSpawn error: ${error.message}`;
          finish(1);
        });

        proc.on("close", (code) => {
          finish(code);
        });

        if (spawnOptions.stdin !== undefined) {
          proc.stdin.write(spawnOptions.stdin);
        }
        proc.stdin.end();

        timers.main = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");

          timers.kill = setTimeout(() => {
            if (!settled) {
              proc.kill("SIGKILL");
            }
          }, GRACE_PERIOD_MS);
        }, timeoutMs);
      });
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

      return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs };
    },

    async teardown(): Promise<void> {
      // native backend has no persistent resources to clean up beyond
      // what materializeFs created, which the caller manages.
    },
  };
}

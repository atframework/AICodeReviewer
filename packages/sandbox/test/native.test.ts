import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeSandboxBackend } from "../src/native.js";
import { GRACE_PERIOD_MS } from "../src/types.js";

// Agent helper: spawns a grandchild worker (inheriting stdio) that keeps
// writing a heartbeat, swallows SIGTERM, and outlives the sandbox timeout.
// With the OLD timeout code only the direct child was signalled, so the
// grandchild was reparented to init, kept holding the inherited stdio pipes,
// and the spawn promise never resolved (death spiral). The fix must kill the
// whole process tree so the grandchild dies and `close` fires promptly.
const AGENT_SCRIPT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));

spawn(process.execPath, [process.env.WORKER_SCRIPT], {
  stdio: "inherit",
  env: { ...process.env },
});

process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
setTimeout(() => {}, 600000);
`;

// Variant of AGENT_SCRIPT that spawns the worker in its OWN session
// (detached: true -> setsid). This mirrors real agent binaries such as the
// Kilo CLI, whose worker subprocesses escape into a new process group/session
// (confirmed in production: orphaned workers had pgid == sid != spawn group).
// A kill(-rootPid) group signal cannot reach such workers, so they survive the
// timeout as orphans. The fix walks /proc by PPID to kill them anyway.
const AGENT_SCRIPT_SETSID_WORKER = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));

// detached: true places the worker in a brand-new session/process group.
const worker = spawn(process.execPath, [process.env.WORKER_SCRIPT], {
  stdio: "inherit",
  env: { ...process.env },
  detached: true,
});
worker.unref();

process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
setTimeout(() => {}, 600000);
`;

const WORKER_SCRIPT = `
import { appendFileSync } from "node:fs";

const hb = process.env.HEARTBEAT_FILE;
const beat = () => { try { appendFileSync(hb, Date.now() + "\\n"); } catch {} };
beat();
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
setInterval(beat, 100);
// Self-termination ceiling so an interrupted test cannot leak an immortal
// detached orphan even if the sandbox's kill cascade never runs.
setTimeout(() => process.exit(0), 20000);
`;

async function heartbeatLineCount(file: string): Promise<number> {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(file, "utf8");
    return content.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

describe("createNativeSandboxBackend", () => {
  it("has kind 'native'", () => {
    expect(createNativeSandboxBackend().kind).toBe("native");
  });

  it("kills the whole process tree on timeout instead of orphaning grandchildren", async () => {
    const base = await mkdtemp(join(tmpdir(), "aicr-native-timeout-"));
    const agentScript = join(base, "agent.mjs");
    const workerScript = join(base, "worker.mjs");
    const heartbeatFile = join(base, "heartbeat.log");
    const agentPidFile = join(base, "agent.pid");
    await writeFile(agentScript, AGENT_SCRIPT, "utf8");
    await writeFile(workerScript, WORKER_SCRIPT, "utf8");

    const backend = createNativeSandboxBackend();
    const timeoutMs = 700;

    try {
      const result = await backend.spawn({
        command: ["node", agentScript],
        cwd: base,
        env: {
          HEARTBEAT_FILE: heartbeatFile,
          WORKER_SCRIPT: workerScript,
          AGENT_PID_FILE: agentPidFile,
        },
        timeoutMs,
      });

      // It must have timed out (not exited cleanly).
      expect(result.timedOut).toBe(true);
      // The promise must resolve boundedly shortly after the timeout + grace
      // cascade, rather than hanging until grandchildren die on their own.
      expect(result.durationMs).toBeGreaterThanOrEqual(timeoutMs);
      expect(result.durationMs).toBeLessThan(timeoutMs + 3 * GRACE_PERIOD_MS + 5_000);
      // The grandchild worker ran long enough to write at least one heartbeat.
      expect(await heartbeatLineCount(heartbeatFile)).toBeGreaterThan(0);

      // After the tree is killed, the grandchild must stop writing heartbeats.
      const before = await heartbeatLineCount(heartbeatFile);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await heartbeatLineCount(heartbeatFile);
      expect(after).toBe(before);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("kills worker subprocesses that escaped into their own session (setsid)", async () => {
    // Skip on platforms without /proc: the setsid-escape fix relies on a
    // /proc PPID walk that only exists on Linux.
    if (process.platform !== "linux") {
      return;
    }

    const base = await mkdtemp(join(tmpdir(), "aicr-native-setsid-"));
    const agentScript = join(base, "agent.mjs");
    const workerScript = join(base, "worker.mjs");
    const heartbeatFile = join(base, "heartbeat.log");
    const agentPidFile = join(base, "agent.pid");
    await writeFile(agentScript, AGENT_SCRIPT_SETSID_WORKER, "utf8");
    await writeFile(workerScript, WORKER_SCRIPT, "utf8");

    const backend = createNativeSandboxBackend();
    const timeoutMs = 700;

    try {
      const result = await backend.spawn({
        command: ["node", agentScript],
        cwd: base,
        env: {
          HEARTBEAT_FILE: heartbeatFile,
          WORKER_SCRIPT: workerScript,
          AGENT_PID_FILE: agentPidFile,
        },
        timeoutMs,
      });

      expect(result.timedOut).toBe(true);
      // The worker must have run and heartbeated before the timeout fired.
      expect(await heartbeatLineCount(heartbeatFile)).toBeGreaterThan(0);

      // After the whole-tree kill, the setsid'd worker must stop heartbeating.
      // With the old killProcessTree (group signal only) this worker survived
      // because it lived in a foreign session, so `after` kept growing.
      const before = await heartbeatLineCount(heartbeatFile);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await heartbeatLineCount(heartbeatFile);
      expect(after).toBe(before);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 30_000);
});

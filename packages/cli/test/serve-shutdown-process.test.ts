import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../..");
for (const backend of ["sqlite", "redis"] as const) {
  it.skipIf(backend === "redis" && !process.env.AICR_REDIS_TEST_URL)(`serve ${backend}: process drains and exits without forced termination`, async () => {
    mkdirSync(join(root, "build/tmp"), { recursive: true });
    const dir = mkdtempSync(join(root, "build/tmp/serve-signal-"));
    const probe = createServer();
    await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(done => probe.close(() => done()));
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({
      llm: { providers: [{ id: "local", kind: "ollama" }], model_chain: { default: [{ provider: "local", model: "test", role: "any" }] }, model_catalog: { enabled: false } },
      server: { hostname: "127.0.0.1", port },
      queue: backend === "sqlite" ? { kind: "sqlite", sqlite: { path: join(dir, "queue.sqlite") } } :
        { kind: "redis", redis: { url_env: "AICR_REDIS_TEST_URL", key_prefix: `signal-${port}` } },
      storage: { database: { kind: "sqlite", sqlite: { path: join(dir, "config.sqlite") } }, object: { filesystem: { root: join(dir, "objects") } } },
      config_sources: { database: { enabled: true, namespace: `signal-${port}` } },
      workspaces: { root: join(dir, "workspaces"), instances: {} },
    }));
    const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href,
      join(import.meta.dirname, "fixtures/serve-signal-child.mts"), "serve", "--config", config,
      "--base-prompt", join(root, "prompts/system/code-reviewer.system.md")],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", errors = "";
    const exited = new Promise<number | null>(done => child.once("exit", code => done(code)));
    const ready = new Promise<void>((done, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`CLI exited ${code}: ${errors}`)));
      child.stderr!.on("data", data => { errors += String(data); });
      child.stdout!.on("data", data => {
        output += String(data);
        if (output.includes("AICR server listening on port")) done();
      });
    });
    try {
      await ready;
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      if (process.platform === "win32") child.send("SIGTERM"); else child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(output).toContain("AICR server drained and closed.");
      expect(errors).not.toContain("has not drained cleanly");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 30_000);
}

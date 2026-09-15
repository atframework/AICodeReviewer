import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PG_CONFIG_MIGRATION_LOCK_KEY } from "../src/pg-config-store.js";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const childFile = join(import.meta.dirname, "fixtures/migration-version-child.mts");
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/migration-c5d221c.json"), "utf8"));
const historical = readFileSync(join(import.meta.dirname, "fixtures/migration-c5d221c.mjs.txt"));
const currentModule = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;
const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done()); child.kill();
  })));
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function setup(): { dir: string; oldModule: string } {
  expect(createHash("sha256").update(historical).digest("hex")).toBe(manifest.sha256);
  mkdirSync(join(root, "build/tmp"), { recursive: true });
  const dir = mkdtempSync(join(root, "build/tmp/version-process-"));
  dirs.push(dir);
  writeFileSync(join(dir, "historical.mjs"), historical);
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(dir, "node_modules"), "junction");
  return { dir, oldModule: pathToFileURL(join(dir, "historical.mjs")).href };
}

function cleanupBackend(kind: string, url: string | undefined, schema: string): void {
  if (kind === "postgres") cleanups.push(async () => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url });
    await client.connect();
    try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
  });
  if (kind === "redis") cleanups.push(async () => {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url!);
    try {
      let cursor = "0";
      do {
        const [next, keys] = await client.scan(cursor, "MATCH", `${schema}:*`, "COUNT", 100);
        cursor = next;
        if (keys.length) await client.del(...keys);
      } while (cursor !== "0");
    } finally { await client.quit(); }
  });
}

function start(dir: string, config: Record<string, unknown>) {
  const file = join(dir, `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(config));
  const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, childFile, file],
    { cwd: root, windowsHide: true, stdio: "pipe" });
  children.push(child);
  let stderr = "", buffer = "", nextId = 0;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.stderr.on("data", data => { stderr += data.toString(); });
  child.stdout.on("data", data => {
    buffer += data.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.startsWith("{")) continue;
      const message = JSON.parse(line);
      if (message.ready) readyResolve();
      else {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else waiter?.resolve(message.result);
      }
    }
  });
  const exited = new Promise<number | null>(resolveExit => child.once("exit", code => {
    const error = new Error(`Version child exited ${code}: ${stderr}`);
    readyReject(error); for (const waiter of pending.values()) waiter.reject(error);
    resolveExit(code);
  }));
  child.once("error", readyReject);
  return { ready, exited, request: <T = unknown>(command: Record<string, unknown>): Promise<T> => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { resolve: value => res(value as T), reject: rej });
    child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
  }) };
}

for (const kind of ["sqlite", "postgres", "redis"] as const) {
  const url = kind === "postgres" ? process.env.AICR_PG_TEST_URL : process.env.AICR_REDIS_TEST_URL;
  describe.skipIf(kind !== "sqlite" && !url)(`${kind} historical c5d221c/current process matrix`, () => {
    it("reads and writes supported formats across a stopped legacy writer, preserving CAS and history", async () => {
      const { dir, oldModule } = setup();
      const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
      cleanupBackend(kind, url, schema);
      const config = { kind, path: join(dir, "data.sqlite"), url, schema, prefix: `${schema}:` };
      const old = start(dir, { ...config, module: oldModule });
        await old.ready;
        const first = await old.request<{ revision: { revision: number } }>({ op: "write", baseRevision: null, operationId: "old-first", formatVersion: 1 });
        expect(first.revision.revision).toBe(1);
        expect(await old.request({ op: "stop" })).toBe("drained");
        expect(await old.exited).toBe(0);
        const current = start(dir, { ...config, module: currentModule });
        await current.ready;
        expect(await current.request({ op: "read", revision: 1 })).toMatchObject({ operationId: "old-first", formatVersion: 1 });
        const second = await current.request<{ revision: { revision: number } }>({ op: "write", baseRevision: 1, operationId: "new-second", formatVersion: 2 });
        expect(second.revision.revision).toBe(2);
        await expect(current.request({ op: "write", baseRevision: 2, operationId: "unknown", formatVersion: 3 }))
          .rejects.toMatchObject({ code: "unsupported_config_version" });
        expect(await current.request({ op: "head" })).toMatchObject({ activeRevision: 2 });
        const restarted = start(dir, { ...config, module: oldModule });
        if (kind === "redis") {
          await restarted.ready;
          expect(await restarted.request({ op: "read", revision: 2 })).toMatchObject({ operationId: "new-second", formatVersion: 2 });
          expect(await restarted.request({ op: "write", baseRevision: 1, operationId: "old-stale", formatVersion: 1 }))
            .toMatchObject({ status: "revision_conflict", head: { activeRevision: 2 } });
          expect(await restarted.request({ op: "write", baseRevision: 2, operationId: "old-third", formatVersion: 2 }))
            .toMatchObject({ status: "committed", revision: { revision: 3 } });
          expect(await current.request({ op: "read", revision: 3 })).toMatchObject({ operationId: "old-third" });
          await restarted.request({ op: "stop" }); await restarted.exited;
        } else {
          await expect(restarted.ready).rejects.toThrow(/newer program|schema_version_unsupported/);
          expect(await restarted.exited).not.toBe(0);
        }
        await current.request({ op: "stop" }); expect(await current.exited).toBe(0);
    }, 30_000);

    if (kind !== "redis") it("refuses an undrained writer and upgrades after its transaction and process finish", async () => {
      const { dir, oldModule } = setup();
      const schema = `drain_${randomUUID().replaceAll("-", "")}`;
      cleanupBackend(kind, url, schema);
      const config = { kind, path: join(dir, "data.sqlite"), url, schema, lockKey: PG_CONFIG_MIGRATION_LOCK_KEY };
      const old = start(dir, { ...config, module: oldModule });
      await old.ready;
      await old.request({ op: "write", baseRevision: null, operationId: "legacy", formatVersion: 1 });
      expect(await old.request({ op: "hold" })).toBe("held");
      const blocked = start(dir, { ...config, module: currentModule });
      await expect(blocked.ready).rejects.toThrow(/locked|lock timeout|store_unavailable/i);
      expect(await blocked.exited).not.toBe(0);
      expect(await old.request({ op: "stop" })).toBe("drained");
      expect(await old.exited).toBe(0);
      const current = start(dir, { ...config, module: currentModule });
      await current.ready;
      expect(await current.request({ op: "read", revision: 1 })).toMatchObject({ operationId: "legacy" });
      await current.request({ op: "stop" }); await current.exited;
    }, 30_000);
  });
}

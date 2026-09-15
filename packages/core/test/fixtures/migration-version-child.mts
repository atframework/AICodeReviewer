import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type * as Core from "../../src/index.js";

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const core = await import(config.module) as typeof Core;
const store = config.kind === "sqlite" ? await core.createSqliteConfigStore({ path: config.path }) :
  config.kind === "postgres" ? await core.createPgConfigStore({ connection: { url: config.url }, schema: config.schema }) :
    await core.createRedisConfigStore({ connection: { url: config.url }, prefix: config.prefix });
const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
output({ ready: true });
const lines = createInterface({ input: process.stdin });
let held: { release(): Promise<void> } | undefined;
for await (const line of lines) {
  const command = JSON.parse(line);
  try {
    let result: unknown;
    if (command.op === "write") {
      const document = core.validateDatabaseDocument(command.document ?? {}, command.formatVersion);
      result = await store.commitChangeset({ namespace: "upgrade", baseRevision: command.baseRevision, fileDigest: null,
        operationId: command.operationId, actor: config.kind, document, formatVersion: command.formatVersion,
        audit: { action: "publish", entityRefs: [], redactedDiff: {} }, now: Date.now() });
    } else if (command.op === "read") {
      result = await store.readRevision("upgrade", command.revision);
    } else if (command.op === "head") {
      result = await store.readHead("upgrade");
    } else if (command.op === "hold") {
      if (config.kind === "sqlite") {
        const { default: Database } = await import("better-sqlite3");
        const db = new Database(config.path);
        db.exec("BEGIN IMMEDIATE");
        db.prepare("UPDATE config_heads SET generation = generation + 1 WHERE namespace = ?").run("upgrade");
        held = { release: async () => { db.exec("COMMIT"); db.close(); } };
      } else {
        const { Client } = await import("pg");
        const client = new Client({ connectionString: config.url });
        await client.connect();
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(${config.lockKey})`);
        held = { release: async () => { await client.query("COMMIT"); await client.end(); } };
      }
      result = "held";
    } else if (command.op === "stop") {
      await held?.release();
      held = undefined;
      await store.close();
      output({ id: command.id, result: "drained" });
      break;
    } else throw new Error("Unknown test command");
    output({ id: command.id, result });
  } catch (error) {
    output({ id: command.id, error: { code: (error as { code?: string }).code, message: String(error) } });
  }
}
await held?.release();
await store.close();
lines.close();

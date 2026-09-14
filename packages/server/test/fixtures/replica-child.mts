/**
 * Replica child server entry (P7 process matrix): boots one REAL server app
 * on a real loopback port from repository source, against the config backend
 * chosen by the JSON config file named on argv.
 *
 * Protocol (consumed by replica-process-matrix.test.ts):
 *   argv[2]  — path to a JSON config document (see ChildConfig below).
 *   stdout   — one JSON line {"event":"ready","port":N} once the HTTP
 *              listener is up; the parent awaits exactly this marker.
 *   stderr   — diagnostics (boot failures exit 1 with the stack on stderr).
 *   SIGTERM/SIGINT — graceful shutdown: close the HTTP listener, the runtime
 *              config manager, the config store, and the receipt store.
 *
 * A fetch-counting shim records every global fetch attempt (one JSON line
 * per call) to the optional controlFile, so the parent can prove a failure
 * leg performed zero external LLM/VCS traffic. The child itself never
 * fetches; any line in the control file is external traffic by definition.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { register } from "node:module";

// Pin @aicr/* to repository source BEFORE loading any repo module. Only
// static node builtins are imported above; everything repo-side loads after
// this registration (dynamic imports below).
register(new URL("./aicr-source-hooks.mts", import.meta.url));

type ConfigStoreSpec =
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "pg"; readonly url: string; readonly schema?: string }
  | { readonly kind: "redis"; readonly url: string; readonly prefix?: string };

interface ChildConfig {
  readonly port: number;
  readonly pathPrefix?: string;
  readonly namespace: string;
  readonly fileDigest: string;
  readonly baseDir: string;
  readonly webhookSecret: string;
  readonly admin: { readonly username: string; readonly password: string };
  readonly configStore: ConfigStoreSpec;
  readonly receipts: { readonly path: string };
  readonly controlFile?: string;
}

const FILE_CONFIG = {
  llm: {
    providers: [{ id: "file-main", kind: "ollama" }],
    model_chain: { default: [{ provider: "file-main", model: "m", role: "any" }] },
  },
};

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: replica-child.mts <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ChildConfig;

  if (config.controlFile) {
    const controlFile = config.controlFile;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      appendFileSync(controlFile, `${JSON.stringify({ at: Date.now(), url: String(input) })}\n`);
      return realFetch(input as never, init as never);
    }) as typeof fetch;
  }

  const core = await import("@aicr/core");
  const { AutoCommitRuntime, createServerApp } = await import("../../src/index.js");
  const { RuntimeConfigManager } = await import("../../src/runtime-config.js");
  const { serveAsync } = await import("../../src/node-serve.js");

  const spec = config.configStore;
  const store = spec.kind === "sqlite"
    ? await core.createSqliteConfigStore({ path: spec.path })
    : spec.kind === "pg"
      ? await core.createPgConfigStore({
          connection: { url: spec.url },
          ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
        })
      : await core.createRedisConfigStore({
          connection: { url: spec.url },
          ...(spec.prefix !== undefined ? { prefix: spec.prefix } : {}),
        });

  const manager = new RuntimeConfigManager({
    fileConfig: FILE_CONFIG as never,
    fileDocument: FILE_CONFIG as never,
    fileDigest: config.fileDigest,
    store,
    namespace: config.namespace,
    baseDir: config.baseDir,
  });
  // Bootstrap parity: adopt the durable head before serving traffic.
  await manager.admission();

  const receiptStore = await core.createSqliteAutoCommitStore({ path: config.receipts.path });
  const runtime = new AutoCommitRuntime({ store: receiptStore, getPolicyLayers: () => ({}) });

  const adminAuth = {
    username: config.admin.username,
    password: config.admin.password,
    sessionTtlSeconds: 3600,
  };
  const app = createServerApp({
    ...(config.pathPrefix !== undefined ? { pathPrefix: config.pathPrefix } : {}),
    gitea: { triggerName: "gitea-internal", workspaceId: "ws-main", webhookSecret: config.webhookSecret },
    autoCommit: runtime,
    autoCommitStore: receiptStore,
    runtimeConfig: manager,
    observability: { adminAuth, sessionStore: store },
    configApi: {
      store,
      adminAuth,
      sessionStore: store,
      namespace: config.namespace,
      fileConfig: FILE_CONFIG as never,
      fileDigest: config.fileDigest,
      formatVersion: 2,
      manager,
    },
  });

  const server = await serveAsync(app, { port: config.port, hostname: "127.0.0.1" });
  console.log(JSON.stringify({ event: "ready", port: config.port }));

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        server.closeAllConnections();
        server.close();
      } catch { /* already closed */ }
      try { manager.close(); } catch { /* already closed */ }
      try { await store.close(); } catch { /* already closed */ }
      try { await receiptStore.close?.(); } catch { /* already closed */ }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

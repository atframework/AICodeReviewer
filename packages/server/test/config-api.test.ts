/**
 * Config admin API tests (P5, A-series matrix subset): auth boundary, DTO
 * strictness, preview/validate side-effect freedom, publish idempotency and
 * conflicts, restore, status, redaction, and request size caps. Backed by
 * the real SQLite config store; the runtime manager exercises the install
 * hook.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryConfigStore, applyConfigChangeset, type ConfigStore, type ConfigChangesetOperation } from "@aicr/core";
import { createSqliteConfigStore } from "@aicr/core";
import { createAdminSession, type AdminAuthConfig } from "../src/admin-auth.js";
import { createConfigApi, type ConfigApiOptions } from "../src/config-api.js";
import { RuntimeConfigManager } from "../src/runtime-config.js";
import { createServerApp } from "../src/index.js";

const NAMESPACE = "api-test";
const DIGEST = "c".repeat(64);
const ADMIN: AdminAuthConfig = {
  username: "admin",
  password: "secret-password",
  sessionTtlSeconds: 3600,
};

const FILE_CONFIG = {
  config_sources: { secret_refs: [{ env: "KNOWN_ENV", target: ["llm", "providers", "db-openai", "api_key_env"], destinations: { kind: "openai_compatible" } }] },
  llm: {
    providers: [{ id: "file-main", kind: "ollama" }],
    model_chain: { default: [{ provider: "file-main", model: "m", role: "any" }] },
  },
} as never;

let dir: string;
let store: ConfigStore;
let sessionStore: ConfigStore;
let manager: RuntimeConfigManager;
let apiOptions: ConfigApiOptions;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aicr-config-api-"));
  store = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
  sessionStore = createMemoryConfigStore();
  manager = new RuntimeConfigManager({
    fileConfig: FILE_CONFIG,
    fileDocument: FILE_CONFIG,
    fileDigest: DIGEST,
    store,
    namespace: NAMESPACE,
    baseDir: dir,
  });
  await manager.admission();
  apiOptions = {
    store,
    adminAuth: ADMIN,
    sessionStore,
    namespace: NAMESPACE,
    fileConfig: FILE_CONFIG,
    fileDigest: DIGEST,
    formatVersion: 2,
    manager,
    envLookup: (name) => (name === "KNOWN_ENV" ? "only-in-process-secret-value" : undefined),
  };
  const session = await createAdminSession({ config: ADMIN, sessions: sessionStore }, "admin", "secret-password");
  token = session!.token;
});

afterEach(async () => {
  await sessionStore.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(options: ConfigApiOptions = apiOptions) {
  return createConfigApi(options);
}

function request(
  app: ReturnType<typeof makeApp>,
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const { method = "GET", body, token: bearer = token, headers = {} } = init;
  return app.request(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify((path === "/changesets" || path.endsWith("/restore")) && body && typeof body === "object"
      ? { fileDigest: DIGEST, ...body } : body), headers: { "content-type": "application/json", ...headers } } : {}),
    ...(bearer !== null ? { headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } } : headers),
  });
}

function providerCreate(id: string): unknown {
  return {
    op: "create",
    collection: "providers",
    record: { id, name: id, enabled: true, value: { id, kind: "ollama" } },
  };
}

async function seedLegacyCredentials(operations: readonly ConfigChangesetOperation[]) {
  // Simulate old persisted data, deliberately bypassing today's write policy.
  await store.commitChangeset({ namespace: NAMESPACE, fileDigest: DIGEST, baseRevision: null,
    now: Date.now(),
    operationId: "legacy-import-operation", actor: "legacy-import", formatVersion: 2,
    document: applyConfigChangeset({}, operations, { formatVersion: 2 }),
    audit: { action: "legacy-import", entityRefs: [], redactedDiff: {} } });
}

describe("config api auth (A01/A02)", () => {
  it("P6 offers approved unused secret names without enumerating the environment", async () => {
    const envLookup = vi.fn(() => "private-value");
    const response = await request(makeApp({ ...apiOptions, envLookup }), "/options/secret_envs");
    expect(await response.json()).toEqual({ source: "secret_envs", options: [{ value: "KNOWN_ENV", label: "KNOWN_ENV" }] });
    expect(envLookup.mock.calls).toEqual([["KNOWN_ENV"]]);
  });

  it.each(["constructor", "toString", "__proto__"])("P6 rejects inherited options source %s", async (source) => {
    const response = await request(makeApp(), `/options/${source}`);
    expect(response.status).toBe(400);
  });

  it.each(["<redacted>", "http://localhost/?key=%3Credacted%3E"])("P6 rejects redaction placeholders before persistence: %s", async (base_url) => {
    const response = await request(makeApp(), "/changesets", { method: "POST", body: { baseRevision: null, operationId: "masked-value",
      operations: [{ op: "create", collection: "providers", record: { id: "masked", name: "masked", enabled: true, value: { id: "masked", kind: "ollama", base_url } } }] } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_field_type" });
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });

  it("A07: prefixed replicas share persisted sessions and report activation versions", async () => {
    const replicaStore = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
    const replicaManager = new RuntimeConfigManager({ fileConfig: FILE_CONFIG, fileDocument: FILE_CONFIG,
      fileDigest: DIGEST, store: replicaStore, namespace: NAMESPACE, baseDir: dir });
    const session = await createAdminSession({ config: ADMIN, sessions: store }, "admin", "secret-password");
    const headers = { authorization: `Bearer ${session!.token}`, "content-type": "application/json" };
    const first = createServerApp({ pathPrefix: "/aicr", configApi: { ...apiOptions, sessionStore: store } });
    const second = createServerApp({ pathPrefix: "/aicr", configApi: { ...apiOptions, store: replicaStore, sessionStore: replicaStore, manager: replicaManager } });
    try {
      const saved = await first.request("/aicr/api/admin/config/changesets", { method: "POST", headers,
        body: JSON.stringify({ baseRevision: null, fileDigest: DIGEST, operationId: "replica-save", operations: [providerCreate("shared")] }) });
      expect(saved.status).toBe(200);
      expect((await first.request("/aicr/api/admin/config/status", { headers })).status).toBe(200);
      const status = await second.request("/aicr/api/admin/config/status", { headers });
      expect(status.status).toBe(200);
      const body = await status.json() as { instances: { ready: boolean; version: { databaseRevision: number } }[] };
      expect(body.instances).toHaveLength(2);
      expect(body.instances.every(instance => instance.ready && instance.version.databaseRevision === 1)).toBe(true);
      expect((await second.request("/api/admin/config/status", { headers })).status).toBe(404);
    } finally { replicaManager.close(); await replicaStore.close(); }
  });

  it("A06/A13: direct API writes require file identity and an approved credential purpose", async () => {
    const envLookup = vi.fn(() => "private-process-value");
    const app = makeApp({ ...apiOptions, envLookup });
    const missingDigest = await request(app, "/changesets", { method: "POST", body: { fileDigest: undefined,
      baseRevision: null, operationId: "missing-digest", operations: [providerCreate("db")] } });
    expect(missingDigest.status).toBe(400);
    const forbidden = await request(app, "/changesets", { method: "POST", body: { baseRevision: null, operationId: "forbidden-env",
      operations: [{ op: "create", collection: "providers", record: { id: "db-openai", name: "db-openai", enabled: true,
        value: { id: "db-openai", kind: "openai_compatible", api_key_env: "PRIVATE_PROCESS_ENV" } } }] } });
    expect(forbidden.status).toBe(400);
    expect(await forbidden.json()).toMatchObject({ code: "invalid_secret_env" });
    expect(envLookup).not.toHaveBeenCalled();
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });

  it("A14/A15: malicious notes remain JSON data; cross-origin mutations do not write or log payloads", async () => {
    const logs = [vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const app = makeApp();
    const note = '<img src=x onerror="fetch(\'/secret\')">';
    const operation = { op: "create", collection: "providers", record: { id: "text", name: "text", enabled: true, note, value: { id: "text", kind: "ollama" } } };
    const body = { baseRevision: null, operationId: "malicious-note", operations: [operation] };
    const denied = await request(app, "/changesets", { method: "POST", body, headers: { origin: "https://external.example" } });
    expect(denied.status).toBe(403);
    expect(await store.readHead(NAMESPACE)).toBeNull();
    expect((await request(app, "/changesets", { method: "POST", body, headers: { origin: "http://localhost" } })).status).toBe(200);
    const read = await request(app, "/revisions/1");
    expect(read.headers.get("content-type")).toContain("application/json");
    expect(await read.text()).toContain("onerror");
    for (const log of logs) { expect(JSON.stringify(log.mock.calls)).not.toContain("onerror"); log.mockRestore(); }
  });

  it("rejects unauthenticated requests on every endpoint", async () => {
    const app = makeApp();
    for (const [path, method] of [
      ["/", "GET"],
      ["/status", "GET"],
      ["/schema", "GET"],
      ["/changesets", "POST"],
      ["/validate", "POST"],
    ] as const) {
      const response = await request(app, path, { method, body: method === "GET" ? undefined : { operations: [] }, token: null });
      expect([path, response.status]).toEqual([path, 401]);
    }
  });

  it("rejects invalid tokens with 401", async () => {
    const app = makeApp();
    const response = await request(app, "/", { token: "not-a-real-token" });
    expect(response.status).toBe(401);
  });
});

describe("config api GET / (A05 redaction + shape)", () => {
  it("reports head, collections, and secret env presence without values", async () => {
    const app = makeApp();
    // Publish a provider that references an env var name.
    await request(app, "/changesets", {
      method: "POST",
      body: {
        baseRevision: null,
        operationId: "op-get-1",
        operations: [{
          op: "create",
          collection: "providers",
          record: { id: "db-openai", name: "db-openai", enabled: true, value: { id: "db-openai", kind: "openai_compatible", api_key_env: "KNOWN_ENV" } },
        }],
      },
    });

    const response = await request(app, "/");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      head: { activeRevision: number } | null;
      collections: Record<string, { count: number; records: { id: string }[] }>;
      secretEnvs: { name: string; present: boolean }[];
    };
    expect(body.head?.activeRevision).toBe(1);
    expect(body.collections.provider.records.map((record) => record.id)).toContain("db-openai");
    expect(body.secretEnvs).toContainEqual({ name: "KNOWN_ENV", present: true });
    const text = JSON.stringify(body);
    expect(text).not.toContain("only-in-process-secret-value");
  });

  it("rejects new literal credentials instead of persisting them", async () => {
    const app = makeApp();
    const response = await request(app, "/changesets", {
      method: "POST",
      body: {
        baseRevision: null,
        operationId: "op-redact-1",
        operations: [{
          op: "create",
          collection: "channels",
          record: { id: "ch", name: "ch", enabled: true, value: { name: "ch", kind: "feishu_bot", webhook_url_env: "FEISHU_URL", api_token: "super-secret-token-value" } },
        }],
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_secret_env" });
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });
});

describe("config api schema endpoint", () => {
  it("exposes the inventory, entity kinds, and channel kinds", async () => {
    const app = makeApp();
    const response = await request(app, "/schema");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      entityCollections: { kind: string }[];
      channelKinds: string[];
      inventory: { path: string; wired: boolean }[];
    };
    expect(body.entityCollections.map((entry) => entry.kind)).toContain("provider");
    expect(body.channelKinds).toContain("feishu_bot");
    expect(body.inventory.length).toBeGreaterThan(100);
    expect(body.inventory.some((row) => row.path === "config_sources.database.enabled" && row.wired)).toBe(true);
  });
});

describe("config api validate + preview-route (A09)", () => {
  const draftOperations: ConfigChangesetOperation[] = [
    { op: "create", collection: "workspaces", record: { id: "draft-workspace", name: "draft-workspace", enabled: true,
      value: { match: [{ source: { repo_ref: { exact: "acme/x" } } }], work_path: "{{segment git.repository}}" } } },
    { op: "create", collection: "routes", record: { id: "draft-route", name: "draft-route", enabled: true,
      value: { id: "draft-route", enabled: true, priority: 100, workspace: "draft-workspace", match: { triggers: ["t"], target_kinds: ["push"] } } } },
  ];

  it("previews staged workspace and routing edits without committing or installing them", async () => {
    const app = makeApp({ ...apiOptions, fileConfig: { ...apiOptions.fileConfig, triggers: [{ name: "t", kind: "github", token_env: "GH_TOKEN" }] } });
    const response = await request(app, "/preview-route", { method: "POST", body: {
      event: { triggerName: "t", targetKind: "push", repoRef: "acme/x" },
      draft: { baseRevision: null, fileDigest: DIGEST, operations: draftOperations },
    } });
    expect(await response.json()).toMatchObject({ status: "matched", workspace: "draft-workspace", routeRuleId: "draft-route" });
    expect(response.status).toBe(200);
    expect(await store.readHead(NAMESPACE)).toBeNull();
    expect(await store.listRevisions(NAMESPACE)).toEqual([]);
    expect(await store.readAudit(NAMESPACE)).toEqual([]);
  });

  it.each([
    [{ baseRevision: 1, fileDigest: DIGEST }, 409, "revision_conflict"],
    [{ baseRevision: null, fileDigest: "0".repeat(64) }, 409, "file_config_mismatch"],
  ])("rejects stale preview baselines: %j", async (baseline, status, code) => {
    const response = await request(makeApp(), "/preview-route", { method: "POST", body: {
      event: { triggerName: "t", targetKind: "push" }, draft: { ...baseline, operations: draftOperations },
    } });
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).toContain(code);
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });

  it("does not offer forbidden variables and supplies valid nullable completion expressions", async () => {
    const response = await request(makeApp(), "/options/path_template_variables");
    const { options } = await response.json();
    expect(options).toContainEqual({ value: "git.repository", label: "git.repository", insertText: "{{segment git.repository}}" });
    expect(options).toContainEqual({ value: "git.branch", label: "git.branch", insertText: '{{segment (default git.branch "unknown")}}' });
    expect(options.find((option: { value: string }) => option.value === "event.actor")).toMatchObject({ disabled: true });
  });

  it("validate reports issues without writing", async () => {
    const app = makeApp();
    const before = await store.readHead(NAMESPACE);
    const response = await request(app, "/validate", {
      method: "POST",
      body: { operations: [{ op: "set", path: ["review", "max_files"], value: 5 }] },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { valid: boolean };
    expect(body.valid).toBe(true);
    expect(await store.readHead(NAMESPACE)).toEqual(before);
  });

  it("preview-route answers from the current effective config", async () => {
    const app = makeApp();
    const response = await request(app, "/preview-route", {
      method: "POST",
      body: { event: { triggerName: "t", targetKind: "push", repoRef: "acme/x" } },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(typeof body.status).toBe("string");
  });

  it("rejects malformed DTOs with field-level issues", async () => {
    const app = makeApp();
    const response = await request(app, "/validate", {
      method: "POST",
      body: { operations: [{ op: "set", path: ["__proto__", "x"], value: 1 }] },
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0]?.path).toContain("path");
  });
});

describe("config api changesets (A10/A12/A13/H13)", () => {
  it("publishes, installs the generation, and stays idempotent per operationId", async () => {
    const app = makeApp();
    const publishBody = {
      baseRevision: null,
      operationId: "op-publish-1",
      operations: [providerCreate("db-main")],
    };
    const first = await request(app, "/changesets", { method: "POST", body: publishBody });
    expect(first.status).toBe(200);
    const body = await first.json() as { status: string; snapshotId: string; revision: { revision: number } };
    expect(body.status).toBe("committed");
    expect(body.revision.revision).toBe(1);
    // The local generation installed (H01 surface).
    expect(manager.current().snapshotId).toBe(body.snapshotId);
    expect(manager.current().config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-main", "file-main"]);

    // Same operationId + same content → same revision, no duplicate.
    const retry = await request(app, "/changesets", { method: "POST", body: publishBody });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { revision: { revision: number } }).revision.revision).toBe(1);
  });

  it("same operationId with different content → 409 operation_conflict", async () => {
    const app = makeApp();
    await request(app, "/changesets", { method: "POST", body: { baseRevision: null, operationId: "op-conflict", operations: [providerCreate("a")] } });
    const clash = await request(app, "/changesets", {
      method: "POST",
      body: { baseRevision: null, operationId: "op-conflict", operations: [providerCreate("b")] },
    });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toBe("operation_conflict");
  });

  it("stale baseRevision → 409 revision_conflict with the current head", async () => {
    const app = makeApp();
    await request(app, "/changesets", { method: "POST", body: { baseRevision: null, operationId: "op-cas-1", operations: [providerCreate("a")] } });
    const stale = await request(app, "/changesets", {
      method: "POST",
      body: { baseRevision: null, operationId: "op-cas-2", operations: [providerCreate("b")] },
    });
    expect(stale.status).toBe(409);
    const body = await stale.json() as { error: string; headRevision: number };
    expect(body.error).toBe("revision_conflict");
    expect(body.headRevision).toBe(1);
  });

  it("invalid references fail atomically with field-level errors (C02/C03)", async () => {
    const app = makeApp();
    const response = await request(app, "/changesets", {
      method: "POST",
      body: {
        baseRevision: null,
        operationId: "op-bad-ref-1",
        operations: [{
          op: "create",
          collection: "channels",
          record: { id: "ch", name: "ch", enabled: true, value: { name: "ch", kind: "gitea_issue" } },
        }, {
          op: "set",
          path: ["outputs", "routes", "default", "summary"],
          value: ["missing-channel"],
        }],
      },
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_reference");
    expect(body.message).toContain("missing-channel");
    // Nothing committed.
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });

  it("bootstrap paths are rejected (A13/C05)", async () => {
    const app = makeApp();
    const response = await request(app, "/changesets", {
      method: "POST",
      body: { baseRevision: null, operationId: "op-bootstrap-1", operations: [{ op: "set", path: ["server", "port"], value: 9999 }] },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("bootstrap_readonly");
  });

  it("committed_activating surfaces as 202 when the install hook fails", async () => {
    const install = vi.spyOn(manager, "install").mockRejectedValue(new Error("install exploded"));
    const admission = vi.spyOn(manager, "admission").mockRejectedValue(new Error("activation unavailable"));
    const app = makeApp();
    const response = await request(app, "/changesets", {
      method: "POST",
      body: { baseRevision: null, operationId: "op-activating-1", operations: [providerCreate("late")] },
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { status: string; stage: string };
    expect(body.status).toBe("committed_activating");
    expect(body.stage).toBe("install");
    // The operation is queryable (H14).
    const query = await request(app, "/operations/op-activating-1");
    expect(query.status).toBe(202);
    expect(((await query.json()) as { status: string }).status).toBe("committed_activating");
    install.mockRestore();
    admission.mockRestore();
    const recovered = await request(app, "/operations/op-activating-1");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: "committed", runtime: { databaseRevision: 1 } });
  });
});

describe("config api revisions (A11)", () => {
  it("restore republishes a historical revision as a higher revision", async () => {
    const app = makeApp();
    await request(app, "/changesets", { method: "POST", body: { baseRevision: null, operationId: "op-rev-1", operations: [providerCreate("v1-provider")] } });
    await request(app, "/changesets", { method: "POST", body: { baseRevision: 1, operationId: "op-rev-2", operations: [{ op: "delete", collection: "providers", recordId: "v1-provider" }] } });

    const list = await request(app, "/revisions");
    expect(((await list.json()) as { revisions: unknown[] }).revisions).toHaveLength(2);

    const restore = await request(app, "/revisions/1/restore", {
      method: "POST",
      body: { baseRevision: 2, operationId: "op-restore-1" },
    });
    expect(restore.status).toBe(200);
    const body = await restore.json() as { status: string; revision: { revision: number } };
    expect(body.status).toBe("committed");
    expect(body.revision.revision).toBe(3);
    // The restored generation includes the provider again.
    expect(manager.current().config.llm.providers.map((provider) => provider.id)).toContain("v1-provider");

    const detail = await request(app, "/revisions/1");
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { revision: { revision: number }; audit: { action: string }[] };
    expect(detailBody.revision.revision).toBe(1);
    expect(detailBody.audit[0]?.action).toBe("publish");
  });

  it("unknown revisions 404", async () => {
    const app = makeApp();
    expect((await request(app, "/revisions/99")).status).toBe(404);
    expect((await request(app, "/operations/op-none")).status).toBe(404);
  });
});

describe("config api request limits (A08)", () => {
  it("rejects oversized bodies with 413", async () => {
    const app = makeApp({ ...apiOptions, maxBodyBytes: 200 });
    const response = await request(app, "/validate", {
      method: "POST",
      body: { operations: [{ op: "set", path: ["review", "max_files"], value: "x".repeat(500) }] },
    });
    expect(response.status).toBe(413);
  });
});

describe("config api status", () => {
  it("reports the durable head and generation state", async () => {
    const app = makeApp();
    await request(app, "/changesets", { method: "POST", body: { baseRevision: null, operationId: "op-status-1", operations: [providerCreate("s")] } });
    const response = await request(app, "/status");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      head: { activeRevision: number } | null;
      manager: { snapshotId: string | null; databaseRevision: number | null } | null;
    };
    expect(body.head?.activeRevision).toBe(1);
    expect(body.manager?.databaseRevision).toBe(1);
    expect(body.manager?.snapshotId).not.toBeNull();
  });
});

describe("config API regression boundaries", () => {
  it.each([
    { op: "set", path: ["review", "max_files"] },
    { op: "update", collection: "providers", recordId: "db" },
    { op: "create", collection: "providers", record: { id: "db", name: "db", enabled: true } },
  ])("rejects missing values on $op operations", async operation => {
    const response = await request(makeApp(), "/validate", { method: "POST", body: { operations: [operation] } });
    expect(response.status).toBe(400);
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });
  it.each(["/changesets", "/validate"])("rejects a foreign fileDigest on %s without writing", async path => {
    const response = await request(makeApp(), path, { method: "POST", body: {
      ...(path === "/changesets" ? { baseRevision: null, operationId: "op-digest" } : {}),
      fileDigest: "f".repeat(64), operations: [providerCreate("db")] } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "file_config_mismatch" });
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });

  it("applies the actual UTF-8 byte limit even with an understated Content-Length", async () => {
    const body = JSON.stringify({ operations: [{ op: "set", path: ["review", "output_language"], value: "汉".repeat(35) }] });
    const response = await makeApp({ ...apiOptions, maxBodyBytes: 150 }).request("/validate", {
      method: "POST", headers: { authorization: 'Bearer ' + token, "content-length": "1" }, body });
    expect(body.length).toBeLessThan(150);
    expect(Buffer.byteLength(body)).toBeGreaterThan(150);
    expect(response.status).toBe(413);
  });

  it("cancels oversized streamed bodies before draining the source", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(64)); },
      cancel() { cancelled = true; },
    });
    const req = new Request("http://localhost/validate", { method: "POST", body,
      headers: { authorization: 'Bearer ' + token }, duplex: "half" } as RequestInit);
    const response = await makeApp({ ...apiOptions, maxBodyBytes: 100 }).request(req);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(5);
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects nested %s before Zod can strip it", async key => {
    const body = '{"operations":[{"op":"set","path":["review","labels"],"value":{"' + key + '":{"secret":"hidden"}}}]}';
    const response = await makeApp().request("/validate", { method: "POST", body,
      headers: { authorization: 'Bearer ' + token } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "prototype_key" });
  });

  it("blocks cross-origin writes before publication", async () => {
    const response = await request(makeApp(), "/changesets", { method: "POST", headers: { origin: "https://untrusted.example" },
      body: { baseRevision: null, operationId: "op-origin", operations: [providerCreate("db")] } });
    expect(response.status).toBe(403);
    expect(await store.readHead(NAMESPACE)).toBeNull();
  });

  it("keeps immutable record IDs, disabled entries, file entities, and effective values in the paginated view", async () => {
    const app = makeApp();
    const response = await request(app, "/changesets", { method: "POST", body: {
      baseRevision: null, operationId: "op-view-1", operations: [{ op: "create", collection: "providers",
        record: { id: "immutable-id", name: "display-name", enabled: false, value: { id: "display-name", kind: "ollama" } } }] } });
    expect(response.status, await response.text()).toBe(200);
    const first = await (await request(app, "/?limit=1")).json() as { collections: Record<string, { records: unknown[]; nextOffset: number }> };
    expect(first.collections.provider.records).toEqual([expect.objectContaining({ id: "file-main", source: "file", readonly: true, effectiveValue: { id: "file-main", kind: "ollama" } })]);
    expect(first.collections.provider.nextOffset).toBe(1);
    const second = await (await request(app, "/?limit=1&offset=1")).json() as { collections: Record<string, { records: unknown[] }> };
    expect(second.collections.provider.records).toEqual([expect.objectContaining({ id: "immutable-id", name: "display-name", enabled: false, source: "database" })]);
  });

  it("reads the head once for a coherent GET view", async () => {
    const readHead = vi.spyOn(store, "readHead");
    expect((await request(makeApp(), "/")).status).toBe(200);
    expect(readHead).toHaveBeenCalledTimes(1);
  });

  it("reports blocked activation instead of healthy status", async () => {
    vi.spyOn(manager, "admission").mockRejectedValue(new Error("cannot open postgres://a:private-password@db"));
    const response = await request(makeApp(), "/status");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ admission: { available: false, reason: "store_unavailable" } });
  });

  it("does not expose raw driver errors", async () => {
    vi.spyOn(store, "readHead").mockRejectedValue(new Error("cannot open postgres://a:private-password@db"));
    const response = await request(makeApp(), "/");
    expect(await response.text()).not.toContain("private-password");
  });

  it("redacts short credentials, URL userinfo, signed queries and custom headers", async () => {
    const app = makeApp();
    await seedLegacyCredentials([{ op: "create", collection: "providers", record: {
        id: "db", name: "db", enabled: true, value: { id: "db", kind: "ollama", password: "abc",
          base_url: "https://user:pw@example.com/api?sig=querysecret", headers: { "X-Custom": "headersecret" } } } }]);
    for (const path of ["/", "/revisions/1"]) {
      const body = await (await request(app, path)).text();
      for (const secret of ['"abc"', "user:pw", "querysecret", "headersecret"]) expect(body).not.toContain(secret);
    }
    const restore = await request(app, "/revisions/1/restore", { method: "POST", body: { baseRevision: 1, operationId: "op-restore-secrets" } });
    expect(restore.status).toBe(400);
    expect((await store.readHead(NAMESPACE))?.activeRevision).toBe(1);
  });
});

describe("config api P6 fields view + options sources", () => {
  it("GET / includes the effective fields view with file locks and overridden values", async () => {
    const fileConfig = { ...FILE_CONFIG, review: { max_files: 7 } } as never;
    const app = makeApp({ ...apiOptions, fileConfig });
    // Bypass the write policy to place a database value beneath a file-owned field.
    await seedLegacyCredentials([{ op: "set", path: ["review", "max_files"], value: 99 }]);

    const response = await request(app, "/");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      fields: { path: string; source: string; editable: boolean; effectiveValue: unknown;
        overriddenValues: { source: string; value: unknown }[] }[];
    };
    expect(Array.isArray(body.fields)).toBe(true);
    const locked = body.fields.find((field) => field.path === "review.max_files");
    expect(locked).toMatchObject({
      source: "file",
      editable: false,
      effectiveValue: 7,
      overriddenValues: [{ source: "database", value: 99 }],
    });
    const fileProvider = body.fields.find((field) => field.path === "llm.providers.file-main.kind");
    expect(fileProvider).toMatchObject({ source: "file", editable: false, effectiveValue: "ollama", overriddenValues: [] });
  });

  it("GET /schema exposes the derived UI spec as JSON", async () => {
    const app = makeApp();
    const response = await request(app, "/schema");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      uiSpec: { protocolVersion: number; pages: { id: string }[]; optionsSources: { id: string }[] };
    };
    expect(body.uiSpec.protocolVersion).toBe(1);
    const pageIds = body.uiSpec.pages.map((page) => page.id);
    for (const id of ["providers", "model-groups", "routing", "versions"]) expect(pageIds).toContain(id);
    expect(body.uiSpec.optionsSources.map((source) => source.id)).toContain("secret_envs");
    // The spec round-trips through JSON and carries no secret material.
    expect(JSON.parse(JSON.stringify(body.uiSpec))).toEqual(body.uiSpec);
    expect(JSON.stringify(body)).not.toContain("only-in-process-secret-value");
  });

  it("GET /options serves all seven sources with disabled and secret-presence flags", async () => {
    const fileConfig = {
      config_sources: { secret_refs: [
        { env: "KNOWN_ENV", target: ["llm", "providers", "db-openai", "api_key_env"], destinations: { kind: "openai_compatible" } },
        { env: "ABSENT_ENV", target: ["llm", "providers", "db-absent", "api_key_env"], destinations: { kind: "openai_compatible" } },
      ] },
      llm: {
        providers: [{ id: "file-main", kind: "ollama" }],
        model_chain: { default: [{ provider: "file-main", model: "m", role: "any" }] },
      },
    } as never;
    const app = makeApp({ ...apiOptions, fileConfig });
    await seedLegacyCredentials([
      { op: "create", collection: "providers", record: { id: "db-openai", name: "db-openai", enabled: true,
        value: { id: "db-openai", kind: "openai_compatible", api_key_env: "KNOWN_ENV" } } },
      { op: "create", collection: "providers", record: { id: "db-absent", name: "db-absent", enabled: true,
        value: { id: "db-absent", kind: "openai_compatible", api_key_env: "ABSENT_ENV" } } },
      { op: "create", collection: "providers", record: { id: "db-off", name: "db-off", enabled: false,
        value: { id: "db-off", kind: "ollama" } } },
    ]);

    type Option = { value: string; label?: string; disabled?: boolean };
    const getOptions = async (source: string) => {
      const response = await request(app, `/options/${source}`);
      expect([source, response.status]).toEqual([source, 200]);
      return (await response.json() as { source: string; options: Option[] }).options;
    };

    const providers = await getOptions("providers");
    expect(providers).toContainEqual({ value: "file-main", label: "file-main" });
    expect(providers).toContainEqual({ value: "db-openai", label: "db-openai" });
    expect(providers).toContainEqual({ value: "db-off", label: "db-off", disabled: true });

    const modelGroups = await getOptions("model_groups");
    expect(modelGroups).toContainEqual({ value: "default", label: "default" });

    for (const source of ["triggers", "channels", "workspaces"]) {
      expect(await getOptions(source)).toEqual([]);
    }

    const secretEnvs = await getOptions("secret_envs");
    expect(secretEnvs).toContainEqual({ value: "KNOWN_ENV", label: "KNOWN_ENV" });
    expect(secretEnvs).toContainEqual({ value: "ABSENT_ENV", label: "ABSENT_ENV", disabled: true });
    expect(JSON.stringify(secretEnvs)).not.toContain("only-in-process-secret-value");

    const variables = await getOptions("path_template_variables");
    expect(variables).toContainEqual({ value: "git.branch", label: "git.branch", insertText: '{{segment (default git.branch "unknown")}}' });
    const unavailable = variables.find((option) => option.value === "scheduled.job_id");
    expect(unavailable?.label).toBe("scheduled.job_id (unavailable)");
  });

  it("rejects unknown options sources with 400 invalid_request", async () => {
    const app = makeApp();
    const response = await request(app, "/options/catalog_models");
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("invalid_request");
  });

  it("rejects unauthenticated options requests with 401", async () => {
    const app = makeApp();
    const response = await request(app, "/options/providers", { token: null });
    expect(response.status).toBe(401);
  });
});

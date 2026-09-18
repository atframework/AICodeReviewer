/**
 * Config publish service tests (P3d): prepare atomicity, CAS conflict,
 * operationId retry/query, committed_activating, restore re-validation, and
 * redacted audit material. Backed by the real SQLite config store.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getConfigOperation,
  prepareConfigPublication,
  prepareConfigRestore,
  publishConfig,
  type ConfigPublishInput,
  type PreparedConfigPublication,
} from "../src/config-publish.js";
import type { ConfigChangesetOperation } from "../src/config-source.js";
import type { ConfigStore } from "../src/config-store.js";
import { createConfigSecretSealing, openConfigSecretLiterals } from "../src/config-secret-sealing.js";
import { createSqliteConfigStore } from "../src/sqlite-config-store.js";

function createOp(collection: "providers" | "triggers" | "channels" | "workspaces" | "routes", name: string, value: Record<string, unknown>): ConfigChangesetOperation {
  return { op: "create", collection, record: { id: `rec-${name}`, name, enabled: true, value } };
}

/** String-valued document entity (template/prompt). */
function createDocOp(collection: "templates" | "prompts", name: string, document: string): ConfigChangesetOperation {
  return { op: "create", collection, record: { id: `rec-${name}`, name, enabled: true, value: document } };
}

const NAMESPACE = "workspace:test";
const DIGEST = "a".repeat(64);

let dir: string;
let store: ConfigStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aicr-config-publish-"));
  store = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function publishInput(overrides: Partial<ConfigPublishInput> = {}): ConfigPublishInput {
  return {
    namespace: NAMESPACE,
    baseRevision: null,
    operationId: "op-1",
    actor: "tester",
    file: {
      config_sources: { secret_refs: [
        { env: "FEISHU_URL", target: ["outputs", "channels", "chat", "webhook_url_env"], destinations: { kind: "feishu_bot", webhook_url_env: "FEISHU_URL" } },
        { env: "GH_TOKEN", target: ["triggers", "gh", "token_env"], destinations: { kind: "github" } },
      ] },
      llm: {
        providers: [{ id: "file-main", kind: "ollama" }],
        model_chain: { default: [{ provider: "file-main", model: "m", role: "any" }] },
      },
    },
    fileDigest: DIGEST,
    current: {},
    operations: [
      createOp("channels", "chat", { name: "chat", kind: "feishu_bot", webhook_url_env: "FEISHU_URL" }),
      { op: "set", path: ["review", "output_language"], value: "zh-CN" },
    ],
    ...overrides,
  };
}

async function currentDoc(namespace: string) {
  const head = await store.readHead(namespace);
  if (head === null) return undefined;
  return (await store.readRevision(namespace, head.activeRevision))?.document;
}

async function publish(prepared: PreparedConfigPublication) {
  const result = await publishConfig(store, prepared);
  if (result.status === "conflict") throw new Error(`unexpected conflict: ${result.message}`);
  return result;
}

describe("publish commit (S02/S03)", () => {
  it("requires sealing at the core publish boundary and handles concurrent literal retries", async () => {
    const prepared = prepareConfigPublication(publishInput({ operations: [
      createOp("triggers", "git", { name: "git", kind: "gitea", token: "literal-token" }),
    ] }));
    await expect(publishConfig(store, prepared)).rejects.toMatchObject({ code: "secrets_key_missing" });
    expect(await store.readHead(NAMESPACE)).toBeNull();
    const secretSealing = createConfigSecretSealing(Buffer.alloc(32, 7));
    const results = await Promise.all(Array.from({ length: 3 }, () => publishConfig(store, prepared, { secretSealing })));
    for (const result of results) expect(result.status).toBe("committed");
    const first = results[0]!;
    if (first.status !== "committed") throw new Error("publication failed");
    expect(JSON.stringify(first.revision.document)).not.toContain("literal-token");
    const snapshot = await store.readSnapshot(first.snapshotId);
    expect(JSON.stringify(snapshot)).not.toContain("literal-token");
    expect(openConfigSecretLiterals(snapshot!.sanitizedEffectiveConfig, secretSealing)).toEqual(prepared.effective);
    const changed = prepareConfigPublication(publishInput({ operations: [
      createOp("triggers", "git", { name: "git", kind: "gitea", token: "different-token" }),
    ] }));
    await expect(publishConfig(store, changed, { secretSealing })).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("commits revision + audit atomically and advances the head", async () => {
    const result = await publish(prepareConfigPublication(publishInput()));
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(result.revision.revision).toBe(1);
    expect(result.revision.parentRevision).toBeNull();
    expect(result.revision.fileDigest).toBe(DIGEST);

    const head = await store.readHead(NAMESPACE);
    expect(head).toMatchObject({ activeRevision: 1 });
    const audits = await store.readAudit(NAMESPACE, { limit: 10 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "publish" });

    // The runtime snapshot was written and is fetchable (architecture §3.15).
    const snapshot = await store.readSnapshot(result.snapshotId);
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({ databaseRevision: 1, fileDigest: DIGEST });
    const effective = snapshot!.sanitizedEffectiveConfig as {
      outputs: { channels: { name: string }[] };
      review: { output_language: string };
    };
    expect(effective.outputs.channels.map((channel) => channel.name)).toContain("chat");
    expect(effective.review.output_language).toBe("zh-CN");
  });

  it("same operationId retry returns the committed result (H14/S03)", async () => {
    const first = await publish(prepareConfigPublication(publishInput()));
    const second = await publishConfig(store, prepareConfigPublication(publishInput()));
    expect(second.status).toBe("committed");
    if (first.status === "committed" && second.status === "committed") {
      expect(second.revision.revision).toBe(first.revision.revision);
      expect(second.revision.contentHash).toBe(first.revision.contentHash);
    }
    const head = await store.readHead(NAMESPACE);
    expect(head?.activeRevision).toBe(1); // no duplicate revision created
  });

  it("baseRevision mismatch returns conflict with the current head (H07)", async () => {
    await publish(prepareConfigPublication(publishInput()));
    const stale = prepareConfigPublication(publishInput({ operationId: "op-2", baseRevision: null }));
    const conflict = await publishConfig(store, stale);
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") {
      expect(conflict.headRevision).toBe(1);
    }
    const correctBase = prepareConfigPublication(
      publishInput({
        operationId: "op-2",
        baseRevision: 1,
        current: (await currentDoc(NAMESPACE))!,
        operations: [{ op: "set", path: ["review", "max_files"], value: 42 }],
      }),
    );
    const ok = await publish(correctBase);
    expect(ok.status).toBe("committed");
  });

  it("getConfigOperation answers response-loss queries", async () => {
    expect(await getConfigOperation(store, NAMESPACE, "op-1")).toEqual({ status: "not_found" });
    await publish(prepareConfigPublication(publishInput()));
    const status = await getConfigOperation(store, NAMESPACE, "op-1");
    expect(status).toMatchObject({ status: "committed", revision: { revision: 1, fileDigest: DIGEST } });
  });
});

describe("prepare failure commits nothing (H13)", () => {
  it("C03: deleting a trigger referenced only by a legacy output rule fails atomically", async () => {
    const first = prepareConfigPublication(publishInput({ operations: [
      createOp("triggers", "gh", { name: "gh", kind: "github" }),
      { op: "set", path: ["outputs", "routes", "rules"], value: [{ match: { trigger: "gh" }, summary: [] }] },
    ] }));
    await publish(first);
    const input = publishInput({ current: first.document, baseRevision: 1, operationId: "delete-trigger", operations: [
      { op: "delete", collection: "triggers", recordId: "rec-gh" },
    ] });
    expect(() => prepareConfigPublication(input)).toThrowError(expect.objectContaining({ code: "invalid_reference" }));
    expect((await store.readHead(NAMESPACE))?.activeRevision).toBe(1);
    expect(prepareConfigPublication({ ...input, operations: [...input.operations,
      { op: "unset", path: ["outputs", "routes", "rules"] },
    ] }).document.entities?.triggers).toEqual({});
  });

  it("C12: restoring an empty globals object does not claim every file lock", async () => {
    const original = prepareConfigPublication(publishInput({ current: { globals: {} }, operations: [] }));
    await publish(original);
    const changed = prepareConfigPublication(publishInput({ current: original.document, baseRevision: 1,
      operationId: "changed", operations: [{ op: "set", path: ["review", "max_files"], value: 42 }] }));
    await publish(changed);
    const restore = await prepareConfigRestore(store, { namespace: NAMESPACE, revision: 1, baseRevision: 2,
      operationId: "restore-empty", actor: "test", file: original.input.file, fileDigest: DIGEST });
    expect((await publish(restore)).status).toBe("committed");
    expect((await currentDoc(NAMESPACE))?.globals).toEqual({});
  });

  it("invalid changeset aborts before any commit", async () => {
    // Unknown channel kind: capability validation rejects during prepare (§6).
    const bad = publishInput({
      operations: [createOp("channels", "bad", { name: "bad", kind: "carrier_pigeon" })],
    });
    expect(() => prepareConfigPublication(bad)).toThrowError(
      expect.objectContaining({ code: "unsupported_capability" }) as Error,
    );
    await expect(store.readHead(NAMESPACE)).resolves.toBeNull();
  });

  it("deleting a referenced entity fails the whole changeset (C02/C03)", async () => {
    // r1: DB provider + DB model group whose chain references it.
    await publish(
      prepareConfigPublication(
        publishInput({
          operations: [
            createOp("providers", "db-main", { id: "db-main", kind: "ollama" }),
            { op: "create", collection: "model_groups", record: { id: "rec-g", name: "g", enabled: true, value: [{ provider: "db-main", model: "m", role: "any" }] } },
          ],
        }),
      ),
    );
    // r2 attempts to delete the provider without removing the group reference.
    const head = await store.readHead(NAMESPACE);
    const dropProvider = publishInput({
      operationId: "op-2",
      baseRevision: head!.activeRevision,
      current: (await currentDoc(NAMESPACE))!,
      operations: [{ op: "delete", collection: "providers", recordId: "rec-db-main" }],
    });
    expect(() => prepareConfigPublication(dropProvider)).toThrowError(
      expect.objectContaining({ code: "invalid_reference" }) as Error,
    );
    await expect(store.readHead(NAMESPACE)).resolves.toMatchObject({ activeRevision: 1 });
  });

  it("file-owned entity mutation is rejected with file_owned", async () => {
    const owned = publishInput({
      operations: [createOp("providers", "file-main", { id: "file-main", kind: "ollama", base_url: "http://x" })],
    });
    expect(() => prepareConfigPublication(owned)).toThrowError(expect.objectContaining({ code: "file_owned" }) as Error);
  });

  it.each([
    {
      name: "RE2-unsupported matcher expression",
      value: { match: [{ triggers: ["gh"], source: { repo_ref: { regex: "acme/(?=svc)" } } }] },
      code: "matcher_invalid",
    },
    {
      name: "match rule referencing an unknown trigger",
      value: { match: [{ triggers: ["ghost"], source: { repo_ref: { glob: "acme/*" } } }] },
      code: "invalid_reference",
    },
    {
      name: "source_repo and match both set",
      value: { source_repo: { trigger: "gh", repo: "acme/x" }, match: [{ triggers: ["gh"] }] },
      code: "match_rule_invalid",
    },
    {
      name: "work_path escaping the workspace root",
      value: { match: [{ triggers: ["gh"] }], work_path: "{{segment source.repository}}/../../outside" },
      code: "template_invalid",
    },
    {
      name: "mixed work_path with an absolute literal prefix",
      value: { match: [{ triggers: ["gh"] }], work_path: "/{{workspace.id}}" },
      code: "template_invalid",
    },
  ])("workspace match errors fail at prepare, never post-commit ($name)", async ({ value, code }) => {
    const base = publishInput({ formatVersion: 2 });
    const input: ConfigPublishInput = {
      ...base,
      file: {
        ...base.file,
        triggers: [{ name: "gh", kind: "github", token_env: "GH_TOKEN" }],
      },
      operations: [createOp("workspaces", "ws-bad", value)],
    };
    expect(() => prepareConfigPublication(input)).toThrowError(expect.objectContaining({ code }) as Error);
    await expect(store.readHead(NAMESPACE)).resolves.toBeNull();
  });
});

describe("committed_activating (H15)", () => {
  it("install failure reports committed_activating and never rolls back", async () => {
    const result = await publishConfig(store, prepareConfigPublication(publishInput()), {
      install: () => Promise.reject(new Error("model dir offline")),
    });
    expect(result).toMatchObject({ status: "committed_activating", stage: "install" });
    if (result.status === "committed_activating") {
      expect(result.message).toContain("model dir offline");
    }
    // The revision is durable — queryable by operationId, head advanced.
    await expect(store.readHead(NAMESPACE)).resolves.toMatchObject({ activeRevision: 1 });
    expect(await getConfigOperation(store, NAMESPACE, "op-1")).toMatchObject({ status: "committed" });
  });
});

describe("restore (C12/S07)", () => {
  it("restores a historical revision as a new higher revision", async () => {
    await publish(prepareConfigPublication(publishInput()));
    const second = prepareConfigPublication(
      publishInput({
        operationId: "op-2",
        baseRevision: 1,
        current: (await currentDoc(NAMESPACE))!,
        operations: [{ op: "set", path: ["review", "output_language"], value: "en" }],
      }),
    );
    await publish(second);

    const restore = await prepareConfigRestore(store, {
      namespace: NAMESPACE,
      revision: 1,
      operationId: "op-3",
      actor: "tester",
      file: publishInput().file,
      fileDigest: DIGEST,
      baseRevision: 2,
    });
    const result = await publishConfig(store, restore);
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.revision.revision).toBe(3);
      expect(result.revision.parentRevision).toBe(2); // forward revision, not a downgrade
    }
    const snapshot = await store.readSnapshot((result as { snapshotId: string }).snapshotId);
    const effective = snapshot!.sanitizedEffectiveConfig as { review: { output_language: string } };
    expect(effective.review.output_language).toBe("zh-CN"); // revision 1 content restored
  });

  it("restore conflicting with a CURRENT file lock is rejected (C12)", async () => {
    // Revision 1 sets a DB global; the file later locks the same leaf.
    await publish(
      prepareConfigPublication(
        publishInput({ file: {}, operations: [{ op: "set", path: ["compression", "context_lines"], value: 5 }] }),
      ),
    );
    await expect(
      prepareConfigRestore(store, {
        namespace: NAMESPACE,
        revision: 1,
        operationId: "op-2",
        actor: "tester",
        file: { compression: { context_lines: 3 } },
        fileDigest: "b".repeat(64),
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "file_owned" });
  });

  it("restore conflicts through quoted map-key locks (C12, formatConfigPath parity)", async () => {
    // Revision 1 sets a DB global under a model id containing "/" and ".".
    await publish(
      prepareConfigPublication(
        publishInput({
          file: {},
          operations: [{ op: "set", path: ["llm", "model_catalog", "overrides", "openai/gpt-4.1", "open_weights"], value: true }],
        }),
      ),
    );
    // The file now locks the same leaf; the historical value must conflict
    // instead of silently restoring a value the file immediately shadows.
    await expect(
      prepareConfigRestore(store, {
        namespace: NAMESPACE,
        revision: 1,
        operationId: "op-2",
        actor: "tester",
        file: { llm: { model_catalog: { overrides: { "openai/gpt-4.1": { open_weights: false } } } } },
        fileDigest: "b".repeat(64),
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "file_owned" });
  });
});

describe("audit redaction (S06)", () => {
  it("audit diff contains entity names and global paths only — no values", async () => {
    await publish(prepareConfigPublication(publishInput()));
    const audits = await store.readAudit(NAMESPACE, { limit: 10 });
    const diff = audits[0]!.redactedDiff as {
      entities: { added: string[]; removed: string[]; changed: string[] };
      globals: { set: string[]; unset: string[] };
    };
    expect(diff.entities.added).toContain("channels/chat");
    expect(diff.globals.set).toEqual(["review.output_language"]);
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain("FEISHU_URL"); // no env names
    expect(serialized).not.toContain("zh-CN"); // no values
  });
});

describe("namespace isolation (C11)", () => {
  it("identical documents in two namespaces keep independent heads and audits", async () => {
    await publish(prepareConfigPublication(publishInput()));
    await publish(prepareConfigPublication(publishInput({ namespace: "workspace:other", operationId: "op-9" })));
    expect(await store.readHead(NAMESPACE)).toMatchObject({ activeRevision: 1 });
    expect(await store.readHead("workspace:other")).toMatchObject({ activeRevision: 1 });
    expect(await getConfigOperation(store, "workspace:other", "op-1")).toEqual({ status: "not_found" });
    expect(await getConfigOperation(store, "workspace:other", "op-9")).toMatchObject({ status: "committed" });
  });
});

describe("reference resolution on publish", () => {
  it.each(["templates", "prompts"] as const)("rejects removing or disabling referenced %s, and permits atomic reference cleanup", (collection) => {
    const operations: ConfigChangesetOperation[] = [createDocOp(collection, "shared", "Shared text")];
    if (collection === "templates") operations.push(createOp("channels", "out", { name: "out", kind: "gitea_issue", templates: { summary: "shared" } }));
    else operations.push(createOp("workspaces", "ws", { prompt: { extra_system_prompt: "shared" } }));
    const current = prepareConfigPublication(publishInput({ operations })).document;
    for (const op of [
      { op: "delete" as const, collection, recordId: "rec-shared" },
      { op: "set-enabled" as const, collection, recordId: "rec-shared", enabled: false },
    ]) expect(() => prepareConfigPublication(publishInput({ current, operations: [op] })))
      .toThrowError(expect.objectContaining({ code: "invalid_reference" }));
    const cleared = prepareConfigPublication(publishInput({ current, operations: [
      { op: "delete", collection, recordId: "rec-shared" },
      { op: "delete", collection: collection === "templates" ? "channels" : "workspaces", recordId: collection === "templates" ? "rec-out" : "rec-ws" },
    ] }));
    expect(cleared.audit.entityRefs).toContain(`-${collection}/shared`);
  });

  const withTrigger: ConfigChangesetOperation[] = [
    createOp("triggers", "gh", { name: "gh", kind: "github", token_env: "GH_TOKEN" }),
  ];

  it("route referencing a trigger upserted in the same changeset passes", async () => {
    const prepared = prepareConfigPublication(
      publishInput({
        formatVersion: 2,
        operations: [
          ...withTrigger,
          createOp("routes", "r1", { id: "r1", workspace: "product-services", match: { triggers: ["gh"] } }),
          createOp("workspaces", "product-services", {}),
        ],
      }),
    );
    await expect(publish(prepared)).resolves.toMatchObject({ status: "committed" });
  });

  it("route referencing a missing trigger fails with invalid_reference", async () => {
    expect(() =>
      prepareConfigPublication(
        publishInput({
          formatVersion: 2,
          operations: [
            createOp("routes", "r1", { id: "r1", workspace: "product-services", match: { triggers: ["ghost"] } }),
            createOp("workspaces", "product-services", {}),
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }) as Error);
  });

  it("channel referencing a template upserted in the same changeset passes", async () => {
    const prepared = prepareConfigPublication(
      publishInput({
        operations: [
          createDocOp("templates", "pr-summary", "Summary {{run.id}}"),
          createOp("channels", "pr", { name: "pr", kind: "gitea_issue", templates: { summary: "pr-summary" } }),
        ],
      }),
    );
    await expect(publish(prepared)).resolves.toMatchObject({ status: "committed" });
  });

  it("channel referencing a missing template fails with invalid_reference", async () => {
    expect(() =>
      prepareConfigPublication(
        publishInput({
          operations: [
            createOp("channels", "pr", { name: "pr", kind: "gitea_issue", templates: { problem: "ghost" } }),
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }) as Error);
  });

  it("workspace referencing a missing system prompt fails with invalid_reference", async () => {
    expect(() =>
      prepareConfigPublication(
        publishInput({
          operations: [
            createOp("workspaces", "product-services", { prompt: { system_prompt: "ghost" } }),
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }) as Error);
  });

  it("workspace referencing a prompt upserted in the same changeset passes", async () => {
    const prepared = prepareConfigPublication(
      publishInput({
        operations: [
          createDocOp("prompts", "team-base", "You review code."),
          createOp("workspaces", "product-services", { prompt: { system_prompt: "team-base", extra_system_prompt: "team-base" } }),
        ],
      }),
    );
    await expect(publish(prepared)).resolves.toMatchObject({ status: "committed" });
  });
});

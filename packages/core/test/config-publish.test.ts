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
import { createSqliteConfigStore } from "../src/sqlite-config-store.js";

function createOp(collection: "providers" | "triggers" | "channels" | "workspaces" | "routes", name: string, value: Record<string, unknown>): ConfigChangesetOperation {
  return { op: "create", collection, record: { id: `rec-${name}`, name, enabled: true, value } };
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

    // The runtime snapshot was written and is fetchable (spec §7.1).
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
        publishInput({ file: {}, operations: [{ op: "set", path: ["review", "output_language"], value: "zh-CN" }] }),
      ),
    );
    await expect(
      prepareConfigRestore(store, {
        namespace: NAMESPACE,
        revision: 1,
        operationId: "op-2",
        actor: "tester",
        file: { review: { output_language: "en" } },
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
});

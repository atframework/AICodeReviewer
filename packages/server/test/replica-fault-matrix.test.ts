/**
 * In-process replica fault matrix (E09): two
 * RuntimeConfigManager instances, two config stores and two createServerApp
 * instances — over ONE shared SQLite config database file (the A07 shape from
 * config-api.test.ts), with separate durable receipt-store connections. Covers the
 * simulated failure between commit and activation, cross-replica publish
 * idempotency, duplicate webhook delivery, store disconnect isolation, and
 * file-digest drift between replicas.
 */
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeStreamId, createSqliteAutoCommitStore, createSqliteConfigStore, type AutoCommitStore, type ConfigStore } from "@aicr/core";
import { createAdminSession, type AdminAuthConfig } from "../src/admin-auth.js";
import { AutoCommitRuntime, createServerApp } from "../src/index.js";
import { RuntimeConfigManager } from "../src/runtime-config.js";

const NAMESPACE = "replica-matrix";
const DIGEST = "d".repeat(64);
const DRIFTED_DIGEST = "e".repeat(64);
const ADMIN: AdminAuthConfig = {
  username: "admin",
  password: "secret-password",
  sessionTtlSeconds: 3600,
};

const FILE_CONFIG = {
  llm: {
    providers: [{ id: "file-main", kind: "ollama" }],
    model_chain: { default: [{ provider: "file-main", model: "m", role: "any" }] },
  },
} as never;

const webhookSecret = "replica-secret";

function sign(payload: string): string {
  return createHmac("sha256", webhookSecret).update(payload).digest("hex");
}

function giteaPushPayload(ref = "refs/heads/main"): string {
  return JSON.stringify({
    ref,
    before: "1111111111111111111111111111111111111111",
    after: "2222222222222222222222222222222222222222",
    repository: { full_name: "owent/example" },
    pusher: { login: "owent", email: "owent@example.com" },
    commits: [{ id: "2222222222222222222222222222222222222222" }],
  });
}

function giteaHeaders(payload: string, event: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-gitea-event": event,
    "x-gitea-signature": sign(payload),
  };
}

function providerCreate(id: string): unknown {
  return {
    op: "create",
    collection: "providers",
    record: { id, name: id, enabled: true, value: { id, kind: "ollama" } },
  };
}

interface Replica {
  readonly store: ConfigStore;
  readonly receiptStore: AutoCommitStore;
  readonly manager: RuntimeConfigManager;
  readonly app: ReturnType<typeof createServerApp>;
}

let dir: string;
let autoCommitStore: AutoCommitStore;
let replicaA: Replica;
let replicaB: Replica;
let token: string;

async function makeReplica(fileDigest: string = DIGEST): Promise<Replica> {
  const store = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
  const manager = new RuntimeConfigManager({
    fileConfig: FILE_CONFIG,
    fileDocument: FILE_CONFIG,
    fileDigest,
    store,
    namespace: NAMESPACE,
    baseDir: dir,
  });
  // No admission here: healthy replicas admit in beforeEach, while a drifted
  // replica must reach the HTTP surface with its admission still failing.
  const receiptStore = await createSqliteAutoCommitStore({ path: join(dir, "receipts.sqlite") });
  const runtime = new AutoCommitRuntime({ store: receiptStore, getPolicyLayers: () => ({}) });
  const app = createServerApp({
    pathPrefix: "/aicr",
    gitea: { triggerName: "gitea-internal", workspaceId: "ws-main", webhookSecret },
    autoCommit: runtime,
    runtimeConfig: manager,
    configApi: {
      store,
      adminAuth: ADMIN,
      sessionStore: store,
      namespace: NAMESPACE,
      fileConfig: FILE_CONFIG,
      fileDigest,
      formatVersion: 2,
      manager,
    },
  });
  return { store, receiptStore, manager, app };
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function publishBody(operationId: string, providerId: string): string {
  return JSON.stringify({
    baseRevision: null,
    fileDigest: DIGEST,
    operationId,
    operations: [providerCreate(providerId)],
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aicr-replica-matrix-"));
  replicaA = await makeReplica();
  autoCommitStore = replicaA.receiptStore;
  replicaB = await makeReplica();
  await replicaA.manager.admission();
  await replicaB.manager.admission();
  const session = await createAdminSession({ config: ADMIN, sessions: replicaA.store }, "admin", "secret-password");
  token = session!.token;
});

afterEach(async () => {
  replicaA.manager.close();
  replicaB.manager.close();
  await replicaA.store.close();
  await replicaB.store.close();
  await replicaA.receiptStore.close?.();
  await replicaB.receiptStore.close?.();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("replica fault matrix (E09)", () => {
  it("crash window: a failed install on A is adopted by B, then A heals after recovery", async () => {
    // Replica A commits the revision but its activation path is down.
    const install = vi.spyOn(replicaA.manager, "install").mockRejectedValue(new Error("install exploded"));
    const admission = vi.spyOn(replicaA.manager, "admission").mockRejectedValue(new Error("activation unavailable"));

    const published = await replicaA.app.request("/aicr/api/admin/config/changesets", {
      method: "POST",
      headers: adminHeaders(),
      body: publishBody("op-crash-1", "db-main"),
    });
    expect(published.status).toBe(202);
    expect(await published.json()).toMatchObject({ status: "committed_activating", stage: "install" });

    // B must adopt on the HTTP admission itself, without a test-side refresh.
    expect(replicaB.manager.current().databaseRevision).toBeNull();
    const payload = giteaPushPayload();
    const hooked = await replicaB.app.request("/aicr/webhooks/gitea", {
      method: "POST",
      headers: giteaHeaders(payload, "push"),
      body: payload,
    });
    expect(hooked.status).toBe(202);
    const adopted = replicaB.manager.current();
    expect(adopted.databaseRevision).toBe(1);
    expect(adopted.snapshotId).not.toBeNull();
    expect(await replicaB.store.readSnapshot(adopted.snapshotId!)).not.toBeNull();
    const hookedBody = (await hooked.json()) as { processing?: { receiptId?: string } };
    const receipt = await autoCommitStore.getReceipt(hookedBody.processing!.receiptId!);
    expect(receipt?.receipt.configSnapshotId).toBe(adopted.snapshotId);

    // A reports the operation as still activating while its admission is down…
    const activating = await replicaA.app.request("/aicr/api/admin/config/operations/op-crash-1", { headers: adminHeaders() });
    expect(activating.status).toBe(202);
    expect(((await activating.json()) as { status: string }).status).toBe("committed_activating");

    // …and committed after its activation path recovers.
    install.mockRestore();
    admission.mockRestore();
    const recovered = await replicaA.app.request("/aicr/api/admin/config/operations/op-crash-1", { headers: adminHeaders() });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: "committed", runtime: { databaseRevision: 1 } });

    // Exactly one revision exists across both replicas.
    expect(await replicaA.store.listRevisions(NAMESPACE, { limit: 10 })).toHaveLength(1);
    expect((await replicaB.store.readHead(NAMESPACE))?.activeRevision).toBe(1);
  });

  it("refuses admission on a real generation prepare failure and retries after recovery", async () => {
    let unavailable = true;
    const prepare = vi.fn(async (generation: { databaseRevision: number | null }) => {
      if (unavailable && generation.databaseRevision === 1) throw new Error("provider initialization failed");
    });
    await replicaB.manager.setGenerationPreparer(prepare);
    const response = await replicaA.app.request("/aicr/api/admin/config/changesets", {
      method: "POST", headers: adminHeaders(), body: publishBody("op-prepare", "prepared"),
    });
    expect(response.status).toBe(200);
    const payload = giteaPushPayload();
    const post = () => replicaB.app.request("/aicr/webhooks/gitea", { method: "POST", headers: giteaHeaders(payload, "push"), body: payload });
    const failed = await post();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ accepted: false, reason: "config_unavailable" });
    expect(replicaB.manager.current().databaseRevision).toBeNull();
    unavailable = false;
    const recovered = await post();
    expect(recovered.status).toBe(202);
    const body = await recovered.json() as { processing: { receiptId: string } };
    expect((await autoCommitStore.getReceipt(body.processing.receiptId))?.receipt.configSnapshotId)
      .toBe(replicaB.manager.current().snapshotId);
    expect(replicaB.manager.current().databaseRevision).toBe(1);
    expect(prepare.mock.calls.filter(([generation]) => generation.databaseRevision === 1)).toHaveLength(2);
  });

  it.each([true, false])("serializes simultaneous saves across separate connections (same operation: %s)", async sameOperation => {
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    for (const replica of [replicaA, replicaB]) {
      const commit = replica.store.commitChangeset.bind(replica.store);
      vi.spyOn(replica.store, "commitChangeset").mockImplementation(async input => {
        if (++arrivals === 2) release();
        await ready;
        return commit(input);
      });
    }
    const results = await Promise.all([replicaA, replicaB].map((replica, index) =>
      replica.app.request("/aicr/api/admin/config/changesets", { method: "POST", headers: adminHeaders(),
        body: publishBody(sameOperation ? "same-operation" : `operation-${index}`, sameOperation ? "same" : `provider-${index}`) })));
    expect(results.map(result => result.status).sort()).toEqual(sameOperation ? [200, 200] : [200, 409]);
    const bodies: unknown[] = await Promise.all(results.map(result => result.json()));
    if (sameOperation) expect(bodies[0]).toEqual(bodies[1]);
    expect(await replicaA.store.listRevisions(NAMESPACE)).toHaveLength(1);
    expect(await replicaB.store.readAudit(NAMESPACE)).toHaveLength(1);
  });

  it("cross-replica idempotency: the same changeset commits exactly one revision (S03)", async () => {
    const body = publishBody("op-shared-1", "shared");
    const first = await replicaA.app.request("/aicr/api/admin/config/changesets", {
      method: "POST",
      headers: adminHeaders(),
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await replicaB.app.request("/aicr/api/admin/config/changesets", {
      method: "POST",
      headers: adminHeaders(),
      body,
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(secondBody).toEqual(firstBody);
    expect(firstBody).toMatchObject({ status: "committed", revision: { revision: 1 } });
    expect(await replicaA.store.listRevisions(NAMESPACE, { limit: 10 })).toHaveLength(1);
    // The replay installed the committed revision on B as well.
    expect(replicaB.manager.current().databaseRevision).toBe(1);
  });

  it("duplicate delivery: one signed delivery to A and B persists exactly one receipt", async () => {
    const payload = giteaPushPayload();
    const headers = { ...giteaHeaders(payload, "push"), "x-gitea-delivery": `delivery-${randomUUID()}` };

    const [first, second] = await Promise.all([
      replicaA.app.request("/aicr/webhooks/gitea", { method: "POST", headers, body: payload }),
      replicaB.app.request("/aicr/webhooks/gitea", { method: "POST", headers, body: payload }),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = (await first.json()) as { processing?: { status?: string; receiptId?: string } };
    const secondBody = (await second.json()) as { processing?: { status?: string; receiptId?: string } };

    expect([firstBody.processing?.status, secondBody.processing?.status].sort()).toEqual(["duplicate", "queued"]);
    expect(secondBody.processing?.receiptId).toBe(firstBody.processing?.receiptId);

    const receipt = await autoCommitStore.getReceipt(firstBody.processing!.receiptId!);
    const streamReceipts = await autoCommitStore.readStreamReceipts(computeStreamId(receipt!.receipt), 0, Number.MAX_SAFE_INTEGER, 10);
    expect(streamReceipts).toHaveLength(1);
  });

  it("disconnect isolation: B's failing store 503s only B and never leaks external requests", async () => {
    const readHead = vi.spyOn(replicaB.store, "readHead").mockRejectedValue(new Error("config backend unreachable"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const payload = giteaPushPayload();
      const failed = await replicaB.app.request("/aicr/webhooks/gitea", {
        method: "POST",
        headers: giteaHeaders(payload, "push"),
        body: payload,
      });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ accepted: false, reason: "config_unavailable" });
      expect((await replicaB.app.request("/aicr/readyz")).status).toBe(503);
      // B's failed path performed zero external requests.
      expect(fetchSpy).not.toHaveBeenCalled();

      // Replica A is unaffected by B's backend failure.
      expect((await replicaA.app.request("/aicr/readyz")).status).toBe(200);
      const accepted = await replicaA.app.request("/aicr/webhooks/gitea", {
        method: "POST",
        headers: giteaHeaders(payload, "push"),
        body: payload,
      });
      expect(accepted.status).toBe(202);
    } finally {
      readHead.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("file digest drift: the drifted replica reports file_config_mismatch instead of serving", async () => {
    const published = await replicaA.app.request("/aicr/api/admin/config/changesets", {
      method: "POST",
      headers: adminHeaders(),
      body: publishBody("op-drift-1", "db-main"),
    });
    expect(published.status).toBe(200);

    // A third replica boots with a different file digest over the same database.
    const drifted = await makeReplica(DRIFTED_DIGEST);
    try {
      expect((await drifted.app.request("/aicr/readyz")).status).toBe(503);

      const payload = giteaPushPayload();
      const denied = await drifted.app.request("/aicr/webhooks/gitea", {
        method: "POST",
        headers: giteaHeaders(payload, "push"),
        body: payload,
      });
      expect(denied.status).toBe(503);
      const deniedBody = (await denied.json()) as { reason?: string; message?: string };
      expect(deniedBody.reason).toBe("config_unavailable");
      expect(deniedBody.message).toContain("file_config_mismatch");

      const status = await drifted.app.request("/aicr/api/admin/config/status", { headers: adminHeaders() });
      expect(status.status).toBe(503);
      const statusBody = (await status.json()) as { admission?: { available: boolean; reason: string } };
      expect(statusBody.admission).toMatchObject({ available: false, reason: "file_config_mismatch" });

      // The matching replicas keep serving.
      expect((await replicaA.app.request("/aicr/readyz")).status).toBe(200);
      expect((await replicaB.app.request("/aicr/readyz")).status).toBe(200);
    } finally {
      drifted.manager.close();
      await drifted.store.close();
      await drifted.receiptStore.close?.();
    }
  });
});

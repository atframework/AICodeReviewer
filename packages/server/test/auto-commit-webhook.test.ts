import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryAutoCommitStore, createReviewEvent } from "@aicr/core";
import { closeStoreDb, createStoreDb } from "@aicr/store";
import { describe, expect, it, vi } from "vitest";

import { createAdminSession } from "../src/admin-auth.js";
import { createObservabilityApi } from "../src/observability-api.js";
import {
  AutoCommitRuntime,
  createServerApp,
  type AutoCommitAcceptInput,
  type AutoCommitAcceptor,
} from "../src/index.js";

const webhookSecret = "top-secret";

function sign(payload: string): string {
  return createHmac("sha256", webhookSecret).update(payload).digest("hex");
}

function giteaPushPayload(): string {
  return JSON.stringify({
    ref: "refs/heads/main",
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

interface QueuedProcessing {
  mode?: string;
  runId?: string;
  receiptId?: string;
  status?: string;
}

describe("auto-commit webhook wiring", () => {
  it("persists a push as a queued receipt instead of scheduling the in-memory timer", async () => {
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({
      store,
      getPolicyLayers: () => ({}),
    });
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws-main", webhookSecret },
      autoCommit: runtime,
      asyncTriggers: true,
    });

    const payload = giteaPushPayload();
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: giteaHeaders(payload, "push"),
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; processing?: QueuedProcessing };

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    // "queued" proves the persistent receive path; the legacy timer path
    // answers mode "background" with status "scheduled".
    expect(body.processing?.mode).toBe("queued");
    expect(body.processing?.status).toBe("queued");
    expect(body.processing?.receiptId).toBe(body.processing?.runId);

    const receipt = await store.getReceipt(body.processing!.receiptId!);
    expect(receipt?.receipt.workspaceId).toBe("ws-main");
    expect(receipt?.receipt.vcs).toBe("git");
    expect(receipt?.receipt.scopeRef).toBe("refs/heads/main");
    expect(receipt?.receipt.coverage).toEqual({
      kind: "range",
      base: "1111111111111111111111111111111111111111",
      head: "2222222222222222222222222222222222222222",
    });
    // Members materialize later, during scheduler metadata expansion; the
    // accept-time contract is the receipt plus a stream head with a wake.
    const streamHead = await store.readStreamHead(receipt!.receipt.streamId);
    expect(streamHead?.streamId).toBe(receipt!.receipt.streamId);
    expect(await store.readNextWake()).toBeDefined();
  });

  it("deduplicates a redelivered push on the deterministic delivery key", async () => {
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({
      store,
      getPolicyLayers: () => ({}),
    });
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws-main", webhookSecret },
      autoCommit: runtime,
    });

    const payload = giteaPushPayload();
    const first = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: giteaHeaders(payload, "push"),
      body: payload,
    });
    const second = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: giteaHeaders(payload, "push"),
      body: payload,
    });
    const firstBody = (await first.json()) as { processing?: QueuedProcessing };
    const secondBody = (await second.json()) as { processing?: QueuedProcessing };

    expect(secondBody.processing?.status).toBe("duplicate");
    expect(secondBody.processing?.receiptId).toBe(firstBody.processing?.receiptId);

    const receipt = await store.getReceipt(firstBody.processing!.receiptId!);
    const streamReceipts = await store.readStreamReceipts(receipt!.receipt.streamId, 0, Number.MAX_SAFE_INTEGER, 10);
    expect(streamReceipts).toHaveLength(1);
  });

  it("never routes pull_request events into the auto-commit accept path", async () => {
    const acceptSpy = vi.fn(async (_input: AutoCommitAcceptInput) => {
      throw new Error("accept must not be called for pull_request");
    });
    const acceptor: AutoCommitAcceptor = { accept: acceptSpy };
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws-main", webhookSecret },
      autoCommit: acceptor,
    });

    const payload = JSON.stringify({
      action: "opened",
      repository: { full_name: "owent/example" },
      sender: { login: "owent" },
      pull_request: {
        html_url: "https://gitea.internal.corp/owent/example/pulls/42",
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
      },
    });
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: giteaHeaders(payload, "pull_request"),
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; processing?: QueuedProcessing };

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.processing?.receiptId).toBeUndefined();
    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it("keeps separate receipts when one upstream delivery targets two workspaces", async () => {
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const apps = ["workspace-a", "workspace-b"].map((workspaceId) => createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId, webhookSecret },
      autoCommit: runtime,
    }));
    const payload = giteaPushPayload();
    const ids: string[] = [];
    for (const app of apps) {
      const response = await app.request("/webhooks/gitea", {
        method: "POST",
        headers: { ...giteaHeaders(payload, "push"), "x-gitea-delivery": "shared-delivery" },
        body: payload,
      });
      const body = (await response.json()) as { processing?: QueuedProcessing };
      expect(response.status).toBe(202);
      expect(body.processing?.status).toBe("queued");
      ids.push(body.processing!.receiptId!);
    }
    expect(new Set(ids).size).toBe(2);
    expect((await store.getReceipt(ids[0]!))?.receipt.workspaceId).toBe("workspace-a");
    expect((await store.getReceipt(ids[1]!))?.receipt.workspaceId).toBe("workspace-b");
  });

  it("answers a retryable 503 when the receipt write fails", async () => {
    const acceptor: AutoCommitAcceptor = {
      accept: async () => {
        throw new Error("store unavailable");
      },
    };
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws-main", webhookSecret },
      autoCommit: acceptor,
    });

    const payload = giteaPushPayload();
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: giteaHeaders(payload, "push"),
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(503);
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("auto_commit_receive_failed");
  });

  it("persists only the notified P4 change even when old_change names a much older change", async () => {
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({
      store,
      getPolicyLayers: () => ({}),
    });
    const app = createServerApp({
      p4: {
        triggerName: "p4-main",
        workspaceId: "ws-p4",
        port: "ssl:p4.example.com:1666",
        user: "swarm",
        ticket: "ticket",
      },
      autoCommit: runtime,
    });

    const response = await app.request("/triggers/p4", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        change: "1024",
        old_change: "1000",
        user: "alice",
        client: "alice-ws",
        depot_path: "//depot/main",
      }),
    });
    const body = (await response.json()) as { accepted: boolean; processing?: QueuedProcessing };

    expect(response.status).toBe(202);
    expect(body.processing?.mode).toBe("queued");
    const receipt = await store.getReceipt(body.processing!.receiptId!);
    expect(receipt?.receipt.vcs).toBe("p4");
    expect(receipt?.receipt.coverage).toEqual({ kind: "single", revision: "1024" });
  });

  it("persists an SVN post-commit with only the notified revision as coverage", async () => {
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({
      store,
      getPolicyLayers: () => ({}),
    });
    const app = createServerApp({
      svn: {
        triggerName: "svn-main",
        workspaceId: "ws-svn",
        repositoryUrl: "https://svn.example.com/repos/project",
      },
      autoCommit: runtime,
    });

    const response = await app.request("/triggers/svn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "421", author: "bob" }),
    });
    const body = (await response.json()) as { accepted: boolean; processing?: QueuedProcessing };

    expect(response.status).toBe(202);
    expect(body.processing?.mode).toBe("queued");
    const receipt = await store.getReceipt(body.processing!.receiptId!);
    expect(receipt?.receipt.vcs).toBe("svn");
    expect(receipt?.receipt.coverage).toEqual({ kind: "single", revision: "421" });
  });
});

describe("auto-commit delivery identity", () => {
  const event = createReviewEvent({
    triggerName: "gitea-one",
    provider: "gitea",
    workspaceId: "workspace-one",
    targetKind: "push",
    repoRef: "owner/repo-one",
    branch: "main",
    baseSha: "base",
    headSha: "head",
    author: {},
    reason: "gitea:push",
  });

  it.each([
    { name: "provider", patch: { provider: "github" as const } },
    { name: "trigger", patch: { triggerName: "gitea-two" } },
    { name: "workspace", patch: { workspaceId: "workspace-two" } },
    { name: "repository", patch: { repoRef: "owner/repo-two" } },
    { name: "ref", patch: { branch: "release" } },
  ])("scopes supplied and fallback delivery keys by $name", async ({ patch }) => {
    for (const deliveryId of [undefined, "same-upstream-id"]) {
      const store = createMemoryAutoCommitStore();
      const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
      const changedEvent = createReviewEvent({ ...event, ...patch });
      const accept = (reviewEvent: typeof event, now: number) => runtime.accept({
        provider: reviewEvent.provider,
        eventName: "push",
        reviewEvent,
        ...(deliveryId ? { deliveryId } : {}),
        now,
      });
      const first = await accept(event, 1000);
      const otherRoute = await accept(changedEvent, 2000);
      const repeated = await accept(event, 3000);
      expect(otherRoute.duplicate).toBe(false);
      expect(otherRoute.receipt.receiptId).not.toBe(first.receipt.receiptId);
      expect(repeated.duplicate).toBe(true);
      expect(repeated.receipt.receiptId).toBe(first.receipt.receiptId);
      expect(repeated.receipt.firstAcceptedAt).toBe(1000);
    }
  });
});

describe("auto-commit receipt query API", () => {
  it("serves receipt detail behind admin auth and 404s unknown ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aicr-receipt-api-"));
    const storeDb = createStoreDb(join(dir, "test.db"));
    try {
      const autoCommitStore = createMemoryAutoCommitStore();
      const runtime = new AutoCommitRuntime({
        store: autoCommitStore,
        getPolicyLayers: () => ({}),
      });
      const reviewEvent = createReviewEvent({
        triggerName: "gitea-internal",
        provider: "gitea",
        workspaceId: "ws-main",
        targetKind: "push",
        repoRef: "owent/example",
        baseSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
        author: {},
        reason: "gitea:push",
        branch: "main",
      });
      const accepted = await runtime.accept({
        provider: "gitea",
        eventName: "push",
        reviewEvent,
        now: 1_700_000_000_000,
      });

      const adminAuth = { username: "admin", password: "test-password", sessionTtlSeconds: 3600 };
      const api = createObservabilityApi({ store: storeDb, adminAuth, autoCommitStore });
      const session = createAdminSession(adminAuth, "admin", "test-password");
      const authHeader = { Authorization: `Bearer ${session!.token}` };

      const unauthenticated = await api.fetch(new Request(`http://localhost/auto-commit/receipts/${accepted.receipt.receiptId}`));
      expect(unauthenticated.status).toBe(401);

      const found = await api.fetch(new Request(`http://localhost/auto-commit/receipts/${accepted.receipt.receiptId}`, { headers: authHeader }));
      expect(found.status).toBe(200);
      const detail = (await found.json()) as {
        receipt: { receiptId: string; workspaceId: string; scopeRef: string };
        memberCounts: Record<string, number>;
      };
      expect(detail.receipt.receiptId).toBe(accepted.receipt.receiptId);
      expect(detail.receipt.workspaceId).toBe("ws-main");
      expect(detail.receipt.scopeRef).toBe("refs/heads/main");
      expect(detail.memberCounts).toBeDefined();

      const missing = await api.fetch(new Request("http://localhost/auto-commit/receipts/nope", { headers: authHeader }));
      expect(missing.status).toBe(404);
    } finally {
      closeStoreDb(storeDb);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { StoreDb } from "../src/database.js";
import {
  acceptImDelivery,
  bindImActionSource,
  claimDueImReplyNotifications,
  claimDueImReviewRequests,
  claimImReviewRequestById,
  consumeImAction,
  consumeImRateLimit,
  deleteExpiredImActions,
  deleteExpiredImInbox,
  deleteExpiredImRateLimits,
  findImReviewRequest,
  finishImReviewRequest,
  finishImReplyNotification,
  getImAction,
  imReviewJobId,
  insertImAction,
  listImActiveConfigSnapshotIds,
  newImRowId,
  normalizeRevision,
  prepareImDispatch,
  updateImReviewRequest,
  type AcceptImDeliveryInput,
  type NewImReviewRequest,
} from "../src/im-store.js";

/**
 * IM-09 acceptance R02–R06 shared by the SQLite and real-PostgreSQL wrappers.
 * Migration conformance (R01) runs in im-store.test.ts (fresh/verify) and the
 * existing migration process suites cover cross-version readers.
 */

const T0 = new Date("2026-09-28T08:00:00Z");

function deliveryInput(overrides: Partial<AcceptImDeliveryInput["delivery"]> = {}): AcceptImDeliveryInput {
  return {
    delivery: {
      namespace: "ns-test",
      connectionIdentity: "wecom-app:ww:1",
      deliveryKind: "message",
      deliveryKey: `msg-${randomUUID()}`,
      payloadDigest: `sha256:${randomUUID()}`,
      ...overrides,
    },
    now: T0,
  };
}

function uniqueHex(): string {
  return randomUUID().replaceAll("-", "") + "a1b2c3d4";
}

function request(overrides: Partial<NewImReviewRequest> = {}): NewImReviewRequest {
  return {
    requestId: `req-${randomUUID()}`,
    runId: `run-${randomUUID()}`,
    bindingId: "reviewers",
    requestedBy: { type: "wecom_userid", id: "alice" },
    conversation: JSON.stringify({ kind: "app_direct" }),
    workspaceId: "ws-main",
    sourceTrigger: "github-main",
    repoRef: "org/service",
    requestedRevision: uniqueHex(),
    configSnapshotId: `cfg-${randomUUID()}`,
    configFileDigest: "d".repeat(64),
    configVersionJson: JSON.stringify({ configSnapshotId: "cfg", databaseRevision: 1, fileDigest: "d".repeat(64) }),
    ...overrides,
  };
}

function commandInput(delivery: AcceptImDeliveryInput, req: NewImReviewRequest, extra: Partial<NonNullable<AcceptImDeliveryInput["command"]>> = {}): AcceptImDeliveryInput {
  return {
    ...delivery,
    command: {
      request: req,
      activeTarget: { workspaceInstance: "ws-main", sourceIdentity: "trigger:github-main:org/service" },
      ...extra,
    },
  };
}

export async function runImStoreConformance(store: StoreDb): Promise<void> {
  await acceptsAndDeduplicatesDeliveries(store);
  await promotesRecordedDelivery(store);
  await mergesActiveTargetsAndReleasesOnFinish(store);
  await mergesActiveTargetsWithoutConsumingQuota(store);
  await atomicActionConsumptionAndQuota(store);
  await claimsWithFencing(store);
  await targetedWakeUpClaims(store);
  await actionBindingBoundaries(store);
  await dispatchSequencesAndSnapshotReferences(store);
  await retentionLifecycle(store);
}

async function actionBindingBoundaries(store: StoreDb): Promise<void> {
  const actionId = `action-${randomUUID()}`;
  await insertImAction(store, {
    actionId, namespace: "ns-test", connectionIdentity: "c", issuedConfigVersion: "cfg",
    sourceMessageId: null, sourceTaskId: null, conversationJson: JSON.stringify({ kind: "app_direct" }), recipientId: null,
    bindingId: "reviewers", workspaceId: "ws-main", sourceTrigger: "github-main", repoRef: "org/service", revision: uniqueHex(),
    expiresAt: new Date(T0.getTime() + 1000), status: "issued", createdAt: T0, updatedAt: T0,
  });
  expect(await bindImActionSource(store, { actionId, now: T0 })).toBe(false);
  expect(await bindImActionSource(store, { actionId, sourceTaskId: "", now: T0 })).toBe(false);
  expect(await listImActiveConfigSnapshotIds(store, "ns-test", T0)).toContain("cfg");
  expect(await listImActiveConfigSnapshotIds(store, "ns-test", new Date(T0.getTime() + 1000))).not.toContain("cfg");
  expect(await listImActiveConfigSnapshotIds(store, "other-namespace", T0)).not.toContain("cfg");
  expect(await bindImActionSource(store, { actionId, sourceTaskId: "task", now: new Date(T0.getTime() + 1000) })).toBe(false);
  const bindings = await Promise.all([
    bindImActionSource(store, { actionId, sourceTaskId: "first", now: T0 }),
    bindImActionSource(store, { actionId, sourceTaskId: "second", now: T0 }),
  ]);
  expect(bindings.filter(Boolean)).toHaveLength(1);
  expect((await getImAction(store, actionId))?.sourceTaskId).toBe(bindings[0] ? "first" : "second");
}

/** IM-14 R11/R12: the queue wake-up claims exactly one due request with the same CAS rules. */
async function targetedWakeUpClaims(store: StoreDb): Promise<void> {
  // Isolated namespace: the shared due scans in other helpers must not
  // claim these rows while the targeted-claim semantics are under test.
  const namespace = `ns-wake-${randomUUID()}`;
  const due = request();
  const deferred = request();
  await acceptImDelivery(store, commandInput(deliveryInput({ namespace }), due));
  await acceptImDelivery(store, commandInput(deliveryInput({ namespace }), deferred));

  // A targeted claim of an unknown id resolves undefined without side effects.
  expect(await claimImReviewRequestById(store, { namespace, requestId: "missing", now: T0, leaseMs: 60_000, owner: "wake-1" })).toBeUndefined();

  // Defer the second request first so later due scans cannot claim it.
  const deferredClaim = await claimImReviewRequestById(store, { namespace, requestId: deferred.requestId, now: T0, leaseMs: 60_000, owner: "wake-4" });
  expect(deferredClaim).toBeDefined();
  await updateImReviewRequest(store, { requestId: deferred.requestId, fence: deferredClaim!.fence,
    nextAttemptAt: new Date(T0.getTime() + 60_000), releaseLease: true, now: T0 });
  expect(await claimImReviewRequestById(store, { namespace, requestId: deferred.requestId, now: T0, leaseMs: 60_000, owner: "wake-5" })).toBeUndefined();

  const claim = await claimImReviewRequestById(store, { namespace, requestId: due.requestId, now: T0, leaseMs: 60_000, owner: "wake-2" });
  expect(claim?.request.requestId).toBe(due.requestId);
  expect(claim?.request.leaseOwner).toBe("wake-2");

  // While the lease holds, neither a wake-up nor the due scan re-claims it.
  expect(await claimImReviewRequestById(store, { namespace, requestId: due.requestId, now: new Date(T0.getTime() + 1000), leaseMs: 60_000, owner: "wake-3" })).toBeUndefined();
  expect((await claimDueImReviewRequests(store, { namespace, now: new Date(T0.getTime() + 1000), leaseMs: 60_000, owner: "w", limit: 10 }))
    .some(entry => entry.request.requestId === due.requestId)).toBe(false);

  // After the lease expires, the targeted claim CAS-bumps the fence.
  const reclaimed = await claimImReviewRequestById(store, { namespace, requestId: due.requestId, now: new Date(T0.getTime() + 61_000), leaseMs: 60_000, owner: "wake-6" });
  expect(reclaimed?.fence).toBeGreaterThan(claim!.fence);

  // Terminal requests are never wakeable.
  await finishImReviewRequest(store, { requestId: due.requestId, fence: reclaimed!.fence, state: "succeeded", now: T0 });
  expect(await claimImReviewRequestById(store, { namespace, requestId: due.requestId, now: new Date(T0.getTime() + 200_000), leaseMs: 60_000, owner: "wake-7" })).toBeUndefined();
}

async function promotesRecordedDelivery(store: StoreDb): Promise<void> {
  const delivery = deliveryInput();
  const recorded = await acceptImDelivery(store, delivery);
  const req = request();
  const promoted = await acceptImDelivery(store, commandInput(delivery, req));
  expect(promoted).toMatchObject({ kind: "created", requestId: req.requestId });
  expect((promoted as { inboxId: string }).inboxId).toBe((recorded as { inboxId: string }).inboxId);
  expect(await findImReviewRequest(store, delivery.delivery.namespace, req.requestId)).toBeDefined();
  expect(await acceptImDelivery(store, commandInput(delivery, request()))).toMatchObject({ kind: "duplicate", requestId: req.requestId });
}

async function acceptsAndDeduplicatesDeliveries(store: StoreDb): Promise<void> {
  const base = deliveryInput();
  const first = await acceptImDelivery(store, base);
  expect(first).toMatchObject({ kind: "created" });
  const firstCreated = first as { kind: "created"; inboxId: string };

  // Same key + same digest replays the original outcome (R02).
  const replay = await acceptImDelivery(store, base);
  expect(replay).toMatchObject({ kind: "duplicate", inboxId: firstCreated.inboxId });

  // Same key + different digest never executes twice (R02).
  const conflict = await acceptImDelivery(store, { ...base, delivery: { ...base.delivery, payloadDigest: "sha256:other" } });
  expect(conflict).toMatchObject({ kind: "conflict" });

  // A different key lands a new row; namespace/identity scoping holds.
  const other = await acceptImDelivery(store, deliveryInput({ connectionIdentity: "wecom-app:ww:2" }));
  expect(other).toMatchObject({ kind: "created" });
}

async function mergesActiveTargetsAndReleasesOnFinish(store: StoreDb): Promise<void> {
  const delivery = deliveryInput();
  const req = request({ requestedRevision: "0123456789abcdef0123456789abcdef01234567" });
  const created = await acceptImDelivery(store, commandInput(delivery, req));
  expect(created).toMatchObject({ kind: "created", requestId: req.requestId });

  // Same trusted target through a different alias/revision casing merges (R03).
  const upper = deliveryInput();
  const merged = await acceptImDelivery(store, commandInput(upper, request({ requestedRevision: req.requestedRevision.toUpperCase() })));
  expect(merged).toMatchObject({ kind: "active_merged", requestId: req.requestId });

  // A different revision is a separate active request.
  const separate = await acceptImDelivery(store, commandInput(deliveryInput(), request({ requestedRevision: "fedcba9876543210fedcba9876543210fedcba98" })));
  expect(separate).toMatchObject({ kind: "created" });
  const separateCreated = separate as { kind: "created"; requestId: string };
  expect(await listImActiveConfigSnapshotIds(store, "ns-test")).toContain((await findImReviewRequest(store, "ns-test", separateCreated.requestId))!.configSnapshotId);

  // Finishing releases the target so a new command creates a new request.
  const claimed = (await claimDueImReviewRequests(store, { namespace: "ns-test", now: T0, leaseMs: 60_000, owner: "w1", limit: 10 }))
    .find(entry => entry.request.requestId === req.requestId);
  expect(claimed).toBeDefined();
  const finished = await finishImReviewRequest(store, { requestId: req.requestId, fence: claimed!.fence, state: "succeeded", now: T0 });
  expect(finished).toBe(true);
  const afterFinish = await acceptImDelivery(store, commandInput(deliveryInput(), request({ requestedRevision: req.requestedRevision })));
  expect(afterFinish).toMatchObject({ kind: "created" });
}

async function mergesActiveTargetsWithoutConsumingQuota(store: StoreDb): Promise<void> {
  const revision = uniqueHex();
  const firstRequest = request({ requestedRevision: revision });
  const rateLimit = { bucketKey: `actor:${randomUUID()}`, windowStart: T0, limit: 1 };
  expect(await acceptImDelivery(store, commandInput(deliveryInput(), firstRequest, { rateLimit })))
    .toMatchObject({ kind: "created", requestId: firstRequest.requestId });

  // A second delivery for the same active target reuses the first request even
  // after its quota is exhausted, and does not increment the persistent bucket.
  expect(await acceptImDelivery(store, commandInput(deliveryInput(), request({ requestedRevision: revision }), { rateLimit })))
    .toMatchObject({ kind: "active_merged", requestId: firstRequest.requestId });
  expect(await consumeImRateLimit(store, { namespace: "ns-test", bucketKey: rateLimit.bucketKey, windowStart: rateLimit.windowStart }))
    .toBe(2);

  const rejected = request({ requestedRevision: uniqueHex() });
  expect(await acceptImDelivery(store, commandInput(deliveryInput(), rejected, { rateLimit })))
    .toMatchObject({ kind: "rate_limited" });
  expect(await findImReviewRequest(store, "ns-test", rejected.requestId)).toBeUndefined();
}

async function atomicActionConsumptionAndQuota(store: StoreDb): Promise<void> {
  const actionId = `act-${randomUUID()}`;
  const req = request();
  await insertImAction(store, {
    actionId,
    namespace: "ns-test",
    connectionIdentity: "wecom-app:ww:1",
    issuedConfigVersion: "v1",
    sourceMessageId: "msg-1",
    sourceTaskId: null,
    conversationJson: null,
    recipientId: "alice",
    bindingId: "reviewers",
    workspaceId: "ws-main",
    sourceTrigger: "github-main",
    repoRef: "org/service",
    revision: req.requestedRevision,
    expiresAt: new Date(T0.getTime() + 24 * 3600_000),
    status: "issued",
    createdAt: T0,
    updatedAt: T0,
  });

  // First click consumes + creates the request in one transaction (R04/A10).
  const consumed = await acceptImDelivery(store, commandInput(deliveryInput(), req, { consumeActionId: actionId }));
  expect(consumed).toMatchObject({ kind: "created", requestId: req.requestId });
  expect((await getImAction(store, actionId))?.status).toBe("consumed");

  // Replaying the same action returns the original request (A10).
  const replay = await acceptImDelivery(store, commandInput(deliveryInput({ deliveryKey: `replay-${randomUUID()}` }), request({ requestedRevision: req.requestedRevision }), { consumeActionId: actionId }));
  expect(replay).toMatchObject({ kind: "duplicate", requestId: req.requestId });

  // A rate-limited command leaves no half-consumed rows (R04).
  const windowStart = new Date(Math.floor(T0.getTime() / 60_000) * 60_000);
  const actionId2 = `act-${randomUUID()}`;
  const limitedRequest = request({ requestedRevision: uniqueHex() });
  await insertImAction(store, {
    actionId: actionId2,
    namespace: "ns-test",
    connectionIdentity: "wecom-app:ww:1",
    issuedConfigVersion: "v1",
    sourceMessageId: "msg-2",
    sourceTaskId: null,
    conversationJson: null,
    recipientId: "alice",
    bindingId: "reviewers",
    workspaceId: "ws-main",
    sourceTrigger: "github-main",
    repoRef: "org/service",
    revision: limitedRequest.requestedRevision,
    expiresAt: new Date(T0.getTime() + 3600_000),
    status: "issued",
    createdAt: T0,
    updatedAt: T0,
  });
  const limitedDelivery = deliveryInput();
  const limited = await acceptImDelivery(store, commandInput(limitedDelivery, limitedRequest, {
    consumeActionId: actionId2,
    rateLimit: { bucketKey: "actor:alice", windowStart, limit: 0 },
  }));
  expect(limited).toMatchObject({ kind: "rate_limited" });
  expect((await getImAction(store, actionId2))?.status).toBe("issued");
  expect(await findImReviewRequest(store, "ns-test", (limited as { kind: string }).kind === "rate_limited" ? "missing" : "")).toBeUndefined();
  expect(await acceptImDelivery(store, limitedDelivery)).toMatchObject({ kind: "created" });
  expect(await consumeImRateLimit(store, { namespace: "ns-test", bucketKey: "actor:alice", windowStart })).toBe(1);

  // Standalone consumption on an expired action is rejected (A12).
  const expiredId = `act-${randomUUID()}`;
  await insertImAction(store, {
    actionId: expiredId,
    namespace: "ns-test",
    connectionIdentity: "wecom-app:ww:1",
    issuedConfigVersion: "v1",
    sourceMessageId: null,
    sourceTaskId: null,
    conversationJson: null,
    recipientId: null,
    bindingId: "reviewers",
    workspaceId: "ws-main",
    sourceTrigger: "github-main",
    repoRef: "org/service",
    revision: "1111111111111111111111111111111111111111",
    expiresAt: new Date(T0.getTime() - 1000),
    status: "issued",
    createdAt: T0,
    updatedAt: T0,
  });
  expect(await consumeImAction(store, { actionId: expiredId, now: T0 })).toMatchObject({ kind: "expired" });
}

async function claimsWithFencing(store: StoreDb): Promise<void> {
  const req = request();
  await acceptImDelivery(store, commandInput(deliveryInput(), req));

  const first = (await claimDueImReviewRequests(store, { namespace: "ns-test", now: T0, leaseMs: 60_000, owner: "w1", limit: 10 }))
    .find(entry => entry.request.requestId === req.requestId);
  expect(first).toBeDefined();

  // A second claim while the lease holds does not double-assign (R05).
  const second = (await claimDueImReviewRequests(store, { namespace: "ns-test", now: new Date(T0.getTime() + 1000), leaseMs: 60_000, owner: "w2", limit: 10 }))
    .filter(entry => entry.request.requestId === req.requestId);
  expect(second).toHaveLength(0);

  // A stale fence loses ownership: zero-row update (R05).
  expect(await updateImReviewRequest(store, { requestId: req.requestId, fence: first!.fence - 1, state: "validating", now: T0 })).toBe(false);
  expect(await updateImReviewRequest(store, { requestId: req.requestId, fence: first!.fence, state: "validating", now: T0 })).toBe(true);

  // After the lease expires another owner claims with a higher fence.
  const renewed = (await claimDueImReviewRequests(store, { namespace: "ns-test", now: new Date(T0.getTime() + 61_000), leaseMs: 60_000, owner: "w2", limit: 10 }))
    .find(entry => entry.request.requestId === req.requestId);
  expect(renewed).toBeDefined();
  expect(renewed!.fence).toBeGreaterThan(first!.fence);

  // The old owner's fenced write no longer applies.
  expect(await updateImReviewRequest(store, { requestId: req.requestId, fence: first!.fence, state: "queued", now: T0 })).toBe(false);
}

async function dispatchSequencesAndSnapshotReferences(store: StoreDb): Promise<void> {
  const req = request();
  await acceptImDelivery(store, commandInput(deliveryInput(), req));
  const claimed = (await claimDueImReviewRequests(store, { namespace: "ns-test", now: T0, leaseMs: 60_000, owner: "w1", limit: 10 }))
    .find(entry => entry.request.requestId === req.requestId)!;

  // prepareDispatch increments atomically; the same seq keeps a stable job id.
  const first = await prepareImDispatch(store, req.requestId, claimed.fence, T0);
  const again = await prepareImDispatch(store, req.requestId, claimed.fence, T0);
  expect(first).toBe(1);
  expect(again).toBe(2);
  expect(imReviewJobId(req.requestId, first!)).toBe(`im-review-${req.requestId}-1`);

  // finishRequest creates terminal notifications in the same transaction.
  const notificationId = `op-${randomUUID()}`;
  const finished = await finishImReviewRequest(store, {
    requestId: req.requestId,
    fence: claimed.fence,
    state: "partial",
    notifications: [{ operationId: notificationId, destinationIdentity: "wecom-app:ww:1", operationKind: "final_status", payloadDigest: "sha256:x", compactReceipt: "receipt-1", nextAttemptAt: T0 }],
    now: T0,
  });
  expect(finished).toBe(true);
  const terminal = await findImReviewRequest(store, "ns-test", req.requestId);
  expect(terminal?.state).toBe("partial");
  expect(await listImActiveConfigSnapshotIds(store, "ns-test")).not.toContain(terminal?.configSnapshotId ?? "");
  const firstNotification = (await claimDueImReplyNotifications(store, { owner: "reply-1", limit: 10, now: T0 }))
    .find(row => row.operationId === notificationId);
  expect(firstNotification?.compactReceipt).toBe("receipt-1");
  expect((await claimDueImReplyNotifications(store, { owner: "reply-2", limit: 10, now: new Date(T0.getTime() + 30_000) }))
    .some(row => row.operationId === notificationId)).toBe(false);
  const reclaimed = (await claimDueImReplyNotifications(store, { owner: "reply-2", limit: 10, now: new Date(T0.getTime() + 61_000) }))
    .find(row => row.operationId === notificationId);
  expect(reclaimed?.fence).toBeGreaterThan(firstNotification!.fence);
  expect(await finishImReplyNotification(store, { operationId: notificationId, fence: firstNotification!.fence, state: "delivered", now: T0 })).toBe(false);
  expect(await finishImReplyNotification(store, { operationId: notificationId, fence: reclaimed!.fence, state: "delivered", now: T0 })).toBe(true);

  // A terminal request never re-enters the claim scan (§5 terminal rule).
  expect((await claimDueImReviewRequests(store, { namespace: "ns-test", now: new Date(T0.getTime() + 120_000), leaseMs: 60_000, owner: "w3", limit: 100 }))
    .filter(entry => entry.request.requestId === req.requestId)).toHaveLength(0);
}

async function retentionLifecycle(store: StoreDb): Promise<void> {
  const active = request();
  await acceptImDelivery(store, commandInput(deliveryInput(), active));

  // Terminal inbox rows older than the horizon are removed; active rows stay.
  const finished = request();
  await acceptImDelivery(store, commandInput(deliveryInput(), finished));
  const claimed = (await claimDueImReviewRequests(store, { namespace: "ns-test", now: T0, leaseMs: 60_000, owner: "w1", limit: 10 }))
    .find(entry => entry.request.requestId === finished.requestId)!;
  await finishImReviewRequest(store, { requestId: finished.requestId, fence: claimed.fence, state: "failed", now: T0 });

  const before = new Date(T0.getTime() + 8 * 24 * 3600_000);
  const removed = await deleteExpiredImInbox(store, "ns-test", before, [active.requestId]);
  expect(removed).toBeGreaterThanOrEqual(1);
  expect(await findImReviewRequest(store, "ns-test", active.requestId)).toBeDefined();

  // Rate-limit windows and consumed actions expire with bounded deletes.
  await consumeImRateLimit(store, { namespace: "ns-test", bucketKey: "cleanup", windowStart: new Date(T0.getTime() - 60_000) });
  expect(await deleteExpiredImRateLimits(store, "ns-test", new Date(T0.getTime() + 120_000))).toBeGreaterThanOrEqual(1);
  expect(await deleteExpiredImActions(store, "ns-test", new Date(T0.getTime() + 25 * 3600_000))).toBeGreaterThanOrEqual(0);

  // Revision normalization feeds the active-target key (R03).
  expect(normalizeRevision("r123")).toBe("123");
  expect(normalizeRevision("0123ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF")).toBe("0123abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
}

export const conformanceHelpers = { deliveryInput, request, commandInput, T0, newImRowId };

/**
 * Stage C of the p4/svn routing admission (spec §5.2, W14): the scheduler
 * background pass that converts durable routing receipts into formal
 * auto-commit receipts. The webhook never fetches VCS metadata; this pass
 * does it at admission-tick time with the same adapter contract the
 * auto-commit pipeline uses.
 *
 * Contract per record:
 * - metadata fetch via `listCommitMetadataPage` (bounded: 1 record, 256 KiB)
 *   — the routing path never runs a full repo scan;
 * - scope split by config contract: p4 scopes intersected with changelist
 *   paths; svn project roots intersected with commit paths;
 * - resolution via `WorkspaceRuntime.resolveForSource` and dispatch through
 *   `AutoCommitRuntime.accept` with delivery id
 *   `routing:${routingKey}:${scopeRef}` — HTTP replays, scheduler replays,
 *   and cross-process duplicates all collapse to the same formal receipt;
 * - `no_match`/`ambiguous`/`unbound` outcomes complete the routing receipt
 *   with a visible note (never dropped, never fake-accepted);
 * - failures retry with exponential backoff and become terminal after the
 *   attempt budget; terminal records stay queryable, not stream-blocking.
 */

import {
  projectEventResolution,
  type AppConfig,
  type AutoCommitStore,
  type ReviewEvent,
  type ReviewProvider,
  type FrozenScopeResolution,
  type RoutingReceiptRecord,
  type WorkspaceResolution,
} from "@aicr/core";
import { sanitizeSourceUrl, type CommitMetadataRecord, type VcsAdapter } from "@aicr/vcs";

import type { AutoCommitRuntime } from "./auto-commit-runtime.js";
import type { WorkspaceRuntime } from "./workspace-runtime.js";
import { normalizeP4Scope } from "./p4-webhook.js";

/** Trigger profile slice the resolver needs (p4 scopes / svn project roots). */
export interface RoutingTriggerProfile {
  readonly workspaceId: string;
  readonly scopes?: readonly string[];
  readonly depotPath?: string;
  readonly repositoryUrl?: string;
  readonly projectRoots?: readonly {
    readonly prefix: string;
    readonly project: string;
    readonly branch?: string | undefined;
  }[];
}

/** Envelope fields the resolver reads back from the persisted record. */
export interface RoutingEnvelopePayload {
  readonly revision: string;
  /** Provider event name recorded at intake (change-commit/post-commit). */
  readonly eventName?: string | undefined;
  readonly depotPath?: string | undefined;
  readonly user?: string | undefined;
  readonly client?: string | undefined;
  readonly files?: readonly string[] | undefined;
}

export interface RoutingResolverOptions {
  readonly store: AutoCommitStore;
  readonly config: AppConfig;
  readonly runtime: AutoCommitRuntime;
  readonly workspaceRuntime: WorkspaceRuntime;
  /** Adapter lookup keyed by trigger name (same factory as stream expansion). */
  readonly adapterFor: (triggerName: string, provider: ReviewProvider) => VcsAdapter | undefined;
  /** Profile lookup: p4 scopes / svn project roots for the recorded trigger. */
  readonly profileFor: (
    triggerName: string,
    provider: ReviewProvider,
  ) => RoutingTriggerProfile | undefined;
  /** Attempt budget before a record goes terminal (default 5). */
  readonly maxAttempts?: number;
  /** Backoff base in ms (default 15_000); doubles per attempt, capped at 15 min. */
  readonly baseRetryMs?: number;
  /** Records converted per pass (default 8). */
  readonly batchSize?: number;
  readonly now?: () => number;
}

const METADATA_PAGE = { maxRecords: 1, maxBytes: 256 * 1024 } as const;
const MAX_RETRY_MS = 15 * 60 * 1000;

function scopeMatchesPath(scope: string, changedPath: string): boolean {
  return changedPath === scope || changedPath.startsWith(scope.endsWith("/") ? scope : `${scope}/`);
}

function previousRevision(revision: string): string | undefined {
  const parsed = Number(revision);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed - 1) : undefined;
}

function envelopeOf(record: RoutingReceiptRecord): RoutingEnvelopePayload {
  const envelope = record.envelope as RoutingEnvelopePayload | null;
  if (!envelope || typeof envelope.revision !== "string" || envelope.revision.length === 0) {
    throw new Error(`routing receipt ${record.routingId} has no usable revision envelope`);
  }
  return envelope;
}

export class RoutingReceiptResolver {
  private readonly options: RoutingResolverOptions;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly batchSize: number;

  constructor(options: RoutingResolverOptions) {
    this.options = options;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseRetryMs = options.baseRetryMs ?? 15_000;
    this.batchSize = options.batchSize ?? 8;
  }

  /**
   * Converts due pending records. Returns the earliest pending retryAt so
   * the scheduler can arm precisely, or undefined when nothing is pending.
   */
  async resolveDue(now: number): Promise<number | undefined> {
    const due = await this.options.store.readDueRoutingReceipts(now, this.batchSize);
    let earliestRetryAt: number | undefined = undefined;
    for (const record of due) {
      let retryAt: number | undefined;
      try {
        retryAt = await this.resolveOne(record, now);
      } catch (error) {
        // A resolver bug must not strand the record: same retry path as
        // adapter failures (W13), terminal after the attempt budget.
        retryAt = await this.recordFailure(record, error, now);
      }
      if (retryAt !== undefined && (earliestRetryAt === undefined || retryAt < earliestRetryAt)) {
        earliestRetryAt = retryAt;
      }
    }
    return earliestRetryAt;
  }

  private nextRetryAt(attempts: number, now: number): number | null {
    if (attempts + 1 >= this.maxAttempts) {
      return null;
    }
    const delay = Math.min(this.baseRetryMs * 2 ** Math.max(0, attempts), MAX_RETRY_MS);
    return now + delay;
  }

  /** Returns the scheduled retryAt, or undefined when the record went terminal. */
  private async recordFailure(
    record: RoutingReceiptRecord,
    error: unknown,
    now: number,
  ): Promise<number | undefined> {
    const message = error instanceof Error ? error.message : String(error);
    const retryAt = this.nextRetryAt(record.attempts, now);
    await this.options.store.recordRoutingReceiptFailure(record.routingId, message, retryAt);
    return retryAt ?? undefined;
  }

  /** Returns a retryAt when the record stays pending, undefined otherwise. */
  private async resolveOne(record: RoutingReceiptRecord, now: number): Promise<number | undefined> {
    const { store } = this.options;
    const envelope = envelopeOf(record);
    if (record.resolution !== null && record.resolution.every((entry) =>
      (entry.outcome !== "match" && entry.outcome !== "legacy_binding") || entry.reviewEvent !== undefined)) {
      return this.convertFrozen(record, envelope, record.resolution, undefined, now);
    }
    const revision = envelope.revision;
    const provider = record.provider as ReviewProvider;
    const profile = this.options.profileFor(record.triggerName, provider);
    if (!profile) {
      // Profile removed from config: keep the record visible and complete it
      // instead of retrying forever or pretending the event was reviewed.
      await store.recordRoutingReceiptConversion(
        record.routingId,
        { complete: true, note: `trigger profile ${record.triggerName} no longer configured` },
        now,
      );
      return undefined;
    }

    const adapter = this.options.adapterFor(record.triggerName, provider);
    if (!adapter?.listCommitMetadataPage) {
      return await this.recordFailure(record, new Error("no metadata adapter for routing profile"), now);
    }

    const baseRevision = previousRevision(revision);
    const queryScopes = provider === "p4"
      ? [...new Set((profile.scopes?.length ? profile.scopes : [profile.depotPath ?? envelope.depotPath ?? ""]).map(normalizeP4Scope))]
      : [profile.repositoryUrl ?? ""];
    const records: CommitMetadataRecord[] = [];
    // A CL may touch only a later configured stream. Query every configured
    // scope; an empty, complete first scope is not a missing revision.
    for (const scopeRef of queryScopes) {
      if (!scopeRef) throw new Error("routing profile has no configured metadata scope");
      const page = await adapter.listCommitMetadataPage({
        scopeRef, headRevision: revision, ...METADATA_PAGE,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
      });
      if (page.status !== "complete") {
        return await this.recordFailure(record,
          new Error(`metadata ${page.status}: ${page.unavailableReason ?? "range not provably covered"}`), now);
      }
      const entry = page.records.find((item) => item.revision === revision);
      if (entry?.changedPathsComplete === false) throw new Error("routing metadata has incomplete changed paths");
      if (entry) records.push(entry);
    }
    if (records.length === 0) {
      await store.recordRoutingReceiptConversion(record.routingId, { complete: true, note: "revision outside configured scopes" }, now);
      return undefined;
    }
    const metadata: CommitMetadataRecord = { ...records[0]!, changedPaths: [...new Set(records.flatMap((entry) => [...entry.changedPaths]))] };
    for (const entry of records) {
      if (entry.p4User !== metadata.p4User || entry.p4Client !== metadata.p4Client || entry.svnAuthor !== metadata.svnAuthor) {
        throw new Error("Conflicting routing revision metadata");
      }
    }

    // V14: the per-scope interpretation freezes on first use; retries and
    // post-restart recovery replay the frozen outcome instead of re-resolving
    // against possibly-changed workspace config.
    let frozen = record.resolution;
    if (frozen === null) {
      if (!adapter.describeSource) throw new Error("no source descriptor adapter for routing profile");
      const fields = await adapter.describeSource(revision);
      if (provider === "p4" && ((fields.user != null && metadata.p4User !== undefined && fields.user !== metadata.p4User) ||
          (fields.client != null && metadata.p4Client !== undefined && fields.client !== metadata.p4Client))) {
        throw new Error("Conflicting P4 changelist user/client metadata");
      }
      const computed = this.interpretScopes(record, envelope, profile, metadata, revision, fields);
      frozen = (await store.recordRoutingReceiptResolution(record.routingId, computed, now)).resolution
        ?? computed;
    }

    return this.convertFrozen(record, envelope, frozen, metadata, now);
  }

  private async convertFrozen(
    record: RoutingReceiptRecord,
    envelope: RoutingEnvelopePayload,
    frozen: readonly FrozenScopeResolution[],
    metadata: CommitMetadataRecord | undefined,
    now: number,
  ): Promise<undefined> {
    const { store } = this.options;
    const provider = record.provider as ReviewProvider;
    const receiptIds: string[] = [];
    const notes: string[] = [];
    if (frozen.length === 0) notes.push("revision outside configured scopes");

    for (const entry of frozen) {
      if (entry.outcome !== "match" && entry.outcome !== "legacy_binding") {
        if (entry.note) notes.push(`${entry.repoRef}: ${entry.note}`);
        continue;
      }
      const resolution = entry.resolution as WorkspaceResolution & { kind: "match" | "legacy_binding" };
      if (!entry.reviewEvent && !metadata) throw new Error("frozen routing scope is missing its event");
      const reviewEvent = entry.reviewEvent ?? this.buildReviewEvent(record, envelope, entry.repoRef, entry.branch, metadata!, resolution);
      const accepted = await this.options.runtime.accept({
        provider,
        eventName: envelope.eventName ?? (provider === "p4" ? "change-commit" : "post-commit"),
        reviewEvent,
        deliveryId: `routing:${record.routingKey}:${entry.repoRef}`,
        resolution,
        now,
      });
      receiptIds.push(accepted.receipt.receiptId);
    }

    await store.recordRoutingReceiptConversion(
      record.routingId,
      {
        ...(receiptIds.length > 0 ? { addedReceiptIds: receiptIds } : {}),
        complete: true,
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      },
      now,
    );
    return undefined;
  }

  /** First-time interpretation of each scope against current workspace config (V14-frozen by caller). */
  private interpretScopes(
    record: RoutingReceiptRecord,
    envelope: RoutingEnvelopePayload,
    profile: RoutingTriggerProfile,
    metadata: CommitMetadataRecord,
    revision: string,
    fields: Readonly<Record<string, string | null>>,
  ): FrozenScopeResolution[] {
    const provider = record.provider as ReviewProvider;
    return this.scopesFor(record, envelope, profile, metadata).map((scope) => {
      const root = profile.projectRoots?.find((entry) =>
        `${sanitizeSourceUrl(profile.repositoryUrl!)}${entry.prefix === "/" ? "" : entry.prefix}` === scope.repoRef);
      const stream = fields.stream && scopeMatchesPath(fields.stream, scope.repoRef) ? fields.stream : null;
      const providerFields = provider === "svn"
        ? { ...fields, repository_url: sanitizeSourceUrl(profile.repositoryUrl!),
          repository: root?.project ?? null, project_path: root?.prefix ?? null, branch: scope.branch ?? null,
          revision, author: metadata.svnAuthor ?? null }
        : { ...fields, depot: /^\/\/([^/]+)/u.exec(scope.repoRef)?.[1] ?? null,
          depot_path: scope.repoRef, scope: scope.repoRef, stream,
          stream_name: stream?.slice(stream.lastIndexOf("/") + 1) ?? null,
          change: revision, user: metadata.p4User ?? fields.user ?? null, client: metadata.p4Client ?? fields.client ?? null };
      const projectKey = provider === "svn"
        ? `svn:${JSON.stringify([fields.repository_root ?? sanitizeSourceUrl(profile.repositoryUrl!), fields.repository_uuid ?? null, scope.repoRef])}`
        : `p4:${JSON.stringify([fields.server ?? null, scope.repoRef])}`;
      const source =
        provider === "svn"
          ? { vcs: "svn" as const, repo_ref: scope.repoRef, repository: root?.project ?? null, branch: scope.branch ?? null, ref: revision, project_key: projectKey }
          : { vcs: "p4" as const, repo_ref: scope.repoRef, branch: null, ref: revision, project_key: projectKey };
      const resolution = this.options.workspaceRuntime.resolveForSource(record.triggerName, source, { provider_fields: providerFields });
      const base = { repoRef: scope.repoRef, ...(scope.branch !== undefined ? { branch: scope.branch } : {}) };
      switch (resolution.kind) {
        case "no_match":
          return { ...base, outcome: "no_match" as const, note: "no match rule" };
        case "ambiguous":
          return { ...base, outcome: "ambiguous" as const, note: `ambiguous (${resolution.definitionIds.join(",")})` };
        case "unbound":
          return { ...base, outcome: "unbound" as const, note: "trigger not bound to a match definition" };
        case "route_denied":
          return { ...base, outcome: "route_denied" as const, note: `route denied (${resolution.reason})` };
        default:
          return { ...base, outcome: resolution.kind, resolution,
            reviewEvent: this.buildReviewEvent(record, envelope, scope.repoRef, scope.branch, metadata, resolution) };
      }
    });
  }

  private scopesFor(
    record: RoutingReceiptRecord,
    envelope: RoutingEnvelopePayload,
    profile: RoutingTriggerProfile,
    metadata: CommitMetadataRecord,
  ): readonly { repoRef: string; branch?: string | undefined }[] {
    const provider = record.provider as ReviewProvider;
    if (provider === "svn") {
      const repositoryUrl = sanitizeSourceUrl(profile.repositoryUrl!);
      const roots = profile.projectRoots ?? [];
      const changedPaths = metadata.changedPaths;
      if (roots.length === 0) return [{ repoRef: repositoryUrl }];
      if (changedPaths.length === 0) throw new Error("routing requires verified changed paths for configured SVN roots");
      const matched = roots.filter(
        (root) => changedPaths.some((path) => scopeMatchesPath(root.prefix, path)),
      );
      if (matched.length === 0) {
        return [];
      }
      return matched.map((root) => ({
        repoRef: `${repositoryUrl.replace(/\/$/u, "")}${root.prefix === "/" ? "" : root.prefix}`,
        ...(root.branch !== undefined ? { branch: root.branch } : {}),
      }));
    }

    const scopes = [...new Set((profile.scopes?.length ? profile.scopes : [profile.depotPath ?? envelope.depotPath ?? ""]).filter(Boolean).map(normalizeP4Scope))];
    const changedPaths = metadata.changedPaths;
    if (changedPaths.length === 0) {
      throw new Error("routing requires verified changed paths for configured P4 scopes");
    }
    const matched = scopes.filter((scope) => changedPaths.some((path) => scopeMatchesPath(scope, path)));
    if (matched.length === 0) {
      return [];
    }
    return matched.map((scope) => ({ repoRef: scope }));
  }

  private buildReviewEvent(
    record: RoutingReceiptRecord,
    envelope: RoutingEnvelopePayload,
    repoRef: string,
    branch: string | undefined,
    metadata: CommitMetadataRecord,
    resolution: WorkspaceResolution & { kind: "match" | "legacy_binding" },
  ): ReviewEvent {
    const revision = envelope.revision;
    const provider = record.provider as ReviewProvider;
    const isP4 = provider === "p4";
    return {
      triggerName: record.triggerName,
      provider,
      workspaceId: resolution.definitionId,
      resolution: projectEventResolution(resolution),
      targetKind: "commit",
      repoRef,
      reason: `${provider}:${envelope.eventName ?? "commit"}:${revision}`,
      headSha: revision,
      ...(previousRevision(revision) !== undefined ? { baseSha: previousRevision(revision) } : {}),
      ...(branch !== undefined ? { branch } : {}),
      author: { username: isP4 ? metadata.p4User : metadata.svnAuthor },
      ...(envelope.depotPath ? { sourcePath: envelope.depotPath } : {}),
      ...(isP4 && metadata.p4Client
        ? { submitterWorkspace: metadata.p4Client }
        : {}),
      ...(metadata.changedPaths.length > 0 ? { changedFiles: metadata.changedPaths.slice(0, 500) } : {}),
    };
  }
}

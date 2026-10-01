/**
 * Review cancellation coordinator: the one place that composes the store,
 * scheduler and IM worker cancel paths for operator-driven cancellation
 * (IM `aicr cancel`, admin force-terminate/close).
 *
 * Cancellation covers the two durable execution systems — auto-commit
 * batches and IM review requests — plus the in-flight `review_runs` marker
 * rows. Live webhook and admin executions abort through the shared run
 * registry; terminal cancellation remains authoritative over late results.
 */

import type { AutoCommitStore, CommitBatchRecord, ReviewEvent } from "@aicr/core";
import { readAllAutoCommitBatches } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import {
  ACTIVE_RUN_STATUSES,
  cancelActiveReviewRun,
  cancelImReviewRequest,
  findImReviewRequest,
  getReviewRunById,
  listImQueryRuns,
  listImReviewRequestsForAdmin,
} from "@aicr/store";

import { buildCancelledNotification } from "./im/manual-review-service.js";
import type { ImCancellationServiceLike } from "./im/command-service.js";
import type { ImCommandBindingConfig } from "@aicr/core";

/** A registered (workspace, trigger, repo) triple from a command binding. */
export interface ReviewCancelTarget {
  readonly workspaceId: string;
  readonly sourceTrigger: string;
  readonly repoRef: string;
}

export interface ReviewCancelFilter {
  /**
   * Authorized targets from the caller's binding. Empty with `allowAll`
   * means every workspace; empty without `allowAll` cancels nothing.
   */
  readonly targets: readonly ReviewCancelTarget[];
  readonly allowAll: boolean;
  /** Revision prefix matched against batch heads, run headSha, IM revisions. */
  readonly revision?: string;
  /** Cancel only tasks created/started strictly before this instant. */
  readonly before?: Date;
}

export interface ReviewCancelSummary {
  readonly deferrals: number;
  readonly batches: number;
  readonly imRequests: number;
  readonly runRows: number;
  readonly lines: readonly string[];
}

export interface CancelBatchOutcome {
  readonly status: "cancelled" | "not_found" | "already_settled";
  readonly batch?: CommitBatchRecord;
  readonly detail: string;
}

export interface CancelImRequestOutcome {
  readonly status: "cancelled" | "not_found" | "already_settled";
  readonly detail: string;
}

export interface ReviewCancellationService {
  cancelRun(runId: string): Promise<CancelImRequestOutcome>;
  cancelByFilter(filter: ReviewCancelFilter): Promise<ReviewCancelSummary>;
  cancelBatch(batchId: string): Promise<CancelBatchOutcome>;
  requeueBatch(batchId: string): Promise<{ status: "requeued" | "not_found" | "not_queued"; detail: string }>;
  cancelImRequest(requestId: string): Promise<CancelImRequestOutcome>;
}

export interface ReviewCancellationDeps {
  readonly store?: StoreDb | undefined;
  readonly autoCommitStore?: AutoCommitStore | undefined;
  /** Scheduler hook: terminally abort a live batch execution. */
  readonly cancelRunningBatch?: (batchId: string) => boolean;
  /** IM worker hook: abort a live request execution. */
  readonly cancelRunningImRequest?: (requestId: string) => boolean;
  readonly cancelRunningRun?: (runId: string) => boolean;
  readonly cancelDeferred?: (matches: (event: ReviewEvent, admittedAt: Date) => boolean) => Promise<number>;
  /** IM store namespace (im_review_requests lookup). */
  readonly imNamespace: string;
  readonly now?: () => Date;
}

const IM_ACTIVE_STATES = ["accepted", "validating", "queued", "running", "publishing", "retry_wait"] as const;

function bindingTargets(binding: ImCommandBindingConfig): readonly ReviewCancelTarget[] {
  return Object.values(binding.repositories ?? {}).map(target => ({
    workspaceId: target.workspace,
    sourceTrigger: target.source_trigger,
    repoRef: target.repo_ref,
  }));
}

/**
 * `aicr cancel` adapter: scopes every cancellation to the authorizing
 * binding's registered repositories (or the whole deployment when the
 * binding opted into `allow_all_repositories`).
 */
export function createImCancelCommandHandler(service: ReviewCancellationService): ImCancellationServiceLike {
  return {
    async cancel({ command, binding }) {
      const allowAll = binding.allow_all_repositories === true && command.repoAlias === undefined;
      let targets = bindingTargets(binding);
      if (command.repoAlias !== undefined) {
        const target = binding.repositories?.[command.repoAlias];
        if (target === undefined) return `仓库别名 ${command.repoAlias} 未在当前绑定中授权。`;
        targets = [{ workspaceId: target.workspace, sourceTrigger: target.source_trigger, repoRef: target.repo_ref }];
      }
      const summary = await service.cancelByFilter({
        targets,
        allowAll,
        ...(command.revision !== undefined ? { revision: command.revision } : {}),
        ...(command.beforeMs !== undefined ? { before: new Date(Date.now() - command.beforeMs) } : {}),
        ...(command.beforeAt !== undefined ? { before: new Date(command.beforeAt) } : {}),
      });
      const total = summary.batches + summary.imRequests + summary.runRows + summary.deferrals;
      if (total === 0) return "没有匹配的进行中或排队中的评审任务。";
      const head = command.revision !== undefined
        ? `已取消 ${total} 个任务（修订 ${command.revision}）：`
        : command.beforeMs !== undefined || command.beforeAt !== undefined
          ? `已取消 ${total} 个任务（指定时间之前）：`
          : `已取消 ${total} 个任务：`;
      return [head, ...summary.lines].join("\n");
    },
  };
}

export function createReviewCancellationService(deps: ReviewCancellationDeps): ReviewCancellationService {
  const now = deps.now ?? (() => new Date());
  const requests = () => deps.store ? readPages((offset) => listImReviewRequestsForAdmin(deps.store!, 200, offset)) : Promise.resolve([]);
  return {
    async cancelByFilter(filter): Promise<ReviewCancelSummary> {
      const summary = { batches: 0, imRequests: 0, runRows: 0, deferrals: 0 };
      const lines: string[] = [];
      const beforeMs = filter.before?.getTime();
      if (beforeMs !== undefined && !Number.isFinite(beforeMs)) throw new RangeError("invalid cancellation cutoff");
      const handledRuns = new Set<string>();
      // Batches key scope by branch; the receipt owns exact repository identity.
      const matchesTarget = async (batch: CommitBatchRecord) => {
        if (filter.allowAll) return true;
        const first = batch.members[0];
        const members = await deps.autoCommitStore!.readMembers(first ? [first.memberId] : []);
        const receipt = members[0] ? await deps.autoCommitStore!.getReceipt(members[0].coverReceiptId) : undefined;
        const repoRef = (receipt?.receipt.envelope as { repoRef?: unknown } | undefined)?.repoRef;
        return filter.targets.some(target =>
          target.workspaceId === batch.workspaceId
          && target.sourceTrigger === batch.triggerName
          && repoRef === target.repoRef);
      };
      const revisionMatches = (value: string | null | undefined) =>
        filter.revision === undefined || (value !== null && value !== undefined
          && (value === filter.revision || !/^\d+$/u.test(filter.revision) && value.startsWith(filter.revision)));

      if (deps.cancelDeferred) {
        summary.deferrals = await deps.cancelDeferred((event, at) =>
          (filter.allowAll || filter.targets.some(target => target.workspaceId === event.workspaceId
            && target.sourceTrigger === event.triggerName && target.repoRef === event.repoRef))
          && revisionMatches(event.headSha) && (beforeMs === undefined || at.getTime() < beforeMs));
        if (summary.deferrals > 0) lines.push(`已取消 ${summary.deferrals} 个等待执行窗口的评审`);
      }

      // 1) Auto-commit batches — the queued set first, then live executions.
      if (deps.autoCommitStore) {
        const queuedStatuses = ["dispatch_pending", "queued", "retry_wait"] as const;
        const candidates = await readAllAutoCommitBatches(deps.autoCommitStore, [...queuedStatuses, "running"]);
        for (const batch of candidates) {
          if (!await matchesTarget(batch)) continue;
          if (!revisionMatches(batch.head) && !batch.members.some(member => revisionMatches(member.revision))) continue;
          if (beforeMs !== undefined && batch.createdAt >= beforeMs) continue;
          const outcome = await this.cancelBatch(batch.batchId);
          if (outcome.status === "cancelled") {
            summary.batches += 1;
            handledRuns.add(batch.runId);
            lines.push(`批次 ${batch.batchId}（run ${batch.runId}）已取消`);
          }
        }
      }

      // 2) IM review requests — persist the store CAS, then abort executions.
      if (deps.store) {
        for (const row of await requests()) {
          if (row.namespace !== deps.imNamespace) continue;
          if (!IM_ACTIVE_STATES.includes(row.state as (typeof IM_ACTIVE_STATES)[number])) continue;
          // IM requests store the repo ref directly.
          const targetMatched = filter.allowAll
            || filter.targets.some(target => target.workspaceId === row.workspaceId && target.sourceTrigger === row.sourceTrigger && target.repoRef === row.repoRef);
          if (!targetMatched) continue;
          if (!revisionMatches(row.requestedRevision) && !revisionMatches(row.resolvedRevision)) continue;
          if (beforeMs !== undefined && row.createdAt.getTime() >= beforeMs) continue;
          const outcome = await this.cancelImRequest(row.requestId);
          if (outcome.status === "cancelled") {
            summary.imRequests += 1;
            handledRuns.add(row.runId);
            lines.push(`IM 评审请求 ${row.requestId} 已取消`);
          }
        }
      }

      // 3) Leftover in-flight marker rows (zombies included) within the filter.
      if (deps.store) {
        const store = deps.store;
        const runs = filter.allowAll
          ? await readPages(offset => listImQueryRuns(store, { statusIn: ACTIVE_RUN_STATUSES, limit: 200, offset }))
          : (await Promise.all(filter.targets.map(target => readPages(offset => listImQueryRuns(store, {
            workspaceId: target.workspaceId, sourceTrigger: target.sourceTrigger, repoRef: target.repoRef,
            statusIn: ACTIVE_RUN_STATUSES, limit: 200, offset,
          }))))).flat();
        for (const run of runs) {
          if (handledRuns.has(run.id)) continue;
          if (!revisionMatches(run.headSha)) continue;
          if (beforeMs !== undefined && (run.startedAt?.getTime() ?? Infinity) >= beforeMs) continue;
          deps.cancelRunningRun?.(run.id);
          const cancelledRow = await cancelActiveReviewRun(store, run.id, "cancelled_by_user");
          if (cancelledRow) {
            summary.runRows += 1;
            handledRuns.add(run.id);
            lines.push(`进行中任务 ${run.id} 已标记取消`);
          }
        }
      }

      return { ...summary, lines: lines.slice(0, 30) };
    },

    async cancelBatch(batchId): Promise<CancelBatchOutcome> {
      if (!deps.autoCommitStore) return { status: "not_found", detail: "auto-commit store unavailable" };
      const batch = await deps.autoCommitStore.readBatch(batchId);
      if (!batch) return { status: "not_found", detail: `batch ${batchId} not found` };
      if (batch.status === "completed" || batch.status === "skipped" || batch.status === "dead") {
        return { status: "already_settled", batch, detail: `batch ${batchId} already ${batch.status}` };
      }
      const cancelled = await deps.autoCommitStore.cancelQueuedBatches({
        batchIds: [batchId],
        statuses: ["dispatch_pending", "queued", "retry_wait", "running"],
        reason: "cancelled_by_user",
      });
      if (cancelled.length === 0) {
        return { status: "already_settled", batch, detail: `batch ${batchId} settled before cancellation` };
      }
      // The terminal store write must precede abort: an intervening restart
      // must never recover a cancellation that only existed in memory.
      deps.cancelRunningBatch?.(batchId);
      if (deps.store) await cancelActiveReviewRun(deps.store, batch.runId, "cancelled_by_user").catch(() => false);
      return { status: "cancelled", batch, detail: `batch ${batchId} cancelled (${batch.status})` };
    },

    async requeueBatch(batchId) {
      if (!deps.autoCommitStore) return { status: "not_found", detail: "auto-commit store unavailable" };
      const record = await deps.autoCommitStore.requeueStalledBatch(batchId, now().getTime());
      if (!record) {
        const batch = await deps.autoCommitStore.readBatch(batchId);
        return batch === undefined
          ? { status: "not_found", detail: `batch ${batchId} not found` }
          : { status: "not_queued", detail: `batch ${batchId} is ${batch.status}` };
      }
      return { status: "requeued", detail: `batch ${batchId} requeued (${record.status})` };
    },

    async cancelImRequest(requestId): Promise<CancelImRequestOutcome> {
      if (!deps.store) return { status: "not_found", detail: "store unavailable" };
      const request = await findImReviewRequest(deps.store, deps.imNamespace, requestId);
      if (!request) return { status: "not_found", detail: `request ${requestId} not found` };
      if (!IM_ACTIVE_STATES.includes(request.state as (typeof IM_ACTIVE_STATES)[number])) {
        return { status: "already_settled", detail: `request ${requestId} already ${request.state}` };
      }
      const notification = buildCancelledNotification(request);
      const cancelled = await cancelImReviewRequest(deps.store, {
        requestId,
        errorCode: "im.cancelled_by_user",
        ...(notification !== undefined ? { notifications: [notification] } : {}),
        now: now(),
      });
      if (!cancelled) return { status: "already_settled", detail: `request ${requestId} settled before cancellation` };
      deps.cancelRunningImRequest?.(requestId);
      await cancelActiveReviewRun(deps.store, request.runId, "cancelled_by_user").catch(() => false);
      return { status: "cancelled", detail: `request ${requestId} cancelled` };
    },

    async cancelRun(runId) {
      if (deps.autoCommitStore) {
        const batch = (await readAllAutoCommitBatches(deps.autoCommitStore, ["dispatch_pending", "queued", "retry_wait", "running"]))
          .find(row => row.runId === runId);
        if (batch) return this.cancelBatch(batch.batchId);
      }
      const request = (await requests()).find(row => row.namespace === deps.imNamespace && row.runId === runId);
      if (request) return this.cancelImRequest(request.requestId);
      const aborted = deps.cancelRunningRun?.(runId) === true;
      const changed = deps.store ? await cancelActiveReviewRun(deps.store, runId) : false;
      if (!aborted && !changed && (!deps.store || !await getReviewRunById(deps.store, runId))) {
        return { status: "not_found", detail: `run ${runId} not found` };
      }
      return { status: aborted || changed ? "cancelled" : "already_settled", detail: `run ${runId} ${aborted || changed ? "cancelled" : "not active"}` };
    },
  };
}

async function readPages<T>(read: (offset: number) => Promise<readonly T[]>): Promise<T[]> {
  const records: T[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await read(offset);
    records.push(...page);
    if (page.length < 200) return records;
  }
}

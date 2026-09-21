# Webhooks, Scheduling and Recovery

Read only the relevant section when changing server reception, retries,
automatic commit batches, PR windows, or deferrals.

## Reception and credentials

Sources: `packages/server/src/webhook-common.ts`, `bootstrap.ts`, `index.ts`,
`review-deduplicator.ts`, `github-app-token.ts`, and matching tests.

- Keep the latest pending target's configSnapshotId when replaying dedup work;
  never reuse the completed run's scheduling extras. Persist it in the versioned
  deferral envelope and restore it after restart. Routing receipts must carry the
  pin through conversion; metadata adapters load the covering receipt's snapshot
  (runtime-http, routing-admission, auto-commit-scheduler, deferral-recovery tests).
  Exit the request AsyncLocalStorage scope before kicking shared scheduler timers;
  otherwise later ticks keep that old generation for policies and concurrency.
  The bootstrap timer boundary is covered in runtime-generation.test.ts.
- Dedup identity isolates trigger/workspace and stable target; repeated PR
  commands across commits must share the intended target without collapsing
  unrelated events to `unknown`. Preserve provider-specific PR detail fetchers
  and authentication when refactoring shared comment-command translation.
- All-zero before/after push SHAs are branch create/delete events, not valid
  review ranges. Preserve the unsupported-event response for those cases.
- Await async VCS/publisher resolution. GitHub credential precedence is output
  channel token → trigger token → trigger App. Resolve issue-comment installation
  tokens before shared translation; VCS/output modules receive a token string.
  Derive GitHub API bases only for REST output, preserving host URLs for links and
  other providers. App access requires installation on the reviewed repository.
- Issue triage uses a Gitea-compatible client. Gate on event provider family
  (`gitea`/`forgejo`), not trigger kind; do not route unsupported providers through
  that client. A Forgejo trigger may arrive through the Gitea route.

## Retry boundaries

Sources: `packages/core/src/io-retry.ts`, queue config, and server trigger tests.

- Trigger retry uses `queue.retry.attempts/backoff`, separate from LLM retry.
  Preserve the upstream cause in `TriggerProcessingError`; retry only transient
  IO, never deterministic context overflow. `onCompleted` runs after final success
  or exhaustion. Reuse shared retry classification instead of adding generic loops.
- Non-idempotent output/triage POSTs cannot be retried blindly after a lost
  response. Once triage side effects start, mark failures non-retryable. Shared
  IO retry excludes HTTP 429, whose Retry-After belongs to the LLM gateway.
- A failed review leaves a coverage gap; later unrelated successful reviews do
  not resolve its files. Diagnose stored runs and actual webhook delivery ranges.
  For authorized repair use the deployment skill; stale delivery replay can create
  obsolete findings and is not a general recovery strategy.

## Automatic commit batches

Sources: `packages/server/src/auto-commit-runtime.ts`, `auto-commit-scheduler.ts`,
bootstrap, core auto-commit stores, scheduler and real-backend conformance tests.

- Route push/P4 change-commit/SVN post-commit by event + targetKind to persistent
  receive before async/manual paths; headSha presence is not the classifier.
  Include GitLab `Push Hook`/`git_push` aliases; preserve the raw event name for
  audit/delivery identity. Share the all-zero before/after SHA guard across Git
  translators. Regression coverage: `packages/server/test/branch-filtering.test.ts`.
  Persistence failure returns retryable 503. Acceptance stores receipts/stream
  heads/wake signals; members materialize during expansion.
- Namespace provider delivery IDs by provider/event/trigger/workspace/repo/scope;
  coverage is only the fallback discriminator. P4/SVN single hooks cover only
  their named revision. Keep all callers aligned if handler signatures change.
- `include_branches` lives in `packages/core/src/auto-commit-policy.ts`. Resolve
  the nearest explicit array (`[]` clears inherited filtering), and gate branched
  automatic events before `autoCommit.accept`; ignored branches create no receipt.
  Branchless P4/SVN events and PR/issue/comment flows bypass this filter. Keep the
  receive-side allowlist out of `policyVersion`; sealed receipts are not re-filtered.
- `include_target_branches` lives in `packages/core/src/pull-request-policy.ts`
  with the same layered nearest-wins semantics. It gates `pull_request` events on
  `ReviewEvent.targetBranch`, which translators must map from Gitea/GitHub
  `pull_request.base.ref`, GitLab `target_branch`, and comment-command PR-detail
  `base.ref`. Unknown target branch (enrichment failure) fails open; push, issue,
  and manual flows are never filtered. Ignored events record
  `target_branch_not_watched` and produce no run.
  Validate supplied `base.ref` as a non-empty string before the gate; malformed
  refs must not masquerade as missing data. Both allowlists match exact,
  case-sensitive names. Test provider routing, mapped workspaces, comment token
  enrichment, and absence of receipt/dedup/deferral side effects for ignored events.
- Persist and consume assembly cut, metadata retry budget and calendar floor.
  Recheck time before analysis, keep every sealed member via bounded ID lookups,
  and fence completion/checkpoint writes with a live lease. Merge complementary
  observations without erasing conflicts or earlier range evidence.
- Recovery contract (2026-09 operator decision, store schema v8): executor
  errors after the `started` checkpoint propagate as ordinary retryable
  failures — replay re-runs the batch and may re-publish output the failed
  attempt already delivered; that duplicate-publication risk is accepted in
  exchange for never leaving a stream jammed. A would-be-terminal failure
  consumes the batch's single automatic recovery (`recoveryAttempt`); a second
  terminal failure skips the batch terminally and the stream keeps flowing.
  Boot reclaims leases held by the previous consumer id and re-arms pre-upgrade
  dead batches; `stop()` aborts in-flight executions (`interrupted_by_shutdown`)
  so deploys never wait out a long analysis. Replays reuse the run id, and the
  run-dir `EEXIST` guard must re-enter a leftover directory whose recorded
  owner is gone (different host after a container restart, or dead pid) — a
  live same-host owner still fails closed (`review-orchestrator.ts`
  isRunDirOwnerAlive; the stale-run reaper never clears cross-host leftovers).
  Manual re-arm is
  `POST /api/admin/auto-commit/batches/:id/retry` (dashboard Queue tab).
  Events `queued` is an immutable admission decision; the `queued_timeout_hours`
  sweep (default 48h) flips stale entries to the terminal `timeout` decision.
  Dispatch and stream exceptions must log. Persist a failing stream's retry
  bound: a global timer delay alone still lets it monopolize a bounded
  same-workspace scan (`auto-commit-scheduler.test.ts` memory and SQLite
  restart cases). Pinned snapshot repair is covered by
  [config pitfalls](AGENTS.config-and-state.md).
- Completed checkpoints replay local accounting only. Started/publication-pending
  checkpoints justify replay only under the operator-accepted duplicate risk
  above; verify actual LLM/publisher call counts after recovery and test
  memory/SQLite/Redis contracts.
- When routing receipts cross Redis Lua/cjson, an empty array round-trips as an
  empty object. Normalize only declared array fields at the read boundary;
  preserve null (unresolved) versus [] (resolved without scopes). Exercise
  duplicate intake, retry, completion and immutable replay against real Redis
  with `auto-commit-store-conformance.ts`, not only an in-memory Redis mock.
- Scheduler Git adapters need per-workspace clone roots matching the run layout,
  `alwaysFetch: true`, and a fresh `tokenProvider`. Cache keys include workspaceId;
  never clone into runtime cwd `/app`. Bootstrap tests with a real local bare
  remote must cover later heads and distinct clones for two workspaces.
- A scan that awaits analysis serializes unrelated workspaces even with higher
  configured limits. Share `ExecutionConcurrency` across batches, queue workers
  and direct trigger attempts; claim past busy workspaces before bounding the
  candidate page. Read live limits outside pinned generations. Track detached
  preparation/execution promises and drain them before closing stores; backoff
  holds no permit. Recheck windows after admission. Cover a blocked P4 run plus
  GitHub manual Retry, shared worker limits and runtime limit changes
  (`auto-commit-scheduler.test.ts`, `queue-worker.test.ts`,
  `execution-concurrency.test.ts`, `execution-window.test.ts`).

## PR windows and deferrals

Sources: bootstrap, `packages/server/src/deferral-manager.ts`, server tests, and
architecture §3.1.1.

- Every entry point checks planned time and actual attempt start, including
  retries and clock/process pauses. PR/MR schedule takes precedence over resolved
  auto-commit schedule. Keep decision logs and Events records.
- Database-mode acceptance waits for the durable pin and deferred write before
  returning 202. Dedup replay reads its execution window in the pending task's
  generation, not the completing run's async scope (runtime-http and
  deferral-recovery tests). A store failure retains the task pin for retry.
- Persist outside-window arrivals without acquiring/releasing an active run's
  dedup key. Test production deduplicator and deferral manager together.
- Claim before handoff; delete only the claimed row after successful scheduling.
  Preserve a re-deferred pending replacement, retain rows on transient reads or
  failed handoff, arm stored deadlines, and consult latest memory fallback after
  failed upserts. Reset claims on startup.
- Track async resume handlers through acknowledgment or release, and drain them
  before closing the store. A rejection must release the claim and retain a
  memory-only target for retry. Do not await a handler inside the serialized
  store queue: it may await `defer()` on that queue. Re-deferred replacements
  must survive acknowledgment (`deferral-manager.ts` and
  `deferral-recovery.test.ts`).
- History cleanup follows `storage.retention.recent_runs|events|queue` and must
  preserve accounting and deduplication facts, live work and retry state.
  Never delete old run IDs solely to cap Recent Runs: checkpoint replay would
  count them again. Use `history_pruned` plus indexed history queries; verify
  Overview/Projects/Providers and daily rollups before and after cleanup on real
  SQLite/PostgreSQL (`store/test/history-retention.test.ts`). Test terminal-only
  Queue cleanup and duplicate receipts in the three-backend conformance suite.
- Receipt-time Events are separate from run rollups. Deferrals provide
  single-process restart recovery, not distributed
  leases or a post-start durable retry queue; without the configured store,
  restart persistence is unavailable.

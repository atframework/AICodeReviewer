# Webhooks, Scheduling and Recovery

Read only the relevant section when changing server reception, retries,
automatic commit batches, PR windows, or deferrals.

## Reception and credentials

Sources: `packages/server/src/webhook-common.ts`, `bootstrap.ts`, `index.ts`,
`review-deduplicator.ts`, `github-app-token.ts`, and matching tests.

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
- Completed checkpoints replay local accounting only. Started/publication-pending
  checkpoints do not justify replaying remote POSTs. Verify actual LLM/publisher
  call counts after recovery and test memory/SQLite/Redis contracts.
- When routing receipts cross Redis Lua/cjson, an empty array round-trips as an
  empty object. Normalize only declared array fields at the read boundary;
  preserve null (unresolved) versus [] (resolved without scopes). Exercise
  duplicate intake, retry, completion and immutable replay against real Redis
  with `auto-commit-store-conformance.ts`, not only an in-memory Redis mock.
- Scheduler Git adapters need per-workspace clone roots matching the run layout,
  `alwaysFetch: true`, and a fresh `tokenProvider`. Cache keys include workspaceId;
  never clone into runtime cwd `/app`. Bootstrap tests with a real local bare
  remote must cover later heads and distinct clones for two workspaces.

## PR windows and deferrals

Sources: bootstrap, `packages/server/src/deferral-manager.ts`, server tests, and
architecture §3.1.1.

- Every entry point checks planned time and actual attempt start, including
  retries and clock/process pauses. PR/MR schedule takes precedence over resolved
  auto-commit schedule. Keep decision logs and Events records.
- Persist outside-window arrivals without acquiring/releasing an active run's
  dedup key. Test production deduplicator and deferral manager together.
- Claim before handoff; delete only the claimed row after successful scheduling.
  Preserve a re-deferred pending replacement, retain rows on transient reads or
  failed handoff, arm stored deadlines, and consult latest memory fallback after
  failed upserts. Reset claims on startup.
- Receipt-time Events retain the newest 100 decisions and are separate from run
  rollups. Deferrals provide single-process restart recovery, not distributed
  leases or a post-start durable retry queue; without the configured store,
  restart persistence is unavailable.

# Config, Models, Store and Observability

Read the section matching a config, model-selection, persistence, or usage change.

## Config and shared utilities

Sources: `packages/core/src/config.ts`, `utils.ts`, their tests, and the actual
consumers in `packages/server/src/bootstrap.ts`.

- Trace schema → workspace resolution → consumer before documenting behavior.
  Schema-only fields are not implemented features. Add config tests and sync
  architecture §3.10, examples, and both public reference locales when affected.
  Auto-commit schema/tests live in `auto-commit-policy.ts` / its matching test;
  receive-side branch policy is covered in [scheduling](AGENTS.scheduling.md).
- Renames inside `.passthrough()` objects need explicit legacy-shape errors;
  otherwise stale keys survive and new defaults silently take over. Historical
  `llm.fallback_chain` / `triage_fallback_chain` / array `model_chain` are
  converted in memory by `convertLegacyConfigDocument` (pure, conflicts fail,
  user files are never rewritten); the latest schema still rejects those keys
  when the converter does not run.
- Keep `yaml`'s default duplicate-key rejection (`uniqueKeys: true`), with
  `stringKeys: true` so numeric/string keys cannot collapse into the same JS
  property. Reject cyclic aliases and prototype keys before traversing values;
  see [YAML options](https://eemeli.org/yaml/#options), `parseRawConfigSource`
  and `config-review.test.ts`. A YAML byte limit alone does not prevent cycles.
- Validate database keys and changeset path segments before any mutation or
  Zod parse that could strip a key. File locks must compare both ancestor and
  descendant paths; arrays are atomic. Converters and merge must preserve raw
  input and malformed entries for final validation. Database model groups use
  ordered arrays; record keys match immutable IDs (`config-source.ts`,
  `config-review.test.ts`).
- A fixture filename or acceptance ID on an inventory row does not establish
  end-to-end coverage. Separate pure validation from reference checks, CAS,
  activation and recovery; retain unfinished plan artifacts. The U24 walker
  uses Zod 3 metadata for auditing, not as a runtime UI renderer.
- Legacy single-profile Gitea/Forgejo routes never enforced repository
  scoping; multi-profile selection must keep that catch-all for profiles
  without `match` resolvers, or existing deployments start returning
  `repository_not_configured`. GitHub/GitLab profiles with `repos`/`repoRef`
  constraints always scoped — preserve both semantics per route family
  (`selectWebhookConfigWithScope` legacyRepoScope).
- Workspace layout paths are specified with `/` separators; convert to host
  form with `resolve()` at the runtime boundary. Joining segments with the
  host separator breaks byte-parity with the legacy `buildSourceRootResolver`
  derivation on Windows.
- Workspace-layer `sandbox`, `agent.web_search.*` per-adapter coverage, and
  several trigger/channel kind-conditional fields are schema-only: acceptance
  is not runtime effect. `packages/core/src/config-components.ts` (U24 gate)
  is the wiring inventory; `config-capabilities.ts` holds the
  consumer-verified kind×field matrix and typed DTOs used at publish
  (`invalid_field_type` / `unsupported_capability`). Verify the bootstrap
  consumer before documenting a field as working; keep both tables in sync.
- `config-format.ts` must stay a leaf module. `config.ts` → `config-source.ts`
  → `config-capabilities.ts` forms the dependency chain; a shared enum placed
  in `config.ts` and imported by `config-capabilities.ts` causes a circular
  TDZ failure at import time. Shared primitives (e.g. `reasoningEffortSchema`)
  live in `config-format.ts` and are re-exported.
- `llm.model_chain` contains named, nonempty ordered groups. Main selection is
  instance → workspace defaults → `llm.default_model_chain`; triage is instance
  → defaults → `llm.triage_model_chain` → workspace main group. Apply it to direct
  fallback, agent candidates, compression, triage and resolution. Never mutate
  shared options for one workspace; select summary models by exact group entry,
  since a provider may host several models.
- Admin TTL uses `session_ttl_seconds`; inspect its current schema default before
  editing deployed configuration. An undeclared `session_ttl_minutes` is ineffective.
- Reuse `normalizePath`, `normalizeChangedPath`, and `isPlainObject` from core.
  Preserve slash collapse and plain-prototype checks (`Object.prototype` or null,
  excluding Date/RegExp). Token estimation must retain its CJK weighting.
- Shared public types use generic names such as `sourcePath` and
  `submitterWorkspace`. Import canonical enums rather than duplicating provider
  lists in generic modules; keep provider-specific fields inside adapters.

## Model catalog and failure routing

Sources: `packages/server/src/model-catalog-service.ts`, `bootstrap.ts`,
`packages/llm/src/model-catalog.ts`, gateway/quota tests, and
`packages/agents/src/model-metadata.ts`.

- Initialize the store for configured catalog/reflection use even without admin
  auth. Run `ensureRefreshed()` before enrichment so bundled fallback is loaded.
  Preserve backend `source` provenance; explicit model config wins over catalog
  data, and unknown metadata stays unset.
- After snapshot refreshes, verify deterministic provider/model resolution.
  Pin `catalog_provider`/`catalog_id` when provider IDs differ or fuzzy matches
  are ambiguous. The former `zhipu` catalog name changed; inspect the current
  snapshot and endpoint rather than copying a historical provider/model list.
- Quota exhaustion is a conservative machine-code/message classification, not
  every HTTP 429 or `RESOURCE_EXHAUSTED`. Durable spend/plan exhaustion selects
  the next model; ordinary rate/capacity pressure uses bounded retry. Agent CLIs
  bypass the direct gateway: `runAgentReviewWithQuotaFallback` must rematerialize
  the entire bundle for each enriched candidate, retain the final provider error,
  and record actual provider/model plus fallback count.

## Store and recovery

Sources: `packages/store/src/schema.ts`, `database.ts`, store tests, architecture
§3.11, and the auto-commit backends under `packages/core/src/`.

- Add migrations with schema changes and select new columns in read APIs such as
  `getRecentRuns`; a stored column omitted by the query renders blank downstream.
- The auto-commit store runs `SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS`) for
  every database before the version ladder, so a column added to the base
  schema makes the matching `ALTER TABLE` fail with "duplicate column" on
  older files. Guard such steps with `PRAGMA table_info` like the v3→v4
  checkpoint and v5→v6 routing-resolution migrations in
  `packages/core/src/sqlite-auto-commit-store.ts`.
- Old-schema tests must reproduce the actual prior DDL, removing all later
  columns before stamping its version. Migration DDL and the version write must
  be atomic. Verify preserved receipts and reopening, and update derived state
  consistently across memory, SQLite, and Redis backends.
- Reflection fingerprints are stable per workspace/pattern. The latest-summary
  key must not include runId/headSha; keep run identity only as provenance.
- `daily_rollups` use the UTC day of run start. Every mutation of its underlying
  run/metrics/usage/output data must recompute the affected partition through
  `recomputeDailyRollup`; real-time queries do not prove the cached rollup is fresh.
- Unique-violation dedup must name the constraint it tolerates. Catching any
  `23505` as "already exists" in `stats.pg.ts` misread a concurrent projects
  upsert race as a persisted run and silently dropped the run's accounting;
  tolerate only the target PK and put the whole multi-write unit (project
  upsert, run, metrics, usage, rollup) in one transaction so checkpoint
  retries replay atomically — the same shape as the sqlite branch.
- Check-then-act across two statements is a race even when "the sweep just
  ran". Snapshot deletion is one conditional `DELETE ... WHERE pinned=0 AND
  ref_count=0` (rowCount/changes decides; re-SELECT only to distinguish
  idempotent-miss from still-referenced), and `writeSnapshot` is
  `ON CONFLICT DO NOTHING`/`INSERT OR IGNORE` + re-read hash check. SELECT →
  act windows let a late pin land between GC's check and delete (spec §7.2).
- Redis CAS scripts derive the next sequence in-script from the value they
  just validated (`local n = tonumber(active or '0') + 1`); never trust a
  caller-side pre-read, which can be stale the moment CAS passes and would
  overwrite an immutable revision or rewind the head.
- `migrate=verify` and CLI status/check are read-only: probe ledger existence
  (`to_regclass`/`tableExists`) and compute all-pending instead of running
  `ensureLedger`; `CREATE SCHEMA` belongs to the auto branch only. A verify
  that writes DDL breaks least-privilege accounts and the "no half-upgraded
  state" boundary.
- `applyConfigChangeset` accepts only the exported op union
  (`create/update/delete/rename/set-enabled/set/unset`); there is no `upsert`.
  Unknown op names fail with `invalid_field_type` before publication; P5
  must additionally validate the complete request shape. A misspelled op
  must never become a successful empty commit (`config-source.ts`).

## Live and final usage

Sources: `packages/server/src/review-orchestrator.ts`, `live-runs.ts`,
`index.ts`, `observability-api.ts`, and corresponding tests.

- Persist actual accumulated `llmUsage`, cache counters, cost/retry/fallback
  counts through webhook summaries. `promptTokenEstimate` is a separate estimate,
  never a substitute for actual usage. Missing counters differ from zero.
- Include initial, context, repair, and direct-fallback completions. Keep the
  final content but sum billable work; label mixed agent/gateway usage correctly.
  Input includes cache tokens; output includes reasoning. Preserve fractional USD.
- Live execution identity is `executionId`, not retry-stable runId. Bootstrap
  shares one registry with the live endpoint. Completed CLI steps/messages give
  advisory previews; replace each preview with its final invocation total rather
  than adding both. Never sum cumulative deltas with completed events.
- VCS stamps come from the resolved adapter/range; timestamp lookup failure must
  not fail review, pending P4 changes have no submit time, and webhook translators
  preserve branch. Dashboard polls serialize, stop when hidden/logged out, reject
  stale responses, surface HTTP errors, and escape revision attributes.

- A descriptor unit test does not prove webhook routing. Exercise each provider
  through authenticated translation and durable intake, assert a non-first
  workspace and the pinned binding (`webhook-match-resolution.test.ts`). GitLab
  Note Hook places `merge_request` at the payload root. Route retries must enter
  `readNextWake` in every backend and reuse frozen events without a new VCS query
  (`routing-admission.test.ts`, `auto-commit-store-conformance.ts`).

- Redis live tests measure the whole shared keyspace: `SCAN MATCH <prefix>`
  still walks every key, so a dev instance with thousands of leftover test
  keys makes `scanCount: 1` pagination tests exceed their timeout while the
  same file passes standalone. Use a fresh disposable test instance or clean
  only test-owned prefixes; never use `FLUSHDB` or raise the timeout
  (`model-catalog-redis-live.test.ts`).
- Redis Lua errors do not roll back earlier writes. Validate all index key
  types and generation bounds before mutation; read large HINCRBY results
  back as decimal strings (`redis-config-store.test.ts`). OOM injection must
  use `AICR_REDIS_OOM_TEST_URL` on a separate instance: CONFIG is server-wide.
- PostgreSQL migrations for config and business tables share the schema and
  ledger, so they need the same lock before ledger creation. Check both
  namespaces in CLI/verify; preserve SQLite's name-only historical ledger
  (`migration-review.test.ts`, `migrate.test.ts`).
- PostgreSQL recording errors from Drizzle wrap the driver error in `cause`;
  dedupe only `review_runs_pkey`. Serialize rollup reads inside the transaction
  with `FOR NO KEY UPDATE`, compatible with concurrent FK `KEY SHARE` locks
  (`pg-store.test.ts` concurrent duplicate and rollup cases).
- `tsc -b` trusts dist timestamps: after changing an exported signature,
  a consumer package can compile against the stale `.d.ts` and report phantom
  arity errors. Rebuild the producer with `tsc -b packages/<producer> --force`
  before suspecting the consumer.
- ESM builds have no bare `require`: resolve optional native deps through
  `createRequire(import.meta.url).resolve("<pkg>")` and createRequire the
  resolved entry (`packages/cli/src/migrate.ts` better-sqlite3 pattern).
  `require.resolve` under top-level await throws `ERR_AMBIGUOUS_MODULE_SYNTAX`.
- better-sqlite3 opens create the file: a "read-only" probe that opens the
  path already mutates the deployment. True read-only status needs
  `new Database(path, { readonly: true })` plus a missing-file branch that
  reports all-pending without touching disk (M19 contract in
  `packages/cli/src/migrate.ts`).
- Historical-DDL fixtures must use frozen migration text: verify append-only
  against git history (`git show <pre-append>:<file>`) and slice the shipped
  array, never label current schema with old version tags (M02,
  `packages/store/test/store-migration-fixture.test.ts`).

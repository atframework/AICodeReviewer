# Config, Models, Store and Observability

Read the section matching a config, model-selection, persistence, or usage change.

## Runtime configuration generations

- Read durable pins before task references during GC, and stop on any unreadable
  backend. A snapshot refcount alone cannot close the pin-to-receipt race; use
  CAS runtime state and preserve unexpanded receipts and claimed deferrals
  (runtime-config tests H11/H12/H16; config-store conformance).
- Validate credential destinations after inheritance. A channel URL, model
  override or workspace/route search endpoint can reuse a file token without
  adding an env field. Require the effective purpose grant and never query an
  unauthorized env (config-secret-policy tests A06).
- Literal credentials (the `api_key`/`token`/… siblings of `*_env`) must cross
  every persistence boundary sealed: the revision document AND the runtime
  snapshot's `sanitizedEffectiveConfig`, including plaintext literals merged in
  from the file config. Preview/publish/restore authenticate ciphertext before
  commit; generation builds open it for execution. Random nonces must not break
  operation retries or concurrent snapshot recovery: compare opened content and
  reuse the committed ciphertext (`config-publish` / `config-api` tests). Keep `config-secret-sealing`
  walkers, the `assertNoConfigCredentialLiterals` allowlist and the admin
  redaction key sets driven from one registry (SEALED/PLAIN literal fields).
- Masked secret fields cannot round-trip through a wholesale entity update:
  `applyConfigChangeset` carries omitted registered literals over from the
  stored record and treats explicit JSON null as clear. Preserve empty parents
  for masked nested fields; encode explicit removal and kind changes as null.
  Search maps must retain masked rows and emit tombstones for removed rows
  (`config-ui-integration` / browser tests). Plain usernames follow normal edits.
- A fixed `display` on `#tab-config` overrides the dashboard's inactive-tab rule.
  Scope its grid layout to `.active`; test both top-level tabs and config pages,
  including read-only drawers and dirty drafts (`tests/browser/config-ui.spec.ts`).
- Schema `superRefine` runs after defaults are applied — mutual-exclusion
  checks between a literal and a defaulted `*_env` (e.g. admin.password_env
  defaults to AICR_ADMIN_PASSWORD) must treat the default value as unset.
- Freeze catalog observations with the task version, including after restart.
  Keep budget/token-bucket state outside generation caches; verify actual
  requests and generated adapter bundles (runtime-generation tests H01–H03/H17).
- Any change to `parseEffectiveConfig`'s canonical output changes
  `contentHashOf` of every future `loadSnapshotGeneration` read: a snapshot
  written by an older parser fails `validateSnapshot` with
  `snapshot_invalid: Config snapshot content hash mismatch` even though the
  config is unchanged. Bump `CONFIG_RESOLVER_VERSION` in the same change, and
  migrate pinned references when the normalized old document hashes to an
  existing snapshot (prove content equivalence via the app's own
  `parseEffectiveConfig` + `contentHashOf` before repointing
  `config_runtime_state.legacy_import` and `auto_commit_receipts.config_snapshot_id`).
  2026-09-18: a silent canonicalization change stranded the legacy baseline,
  crashed the deferral resume, and made every pre-upgrade receipt unloadable
  (`runtime-config.ts` validateSnapshot/loadSnapshotGeneration).

## Config and shared utilities

Sources: `packages/core/src/config.ts`, `utils.ts`, their tests, and the actual
consumers in `packages/server/src/bootstrap.ts`.

- `review.max_files` and `review.max_patch_bytes` count only the post-filter
  analyzed set: the orchestrator applies include/exclude/max_files to
  changedPaths first and requests the diff with exactly that pathspec, so an
  excluded 50MB resource never inflates the budget of a 10KB code change.
  Preserve this contract everywhere: VCS adapters must honor the requested
  pathspec (git `-- <paths>`, p4 `filterDiffToRange`/`diffBatch`, svn target
  filters), `applyReviewCommitPolicy` re-diffs per commit against
  `range.files`-intersected paths, the `incremental=false` full-file budget
  iterates the same filtered list, and a dry run whose analyzed set is empty
  must not be rejected on preview-only diff content
  (`review-orchestrator.test.ts` post-filter budget and dry-run cases).
- Trace schema → workspace resolution → consumer before documenting behavior.
  Schema-only fields are not implemented features. Add config tests and sync
  architecture §3.10, examples, and both public reference locales when affected.
  `agent.default: native-llm` must remain selectable at global, workspace and
  route layers; bootstrap leaves both adapter and sandbox factory unset so the
  orchestrator uses direct gateway completion. The Config UI enum comes from the
  schema (`config-ui-spec.test.ts`; `runtime-generation.test.ts`).
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
- UI parity must exercise the generated registry and the real renderer through
  API persistence. Synthetic field fixtures can reach 100% while `[]`/`*`
  descendants disappear or UI IDs become config keys. Check row-relative paths,
  consecutive nested edits, unknown descendants and explicit empty values
  (`config-ui-integration.test.ts`, `tests/browser/config-ui.spec.ts`).
  Kind applicability is independent of write permission: file-owned views must
  hide irrelevant fields too. Reset conflicts must retry the selected `unset`
  operations, not encode the unchanged editor draft (`config-ui-runtime.test.ts`,
  `tests/browser/config-ui.spec.ts`).
- Freeze each editor's revision/digest and the complete submitted payload.
  Refreshing another page must not advance a dirty draft's CAS base. After a lost
  response, query the operation and reuse the exact payload for an explicit retry;
  404 can still mean an in-flight write. Apply this to restore too, and keep 202
  edits locked until activation is resolved (`config-ui-client.test.ts`, browser gate).
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
- `agent.web_search.*` per-adapter coverage and
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

- Dynamic config admission must run before profile lookup/authentication. Keep
  one request generation across awaits; a later publish must not switch credentials,
  workspace or receipt pin halfway through. Exercise signed HTTP requests without
  a manual refresh first (`runtime-http.test.ts`). Verify snapshot namespace/file
  identity before recovery writes, serialize head adoption, and evict disposed
  generations. Adopting a snapshot already leased by a worker must reuse its
  generation and resources; track live ownership independently of cache keys
  (`runtime-config.test.ts`). Historical null pins resolve to the durable
  `legacy_import` baseline, never the latest head.
- Publish prepare must share the exact validation a generation build runs: the
  file-load path called `validateWorkspaceDefinitions` while the publish path
  only compiled the routing graph, letting invalid DB workspace records commit
  and fail post-commit at install (`committed_activating`, replica 503s). Any
  validation added to one side belongs to both (`config-publish.ts`,
  `config-publish.test.ts`). Validate mixed template literals before publication:
  `/{{workspace.id}}` is always invalid even though its variable is valid
  (`config-path-template.test.ts`). Related: a v2 route selecting a workspace with no
  binding rule must fail admission with `no_route` instead of silently falling
  back to the first workspace, and disabled legacy bindings are skipped like
  disabled match rules but still own their trigger (`config-resolution.ts`).
- Path-shaped comparisons must use one encoding: restore compared
  `path.join(".")` against `formatConfigPath`-encoded file locks, so quoted
  map keys (`openai/gpt-4.1`) bypassed the C12 check. Compare parsed token
  arrays, not formatted strings (`config-publish.ts`). An empty globals object
  contributes no paths; do not compare an empty root path against every file lock.
- Repeated UI staging must retain the original baseline and cumulative session.
  Entity updates replace the full value, so merging operations by record ID loses
  earlier fields. Re-encode from the retained session, remove reverted fields and
  clear sessions when discarding (`tests/browser/config-ui.spec.ts`). Refresh only
  staged option overlays; clearing server options breaks the next editor on the
  same page (`tests/browser/ui-run-isolation.spec.ts`, consecutive channels).
- Config API limits must count streamed UTF-8 bytes, reject prototype keys before
  Zod parsing and require operation values. Validate client fileDigest against the
  local file; redact URLs/headers/short credentials and suppress driver error text.
  Test disabled entities and immutable IDs in GET views (`config-api.test.ts`).
- High-entropy redaction also matches SHA-256 workspace identities. Preserve
  only the validated, computed preview layout and instance ID; keep source
  values redacted. Assert complete paths through HTTP and UI-to-review tests
  (`config-api.test.ts`, `tests/browser/ui-run-isolation.spec.ts`).
- A crash-window test needs an observed barrier after durable commit and before
  installation. A sleep or a branch accepting an already-completed response
  cannot prove that window. Keep the barrier in the child fixture, kill the
  actual process, then assert durable operation/head and idempotent recovery
  (`replica-process-matrix.test.ts`).
- A version matrix must run pinned historical implementation code in a separate
  process, with source/artifact hashes and stable line endings. Same-version
  children do not test compatibility. Cover supported reads/writes, unknown
  format rejection, an active legacy transaction, drain and old-program restart
  (`migration-version-process.test.ts`). Migration locks cannot detect idle old
  binaries; keep the first-upgrade stop/drain prerequisite explicit.
- Drain must include pending lease loads, claims, accepted timers/retries, publication and
  final persistence. Counting only active generation leases misses work between
  awaits; never report a worker's 30-second wait expiry as success. Stop new
  admission before waiting, close stores last, and close both BullMQ clients
  (`runtime-config`, `queue-worker`, `server-shutdown` and E2E drain tests).

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
- Dashboard provider presets (`packages/llm/src/provider-presets.ts`) use official
  platform docs for endpoints, account restrictions and model retirement; the
  bundled catalog validates metadata resolution only. Anthropic roots omit `/v1`;
  OpenCode/Kilo translate them for AI SDK. Test both protocols through direct
  requests and real bundle materialization (`provider-presets.test.ts` in llm
  and agents). Catalog npm metadata must not override the selected protocol.
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
- SQLite initialization PRAGMAs can fail before migration starts. Keep them
  inside connection cleanup protection; injected failures must close the real
  handle (`sqlite-auto-commit-store.test.ts`). Reproduce WAL locking failures
  on a native local filesystem before changing concurrency logic; a WSL v9fs
  Windows-drive mount is not equivalent to Linux local storage.
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
  The advisory lock is database-wide: unique test schemas do not isolate the
  deliberate lock holder in `migration-version-process.test.ts` from other
  migration tests. With a shared `AICR_PG_TEST_URL`, run the complete suite with
  `--maxWorkers=1` or provide separate databases; retain timeouts and the
  concurrency exercised inside each test.
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

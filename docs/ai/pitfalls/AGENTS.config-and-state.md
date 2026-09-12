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

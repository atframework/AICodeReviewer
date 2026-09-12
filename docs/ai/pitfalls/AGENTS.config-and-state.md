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
  otherwise stale keys survive and new defaults silently take over. Preserve
  rejection of old fallback-chain names and legacy model-chain arrays.
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

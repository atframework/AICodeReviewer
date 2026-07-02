---
name: agent-runtime-integration
description: "Use when: implementing or auditing agent CLI runtime materialization, LLM config translation, MCP tool mapping, prompt/instruction layering, and skills merging; do not use for ordinary review logic or output rendering changes."
user-invocable: false
---

# Agent Runtime Integration

Use this skill when work touches how AICR prepares an external AI agent CLI before a review run.

## Scope

This workflow covers the per-run runtime bundle assembled for Kilo, Zoo, OpenCode, Copilot CLI, Claude Code, or another adapter:

- LLM provider/model config translated from `ModelSpec`.
- AICR MCP tool registration and per-agent MCP config files.
- Three-layer prompts/instructions: AICR built-in protected rules, user/operator common rules, and project/workspace/repo-local rules.
- Three-layer skills: AICR protected skills, user/operator common skills, and project/workspace/repo-local skills.
- Sandbox mounts, environment variables, and audit manifests.

Do not use this skill for VCS implementation details, output channel rendering, or package scaffold changes unless they are needed to validate the runtime bundle.

## Procedure

1. **Read current contracts first**
   - `../../../docs/ai/architecture.md` §3.6, §3.7, §3.9, and §3.13 (model metadata catalog).
   - `../../../Plan.md` §8.1 when roadmap status or remaining milestone scope matters.
   - `../../../packages/agents/src/types.ts` and the target adapter implementation.
   - `../../../packages/mcp-output/src/index.ts` for the authoritative AICR tool registry.
   - `../../../packages/core/src/prompt-manager.ts` for instruction and skill discovery rules.
   - `../../../packages/core/src/config.ts` (`llm.model_catalog`), `../../../packages/llm/src/model-catalog.ts` (parser/normalizer), `../../../packages/server/src/model-catalog-service.ts` (refresh/fallback/enrichment), and `../../../packages/agents/src/model-metadata.ts` (per-adapter injection) when model parameters/pricing are in scope.

2. **Build one runtime bundle, not parallel configs**
   - Treat model config, MCP tools, instructions, skills, mounts, env vars, and manifest as one atomic materialization step.
   - Write only under the run/workspace `agent/` directory or an isolated HOME/XDG directory.
   - Never mutate a developer's global Kilo, Zoo, OpenCode, Claude Code, or Copilot CLI config.

3. **Map MCP tools from the registry**
   - Generate adapter-native MCP config from `createAicrOutputToolRegistry()` and any implemented context tools.
   - Stable current tools are `aicr.report_problem`, `aicr.publish_summary`, `aicr.skip`, `aicr.fetch_more_context`, and `aicr.try_blame`.
   - `aicr.fetch_more_context` may fetch full changed files when the diff is missing/truncated and narrowly related repository files when needed to validate a changed line; keep requests bounded by path/range/reason.
   - `aicr.try_blame` may request VCS-verified, best-effort attribution when ownership or revision provenance materially affects review reasoning; keep requests bounded by path/range/reason and never ask the model to infer authorship.
   - Do not advertise planned tools such as `aicr.recall_memory` or `aicr.recall_skill` until schema, server, client tests, and prompt guidance exist.
   - Keep JSON/XML stdout tool-call parsing only as a compatibility fallback when MCP is unavailable.

4. **Merge instructions and skills deterministically**
   - Preserve AICR protected output/security instructions above workspace and repo-local instructions.
   - Merge layers in this visible order: system built-in → user/operator common → project/workspace/repo-local.
   - Resolve conflicts with this precedence: protected hard rules always win; then the most specific project/path rule; then user/operator common; then compatibility aliases.
   - Load repo-local AGENTS/path instructions and skills only when they match the current review paths or approved extra context.
   - Resolve same-name skill conflicts by priority; record dropped or renamed skills in the manifest.
   - Materialize canonical Agent Skills into adapter-native locations when supported, while keeping `.agents/skills/<name>/SKILL.md` as the source of truth.
   - If an adapter lacks native skill support, inject active skill summaries into the prompt and expose full skill files as read-only resources or files.

5. **Translate adapter capabilities explicitly**
   - For each adapter, document and test whether it supports model config, MCP config, native skills, repo instruction files, isolated HOME, and stdout fallback.
   - If a capability is unsupported, degrade visibly in the manifest and tests instead of silently dropping it.
   - Apply resolved model metadata from the model catalog (§3.13) per tool. The shared builders live in `packages/agents/src/model-metadata.ts`; each adapter's `materializeConfig` calls the right one, and `materializeRuntimeBundle` records `manifest.model.metadataInjection` (`injected` / `delegated` / `not_applicable`) plus `catalogSource`:
     - **opencode** resolves known providers from models.dev natively, so only inject `models.<id>.limit`/`cost` for custom `@ai-sdk/openai-compatible` / `ollama` providers (via `buildOpencodeModelEntry`). Known providers (`anthropic`, `google_ai_studio`, …) get no `models` block.
     - **Kilo Code** and **Zoo Code** do not have a verified native models.dev ingestion surface for custom OpenAI-compatible providers, so inject `contextWindow` / `maxTokens` / `supportsImages` / `supportsComputerUse` / `supportsPromptCache` / `inputPrice` / `outputPrice` (Kilo also `cacheReadsPrice` / `cacheWritesPrice`) via `buildKiloModelInfo` / `buildZooCustomModelInfo`.
     - **Claude Code** derives `ANTHROPIC_MAX_TOKENS` from `model.maxOutputTokens` (explicit `extraParams.max_tokens` wins); the rest is delegated to its built-in Anthropic catalog.
     - **Copilot CLI** has no injection surface → `not_applicable`.
   - Price values injected into Kilo/Zoo/opencode are USD per 1M tokens (the models.dev native unit); keep them consistent across tools.

6. **Validate the runtime bundle**
   - Add adapter tests that assert generated file paths, file contents, env vars, and manifest entries.
   - Add MCP client/schema tests when adding or changing tools.
   - Add prompt/skill snapshot tests when changing instruction layering.
   - Run markdownlint for changed AI-facing assets.

## Pitfalls

- Do not duplicate skill bodies into tool-private config trees as committed source; generate shims or materialized copies per run.
- Do not let prompt text be the source of truth for tool names; the MCP registry is authoritative.
- Do not expose arbitrary external MCP servers directly to the agent; route them through AICR allowlists and context tools.
- Do not include secrets in generated config files; use env placeholders and sandbox env injection.
- Do not accept summaries that claim actionable problems without `aicr.report_problem` records, or skip/summary prose that asks humans for diff/source context; trigger structured repair so locations and context requests remain machine-readable.
- Do not treat MCP state `contextRequests` or `attributionRequests` as passive metadata. Replay them through the VCS-backed `aicr.fetch_more_context` / `aicr.try_blame` handlers, feed returned context into a follow-up pass, and clear stale `.aicr-output-state.json` before each agent run.
- If an agent repair retry still cannot produce structured output, fall back to direct LLM repair; but when the prose explicitly says there are no actionable problems or no reviewable code, normalize to `aicr.skip` rather than publishing a generic fallback summary.
- Do not double-inject model metadata when the target tool already resolves it from models.dev (opencode known providers), and do not fabricate values the catalog is missing: user-supplied `llm.providers[]` fields always win over catalog data, and missing fields stay unset rather than guessed.
- **Context auto-compaction must be injected per adapter.** `agent.context_compaction` (default enabled) flows through `RuntimeBundleInput.compaction` → `materializeConfig(model, workingDir, options)` → each adapter's native format: Kilo `compaction.{auto,threshold_percent,prune}`, opencode `compaction.{auto,prune}`, Zoo `autoCondenseContext`/`condenseContextPercentThreshold` in Zoo Code's current `.roo/settings.json` compatibility path. Claude Code delegates (auto-compacts by default); Copilot CLI is not applicable. The manifest records `contextCompaction.{enabled,mode}`. Kilo only tracks models that declare `contextWindow` — always enable `llm.model_catalog` or set `context_window` so compaction activates. When an agent overflows anyway, `runAgentReview` throws `AgentContextOverflowError` with actionable guidance; never let a raw `review_orchestration_failed` surface for a context overflow.

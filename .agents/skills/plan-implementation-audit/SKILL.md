---
name: plan-implementation-audit
description: "Use when: comparing the current roadmap/docs with implementation, identifying gaps, fixing issues, or adding missing tests; do not use for unrelated feature work."
user-invocable: false
---

# Plan Implementation Audit

## When to Use

- When asked to compare the roadmap/docs with current implementation.
- When asked to find and fix issues in the current milestone.
- When asked to add missing unit tests or improve coverage.

## Do Not Use

- For feature work that does not involve roadmap/document comparison.

## Procedure

### Step 1: Understand current milestone status

Read `Plan.md` §8.1 (里程碑状态表) first to understand which milestones are complete, in-progress, or not started. Then read `../../../docs/ai/index.md` to locate the detailed architecture, decision, and completed-milestone docs you actually need. Focus audit on in-progress milestones.

### Step 2: Check known pitfalls before making changes

Read the "Known codebase pitfalls" section in `AGENTS.md`. These are issues found and fixed in prior sessions — do not reintroduce them. Key checks:

- Config schema fields from Plan.md §3.10 / `../../../docs/ai/architecture.md` §3.10 (compression, LLM, queue, review, workspaces)
- Store schema columns from Plan.md §3.11 / `../../../docs/ai/architecture.md` §3.11 (triggerName, provider, providerModel)
- `isPlainObject` rejecting Date/RegExp
- `normalizePath` compressing consecutive slashes
- `estimateTokens` handling CJK characters
- Prompt manager conflict detection
- MCP tool contracts in `../../../docs/ai/architecture.md` §3.9 and `../../../docs/output-channels.md`, including `aicr.report_problem`, `aicr.publish_summary`, `aicr.fetch_more_context`, `aicr.try_blame`, and only-advertise-when-implemented planned tools such as memory/skill recall
- Output channel policy in `../../../docs/ai/architecture.md` §3.9/§3.10 and `../../../docs/output-channels.md`, including per-channel `no_problems` resolution and non-PR/MR target link rendering
- Agent Runtime Bundle responsibilities from `../../../docs/ai/architecture.md` §3.6.3 / §3.7: LLM config, MCP config, instructions, skills, env vars, and manifest must be audited together
- Review orchestrator status logic when `dryRun=false`
- No unused imports
- DRY utility functions from `packages/core/src/utils.ts`

### Step 3: Run baseline verification

Use the environment-appropriate commands (see AGENTS.md "Environment notes"):

1. Lint
2. Typecheck
3. Tests
4. Markdownlint (if docs changed)

### Step 4: Identify gaps

For each in-progress milestone, check:

1. **Schema completeness**: Do Zod schemas in `config.ts` match Plan.md §3.10 / `docs/ai/architecture.md` §3.10? Does `store/schema.ts` match §3.11?
2. **Test coverage**: Are there test files for every source file? Are error paths, edge cases, and alternative formats covered?
3. **Code correctness**: Do implementations match the contracts described in the roadmap summaries and detailed docs?
4. **Agent runtime consistency**: If agent adapters changed, do tests cover model translation, MCP config materialization, three-layer skill/instruction merging (system built-in → user common → project/repo-local), isolated HOME/env handling, and stdout fallback behavior?
5. **Context tool boundaries**: If VCS context tools changed, do they preserve scoped fetch, path allowlists, multi-repo selector validation, and no full recursive submodule fetch by default?
6. **Output policy correctness**: If output routing or templates changed, do tests cover global → channel → workspace `no_problems` overrides, mixed-channel suppression/publishing, and commit/revision target links without misleading `View PR` labels?
7. **Document sync**: Did the change touch config shape, agent adapters, MCP/output contracts, output rendering, deployment behavior, or review orchestration semantics without updating `Plan.md`, `docs/ai/architecture.md`, `example/config.yaml`, or `example/README.md`? See Step 5 for the mandatory sync checklist.

### Step 5: Document sync check (mandatory)

Before declaring a change complete, verify documentation alignment:

- **Start from the actual changed files** → Inspect `git diff --name-only`, `git show --name-only`, or the task's explicit file list. Map each changed source/config/test file to its public contract surfaces before deciding docs are unnecessary.

1. **Config shape changes** → Update `Plan.md` §3.10 summary, `docs/ai/architecture.md` §3.10, `packages/core/test/config.test.ts`, and `example/config.yaml`.
2. **Store schema changes** → Update `Plan.md` §3.11 summary, `docs/ai/architecture.md` §3.11, and `packages/store/test/schema.test.ts`.
3. **Agent adapter / MCP tool contract changes** → Update `docs/ai/architecture.md` §3.6–3.7, `docs/output-channels.md`, and relevant skill files.
4. **Output rendering or channel behavior changes** → Update `docs/ai/architecture.md` §3.9, `docs/output-channels.md`, `example/config.yaml`, and `example/README.md`.
5. **Review orchestration semantics changes** (deduplication, update strategy, comment commands) → Update `docs/ai/architecture.md` §3.1/§3.9, `Plan.md` §3.1/§3.9, and example docs.
6. **Deployment or public workflow changes** → Update `example/README.md`, `docs/podman.md`, and `Plan.md` §11.

For each matched category, verify both user-facing docs and example config snippets. If a change genuinely requires no doc update, explicitly state the reason in the change summary. Do not skip this check silently.

### Step 6: Fix and test

- Fix code issues first, then add tests.
- When a fix changes config, agent behavior, MCP/output contracts, deployment, or public workflows, update the matching docs and examples (`Plan.md` roadmap summary, `docs/`, `example/config.yaml`, `example/README.md`) in the same change.
- Always run the full verification chain after changes.
- Update `AGENTS.md` "Known codebase pitfalls" if a new recurring issue is found.

### Step 7: Summarize

Provide a table of: issue found, file location, fix applied, test added, and docs/examples updated or why no docs/examples were needed.

## Common test gaps to check

| Package            | Common gaps                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@aicr/llm`        | Error paths (missing choices/message), default base URLs, organization header, extra params                                                                 |
| `@aicr/outputs`    | `renderProblemMarkdown` variants (no suggestion, no fingerprint, with endLine), target link templates for PR and non-PR events, no-auth dispatch            |
| `@aicr/mcp-output` | `fetchMoreContext` without handler, individual validation edge cases, tool schema/name drift                                                                |
| `@aicr/server`     | Alternative LLM output format (problems/summary/skipReason), removed finding aliases rejection, invalid JSON, status logic, per-channel no-problems routing |
| `@aicr/vcs`        | Multi-file diffs, copied files, context-only hunks, empty diffs                                                                                             |
| `@aicr/agents`     | Runtime bundle materialization, model config, MCP tools, native skills, isolated env, manifest; must have tests even for simple exports                     |
| `@aicr/sandbox`    | Must have at least `test/index.test.ts` even if only exporting a constant                                                                                   |

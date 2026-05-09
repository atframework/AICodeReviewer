---
name: plan-implementation-audit
description: "Use when: comparing Plan.md milestones with current code, identifying implementation gaps, fixing issues, or adding missing tests; do not use for unrelated feature work."
user-invocable: false
---

# Plan Implementation Audit

## When to Use

- When asked to compare Plan.md with current implementation.
- When asked to find and fix issues in the current milestone.
- When asked to add missing unit tests or improve coverage.

## Do Not Use

- For feature work that does not involve Plan.md comparison.

## Procedure

### Step 1: Understand current milestone status

Read `Plan.md` §8.1 (里程碑状态表) first to understand which milestones are complete, in-progress, or not started. Focus audit on in-progress milestones.

### Step 2: Check known pitfalls before making changes

Read the "Known codebase pitfalls" section in `AGENTS.md`. These are issues found and fixed in prior sessions — do not reintroduce them. Key checks:

- Config schema fields from Plan.md §3.10 (compression, LLM, queue, review, workspaces)
- Store schema columns from Plan.md §3.11 (triggerName, provider, providerModel)
- `isPlainObject` rejecting Date/RegExp
- `normalizePath` compressing consecutive slashes
- `estimateTokens` handling CJK characters
- Prompt manager conflict detection
- MCP tool contracts in Plan.md §3.9, including `aicr.report_problem`, `aicr.publish_summary`, `aicr.fetch_more_context`, and only-advertise-when-implemented planned tools such as `aicr.try_blame`
- Output channel policy in Plan.md §3.9/§3.10, including per-channel `no_problems` resolution and non-PR/MR target link rendering
- Agent Runtime Bundle responsibilities from Plan.md §3.6.3 / §3.7: LLM config, MCP config, instructions, skills, env vars, and manifest must be audited together
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

1. **Schema completeness**: Do Zod schemas in `config.ts` match Plan.md §3.10? Does `store/schema.ts` match §3.11?
2. **Test coverage**: Are there test files for every source file? Are error paths, edge cases, and alternative formats covered?
3. **Code correctness**: Do implementations match the contracts described in Plan.md?
4. **Agent runtime consistency**: If agent adapters changed, do tests cover model translation, MCP config materialization, three-layer skill/instruction merging (system built-in → user common → project/repo-local), isolated HOME/env handling, and stdout fallback behavior?
5. **Context tool boundaries**: If VCS context tools changed, do they preserve scoped fetch, path allowlists, multi-repo selector validation, and no full recursive submodule fetch by default?
6. **Output policy correctness**: If output routing or templates changed, do tests cover global → channel → workspace `no_problems` overrides, mixed-channel suppression/publishing, and commit/revision target links without misleading `View PR` labels?

### Step 5: Fix and test

- Fix code issues first, then add tests.
- When a fix changes config, agent behavior, MCP/output contracts, deployment, or public workflows, update the matching docs and examples (`Plan.md`, `docs/`, `example/config.yaml`, `example/README.md`) in the same change.
- Always run the full verification chain after changes.
- Update `AGENTS.md` "Known codebase pitfalls" if a new recurring issue is found.

### Step 6: Summarize

Provide a table of: issue found, file location, fix applied, and test added.

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

---
name: plan-implementation-audit
description: "Use when: comparing Plan.md milestones with current code, finding implementation gaps, fixing issues, or adding missing tests; do not use for unrelated feature work."
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

### Step 5: Fix and test

- Fix code issues first, then add tests.
- Always run the full verification chain after changes.
- Update `AGENTS.md` "Known codebase pitfalls" if a new recurring issue is found.

### Step 6: Summarize

Provide a table of: issue found, file location, fix applied, and test added.

## Common test gaps to check

| Package            | Common gaps                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `@aicr/llm`        | Error paths (missing choices/message), default base URLs, organization header, extra params      |
| `@aicr/outputs`    | `renderFindingMarkdown` variants (no suggestion, no fingerprint, with endLine), no-auth dispatch |
| `@aicr/mcp-output` | `fetchMoreContext` without handler, individual validation edge cases                             |
| `@aicr/server`     | Alternative LLM output format (findings/summary/skipReason), invalid JSON, status logic          |
| `@aicr/vcs`        | Multi-file diffs, copied files, context-only hunks, empty diffs                                  |
| `@aicr/sandbox`    | Must have at least `test/index.test.ts` even if only exporting a constant                        |
| `@aicr/agents`     | Must have at least `test/index.test.ts` even if only exporting a constant                        |

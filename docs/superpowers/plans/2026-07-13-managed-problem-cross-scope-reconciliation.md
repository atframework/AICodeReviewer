# Managed Problem Cross-Scope Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make consolidated managed problem issues parse ranged locations and reconcile old push scopes per fingerprint, then deploy the verified fix and repair production issues #42 and #46.

**Architecture:** Keep platform-neutral parsing and categorization helpers in `packages/outputs/src/index.ts`, then invoke them from the existing GitHub and Gitea dispatchers. Cross-scope updates preserve the old scope and historical summary, retain out-of-scope findings, resolve reviewed-and-missing findings, and close only when no open fingerprint remains.

**Tech Stack:** TypeScript, Vitest, GitHub/Gitea REST dispatchers, Markdown, pnpm workspace, Podman.

## Global Constraints

- Cross-scope cleanup applies only to `issue_mode: consolidated`; `per_commit` stays independent.
- Missing or malformed stored file metadata remains fail-safe and unresolved.
- GitHub and Gitea behavior and tests remain symmetric.
- Do not change config schema, routing, authentication, templates, or fingerprint computation.
- Root `AGENTS.md`, `Plan.md`, and `example/` remain unchanged.
- Temporary artifacts go under `build/`; never print production secrets.

---

### Task 1: Add production-shaped failing tests

**Files:**

- Modify: `packages/outputs/test/github-problem-issue.test.ts`
- Modify: `packages/outputs/test/gitea-problem-issue.test.ts`

**Interfaces:**

- Consumes: both problem-issue dispatcher factories, `computeScopeFingerprint`, and existing fetch stubs.
- Produces: regressions for ranges, partial old-scope updates, empty reviews, and per-commit isolation.

- [ ] **Step 1: Make the old-body fixtures accept multiple entries and optional end lines**

Use this entry type and location expression in both test files:

```ts
interface StoredProblemFixture {
  readonly fp: string;
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  readonly category: string;
  readonly severity: string;
}

const location = entry.endLine
  ? entry.file + ":" + entry.line + "-" + entry.endLine
  : entry.file + ":" + entry.line;
```

The generated body must contain managed, consolidated, channel, label, scope, commit, and open-problem markers; a historical summary; the builder-owned thematic break; and one fingerprint heading per entry.

- [ ] **Step 2: Add the issue #46 regression**

Build an old cross-scope issue with three findings at `src/mq_channel_manager.cpp:309-313`, `:712-715`, and `:522-528`. Reconcile an unrelated current finding with reviewed files containing `src/mq_channel_manager.cpp`. Return `status: "ahead"` from compare. Assert the old issue receives the platform's resolved action.

- [ ] **Step 3: Add the issue #42 partial-update regression**

Build an old issue containing two `src/OrbitRPCHandle.h` fingerprints and one `src/component-functions.cmake:327` fingerprint. Reconcile a current-scope finding from another file while only the CMake file and current file are reviewed. Assert:

```ts
expect(oldPatch.state).toBeUndefined();
expect(oldPatch.body).toContain(
  "<!-- aicr:open_problems=fp-orbit-stringify,fp-orbit-concat -->",
);
expect(oldPatch.body).toContain("✅ Resolved (1)");
expect(oldPatch.body).toContain("src/component-functions.cmake:327");
expect(oldPatch.body).toContain("## Historical summary");
expect(oldPatch.body).not.toContain("aicr:open_problems=fp-current");
```

Also assert the new current-scope issue is created separately.

- [ ] **Step 4: Add empty-review and per-commit boundaries**

An empty review over only one stored file must produce the same partial PATCH. With `issueMode: "per_commit"`, an old different-scope issue must receive no cross-scope update or resolution.

- [ ] **Step 5: Prove the tests fail before implementation**

Run:

```powershell
node node_modules/vitest/vitest.mjs run packages/outputs/test/github-problem-issue.test.ts packages/outputs/test/gitea-problem-issue.test.ts
```

Expected: range-based closure and partial-update assertions fail against the current close-or-skip implementation.

---

### Task 2: Implement ranged metadata and shared partial reconciliation

**Files:**

- Modify: `packages/outputs/src/index.ts:2937-2967`
- Modify: `packages/outputs/src/index.ts:3093-3193`
- Modify: `packages/outputs/src/index.ts:2125-2259`
- Modify: `packages/outputs/src/index.ts:3955-4095`

**Interfaces:**

- Consumes: `categorizeProblems`, `buildRetainedProblems`, commit comparison, and platform update/resolve functions.
- Produces: `prepareStoredConsolidatedReconciliation(body, currentProblems, reviewedFiles)` and optional `endLine` metadata.

- [ ] **Step 1: Parse optional end lines**

Change `ParsedProblemInfo` to include `readonly endLine?: number`. Replace the heading regex with:

```ts
const problemHeadingPattern =
  /^\*\*([^*]+?)\*\*\s+[\u2014-]\s+`([^`]+):(\d+)(?:-(\d+))?`\s*(?:<!--\s*aicr:fp=([^\s>]+)\s*-->)?/u;
```

Fingerprint is capture 5. Copy capture 4 into `endLine` when present, copy it through `buildRetainedProblem`, and render ranges in retained/resolved locations.

- [ ] **Step 2: Preserve the historical summary**

Add `extractConsolidatedIssueSummary(body)`. Find the first line containing `<!-- aicr:fp=`, walk backward to its `#### SEVERITY (N)` group, then to the nearest preceding line equal to `---`. Return the text after the initial AICR marker block and before that separator. Return `undefined` if any boundary is missing.

- [ ] **Step 3: Add the pure stored-issue categorizer**

Implement this contract:

```ts
interface PreparedStoredConsolidatedReconciliation {
  readonly relevantCurrentProblems: readonly ReviewProblem[];
  readonly categorization: ConsolidatedIssueCategorization;
  readonly openProblems: readonly ReviewProblem[];
}

function prepareStoredConsolidatedReconciliation(
  body: string,
  currentProblems: readonly ReviewProblem[],
  reviewedFiles: readonly string[] | undefined,
): PreparedStoredConsolidatedReconciliation | undefined;
```

It must parse open fingerprints, filter current findings to those already in the old issue, call `categorizeProblems` with stored file metadata and reviewed files, rebuild retained findings, return `undefined` if any retained fingerprint lacks metadata, and never classify current-scope-only findings as new findings in the old issue.

- [ ] **Step 4: Let platform update functions preserve old scope context**

Add:

```ts
interface ConsolidatedIssueUpdateContext {
  readonly scopeFingerprint: string;
  readonly headSha?: string;
}
```

Add this optional context to both platform `updateConsolidatedIssue` functions. Same-scope calls default to current scope/head. Old-scope calls pass the stored scope, current head, extracted historical summary, and prepared categorization.

- [ ] **Step 5: Replace close-only cross-scope loops**

For GitHub and Gitea, run cross-scope iteration only in consolidated mode. Require commit comparison to return `true`; skip both `false` and `undefined` so a failed comparison cannot resolve an old issue. After that validation:

```ts
const prepared = prepareStoredConsolidatedReconciliation(
  issue.body,
  preparedProblems,
  reviewedFiles,
);
if (!prepared || prepared.categorization.resolvedFingerprints.size === 0)
  continue;
if (prepared.openProblems.length === 0) {
  const result = await resolveIssue(issue);
  if (result) results.push(result);
  continue;
}
results.push(
  await updateConsolidatedIssue(
    issue,
    prepared.relevantCurrentProblems,
    extractConsolidatedIssueSummary(issue.body),
    prepared.categorization,
    {
      scopeFingerprint: issue.scopeFingerprint,
      ...(options.headSha ? { headSha: options.headSha } : {}),
    },
  ),
);
```

Use the same partial path for empty reviews. Keep same-scope duplicate cleanup and webhook replay checks.

- [ ] **Step 6: Run focused tests**

Run the Task 1 command. Expected: both test files pass.

- [ ] **Step 7: Commit implementation and tests**

```powershell
git add packages/outputs/src/index.ts packages/outputs/test/github-problem-issue.test.ts packages/outputs/test/gitea-problem-issue.test.ts
git commit -m "fix: reconcile managed issues per fingerprint"
```

---

### Task 3: Synchronize lifecycle documentation

**Files:**

- Modify: `docs/ai/architecture.md:403-441`
- Modify: `docs/output-channels.md:206-226`
- Modify: `.agents/skills/output-channel-contracts/references/managed-problem-issues.md`
- Modify: `docs/ai/AGENTS.known-pitfalls.md`

**Interfaces:**

- Consumes: tested behavior from Task 2.
- Produces: one consistent lifecycle contract.

- [ ] **Step 1: Correct architecture and output-channel contracts**

Remove claims that cross-scope cleanup is absent. Document ancestry validation, per-fingerprint partial updates, range support, retained out-of-scope findings, close-only-when-empty behavior, and per-commit isolation.

- [ ] **Step 2: Update the detailed skill reference**

Record the same operational invariants without expanding the root skill or root `AGENTS.md`.

- [ ] **Step 3: Add a concise known pitfall**

Require both `file:line` and `file:start-end` parsing and prohibit whole-issue close/skip logic where reviewed and unreviewed fingerprints are mixed.

- [ ] **Step 4: Validate Markdown**

```powershell
node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs
```

Expected: discovered files are reported and the summary has zero errors.

- [ ] **Step 5: Commit documentation**

```powershell
git add docs/ai/architecture.md docs/output-channels.md .agents/skills/output-channel-contracts/references/managed-problem-issues.md docs/ai/AGENTS.known-pitfalls.md
git commit -m "docs: define partial managed issue reconciliation"
```

---

### Task 4: Run complete applicable verification

**Files:**

- Verify: all files changed by Tasks 1-3

**Interfaces:**

- Consumes: final implementation and docs diff.
- Produces: CI-equivalent evidence for deployment.

- [ ] **Step 1: Re-read status and diff**

```powershell
git status --short
git diff HEAD~2 --check
git diff HEAD~2 -- packages/outputs/src/index.ts packages/outputs/test/github-problem-issue.test.ts packages/outputs/test/gitea-problem-issue.test.ts docs/ai/architecture.md docs/output-channels.md .agents/skills/output-channel-contracts/references/managed-problem-issues.md docs/ai/AGENTS.known-pitfalls.md
```

Expected: no unrelated edits and no whitespace errors.

- [ ] **Step 2: Run repository gates in order**

```powershell
node node_modules/eslint/bin/eslint.js . --max-warnings=0
node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false
node node_modules/vitest/vitest.mjs run --coverage
node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs
cmd /c "pnpm build"
node packages/cli/dist/index.js eval --validate-only
cmd /c "pnpm docs:build"
```

Expected: all exit 0; tests and Markdown files are discovered; eval fixtures validate; docs build succeeds.

---

### Task 5: Deploy and repair public production state

**Files:**

- Read: `development/README.md`
- Read: `.agents/skills/remote-deployment/SKILL.md`
- Create temporarily: `build/aicr-deploy-latest.tar.gz`
- Deploy: `/home/tools/AICodeReviewer/source`

**Interfaces:**

- Consumes: verified commits and documented SSH selectors.
- Produces: healthy public service and corrected #42/#46 states.

- [ ] **Step 1: Package and upload**

Create the archive under `build/` excluding `.git`, `node_modules`, `dist`, `coverage`, and `build`. Use selector-derived SSH values and the mirrored key without printing secrets.

- [ ] **Step 2: Replace source and deploy**

Extract into the remote source directory and run the existing deployment script. Use the documented loopback proxy plus host-network path if port 3128 is active. Preserve the previous image for rollback.

- [ ] **Step 3: Verify deployment**

Check container status/logs, local port 8090 health, reverse-proxy health, and compiled output for the new helper.

- [ ] **Step 4: Repair GitHub issues once**

Use the authenticated GitHub API to add the normal lifecycle comment and close #46. Update #42 while keeping it open: set open fingerprints to `c40c69aa3d63da90,b7a69ee2f1cc3aef` and render `c8ec6907e82d3c56` as resolved. Do not modify #47.

- [ ] **Step 5: Re-fetch final state**

Expected: #42 is open with two open fingerprints and the CMake location in Resolved; #46 is closed with a lifecycle comment; #47 is unchanged; both health checks return `ok`.

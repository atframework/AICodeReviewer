# Managed Problem Cross-Scope Reconciliation Design

## Context

Production reviews for `atframework/atsf4g-co` exposed two related lifecycle
gaps in consolidated GitHub problem issues:

- issue #46 stayed open after commit `c8d403c3ac9f` re-reviewed
  `mq_channel_manager.cpp` and removed all three stored findings;
- issue #42 kept its CMake finding open after the same commit re-reviewed
  `component-functions.cmake` and removed that finding, because two findings in
  `OrbitRPCHandle.h` were outside the review scope.

The production image already contains cross-scope cleanup, the output channel
uses `issue_mode: consolidated` and `resolved_action: close`, and GitHub returns
both issues within the configured recent-issue window. The failure is therefore
inside output reconciliation rather than deployment, routing, or issue listing.

## Root Causes

1. `parseConsolidatedBodyProblemInfo` accepts only ``file:line`` locations.
   Consolidated bodies render `endLine` findings as ``file:start-end``. All
   three #46 headings use ranges, so their files are treated as unknown and the
   reviewed-file guard conservatively refuses to close the issue.
2. Cross-scope cleanup is all-or-nothing. It can close an old consolidated
   issue only when every stored fingerprint is absent and every stored file was
   reviewed. It cannot mark covered fingerprints resolved while retaining
   out-of-scope fingerprints. That prevents the CMake fingerprint in #42 from
   moving to Resolved.
3. The current tests use only single-line locations and check cross-scope close
   or skip behavior, so neither production shape is covered.
4. `docs/ai/architecture.md` says repository-wide cross-scope cleanup was
   removed, while the implementation, `docs/output-channels.md`, the detailed
   output-channel skill reference, and known-pitfall guidance say it is active.

## Goals

- Parse both ``file:line`` and ``file:start-end`` without weakening the
  reviewed-file safety guard.
- Reconcile old consolidated issues per fingerprint across push scopes.
- Keep out-of-scope findings open, visibly mark reviewed-and-missing findings
  resolved, and close an old issue only after no open fingerprints remain.
- Apply equivalent behavior to GitHub and Gitea dispatchers.
- Keep `per_commit` issues independent; cross-scope cleanup applies only to
  `consolidated` mode.
- Repair the existing production state: close #46 and update #42 so only
  fingerprints `c40c69aa3d63da90` and `b7a69ee2f1cc3aef` remain open while
  `c8ec6907e82d3c56` appears in Resolved.

## Non-Goals

- No config-schema, template-variable, routing, or authentication changes.
- No change to how review fingerprints are computed.
- No new admin endpoint or general-purpose issue migration command.
- No attempt to close the two unresolved Orbit findings in #42.
- No switch from consolidated issues to per-problem issues.

## Design

### Location metadata

Extend `ParsedProblemInfo` with optional `endLine`. Update the consolidated
heading parser so the end range is optional and the fingerprint remains the
final capture. When rebuilding retained or resolved entries, preserve the
range. Missing or malformed metadata remains non-resolvable when scoped
`reviewedFiles` is present.

### Per-fingerprint reconciliation

Use one pure categorization path for a stored consolidated issue:

1. Read `aicr:open_problems` and parse the stored metadata for each fingerprint.
2. Restrict current problems to fingerprints that already belong to that old
   issue; findings created by the current push stay in the current-scope issue.
3. Categorize every stored fingerprint:
   - present now: still open;
   - absent and its file was reviewed: resolved;
   - absent and its file was not reviewed: retained open;
   - absent but its file cannot be parsed: retained conservatively; if the
     retained problem cannot be rebuilt, skip the rewrite.
4. If no open fingerprint remains, apply `resolved_action` to the issue.
5. If some fingerprints resolved and some remain open, update the old issue:
   - preserve its original scope fingerprint;
   - advance the commit marker to the commit that performed reconciliation;
   - retain the original review summary as historical context;
   - rebuild the Open Issues section from still-open and retained problems;
   - render the newly resolved fingerprints in the Resolved section;
   - update the title and `aicr:open_problems` marker to match remaining open
     findings.
6. If no stored fingerprint changed, do not issue an unnecessary PATCH.

The same algorithm handles non-empty and empty current reviews. This removes
the current empty-review all-or-nothing special case. Same-scope consolidated
updates retain their existing ordering and webhook-replay protection.

### Mode boundaries

Cross-scope iteration runs only for `issue_mode: consolidated`. `per_commit`
continues to use a commit-specific scope without closing or rewriting issues
from other commits. `per_problem` behavior remains unchanged except that shared
location parsing accepts ranges wherever applicable.

### Commit ancestry and failures

Before changing an old scope, retain the existing compare check:

- `ahead` or `identical`: reconcile;
- `behind` or `diverged`: skip;
- missing commit metadata or compare failure: keep existing fail-safe behavior
  and do not claim a fingerprint was resolved from uncertain ordering.

GitHub/Gitea API failures continue to surface as failed dispatch results through
the existing publisher error path. The change adds no retry layer.

## Test Strategy

Add symmetric GitHub and Gitea regression coverage using production-shaped
bodies:

- a cross-scope issue containing only `file:start-end` findings closes when the
  ranged file was reviewed and the fingerprints disappeared;
- an old issue with findings in two files is partially updated when only one
  file was reviewed: reviewed findings move to Resolved, out-of-scope findings
  remain in `aicr:open_problems`, and the issue stays open;
- current-scope problems are not copied into the old-scope issue;
- empty reviews use the same partial reconciliation behavior;
- unknown retained metadata prevents rewriting;
- `per_commit` mode does not perform cross-scope cleanup;
- generated Markdown remains lint-compatible and range locations survive the
  parse/rebuild roundtrip.

After targeted tests, run the repository gates in the documented Windows order:
ESLint, TypeScript, Vitest with coverage, markdownlint CLI bin, build, eval
fixture validation, and docs build because contract documentation changes.

## Documentation and AI-Facing Assets

Update:

- `docs/ai/architecture.md` to remove the stale claim that cross-scope cleanup
  is absent and document partial reconciliation;
- `docs/output-channels.md` with the per-fingerprint cross-scope behavior;
- `.agents/skills/output-channel-contracts/references/managed-problem-issues.md`
  with the operational contract;
- `docs/ai/AGENTS.known-pitfalls.md` with the range-parser and partial-cleanup
  invariant.

Do not expand root `AGENTS.md`. `Plan.md` remains a roadmap index and already
links to the authoritative output-channel documents, so this completed bug fix
does not add roadmap detail. No config shape or public setup changes, so
`example/config.yaml` and `example/README.md` do not change.

## Production Rollout

1. Build and validate locally.
2. Sync the validated source to `/home/tools/AICodeReviewer/source` using the
   repository deployment procedure.
3. Run the public production `deploy.sh` without changing `config.yaml` or
   `.env`.
4. Verify the container, local `/healthz`, and reverse-proxy `/healthz`.
5. Perform a one-time GitHub state repair through the authenticated GitHub API:
   close #46 with the normal lifecycle comment and update #42 according to the
   approved open/resolved fingerprint split.
6. Re-fetch #42 and #46 to verify their final state and ensure #47 is unchanged.

## Acceptance Criteria

- The exact #46 body shape resolves all three ranged findings and closes the
  issue when `mq_channel_manager.cpp` is reviewed.
- The exact #42 body shape retains the two Orbit findings, marks only the CMake
  finding resolved, and leaves the issue open.
- GitHub and Gitea regression suites pass.
- All applicable repository gates pass after the final edit.
- The public production service is healthy after deployment.
- GitHub confirms #46 closed, #42 open with two open fingerprints and one
  resolved fingerprint, and #47 unchanged.

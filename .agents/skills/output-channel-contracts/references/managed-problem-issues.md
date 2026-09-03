# Managed Problem Issue Lifecycle

Read this when changing `gitea_problem_issue`, `github_problem_issue`, issue modes, scope fingerprints, resolved-action behavior, file-scope guards, or reconciliation tests.

## Managed problem issue lifecycle

- `gitea_problem_issue` and `github_problem_issue` support:
  - `consolidated` (default): one target-aware issue per scope. Push scopes use `headSha`, PR/MR scopes use the pull number (falling back to `headSha`), and other targets use the repository scope.
  - `per_commit`: one independent issue per commit. Never run cross-scope cleanup for this mode.
  - `per_problem`: one issue per problem fingerprint.
- Consolidated bodies carry commit, open-fingerprint, and per-problem fingerprint markers. Problem headings must parse both `file:line` and `file:start-end`; retained and resolved rendering must preserve `endLine` and enough of the original diagnostic for semantic verification.
- Same-scope updates verify commit order: same-commit replay cannot resolve problems, older/diverged commits are skipped, and compare failure updates without classification.
- Cross-scope reconciliation is consolidated-only and fail-safe:
  - require both stored/current commits and an explicitly successful ancestry comparison;
  - filter current findings to fingerprints already owned by the old issue;
  - treat reviewed-and-missing fingerprints as candidates, then require the injected `ProblemResolutionAnalyzer` to confirm them against current source; retain unreviewed, unconfirmed, legacy-no-diagnostic, and analysis-failure candidates, and skip rewriting if retained metadata is incomplete;
  - preserve the old scope marker and historical summary;
  - apply `resolved_action` only when no open fingerprint remains.
- Empty reviews use the same per-fingerprint path. With a resolution analyzer, same-scope markerless bodies no longer use the legacy whole-issue close fallback because they lack a diagnostic the model can verify; different scopes never use that fallback.
- `reviewedFiles` flows from `ReviewSummaryPublishOptions` through bootstrap to the third `reconcileProblems` argument. Do not remove or bypass it.
- Reconciliation only runs for real review outcomes, never for failure notices: `ReviewSummaryPublishOptions.skipReconcile` makes the `github_problem_issue` / `gitea_problem_issue` bootstrap wrappers return `[]` without calling `reconcileProblems` (and without consuming the per-publisher `reconciled` flag). `publishTriggerErrorReport` sets it alongside `bypassNoProblemsPolicy` so a failed/timed-out analysis (empty problem list) cannot resolve or close managed issues. A normal genuine-empty review omits it so resolved findings still close.
- Per-problem bodies embed `<!-- aicr:file=<path> -->` and may parse legacy `Location: path:line`. Missing file metadata with scoped review input must remain unresolved.
- Same-scope duplicate consolidated issues from prior races are resolved after the primary issue is updated.
- Production bootstrap injects one cached resolution analyzer per review and uses the model/client resolved from `llm.triage_model_chain`; an absent or empty chain must reuse the code-analysis model/client. Duplicate cleanup remains deterministic because it reconciles managed identity, not code resolution.
- Titles stay output-owned and concise; `aicr.publish_summary.title` only affects the summary rendered in the body. When every surviving problem is retained from an unreviewed file, refresh the generated severity/count/location prefix but preserve the existing descriptive suffix instead of promoting retained placeholder prose into the issue title.
- Gitea applies `auto_tag` and `reviewed_tag` at issue creation through `body.labels`.

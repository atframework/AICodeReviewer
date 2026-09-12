---
name: repository-baseline-validation
description: "Select and run repository gates for code, docs, CI, Docker, or shared tooling; skip checks unrelated to the changed surfaces."
user-invocable: false
---

# Repository Baseline Validation

1. Classify the actual diff using
   [the baseline matrix and commands](../../../docs/ai/AGENTS.repository-baseline.md).
   Check the current package scripts/configs before assuming versions or scope.
2. Run targeted checks during iteration, then all applicable final gates after
   the last edit. Keep logs under `build/logs/`. Confirm discovered files/tests;
   a silent library invocation or a crashed worker is not a passing gate.
3. Fix the underlying failure without weakening assertions, globs, or strict
   flags. Report unrelated baseline failures separately from changes in this task.
4. For Windows launch/spawn/fixture failures, use the
   [PowerShell failure boundaries](../modern-cli-toolkit/references/powershell-for-agents.md).
   Rerun the exact gate with permitted access; do not count a failed launcher as
   product failure or success. A direct script equivalent is diagnostic evidence
   unless it executes the complete package-script gate.
5. For tooling, dependency, docs-site, or Docker changes, check only the matching
   [build/docs pitfalls](../../../docs/ai/pitfalls/AGENTS.build-and-docs.md).
   Validate workspace topology with its dedicated skill if it changed.
6. Finish with `git diff --check`, a scoped diff review, and an exact record of
   passed, failed, blocked, and unrun gates. Do not claim completion with a
   required gate missing.

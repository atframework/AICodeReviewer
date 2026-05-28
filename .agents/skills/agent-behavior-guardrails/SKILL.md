---
name: agent-behavior-guardrails
description: "Use when: planning, coding, refactoring, reviewing, or editing prompts for non-trivial tasks where assumptions, scope control, simplicity, or verification matter; do not use for obvious one-line fixes."
user-invocable: false
---

# Agent Behavior Guardrails

Use this skill to reduce common coding-agent mistakes: hidden assumptions,
overbuilt designs, drive-by edits, and unverifiable "done" claims. It is
intentionally small; project-specific rules in `../../../AGENTS.md` and
specialized skills still win.

## Core habits

1. **Clarify before executing**
   - State assumptions when they affect design, security, data shape, or
     workflow.
   - If multiple interpretations lead to different implementations, present the
     options and ask before choosing.
   - Push back when the requested path is riskier or more complex than a simpler
     alternative.
2. **Choose the simplest sufficient change**
   - Start with the smallest change that satisfies the requested outcome.
   - Do not add speculative configuration, extension points, or abstractions for
     single-use code.
   - Prefer a clear, correct baseline before optimizing; preserve correctness
     when optimizing.
3. **Edit surgically**
   - Every changed line should trace to the user's request or to cleanup made
     necessary by your change.
   - Match nearby style and public API conventions; avoid reformatting, comment
     churn, or drive-by refactors.
   - Remove imports, variables, tests, docs, or files made obsolete by your own
     change, but only mention unrelated pre-existing dead code.
4. **Work from verifiable goals**
   - Convert broad requests into success criteria before editing: "bug
     reproduced", "test passes", "markdown validates", "route handles X".
   - For bugs, prefer a failing test or minimal reproduction before the fix when
     practical.
   - Keep looping until targeted verification passes, or stop with a concrete
     blocker and the smallest remaining question.

## Lightweight checklist

Before editing:

- Identify the exact user-visible outcome.
- List assumptions that could change the implementation.
- Pick the narrowest files and checks needed.

After editing:

- Re-read the diff and remove unrelated changes.
- Run the most targeted validation first, then broader gates when the touched
  area requires them.
- Summarize verification honestly; distinguish not-run checks from passing
  checks.

## Anti-patterns to avoid

- Silently selecting one interpretation of an ambiguous request.
- Adding "future-proof" APIs, strategies, caches, retries, or configuration
  without a current requirement.
- Refactoring adjacent code while fixing a local bug.
- Reporting completion without a check that matches the requested outcome.
- Treating noisy output or prose as proof when the repository has structured
  contracts or tests.

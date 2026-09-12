---
name: agent-behavior-guardrails
description: "Resolve scope, assumptions, and acceptance criteria for non-trivial planning, implementation, or review; skip straightforward edits with clear criteria."
user-invocable: false
---

# Agent Behavior Guardrails

Turn a broad request into a verifiable outcome before implementation:

1. Inspect the current diff and relevant source/tests. Distinguish observed
   behavior, intended contracts, and assumptions that could change the solution.
2. State the outcome, affected surfaces, simplest sufficient approach, tradeoffs,
   and validation. Ask only about unresolved choices that change implementation;
   use existing authorization and context for routine decisions.
3. Tie each edit to that outcome. Remove only code made unused by your change;
   avoid speculative APIs, config, and unrelated cleanup.
4. For a defect, reproduce the failing behavior when practical. Validate the
   public contract and failure boundary, not a copy of the implementation.
5. Re-read the diff and run the applicable final gates from
   [the baseline](../../../docs/ai/AGENTS.repository-baseline.md). Report evidence
   and remaining limits; prose or an empty test run is not verification.

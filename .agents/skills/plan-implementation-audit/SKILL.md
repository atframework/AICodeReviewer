---
name: plan-implementation-audit
description: "Compare roadmap or design claims with implementation and retire completed task artifacts; skip unrelated feature work or ordinary test additions."
user-invocable: false
---

# Plan Implementation Audit

1. Read the relevant unfinished item in `Plan.md`. Use
   [the documentation map](../../../docs/ai/index.md) for corresponding contracts
   and decisions; consult milestones only when acceptance history matters.
2. Map each acceptance claim to code, configuration wiring, consumer behavior,
   and meaningful tests. A schema field or mock alone does not establish runtime
   behavior. Load only matching [pitfall topics](../../../docs/ai/AGENTS.known-pitfalls.md).
3. Separate local implementation, real local-backend acceptance, and deployment
   evidence. An external service label does not block local work that can be
   verified independently. State gaps and a plan before fixing them.
4. Trace persistence through recovery: fresh process, expired lease, partial
   pages, retry budgets, config changes, and actual downstream call counts.
   Use public records in conformance fixtures (`computeStreamId(receipt)` instead
   of adding a memory-only property). Local checkpoints cannot prove remote
   exactly-once publication. See [scheduling](../../../docs/ai/pitfalls/AGENTS.scheduling.md).
5. Map the actual diff to docs/examples and update affected contracts in the same
   change. For runtime or output work select the corresponding specialized skill;
   do not copy its checklist here. Run the applicable final baseline gates.
6. Retire a `docs/superpowers/{specs,plans}/` file only when implementation,
   validation, and durable decisions are accounted for. Search inbound links and
   update them first. Unchecked template boxes alone do not prove incompleteness;
   retain tasks with missing evidence. Keep `Plan.md` forward-looking.

Report each material gap with its source, fix or remaining work, and validation.
Do not require one test file per source file; test observable contracts and risks.

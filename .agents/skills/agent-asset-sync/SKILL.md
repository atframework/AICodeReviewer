---
name: agent-asset-sync
description: "Sync AGENTS instructions, AGENTS-prefixed prompt reference files, and reusable skills after repository-wide guidance changes. Use when shared agent rules changed; do not use for ordinary feature edits that do not alter repository-wide instructions."
user-invocable: false
---

# Agent Asset Sync

## When to Use

- After changing repository-wide guidance, build gates, workspace layout, Docker or pnpm behavior, or shared tooling defaults.
- When a shared workflow changes enough that future agents would otherwise learn stale rules.
- When `AGENTS.md`, `docs/ai/AGENTS.*.md`, or `.agents/skills/` would be out of date after a repository-wide change.

## Do Not Use

- For package-local feature work that does not change repository-wide agent guidance.

## Procedure

1. Read the existing `../../../AGENTS.md`, related `../../../docs/ai/AGENTS.*.md` files, and affected skills before editing.
2. Merge new guidance into existing assets instead of appending near-duplicate sections.
3. Keep always-on rules in `../../../AGENTS.md`; keep detailed AI-facing reference material in `../../../docs/ai/AGENTS.*.md`; keep workflows in `.agents/skills/`.
4. Put temporary sync notes, helper scripts, and generated comparison output under `../../../build/` instead of the repository root.
5. Name AI-facing prompt/reference files and skills by function, not by milestone identifiers or milestone filenames.
6. If `AGENTS.md` references an AI-facing prompt/reference file, that file name must start with `AGENTS.`.
7. Validate markdown for every changed AI maintenance file before finishing.

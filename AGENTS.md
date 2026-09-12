# AICodeReviewer Agent Guidelines

## Working rules

- For every task, research the current source of truth in depth before choosing
  a solution: inspect relevant code, config, tests, and decisions; verify external
  contracts against current authoritative sources. Do not guess. Before editing,
  state an evidence-backed plan with assumptions, tradeoffs, affected surfaces,
  and validation. Ask when unresolved ambiguity changes the implementation.
- Keep edits within the requested scope; preserve unrelated working-tree changes.
  Do not add speculative features, broad refactors, or style churn.
- After the final edit, run every applicable gate in
  [repository baseline](docs/ai/AGENTS.repository-baseline.md). Targeted checks
  are iteration evidence. Confirm file/test discovery; report unrun, blocked,
  or failing checks without claiming completion. Never weaken gates to pass.
- When behavior changes, sync the affected docs, both public locales, examples,
  AI guidance, and `Plan.md` roadmap entry in the same change; explain any surface
  that needs no update. Schema acceptance alone does not prove runtime support.
- All temporary task artifacts belong under `build/`: use `build/tmp/` for
  helpers/data, `build/logs/` for logs, and `build/deploy/` for staging. Create
  the directory first. `eval/` contains permanent fixtures only.
- On Windows use PowerShell 7+ (`pwsh.exe -NoLogo -NoProfile`), never 5.1.
  Prefer `rg` for search and the modern tools from the shell skill. Probe host
  availability with `Get-Command` (POSIX: `command -v`); only the shipped review
  image guarantees its toolset. Use native Node CLI entrypoints if `.ps1` shims
  are blocked; exact commands are in the repository baseline.

## Read only what the task needs

Select skills by their descriptions; if discovery is unavailable, use the
[skill index](.agents/skills/README.md). Read only matching skills and reference
sections, not every linked file. For implementation or review, consult the
[pitfall topic map](docs/ai/AGENTS.known-pitfalls.md) and load the affected topics.
For unknown or cross-subsystem work, use the [documentation map](docs/ai/index.md)
to locate code and relevant architecture sections. History is optional context.

## AI guidance ownership

- `AGENTS.md` is the sole always-on canonical repository guide;
  `.agents/skills/*/SKILL.md` owns task workflows. Keep client-private files
  (`CLAUDE.md`, Copilot, Zoo/Kilo, OpenCode, etc.) as thin bridges or scoped deltas.
- Before changing AI assets, read the existing entrypoints and affected skills,
  then merge or replace rules instead of appending near-duplicates. AI-facing
  context files linked from this guide use functional `AGENTS.*.md` names.
- Skills use matching directory/frontmatter `name`, a concrete `description`
  with a useful scope boundary, and a body usable without proprietary metadata.
  Load detailed references only under an explicit task condition.
- Keep `Plan.md` forward-looking, stable contracts in topic docs, and completed
  history in `docs/ai/milestones/`. Do not copy history into prompts or skills.
  Retire completed `docs/superpowers/{specs,plans}/` files only after validation
  and preservation of durable decisions; retain unfinished work.
- Record reusable retry lessons in the closest existing skill or pitfall topic:
  trigger, non-obvious cause, preferred fix, and code/test pointer. Merge with
  existing rules; do not accumulate incident logs or generic advice.

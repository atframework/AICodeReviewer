---
name: ai-agent-maintenance
description: "Audit and maintain repository prompts, skills, bridges, and AI reference routing; skip feature edits that leave AI assets unchanged."
user-invocable: false
---

# AI Agent Maintenance

## Research and choose the surface

1. Inventory current instructions, skills, references, runtime prompt builders,
   and their callers. Start with `git status`/`git diff`; preserve unrelated edits.
   Measure bytes as well as lines, and trace which files a typical task loads.
2. Verify changed authoring/compatibility claims through the matching record in
   [the source map](../../../docs/ai/source-index.md) and current primary sources.
   Preserve older verification dates for records not refreshed.
3. State the evidence-backed plan before editing. For each rule choose one owner:
   global invariant → `AGENTS.md`; workflow → matching skill; conditional contract
   → topic reference; external evidence → source record; history → milestone.
4. Merge duplicates and remove generic advice, stale snapshots, and incident
   narratives. Retain non-obvious invariants, failure boundaries, and source/test
   pointers. Do not copy complete schemas, CLI manuals, or deployment runbooks.

## Keep discovery and loading cheap

- Descriptions name the task and a useful exclusion; directory and frontmatter
  `name` match. Preserve existing invocation metadata. Do not add proprietary
  fields for correctness or generate tool-private copies in Git.
- Keep the skill body sufficient for its common workflow. Link each substantial
  reference with a concrete trigger; do not instruct agents to read all references.
  Keep short skills self-contained instead of adding unnecessary routing layers.
- The root guide, skill index, pitfall map, and source map are navigation, not
  duplicate manuals. Update inbound links when moving content; preserve stable
  architecture anchors and ongoing task documents.
- Runtime prompts cannot assume repository-maintenance references are available
  in a review sandbox. Keep required output/security rules self-contained.
  The current bundle copies skill bodies only; linked references remain source
  files and require source-checkout access or an explicit context fetch.
  For model/MCP/layering changes use
  [runtime integration](../agent-runtime-integration/SKILL.md).
- Add retry-derived lessons only when they change future decisions; merge with
  the closest existing rule. Launcher access-denied is already covered by the
  [Windows reference](../modern-cli-toolkit/references/powershell-for-agents.md).

## Validate the resulting reading path

- Run the real repository Markdown gate after the final edit; verify it discovers
  new references. Check YAML metadata, local links, moved anchors, and duplicate
  active instruction surfaces.
- Walk representative tasks through the revised routing and compare required
  reads and bytes. Check both positive and negative skill-selection cases.
  Structural checks do not prove model quality or runtime token savings.
- For runtime prompt edits, preserve placeholders and tool contracts and run
  assembly/runtime tests plus the applicable baseline gates. Preserve independent
  triage, repair, and resolution prompts unless their own contract needs editing.
- Sync affected docs, examples and roadmap navigation; keep research reports and
  measurements under `build/`. Report which surfaces were retained and why.

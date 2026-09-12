# AI Source Map

Use the matching record before changing an external compatibility contract.
Do not read all source files as startup context. Each record retains its own
`last_checked`, `next_review`, and `update_trigger`; a past check is evidence
for that date/version, not proof of current behavior. Refresh only affected
records from primary sources and mark unavailable claims unverified.

| Change | Source records |
| --- | --- |
| AGENTS, skill descriptions, progressive disclosure, review prompt design | [Authoring](sources/authoring.md) |
| Claude/Copilot editor instructions, optional client bridges | [Clients](sources/clients.md) |
| Kilo/Zoo, OpenCode or Copilot CLI flags/config/skills | [CLI adapters](sources/cli-adapters.md) |
| pi/omp models, MCP, trust, events or search | [pi family](sources/pi-family.md) |
| Model catalog, quota classification, completed/live usage | [Models and usage](sources/models-and-usage.md) |
| MCP schemas, transport or authorization | [MCP](sources/mcp.md) |
| PowerShell or runtime image tools/releases | [Shell and tooling](sources/shell-and-tooling.md) |

The 2026-09-12 authoring refresh covers concise instructions, conditional
reference loading, skill metadata, the Claude import bridge, and PowerShell 7
pipeline chains. Other dated records were condensed with their evidence scope
preserved; adapter implementations were not changed by this layout pass.

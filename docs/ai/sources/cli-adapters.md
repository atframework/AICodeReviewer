# CLI Adapter Sources

Read only the record for the external contract being changed. Dates describe the
last evidence check, not guaranteed current behavior. Retained records were not
revalidated by the 2026-09-12 layout change unless explicitly marked below.

## Kilo Code and Zoo Code

- Sources:
  - <https://kilo.ai/docs/customize/agents-md>
  - <https://kilo.ai/docs/customize/skills>
  - <https://kilo.ai/docs/customize/custom-instructions>
  - <https://docs.zoocode.dev/>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/cli/cmd/run.ts>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/session/message-v2.ts>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/session/processor.ts>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/session/session.ts>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/tool/websearch.ts>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/tool/mcp-exa.ts>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/tool/registry.ts>
  - <https://github.com/Kilo-Org/kilocode/blob/v7.2.40/packages/opencode/src/config/variable.ts>
  - <https://docs.zoocode.dev/getting-started/installing>
  - <https://docs.zoocode.dev/roo-to-zoo-migration>
  - <https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/tree/8d4ed32f0606a4c7f45aac959540508aeac0b0e2>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/apps/cli/src/index.ts>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/apps/cli/src/lib/storage/config-dir.ts>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/src/core/config/CustomModesManager.ts>
- Evidence: Dated Kilo source verifies native config/MCP/skill surfaces, disjoint completed-step usage and explicit websearch activation/deny. Zoo retains roo binary and .roo/.roomodes compatibility paths in the checked revision. Version checks are evidence, not current Dockerfile installation pins.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-08
- `update_trigger`: Re-check before changing the pinned Kilo CLI version or JSON-stream parser, the `zoo` adapter kind, Zoo CLI binary, `.roo`/`.roomodes` compatibility paths, `.kilo`/`.kilocode` path rules, kilo.json `instructions`/`skills.paths`/`mcp` wiring, adapter-native skill materialization, or the websearch permission/activation mapping (`KILO_ENABLE_EXA`, `permission.websearch`).

## OpenCode

- Sources:
  - <https://opencode.ai/docs/rules/>
  - <https://opencode.ai/docs/agents/>
  - <https://opencode.ai/docs/skills/>
  - <https://opencode.ai/docs/cli/>
  - <https://opencode.ai/docs/mcp-servers/>
  - <https://opencode.ai/docs/config/>
  - <https://opencode.ai/docs/providers/>
  - <https://opencode.ai/docs/models/>
  - <https://opencode.ai/config.json>
  - <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts>
  - <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/websearch.ts>
- Evidence: OpenCode uses project opencode.json, a provider-keyed model map, env references, native MCP, and canonical skill discovery. Verify command flags, complete limit/cost shapes and websearch activation against the current schema before adapter edits.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-09
- `update_trigger`: Re-check when adding OpenCode agents, permissions, `.opencode/skills`, or `opencode.json` bridges, and before changing the opencode adapter command line or config materialization.

## GitHub Copilot CLI

- Sources:
  - <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
  - <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview>
  - <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills>
- Evidence: Standalone copilot replaces the legacy gh extension. Verify programmatic flags, auth precedence, additional MCP config and skill loading. Native web_search exclusion is separate from URL/shell permission checks.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-08
- `update_trigger`: Re-check before changing the copilot-cli adapter command line, auth env mapping, MCP wiring, or skills materialization for Copilot CLI.

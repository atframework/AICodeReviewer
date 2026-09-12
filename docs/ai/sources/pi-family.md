# pi and oh-my-pi Sources

Read only the record for the external contract being changed. Dates describe the
last evidence check, not guaranteed current behavior. Retained records were not
revalidated by the 2026-09-12 layout change unless explicitly marked below.

## Per-run home and MCP child environment

- Sources:
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/environment-variables.md>
  - <https://nodejs.org/api/os.html#oshomedir>
- Evidence: pi exposes PI_CODING_AGENT_DIR; Node home lookup on Windows also needs USERPROFILE. AICR now redirects HOME/USERPROFILE and XDG directories for both pi-family adapters, retaining their existing agent-directory override. The generated pi MCP bridge forwards these isolated directories through a minimal environment allowlist. Unrelated provider credentials do not enter the MCP child environment.
- Local checks: `packages/agents/test/index.test.ts` runs the generated bridge lifecycle and inspects the actual child spawn environment. The orchestrator concurrency test verifies distinct home directories. Historical native-home considerations in the records below are superseded by this isolation change; other dated CLI/parser claims were not refreshed.
- `last_checked`: 2026-09-12
- `next_review`: 2026-12-12
- `update_trigger`: Changing pi-family directory overrides or the MCP child's environment allowlist.

## pi (earendil-works)

- Sources:
  - <https://github.com/earendil-works/pi> (README with full CLI reference)
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/json.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/custom-provider.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/settings.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/environment-variables.md>
- Evidence: pi uses positional JSON-mode tasks, models.json, an isolated PI_CODING_AGENT_DIR and a project skill trust gate. MCP is supplied through a lifecycle-managed extension. Completed message_end usage excludes cumulative deltas; host user skills remain a native-sandbox consideration.
- `last_checked`: 2026-08-26
- `next_review`: 2026-11-26
- `update_trigger`: Re-check before changing the pi adapter command line, the generated MCP bridge extension, `models.json`/`settings.json` materialization, or the `--approve` trust decision.

## oh-my-pi (omp)

- Sources:
  - <https://github.com/can1357/oh-my-pi> (README)
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/cli-reference.md>
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/config-usage.md>
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/models.md>
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/mcp-config.md>
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/mcp-runtime-lifecycle.md>
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/compaction.md>
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/skills.md>
  - <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/web_search.md>
  - <https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/environment-variables.md>
- Evidence: omp uses pi-family completed-message output, models.yml, config.yml and native mcp.json. The checked version exposes MCP through xd:// writes and enables built-in search by default; credential indirection and explicit disabled config are required for isolated AICR runs.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-26
- `update_trigger`: Re-check before changing the omp adapter command line, `models.yml`/`config.yml`/`mcp.json` materialization, the MCP tool-name normalization rule, or the web-search settings/credential env mapping (`web_search.enabled` default, provider id list, `TAVILY_API_KEY`-style env names, or the `agent.web_search` schema in `packages/core/src/config.ts`).

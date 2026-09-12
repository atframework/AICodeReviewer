# Prompt, MCP and Sandbox Contracts

Read for Prompt Manager, orchestration, context/repair, or sandbox changes.
Adapter-specific details live in [agent adapters](AGENTS.agent-adapters.md).

## Discovery and materialization

Sources: `packages/core/src/prompt-manager.ts`,
`packages/agents/src/runtime-bundle.ts`, and their tests.

- Preserve duplicate skill-name, overlapping path-instruction, and alias versus
  Copilot conflict detection. Root/nearest discovery must not inject the same
  asset twice. Keep protected rules above project/path/common/alias precedence.
- Use `materializeRuntimeBundle` for every agent attempt, including fallback.
  Instructions, skills, model config, MCP, environment, and manifest belong in
  one isolated bundle. Never mutate developer-global agent state.
- Expose one active native instruction surface per adapter. Source copies under
  `instructions/` are for audit; do not load them again through a config glob.
  Reject normalized output-path collisions before writing generated skills.
- Tool names/schema come from `createAicrOutputToolRegistry`, not prompt prose.
  Only advertise implemented tools. Preserve the base-prompt placeholders
  and test assembly after prompt edits.

## Structured output and context follow-up

Sources: `packages/server/src/review-orchestrator.ts`,
`packages/mcp-output/src/index.ts`, `server.ts`, and their tests.

- Native MCP state is authoritative. Normalize adapter tool names to `aicr.*`;
  use stream/JSON/XML compatibility output only when authoritative results are
  absent. Do not collect the same problem again from stdout after MCP/events.
- Clear `.aicr-output-state.json` before each attempt and pin
  `AICR_OUTPUT_STATE_PATH` to the shared writable agent workspace. Container cwd
  is `/workspace/agent`. Native runs rewrite the image-only MCP server path
  `/app/packages/mcp-output/dist/server.js` to its host module-relative location.
- Replay both `contextRequests` and `attributionRequests` through VCS handlers.
  A pending response is not proof the file is inaccessible. When context is
  fetched, re-run verification and clear provisional findings, even if the same
  round also emitted problems. Preserve bounded follow-up rounds; failed invalid
  requests alone do not invalidate otherwise confirmed findings.
- Free-form agent stdout is not a report. Repair summaries claiming issues
  without `report_problem` records and prose asking humans for source/blame.
  If agent repair fails, use direct LLM repair. Explicit no-issue/no-code prose
  normalizes to `skip`, not a generic fallback summary.
- Deduplicate fingerprints in the collector and clear its identity set with
  review outputs. Publisher reconciliation has independent dedup/once guards;
  see [output contracts](AGENTS.outputs.md).

## Sandbox process and secret boundaries

Sources: `packages/sandbox/src/types.ts`, `native.ts`, `docker.ts`,
`process-tree.ts`, and sandbox tests.

- Enforce `ALLOWED_COMMANDS` in native and container spawns; add a new agent
  executable there as well as to adapter tests. Use the resolved docker/podman
  engine. Adapter mocks do not exercise the sandbox allowlist.
- Keep container env files on the host outside source/agent/tmp mounts and remove
  them after each run. Materialized config contains env references, never keys.
- For stdin use spawn-based runners; `execFile` has no synchronous-style `input`
  option. Preserve optional-property semantics when constructing adapter options.
- Timeout kills the entire descendant tree: Linux `/proc` PPID traversal catches
  `setsid` escapees that process-group signals miss; Windows uses tree termination.
  Keep TERM→KILL escalation and the stdio-destroy/force-resolve backstop. Validate
  inherited-stdio and Linux setsid regressions; outer containers retain `--init`.

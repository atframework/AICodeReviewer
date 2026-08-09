---
title: Agent adapters
description: The supported agent CLIs and how AICR translates models, instructions, and MCP tools into each one's runtime bundle.
---

AICR does code reasoning through external agent CLIs (and a built-in
direct-LLM path). Each agent kind is wrapped by an `AgentAdapter` that turns
AICR's provider-neutral model spec into the agent's native configuration. The
adapter also materializes an isolated runtime bundle per run, so AICR never
mutates your global agent CLI config directory.

For the config fields referenced here, see
[Agent and sandbox](/en/configuration/agent/). For the MCP tools the agent
calls back into, see [MCP tools](/en/integrations/mcp-tools/).

## How a runtime bundle is materialized

For every agent run, AICR writes a complete, isolated bundle into the run's
`agent/` directory and runs the agent with that directory as its config root.
The bundle contains:

- The LLM provider/model configuration, translated to the agent's native
  format.
- The MCP configuration pointing at the local `aicr-output` server, wired
  through the agent's native MCP surface (config file or CLI flags).
- A combined `AGENTS.md` with the effective repository instructions — the one
  instruction file every supported CLI discovers natively.
- Activated skills in the canonical Agent Skills layout
  (`.agents/skills/<name>/SKILL.md`), plus adapter-native copies where the CLI
  needs a different root.
- Environment-variable injection.
- A `manifest.json` recording exactly what was injected, what was delegated
  to the tool's native catalog, what was downgraded, and which native
  surfaces (instructions/skills/MCP) were wired — so capability gaps are
  auditable rather than silently dropped.

The orchestrator calls `materializeRuntimeBundle` once per run instead of
mutating any global config. Each adapter then translates the bundle into its
own file layout (for example Kilo's `kilo.json`, opencode's `opencode.json`,
Zoo Code's `.roo/`).

## Native surface wiring

Instructions, skills, and the `aicr-output` MCP server are wired into each
agent's native discovery surfaces; the run manifest records the wiring under
`nativeSurfaces`:

| Surface | kilo | opencode | claude-code | copilot-cli | zoo |
| --- | --- | --- | --- | --- | --- |
| Instructions | `AGENTS.md` (auto-loaded) | `AGENTS.md` (auto-loaded) | `AGENTS.md` via `CLAUDE.md` `@AGENTS.md` import | `AGENTS.md` (auto-loaded) | `AGENTS.md` |
| Skills | `kilo.json` `skills.paths` → `.agents/skills` | `.agents/skills/<name>/SKILL.md` + `permission.skill` allow | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` (resource) |
| `aicr-output` MCP | `kilo.json` `mcp` | `opencode.json` `mcp` | `--mcp-config` + `--strict-mcp-config` CLI flags | `--additional-mcp-config` CLI flag | none (prompt-only) |

The MCP output-state file path is pinned via `AICR_OUTPUT_STATE_PATH` in the
server environment, so the orchestrator reliably collects reported problems
and summaries regardless of which working directory the host CLI spawns MCP
servers with.

## ModelSpec translation

AICR holds a single provider-neutral `ModelSpec` (context window, max
input/output tokens, capability flags, pricing, reasoning effort, etc.).
Each adapter translates `ModelSpec` plus the optional `thinkingLevel` into
the provider-native fields the agent CLI expects (Azure, Vertex, Bedrock,
OpenAI-compatible, Anthropic, Gemini, etc.).

When the [model catalog](/en/configuration/llm/) is enabled, AICR enriches
`ModelSpec` from models.dev before translation. Explicit values you write in
`llm.providers[]` and `model_catalog.overrides` always win over catalog data;
missing fields are never fabricated.

## Capability downgrade

When an adapter cannot express a capability natively, it does **not** silently
drop it. Instead the runtime bundle `manifest.json` records the downgrade
mode for that capability:

- `injected` — AICR wrote the value into the agent's native config.
- `delegated` — the agent CLI resolves it from its own built-in catalog.
- `not_applicable` — the agent has no surface for this capability.

This makes every model-translation decision auditable from the run snapshot.

## Supported agent kinds

### `kilo` (Kilo Code)

The primary deployment-test agent. AICR materializes Kilo's `kilo.json` with
the LLM provider config, the local stdio `aicr-output` MCP server, skills,
instructions, and `compaction.{auto,threshold_percent,prune}` conversation
settings.

Kilo does not read models.dev, so for OpenAI-compatible custom providers AICR
injects `contextWindow`, `maxTokens`, `supportsImages`,
`supportsComputerUse`, `supportsPromptCache`, and per-million-token pricing
into the model info block.

:::caution[Kilo compaction needs a context window]
Kilo only auto-compacts for models that declare a `contextWindow`. If the
model catalog is disabled and no `context_window` override is set, Kilo
silently skips compaction and large PRs overflow. **Always enable
`llm.model_catalog` or set `context_window` in overrides.** See
[Troubleshooting](/en/troubleshooting/).
:::

### `opencode`

opencode resolves known providers from models.dev natively. For custom
`@ai-sdk/openai-compatible` providers that opencode cannot resolve, AICR puts
models under `provider.<provider-id>.models.<model-id>` and injects complete
schema-valid `limit`/`cost` pairs plus supported model capabilities. Injection
is skipped when the provider hits a models.dev known provider, avoiding
double-write conflicts.

The agent runs as `opencode --pure run --format json --auto --dir <agent-dir>` with
`--model provider/model` and emits part-wrapped `text` / `tool_use` events plus
`step_finish` usage events. Configuration is written to `opencode.json` in the
working-directory root and discovered through the sandbox cwd/`--dir` (avoiding
a host-only config path inside containers); provider transport and auth live
under provider `options`, model request parameters live under model
`options`, and API keys use `{env:NAME}` references. The file also carries
`compaction.{auto,prune}`, the `mcp` section for `aicr-output`, and a
`permission.skill` allow rule. Per-source instruction files remain audit
artifacts; the combined `AGENTS.md` is the single active instruction surface.
`--pure` disables external plugins, and update/title/LSP-download side effects
are disabled for this one-shot run.

### `zoo` (Zoo Code)

The Zoo Code adapter exposes `AgentKind: "zoo"`. The CLI binary and project
config paths still use the upstream `roo` / `.roo` / `.roomodes` compatibility
surface, so AICR writes its config into Zoo Code's current `.roo/settings.json`
path rather than inventing a `.zoo` path.

Zoo Code does not read models.dev, so AICR injects `contextWindow`,
`maxTokens`, `supportsImages`, `supportsComputerUse`, `supportsPromptCache`,
`inputPrice`, and `outputPrice` into `apiConfiguration.openAiCustomModelInfo`.
Native auto-condense settings (`autoCondenseContext`,
`condenseContextPercentThreshold`) are written into the same settings file.

### `claude-code` (Claude Code)

The agent runs headless as `claude -p --output-format json` (print mode, with
the review prompt piped via stdin) plus `--dangerously-skip-permissions`
inside the sandbox and `--mcp-config`/`--strict-mcp-config` to wire the
`aicr-output` MCP server in isolation from user/project MCP config. The JSON
result envelope gives the orchestrator the final answer, per-turn token
usage, USD cost, and turn count. Reasoning effort maps to `--effort` (AICR's
`minimal` tier maps to `low`).

Claude Code relies on its built-in Anthropic catalog and environment
variables; there is no file-level model-metadata surface. The environment
translation follows the current Claude Code env-var contract:
`maxOutputTokens` (or explicit `extraParams.max_tokens`) derives
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `contextWindow` derives
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, an explicit thinking budget sets
`MAX_THINKING_TOKENS` plus `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` (fixed
budgets are ignored on adaptive-reasoning models otherwise), and beta headers
go through `ANTHROPIC_BETAS`. Self-update, telemetry, and print-mode title
generation are disabled for one-shot sandbox runs. Context window and pricing
are otherwise delegated to Claude Code's native catalog; capability gaps are
recorded as `delegated` in the manifest.

Instructions reach Claude Code through a generated `CLAUDE.md` that
`@AGENTS.md`-imports the shared instructions file, and skills are
materialized to `.claude/skills/<name>/SKILL.md`.

Claude Code auto-compacts by default, so AICR does not inject additional
compaction config (opting out sets `DISABLE_AUTO_COMPACT`).

### `copilot-cli` (Copilot CLI)

The adapter targets the current GitHub Copilot CLI (`copilot` binary), not
the deprecated `gh copilot suggest` extension. The agent runs programmatically
as `copilot --prompt <task> --silent --no-ask-user --allow-all-tools
--allow-all-paths`, with `--model`, `--effort` (reasoning effort), and the
`aicr-output` MCP server wired per run via `--additional-mcp-config`.
Headless auth uses `COPILOT_GITHUB_TOKEN` (the CLI's highest-precedence auth
environment variable).

Copilot CLI uses its subscription's fixed model catalog. There is no
injection surface for model metadata, and conversation-level context
management is `not_applicable` (the CLI auto-compacts near the token limit).
AICR records the model as `not_applicable` in the manifest.

## Direct-LLM fallback (not an agent kind)

When an agent CLI cannot produce structured output even after a structured
repair pass, the orchestrator can fall back to calling the LLM gateway
directly. This is an internal fallback, **not** a configurable `agent.default`
value — the valid `agent.default` values are exactly `kilo`, `opencode`,
`zoo`, `copilot-cli`, and
`claude-code`. The orchestrator computes
`maxPromptTokens = floor(contextWindow × 0.6)` and lets the prompt manager
trim memory hints, skills, and instructions to fit; the diff itself is
compressed by the AICR-side compression stage.

## Model catalog injection summary

| Adapter | Reads models.dev natively? | Injection strategy |
| --- | --- | --- |
| opencode | Known providers yes; custom OpenAI-compatible providers no | Use schema-native provider/model nesting; inject complete `limit`/`cost` pairs and supported capabilities for custom providers only |
| kilo | No | Inject `contextWindow`, `maxTokens`, `supportsImages`, `supportsComputerUse`, `supportsPromptCache`, pricing |
| zoo | No | Inject into `.roo/settings.json` `openAiCustomModelInfo` |
| claude-code | No (built-in Anthropic catalog) | Derive `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; delegate the rest |
| copilot-cli | No (fixed subscription catalog) | No injection; recorded as N/A |

Injection only happens for custom or unresolved provider paths; when the tool
resolves the model from models.dev itself, AICR skips injection to avoid
double-write conflicts.

## Choosing an agent

Set `agent.default` globally. The schema also accepts
`workspaces.defaults.agent.default` and
`workspaces.instances.<id>.agent.default`, but the current version builds one
global adapter at startup — workspace-layer values are parsed but have no
effect, so mixing agents needs a future release. See
[Agent and sandbox](/en/configuration/agent/) for the timeout, sandbox, and
context-compaction fields that apply to every agent kind.

### Which agent should I use?

| Agent | Best for | Watch out for |
| --- | --- | --- |
| `kilo` (default) | The validated, supported default path. Best end-to-end test coverage and production hardening. | Needs a declared `contextWindow` to auto-compact — enable `llm.model_catalog` or set `context_window` in overrides, or large PRs will overflow. |
| `claude-code` | Teams already standardizing on Claude Code; Anthropic-native model catalog. | Auto-compacts by default (delegated to Claude Code's built-in behavior). AICR derives output/context limits and explicit thinking budgets; the rest delegates to Claude Code's native catalog. |
| `opencode` | Open-source-first setups; custom OpenAI-compatible providers. | Resolves known providers from models.dev natively. Custom providers need explicit schema-valid provider/model configuration. |
| `zoo` | Teams using Zoo Code as their primary tool. | Always needs `contextWindow`/`maxTokens`/`supportsImages`/pricing injected — enable the model catalog. |
| `copilot-cli` | GitHub Copilot subscription environments where you want zero per-call LLM cost. | Uses the subscription's fixed catalog; no model metadata is injected. No conversation-level auto-compaction surface (`not_applicable`). |

### Decision guide

- **Starting out or unsure?** Use `kilo` (the default). It has the deepest
  production validation and is the agent the deployment verification flow
  checks against.
- **Context overflow on large PRs?** Whichever agent you pick, ensure the
  model declares a `contextWindow` (via `llm.model_catalog` or an explicit
  `context_window` override). Without it, Kilo and Zoo cannot track context
  usage and will overflow instead of auto-compacting. If an overflow still
  occurs, AICR throws `AgentContextOverflowError` with the limit, requested
  tokens, and actionable guidance — not a generic `review_orchestration_failed`.
- **Mixing agents?** All workspaces share the global `agent.default` in the
  current version; per-workspace agent overrides are parsed but not applied
  yet.

Capability gaps (vision, reasoning, structured output, tool calls) are
recorded in each run's `manifest.json` as `injected`, `delegated`, or
`not_applicable` — they are never silently dropped.

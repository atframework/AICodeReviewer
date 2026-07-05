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
- The MCP configuration pointing at the local `aicr-output` server.
- The effective instructions (system prompt, repo-local rules, activated
  skills).
- Activated skills (full skill files or compact summaries, depending on the
  adapter's capability).
- Environment-variable injection.
- A `manifest.json` recording exactly what was injected, what was delegated
  to the tool's native catalog, and what was downgraded — so capability gaps
  are auditable rather than silently dropped.

The orchestrator calls `materializeRuntimeBundle` once per run instead of
mutating any global config. Each adapter then translates the bundle into its
own file layout (for example Kilo's `kilo.json`, opencode's `.opencode/`,
Zoo Code's `.roo/`).

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
`@ai-sdk/openai-compatible` providers that opencode cannot resolve, AICR
injects `limit.context`, `limit.output`, per-token `cost`, and `name` into
the model block. Injection is skipped when the provider hits a models.dev
known provider, avoiding double-write conflicts.

opencode's native compaction (`compaction.{auto,prune}`) is written into
`.opencode/config.json`.

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

Claude Code relies on its built-in Anthropic catalog and environment
variables; there is no file-level model-metadata surface. When the resolved
`ModelSpec` has `maxOutputTokens`, AICR derives `ANTHROPIC_MAX_TOKENS` from
it. Context window and pricing are delegated to Claude Code's native catalog.
Capability gaps are recorded as `delegated` in the manifest.

Claude Code auto-compacts by default, so AICR does not inject additional
compaction config.

### `copilot-cli` (Copilot CLI)

Copilot CLI uses its subscription's fixed model catalog. There is no
injection surface, and conversation-level context management is
`not_applicable`. AICR records the model as `not_applicable` in the manifest.

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
| opencode | Known providers yes; custom OpenAI-compatible providers no | Inject `limit`/`cost`/`name` for custom providers only |
| kilo | No | Inject `contextWindow`, `maxTokens`, `supportsImages`, `supportsComputerUse`, `supportsPromptCache`, pricing |
| zoo | No | Inject into `.roo/settings.json` `openAiCustomModelInfo` |
| claude-code | No (built-in Anthropic catalog) | Derive `ANTHROPIC_MAX_TOKENS`; delegate the rest |
| copilot-cli | No (fixed subscription catalog) | No injection; recorded as N/A |

Injection only happens for custom or unresolved provider paths; when the tool
resolves the model from models.dev itself, AICR skips injection to avoid
double-write conflicts.

## Choosing an agent

Set `agent.default` globally, override per workspace with
`workspaces.instances.<id>.agent.default`, or set
`workspaces.defaults.agent.default` for a workspace-set default. See
[Agent and sandbox](/en/configuration/agent/) for the timeout, sandbox, and
context-compaction fields that apply to every agent kind.

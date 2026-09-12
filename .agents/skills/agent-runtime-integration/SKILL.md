---
name: agent-runtime-integration
description: "Maintain agent CLI bundles, model/MCP config translation, prompt layers, and skills; skip ordinary review logic or output rendering."
user-invocable: false
---

# Agent Runtime Integration

1. Trace the affected path through `packages/agents/src/types.ts`, the target
   adapter, `runtime-bundle.ts`, server orchestration, and their tests. Consult
   architecture §3.6–3.8 only for the corresponding contract.
2. Before changing a CLI flag or generated config, refresh that adapter's
   [external source record](../../../docs/ai/source-index.md) and verify current
   upstream schema/help. Local fixtures alone can encode an invented contract.
3. Treat model config, MCP, instructions, skills, env/mounts and manifest as one
   per-run materialization. Write into the isolated bundle; secrets remain env
   references and developer-global config is untouched.
4. Keep protected rules above common/project layers. Materialize canonical skills
   into native surfaces as needed, expose one active instruction surface, reject
   path collisions, and record dropped/unsupported capabilities in the manifest.
5. Validate generated files, sandbox-visible paths, env, manifest, and actual
   context/output collection. Use current registry names and implemented tools;
   stdout JSON/XML is a compatibility fallback to native MCP.

The current bundle copies `SKILL.md` bodies, not their sibling references.
Repository references must be read from the source checkout (or fetched by a
concrete repository-relative context request); do not assume bundle-local links
work or move required runtime safety/output rules behind them.

## Load by changed contract

| Change | Reference / source |
| --- | --- |
| Prompt discovery, instruction precedence, MCP replay/repair, sandbox processes | [Review runtime](../../../docs/ai/pitfalls/AGENTS.review-runtime.md); prompt-manager, runtime-bundle, mcp-output tests |
| Adapter config, native skills, MCP, compaction, web search, argv, usage parser | [Agent adapters](../../../docs/ai/pitfalls/AGENTS.agent-adapters.md); target adapter and sandbox tests |
| Model catalog, workspace groups, quota fallback, live/final usage | [Config and state](../../../docs/ai/pitfalls/AGENTS.config-and-state.md); model-metadata, catalog-service, orchestration tests |

For MCP schema changes, update server/client tests and prompt guidance together.
For live usage, exercise split stdout records before exit and final accounting
after exit; previews must not be added twice. Run applicable final gates from
[the baseline](../../../docs/ai/AGENTS.repository-baseline.md).

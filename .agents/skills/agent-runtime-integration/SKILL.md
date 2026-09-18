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
   For platform presets, verify both protocol choices through the enriched model
   and actual bundle: catalog SDK metadata can describe a different protocol,
   and SDKs differ in whether they append /messages or /v1/messages.
3. Treat model config, MCP, instructions, skills, env/mounts and manifest as one
   per-run materialization. Write into the isolated bundle; env references keep
   secrets out of the bundle, while registered literal credentials (literal
   `api_key`, web_search `{ value }`) resolve before the bundle is built and
   may enter generated config or the per-run spawn environment. Verify the
   actual adapter output; never let either form reach developer-global config.
4. Keep protected rules above common/project layers. Materialize canonical skills
   into native surfaces as needed, expose one active instruction surface, reject
   path collisions, and record dropped/unsupported capabilities in the manifest.
5. For dynamic configuration, test an old pinned run and a new run through each
   affected adapter's generated config, command, env and manifest. Resolve search
   credentials after layering against deployment grants (env names stay `${VAR}`
   references; `{ value }` literals inject directly). Inherited file literals
   retain their destination restrictions; repository-owned input
   cannot increase approval or sandbox permissions (architecture §3.16).
   Named base/extra prompts must resolve from the pinned generation; strip
   frontmatter and append the extra body after the resolved base. Exercise
   actual bootstrap resolvers and an old task after publication
   (`runtime-generation.test.ts`), alongside prompt assembly tests.
6. Validate generated files, sandbox-visible paths, env, manifest, and actual
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

For MCP schema changes, update server/client tests and prompt guidance together;
verify host VCS execution and follow-up replay as well as tool discovery.
For live usage, exercise split stdout records before exit and final accounting
after exit; previews must not be added twice. Run applicable final gates from
[the baseline](../../../docs/ai/AGENTS.repository-baseline.md).

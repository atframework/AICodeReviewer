# AI Source Index

This file records verified external sources for repository AI-agent guidance, Agent Skills, MCP, and cross-tool compatibility. It is an evidence index, not a prompt body: keep it concise, cite sources, and avoid copying large external documentation into always-on files.

## How to use this index

- Check this file before adding or changing compatibility claims in `AGENTS.md`, `CLAUDE.md`, `.agents/skills/`, or tool-specific bridge files.
- If a source is missing, unavailable, or ambiguous, mark the claim as unverified instead of guessing.
- Refresh the relevant source row when external docs change, when a tool adds a new rules/skills surface, or when a repository change depends on updated compatibility behavior.
- Prefer canonical cross-tool files (`AGENTS.md`, `.agents/skills/<name>/SKILL.md`) over committed duplicates in tool-private directories.

## Last research pass

- `last_checked`: 2026-08-26
- Scope: M13 pi + oh-my-pi integration — pi README/CLI reference + `docs/{json,models,custom-provider,extensions,settings,environment-variables}.md`, omp README + `docs/{cli-reference,config-usage,models,mcp-config,mcp-runtime-lifecycle,compaction,skills}.md`; verified every adapter flag/env/config path against current upstream docs instead of memory.
- Result: `pi` uses `--mode json --approve --no-session` with a positional prompt, custom providers via `$PI_CODING_AGENT_DIR/models.json` (`apiKey: "$ENV"` interpolation), `PI_OFFLINE=1`/`PI_TELEMETRY=0`, and a generated user-level extension (`extensions/aicr-output.ts`) that bridges the AICR MCP stdio server into `pi_aicr_*` tools because pi has no built-in MCP by design. `oh-my-pi` uses `-p --mode json --auto-approve --no-session`, custom providers via `$PI_CODING_AGENT_DIR/models.yml` (env-name-first `apiKey`, `auth: none` for keyless), native MCP via `$PI_CODING_AGENT_DIR/mcp.json` exposing `mcp__<server>_<tool>` names, and config.yml `compaction.{enabled,thresholdPercent}`. Both discover project `.agents/skills/` and `AGENTS.md` natively; both get `PI_CODING_AGENT_DIR` injected with the sandbox-visible bundle path by the orchestrator.

## Source records

### AGENTS.md standard

- Sources:
  - <https://agents.md/>
  - <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Verified guidance:
  - `AGENTS.md` is a repository guide for coding agents, analogous to `README.md` for humans.
  - It should contain build/test commands, code style, project structure, security notes, and agent-specific conventions.
  - Nested `AGENTS.md` files can scope instructions to subtrees; user prompts still override repository files.
  - Codex layers global and project guidance, reading one instruction file per directory from repository root toward the current working directory; closer files override earlier guidance.
  - AGENTS.md is now stewarded by the Agentic AI Foundation (AAIF) under the Linux Foundation and is supported by 60k+ open-source projects and most major coding agents (Codex, Copilot coding agent, Cursor, Gemini CLI, Kilo Code, opencode, Aider, Augment, Windsurf, Zed, and others).
- `last_checked`: 2026-08-08
- `next_review`: 2026-11-08
- `update_trigger`: Re-check when changing repository-wide instruction loading, adding nested instruction files, or adding support for a new AGENTS-aware client.

### Agent Skills open standard

- Sources:
  - <https://agentskills.io/>
  - <https://agentskills.io/specification>
  - <https://agentskills.io/skill-creation/quickstart>
  - <https://agentskills.io/skill-creation/best-practices>
  - <https://agentskills.io/skill-creation/optimizing-descriptions>
  - <https://agentskills.io/skill-creation/evaluating-skills>
  - <https://agentskills.io/skill-creation/using-scripts>
  - <https://agentskills.io/llms.txt>
  - <https://learn.chatgpt.com/docs/build-skills>
  - <https://code.claude.com/docs/en/skills>
- Verified guidance:
  - A skill is a directory containing `SKILL.md`.
  - Required frontmatter is `name` and `description`; folder name should match `name`.
  - Skill names should be lowercase alphanumeric with single hyphen separators and no leading/trailing/consecutive hyphens.
  - Descriptions are the activation surface; keep them concrete, trigger-oriented, and under 1024 characters.
  - Skills use progressive disclosure: metadata is listed first, `SKILL.md` loads on demand, and supporting files load only when needed.
  - Codex starts with skill name, description, and file path; full `SKILL.md` loads only when the skill is selected, and many installed skills can cause descriptions to be shortened or omitted from the initial list.
  - Keep each skill focused on one job, write imperative steps with explicit inputs/outputs, and test prompts against the description to confirm trigger behavior.
  - Supporting files keep `SKILL.md` focused while detailed references, examples, or scripts load only when needed.
  - Scripts should be non-interactive, support `--help`, emit actionable errors, and keep output bounded.
- `last_checked`: 2026-07-10
- `next_review`: 2026-10-10
- `update_trigger`: Re-check before changing `SKILL.md` frontmatter shape, skill directory layout, script expectations, or skill activation descriptions.

### Code review agent design (Augment, Claude Code, OpenAI Codex, Qodo)

- Sources:
  - <https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent>
  - <https://code.claude.com/docs/en/best-practices>
  - <https://www.anthropic.com/engineering/writing-tools-for-agents>
  - <https://developers.openai.com/blog/custom-code-review-rules-for-codex>
  - <https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/pr_reviewer_prompts.toml>
- Verified guidance:
  - A review system prompt's primary tuning knob is the precision/recall tradeoff; pick high signal-to-noise explicitly, name the comment categories to avoid, and outline the review workflow steps (Augment).
  - Keep the tool set small and non-overlapping; inject large inputs such as the diff deterministically instead of letting the agent re-retrieve them through tools (Augment, Anthropic).
  - Tool descriptions are prompt engineering: unambiguous parameter names, usage constraints, and error/truncation messages that steer token-efficient next steps measurably improve tool use (Anthropic).
  - A reviewer asked to find problems tends to report some even when the work is sound; instruct it to flag only defects that affect correctness or stated requirements and treat the rest as optional (Claude Code best practices).
  - Repository review rules live in `AGENTS.md`, scoped root vs. nested, written as a consequential invariant plus a safe path, and cited in findings; evaluate rule-guided review on coverage, restraint, retention, and actionability (OpenAI Codex; rule-guided variants recovered 98% of required custom findings vs. 58.3% baseline).
  - Diff hunks ending at an opening brace are a visible scope boundary, not incomplete code; do not question elements that may be defined elsewhere or suggest functionality that may already exist without reading the source; an empty findings list is acceptable (Qodo PR-Agent prompt).
- `last_checked`: 2026-08-08
- `next_review`: 2026-11-08
- `update_trigger`: Re-check before changing the default review system prompt, `buildJsonToolContract()`, MCP tool descriptions, or the review eval fixtures.

### Karpathy-inspired coding-agent behavior

- Sources:
  - <https://x.com/karpathy/status/2015883857489522876>
  - <https://github.com/multica-ai/andrej-karpathy-skills>
  - <https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md>
  - <https://github.com/multica-ai/andrej-karpathy-skills/blob/main/README.zh.md>
- Verified guidance:
  - Common coding-agent failure modes include hidden assumptions, overbuilt APIs, drive-by edits, and completion claims without concrete success criteria.
  - Useful mitigations are to surface assumptions, choose the simplest sufficient implementation, keep edits surgical, and turn work into verifiable goals.
  - The reference repository packages the same behavioral guidance as a thin root instruction, Cursor rule, Claude plugin, and Agent Skill; this repository keeps one canonical tool-neutral source in `AGENTS.md` plus `.agents/skills/` instead of copying tool-private prompt bodies.
- `last_checked`: 2026-05-28
- `next_review`: 2026-08-28
- `update_trigger`: Re-check when changing broad agent behavior guardrails, adding tool-specific behavioral bridges, or adopting a new external behavioral-guidance source.

### VS Code Copilot customization

- Sources:
  - <https://code.visualstudio.com/docs/copilot/customization/custom-instructions>
  - <https://code.visualstudio.com/docs/copilot/customization/agent-skills>
  - <https://code.visualstudio.com/docs/copilot/customization/custom-agents>
  - <https://code.visualstudio.com/docs/copilot/customization/prompt-files>
- Verified guidance:
  - VS Code supports repository instructions, path-scoped `.instructions.md`, prompt files, custom agents, and Agent Skills.
  - Agent Skills are appropriate for portable, reusable workflows; prompt files are better for manually invoked one-off or repeatable prompts.
  - Instructions should be concise, non-obvious, and scoped to the places where they apply.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check when adding `.github/instructions/*.instructions.md`, `.prompt.md`, `.agent.md`, or VS Code-specific skill placement.

### Claude Code

- Sources:
  - <https://code.claude.com/docs/en/skills>
  - <https://code.claude.com/docs/en/memory>
  - <https://code.claude.com/docs/en/cli-reference>
  - <https://code.claude.com/docs/en/env-vars>
  - <https://code.claude.com/llms.txt>
  - <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- Verified guidance:
  - Claude Code reads `CLAUDE.md`; a thin `@AGENTS.md` bridge is an official compatibility pattern.
  - Claude Code Skills follow the Agent Skills model and load on demand.
  - Skill descriptions need natural trigger keywords; supporting files are appropriate for large references and examples so `SKILL.md` stays focused.
  - Large `CLAUDE.md` files should be split or trimmed; duplicate global prompt bodies increase context cost and drift risk.
  - Headless automation uses print mode: `claude -p` with the prompt as an argument or piped via stdin, `--output-format text|json|stream-json` (json emits a result envelope with `result`, `is_error`, `session_id`, `num_turns`, `total_cost_usd`, and `usage.{input,output,cache_read,cache_creation}_tokens`), `--model`, `--effort low|medium|high|xhigh|max`, `--max-turns`, `--max-budget-usd`, `--fallback-model`, `--add-dir`, `--append-system-prompt-file`, `--allowedTools`/`--disallowedTools`, `--permission-mode`/`--dangerously-skip-permissions` (sandboxed environments only), and `--mcp-config` (JSON string or file path) with `--strict-mcp-config` for MCP isolation. `--timeout`, `--cwd`, and `--thinking` are not general session flags.
  - Built-in `WebSearch`/`WebFetch` tools are permission-ruled (`--allowedTools`/`--disallowedTools WebSearch`, settings `permissions.allow/deny`; deny rules outrank permission-mode auto-allowing, verified against code.claude.com/docs/en/tools 2026-08-27). The search engine is Anthropic's own backend — no provider/credential surface.
  - Environment surface includes `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_BETAS` (comma-separated beta headers), `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (assumed context window override, useful for gateway/custom model IDs), `MAX_THINKING_TOKENS` (fixed thinking budget; ignored on adaptive-reasoning models unless `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`), `DISABLE_AUTO_COMPACT`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` (skips print-mode title generation). `ANTHROPIC_VERSION`, `ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_THINKING_BUDGET_TOKENS`, and `ANTHROPIC_BETA` do not exist in the Claude Code environment surface.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-08
- `update_trigger`: Re-check when changing `CLAUDE.md`, adding `.claude/` assets, changing the claude-code adapter command line or env translation, or relying on Claude-specific frontmatter or plugin behavior.

### Kilo Code and Zoo Code

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
- Verified guidance:
  - Kilo Code supports repository-level instruction files and Agent Skills-compatible workflows.
  - `kilo.json` (project `.kilo/kilo.json` or root) supports the top-level `instructions` glob array for additional instruction files, `skills.paths` for extra Agent Skills discovery directories (layout `skills/<name>/SKILL.md`), and the `mcp` section (`{ "type": "local", "command": [...] }` / `{ "type": "remote", "url": "..." }`); MCP tool permission keys are `{server}_{tool}` with glob support.
  - Built-in web search (verified in v7.2.40 source, cross-checked on master 7.5.5): the `websearch` tool calls the Exa hosted MCP (`https://mcp.exa.ai/mcp`; `EXA_API_KEY` switches to keyed usage, `tool/mcp-exa.ts`) and is only offered to the model for the `kilo` provider or when the `KILO_ENABLE_EXA` runtime flag is truthy (`tool/registry.ts`: `providerID === ProviderID.kilo || Flag.KILO_ENABLE_EXA`; flag.ts: `KILO_ENABLE_EXA || KILO_EXPERIMENTAL || KILO_EXPERIMENTAL_EXA`) — custom OpenAI-compatible providers therefore need the `KILO_ENABLE_EXA=1` activation env. The off switch is `kilo.json` `permission.websearch: "allow" | "deny" | "ask"` (explicit key in `config/permission.ts`); a config deny outranks `--auto` auto-approval and also strips the tool from the model toolset (`Permission.disabled` in `session/llm.ts`). Master adds a `web_search: true` config bypass, a `KILO_ENABLE_PARALLEL` flag, and `KILO_WEBSEARCH_PROVIDER=exa|parallel|kilo-exa` routing (`tool/mcp-websearch.ts`); v7.2.40 (the version pinned in `deploy/Dockerfile`) is Exa-only. Zoo Code (pinned `8d4ed32f`) has no built-in web search tool — only an open proposal (#1280) to bundle a default-disabled Exa MCP endpoint.
  - Kilo CLI v7.2.40 JSON run mode emits `step_finish` with the completed `step-finish` part. Each part is built from one model `finish-step` usage, with non-cached input, output excluding reasoning, reasoning, and cache read/write as disjoint counters; sum the events within a CLI run. AICR additionally sums every initial, repair, and direct-fallback completion across the whole review run.
  - Zoo Code is the maintained VS Code extension published as `ZooCodeOrganization.zoo-code`; official migration guidance imports an exported settings file from the older tool into Zoo Code.
  - Upstream Zoo Code source at `8d4ed32f0606a4c7f45aac959540508aeac0b0e2` currently keeps compatibility names: CLI program/bin is `roo`, user CLI config dir is `~/.roo`, and project rule/mode files use `.roomodes` plus `.roo/rules-*`. Do not invent `.zoo` paths or a `zoo` binary without re-checking upstream.
  - Keep shared instructions in the canonical repository layer and add tool-specific files only for narrow, necessary deltas.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-08
- `update_trigger`: Re-check before changing the pinned Kilo CLI version or JSON-stream parser, the `zoo` adapter kind, Zoo CLI binary, `.roo`/`.roomodes` compatibility paths, `.kilo`/`.kilocode` path rules, kilo.json `instructions`/`skills.paths`/`mcp` wiring, adapter-native skill materialization, or the websearch permission/activation mapping (`KILO_ENABLE_EXA`, `permission.websearch`).

### Windsurf

- Sources:
  - <https://docs.windsurf.com/windsurf/cascade/agents-md>
  - <https://docs.windsurf.com/windsurf/cascade/memories>
  - <https://docs.windsurf.com/windsurf/cascade/skills>
  - <https://docs.windsurf.com/llms.txt>
- Verified guidance:
  - Windsurf supports `AGENTS.md`-style project instructions and Cascade skills.
  - Rules/memories/skills are distinct surfaces; use skills for reusable multi-step procedures, not broad prompt dumps.
  - The docs index confirms dedicated pages for AGENTS.md, memories/rules, MCP, skills, and workflows.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check when adding Windsurf-specific rules, memories, workflows, or skill path assumptions.

### OpenCode

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
- Verified guidance:
  - OpenCode supports project and global skills, including `.opencode/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, and `.agents/skills/<name>/SKILL.md`.
  - OpenCode skill frontmatter recognizes `name` and `description` as required fields; unknown fields are ignored; skill directory names must match `^[a-z0-9]+(-[a-z0-9]+)*$` and the frontmatter `name`.
  - Skill access can be controlled by OpenCode permissions (`permission.skill` patterns in `opencode.json`), but this repository should not commit `opencode.json` unless a real tool-specific policy is needed.
  - Non-interactive runs use `opencode run [message..]` with `--model`/`-m` in `provider/model` form, `--agent`, `--dir`, `--format default|json`, `--variant`, `--auto`, and session flags. JSON output is NDJSON with part-wrapped `text`/`tool_use` events and `step_finish` usage events. `--cwd` and `--timeout` are not `run` flags; stdin is accepted when no positional message is supplied.
  - The project config file is `opencode.json` in the working-directory root (global: `~/.config/opencode/opencode.json`); `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and `OPENCODE_CONFIG_CONTENT` environment overrides exist. AICR relies on project discovery through the same sandbox cwd/`--dir` instead of setting `OPENCODE_CONFIG` to a host-only absolute path. The schema uses a `provider` object keyed by provider ID, nests models under each provider, nests transport/auth under provider `options` and request parameters under model `options`, and uses `{env:NAME}` interpolation.
  - MCP servers are configured via the config `mcp` section: local servers `{ "type": "local", "command": [...], "enabled": true, "environment": {...} }`, remote servers `{ "type": "remote", "url": "..." }`; per-tool enable/disable is supported.
  - Built-in web tools (verified 2026-08-27 against opencode.ai/docs/tools and anomalyco/opencode `tool/websearch.ts`): `webfetch` (URL fetch) and `websearch` (Exa or Parallel hosted MCP backend). `websearch` is active with the OpenCode provider or a truthy `OPENCODE_ENABLE_EXA`/`OPENCODE_ENABLE_PARALLEL` env; `OPENCODE_WEBSEARCH_PROVIDER` explicitly selects `exa` or `parallel`, and `permission.webfetch`/`permission.websearch` (`allow`/`deny`/`ask`) in `opencode.json` gates access. Credentials: `EXA_API_KEY` switches Exa to keyed usage (`https://mcp.exa.ai/mcp?exaApiKey=...`), `PARALLEL_API_KEY` sends `Authorization: Bearer` to Parallel; keyless anonymous fallback exists.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-09
- `update_trigger`: Re-check when adding OpenCode agents, permissions, `.opencode/skills`, or `opencode.json` bridges, and before changing the opencode adapter command line or config materialization.

### GitHub Copilot CLI

- Sources:
  - <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
  - <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview>
  - <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills>
- Verified guidance:
  - The current CLI is the `copilot` binary; the legacy `gh copilot suggest` extension is deprecated and must not be targeted.
  - Programmatic mode runs `copilot --prompt <text>` (exits after completion); `--silent` prints only the agent response, `--no-ask-user` disables the interactive question tool, `--allow-all-tools` is documented as required for programmatic use, and `--allow-all`/`--yolo` bundles tools+paths+URLs while `--allow-all-tools`/`--allow-all-paths` stay granular.
  - Model selection uses `--model=<id>` or `COPILOT_MODEL`; reasoning effort uses `--effort low|medium|high|xhigh|max`; structured output uses `--output-format text|json` (json = JSONL events).
  - Headless auth checks `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`; classic PATs are unsupported.
  - MCP servers merge with this precedence: `--additional-mcp-config` inline JSON (highest), plugin-provided, workspace `.mcp.json`/`.github/mcp.json`, then `~/.copilot/mcp-config.json`; local servers use `{ "type": "local", "command": ..., "args": [...], "tools": [...] }`.
  - Repository custom instructions (`.github/copilot-instructions.md`, `.github/instructions/**`, `AGENTS.md`) load by default (`--no-custom-instructions` disables); project skills live in `.github/skills/`, `.claude/skills/`, or `.agents/skills/<name>/SKILL.md`; history auto-compacts near 95% of the token limit.
  - Built-in web tools (verified 2026-08-27 against docs.github.com CLI reference + v1.0.80 `copilot help permissions`): native `web_search` and `web_fetch` tools ship in the binary (no MCP required). `--deny-tool` accepts only `kind(argument)` permission patterns (kinds: `shell`/`write`/`read`/`memory`/`url`/MCP server name — no web kind), and the URL layer (`--deny-url`) gates only shell and web-fetch traffic, NOT `web_search`; the documented way to remove the built-in web tools from the model's toolset is `--excluded-tools=web_search,web_fetch`. The search backend is the Copilot subscription — no provider/credential surface.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-08
- `update_trigger`: Re-check before changing the copilot-cli adapter command line, auth env mapping, MCP wiring, or skills materialization for Copilot CLI.

### pi (earendil-works)

- Sources:
  - <https://github.com/earendil-works/pi> (README with full CLI reference)
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/json.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/custom-provider.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/settings.md>
  - <https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/environment-variables.md>
- Verified guidance:
  - Headless machine output is `pi --mode json "<prompt>"` (positional prompt after `--` is the documented form; print mode additionally merges piped stdin, JSON mode stdin is not documented). Events are NDJSON: a `session` header, then `agent_start`/`turn_*`/`message_*`/`tool_execution_*`/`compaction_*`. Authoritative per-message usage is `message_end.message.usage` (`input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`/`cost.total`, disjoint counters); `message_update.usage` is a cumulative snapshot — never sum both.
  - Model selection: `--model provider/id[:thinking]`, `--thinking off|minimal|low|medium|high|xhigh|max`, `--api-key`. AICR reasoning efforts map 1:1 onto pi thinking levels.
  - Custom providers live in `$PI_CODING_AGENT_DIR/models.json` (`{providers:{<id>:{baseUrl, api, apiKey, headers?, authHeader?, models:[{id, name, reasoning, input, cost, contextWindow, maxTokens}]}}}`); `apiKey` interpolates `$ENV`/`${ENV}`/`!command`; `api` values include `openai-completions`, `anthropic-messages`, `google-generative-ai`, `azure-openai-responses`, `google-vertex`, `bedrock-converse-stream`. Model entries require `contextWindow`/`maxTokens`.
  - `PI_CODING_AGENT_DIR` redirects the whole config dir (models/settings/extensions/sessions); `PI_OFFLINE=1` disables update checks, package update checks, and install/update telemetry; `PI_TELEMETRY=0` opts out separately. `--no-session` keeps runs ephemeral.
  - Project `.pi/` resources and project `.agents/skills` are trust-gated; headless modes apply `defaultProjectTrust` (`ask`/`never` ignore) unless `--approve`/`-a` is passed. Context files (cwd/ancestor `AGENTS.md`/`CLAUDE.md`) load regardless of trust; `--no-context-files` disables.
  - pi ships **no built-in MCP client** by explicit design; the documented path is a TypeScript extension using `pi.registerTool({name, label, description, parameters (typebox), execute})`. Extensions under `$PI_CODING_AGENT_DIR/extensions/` are user-level (no project trust needed), are transpiled by jiti, and may import `typebox` and node builtins. Extension factories can run without a session and therefore must not start long-lived resources; the AICR bridge registers handlers in the factory, starts/awaits MCP discovery from `session_start` before the first turn, and stops child processes on `session_shutdown`. `Type.Unsafe(rawJsonSchema)` passes MCP `inputSchema` through unchanged.
  - pi also discovers user-level `~/.agents/skills/`, which `PI_CODING_AGENT_DIR` does not redirect; on the native sandbox this can leak host user skills into a run (container sandboxes are unaffected).
- `last_checked`: 2026-08-26
- `next_review`: 2026-11-26
- `update_trigger`: Re-check before changing the pi adapter command line, the generated MCP bridge extension, `models.json`/`settings.json` materialization, or the `--approve` trust decision.

### oh-my-pi (omp)

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
- Verified guidance:
  - omp is a pi fork; headless machine output is `omp -p --mode json "<prompt>"` with the same NDJSON event family and the same `message_end.message.usage` shape, so one extractor serves both adapters.
  - Launch flags: `--model <provider/id[:level]>`, `--thinking off|minimal|low|medium|high|xhigh|max|auto`, `--auto-approve`, `--no-session`, `--cwd`, `--config <file>` (repeatable), `--no-skills`/`--no-rules`/`--no-extensions`.
  - `PI_CODING_AGENT_DIR` redirects the default profile's agent dir (`config.yml`, `models.yml`, `mcp.json`, sessions); `PI_CONFIG_FILES` overlays extra config files. `models.yml` has only a top-level `providers:` map (unknown root keys fail validation); `apiKey` resolves as an env-var name first, then as a literal; `auth: none` marks keyless providers; model entries accept `contextWindow`/`maxTokens`/`cost`/`reasoning`/`input`.
  - Native MCP: user-level `$PI_CODING_AGENT_DIR/mcp.json` or project `.omp/mcp.json`, `{mcpServers:{<name>:{command, args?, env?}}}` for stdio (default) and `{type:"http"|"sse", url, headers?}` for remote; `${VAR}` expansion at discovery and env-name indirection at connect. MCP tools are exposed as `mcp__<server>_<tool>` with components lowercased and sanitized to letters/underscores — the AICR `<prefix>_aicr_<tool>` normalization rule matches these names unchanged. Headless sessions await full MCP discovery before startup.
  - Compaction settings: `compaction.enabled` (true), `compaction.thresholdPercent` (-1 = reserve-based auto), `compaction.keepRecentTokens`, `compaction.methodOrder` and more; AICR injects `enabled` and `thresholdPercent` only.
  - Skills: native providers include `.omp/skills/` and the `agents` provider for `.agents/skills/<name>/SKILL.md` (user and project), matching the canonical AICR bundle layout without copies.
  - Web search settings (verified with `omp config list` on 18.0.6): the built-in `web_search` tool is gated by `web_search.enabled` (**default true**; credential-free scrapers duckduckgo/startpage work with no configuration); the provider chain is controlled by `providers.webSearchOrder` / `providers.webSearchExclude` (unknown ids ignored) and `providers.webSearchTimeoutSeconds` (default 60, capped 300); self-hosted SearXNG uses `searxng.{endpoint,token,basicUsername,basicPassword,categories,engines,language,safesearch}`. Credential env names verified in `docs/tools/web_search.md`, `docs/environment-variables.md`, and a binary string scan: `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `JINA_API_KEY`, `KAGI_API_KEY`, `PARALLEL_API_KEY`, `KIMI_SEARCH_API_KEY` / `MOONSHOT_SEARCH_API_KEY`, `PERPLEXITY_API_KEY`, `ZAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_SEARCH_API_KEY` (search-only, independent of chat auth), `TINYFISH_API_KEY`, `FIRECRAWL_API_KEY`, `SEARXNG_ENDPOINT` / `SEARXNG_TOKEN` / `SEARXNG_BASIC_USERNAME` / `SEARXNG_BASIC_PASSWORD`. OAuth-stored providers (perplexity/gemini/codex OAuth in `agent.db`) cannot authenticate when `PI_CODING_AGENT_DIR` is an ephemeral per-run directory.
  - Empirically verified with omp 18.0.6 on WSL (native sandbox, 2026-08-27): the `xd://` hashline surface routes MCP tool calls — model turns emit `tool_execution_start` with `toolName: "write"` and `args.path: "xd://mcp__aicr_output_<tool>"`, plus a `notice` event listing the mounted `mcp__aicr_output_*` tools at session start; there is no `tool_execution_start` whose `toolName` is the raw MCP tool name. Stream-level `toolCallEvents` therefore stay empty and the MCP state file stays authoritative. `message_end.message.usage` counters (`input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`, `output` includes `reasoningTokens`) are disjoint and sum exactly to `totalTokens`.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-26
- `update_trigger`: Re-check before changing the omp adapter command line, `models.yml`/`config.yml`/`mcp.json` materialization, the MCP tool-name normalization rule, or the web-search settings/credential env mapping (`web_search.enabled` default, provider id list, `TAVILY_API_KEY`-style env names, or the `agent.web_search` schema in `packages/core/src/config.ts`).

### Model Context Protocol

- Sources:
  - <https://modelcontextprotocol.io/docs/getting-started/intro>
  - <https://modelcontextprotocol.io/docs/learn/architecture>
  - <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
  - <https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>
  - <https://modelcontextprotocol.io/llms.txt>
- Verified guidance:
  - MCP uses host/client/server architecture over JSON-RPC and standardizes tools, resources, prompts, and related capabilities.
  - Tool metadata includes name, description, input schema, and result contracts; clients should expose only appropriate tools.
  - Security guidance emphasizes input validation, output sanitization, least privilege, scoped tokens, audit logs, timeouts, rate limits, and human approval for sensitive operations.
- `last_checked`: 2026-05-18
- `next_review`: 2026-08-18
- `update_trigger`: Re-check when changing AICR MCP tool schemas, adding external MCP servers, changing authorization, or adopting a new MCP protocol version.

### OpenClaw and ClawHub

- Sources:
  - <https://docs.openclaw.ai/llms.txt>
  - <https://docs.openclaw.ai/concepts/agent-workspace.md>
  - <https://docs.openclaw.ai/gateway/config-agents.md>
  - <https://docs.openclaw.ai/tools/skills>
  - <https://docs.openclaw.ai/plugins/skill-workshop.md>
  - <https://docs.openclaw.ai/clawhub/index.md>
  - <https://docs.openclaw.ai/clawhub/skill-format.md>
  - <https://docs.openclaw.ai/clawhub/http-api.md>
  - <https://docs.openclaw.ai/clawhub/cli.md>
  - <https://docs.openclaw.ai/clawhub/acceptable-usage.md>
- Verified guidance:
  - OpenClaw loads AgentSkills-compatible folders and includes `.agents/skills` in its skill precedence model.
  - Workspace/bootstrap files, managed config, credentials, sessions, and skill stores have separate trust and version-control expectations.
  - Skill Workshop is experimental and disabled by default; automatic skill writes should start in pending approval mode and are inappropriate for hostile or shared input-heavy workspaces.
  - ClawHub exposes registry APIs with rate limits, moderation state, scan/trust fields, and explicit install-block signals; clients should honor `Retry-After` and version-exact security endpoints.
  - Skill publishing requires accurate metadata for environment variables, binaries, platform requirements, and install behavior.
- `last_checked`: 2026-05-18
- `next_review`: 2026-06-18
- `update_trigger`: Re-check when relying on OpenClaw workspace bootstrap, skill precedence, ClawHub security metadata, skill publishing, or OpenClaw runtime compatibility.

### Hermes Agent

- Sources:
  - <https://github.com/NousResearch/hermes-agent>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/curator>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>
- Verified guidance:
  - Hermes supports project context files including `AGENTS.md` and can scan external skill directories such as `~/.agents/skills/`.
  - Hermes skills are compatible with the Agent Skills standard and use progressive disclosure.
  - Hermes distinguishes memory/facts from skills/procedures; agent-managed skill creation and curator maintenance have separate safety and provenance rules.
  - Hermes MCP config supports local stdio and remote HTTP servers, per-server filtering, tool prefixing, explicit environment passing, and rate/timeout controls for sampling.
- `last_checked`: 2026-05-18
- `next_review`: 2026-06-18
- `update_trigger`: Re-check when adding Hermes-specific context assumptions, external skill directory guidance, MCP integration, or auto skill-management behavior.

### Google Antigravity

- Sources:
  - <https://antigravity.google/docs/home>
  - <https://antigravity.google/docs/rules-workflows>
  - <https://antigravity.google/docs/skills>
  - <https://antigravity.google/docs/mcp>
  - <https://antigravity.google/docs/knowledge>
- Verified guidance:
  - Antigravity supports workspace rules under `.agents/rules`, workflows as Markdown slash-command procedures, and skills under `.agents/skills/<skill-folder>/`.
  - Antigravity skills follow the open Agent Skills model: a folder with `SKILL.md`, progressive disclosure, clear descriptions, and optional scripts/resources.
  - Antigravity MCP configuration lives in user-local config and can disable individual tools; token files and account auth belong outside the repository.
  - Knowledge Items are Antigravity's persistent memory surface and should not be treated as committed repository prompt assets.
- `last_checked`: 2026-05-18
- `next_review`: 2026-06-18
- `update_trigger`: Re-check when adding Antigravity rules/workflows/skills, MCP setup guidance, or knowledge-memory assumptions.

### models.dev model metadata catalog

- Sources:
  - <https://models.dev/>
  - <https://github.com/anomalyco/models.dev>
  - <https://opencode.ai/docs/providers/>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/packages/types/src/provider-settings.ts>
- Verified guidance:
  - models.dev is an open-source (MIT) database of AI model specs/pricing/capabilities, maintained by the SST team and used internally by opencode. Data is stored as TOML and built to JSON.
  - HTTP API: `https://models.dev/api.json` (provider + serving view, keyed `<providerId>` → `models.<modelId>`), `https://models.dev/models.json` (provider-agnostic model facts), `https://models.dev/catalog.json` (both), `https://models.dev/logos/{provider}.svg`. Model IDs match the AI SDK identifiers.
  - Per-model fields include `name`, `family`, `attachment`, `reasoning`, `tool_call`, `structured_output`, `temperature`, `knowledge`, `release_date`, `last_updated`, `open_weights`, `license`, `links`, `weights`, `benchmarks`, `interleaved.field`, `cost.{input,output,reasoning,cache_read,cache_write,input_audio,output_audio}` (USD per **million** tokens), `limit.{context,input,output}`, `modalities.{input,output}`, and `status`. A stable search/web-search capability field was not verified in the current schema; treat search support as optional override-only until upstream documents it.
  - Cross-provider docs checked in this pass show additional capabilities that AICR should normalize when available or explicitly overridden: OpenAI exposes model tools such as functions, web search, file search, and computer use; Claude exposes max input/output tokens, capabilities objects, extended/adaptive thinking, provider-specific IDs and prompt caching; Gemini exposes function calling, Google Search grounding, URL context, file search, code execution, computer use, Live/audio, and model lifecycle labels; DeepSeek exposes thinking modes, JSON output, tool calls, cache-hit/cache-miss pricing, FIM/chat-prefix beta flags, and deprecated model aliases; GLM exposes thinking modes, function call, context caching, structured output, 128K/96K limits, and text modality; Kimi exposes multimodal input, tool use, JSON/schema response formats, prompt cache keys, thinking retention, and high-speed variants.
  - Tool compatibility for config translation: opencode resolves known providers from models.dev automatically. Custom `@ai-sdk/openai-compatible` providers require models under `provider.<provider-id>.models.<model-id>`; schema-valid manual entries use complete `limit.context`/`limit.output` and `cost.input`/`cost.output` pairs, plus supported attachment/reasoning/temperature/tool-call/interleaved/modality metadata. Zoo Code and Kilo Code do not have a verified native models.dev ingestion surface for custom OpenAI-compatible providers in the checked sources; AICR injects their native model-info fields. Claude Code and Copilot CLI rely on their own built-in model catalogs.
- `last_checked`: 2026-08-09
- `next_review`: 2026-11-09
- `update_trigger`: Re-check before changing the model-catalog fetch URL, the api.json field mapping into `ModelSpec`, the per-tool config-injection strategy, or the build-time fallback snapshot source.

### Modern CLI tool availability and release artifacts

- Sources:
  - <https://packages.ubuntu.com/> (suite `noble` package searches; pre-trixie baseline)
  - Live `apt-cache policy` / `apt-cache show` inside `debian:trixie-slim` via WSL podman (2026-09-03; default `debian.sources` deb822, `Components: main` only)
  - <https://package.perforce.com/apt/ubuntu/dists/> (directory listing)
  - GitHub Releases API `repos/<owner>/<repo>/releases/latest` for `bootandy/dust`, `XAMPPRocky/tokei`, `ducaale/xh`, `mr-karan/doggo`, `01mf02/jaq`, `Wilfred/difftastic`, `ouch-org/ouch`, `dalance/procs`, `watchexec/watchexec`, `bensadeh/tailspin`, `solidiquis/erdtree`, `dathere/qsv`
- Verified guidance:
  - Debian 13 (trixie) apt with `Components: main` only carries every runtime apt package in `deploy/Dockerfile` (zero missing in the live container check), including `ripgrep` 14.1.1, `fd-find` 10.2.0, `bat` 0.25.0, `sd` 1.0.0, `eza` 0.21.0, `duf` 0.8.1, `hyperfine` 1.19.0, `hexyl` 0.8.0, `miller` 6.13.0, `git-delta` 0.18.2, `lnav` 0.12.4, `ugrep` 7.4.2, `fzf` 0.60.3, `universal-ctags`, `podman`/`buildah`/`skopeo`. Trixie newly packages `du-dust` 1.2.0, `tokei` 12.1.2, `xh` 0.24.0, `procs` 0.14.10, `tailspin` 5.4.2, and `plocate` 1.1.23 (Ubuntu 24.04 noble had none of these); it still lacks `doggo`, `jaq`, `qsv`, `ouch`, `difftastic`, `watchexec`, and `erdtree`.
  - The image keeps pinned static builds for `dust` (v1.2.5 > trixie 1.2.0), `xh` (v0.26.2 > 0.24.0), `procs` (v0.14.12 > 0.14.10), and `tailspin` (7.0.0 > 5.4.2) because the pinned versions are newer and reproducible across arches.
  - Pinned static-binary releases and archive layouts verified against live artifacts: `dust` v1.2.5, `xh` v0.26.2, `doggo` v1.4.0 (root binary), `jaq` v3.1.1 (raw binary; aarch64 is gnu-only), `difftastic` 0.70.0 (root `difft`; aarch64 is gnu-only; ~120 MB uncompressed), `ouch` 0.8.2 (no `v` tag prefix), `procs` v0.14.12 (zip, root binary), `watchexec` v2.7.0 (asset names strip the `v`), `tailspin` 7.0.0 (no `v` prefix; binary is `tspin`), `erdtree` v3.1.2 (root `erd`).
  - `tokei` publishes no release binaries since v13.0.0 (v13.0.0/v14.0.0 have zero assets; last binaries at v12.1.2) and trixie apt carries only that stale 12.1.2; `qsv` 22.0.1 musl zip is ~104 MB compressed. Both are excluded from the runtime image along with `plocate` (no `updatedb` index in containers).
  - Perforce's APT repo publishes only Ubuntu codename dists (`bionic`, `focal`, `jammy`, `noble`, `precise`, `trusty`, `xenial` — verified 2026-09-03); there is no Debian dist, so `PERFORCE_APT_DISTRO` stays an Ubuntu codename (`noble`) on the Debian trixie base and the noble `p4-cli` build (glibc 2.39) runs on trixie's glibc 2.41.
  - Tencent mirror endpoints verified absent for Helm apt, yq, and GitHub releases; GitHub release downloads accept a URL prefix override (`GH_RELEASE_PREFIX`) for ghproxy-style mirrors or internal caches. For Debian apt, China mirrors share the layout `<root>/debian` + `<root>/debian-security` (USTC, TUNA, Aliyun, Tencent), so the Dockerfile derives the security entries by appending `-security` to `APT_MIRROR`.
- `last_checked`: 2026-09-03
- `next_review`: 2026-12-03
- `update_trigger`: Re-check when bumping the pinned `*_VERSION` args in `deploy/Dockerfile`, when the distro base changes, or when adding/removing a tool in the runtime image baseline.

### PowerShell 7+ behavior for Windows shell work

- Sources:
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh>
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules>
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing>
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables>
  - Empirical probes on 2026-09-03 against PowerShell 7.6.5 and Windows PowerShell 5.1 on the maintainer host.
- Verified guidance:
  - Edition differences visible to agents (all verified live): 5.1 rejects `&&`/`||` at parse time (whole script fails), aliases `curl`/`wget` to `Invoke-WebRequest`, defaults redirection/`Out-File` to UTF-16LE, and has no `$PSNativeCommandArgumentPassing` (always Legacy). 7.6.5 resolves `curl` to `curl.exe`, has no `wget` alias, defaults `$PSNativeCommandArgumentPassing` to `Windows`, and writes UTF-8 without BOM.
  - `pwsh -Command` collapses a native command's non-zero exit code to `1` unless the command text ends with `exit $LASTEXITCODE` (verified: `cmd /c exit 7` yields outer `$LASTEXITCODE` 1 without the explicit exit, 9 with `exit 9` semantics).
  - `Select-String` returns `Microsoft.PowerShell.Commands.MatchInfo` objects (`.Line` holds the text); `ConvertTo-Json` truncates nesting past depth 2 with only a warning; `& { ... } | ...` pipes statement-block output.
  - `powershell.exe` on the maintainer host blocks unsigned scripts by execution policy (`UnauthorizedAccess`) while `pwsh.exe` 7.6.5 runs them; the `node`-direct CLI workaround in `AGENTS.md` is edition-independent and stays valid.
  - `where` resolves to the `Where-Object` alias (7.x verified); `find` resolves to `find.exe`; prefer full cmdlet names or modern tool binaries over short aliases.
  - Outer-shell `$` expansion inside double-quoted inline commands breaks inner PowerShell variables (observed live in this session); write probe scripts under `build/tmp/` instead of stacking quote layers.
- `last_checked`: 2026-09-03
- `next_review`: 2026-12-03
- `update_trigger`: Re-check when updating Windows shell guidance in `AGENTS.md` or `.agents/skills/modern-cli-toolkit/references/powershell-for-agents.md`, when the minimum supported PowerShell version changes, or when Microsoft revises `$PSNativeCommandArgumentPassing` defaults.

## Repository decisions from this pass

- Keep `AGENTS.md` as the only always-on canonical repository instruction file.
- Keep `CLAUDE.md` as a thin bridge using `@AGENTS.md`; do not add a duplicated Claude prompt body.
- Keep `.agents/skills/` as the canonical skill source and use `.agents/skills/README.md` only as a compact index.
- Do not add `.github/copilot-instructions.md`, `.claude/`, Zoo Code `.roo/`, `.kilo/`, `.opencode/`, `.agents/rules/`, `.pi/`, `.omp/`, or other tool-private files unless a future task has a concrete tool-specific need.
- pi and oh-my-pi adapters never persist provider secrets: models.json uses `$ENV` interpolation, models.yml uses env-name-first `apiKey`; the orchestrator injects `PI_CODING_AGENT_DIR` with the sandbox-visible path, and pi receives its MCP bridge spec via `AICR_PI_MCP_SERVERS` instead of baked-in paths.
- pi/omp v1 supports the verified provider kinds (`openai_compatible`, `ollama`, `anthropic`, `google_ai_studio`); other provider kinds fail visibly with guidance instead of guessing unverified auth plumbing.
- Treat MCP and skill marketplace integrations as security-sensitive surfaces: record sources, use allowlists, keep secrets out of committed files, and prefer dry-run or pending-review flows for automated writes.

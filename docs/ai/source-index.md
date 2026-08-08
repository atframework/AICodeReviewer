# AI Source Index

This file records verified external sources for repository AI-agent guidance, Agent Skills, MCP, and cross-tool compatibility. It is an evidence index, not a prompt body: keep it concise, cite sources, and avoid copying large external documentation into always-on files.

## How to use this index

- Check this file before adding or changing compatibility claims in `AGENTS.md`, `CLAUDE.md`, `.agents/skills/`, or tool-specific bridge files.
- If a source is missing, unavailable, or ambiguous, mark the claim as unverified instead of guessing.
- Refresh the relevant source row when external docs change, when a tool adds a new rules/skills surface, or when a repository change depends on updated compatibility behavior.
- Prefer canonical cross-tool files (`AGENTS.md`, `.agents/skills/<name>/SKILL.md`) over committed duplicates in tool-private directories.

## Last research pass

- `last_checked`: 2026-08-09
- Scope: agent framework/adapter surface refresh — Claude Code CLI reference + env-vars doc, OpenCode CLI/config/provider/model/MCP/skills docs and config schema, GitHub Copilot CLI command reference + skills/instructions docs, Kilo `kilo.json` configuration reference; verified every adapter flag/env/config path against current upstream docs instead of memory.
- Result: `claude-code` uses headless print mode (`-p --output-format json`) and documented flags/env; `opencode` uses `--pure run --format json --auto --dir`, schema-valid project-root `opencode.json`, `provider/model` IDs, provider/model option nesting, and current `tool_use`/`step_finish` NDJSON envelopes; `copilot-cli` targets the current `copilot` programmatic CLI. Runtime bundles expose one active combined `AGENTS.md` instruction surface, canonical Agent Skills paths, native MCP wiring, and explicit `nativeSurfaces` manifest entries; source instruction copies remain audit-only. Orchestrator extracts real usage/cost and pins `AICR_OUTPUT_STATE_PATH`. The default review prompt now keeps findings-only restraint in one compact output-discipline section instead of repeating no-problem prose across sections.

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
  - Environment surface includes `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_BETAS` (comma-separated beta headers), `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (assumed context window override, useful for gateway/custom model IDs), `MAX_THINKING_TOKENS` (fixed thinking budget; ignored on adaptive-reasoning models unless `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`), `DISABLE_AUTO_COMPACT`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` (skips print-mode title generation). `ANTHROPIC_VERSION`, `ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_THINKING_BUDGET_TOKENS`, and `ANTHROPIC_BETA` do not exist in the Claude Code environment surface.
- `last_checked`: 2026-08-08
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
  - <https://docs.zoocode.dev/getting-started/installing>
  - <https://docs.zoocode.dev/roo-to-zoo-migration>
  - <https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/tree/8d4ed32f0606a4c7f45aac959540508aeac0b0e2>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/apps/cli/src/index.ts>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/apps/cli/src/lib/storage/config-dir.ts>
  - <https://github.com/Zoo-Code-Org/Zoo-Code/blob/8d4ed32f0606a4c7f45aac959540508aeac0b0e2/src/core/config/CustomModesManager.ts>
- Verified guidance:
  - Kilo Code supports repository-level instruction files and Agent Skills-compatible workflows.
  - `kilo.json` (project `.kilo/kilo.json` or root) supports the top-level `instructions` glob array for additional instruction files, `skills.paths` for extra Agent Skills discovery directories (layout `skills/<name>/SKILL.md`), and the `mcp` section (`{ "type": "local", "command": [...], "environment": {...} }` / `{ "type": "remote", "url": "..." }`); MCP tool permission keys are `{server}_{tool}` with glob support.
  - Kilo CLI v7.2.40 JSON run mode emits `step_finish` with the completed `step-finish` part. Each part is built from one model `finish-step` usage, with non-cached input, output excluding reasoning, reasoning, and cache read/write as disjoint counters; sum the events within a CLI run. AICR additionally sums every initial, repair, and direct-fallback completion across the whole review run.
  - Zoo Code is the maintained VS Code extension published as `ZooCodeOrganization.zoo-code`; official migration guidance imports an exported settings file from the older tool into Zoo Code.
  - Upstream Zoo Code source at `8d4ed32f0606a4c7f45aac959540508aeac0b0e2` currently keeps compatibility names: CLI program/bin is `roo`, user CLI config dir is `~/.roo`, and project rule/mode files use `.roomodes` plus `.roo/rules-*`. Do not invent `.zoo` paths or a `zoo` binary without re-checking upstream.
  - Keep shared instructions in the canonical repository layer and add tool-specific files only for narrow, necessary deltas.
- `last_checked`: 2026-08-08
- `next_review`: 2026-11-08
- `update_trigger`: Re-check before changing the pinned Kilo CLI version or JSON-stream parser, the `zoo` adapter kind, Zoo CLI binary, `.roo`/`.roomodes` compatibility paths, `.kilo`/`.kilocode` path rules, kilo.json `instructions`/`skills.paths`/`mcp` wiring, or adapter-native skill materialization.

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
- Verified guidance:
  - OpenCode supports project and global skills, including `.opencode/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, and `.agents/skills/<name>/SKILL.md`.
  - OpenCode skill frontmatter recognizes `name` and `description` as required fields; unknown fields are ignored; skill directory names must match `^[a-z0-9]+(-[a-z0-9]+)*$` and the frontmatter `name`.
  - Skill access can be controlled by OpenCode permissions (`permission.skill` patterns in `opencode.json`), but this repository should not commit `opencode.json` unless a real tool-specific policy is needed.
  - Non-interactive runs use `opencode run [message..]` with `--model`/`-m` in `provider/model` form, `--agent`, `--dir`, `--format default|json`, `--variant`, `--auto`, and session flags. JSON output is NDJSON with part-wrapped `text`/`tool_use` events and `step_finish` usage events. `--cwd` and `--timeout` are not `run` flags; stdin is accepted when no positional message is supplied.
  - The project config file is `opencode.json` in the working-directory root (global: `~/.config/opencode/opencode.json`); `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and `OPENCODE_CONFIG_CONTENT` environment overrides exist. AICR relies on project discovery through the same sandbox cwd/`--dir` instead of setting `OPENCODE_CONFIG` to a host-only absolute path. The schema uses a `provider` object keyed by provider ID, nests models under each provider, nests transport/auth under provider `options` and request parameters under model `options`, and uses `{env:NAME}` interpolation.
  - MCP servers are configured via the config `mcp` section: local servers `{ "type": "local", "command": [...], "enabled": true, "environment": {...} }`, remote servers `{ "type": "remote", "url": "..." }`; per-tool enable/disable is supported.
- `last_checked`: 2026-08-09
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
- `last_checked`: 2026-08-08
- `next_review`: 2026-11-08
- `update_trigger`: Re-check before changing the copilot-cli adapter command line, auth env mapping, MCP wiring, or skills materialization for Copilot CLI.

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

## Repository decisions from this pass

- Keep `AGENTS.md` as the only always-on canonical repository instruction file.
- Keep `CLAUDE.md` as a thin bridge using `@AGENTS.md`; do not add a duplicated Claude prompt body.
- Keep `.agents/skills/` as the canonical skill source and use `.agents/skills/README.md` only as a compact index.
- Do not add `.github/copilot-instructions.md`, `.claude/`, Zoo Code `.roo/`, `.kilo/`, `.opencode/`, `.agents/rules/`, or other tool-private files unless a future task has a concrete tool-specific need.
- Treat MCP and skill marketplace integrations as security-sensitive surfaces: record sources, use allowlists, keep secrets out of committed files, and prefer dry-run or pending-review flows for automated writes.

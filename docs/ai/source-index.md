# AI Source Index

This file records verified external sources for repository AI-agent guidance, Agent Skills, MCP, and cross-tool compatibility. It is an evidence index, not a prompt body: keep it concise, cite sources, and avoid copying large external documentation into always-on files.

## How to use this index

- Check this file before adding or changing compatibility claims in `AGENTS.md`, `CLAUDE.md`, `.agents/skills/`, or tool-specific bridge files.
- If a source is missing, unavailable, or ambiguous, mark the claim as unverified instead of guessing.
- Refresh the relevant source row when external docs change, when a tool adds a new rules/skills surface, or when a repository change depends on updated compatibility behavior.
- Prefer canonical cross-tool files (`AGENTS.md`, `.agents/skills/<name>/SKILL.md`) over committed duplicates in tool-private directories.

## Last research pass

- `last_checked`: 2026-05-18
- Scope: AGENTS.md, Agent Skills, VS Code Copilot customization, Claude Code, Kilo, Roo, Windsurf, OpenCode, OpenClaw, Hermes Agent, Google Antigravity, MCP, and skill registry/security guidance.
- Result: Existing repository strategy is aligned: `AGENTS.md` remains canonical, `CLAUDE.md` stays a thin bridge, and repeatable procedures live under `.agents/skills/`.

## Source records

### AGENTS.md standard

- Sources:
  - <https://agents.md/>
- Verified guidance:
  - `AGENTS.md` is a repository guide for coding agents, analogous to `README.md` for humans.
  - It should contain build/test commands, code style, project structure, security notes, and agent-specific conventions.
  - Nested `AGENTS.md` files can scope instructions to subtrees; user prompts still override repository files.
- `last_checked`: 2026-05-18
- `next_review`: 2026-08-18
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
- Verified guidance:
  - A skill is a directory containing `SKILL.md`.
  - Required frontmatter is `name` and `description`; folder name should match `name`.
  - Skill names should be lowercase alphanumeric with single hyphen separators and no leading/trailing/consecutive hyphens.
  - Descriptions are the activation surface; keep them concrete, trigger-oriented, and under 1024 characters.
  - Skills use progressive disclosure: metadata is listed first, `SKILL.md` loads on demand, and supporting files load only when needed.
  - Scripts should be non-interactive, support `--help`, emit actionable errors, and keep output bounded.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check before changing `SKILL.md` frontmatter shape, skill directory layout, script expectations, or skill activation descriptions.

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
  - <https://code.claude.com/llms.txt>
  - <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- Verified guidance:
  - Claude Code reads `CLAUDE.md`; a thin `@AGENTS.md` bridge is an official compatibility pattern.
  - Claude Code Skills follow the Agent Skills model and load on demand.
  - Large `CLAUDE.md` files should be split or trimmed; duplicate global prompt bodies increase context cost and drift risk.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check when changing `CLAUDE.md`, adding `.claude/` assets, or relying on Claude-specific frontmatter or plugin behavior.

### Kilo Code and Roo Code

- Sources:
  - <https://kilo.ai/docs/customize/agents-md>
  - <https://kilo.ai/docs/customize/skills>
  - <https://kilo.ai/docs/customize/custom-instructions>
  - <https://roocodeinc.github.io/Roo-Code/features/custom-instructions>
  - <https://roocodeinc.github.io/Roo-Code/features/skills>
- Verified guidance:
  - Both tools support repository-level instruction files and Agent Skills-compatible workflows.
  - Keep shared instructions in the canonical repository layer and add tool-specific files only for narrow, necessary deltas.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check before adding `.roo/`, `.kilo/`, `.kilocode/`, Kilo/Roo path rules, or adapter-native skill materialization.

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
- Verified guidance:
  - OpenCode supports project and global skills, including `.agents/skills/<name>/SKILL.md`.
  - OpenCode skill frontmatter recognizes `name` and `description` as required fields; unknown fields are ignored.
  - Skill access can be controlled by OpenCode permissions, but this repository should not commit `opencode.json` unless a real tool-specific policy is needed.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check when adding OpenCode agents, permissions, `.opencode/skills`, or `opencode.json` bridges.

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

## Repository decisions from this pass

- Keep `AGENTS.md` as the only always-on canonical repository instruction file.
- Keep `CLAUDE.md` as a thin bridge using `@AGENTS.md`; do not add a duplicated Claude prompt body.
- Keep `.agents/skills/` as the canonical skill source and use `.agents/skills/README.md` only as a compact index.
- Do not add `.github/copilot-instructions.md`, `.claude/`, `.roo/`, `.kilo/`, `.opencode/`, `.agents/rules/`, or other tool-private files unless a future task has a concrete tool-specific need.
- Treat MCP and skill marketplace integrations as security-sensitive surfaces: record sources, use allowlists, keep secrets out of committed files, and prefer dry-run or pending-review flows for automated writes.

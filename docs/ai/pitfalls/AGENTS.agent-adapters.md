# Agent Adapter Contracts

Read the section for the adapter/capability being changed. Current local source
is `packages/agents/src/` with matching tests. Refresh only that tool's external
record via [the source map](../source-index.md); old flags/versions are evidence
snapshots, not a current CLI specification.

## Shared translation

- Test generated config against the upstream schema and actual CLI, not only a
  plausible local fixture. Audit model config, native MCP, skills, instruction
  files, isolated environment and manifest together. Unsupported capabilities
  must degrade visibly; unknown required provider authentication must fail.
- Preserve model metadata units (USD per million tokens), explicit user overrides,
  and complete limit/cost pairs where required. Do not fabricate missing limits.
- Compaction flows config → bootstrap → bundle → adapter. A contextWindow is
  needed for model-based compaction, notably Kilo; keep catalog/override guidance
  and `AgentContextOverflowError`. Bootstrap derives default compression and
  prompt budgets from the resolved workspace model when not explicitly configured.

## Kilo, Zoo, OpenCode, Claude and Copilot

- Kilo: redirect XDG config/data to bundle-local sandbox-visible paths; host
  global config validation and stale session DBs can break otherwise valid runs.
  Provider keys use `{env:NAME}`. Keep native `kilo.json` MCP/compaction wiring.
- OpenCode: provider map keyed by ID, models nested beneath it, transport/auth
  under provider `options`, request parameters under model `options`, and
  `provider/model` CLI IDs. Discover root `opencode.json` via sandbox cwd/`--dir`;
  do not set a host-only `OPENCODE_CONFIG` in containers. Known providers can
  delegate catalog metadata; custom compatible providers need valid model entries.
- Zoo: retain verified `.roo` compatibility paths/binary until upstream changes
  them. Do not invent `.zoo` paths from the adapter name.
- Claude: verify print-mode flags and documented env names. Context/output limits,
  betas, and fixed-thinking budgets have distinct variables; invented Anthropic
  variables silently do nothing. Native MCP isolation is part of the contract.
- Copilot: use the standalone `copilot` CLI, not legacy `gh copilot suggest`.
  Verify programmatic mode, authentication, MCP flags, and tool exclusions.

## pi and oh-my-pi

- Task is positional after `--`; `buildStdin()` returns empty to avoid feeding
  it twice. The orchestrator injects sandbox-visible `PI_CODING_AGENT_DIR` and
  includes it in manifest env keys, never a host path in container config.
- pi uses `models.json` with `$ENV` key references; omp uses `models.yml` with
  env-name-first keys (`auth: none` for keyless). Both need contextWindow/maxTokens
  and an explicitly supported provider mapping. Never persist auth stores.
- pi MCP is a generated extension, not a fabricated config-file surface. Its
  factory registers hooks; discovery starts/awaits in `session_start`, cleanup
  runs in `session_shutdown`. Server specs come from `AICR_PI_MCP_SERVERS`;
  children receive minimal base env plus server env, not provider secrets from
  `process.env`. Keep the byte-bounded NDJSON buffer and fail/kill on overflow.
- pi's project skill trust gate needs the headless approval flag in the isolated
  bundle. Native execution may still discover host `~/.agents/skills`; container
  isolation is a separate guarantee. omp native MCP can appear as `xd://` writes;
  retain the authoritative MCP state path even when stream tool events are absent.
- Parse only completed assistant `message_end` usage, not cumulative
  `message_update`. Sum disjoint counters when total is absent; do not synthesize
  zero usage. Accept a timed-out pi-family process only when parsed terminal
  `agent_end` proves completion; otherwise retain timeout failure.

## Task transport and web search

- Single-argument task adapters declare `taskTransport: "argv"`. Keep the
  orchestrator's Windows full-command and Linux single-string safe budgets;
  oversized tasks go into `.aicr-task.md` after bundle creation, with a short
  sandbox-visible pointer. Remove stale task files each run and cap raw stdout
  and previous-output tails before repair. Stdin adapters stay on stdin.
- Auto-approval does not disable built-in web search. Disabled config must inject
  explicit native denies and no search credentials. Check config and spawn flags
  together (Claude/Copilot exclusions are command-line surfaces).
- Keep supported provider selection, activation flags and env-name indirection
  in adapter source; unsupported optional fields warn rather than breaking mixed
  workspaces. Synchronize omp credential IDs with the core config enum and audit
  `webSearch.mode` in the manifest. OAuth-only stores are unsuitable for ephemeral
  bundles; browser-backed search may need downloads unavailable in the sandbox.

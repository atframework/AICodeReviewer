---
title: CLI commands
description: Reference for every aicr CLI subcommand and flag.
---

The `aicr` CLI (built from `packages/cli`) is the entry point for serving,
one-shot reviews, eval, replay, memory inspection, and template linting. Build
it first with `pnpm build`, then invoke via Node:

```bash
node packages/cli/dist/index.js <command> [options]
```

On Linux/CI where `pnpm` runs directly, the same binary is invoked the same
way. Show help at any time with `--help` / `-h`.

## Commands

| Command | Purpose |
| --- | --- |
| [`serve`](#serve) | Start the webhook server |
| [`review`](#review) | Run a code review (prompt prep or full dry-run) |
| [`eval`](#eval) | Run evaluation benchmarks against the configured LLM |
| [`replay`](#replay) | Replay a stored review run scaffold |
| [`memory`](#memory) | Inspect or clear workspace memory |
| [`lint`](#lint) | Validate templates or config scaffold |
| [`doctor`](#doctor) | Print environment diagnostics |
| `help` | Show the help message |

## Global options

| Flag | Description |
| --- | --- |
| `--config <path>` | Path to config YAML file |
| `--workspace <id>` | Workspace ID |
| `--help`, `-h` | Show the help message |
| `--version`, `-v` | Show version |

## serve

Start the HTTP server that receives webhooks and trigger events.

```bash
node packages/cli/dist/index.js serve \
  --config example/config.yaml \
  --port 8080
```

| Flag | Description |
| --- | --- |
| `--port <number>` | HTTP listen port (default: 8080) |

The server exposes `/healthz`, `/metrics`, `/dashboard`, `/api/admin/*`,
`/webhooks/*`, and `/triggers/*`. See [Authentication &
secrets](/en/configuration/authentication/) for how each route is protected.

## review

Run a single review without the long-running server. With `--dry-run` it
prepares and runs the review but skips all output channels.

```bash
node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```

| Flag | Description |
| --- | --- |
| `--repo <ref>` | Repository reference (owner/repo) |
| `--provider <name>` | Trigger provider kind from the config schema |
| `--trigger <name>` | Trigger name |
| `--reason <text>` | Review reason |
| `--source-root <path>` | Source root directory |
| `--base-prompt <path>` | Path to base system prompt template |
| `--changed-file <path>` | Changed file (repeatable) |
| `--base-sha <sha>` | Base revision SHA |
| `--head-sha <sha>` | Head revision SHA |
| `--url <url>` | PR / MR / commit URL |
| `--author-username <u>` | Author username |
| `--author-email <e>` | Author email |
| `--dry-run` | Run without publishing to output channels |
| `--max-prompt-tokens <n>` | Maximum prompt token budget |

## eval

Run evaluation fixtures. Without secrets, `--validate-only` checks fixture
shape and expected-problem contracts only — this is what CI runs.

```bash
# Validate fixtures only (no LLM, no config secrets needed)
node packages/cli/dist/index.js eval --validate-only

# Full benchmark run (loads config + LLM; needs AICR_LLM_API_KEY etc.)
node packages/cli/dist/index.js eval --eval-dir eval/
```

| Flag | Description |
| --- | --- |
| `--eval-dir <path>` | Directory containing eval JSON fixtures |
| `--validate-only` | Validate fixtures without loading config or LLM |

Fixtures live under `eval/*.json`. The root CI pipeline runs
`pnpm eval:validate` (= `eval --validate-only`) on every change.

## replay

Replay a stored review run scaffold — useful for reproducing a past run from
its captured inputs without re-fetching from VCS.

```bash
node packages/cli/dist/index.js replay \
  --config example/config.yaml \
  --run-id <id>
```

| Flag | Description |
| --- | --- |
| `--run-id <id>` | Run ID to replay |

## memory

Inspect or clear workspace reflection/memory scaffolds. Memory is scoped per
workspace; clearing does not cross workspace boundaries.

```bash
# Show memory for a workspace
node packages/cli/dist/index.js memory --workspace <id>

# Include full file contents
node packages/cli/dist/index.js memory --workspace <id> --all

# Clear a specific scope (e.g. false-positives)
node packages/cli/dist/index.js memory clear --workspace <id> --scope false-positives
```

| Flag | Description |
| --- | --- |
| `--workspace <id>` | Workspace ID |
| `--scope <scope>` | Memory clear scope (`false-positives`, `recurring-issues`, etc.) |
| `--all` | Include full file contents in `memory show` |

`memory` subcommands: `show` (default), `clear`.

## lint

Validate templates or the config scaffold. Render a single template against a
sample context to catch template errors before deploying.

```bash
node packages/cli/dist/index.js lint \
  --template path/to/template.hbs \
  --template-kind summary
```

| Flag | Description |
| --- | --- |
| `--template <path>` | Template file to render and validate |
| `--template-kind <kind>` | Template kind: `summary` or `problem` |
| `--channel-kind <kind>` | Output channel kind for lint sample context |

## doctor

Print environment diagnostics — Node version, resolved binary paths, sandbox
engine availability, and config sanity. Useful first step when troubleshooting
a deployment.

```bash
node packages/cli/dist/index.js doctor --config example/config.yaml
```

`doctor` takes only the global `--config` flag.

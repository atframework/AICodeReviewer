---
title: Dry-run review
description: Run a one-shot review from the CLI without publishing output, and read the local result.
---

The `aicr review` command runs a single review without the long-running
server. With `--dry-run` it prepares and runs the full review pipeline but
skips every output channel, so you can validate the LLM, agent, and sandbox
without spamming a PR or IM channel. This page expands on the
[dry-run section of Quick start](/en/start/quick-start/#dry-run-a-review).

For the complete CLI command reference, see [CLI commands](/en/reference/cli/).

## When to use dry-run

- Validating that LLM credentials, the agent CLI, and the sandbox are wired
  up before opening the server to webhooks.
- Iterating on prompts, skills, or model choice without publishing.
- Reproducing a review locally from a checkout.

Dry-run does **not** publish to any channel, regardless of `outputs.routes`.
A non-dry-run review without a matching output route is recorded as skipped
with `skipReason="no_output_publisher"` — that is routing, not a dry run.

## Running a dry-run

```bash
export AICR_LLM_API_KEY=sk-xxx

node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```

## Flags

| Flag | Description |
| --- | --- |
| `--config <path>` | Path to the config YAML file |
| `--repo <ref>` | Repository reference (e.g. `owner/repo`) |
| `--provider <name>` | Trigger provider kind from the config schema (`gitea`, `github`, `gitlab`, `p4`, `svn`) |
| `--trigger <name>` | Trigger name |
| `--reason <text>` | Review reason |
| `--source-root <path>` | Source root directory to review |
| `--base-prompt <path>` | Path to a base system prompt template (overrides the workspace prompt file) |
| `--changed-file <path>` | Changed file (repeatable) |
| `--base-sha <sha>` | Base revision SHA |
| `--head-sha <sha>` | Head revision SHA |
| `--url <url>` | PR / MR / commit URL |
| `--author-username <u>` | Author username |
| `--author-email <e>` | Author email |
| `--dry-run` | Run without publishing to output channels |
| `--max-prompt-tokens <n>` | Maximum prompt token budget |

`--provider` selects which trigger profile's VCS adapter and filters apply.
`--source-root` points at the local checkout; combine it with `--changed-file`
(or `--base-sha` / `--head-sha`) to scope the diff.

## Reading the result

A dry-run prints the resolved review summary, the list of reported problems
(if any), and the skip reason when the review was skipped. Common skip
reasons:

| Skip reason | Meaning |
| --- | --- |
| `lgtm` | No actionable problems found |
| `no_reviewable_code` | Nothing reviewable in the change |
| `no_output_publisher` | No output route matched (non-dry-run only) |
| `no_problems_suppressed` | All selected summary channels suppress zero-problem results |
| `output_dispatch_failed` | Every dispatch attempt failed |

If the dry-run reports problems, the LLM and pipeline are healthy. If it
errors with `AgentContextOverflowError`, enable `llm.model_catalog` or set a
`context_window` override — see [Troubleshooting](/en/troubleshooting/).

## Next steps

Once dry-run is clean, wire up your [first webhook](/en/start/first-webhook/)
to let real VCS events drive reviews.

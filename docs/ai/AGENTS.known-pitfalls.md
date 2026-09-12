# AICR Pitfall Topic Map

Before implementation or review, select the affected topics below. Read only
those files and their relevant sections; the list is not a mandatory full read.
Code and tests remain authoritative. Historical issue numbers are not contracts.

| Changed surface / search terms | Read |
| --- | --- |
| Config, passthrough migration, model_chain, catalog, store, usage, rollups | [Config and state](pitfalls/AGENTS.config-and-state.md) |
| Prompt Manager, MCP state, context/repair, sandbox, runtime bundle | [Review runtime](pitfalls/AGENTS.review-runtime.md) |
| CLI flags, model injection, compaction, web search, pi/omp, argv, XDG | [Agent adapters](pitfalls/AGENTS.agent-adapters.md) |
| PR comments, no_problems, Markdown, Feishu, fingerprints, resolution | [Output contracts](pitfalls/AGENTS.outputs.md) |
| Webhooks, retry/dedup, auto-commit, execution windows, deferrals | [Scheduling](pitfalls/AGENTS.scheduling.md) |
| Git/submodules, P4, blame, batch diff, transport errors | [VCS context](pitfalls/AGENTS.vcs.md) |
| CI, dependencies, Markdown gates, docs site, LFS, Docker/tool baseline | [Build and docs](pitfalls/AGENTS.build-and-docs.md) |
| Remote deploy, restart, rollback, rootless Podman, issue repair | [Deployment skill](../../.agents/skills/remote-deployment/SKILL.md) |
| Windows launcher, quoting, encoding, native-command globs | [PowerShell reference](../../.agents/skills/modern-cli-toolkit/references/powershell-for-agents.md) |

Add a recurring regression to its existing topic: name the trigger, non-obvious
invariant, source, and regression check. Merge overlapping entries and remove
obsolete details. Keep incident chronology, copied schemas, version catalogs,
and generic lint/typecheck advice out of this map and its topics.

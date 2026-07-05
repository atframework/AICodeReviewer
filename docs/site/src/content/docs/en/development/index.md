---
title: Contributing
description: Repository layout, development setup, the test and validation matrix, and how to add packages, config fields, and output channels.
---

This page is the public contributor guide for AICodeReviewer. It covers the
repository layout, local development setup, the test and validation matrix,
and the common contribution workflows. The repository's `AGENTS.md` holds the
always-on rules, guardrails, environment notes, and the list of known
codebase pitfalls to avoid reintroducing — read it before larger changes.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/*` | Runtime TypeScript packages (CLI, core, server, agents, sandbox, outputs, mcp-output, llm, vcs, store, eval). Managed with pnpm workspaces and TypeScript project references. |
| `docs/site` | This documentation site (Astro Starlight, English + 简体中文). An isolated workspace package; not part of the runtime. |
| `docs/` (other) | Topical reference modules (e.g. output channels) consulted while writing these pages. |
| `example/` | Deployment sample: `config.yaml`, `.env.sample`, Compose stack, trigger scripts. |
| `deploy/` | `Dockerfile`, `deploy.sh`, and related deployment assets. |
| `eval/` | Permanent eval CLI test fixtures. |
| `AGENTS.md` | Always-on contributor guidance, guardrails, and known codebase pitfalls. |
| `.agents/skills/` | Repeatable workflow skills (audit, deployment, maintenance, etc.). |

:::note[Keep the docs site out of the runtime]
`docs/site` is an isolated workspace package and must stay out of the runtime
image. It is not referenced from the root `tsconfig.json`, and the root
`build`/`clean` scripts are filtered to `--filter "./packages/*"`. The
runtime `Dockerfile` does not copy `docs/site`.
:::

## Development setup

Requirements:

- Node.js `>= 20` (Node 22 userspace is used by the deployment image).
- pnpm.

```bash
# From the repository root
pnpm install
pnpm build
```

:::note[Windows PowerShell]
`pnpm`, `npx`, and `.ps1` scripts are blocked by default execution policy.
Run Node-based tools directly:

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/eslint/bin/eslint.js .
node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false
```

PowerShell 5.1 `>` redirect and `Out-File` default to UTF-16 LE; use
`Set-Content -Encoding utf8` (PS 7+) or `Out-File -Encoding ascii` for files
that must be transferred. Backticks are escapes/line continuations, so avoid
inline `node -e` snippets with template literals.
:::

## Test and validation matrix

Run these before proposing a change. On Linux/CI use the `pnpm` scripts; on
Windows PowerShell invoke the Node binaries directly as above.

| Step | Linux/CI | Windows PowerShell |
| --- | --- | --- |
| ESLint | `pnpm lint` | `node node_modules/eslint/bin/eslint.js .` |
| Typecheck | `pnpm typecheck` | `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` |
| Unit tests | `pnpm test` | `node node_modules/vitest/vitest.mjs run` |
| Markdown lint | `pnpm markdownlint` | `node node_modules/markdownlint-cli2/markdownlint-cli2.mjs "**/*.md" "!**/node_modules/**" "!**/dist/**" "!**/coverage/**"` |
| Build | `pnpm build` | `cmd /c "pnpm build"` |
| Eval fixture validation | `pnpm eval:validate` (after build) | `node packages/cli/dist/index.js eval --validate-only` |
| Docs build | `pnpm docs:build` | `pnpm docs:build` |

`pnpm eval:validate` runs `aicr eval --validate-only`, which checks `eval/*.json`
shape and expected-problem contracts only — no LLM, no config secrets. A full
`aicr eval` run loads config and calls the LLM, so keep it as a separate
environment-specific benchmark job.

Changes that affect config shape, agent adapters, MCP tool contracts, output
rendering, deployment behavior, or public workflow must update the matching
docs, `example/config.yaml`, and `example/README.md` in the same change.

## Adding a package

1. Create the package directory under `packages/<name>/` with its own
   `package.json`, `tsconfig.json`, `src/`, and `test/`.
2. Add the package to `pnpm-workspace.yaml` (the workspace already globs
   `packages/*`, so this is usually automatic).
3. Add a TypeScript project reference from the root `tsconfig.json` and from
   any package that consumes it; add a reference back from the new package's
   `tsconfig.json` to its dependencies.
4. Add at least a `test/index.test.ts` so the package has a test surface,
   even if it only exports a constant.
5. Add the new `onlyBuiltDependencies` entry to `pnpm-workspace.yaml` if the
   package introduces a native module (pnpm 10 gates native builds behind
   `onlyBuiltDependencies`).

## Adding or changing a config field

The Zod schema in `packages/core/src/config.ts` is the source of truth.

1. Update the schema (and any `superRefine` cross-field validation).
2. Add or update a test in `packages/core/test/config.test.ts`.
3. Update `example/config.yaml` with a commented example.
4. Update the relevant narrative page under `docs/site/src/content/docs/.../configuration/`
   and the field table in
   [Configuration fields](/en/reference/config-fields/).
5. If the field changes runtime behavior, update `example/README.md` and the
   matching topical doc.

Workspace config files cannot write system-level fields; respect the
`cache` / `defaults` / `instances` three-part shape and the
global → workspace-default → workspace-instance override order.

## Adding an output channel

1. Implement the dispatcher in `packages/outputs/src/` and register it in the
   output registry. The channel `kind` is a free-form string constrained by
   the registry (not a closed enum).
2. Add built-in Handlebars templates for the problem and summary variants
   under the template engine.
3. Add tests, including the IM-markdown transformer if the channel is an IM
   bot (table regexes must not use the `g` flag with `.test()`).
4. Document the channel in [Output channels](/en/integrations/output-channels/)
   and add its fields to [Configuration fields](/en/reference/config-fields/).
5. Update `example/config.yaml` with a commented example.

See [Output channels](/en/integrations/output-channels/) for the problem
schema, summary schema, channel mapping, and the no-problems policy that
every channel must respect.

## Maintaining the docs site

The docs site is bilingual (English under `.../en/`, 简体中文 under
`.../zh-cn/`). Every user-facing page exists in both locales; keep config
keys, commands, paths, field names, and enum values identical across locales.

- Build and validate locally with `pnpm docs:build`. The build enforces the
  public/internal boundary: pages under `src/content/docs/` must not reference
  the internal AI/roadmap documentation tree or carry migration-source
  maintenance notes.
- Sidebar slugs omit the `index` segment (e.g. `troubleshooting/index.md` has
  slug `troubleshooting`). Frontmatter `template` only accepts `doc` or
  `splash`; Starlight `social` is an array of link items.
- Content files use `.md` only (no MDX).
- Cross-links use locale-prefixed paths (`/en/...`, `/zh-cn/...`).

When you change a config shape, output contract, or runtime behavior, update
both locales' relevant pages in the same change.

## Workflow rules

- Keep edits minimal and surgical; do not weaken lint, typecheck, test, or
  markdown gates to land a change.
- All temporary task artifacts (scratch scripts, debug logs, one-off reports,
  benchmark output) go under `build/`, never in the repository root, `eval/`,
  or a package directory.
- Public/shared modules (`packages/cli/src`, `ReviewEvent`, template context)
  must stay platform-neutral — import canonical schemas from `@aicr/core`
  and keep provider/channel-specific names inside config contracts, docs,
  tests, and platform-specific adapters.

For the full, always-on contributor rules — including the numbered list of
known codebase pitfalls to avoid reintroducing — read `AGENTS.md` at the
repository root.

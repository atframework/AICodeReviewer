# Build, Dependencies and Documentation

Read the section matching tooling, image, dependency, or site changes.
Final commands live in [the baseline](../AGENTS.repository-baseline.md).

## Workspace and dependencies

Sources: root/package manifests, `pnpm-workspace.yaml`, `tsconfig.json`,
`vitest.config.ts`, and `.github/workflows/`.

- Keep package manifests, local TS config and root references aligned. Preserve
  meaningful sandbox/agent tests; an export-only fixture is not a coverage goal.
- Recheck native-module engines and pnpm build approvals after dependency bumps.
  `better-sqlite3` 13 uses bundled N-API prebuilds: retain the workspace override
  and ignored build setting while applicable; do not trigger node-gyp needlessly.
  Unsupported Node can kill test workers before assertions. Compare expected
  test files with collected results rather than trusting partial green output.
- Check TypeScript/ESLint/Astro peers together. A major Zod bump is a schema
  migration: default/refinement ordering, errors, MCP compatibility and docs
  introspection all need regression evidence. Live manifests own version limits.
- Hydrate LFS snapshot/PNG assets before packaging. CI/docs/image checkouts use
  `lfs: true`; working-tree packaging follows `git lfs pull`, not `git archive`.
  Keep the model snapshot path aligned across code, attributes and deploy checks.
  Renormalization is scoped; history rewrite is a separate operation.
- On Windows with `core.autocrlf=true`, `pnpm format:check` flags every file
  (prettier `endOfLine` defaults to `lf`, the working tree is CRLF). This is
  an environment artifact, not formatting drift: the script is a local
  convenience, runs in no CI job, and is not part of the repository-baseline
  gate list. Do not "fix" it by mass-reformatting or by weakening the config
  without a repo-wide decision.
- Browser-gate specs share one persistent config namespace per fixture
  launch. A spec that publishes scheduling config (e.g.
  `review.pull_request.schedule.rules` weekly windows, M16 durable deferral)
  silently defers later webhook-triggered reviews to the next window — the
  failure surfaces in a different spec as "agent never invoked". Affected
  specs must clear the schedule first, BEFORE the config tab loads: an
  out-of-band revision after the UI has read its baseline 409s the first UI
  publish. Cross-process conditions (agent stub spawn after webhook →
  scheduling → VCS → bundle → exe) exceed Playwright's 10 s `expect.poll`
  default on cold full-suite starts; give those polls an explicit 60 s
  budget. See `tests/browser/ui-run-isolation.spec.ts`.
- Live gate services (throwaway PG cluster, Redis instances) can die between
  turns; a mid-turn crash even wiped one cluster's roles. Before citing a
  zero-skip coverage run, re-verify reachability with real clients
  (psql/redis-cli), not port probes or hub status, and re-create roles via
  single-user mode if the cluster lost them (`postgres --single -D …`).

## Runtime image

Sources: `deploy/Dockerfile`, `deploy/deploy.sh`, and
[the tool catalog](../../../.agents/skills/modern-cli-toolkit/references/tool-catalog.md).

- Some hoisted-only workspace packages have no local node_modules directory.
  Create required sandbox/eval directories in the build stage before runtime COPY.
- The P4 install path needs a glibc Debian-family image and the verified Perforce
  Ubuntu APT distribution. Do not derive that distribution from Debian's codename
  or switch to a musl base without replacing/revalidating the P4 install.
- Tool availability, aliases (`fd`, `bat`), pinned release asset names/architecture,
  and mirror variables come from the Dockerfile. Recheck actual packages/releases
  when changing them; update relevant shell/runtime/deploy documentation together.
- Host/WSL toolsets differ from the image. WSL PATH can select Windows pnpm with
  an invalid UNC cwd; use the WSL-native pinned package manager from the repo.
  Isolated dirty-tree validation must copy tracked changes and untracked task
  files without deleting existing dependencies or logs.

## Markdown and public site

Sources: `.markdownlint-cli2.yaml`, `docs/site/package.json`, its scripts,
`astro.config.mjs`, and both content locales.

- Invoke Markdownlint's CLI bin and confirm discovered files; the library module
  can return zero without scanning anything. Do not broaden ignores to pass.
- `docs/site` is a precise workspace entry, excluded from root runtime TS/build
  and Docker copies. Public validators reject internal AI/maintenance content.
  Keep `.md` versus component-bearing `.mdx` scanning and locale parity intact.
- Verify Starlight frontmatter/sidebar/component APIs against installed versions.
  Index routes omit `/index`; use valid icons and supported template values.
  Do not copy historical dependency conventions as current requirements.
- Astro dependency patches are independent, idempotent and source-shape guarded.
  Resolve transitive dependencies from their owner; one satisfied patch must not
  skip later patches. Reproduce failures in the real build before adding patches.
- Config-reference validation reads TS source, not stale dist. Preserve wrapper,
  preprocess/lazy/rejected-field handling, explicit allowlists, and escaped table
  pipes. An ancestor summary cannot silently cover newly undocumented fields.
  Arrays document element `[]` paths under every exposed workspace prefix;
  enumConceptPaths and both locale tables keep matching order.
- CLI extraction respects nested braces and distinguishes command from subcommand.
  Sidebar extraction handles inline entries; link resolution distinguishes index
  pages from ordinary pages. Update extractors when source shapes change, never
  weaken their assertions to conceal missing documentation.

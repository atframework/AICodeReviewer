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
  When pnpm meets an undecided build script it appends an
  `allowBuilds: <pkg>: set this to true or false` PLACEHOLDER to
  `pnpm-workspace.yaml`; from then on every install hard-fails with
  ERR_PNPM_IGNORED_BUILDS (surfacing as runDepsStatusCheck errors before any
  `pnpm run` script) until each entry is decided. Decide explicitly (`false`
  for esbuild/msgpackr-extract/protobufjs — prebuilt optional deps or pure JS)
  and keep the list reviewed, not auto-accepted.
  A dynamic optional import can fail because a transitive dependency is missing
  even when the package itself exists. Preserve the underlying import cause and
  verify package-local resolution before changing manifests (`redis-queue.ts`).
  Unsupported Node can kill test workers before assertions. Compare expected
  test files with collected results rather than trusting partial green output.
- Check TypeScript/ESLint/Astro peers together. When the newest releases have
  incompatible peer ranges, record and validate a compatible exception rather
  than forcing an unsupported pair. TypeScript 6 runtime projects should declare
  `types: ["node"]` explicitly instead of relying on implicit `@types` inclusion.
  A major Zod bump is a schema migration: default/refinement ordering, errors,
  MCP compatibility and docs introspection all need regression evidence. Live
  manifests own version limits.
- Hydrate LFS snapshot/SVG/PNG assets before packaging. CI/docs/image checkouts use
  `lfs: true`; working-tree packaging follows `git lfs pull`, not `git archive`.
  Keep the model snapshot path aligned across code, attributes and deploy checks.
  Renormalization is scoped; history rewrite is a separate operation.
- Executable scripts must carry the tracked `100755` mode. Windows checkouts
  (`core.filemode=false`) commit new shebang scripts as `100644` with no
  warning, and POSIX later fails `spawn <name> EACCES` wherever a test or doc
  resolves the script by PATH name instead of `bash <path>`. Set it with
  `git update-index --chmod=+x <path>` (a mode-only commit; a working-tree
  chmod alone is invisible on Windows), and audit modes with `git ls-files -s`
  when adding PATH-spawned shims such as
  `tests/browser/fixtures/stub-bin/kilo` / `opencode`.
- On Windows with `core.autocrlf=true`, `pnpm format:check` flags every file
  (prettier `endOfLine` defaults to `lf`, the working tree is CRLF). This is
  an environment artifact, not formatting drift: the script is a local
  convenience, runs in no CI job, and is not part of the repository-baseline
  gate list. Do not "fix" it by mass-reformatting or by weakening the config
  without a repo-wide decision.
- A standalone pnpm installation can break while staying on `PATH`: the
  `%LOCALAPPDATA%\pnpm\bin\pnpm.cmd` shim executes the global store's `pnpm`
  entry directly, so a missing or corrupted CLI bundle in that store makes
  every call fail instantly with `'"…pnpm"' is not recognized` — including the
  nested `pnpm` invocations inside `pnpm build`, even when `corepack pnpm`
  works. Route the command through the repo-pinned Corepack entry
  (`corepack pnpm build`; `packageManager` owns the version) and, because
  build scripts re-invoke `pnpm` recursively, prepend a shim directory that
  forwards to `corepack pnpm@<version>` so nested calls resolve the same way.
  Probe with `pnpm --version` before starting long gate runs.
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
- A process fixture reporting no free port may be rejecting valid ports with a
  stale workstation-specific Hyper-V range list. Repeated `listen(0)` calls can
  also return the same recently closed candidate. Probe explicit random ports,
  retry only bind conflicts/access denial with a finite budget, and propagate
  other errors. Never copy one host's excluded ranges into tests. See
  `packages/server/test/fixtures/loopback-port.ts` and the post-migration/replica
  process tests; a probe is not a reservation, so child readiness must still fail
  visibly if another process wins the port.
- Full live-service coverage can exceed a small fixture's PostgreSQL connection
  budget (`53300`, too many clients), while overlapping cold TypeScript child
  imports miss readiness deadlines. Retain the failure log and inspect capacity
  before rerunning; provision an owned test instance with enough connections and
  bound worker parallelism with `VITEST_MAX_WORKERS`, preserving every test,
  race assertion and timeout. With shared live endpoints, also apply the
  database-wide lock and Redis prefix-isolation rules in
  [config/state pitfalls](AGENTS.config-and-state.md). The deployment fixture's
  30-connection limit is a service acceptance constraint, not full-suite sizing.

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
- Disposable Debian slim fixtures may lack CA certificates. Use
  `tests/services/debian-mirror.sh`: bootstrap the CA bundle from the domestic
  mirror with Debian signature verification intact, then switch to HTTPS.
  Preserve the pinned image's suites and signing-key path; validate both service
  wrappers and cleanup as described in [the service guide](../../testing-services.md).

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
- Live serve-based tests (`*-live.test.ts` spawning the CLI) run the workspace
  **dist** exports of `@aicr/outputs|server|cli`, not the edited `src`; a green
  vitest on stale dist proves nothing. Always `pnpm build` before rerunning live
  suites after touching source (`wsl-run-live.sh` builds first for this reason).
- CLI extraction respects nested braces and distinguishes command from subcommand.
  Sidebar extraction handles inline entries; link resolution distinguishes index
  pages from ordinary pages. Update extractors when source shapes change, never
  weaken their assertions to conceal missing documentation.
- Starlight CSS cascade: all built-in styles live in `@layer starlight.*`, so
  unlayered `customCss` rules beat them at equal specificity — EXCEPT
  `Page.astro`'s unlayered inline `<style>` (e.g. the splash-page
  `--sl-content-width: 67.5rem` under `html:not([data-has-sidebar])`), which ties
  a `:root`/element rule and wins on source order. Bump specificity with the
  always-present `[data-theme]` attribute instead of `!important`.
- `--sl-content-width` feeds several formulas (TwoColumnContent main-pane/right
  sidebar, Header search grid, ContentPanel max-width). Setting it to `100%`
  degrades the header grid math and gives ~229 Latin / ~114 CJK characters per
  line at 2560px; on the sidebar-free splash page it is even worse (~211 CJK in
  full-width asides at 3440px). Keep fixed rem caps (96rem docs / 120rem splash).
  Paragraphs and lists must follow their containing section's width: a separate
  `62ch` cap leaves narrow text beside wide asides and card grids. Inspect
  rendered bounds and screenshots on landing and ordinary docs pages in both
  locales/themes, including mobile, ultrawide and font-CDN fallback rendering;
  preserve list indentation and local table/code scrolling. The rules live in
  `docs/site/src/styles/custom.css`; validation scope is in `docs/site/README.md`.
  Aside titles containing inline code need normal inline layout: Starlight's
  flex title splits text/code into separate items that can exceed a narrow box.
  Check the English config reference's workspace-layer note on mobile.
- `astro dev`/`astro preview` default to host `localhost`, which follows the
  system resolver: when it returns `::1` first (Windows default) the server
  binds an IPv6-only listener on `[::1]`, and on hosts with a broken IPv6
  loopback (seen with Hyper-V/WSL networking: LISTENING on `[::1]` yet every
  connect refused) the printed URL never opens and `127.0.0.1` answers nothing.
  `docs/site/astro.config.mjs` pins `server.host: "127.0.0.1"` for both
  commands; browsers still reach it via the `localhost` name. Do not revert to
  `localhost`; pass `--host` on the CLI for LAN exposure instead.

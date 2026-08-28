# AICodeReviewer(AICR) Documentation Site

This is the user-facing documentation site for AICodeReviewer, built with
[Astro Starlight](https://starlight.astro.build/). It is an independent
workspace package (`@aicr/docs-site`) and has **no runtime dependency** on the
AICR service.

## Quick commands

Run from the repository root with Node.js `>=23.6.0`. Astro 7 itself supports
Node `>=22.12.0`, but the source-backed config validator needs Node's native
TypeScript stripping, which became available in Node 23.6:

```bash
pnpm docs:dev       # local dev server with hot reload
pnpm docs:build     # validation gates + static build -> docs/site/dist/
pnpm docs:preview   # preview the built site locally
pnpm docs:check     # validation gates + Astro diagnostics
```

All four scripts filter to `@aicr/docs-site`, so they never build runtime
packages. `docs:build` and `docs:check` run the validation scripts in
`scripts/` before Astro; each one is also invocable on its own via
`pnpm --filter @aicr/docs-site validate:<name>`.

## Validation gates

| Script | Enforces |
| --- | --- |
| `validate-public-content.mjs` | Public pages must not reference internal AI/roadmap paths or carry migration-source notes. |
| `validate-config-reference.mjs` | `en/zh-cn reference/config-fields.md` must cover every settable field of the Zod schema in `packages/core/src/config.ts` (and list no invented fields); the shared enum table must match schema enum options; both locales must list the same field set. Imports the schema from TypeScript source via Node type stripping, so it never validates against a stale build. |
| `validate-cli-reference.mjs` | `en/zh-cn reference/cli.md` must match the commands and flags the CLI actually dispatches (`packages/cli/src/app.ts` parseArgs options), and `helpText` must list exactly the accepted flags. |
| `validate-internal-links.mjs` | Every site-absolute link, MDX `href`, and anchor must resolve to a content page route, a `public/` asset, or a heading id; every sidebar slug must exist in both locales and every page must appear in the sidebar. |
| `validate-seo.mjs` | Every page needs non-empty frontmatter `title`/`description` within length bounds (CJK-aware width: description 40-320, title <= 60); `public/robots.txt` must advertise `<site>/sitemap-index.xml`; the starlight `head` must wire `og:image`/`twitter:image` to a committed 1200x630 `public/og-image.png`. |
| `validate-bilingual-consistency.mjs` | `en/` and `zh-cn/` must hold the same page set with equal code-fence counts; machine tokens inside fences (config keys, env vars, flags, paths) must match across locales; `.mdx` fences need language tags; prose must avoid the machine-checkable subset of the banned filler-word lists in `.agents/skills/docs-writing-style/SKILL.md`. |

`validate-config-reference.mjs` requires Node `>=23.6` (native TypeScript type
stripping); the CI docs job uses Node 24, matching `engines.node >=23.6.0`.
`validation-helpers.test.mjs` covers the config-subtree, relative-route,
frontmatter/width, machine-token, and PNG-size rules before these six
validators run.

## Directory layout

```text
docs/site/
  astro.config.mjs        Site config: locales, sidebar, base path
  src/
    content.config.ts     Starlight docs + i18n content collections
    content/
      docs/
        en/               English content (served at /en/...)
        zh-cn/            Simplified Chinese content (served at /zh-cn/...)
      i18n/
        zh-CN.json        Chinese UI-string overrides
    styles/custom.css     Minimal theme overrides
  public/                 Static assets served as-is
```

## Internationalization

Every locale is URL-prefixed for a symmetric structure:

- English → `/en/...`
- 简体中文 → `/zh-cn/...`

`defaultLocale: "en"` only controls UI-string fallback. To add a page, create
both `src/content/docs/en/<path>.md` and `src/content/docs/zh-cn/<path>.md`.
Sidebar labels are localized via the `translations` map keyed by BCP-47 lang
tag (e.g. `"zh-CN"`) in `astro.config.mjs`.

Content pages use `.md`. The two localized landing pages (`en/index.mdx` and
`zh-cn/index.mdx`) use `.mdx` so they can render Starlight components — hero
frontmatter plus `Card`, `CardGrid`, `LinkCard`, `Steps`, and `Aside`. MDX
ships with Starlight (no extra integration needed); those components do **not**
render in plain `.md` (they leak as literal tags). `validate-public-content.mjs`
scans both `.md` and `.mdx`.

## Deployment target

The site targets the GitHub Pages custom domain `https://aicr.atframe.work/`.
The `site` field in `astro.config.mjs` encodes that origin, and no `base` is
set because the site is published at the domain root. The `public/CNAME` file
is copied into `gh-pages` so GitHub Pages keeps the custom domain binding.

SEO assets shipped from `public/`: `robots.txt` (advertises the Starlight
sitemap at `/sitemap-index.xml`) and `og-image.png` (1200x630 social preview,
wired through the starlight `head` config). Regenerate the preview image after
branding changes with `pnpm --filter @aicr/docs-site generate:og-image` (uses
the committed `sharp` dependency and system fonts; commit the result) —
`validate-seo.mjs` fails the build if the image goes missing or drifts from
1200x630.

The GitHub Actions workflow at `.github/workflows/docs.yml` builds the site
and publishes `docs/site/dist/` to the `gh-pages` branch. Real publishing
requires the repository secret `DEPLOY_DOCUMENT_GH_PAGES_KEY` to contain a
writable SSH deploy key and the repository's **Settings → Pages → Source =
Deploy from a branch**, branch `gh-pages`, folder `/`.

## Boundaries

- This package is **not** part of `tsconfig.json` project references and is
  excluded from the runtime Docker image (`.dockerignore` excludes `docs`).
- Root `pnpm build` (`pnpm -r run build`) only touches `packages/*` because
  `docs/site` is not under the `packages/*` glob.
- Dependencies live in this package's `package.json`, isolated from runtime
  packages.

## Content sources

User-facing content is rewritten from these in-repo sources (do not copy
internal/AI docs verbatim):

- `example/README.md` — primary user guide.
- `example/config.yaml` — configuration reference truth.
- `docs/output-channels.md` — output channel and MCP tool contract.
- `docs/podman.md` — Podman deployment guide.
- Code truth: `packages/core/src/config.ts`, `packages/cli/src/app.ts`,
  `packages/server/src/index.ts`.

Internal AI/roadmap/architecture docs under `docs/ai/` are **not** published
here; they serve maintainers only.

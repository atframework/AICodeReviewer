# AICodeReviewer(AICR) Documentation Site

This is the user-facing documentation site for AICodeReviewer, built with
[Astro Starlight](https://starlight.astro.build/). It is an independent
workspace package (`@aicr/docs-site`) and has **no runtime dependency** on the
AICR service.

The [documentation directory](../README.md) groups the user guides, design
documents, and acceptance records. This file covers the documentation site itself.

## Quick commands

Run from the repository root with Node.js `>=23.6.0`. Astro 7 itself supports
Node `>=22.12.0`, but the source-backed config validator needs Node's native
TypeScript stripping, which became available in Node 23.6:

```bash
pnpm docs:dev       # local dev server with hot reload
pnpm docs:build     # validation gates + static build -> docs/site/dist/
pnpm docs:preview   # preview the built site locally
pnpm docs:check     # validation gates + Astro diagnostics
pnpm --filter @aicr/docs-site generate:brand-assets  # refresh brand exports
```

All four scripts filter to `@aicr/docs-site`, so they never build runtime
packages. `docs:build` and `docs:check` run the validation scripts in
`scripts/` before Astro; each one is also invocable on its own via
`pnpm --filter @aicr/docs-site validate:<name>`.

Dev and preview bind to `127.0.0.1` (set via `server.host` in
`astro.config.mjs`), so the printed URL works even on hosts with a broken IPv6
loopback; pass `--host` on the CLI to expose the server on the LAN.

## Validation gates

| Script | Enforces |
| --- | --- |
| `validate-public-content.mjs` | Public pages must not reference internal AI/roadmap paths or carry migration-source notes. |
| `validate-config-reference.mjs` | `en/zh-cn reference/config-fields.md` must cover every settable field of the Zod schema in `packages/core/src/config.ts` (and list no invented fields); the shared enum table must match schema enum options; both locales must list the same field set. Imports the schema from TypeScript source via Node type stripping, so it never validates against a stale build. |
| `validate-cli-reference.mjs` | `en/zh-cn reference/cli.md` must match the commands and flags the CLI actually dispatches (`packages/cli/src/app.ts` parseArgs options), and `helpText` must list exactly the accepted flags. |
| `validate-internal-links.mjs` | Every site-absolute link, MDX `href`, and anchor must resolve to a content page route, a `public/` asset, or a heading id; every sidebar slug must exist in both locales and every page must appear in the sidebar. |
| `validate-seo.mjs` | Every page needs non-empty frontmatter `title`/`description` within length bounds (CJK-aware width: description 40-320, title <= 60); `public/robots.txt` must advertise `<site>/sitemap-index.xml`; the starlight `head` must wire `og:image`/`twitter:image` to a committed 1200x630 `public/og-image.png`. Brand SVG copies must match; 32px, 180px, and 512px PNG exports must have the expected dimensions. |
| `validate-bilingual-consistency.mjs` | `en/` and `zh-cn/` must hold the same page set with equal code-fence counts; machine tokens inside fences (config keys, env vars, flags, paths) must match across locales; `.mdx` fences need language tags; prose must avoid the machine-checkable subset of the banned filler-word lists in `.agents/skills/ai-agent-maintenance/references/writing-guidance.md`. |

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
    styles/custom.css     Brand colors, font stacks, wide-screen layout
  public/                 Static assets served as-is
```

## Wide-screen layout

`src/styles/custom.css` raises Starlight's content column from the default
`--sl-content-width: 45rem` to `96rem` (1536px at the 16px root size) on docs
pages and `120rem` (1920px) on the splash landing page, so 2.5K/4K/ultra-wide
viewports are actually used instead of turning into empty gutters. Starlight's
flex math keeps the table of contents glued to the column's right edge and
distributes excess space to the outer gutters. True 100% full-bleed was tested
and rejected: at ultrawide widths it produced ~211 CJK characters per line
inside asides and ~550px link cards.

Paragraphs, lists, blockquotes and description lists follow their containing
section's width, as do asides, code blocks and card grids. Lists retain their
marker indentation, and tables retain their natural column widths and local
horizontal scrolling. There is no separate character-based width cap on
text: at wide viewports, lines grow with the bounded content container instead
of leaving a narrow text strip beside full-width components. The root font
size stays unchanged so navigation and sidebars retain their proportions.
Aside titles use normal inline layout so titles containing code can wrap on
narrow screens while keeping their icon and inline code styling.

When touching these rules, verify both landing pages and ordinary docs pages
at mobile and desktop widths (390, 1280, 1920, 2560, 3250, 3440 px) in both
locales and themes. Inspect screenshots and rendered element bounds: prose
must fill its parent after padding and list indentation, and wide tables and
code blocks must scroll locally without widening the page. Also check system
font fallbacks when font CDNs are unavailable.

## Internationalization

Every locale is URL-prefixed for a symmetric structure:

- English → `/en/...`
- 简体中文 → `/zh-cn/...`

`defaultLocale: "en"` only controls UI-string fallback. To add a page, create
both `src/content/docs/en/<path>.md` and `src/content/docs/zh-cn/<path>.md`.
Sidebar labels are localized via the `translations` map keyed by BCP-47 lang
tag (e.g. `"zh-CN"`) in `astro.config.mjs`.

Starlight renders the browser tab as `<page title> | <site title>`, so the two
landing pages use `title: Home` / `title: 首页` in frontmatter; repeating the
site title there would render `AICodeReviewer | AICodeReviewer`. The visible
hero heading comes from the separate `hero.title` field and stays
`AICodeReviewer`.

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

SEO and brand assets shipped from `public/`: `robots.txt` advertises the
Starlight sitemap; `favicon.svg` is the editable app mark; `favicon-32.png`
provides a small PNG fallback; `apple-touch-icon.png` is 180x180;
`app-icon-512.png` is the large app icon; and `og-image.png` is the 1200x630
social preview. The SVG uses a code-review bracket mark and a confirmation
badge in navy, ice blue, and mint. Regenerate the PNGs, dashboard SVG copy,
and Starlight navigation copy in `src/assets/` after changing the master with
`pnpm --filter @aicr/docs-site generate:brand-assets`. Commit the exports.
SVG and PNG files are Git LFS assets; hydrate them before building or
packaging. The generator uses the committed `sharp` dependency and system
fonts for the social card, so export it deliberately rather than at build time.

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

# AICodeReviewer Documentation Site

This is the user-facing documentation site for AICodeReviewer, built with
[Astro Starlight](https://starlight.astro.build/). It is an independent
workspace package (`@aicr/docs-site`) and has **no runtime dependency** on the
AICR service.

## Quick commands

Run from the repository root with Node.js `>=22.12.0` (Astro 7 requirement):

```bash
pnpm docs:dev       # local dev server with hot reload
pnpm docs:build     # public-content validation + static build -> docs/site/dist/
pnpm docs:preview   # preview the built site locally
pnpm docs:check     # public-content validation + Astro diagnostics
```

All four scripts filter to `@aicr/docs-site`, so they never build runtime
packages. `docs:build` and `docs:check` also run
`scripts/validate-public-content.mjs` before Astro. That guard prevents public
pages from publishing internal AI/roadmap paths or migration-source notes.

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

## Deployment target

The site targets a GitHub Pages project page at
`https://owent.github.io/AICodeReviewer/`. The `site` and `base` fields in
`astro.config.mjs` encode that. To change to a custom domain, set `site` to the
domain, remove `base`, and add a `public/CNAME` file.

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

// Validate SEO metadata for the docs site (M11-P6 "SEO 自动化" in
// docs/ai/documentation-site-plan.md §8). Zero dependencies.
//
// Starlight already emits canonical URLs, hreflang alternates, og:title /
// og:description / og:url, twitter:card, and the sitemap whenever `site` is
// configured — those are trusted. This gate covers what Starlight does NOT
// provide and what per-page discipline requires:
//
//   1. every content page in BOTH locales has non-empty frontmatter
//      `title` and `description` (they feed <title>, og:*, and the snippet);
//   2. description display width is 40..320 and title display width is <= 60
//      (CJK-aware: one wide/fullwidth character counts as 2; search engines
//      truncate meta descriptions around 155-160 latin characters);
//   3. public/robots.txt exists and advertises `<site>/sitemap-index.xml`;
//   4. astro.config.mjs wires og:image / twitter:image (plus alt text) to
//      `<site>/og-image.png`, the file exists, and it is a 1200x630 PNG —
//      Starlight hardcodes twitter:card=summary_large_image, which without an
//      og:image renders an empty large card on social platforms.
//
// `site` is parsed from astro.config.mjs (same text-scanning approach as
// validate-internal-links.mjs; importing the config would pull in Astro).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import {
  displayWidth,
  extractFrontmatter,
  frontmatterValue,
  pngDimensions,
} from "./validation-helpers.mjs";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const docsDir = join(siteRoot, "src", "content", "docs");
const publicDir = join(siteRoot, "public");

const DESCRIPTION_MIN_WIDTH = 40;
const DESCRIPTION_MAX_WIDTH = 320;
const TITLE_MAX_WIDTH = 60;
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

const violations = [];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && (path.endsWith(".md") || path.endsWith(".mdx"))) {
      yield path;
    }
  }
}


// ---------------------------------------------------------------------------
// 1 + 2. Per-page frontmatter discipline (both locales)
// ---------------------------------------------------------------------------

for (const file of walk(docsDir)) {
  const displayPath = relative(process.cwd(), file).replaceAll("\\", "/");
  const frontmatter = extractFrontmatter(readFileSync(file, "utf8"));
  if (frontmatter === null) {
    violations.push(`${displayPath}: missing frontmatter block`);
    continue;
  }
  for (const key of ["title", "description"]) {
    const value = frontmatterValue(frontmatter, key);
    if (value === undefined || value === "") {
      violations.push(`${displayPath}: frontmatter \`${key}\` is required and must not be empty`);
    }
  }
  const description = frontmatterValue(frontmatter, "description");
  if (description !== undefined && description !== "") {
    const width = displayWidth(description);
    if (width < DESCRIPTION_MIN_WIDTH || width > DESCRIPTION_MAX_WIDTH) {
      violations.push(
        `${displayPath}: description display width ${width} outside ${DESCRIPTION_MIN_WIDTH}..${DESCRIPTION_MAX_WIDTH}` +
          ` (CJK counts double); write a real two-clause summary, not a stub`,
      );
    }
  }
  const title = frontmatterValue(frontmatter, "title");
  if (title !== undefined && displayWidth(title) > TITLE_MAX_WIDTH) {
    violations.push(
      `${displayPath}: title display width ${displayWidth(title)} exceeds ${TITLE_MAX_WIDTH}; keep the <title> tag short`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared: parse `site` from astro.config.mjs
// ---------------------------------------------------------------------------

const astroConfig = readFileSync(join(siteRoot, "astro.config.mjs"), "utf8");
const siteMatch = astroConfig.match(/^\s*site:\s*"([^"]+)"/mu);
if (!siteMatch) {
  violations.push("astro.config.mjs: `site` must be set (canonical URLs and the sitemap depend on it)");
}
const site = siteMatch ? siteMatch[1].replace(/\/$/u, "") : undefined;

// ---------------------------------------------------------------------------
// 3. robots.txt advertises the sitemap
// ---------------------------------------------------------------------------

const robotsPath = join(publicDir, "robots.txt");
if (!existsSync(robotsPath)) {
  violations.push("public/robots.txt: missing; search engines learn the sitemap location from it");
} else {
  const robots = readFileSync(robotsPath, "utf8");
  const expected = `Sitemap: ${site}/sitemap-index.xml`;
  if (!robots.split(/\r?\n/u).some((line) => line.trim() === expected)) {
    violations.push(`public/robots.txt: must contain the exact line "${expected}"`);
  }
}

// ---------------------------------------------------------------------------
// 4. og:image wiring + committed 1200x630 PNG
// ---------------------------------------------------------------------------

const ogImageUrl = `${site}/og-image.png`;
// The head entries are multi-line object literals, so pair the property/name
// attribute with the content attribute across newlines rather than per line.
const requiredHeadAttrs = [
  {
    find: new RegExp(`property:\\s*"og:image",\\s*content:\\s*"${ogImageUrl}"`, "u"),
    what: "og:image",
    hint: ` pointing at "${ogImageUrl}"`,
  },
  {
    find: new RegExp(`name:\\s*"twitter:image",\\s*content:\\s*"${ogImageUrl}"`, "u"),
    what: "twitter:image",
    hint: ` pointing at "${ogImageUrl}"`,
  },
  {
    find: /property:\s*"og:image:alt",\s*content:\s*"(?:.+?)"/u,
    what: "og:image:alt",
    hint: " with non-empty alt text",
  },
  {
    find: /name:\s*"twitter:image:alt",\s*content:\s*"(?:.+?)"/u,
    what: "twitter:image:alt",
    hint: " with non-empty alt text",
  },
];
for (const { find, what, hint } of requiredHeadAttrs) {
  if (!find.test(astroConfig)) {
    violations.push(`astro.config.mjs: starlight head config must carry \`${what}\`${hint}`);
  }
}

const ogImagePath = join(publicDir, "og-image.png");
if (!existsSync(ogImagePath)) {
  violations.push("public/og-image.png: missing; regenerate via `pnpm --filter @aicr/docs-site generate:og-image`");
} else {
  const dims = pngDimensions(readFileSync(ogImagePath));
  if (dims === null) {
    violations.push("public/og-image.png: not a valid PNG");
  } else if (dims.width !== OG_IMAGE_WIDTH || dims.height !== OG_IMAGE_HEIGHT) {
    violations.push(
      `public/og-image.png: ${dims.width}x${dims.height}, expected ${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT} (Open Graph standard)`,
    );
  }
}

if (violations.length > 0) {
  console.error("SEO validation failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  "SEO OK: every page carries title/description within length bounds, robots.txt advertises the sitemap, and the og:image is wired and 1200x630.",
);

// Validate internal links across the docs site (M11-P6 "链接检查：先从内部
// 链接开始" in docs/ai/documentation-site-plan.md §7). No external link
// checking and no new dependencies — this walks the content sources directly.
//
// Checks:
//   1. every site-absolute link (`/en/...`, `/zh-cn/...`) and MDX `href`
//      resolves to a content page route or a file in public/;
//   2. every anchor (`#foo`, `/path/#foo`) matches a heading id on the target
//      page (GitHub-style slugs, CJK preserved);
//   3. relative markdown links resolve against the linking page;
//   4. every sidebar slug in astro.config.mjs exists as a page in BOTH
//      locales, and every content page appears in the sidebar.
//
// Route derivation mirrors Starlight's file-based routing: no `slug:`
// frontmatter overrides exist in this site; `en/index.mdx` → `/en/`, and
// every other page keeps its path with a trailing slash.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { resolveRelativeRoute } from "./validation-helpers.mjs";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const docsDir = join(siteRoot, "src", "content", "docs");
const publicDir = join(siteRoot, "public");

const violations = [];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

// ---------------------------------------------------------------------------
// Build the page table: route -> { file, headings }
// ---------------------------------------------------------------------------

// Strip fenced code blocks so links and headings inside them are ignored.
function stripCodeFences(source) {
  return source.replace(/^(```|~~~).*\n[\s\S]*?^\1.*$/gmu, "");
}

function headingSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function extractHeadings(source) {
  const headings = new Set();
  const seen = new Map();
  for (const match of stripCodeFences(source).matchAll(/^(#{1,6})\s+(.+)$/gmu)) {
    // Drop inline markup (code spans, links, emphasis) before slugging.
    const plain = match[2]
      .replaceAll(/`([^`]*)`/gu, "$1")
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replaceAll(/[*_]+/gu, "")
      .trim();
    const base = headingSlug(plain);
    if (!base) {
      continue;
    }
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    // github-slugger appends -1, -2 ... to repeat headings on the same page.
    headings.add(count === 0 ? base : `${base}-${count}`);
  }
  return headings;
}

const pages = new Map(); // route ("/en/foo/") -> { file, headings, isIndex }
const pagesByLocale = new Map(); // "en" -> Set of sidebar slugs

for (const file of walk(docsDir)) {
  if (!file.endsWith(".md") && !file.endsWith(".mdx")) {
    continue;
  }
  const relativePath = relative(docsDir, file).replaceAll("\\", "/");
  const segments = relativePath.slice(0, relativePath.lastIndexOf(".")).split("/");
  const isIndex = segments.slice(-1)[0] === "index";
  const route = isIndex ? `/${segments.slice(0, -1).join("/")}/` : `/${segments.join("/")}/`;
  pages.set(route, { file, headings: extractHeadings(readFileSync(file, "utf8")), isIndex });

  const locale = segments[0];
  const slug = segments.slice(1, segments.slice(-1)[0] === "index" ? -1 : undefined).join("/");
  if (!pagesByLocale.has(locale)) {
    pagesByLocale.set(locale, new Set());
  }
  if (slug) {
    pagesByLocale.get(locale).add(slug);
  }
}

const rootPage = join(siteRoot, "src", "pages", "index.astro");
if (existsSync(rootPage)) {
  pages.set("/", { file: rootPage, headings: new Set(), isIndex: true });
}

// ---------------------------------------------------------------------------
// Extract and validate links
// ---------------------------------------------------------------------------

const externalPattern = /^[a-z][a-z0-9+.-]*:/iu;

function checkAnchor(anchor, targetPage, display) {
  if (!anchor) {
    return;
  }
  if (targetPage && !targetPage.headings.has(anchor)) {
    violations.push(`${display}: anchor #${anchor} not found on ${targetPage.file ? relative(siteRoot, targetPage.file).replaceAll("\\", "/") : "target page"}`);
  }
}

function checkTarget(rawTarget, sourceFile, display) {
  if (rawTarget === "" || rawTarget.startsWith("mailto:") || externalPattern.test(rawTarget)) {
    return;
  }

  let target = rawTarget;
  let anchor = null;
  const hashIndex = target.indexOf("#");
  if (hashIndex >= 0) {
    anchor = decodeURIComponent(target.slice(hashIndex + 1));
    target = target.slice(0, hashIndex);
  }
  const queryIndex = target.indexOf("?");
  if (queryIndex >= 0) {
    target = target.slice(0, queryIndex);
  }

  if (target === "") {
    // Same-page anchor.
    const sourceRoute = [...pages.entries()].find(([, page]) => page.file === sourceFile)?.[0];
    checkAnchor(anchor, sourceRoute ? pages.get(sourceRoute) : undefined, display);
    return;
  }

  if (target.startsWith("/")) {
    // Site-absolute: either a content route (normalized to trailing slash) or
    // a public asset.
    const normalized = target.endsWith("/") ? target : `${target}/`;
    const targetPage = pages.get(normalized);
    if (targetPage) {
      checkAnchor(anchor, targetPage, display);
      return;
    }
    if (anchor === null && existsSync(join(publicDir, target.slice(1)))) {
      return;
    }
    violations.push(`${display}: link target ${rawTarget} does not match any page or public asset`);
    return;
  }

  // Relative links (e.g. `../configuration/llm/`) resolve against the linking
  // page's route directory.
  const sourceEntry = [...pages.entries()].find(([, page]) => page.file === sourceFile);
  if (!sourceEntry) {
    return;
  }
  const [sourceRoute, sourcePage] = sourceEntry;
  const normalized = resolveRelativeRoute(sourceRoute, sourcePage.isIndex, target);
  const targetPage = pages.get(normalized);
  if (targetPage) {
    checkAnchor(anchor, targetPage, display);
  } else {
    violations.push(`${display}: relative link target ${rawTarget} does not match any page`);
  }
}

for (const [route, page] of pages) {
  if (route === "/") {
    continue; // index.astro has no markdown links to check beyond its own markup
  }
  const displayPath = relative(siteRoot, page.file).replaceAll("\\", "/");
  const source = stripCodeFences(readFileSync(page.file, "utf8"));

  // Markdown links and images: [text](target) / ![alt](target)
  for (const match of source.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)[^)]*\)/gu)) {
    checkTarget(match[3], page.file, `${displayPath} [${match[2].slice(0, 40)}]`);
  }
  // MDX/HTML attributes: href="..." and src="..."
  for (const match of source.matchAll(/(?:href|src)="([^"]+)"/gu)) {
    checkTarget(match[1], page.file, `${displayPath} ${match[0].slice(0, 60)}`);
  }
}

// ---------------------------------------------------------------------------
// Sidebar coverage (astro.config.mjs)
// ---------------------------------------------------------------------------

const astroConfig = readFileSync(join(siteRoot, "astro.config.mjs"), "utf8");
// Entries appear both as `slug: "..."` on their own line and inline as
// `{ slug: "...", translations: {...} }`, so match anywhere.
const sidebarSlugs = [...astroConfig.matchAll(/slug:\s*"([^"]+)"/gu)].map((m) => m[1]);

for (const slug of sidebarSlugs) {
  for (const locale of pagesByLocale.keys()) {
    if (!pagesByLocale.get(locale).has(slug)) {
      violations.push(`astro.config.mjs: sidebar slug \`${slug}\` has no ${locale} page`);
    }
  }
}
for (const [locale, slugs] of pagesByLocale) {
  for (const slug of slugs) {
    if (!sidebarSlugs.includes(slug)) {
      violations.push(`astro.config.mjs: ${locale} page \`${slug}\` is not referenced by the sidebar`);
    }
  }
}

if (violations.length > 0) {
  console.error("Internal link validation failed:");
  for (const message of violations) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

console.log(
  `Internal links OK: ${pages.size} pages, ${sidebarSlugs.length} sidebar entries, all internal links and anchors resolve.`,
);

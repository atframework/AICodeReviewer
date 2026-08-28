// Enforce the documented bilingual contribution rules (M11-P6 "贡献规则自动化"
// in docs/ai/documentation-site-plan.md §8; rules recorded in
// .agents/skills/docs-writing-style/SKILL.md §1 and §3.4 of the site plan).
// Zero dependencies.
//
// Checks, for every page pair under src/content/docs/{en,zh-cn}/:
//   1. both locales contain the same set of page files;
//   2. the page pair has the same number of fenced code blocks;
//   3. machine tokens inside code blocks (config keys, ENV_VARS, --flags,
//      /abs/paths) are identical across locales — translated comments,
//      placeholder values, and locale-specific example values such as
//      `language: zh-CN` are intentionally allowed to differ;
//   4. every fence in .mdx files carries a language tag (markdownlint MD040
//      only reaches *.md via the root glob);
//   5. prose avoids the machine-checkable subset of the banned filler-word
//      lists from the docs-writing-style skill (zh §3, en §4). The subset is
//      the unambiguous words only — context-dependent bans (核心、进行,
//      "simply", sentence-initial "moreover", ...) stay human-reviewed.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import {
  extractFencedBlocks,
  extractMachineTokens,
  stripCommentLines,
} from "./validation-helpers.mjs";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const docsDir = join(siteRoot, "src", "content", "docs");
const locales = ["en", "zh-cn"];

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

function display(file) {
  return relative(process.cwd(), file).replaceAll("\\", "/");
}

// ---------------------------------------------------------------------------
// 1. File parity between locales
// ---------------------------------------------------------------------------

const filesByLocale = new Map();
for (const locale of locales) {
  const set = new Set();
  for (const file of walk(join(docsDir, locale))) {
    set.add(relative(join(docsDir, locale), file).replaceAll("\\", "/"));
  }
  filesByLocale.set(locale, set);
}
const [enFiles, zhFiles] = locales.map((l) => filesByLocale.get(l));
for (const rel of enFiles) {
  if (!zhFiles.has(rel)) {
    violations.push(`src/content/docs/zh-cn/${rel}: missing; every page must exist in both locales`);
  }
}
for (const rel of zhFiles) {
  if (!enFiles.has(rel)) {
    violations.push(`src/content/docs/en/${rel}: missing; every page must exist in both locales`);
  }
}

// ---------------------------------------------------------------------------
// 2-4. Per-page-pair code-block discipline + .mdx fence languages
// ---------------------------------------------------------------------------

for (const rel of enFiles) {
  if (!zhFiles.has(rel)) continue;
  const enBlocks = extractFencedBlocks(readFileSync(join(docsDir, "en", rel), "utf8"));
  const zhBlocks = extractFencedBlocks(readFileSync(join(docsDir, "zh-cn", rel), "utf8"));
  if (enBlocks.length !== zhBlocks.length) {
    violations.push(
      `${rel}: ${enBlocks.length} fenced blocks in en vs ${zhBlocks.length} in zh-cn;` +
        " structural updates must land in both locales",
    );
    continue;
  }
  for (let i = 0; i < enBlocks.length; i++) {
    const enTokens = extractMachineTokens(stripCommentLines(enBlocks[i].body));
    const zhTokens = extractMachineTokens(stripCommentLines(zhBlocks[i].body));
    if (JSON.stringify(enTokens) !== JSON.stringify(zhTokens)) {
      const enOnly = enTokens.filter((t) => !zhTokens.includes(t));
      const zhOnly = zhTokens.filter((t) => !enTokens.includes(t));
      const parts = [];
      if (enOnly.length > 0) parts.push(`only in en: ${enOnly.slice(0, 5).join(", ")}`);
      if (zhOnly.length > 0) parts.push(`only in zh-cn: ${zhOnly.slice(0, 5).join(", ")}`);
      violations.push(
        `${rel}: code block #${i + 1} machine tokens diverge (${parts.join("; ")});` +
          " config keys, env vars, flags, and paths must stay identical across locales",
      );
    }
  }
}

for (const locale of locales) {
  for (const file of walk(join(docsDir, locale))) {
    if (!file.endsWith(".mdx")) continue;
    const blocks = extractFencedBlocks(readFileSync(file, "utf8"));
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].info === "") {
        violations.push(
          `${display(file)}: fenced block #${i + 1} has no language tag (markdownlint MD040 does not glob .mdx)`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Banned filler words in prose (machine-checkable subset)
// ---------------------------------------------------------------------------

const bannedZh = [
  "强大", "高效", "灵活", "便捷", "丰富", "完善", "智能", "优雅", "无缝", "轻松",
  "极大地", "显著", "至关重要", "赋能", "助力", "打造", "抓手",
];
const bannedEn = [
  /\bdelve\b/giu,
  /\bleverag/giu,
  /\bseamless/giu,
  /\brobust/giu,
  /\bstreamline/giu,
  /\bunlock/giu,
  /\belevate\b/giu,
  /\bempower/giu,
  /\bcutting-edge/giu,
  /\bgame-changer/giu,
  /\brealm\b/giu,
  /\bjourney\b/giu,
  /\bcrucial\b/giu,
  /\bvital\b/giu,
  /\bcomprehensive\b/giu,
  /\butilize\b/giu,
  /\bfacilitate\b/giu,
  /\beffortless/giu,
];

const stripFences = (source) =>
  source.replace(/^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~).*$/gmu, "");

for (const locale of locales) {
  for (const file of walk(join(docsDir, locale))) {
    const source = readFileSync(file, "utf8");
    const prose = stripFences(source);
    for (const [index, line] of prose.split(/\r?\n/u).entries()) {
      if (locale === "zh-cn") {
        for (const word of bannedZh) {
          if (line.includes(word)) {
            violations.push(
              `${display(file)}:${index + 1}: banned filler word "${word}" (docs-writing-style §3); replace with concrete wording`,
            );
          }
        }
      } else {
        for (const pattern of bannedEn) {
          pattern.lastIndex = 0;
          const match = pattern.exec(line);
          if (match) {
            violations.push(
              `${display(file)}:${index + 1}: banned filler word "${match[0]}" (docs-writing-style §4); replace with concrete wording`,
            );
          }
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Bilingual consistency validation failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Bilingual consistency OK: ${enFiles.size} page pairs, matching code-block counts and machine tokens, no banned filler words.`,
);

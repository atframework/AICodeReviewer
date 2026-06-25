import { fixAndValidateMarkdown } from "@aicr/core";

const FENCE_LINE_RE = /^(\s{0,3})(`{3,}|~{3,})/u;

interface Segment {
  readonly kind: "text" | "code";
  readonly value: string;
}

function splitByFences(content: string): Segment[] {
  const segments: Segment[] = [];
  const lines = content.split("\n");
  let buffer: string[] = [];
  let inFence = false;
  let fenceMarker: string | undefined;

  function flushAs(kind: "text" | "code"): void {
    if (buffer.length === 0) return;
    segments.push({ kind, value: buffer.join("\n") });
    buffer = [];
  }

  for (const line of lines) {
    const fenceMatch = FENCE_LINE_RE.exec(line);
    if (!inFence && fenceMatch && fenceMatch[2]) {
      flushAs("text");
      fenceMarker = fenceMatch[2][0];
      buffer.push(line);
      inFence = true;
    } else if (inFence && fenceMatch && fenceMatch[2] && fenceMatch[2].startsWith(fenceMarker ?? "")) {
      buffer.push(line);
      flushAs("code");
      inFence = false;
      fenceMarker = undefined;
    } else {
      buffer.push(line);
    }
  }

  flushAs(inFence ? "code" : "text");
  return segments;
}

function applyTextTransform(content: string, transform: (text: string) => string): string {
  if (!content.includes("```") && !content.includes("~~~")) {
    return transform(content);
  }

  const segments = splitByFences(content);
  return segments
    .map((segment) => (segment.kind === "text" ? transform(segment.value) : segment.value))
    .join("\n");
}

// ---- Feishu / Lark ----

// Feishu interactive-card Markdown supports a broad subset ONLY when the card
// uses the JSON 2.0 schema (`card.schema = "2.0"`, elements under
// `card.body.elements`). With 2.0 it renders headings, bold/italic/strikethrough,
// links, images, dividers, ordered/unordered lists, blockquotes, tables, fenced
// code blocks WITH language-based syntax highlighting (```cpp …), and inline
// code (`code`). Under the legacy 1.0 schema inline code and highlighting do
// NOT render (single backticks show literally), which is why AICR sends 2.0.
// TABLE_DIVIDER_RE / TABLE_ROW_RE stay shared with the other IM transformers.

const TABLE_DIVIDER_RE = /^\|[\s\-:|]+\|$/mu;
const TABLE_ROW_RE = /^\|.+\|$/mu;

/**
 * Normalize Markdown for the Feishu interactive-card Markdown component.
 *
 * Because Feishu JSON 2.0 cards render headings, lists, blockquotes, tables,
 * inline code and fenced code blocks natively, no element degradation is
 * applied. Only trailing spaces / consecutive blank lines are cleaned via
 * {@link fixAndValidateMarkdown}. Callers MUST send the card with
 * `schema: "2.0"` or inline code / highlighting will not render.
 */
export function toFeishuMarkdown(content: string): string {
  const fixed = fixAndValidateMarkdown(content);
  return fixed.replace(/\n{3,}/gu, "\n\n").trim();
}

// ---- WeCom ----

// WeCom webhook "markdown" type supports: headings, bold, links, inline-code, quotes, font-colour.
// Does NOT support: code blocks, lists, tables, italics, horizontal rules.
// WeCom "markdown_v2" supports almost full standard Markdown but drops @mentions and font colours.
// We keep the conservative "markdown" type and only degrade elements that break readability.

function wecomFixTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inTable = false;
  let tableRows: string[] = [];

  function flushTable(): void {
    if (tableRows.length === 0) return;
    const dataRows = tableRows.filter((row) => !TABLE_DIVIDER_RE.test(row));
    for (const row of dataRows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length > 0) {
        out.push(cells.join("  ·  "));
      }
    }
    tableRows = [];
  }

  for (const line of lines) {
    if (TABLE_ROW_RE.test(line)) {
      inTable = true;
      tableRows.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
      }
      out.push(line);
    }
  }
  if (inTable) {
    flushTable();
  }

  return out.join("\n");
}

/**
 * Convert standard Markdown into WeCom webhook Markdown subset.
 *
 * Transformations applied:
 * - Tables → plain-text rows (WeCom markdown does not render tables)
 * - Trailing spaces / consecutive blank lines cleaned via {@link fixAndValidateMarkdown}
 *
 * Headings, bold, links, inline code and quotes are left as-is because
 * WeCom `msgtype=markdown` already renders them correctly.
 */
export function toWeComMarkdown(content: string): string {
  const fixed = fixAndValidateMarkdown(content);
  const transformed = applyTextTransform(fixed, (text) => wecomFixTables(text));
  return transformed.trim();
}

// ---- DingTalk ----

// DingTalk custom-robot markdown supports: headings, bold, italic, links, images,
// inline-code, code blocks, ordered/unordered lists, quotes, divider.
// Does NOT support: tables.

function dingtalkFixTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inTable = false;
  let tableRows: string[] = [];

  function flushTable(): void {
    if (tableRows.length === 0) return;
    const dataRows = tableRows.filter((row) => !TABLE_DIVIDER_RE.test(row));
    for (const row of dataRows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length > 0) {
        out.push("- " + cells.join("  ·  "));
      }
    }
    tableRows = [];
  }

  for (const line of lines) {
    if (TABLE_ROW_RE.test(line)) {
      inTable = true;
      tableRows.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
      }
      out.push(line);
    }
  }
  if (inTable) {
    flushTable();
  }

  return out.join("\n");
}

/**
 * Convert standard Markdown into DingTalk robot Markdown subset.
 *
 * Transformations applied:
 * - Tables → plain-text list rows (DingTalk markdown does not render tables)
 * - Trailing spaces / consecutive blank lines cleaned via {@link fixAndValidateMarkdown}
 */
export function toDingTalkMarkdown(content: string): string {
  const fixed = fixAndValidateMarkdown(content);
  const transformed = applyTextTransform(fixed, (text) => dingtalkFixTables(text));
  return transformed.trim();
}

// ---- Slack ----

// Slack mrkdwn is NOT standard Markdown.
// Supported: *bold*, _italic_, `code`, ```code blocks```, <url|label> links,
// > quotes, - lists, --- divider.
// Does NOT support: headings (#), [text](url) links, tables.

const SLACK_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/gu;
const SLACK_HEADING_RE = /^(#{1,6})\s+(.+)$/gmu;
const SLACK_BLOCKQUOTE_RE = /^>[ \t]?(.*)$/gmu;

function slackFixLinks(text: string): string {
  return text.replace(SLACK_LINK_RE, (_match, label: string, url: string) => {
    return `<${url}|${label}>`;
  });
}

function slackFixHeadings(text: string): string {
  return text.replace(SLACK_HEADING_RE, (_match, _hashes: string, title: string) => {
    return `*${title.trim()}*`;
  });
}

function slackFixBlockquotes(text: string): string {
  return text.replace(SLACK_BLOCKQUOTE_RE, (_match, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return "";
    return `_${trimmed}_`;
  });
}

function slackFixTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inTable = false;
  let tableRows: string[] = [];

  function flushTable(): void {
    if (tableRows.length === 0) return;
    const dataRows = tableRows.filter((row) => !TABLE_DIVIDER_RE.test(row));
    for (const row of dataRows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length > 0) {
        out.push(cells.join("  ·  "));
      }
    }
    tableRows = [];
  }

  for (const line of lines) {
    if (TABLE_ROW_RE.test(line)) {
      inTable = true;
      tableRows.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
      }
      out.push(line);
    }
  }
  if (inTable) {
    flushTable();
  }

  return out.join("\n");
}

/**
 * Convert standard Markdown into Slack mrkdwn subset.
 *
 * Transformations applied:
 * - Headings (`# …` → `*…*`)
 * - Links (`[text](url)` → `<url|text>`)
 * - Blockquotes (`> …` → `_…_`)
 * - Tables → plain-text rows
 * - Trailing spaces / consecutive blank lines cleaned via {@link fixAndValidateMarkdown}
 */
export function toSlackMarkdown(content: string): string {
  const fixed = fixAndValidateMarkdown(content);
  let transformed = applyTextTransform(fixed, (text) => {
    let t = slackFixHeadings(text);
    t = slackFixLinks(t);
    t = slackFixBlockquotes(t);
    t = slackFixTables(t);
    return t;
  });
  transformed = transformed.replace(/\n{3,}/gu, "\n\n");
  return transformed.trim();
}

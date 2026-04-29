export interface MarkdownFixResult {
  readonly fixed: string;
  readonly changed: boolean;
  readonly warnings: readonly string[];
  readonly violations: readonly MarkdownViolation[];
}

export interface MarkdownViolation {
  readonly rule: string;
  readonly line: number;
  readonly detail: string;
  readonly fixable: boolean;
}

const TRAILING_SPACE_RE = /[ \t]+$/gmu;
const CONSECUTIVE_BLANK_LINES_RE = /\n{3,}/gu;
const BARE_URL_RE = /(?<![<([`])(https?:\/\/[^\s<>[\]]+)(?![\])\s,;.:!?)>`])/giu;
const HEADING_WITHOUT_SPACE_RE = /^(#{1,6})([^ #\n])/gmu;
const HEADING_WITH_TRAILING_HASH_RE = /[ \t]+#+[ \t]*$/gmu;
const LIST_MARKER_WITHOUT_SPACE_RE = /^(\s*[-*+]|\s*\d+\.)(?=[^ \n])/gmu;
const INCONSISTENT_HEADING_INDENT_RE = /^( {1,3})(#{1,6}\s)/gmu;

function fixTrailingSpaces(content: string): { text: string; changed: boolean } {
  if (!TRAILING_SPACE_RE.test(content)) return { text: content, changed: false };
  return { text: content.replace(TRAILING_SPACE_RE, ""), changed: true };
}

function fixConsecutiveBlankLines(content: string): { text: string; changed: boolean } {
  if (!CONSECUTIVE_BLANK_LINES_RE.test(content)) return { text: content, changed: false };
  return { text: content.replace(CONSECUTIVE_BLANK_LINES_RE, "\n\n"), changed: true };
}

function fixHeadingSpacing(content: string): { text: string; changed: boolean } {
  let changed = false;
  let text = content.replace(HEADING_WITHOUT_SPACE_RE, (_match, hashes: string, after: string) => {
    changed = true;
    return `${hashes} ${after}`;
  });
  text = text.replace(HEADING_WITH_TRAILING_HASH_RE, () => {
    changed = true;
    return "";
  });
  return { text, changed };
}

function fixListMarkerSpacing(content: string): { text: string; changed: boolean } {
  let changed = false;
  const text = content.replace(LIST_MARKER_WITHOUT_SPACE_RE, (match: string, marker: string) => {
    changed = true;
    return `${marker} `;
  });
  return { text, changed };
}

function fixTrailingNewline(content: string): { text: string; changed: boolean } {
  if (!content.includes("\n") || content.length === 0 || content.endsWith("\n")) {
    return { text: content, changed: false };
  }
  return { text: `${content}\n`, changed: true };
}

function detectBareUrls(content: string): string[] {
  const warnings: string[] = [];
  if (BARE_URL_RE.test(content)) {
    warnings.push("MD034: bare URLs detected; review recommended");
  }
  return warnings;
}

function detectUnbalancedBackticks(content: string): string[] {
  const warnings: string[] = [];
  const unbalancedBackticks = (content.match(/`{1,2}[^`\n]+$/gmu) ?? []).length;
  if (unbalancedBackticks > 0) {
    warnings.push("MD011: possible unbalanced inline code backticks");
  }
  return warnings;
}

function detectInconsistentHeadingIndent(content: string): string[] {
  const warnings: string[] = [];
  if (INCONSISTENT_HEADING_INDENT_RE.test(content)) {
    warnings.push("MD027: inconsistent heading indent detected");
  }
  return warnings;
}

export function fixMarkdown(content: string): MarkdownFixResult {
  const violations: MarkdownViolation[] = [];
  const warnings: string[] = [];
  let fixed = content;
  let changed = false;

  const trailing = fixTrailingSpaces(fixed);
  if (trailing.changed) {
    fixed = trailing.text;
    changed = true;
  }

  const blankLines = fixConsecutiveBlankLines(fixed);
  if (blankLines.changed) {
    fixed = blankLines.text;
    changed = true;
  }

  const headingSpacing = fixHeadingSpacing(fixed);
  if (headingSpacing.changed) {
    fixed = headingSpacing.text;
    changed = true;
    violations.push({
      rule: "MD018/MD051",
      line: 0,
      detail: "Fixed heading spacing",
      fixable: true,
    });
  }

  const listSpacing = fixListMarkerSpacing(fixed);
  if (listSpacing.changed) {
    fixed = listSpacing.text;
    changed = true;
    violations.push({
      rule: "MD004/MD005/MD006/MD007/MD030",
      line: 0,
      detail: "Fixed list marker spacing",
      fixable: true,
    });
  }

  const trailingNl = fixTrailingNewline(fixed);
  if (trailingNl.changed) {
    fixed = trailingNl.text;
    changed = true;
  }

  warnings.push(...detectBareUrls(fixed));
  warnings.push(...detectUnbalancedBackticks(fixed));
  warnings.push(...detectInconsistentHeadingIndent(fixed));

  return { fixed, changed, warnings, violations };
}

export function fixAndValidateMarkdown(content: string): string {
  const result = fixMarkdown(content);
  return result.fixed;
}

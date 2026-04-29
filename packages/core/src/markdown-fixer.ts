export interface MarkdownFixResult {
  readonly fixed: string;
  readonly changed: boolean;
  readonly warnings: readonly string[];
}

const TRAILING_SPACE_RE = /[ \t]+$/gmu;
const CONSECUTIVE_BLANK_LINES_RE = /\n{3,}/gu;
const BARE_URL_RE = /(?<![<([`])(https?:\/\/[^\s<>[\]]+)(?![\])\s,;.:!?)>`])/giu;

export function fixMarkdown(content: string): MarkdownFixResult {
  const warnings: string[] = [];
  let fixed = content;
  let changed = false;

  if (CONSECUTIVE_BLANK_LINES_RE.test(fixed)) {
    fixed = fixed.replace(CONSECUTIVE_BLANK_LINES_RE, "\n\n");
    changed = true;
  }

  if (TRAILING_SPACE_RE.test(fixed)) {
    fixed = fixed.replace(TRAILING_SPACE_RE, "");
    changed = true;
  }

  if (BARE_URL_RE.test(fixed)) {
    warnings.push("MD034: bare URLs detected; review recommended");
  }

  const unbalancedBackticks = (fixed.match(/`{1,2}[^`\n]+$/gmu) ?? []).length;
  if (unbalancedBackticks > 0) {
    warnings.push("MD011: possible unbalanced inline code backticks");
  }

  if (fixed.includes("\n") && fixed.length > 0 && !fixed.endsWith("\n")) {
    fixed += "\n";
    changed = true;
  }

  return { fixed, changed, warnings };
}

export function fixAndValidateMarkdown(content: string): string {
  const result = fixMarkdown(content);
  return result.fixed;
}

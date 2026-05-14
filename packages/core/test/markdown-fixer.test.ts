import { describe, expect, it } from "vitest";
import { fixMarkdown, fixAndValidateMarkdown } from "../src/markdown-fixer.js";

describe("fixMarkdown", () => {
  it("removes trailing whitespace from lines", () => {
    const result = fixMarkdown("hello   \nworld\t\n");
    expect(result.fixed).toBe("hello\nworld\n");
    expect(result.changed).toBe(true);
  });

  it("collapses multiple consecutive blank lines", () => {
    const result = fixMarkdown("line1\n\n\n\nline2\n");
    expect(result.fixed).toBe("line1\n\nline2\n");
    expect(result.changed).toBe(true);
  });

  it("ensures multi-line content ends with a newline", () => {
    const result = fixMarkdown("# Title\n\nParagraph without trailing newline");
    expect(result.fixed).toBe("# Title\n\nParagraph without trailing newline\n");
    expect(result.changed).toBe(true);
  });

  it("returns unchanged for already-valid markdown", () => {
    const valid = "# Title\n\nA paragraph with **bold** text.\n\n- list item 1\n- list item 2\n";
    const result = fixMarkdown(valid);
    expect(result.fixed).toBe(valid);
    expect(result.changed).toBe(false);
  });

  it("returns unchanged for empty string", () => {
    const result = fixMarkdown("");
    expect(result.fixed).toBe("");
    expect(result.changed).toBe(false);
  });

  it("warns about bare URLs", () => {
    const result = fixMarkdown("See https://example.com/page for details.\n");
    expect(result.warnings).toContain("MD034: bare URLs detected; review recommended");
  });

  it("warns about possible unbalanced backticks", () => {
    const result = fixMarkdown("Here is `unclosed inline code\n");
    expect(result.warnings).toContain("MD011: possible unbalanced inline code backticks");
  });

  it("does not modify indented code blocks", () => {
    const input = "Normal line\n    indented code\nMore text\n";
    const result = fixMarkdown(input);
    expect(result.fixed).toBe(input);
    expect(result.changed).toBe(false);
  });

  it("handles content with no warnings", () => {
    const result = fixMarkdown("# Title\n\nClean content.\n");
    expect(result.warnings).toHaveLength(0);
  });

  it("preserves single-line content without adding newline", () => {
    const result = fixMarkdown("single line");
    expect(result.fixed).toBe("single line");
    expect(result.changed).toBe(false);
  });

  it("collapses many blank lines to just two", () => {
    const result = fixMarkdown("a\n\n\n\n\n\nb\n");
    expect(result.fixed).toBe("a\n\nb\n");
    expect(result.changed).toBe(true);
  });

  it("fixes heading without space after hash", () => {
    const result = fixMarkdown("#Title\n");
    expect(result.fixed).toBe("# Title\n");
    expect(result.changed).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("fixes heading with trailing hash", () => {
    const result = fixMarkdown("# Title #\n");
    expect(result.fixed).toBe("# Title\n");
    expect(result.changed).toBe(true);
  });

  it("fixes list marker without space", () => {
    const result = fixMarkdown("-item\n");
    expect(result.fixed).toBe("- item\n");
    expect(result.changed).toBe(true);
  });

  it("fixes asterisk list marker without space", () => {
    const result = fixMarkdown("*item\n");
    expect(result.fixed).toBe("* item\n");
    expect(result.changed).toBe(true);
  });

  it("does not break bold markers at line start", () => {
    const result = fixMarkdown("**Reviewed**: [Commit abc](https://example.com)\n**Author**: Someone <a@b>\n**Branch**: main\n");
    expect(result.fixed).toBe("**Reviewed**: [Commit abc](https://example.com)\n**Author**: Someone <a@b>\n**Branch**: main\n");
    expect(result.changed).toBe(false);
  });

  it("does not break bold-italic markers at line start", () => {
    const result = fixMarkdown("***Important*** note\n");
    expect(result.fixed).toBe("***Important*** note\n");
    expect(result.changed).toBe(false);
  });

  it("does not break thematic breaks", () => {
    const input = "Intro\n\n---\n\nSummary text.\n";
    const result = fixMarkdown(input);
    expect(result.fixed).toBe(input);
    expect(result.changed).toBe(false);
  });

  it("returns violations array", () => {
    const result = fixMarkdown("#Title\n");
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("warns about inconsistent heading indent", () => {
    const result = fixMarkdown(" # Title\n");
    expect(result.warnings).toContain("MD027: inconsistent heading indent detected");
  });

  it("handles combined fixes", () => {
    const input = "#Title   \n\n\n-item\n";
    const result = fixMarkdown(input);
    expect(result.fixed).toBe("# Title\n\n- item\n");
    expect(result.changed).toBe(true);
  });
});

describe("fixAndValidateMarkdown", () => {
  it("returns fixed content as string", () => {
    const result = fixAndValidateMarkdown("hello   \n\n\n\nworld");
    expect(result).toBe("hello\n\nworld\n");
  });

  it("returns same content when nothing to fix", () => {
    const content = "# Title\n\nContent.\n";
    expect(fixAndValidateMarkdown(content)).toBe(content);
  });

  it("fixes heading and list issues", () => {
    const result = fixAndValidateMarkdown("#Title\n-item\n");
    expect(result).toBe("# Title\n\n- item\n");
  });

  it("does not modify heading-like content inside fenced code blocks", () => {
    const input = "# Real Heading\n\n```\n#NotAHeading\n-notAList\n```\n\n#FixMe\n";
    const result = fixAndValidateMarkdown(input);
    expect(result).toContain("```\n#NotAHeading\n-notAList\n```");
    expect(result).toContain("# FixMe");
  });

  it("does not modify list-like content inside tilde fenced code blocks", () => {
    const input = "Intro\n\n~~~\n-item\n#hash\n~~~\n\n-fixme\n";
    const result = fixAndValidateMarkdown(input);
    expect(result).toContain("~~~\n-item\n#hash\n~~~");
    expect(result).toContain("- fixme");
  });

  it("handles unterminated fenced block by leaving its body untouched", () => {
    const input = "Intro\n\n```\n#noTouch\n-stillCode\n";
    const result = fixAndValidateMarkdown(input);
    expect(result).toContain("```\n#noTouch\n-stillCode");
  });

  it("preserves bold summary header from template rendering", () => {
    const input = "## AI Code Review Report\n\n**Reviewed**: [Commit c0a7ca4](https://example.com)\n**Author**: Yang <yang@n>\n**Branch**: main\n\n---\n\nSummary text.\n";
    const result = fixAndValidateMarkdown(input);
    expect(result).toBe(input);
  });

  it("inserts blank lines around headings that lack them", () => {
    const input = "## Heading\ncontent\n## Another\nmore";
    const result = fixAndValidateMarkdown(input);
    expect(result).toBe("## Heading\n\ncontent\n\n## Another\n\nmore\n");
  });

  it("does not duplicate blank lines around already-spaced headings", () => {
    const input = "## Heading\n\ncontent\n\n## Another\n\nmore\n";
    const result = fixAndValidateMarkdown(input);
    expect(result).toBe(input);
  });

  it("fixes heading blanks inside fenced code blocks only for text segments", () => {
    const input = "## Title\n```\n## not a heading\n```\n## After\ncontent";
    const result = fixAndValidateMarkdown(input);
    expect(result).toContain("## not a heading");
    expect(result).toContain("## Title\n\n```\n## not a heading\n```\n\n## After\n\ncontent");
  });

  it("inserts blank lines around headings produced by LLM summaries", () => {
    const input = "发现1个中等问题\n\n## 审查范围\n本次审查了 p4:change-commit:6484。\n\n## 发现问题\n中等问题: 描述\n\n## 问题详情\n`file:307` 的内容";
    const result = fixAndValidateMarkdown(input);
    expect(result).toContain("## 审查范围\n\n本次审查了");
    expect(result).toContain("## 发现问题\n\n中等问题");
    expect(result).toContain("## 问题详情\n\n`file:307`");
  });
});

import { describe, expect, it } from "vitest";

import { toFeishuMarkdown, toWeComMarkdown } from "../src/im-markdown.js";

describe("toFeishuMarkdown", () => {
  it("preserves ATX headings (Feishu JSON 2.0 renders them natively)", () => {
    const input = "## 发现的问题\n### 中等严重度（1个）\nfile.cpp:54 - issue";
    const result = toFeishuMarkdown(input);

    expect(result).toContain("## 发现的问题");
    expect(result).toContain("### 中等严重度（1个）");
  });

  it("preserves blockquotes (Feishu JSON 2.0 renders them natively)", () => {
    const input = "> This is a quote";
    const result = toFeishuMarkdown(input);

    expect(result).toContain("> This is a quote");
  });

  it("preserves inline code (renders as code under JSON 2.0)", () => {
    const input = "See `GameplayTagsManager.h` for details.";
    const result = toFeishuMarkdown(input);

    expect(result).toContain("`GameplayTagsManager.h`");
  });

  it("preserves code fences with language for syntax highlighting", () => {
    const input = "```cpp\nconst x = 1;\n```";
    const result = toFeishuMarkdown(input);

    expect(result).toContain("```cpp");
    expect(result).toContain("const x = 1;");
  });

  it("does not transform headings inside code fences", () => {
    const input = "```\n## not a heading\n```";
    const result = toFeishuMarkdown(input);

    expect(result).toContain("## not a heading");
  });

  it("collapses consecutive blank lines", () => {
    const input = "line1\n\n\n\nline2";
    const result = toFeishuMarkdown(input);

    expect(result).not.toContain("\n\n\n");
  });

  it("preserves tables (Feishu JSON 2.0 renders them natively)", () => {
    const input = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = toFeishuMarkdown(input);

    expect(result).toContain("| A | B |");
    expect(result).toContain("|---|---|");
    expect(result).toContain("| 1 | 2 |");
  });

  it("handles mixed content correctly", () => {
    const input = [
      "## Summary",
      "",
      "Some **bold** text with `code`.",
      "",
      "### Details",
      "",
      "- item 1",
      "- item 2",
      "",
      "> A quote",
      "",
      "```cpp",
      "int x = 0;",
      "```",
    ].join("\n");

    const result = toFeishuMarkdown(input);

    expect(result).toContain("## Summary");
    expect(result).toContain("### Details");
    expect(result).toContain("> A quote");
    expect(result).toContain("```cpp");
    expect(result).toContain("int x = 0;");
    expect(result).toContain("**bold**");
    expect(result).toContain("`code`");
  });
});

describe("toWeComMarkdown", () => {
  it("preserves ATX headings (WeCom supports them natively)", () => {
    const input = "## Summary\n### Details";
    const result = toWeComMarkdown(input);

    expect(result).toContain("## Summary");
    expect(result).toContain("### Details");
  });

  it("converts tables to plain-text rows", () => {
    const input = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = toWeComMarkdown(input);

    expect(result).not.toContain("|---|");
    expect(result).toContain("A  ·  B");
    expect(result).toContain("1  ·  2");
  });

  it("preserves code fences without transforming content inside", () => {
    const input = "```ts\n| A | B |\n|---|---|\n```";
    const result = toWeComMarkdown(input);

    expect(result).toContain("| A | B |");
    expect(result).toContain("|---|---|");
  });

  it("preserves bold, links, inline code and blockquotes", () => {
    const input = "**bold** [link](https://example.com) `code`\n> quote";
    const result = toWeComMarkdown(input);

    expect(result).toContain("**bold**");
    expect(result).toContain("[link](https://example.com)");
    expect(result).toContain("`code`");
    expect(result).toContain("> quote");
  });

  it("handles mixed content with tables and headings", () => {
    const input = [
      "## Review Summary",
      "",
      "| File | Severity |",
      "|------|----------|",
      "| a.ts | high     |",
      "",
      "### Details",
      "- item 1",
    ].join("\n");

    const result = toWeComMarkdown(input);

    expect(result).toContain("## Review Summary");
    expect(result).toContain("File  ·  Severity");
    expect(result).toContain("a.ts  ·  high");
    expect(result).not.toContain("|------|");
    expect(result).toContain("### Details");
  });
});

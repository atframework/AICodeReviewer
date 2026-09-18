import { describe, expect, it } from "vitest";

import { markdownDocumentBody, markdownDocumentString, parseMarkdownDocument } from "../src/markdown-document.js";

describe("parseMarkdownDocument", () => {
  it("returns the whole text as the body when no frontmatter opens the document", () => {
    const parsed = parseMarkdownDocument("# Title\n\nBody {{value}}.\n");
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe("# Title\n\nBody {{value}}.\n");
    expect(parsed.issue).toBeUndefined();
  });

  it("does not treat a leading --- line without a trailing newline as an opener", () => {
    const parsed = parseMarkdownDocument("---");
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe("---");
    expect(parsed.issue).toBeUndefined();
  });

  it("parses name and description metadata and strips the block from the body", () => {
    const parsed = parseMarkdownDocument("---\nname: 默认模板\ndescription: 汇总输出\n---\nSummary {{run.id}}\n");
    expect(parsed.meta).toEqual({ name: "默认模板", description: "汇总输出" });
    expect(parsed.body).toBe("Summary {{run.id}}\n");
    expect(parsed.issue).toBeUndefined();
  });

  it("handles CRLF fences and bodies", () => {
    const parsed = parseMarkdownDocument("---\r\nname: crlf\r\n---\r\nbody line\r\n");
    expect(parsed.meta).toEqual({ name: "crlf" });
    expect(parsed.body).toBe("body line\r\n");
  });

  it("ignores unknown metadata keys while keeping known ones", () => {
    const parsed = parseMarkdownDocument("---\nname: x\nowner: team\n---\nbody\n");
    expect(parsed.meta).toEqual({ name: "x" });
    expect(parsed.body).toBe("body\n");
  });

  it("drops blank name/description values from meta", () => {
    const parsed = parseMarkdownDocument("---\nname: '  '\ndescription: ''\n---\nbody\n");
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe("body\n");
  });

  it("treats an empty frontmatter block as valid metadata-less content", () => {
    const parsed = parseMarkdownDocument("---\n---\nbody only\n");
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe("body only\n");
    expect(parsed.issue).toBeUndefined();
  });

  it("flags an unclosed frontmatter fence and keeps the whole text as the body", () => {
    const text = "---\nname: broken\nno closing fence\n";
    const parsed = parseMarkdownDocument(text);
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe(text);
    expect(parsed.issue).toContain("not closed");
  });

  it("flags invalid frontmatter YAML and keeps the whole text as the body", () => {
    const text = "---\nname: [unclosed\n---\nbody\n";
    const parsed = parseMarkdownDocument(text);
    expect(parsed.body).toBe(text);
    expect(parsed.issue).toContain("invalid");
  });

  it("flags a non-mapping frontmatter block and keeps the whole text as the body", () => {
    const text = "---\n- item\n---\nbody\n";
    const parsed = parseMarkdownDocument(text);
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe(text);
    expect(parsed.issue).toContain("mapping");
  });

  it("closes the block at the first exact --- fence, not at a thematic break with trailing text", () => {
    const parsed = parseMarkdownDocument("---\nname: a\n---\nbody\n--- more\ntail\n");
    expect(parsed.body).toBe("body\n--- more\ntail\n");
  });
});

describe("markdownDocumentBody", () => {
  it("strips frontmatter and returns the runtime body", () => {
    expect(markdownDocumentBody("---\nname: x\n---\nrender me\n")).toBe("render me\n");
  });

  it("returns plain text unchanged", () => {
    expect(markdownDocumentBody("plain {{template}}\n")).toBe("plain {{template}}\n");
  });
});

describe("markdownDocumentString", () => {
  it("accepts plain text and well-formed frontmatter documents", () => {
    expect(markdownDocumentString.safeParse("plain").success).toBe(true);
    expect(markdownDocumentString.safeParse("---\nname: x\n---\nbody\n").success).toBe(true);
  });

  it("rejects documents whose frontmatter opener is unusable", () => {
    const result = markdownDocumentString.safeParse("---\nname: broken\n");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("not closed");
    }
  });
});

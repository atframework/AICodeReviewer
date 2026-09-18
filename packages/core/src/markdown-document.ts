import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Exact config locations whose keys name documents, not credential fields. */
export function isMarkdownConfigMap(path: readonly string[]): boolean {
  return path.length === 2 && ((path[0] === "outputs" && path[1] === "templates")
    || (path[0] === "prompts" && path[1] === "system"));
}

export function isMarkdownDatabaseCollection(path: readonly string[]): boolean {
  return path.length === 2 && path[0] === "entities" && (path[1] === "templates" || path[1] === "prompts");
}

// ---------------------------------------------------------------------------
// Markdown documents with YAML frontmatter (templates & named prompts).
//
// Stored template/prompt values are plain markdown text that may open with a
// frontmatter block carrying display metadata:
//
//   ---
//   name: 中文显示名
//   description: 用途说明
//   ---
//   <body used at runtime>
//
// The document id is always the storage key (database map key, entity name or
// the asset's file name/path); frontmatter never renames a document. The body
// is what the template engine / prompt loader consumes; the metadata is
// display data for the management UI only.
// ---------------------------------------------------------------------------

/** Display metadata parsed from a frontmatter block. */
export interface MarkdownDocumentMeta {
  readonly name?: string;
  readonly description?: string;
}

export interface MarkdownDocument {
  readonly meta: MarkdownDocumentMeta;
  /** Content below the frontmatter block (the whole text when absent). */
  readonly body: string;
  /** Present when the text opened with `---` but the block was unusable. */
  readonly issue?: string;
}

const FRONTMATTER_OPEN = /^---(?:\r?\n)/;

function splitFrontmatter(text: string): { readonly block: string; readonly body: string } | undefined {
  const open = FRONTMATTER_OPEN.exec(text);
  if (open === null) {
    return undefined;
  }
  const rest = text.slice(open[0].length);
  // The closing fence is a line containing exactly `---`.
  const close = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(rest);
  if (close === null) {
    return undefined;
  }
  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  return { block, body };
}

/**
 * Lenient parse: documents without a well-formed frontmatter block are
 * returned whole as the body, with `issue` set when a `---` opener was
 * present but the block could not be used (unclosed fence, invalid YAML, or a
 * non-mapping block). Unknown block keys are preserved in the raw text but
 * not surfaced in `meta`.
 */
export function parseMarkdownDocument(text: string): MarkdownDocument {
  const parts = splitFrontmatter(text);
  if (parts === undefined) {
    if (FRONTMATTER_OPEN.test(text)) {
      return { meta: {}, body: text, issue: "frontmatter block is not closed by a `---` fence" };
    }
    return { meta: {}, body: text };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(parts.block);
  } catch (error) {
    return {
      meta: {},
      body: text,
      issue: `frontmatter YAML is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (parsed === null || parsed === undefined) {
    return { meta: {}, body: parts.body };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { meta: {}, body: text, issue: "frontmatter block must be a mapping" };
  }
  const record = parsed as Record<string, unknown>;
  const meta: { name?: string; description?: string } = {};
  if (typeof record.name === "string" && record.name.trim().length > 0) {
    meta.name = record.name;
  }
  if (typeof record.description === "string" && record.description.trim().length > 0) {
    meta.description = record.description;
  }
  return { meta, body: parts.body };
}

/** Body of a stored document with any frontmatter stripped (runtime view). */
export function markdownDocumentBody(text: string): string {
  return parseMarkdownDocument(text).body;
}

/**
 * Schema for stored template/prompt documents: any string is accepted, but a
 * text that opens with `---` must carry a usable frontmatter block so save
 * surfaces reject typos instead of silently storing display-less documents.
 */
export const markdownDocumentString = z.string().superRefine((value, ctx) => {
  const parsed = parseMarkdownDocument(value);
  if (parsed.issue !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.issue });
  }
});

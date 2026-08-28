export function isSchemaLeafDocumented(node, fieldPaths, subtreeSummaries) {
  return (
    fieldPaths.has(node) ||
    [...subtreeSummaries].some((summaryPath) => node.startsWith(`${summaryPath}.`))
  );
}

export function resolveRelativeRoute(sourceRoute, sourceIsIndex, target) {
  const segments = sourceRoute.split("/").filter((segment) => segment !== "");
  if (!sourceIsIndex) {
    segments.pop();
  }
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}/`;
}

/** Frontmatter block of a Markdown/MDX page, without the `---` fences. */
export function extractFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/** First `key: value` line of a frontmatter block, value unquoted. */
export function frontmatterValue(frontmatter, key) {
  const match = frontmatter?.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  return match ? match[1].trim().replace(/^["']|["']$/gu, "") : undefined;
}

/**
 * Display width of a string for SEO length bounds: East-Asian wide/fullwidth
 * characters count as 2, everything else as 1. CJK ranges start at U+2E80;
 * fullwidth forms (U+FF00+) sit above that threshold too.
 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    width += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  }
  return width;
}

/** Fenced code blocks as `{ info, body }`; `info` is the language tag. */
export function extractFencedBlocks(source) {
  const blocks = [];
  const fence = /^(```|~~~)([^\n]*)\n([\s\S]*?)\r?\n?\1.*$/gmu;
  let match;
  while ((match = fence.exec(source)) !== null) {
    blocks.push({ info: match[2].trim(), body: match[3] });
  }
  return blocks;
}

/** Remove comment-only lines and trailing `#`/`//` comments from a block. */
export function stripCommentLines(body) {
  return body
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== "" &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("<!--")
      );
    })
    .map((line) =>
      line
        .replace(/\s+#\s.*$/u, "")
        .replace(/\s+\/\/\s.*$/u, "")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Machine tokens that must stay identical between the `en/` and `zh-cn/`
 * versions of a page's code blocks: config keys (`key:`), env-style
 * identifiers (`AICR_WEBHOOK_SECRET`), CLI flags (`--mode`), and absolute
 * paths (`/webhooks/gitea`). Translated comments, placeholder values, and
 * prose strings are deliberately ignored.
 */
export function extractMachineTokens(codeText) {
  const tokens = [];
  for (const match of codeText.matchAll(/^\s*-?\s*([\w.-]+):/gmu)) {
    tokens.push(`key:${match[1]}`);
  }
  for (const match of codeText.matchAll(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/gu)) {
    tokens.push(`env:${match[0]}`);
  }
  for (const match of codeText.matchAll(/--[a-zA-Z][\w-]*/gu)) {
    tokens.push(`flag:${match[0]}`);
  }
  for (const match of codeText.matchAll(/(?<![\w`])(\/(?:[\w.-]+\/)+[\w.-]+)/gu)) {
    tokens.push(`path:${match[1]}`);
  }
  tokens.sort();
  return tokens;
}

/** PNG dimensions from the IHDR chunk, or `null` for non-PNG buffers. */
export function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

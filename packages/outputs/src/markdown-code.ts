/** Code boundaries used by the social IM adapters, not a general Markdown parser. */
export type MarkdownCodeSegment =
  | { readonly kind: "text"; readonly raw: string }
  | {
      readonly kind: "inline_code";
      readonly raw: string;
      readonly body: string;
    }
  | {
      readonly kind: "code_block";
      readonly raw: string;
      readonly body: string;
      readonly language: string;
    };

export function splitMarkdownFences(content: string): MarkdownCodeSegment[] {
  const segments: MarkdownCodeSegment[] = [];
  const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n/gmu;
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(content))) {
    if (match.index > offset)
      segments.push({ kind: "text", raw: content.slice(offset, match.index) });
    const marker = match[1]!;
    const closing = new RegExp(
      `^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?=\\n|$)`,
      "gmu",
    );
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(content);
    const last = end ? end.index + end[0].length : content.length;
    segments.push({
      kind: "code_block",
      raw: content.slice(match.index, last),
      body: content.slice(opening.lastIndex, end?.index ?? content.length),
      language: /^[\w+#.-]+$/u.test(match[2]!.trim()) ? match[2]!.trim() : "",
    });
    offset = last;
    opening.lastIndex = last;
    if (!end) break;
  }
  if (offset < content.length)
    segments.push({ kind: "text", raw: content.slice(offset) });
  return segments;
}

export function splitMarkdownCode(content: string): MarkdownCodeSegment[] {
  return splitMarkdownFences(content).flatMap((segment) => {
    if (segment.kind !== "text") return [segment];
    const out: MarkdownCodeSegment[] = [];
    const inline = /(?<!`)(`+)([^\n]*?)\1(?!`)/gu;
    let offset = 0;
    for (const match of segment.raw.matchAll(inline)) {
      if (match.index > offset)
        out.push({ kind: "text", raw: segment.raw.slice(offset, match.index) });
      out.push({ kind: "inline_code", raw: match[0], body: match[2]! });
      offset = match.index + match[0].length;
    }
    if (offset < segment.raw.length)
      out.push({ kind: "text", raw: segment.raw.slice(offset) });
    return out;
  });
}

/** Keep source examples intact while removing publication bookkeeping from visible prose. */
export function normalizeSocialImMarkdown(content: string): string {
  const segments = splitMarkdownCode(content.replace(/\r\n?/gu, "\n"));
  return segments
    .map((segment, index) => {
      if (segment.kind !== "text") return segment.raw;
      let text = segment.raw
        .replace(/<!--[ \t]*aicr:[\s\S]*?-->/gu, "")
        .replace(/[ \t]+(?=\n)/gu, "")
        .replace(/\n{3,}/gu, "\n\n");
      if (index === 0) text = text.trimStart();
      if (index === segments.length - 1) text = text.trimEnd();
      return text;
    })
    .join("");
}

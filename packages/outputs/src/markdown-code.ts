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

export interface MarkdownLink {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly url: string;
  readonly raw: string;
}

function isEscaped(content: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function readMarkdownLink(content: string, start: number): MarkdownLink | undefined {
  if (content[start] !== "[" || isEscaped(content, start)) return undefined;
  let labelDepth = 1;
  let cursor = start + 1;
  for (; cursor < content.length; cursor += 1) {
    const char = content[cursor];
    if (char === "\n") return undefined;
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === "[") labelDepth += 1;
    if (char === "]") {
      labelDepth -= 1;
      if (labelDepth === 0) break;
    }
  }
  if (labelDepth !== 0 || content[cursor + 1] !== "(") return undefined;
  const labelEnd = cursor;
  let destinationDepth = 1;
  cursor += 2;
  for (; cursor < content.length; cursor += 1) {
    const char = content[cursor];
    if (char === "\n") return undefined;
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === "(") destinationDepth += 1;
    if (char === ")") {
      destinationDepth -= 1;
      if (destinationDepth === 0) {
        return {
          start,
          end: cursor + 1,
          label: content.slice(start + 1, labelEnd),
          url: content.slice(labelEnd + 2, cursor),
          raw: content.slice(start, cursor + 1),
        };
      }
    }
  }
  return undefined;
}

export function scanMarkdownLinks(content: string): readonly MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (let cursor = 0; cursor < content.length;) {
    const start = content.indexOf("[", cursor);
    if (start < 0) break;
    const link = readMarkdownLink(content, start);
    if (link === undefined) {
      cursor = start + 1;
      continue;
    }
    links.push(link);
    cursor = link.end;
  }
  return links;
}

export function mapMarkdownLinks(content: string, map: (link: MarkdownLink) => string): string {
  let output = "";
  let offset = 0;
  for (const link of scanMarkdownLinks(content)) {
    output += content.slice(offset, link.start) + map(link);
    offset = link.end;
  }
  return output + content.slice(offset);
}

export interface MarkdownAtom {
  readonly raw: string;
  readonly atomic: boolean;
}

export function splitMarkdownAtoms(content: string): readonly MarkdownAtom[] {
  const atoms: MarkdownAtom[] = [];
  const appendText = (raw: string): void => {
    let offset = 0;
    for (const match of raw.matchAll(/<[^<>\n]+>|&(?:amp|lt|gt);/gu)) {
      if (match.index > offset) atoms.push({ raw: raw.slice(offset, match.index), atomic: false });
      atoms.push({ raw: match[0], atomic: true });
      offset = match.index + match[0].length;
    }
    if (offset < raw.length) atoms.push({ raw: raw.slice(offset), atomic: false });
  };
  for (const segment of splitMarkdownCode(content)) {
    if (segment.kind !== "text") {
      atoms.push({ raw: segment.raw, atomic: true });
      continue;
    }
    let offset = 0;
    for (const link of scanMarkdownLinks(segment.raw)) {
      appendText(segment.raw.slice(offset, link.start));
      atoms.push({ raw: link.raw, atomic: true });
      offset = link.end;
    }
    appendText(segment.raw.slice(offset));
  }
  return atoms;
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

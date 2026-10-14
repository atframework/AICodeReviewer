import { toSlackMarkdown } from "./im-markdown.js";
import {
  normalizeSocialImMarkdown,
  splitMarkdownCode,
  splitMarkdownFences,
} from "./markdown-code.js";
import type { SocialImMessage, TelegramMessageEntity } from "./social-im.js";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const safeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !/[<>|\s]/u.test(url)
    );
  } catch {
    return false;
  }
};
const notice = "\n\n… Report truncated at the platform message size limit.";

/** Keep a host-added mention outside an unfinished template/code fence. */
function closeMentionFence(content: string): string {
  const tail = splitMarkdownFences(content).at(-1);
  if (tail?.kind !== "code_block") return content;
  const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(tail.raw)![1]!;
  const closed = new RegExp(`\\n {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, "u").test(tail.raw);
  return closed ? content : `${content}\n${marker}\n`;
}

/** Links, code spans/fences and escaped Slack controls remain indivisible during truncation. */
export function boundSocialMarkdown(
  text: string,
  limit: number,
  detailUrl?: string,
): string {
  if (text.length <= limit) return text;
  const suffix = `${notice}${detailUrl && safeUrl(detailUrl) ? `\n${detailUrl}` : ""}`;
  if (suffix.length >= limit)
    throw new Error("Social IM metadata exceeds message budget.");
  const atomic =
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|`[^`\n]*`|<[^<>\n]+>|\[[^\]\n]*\]\([^\n)]*\)|&(?:amp|lt|gt);/gu;
  let output = "";
  let offset = 0;
  const append = (value: string): boolean => {
    for (const { segment } of segmenter.segment(value)) {
      if (output.length + segment.length + suffix.length > limit) return false;
      output += segment;
    }
    return true;
  };
  for (const match of text.matchAll(atomic)) {
    if (!append(text.slice(offset, match.index)))
      return output.trimEnd() + suffix;
    if (output.length + match[0].length + suffix.length > limit)
      return output.trimEnd() + suffix;
    output += match[0];
    offset = match.index + match[0].length;
  }
  append(text.slice(offset));
  return output.trimEnd() + suffix;
}

export function toDiscordMarkdown(content: string, detailUrl?: string, authorUserId?: string): string {
  const mention = authorUserId && /^[1-9][0-9]{0,31}$/u.test(authorUserId) ? `\n\n<@${authorUserId}>` : "";
  // Escape untrusted controls before adding the separately resolved author.
  return boundSocialMarkdown(
    splitMarkdownCode(normalizeSocialImMarkdown(mention ? closeMentionFence(content) : content))
      .map((segment) =>
        segment.kind === "text"
          ? segment.raw
              .replace(/@(?=everyone|here|[!&]?\d)/gu, "@\u200b")
              .replace(/<@/gu, "<@\u200b")
          : segment.raw,
      )
      .join(""),
    1900 - mention.length,
    detailUrl,
  ) + mention;
}

export function toBoundedSlackMarkdown(
  content: string,
  detailUrl?: string,
  authorUserId?: string,
): string {
  const mention = authorUserId && /^[UW][A-Z0-9]{1,63}$/u.test(authorUserId) ? `\n\n<@${authorUserId}>` : "";
  return boundSocialMarkdown(toSlackMarkdown(mention ? closeMentionFence(content) : content), 3900 - mention.length, detailUrl) + mention;
}

/** A controlled Markdown subset; unsupported constructs remain readable plain text. */
export function toTelegramMessage(
  content: string,
  detailUrl?: string,
  authorUserId?: string,
): SocialImMessage {
  const mention = authorUserId && /^[1-9][0-9]{0,15}$/u.test(authorUserId) && Number.isSafeInteger(Number(authorUserId))
    ? { text: "\n\nReview author", url: `tg://user?id=${authorUserId}` } : undefined;
  let text = "";
  const entities: TelegramMessageEntity[] = [];
  const append = (
    body: string,
    bold: boolean,
    entity?: Omit<TelegramMessageEntity, "offset" | "length">,
  ) => {
    if (!body) return;
    if (entity)
      entities.push({ ...entity, offset: text.length, length: body.length });
    // Telegram forbids any style entity from overlapping code/pre, including full containment.
    if (bold && entity?.type !== "code" && entity?.type !== "pre")
      entities.push({ type: "bold", offset: text.length, length: body.length });
    text += body;
  };
  const inline = (source: string, bold = false, headings = true): void => {
    const tokens = new RegExp(
      /(?<!`)(`+)([^\n]*?)\1(?!`)|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(([^\n)]+)\)/u
        .source + (headings ? /|^#{1,6}[ \t]+([^\n]*)/u.source : ""),
      "gmu",
    );
    let offset = 0;
    for (const match of source.matchAll(tokens)) {
      append(source.slice(offset, match.index), bold);
      if (match[2] !== undefined) append(match[2], false, { type: "code" });
      else if (match[3] !== undefined) inline(match[3], true, false);
      else if (match[4] !== undefined)
        append(
          match[4],
          bold,
          safeUrl(match[5]!)
            ? { type: "text_link", url: match[5]! }
            : undefined,
        );
      else inline(match[6]!, true, false);
      offset = match.index + match[0].length;
    }
    append(source.slice(offset), bold);
  };
  for (const segment of splitMarkdownFences(
    normalizeSocialImMarkdown(content),
  )) {
    if (segment.kind === "code_block")
      append(segment.body, false, {
        type: "pre",
        ...(segment.language ? { language: segment.language } : {}),
      });
    else inline(segment.raw);
  }
  const bounded = boundSocialMarkdown(text, 3900 - (mention?.text.length ?? 0), detailUrl);
  const cut = bounded === text ? text.length : bounded.lastIndexOf(notice);
  return {
    text: bounded + (mention?.text ?? ""),
    entities: [...entities
      .filter((entity) => entity.offset < cut)
      .map((entity) => ({
        ...entity,
        length: Math.min(entity.length, cut - entity.offset),
      }))
      .filter((entity) => entity.length > 0),
      ...(mention ? [{ type: "text_link" as const, offset: bounded.length + 2, length: mention.text.length - 2, url: mention.url }] : [])],
  };
}

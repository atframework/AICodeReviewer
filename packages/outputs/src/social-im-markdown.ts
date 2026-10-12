import { toSlackMarkdown } from "./im-markdown.js";
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
    /(`{3,})[^\n]*\n[\s\S]*?\1|`[^`\n]*`|<[^<>\n]+>|\[[^\]\n]*\]\([^\n)]*\)|&(?:amp|lt|gt);/gu;
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

export function toDiscordMarkdown(content: string, detailUrl?: string): string {
  // allowed_mentions also disables notifications; escaping avoids misleading mention markup.
  return boundSocialMarkdown(
    content
      .replace(/@(?=everyone|here|[!&]?\d)/gu, "@\u200b")
      .replace(/<@/gu, "<@\u200b"),
    1900,
    detailUrl,
  );
}

export function toBoundedSlackMarkdown(
  content: string,
  detailUrl?: string,
): string {
  return boundSocialMarkdown(toSlackMarkdown(content), 3900, detailUrl);
}

/** A controlled Markdown subset; unsupported constructs remain readable plain text. */
export function toTelegramMessage(
  content: string,
  detailUrl?: string,
): SocialImMessage {
  let text = "";
  const entities: TelegramMessageEntity[] = [];
  const input = content.replace(/^#{1,6}\s+/gmu, "");
  const tokens =
    /```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\n)]+)\)/gu;
  let offset = 0;
  for (const match of input.matchAll(tokens)) {
    text += input.slice(offset, match.index);
    const body = match[1] ?? match[2] ?? match[3] ?? match[4]!;
    const type =
      match[1] !== undefined
        ? "pre"
        : match[2] !== undefined
          ? "code"
          : match[3] !== undefined
            ? "bold"
            : "text_link";
    if (type !== "text_link" || safeUrl(match[5]!))
      entities.push({
        type,
        offset: text.length,
        length: body.length,
        ...(type === "text_link" ? { url: match[5]! } : {}),
      });
    text += body;
    offset = match.index + match[0].length;
  }
  text += input.slice(offset);
  const bounded = boundSocialMarkdown(text, 3900, detailUrl);
  const cut = bounded === text ? text.length : bounded.lastIndexOf(notice);
  return {
    text: bounded,
    entities: entities
      .filter((entity) => entity.offset < cut)
      .map((entity) => ({
        ...entity,
        length: Math.min(entity.length, cut - entity.offset),
      }))
      .filter((entity) => entity.length > 0),
  };
}

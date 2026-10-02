import { XMLParser } from "fast-xml-parser";

/**
 * Single strict XML wrapper (implementation spec §6): the ONLY place XML is
 * parsed for IM callbacks. Entity processing is disabled outright, DTD and
 * entity declarations are rejected before parsing, duplicate authentication
 * fields are refused, and only the whitelisted WeCom envelope tags survive.
 * Consumes fast-xml-parser's preserveOrder structure (arrays of single-key
 * nodes with {"#text": value} leaves).
 *
 * CardType/ResponseCode are the flat template-card event fields (W5);
 * nested multi-select answer structures (SelectedItems) stay rejected —
 * this deployment never sends cards that produce them.
 */

export class StrictXmlError extends Error {
  constructor(readonly code: "dtd" | "entity" | "malformed" | "oversized" | "multiple_roots" | "unexpected_field") {
    super(`Strict XML rejected input: ${code}.`);
    this.name = "StrictXmlError";
  }
}

export const XML_MAX_BYTES = 256 * 1024;
const XML_MAX_DEPTH = 32;

const WECOM_ENVELOPE_FIELDS = new Set(["ToUserName", "FromUserName", "CreateTime", "MsgType", "Content", "MsgId", "AgentID", "Event", "EventKey", "TaskId", "Encrypt", "ChatId", "ChatType", "Receiver", "Sender", "CardType", "ResponseCode"]);

export interface XmlEnvelope {
  readonly root: string;
  readonly fields: ReadonlyMap<string, string>;
}

export function parseStrictWcomXml(xml: string): XmlEnvelope {
  if (Buffer.byteLength(xml, "utf8") > XML_MAX_BYTES) throw new StrictXmlError("oversized");
  // DTD/ENTITY declarations are rejected before any parsing (XXE surface).
  if (/<!DOCTYPE/iu.test(xml) || /<!ENTITY/iu.test(xml)) throw new StrictXmlError("dtd");
  // With processEntities disabled a stray entity stays literal; the protocol
  // charset never contains one, so any entity-looking sequence is rejected.
  if (/&[a-zA-Z#][a-zA-Z0-9]{0,15};/u.test(xml)) throw new StrictXmlError("entity");

  const parser = new XMLParser({
    processEntities: false,
    preserveOrder: true,
    ignoreDeclaration: false,
    parseTagValue: false,
    trimValues: false,
    commentPropName: "#comment",
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    throw new StrictXmlError("malformed");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new StrictXmlError("malformed");

  const isMeta = (node: Record<string, unknown>): boolean => "#comment" in node || "?xml" in node;
  const roots = (parsed as Record<string, unknown>[]).filter(node => !isMeta(node));
  if (roots.length !== 1) throw new StrictXmlError(roots.length === 0 ? "malformed" : "multiple_roots");

  const root = roots[0]!;
  const rootTag = Object.keys(root).find(key => key !== "#comment");
  if (rootTag === undefined) throw new StrictXmlError("malformed");
  const rootChildren = root[rootTag];
  if (!Array.isArray(rootChildren)) throw new StrictXmlError("malformed");

  const fields = new Map<string, string>();
  const collect = (nodes: readonly Record<string, unknown>[], depth: number): void => {
    if (depth > XML_MAX_DEPTH) throw new StrictXmlError("oversized");
    for (const node of nodes) {
      for (const [tag, value] of Object.entries(node)) {
        if (tag === "#text" || tag === "#comment") continue;
        if (!WECOM_ENVELOPE_FIELDS.has(tag)) throw new StrictXmlError("unexpected_field");
        if (fields.has(tag)) throw new StrictXmlError("unexpected_field"); // duplicate auth field (S06)
        if (!Array.isArray(value)) throw new StrictXmlError("malformed");
        const text = (value as Record<string, unknown>[]).find(child => "#text" in child);
        if (text !== undefined) {
          const raw = text["#text"];
          if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") throw new StrictXmlError("malformed");
          fields.set(tag, String(raw));
          continue;
        }
        // Nested elements are not part of the flat WeCom envelope.
        throw new StrictXmlError("malformed");
      }
    }
  };
  collect(rootChildren as Record<string, unknown>[], 0);
  return { root: rootTag, fields };
}

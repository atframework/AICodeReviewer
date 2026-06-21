import type { AttributionEntry, AttributionStatus } from "./contracts.js";

export function filterAttributionByLineRange(
  entries: readonly AttributionEntry[],
  startLine: number | undefined,
  endLine: number | undefined,
): AttributionEntry[] {
  if (startLine === undefined && endLine === undefined) {
    return [...entries];
  }

  const start = startLine ?? 1;
  const end = endLine ?? Number.MAX_SAFE_INTEGER;
  return entries.filter((entry) => entry.line >= start && entry.line <= end);
}

export function determineAttributionStatus(entries: readonly AttributionEntry[]): AttributionStatus {
  if (entries.length === 0) {
    return "not_found";
  }

  const incomplete = entries.some((entry) => !entry.revision || !entry.author);
  return incomplete ? "partial" : "ok";
}

export function buildAttributionEntry(input: {
  readonly line: number;
  readonly revision?: string | undefined;
  readonly author?: string | undefined;
  readonly authorEmail?: string | undefined;
  readonly summary?: string | undefined;
}): AttributionEntry {
  return {
    line: input.line,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.author ? { author: input.author } : {}),
    ...(input.authorEmail ? { authorEmail: input.authorEmail } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
  };
}

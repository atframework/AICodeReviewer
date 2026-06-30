import { createHash } from "node:crypto";

import { scrubText } from "./secret-scrubber.js";
import { normalizePath } from "./utils.js";

export interface ReflectionExtractorInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly status: string;
  readonly skipReason?: string | undefined;
  readonly problems: readonly ReflectionProblem[];
  readonly summaries: readonly ReflectionSummary[];
  readonly changedFiles: readonly string[];
}

export type ReflectionSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ReflectionProblem {
  readonly file: string;
  readonly line: number;
  readonly severity: ReflectionSeverity;
  readonly category: string;
  readonly message: string;
}

export interface ReflectionSummary {
  readonly title?: string;
}

export interface ExtractedReflection {
  readonly fingerprint: string;
  readonly content: string;
}

export interface CrossRunMemoryEntry {
  readonly fingerprint: string;
  readonly occurrenceCount: number;
}

export interface ReflectionMemoryHintSource {
  readonly content: string;
  readonly fingerprint?: string;
  readonly occurrenceCount?: number;
}

const repoConventionPrefix = "Repo convention:";
const defaultMaxConventions = 5;
const defaultMaxHintLength = 260;
const severityRank: Readonly<Record<ReflectionSeverity, number>> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function stableFingerprint(workspaceId: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(workspaceId);
  for (const part of parts) {
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex").slice(0, 16);
}

function extractFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0) return "";
  return filePath.slice(lastDot + 1).toLowerCase();
}

function groupByCategory(problems: readonly ReflectionProblem[]): Map<string, readonly ReflectionProblem[]> {
  const groups = new Map<string, ReflectionProblem[]>();
  for (const problem of problems) {
    const key = problem.category || "uncategorized";
    const existing = groups.get(key);
    if (existing) {
      existing.push(problem);
    } else {
      groups.set(key, [problem]);
    }
  }
  return groups;
}

function normalizeCategory(category: string): string {
  return category || "uncategorized";
}

function normalizeMemoryToken(value: string, fallback: string): string {
  const scrubbed = scrubText(value).text
    .replace(/[^a-z0-9_.:/-]+/giu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  return scrubbed || fallback;
}

function categoryReflectionFingerprint(workspaceId: string, category: string): string {
  return stableFingerprint(workspaceId, "category", normalizeCategory(category));
}

function groupByExtension(files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = extractFileExtension(file) || "no-ext";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return counts;
}

function isUnsafeRelativePath(normalized: string): boolean {
  return !normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || /^[a-z]:/iu.test(normalized);
}

function normalizeRelativeLocation(file: string, line: number): string | undefined {
  const normalized = normalizePath(file);
  if (isUnsafeRelativePath(normalized)) {
    return undefined;
  }

  return `${scrubText(normalized).text}:${line}`;
}

function conventionScope(file: string): string {
  const normalized = normalizePath(file);
  if (isUnsafeRelativePath(normalized)) {
    return "in repository files";
  }

  const [firstSegment] = normalized.split("/");
  if (firstSegment && firstSegment !== normalized && !firstSegment.includes(":")) {
    return `under ${firstSegment}/`;
  }
  const ext = extractFileExtension(normalized);
  return ext ? `in .${ext} files` : "in files without extensions";
}

function trimHint(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isRepoConvention(content: string): boolean {
  return content.startsWith(repoConventionPrefix);
}

export function extractReflections(input: ReflectionExtractorInput): readonly ExtractedReflection[] {
  const reflections: ExtractedReflection[] = [];
  const { workspaceId, status, skipReason, problems, summaries, changedFiles } = input;

  if (status === "skipped" && skipReason) {
    reflections.push({
      fingerprint: stableFingerprint(workspaceId, "skip", skipReason),
      content: `Previous review was skipped: ${skipReason}`,
    });
    return reflections;
  }

  if (problems.length > 0) {
    const categoryGroups = groupByCategory(problems);
    for (const [category, categoryProblems] of categoryGroups) {
      const fileExts = [...new Set(categoryProblems.map(p => extractFileExtension(p.file)).filter(Boolean))];
      const severityCounts = new Map<string, number>();
      for (const p of categoryProblems) {
        severityCounts.set(p.severity, (severityCounts.get(p.severity) ?? 0) + 1);
      }
      const severitySummary = [...severityCounts.entries()]
        .map(([sev, count]) => `${count} ${sev}`)
        .join(", ");

      let hint = `Category "${category}": found ${categoryProblems.length} issue${categoryProblems.length > 1 ? "s" : ""} (${severitySummary})`;
      if (fileExts.length > 0) {
        hint += ` in ${fileExts.join("/")} files`;
      }
      if (categoryProblems.length <= 3) {
        const locations = categoryProblems.map(p => `${p.file}:${p.line}`).join(", ");
        hint += ` — ${locations}`;
      }

      reflections.push({
        fingerprint: categoryReflectionFingerprint(workspaceId, category),
        content: hint,
      });
    }

    const topCategories = [...categoryGroups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([cat]) => cat);
    if (topCategories.length > 1) {
      reflections.push({
        fingerprint: stableFingerprint(workspaceId, "summary", "categories"),
        content: `Review found ${problems.length} issue${problems.length > 1 ? "s" : ""} across ${categoryGroups.size} categor${categoryGroups.size > 1 ? "ies" : "y"}: ${topCategories.join(", ")}`,
      });
    }
  }

  if (changedFiles.length > 0) {
    const extCounts = groupByExtension(changedFiles);
    const topExts = [...extCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `.${ext} (${count})`);
    reflections.push({
      fingerprint: stableFingerprint(workspaceId, "scope", "file-types"),
      content: `Reviewed files: ${topExts.join(", ")}; ${changedFiles.length} file${changedFiles.length > 1 ? "s" : ""} total`,
    });
  }

  if (summaries.length > 0 && summaries[0]?.title) {
    reflections.push({
      // Stable per-workspace fingerprint so the newest summary overwrites the
      // previous one instead of accumulating a fresh entry per run.
      fingerprint: stableFingerprint(workspaceId, "summary", "latest"),
      content: `Latest review summary: ${summaries[0].title}`,
    });
  }

  return reflections;
}

export function extractRepositoryConventions(
  input: ReflectionExtractorInput,
  options?: { readonly maxConventions?: number; readonly maxHintLength?: number },
): readonly ExtractedReflection[] {
  if (input.problems.length === 0 || input.status === "skipped") {
    return [];
  }

  const maxConventions = options?.maxConventions ?? defaultMaxConventions;
  const maxHintLength = options?.maxHintLength ?? defaultMaxHintLength;
  const candidates = [...input.problems]
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
  const seen = new Set<string>();
  const conventions: ExtractedReflection[] = [];

  for (const problem of candidates) {
    const category = normalizeMemoryToken(normalizeCategory(problem.category), "uncategorized");
    const ext = normalizeMemoryToken(extractFileExtension(problem.file) || "no-ext", "no-ext");
    const scope = conventionScope(problem.file);
    const key = `${category}:${ext}:${scope}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const location = normalizeRelativeLocation(problem.file, problem.line);
    const locationText = location ? ` Source: ${location}.` : "";
    const rawContent = `${repoConventionPrefix} prior reviews in this workspace flagged ${problem.severity} ${category} concerns ${scope}; re-check this repository pattern before reporting similar changes.${locationText}`;
    const content = trimHint(scrubText(rawContent).text, maxHintLength);

    conventions.push({
      fingerprint: stableFingerprint(input.workspaceId, "repo-convention", category, ext, scope),
      content,
    });

    if (conventions.length >= maxConventions) {
      break;
    }
  }

  return conventions;
}

export function buildMemoryHintsForPrompt(
  entries: readonly ReflectionMemoryHintSource[],
  options?: { readonly maxHints?: number; readonly maxHintLength?: number },
): readonly string[] {
  const maxHints = options?.maxHints ?? 12;
  const maxHintLength = options?.maxHintLength ?? defaultMaxHintLength;
  const seen = new Set<string>();
  const unique = entries
    .map((entry, index) => ({
      content: trimHint(scrubText(entry.content).text, maxHintLength),
      occurrenceCount: entry.occurrenceCount ?? 1,
      index,
    }))
    .filter((entry) => {
      if (!entry.content || seen.has(entry.content)) {
        return false;
      }
      seen.add(entry.content);
      return true;
    })
    .sort((a, b) => {
      const aConvention = isRepoConvention(a.content);
      const bConvention = isRepoConvention(b.content);
      if (aConvention !== bConvention) {
        return aConvention ? -1 : 1;
      }
      if (a.occurrenceCount !== b.occurrenceCount) {
        return b.occurrenceCount - a.occurrenceCount;
      }
      return a.index - b.index;
    });

  return unique.slice(0, maxHints).map((entry) => entry.content);
}

export function extractCrossRunPatterns(
  workspaceId: string,
  currentCategories: readonly string[],
  memoryEntries: readonly CrossRunMemoryEntry[],
  options?: { threshold?: number },
): readonly ExtractedReflection[] {
  const threshold = options?.threshold ?? 3;
  const fingerprintToCount = new Map<string, number>();
  for (const entry of memoryEntries) {
    fingerprintToCount.set(entry.fingerprint, entry.occurrenceCount);
  }

  const reflections: ExtractedReflection[] = [];
  for (const category of currentCategories) {
    const normalizedCategory = normalizeCategory(category);
    const categoryFp = categoryReflectionFingerprint(workspaceId, normalizedCategory);
    const count = fingerprintToCount.get(categoryFp);
    if (count !== undefined && count >= threshold) {
      reflections.push({
        fingerprint: stableFingerprint(workspaceId, "thorough", "recurring", normalizedCategory),
        content: `Recurring pattern: category "${normalizedCategory}" reported in ${count} recent reviews. If these are non-actionable noise, consider adding ignore rules or adjusting filters.`,
      });
    }
  }
  return reflections;
}

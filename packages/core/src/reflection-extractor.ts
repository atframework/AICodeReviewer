import { createHash } from "node:crypto";

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

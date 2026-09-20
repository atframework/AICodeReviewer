/**
 * Review path policy (P4/H05): pure application of the merged `review`
 * include/exclude/max_files filters to the changed-path list. The filters use repository path globs: * matches within a directory and ** spans zero or more directories.
 */

import { globMatchesPath } from "./prompt-manager.js";
import type { ReviewConfig } from "./config.js";

/**
 * Built-in review-scope defaults. The effective-config schema fills the same
 * values; keep them exported so enforcement fallbacks (full-file budget) and
 * the schema default cannot drift apart.
 */
export const REVIEW_DEFAULT_MAX_FILES = 2_000;
export const REVIEW_DEFAULT_MAX_PATCH_BYTES = 20 * 1_024 * 1_024;

/** Per-run serialized budget; concurrent MCP requests cannot overspend it. */
export function createReviewContextFetcher(
  policy: ReviewConfig["fetch_extra"],
  fetch: (path: string, startLine?: number, endLine?: number) => Promise<string>,
): (path: string, startLine?: number, endLine?: number) => Promise<string> {
  let usedBytes = 0;
  const files = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  return (path, startLine, endLine) => {
    const run = tail.then(async () => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some(p => p === ".." || p === "." || p === "")) {
        throw new Error("Context path must be relative to the repository.");
      }
      if (policy?.allow_paths !== undefined && !policy.allow_paths.some(pattern => globMatchesPath(pattern, normalized))) {
        throw new Error("Context path is outside review.fetch_extra.allow_paths.");
      }
      if (!files.has(normalized) && files.size >= (policy?.max_files ?? Infinity)) {
        throw new Error("review.fetch_extra.max_files exceeded.");
      }
      if (usedBytes >= (policy?.max_bytes ?? Infinity)) throw new Error("review.fetch_extra.max_bytes exceeded.");
      files.add(normalized);
      const content = await fetch(normalized, startLine, endLine);
      usedBytes += Buffer.byteLength(content, "utf8");
      if (usedBytes > (policy?.max_bytes ?? Infinity)) throw new Error("review.fetch_extra.max_bytes exceeded.");
      return content;
    });
    tail = run.catch(() => {});
    return run;
  };
}

export interface ReviewPathPolicy {
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly max_files?: number | undefined;
}

export interface AppliedReviewPathPolicy {
  /** Filtered paths, preserving VCS order; truncated at max_files. */
  readonly paths: readonly string[];
  /** Paths dropped by include/exclude patterns. */
  readonly excluded: readonly string[];
  /** Paths dropped only by the max_files cap (all filter-passing ones beyond it). */
  readonly truncated: readonly string[];
}

/**
 * Applies include (default: everything) then exclude (default: nothing) then
 * the max_files cap. The matcher shares the repository instruction path semantics.
 */
export function applyReviewPathPolicy(
  paths: readonly string[],
  policy: ReviewPathPolicy,
): AppliedReviewPathPolicy {
  const include = policy.include ?? ["**/*"];
  const exclude = policy.exclude ?? [];

  const kept: string[] = [];
  const excluded: string[] = [];
  for (const path of paths) {
    const matchesInclude = include.some((pattern) => globMatchesPath(pattern, path));
    const matchesExclude = exclude.some((pattern) => globMatchesPath(pattern, path));
    if (matchesInclude && !matchesExclude) {
      kept.push(path);
    } else {
      excluded.push(path);
    }
  }

  const maxFiles = policy.max_files;
  if (maxFiles !== undefined && maxFiles >= 0 && kept.length > maxFiles) {
    return { paths: kept.slice(0, maxFiles), excluded, truncated: kept.slice(maxFiles) };
  }
  return { paths: kept, excluded, truncated: [] };
}

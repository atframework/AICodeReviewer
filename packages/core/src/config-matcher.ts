/**
 * Shared matcher compilation (spec §5.1, P1).
 *
 * ConfigMatcher is `{ exact } | { glob, ignore_case? } | { regex, ignore_case? }`
 * (config-format.ts). Semantics mirror the auto-commit exclusion contract:
 * glob matches the entire field — `*` is zero or more Unicode code points
 * (including `/`, consecutive `*` collapse), `?` is exactly one code point,
 * every other character is literal; regex runs on RE2 as a substring search
 * (write `^...$` for full-field matches); exact is plain string equality.
 * `ignore_case` affects only matching, never stored identity. RE2 is
 * mandatory — no fallback to unbounded JavaScript RegExp.
 */

import { RE2 } from "re2-wasm";

import { ConfigError, validateConfigMatcher, type ConfigMatcher, type ConfigPath } from "./config-format.js";

/** Translate a config glob to an anchored RE2 source (spec §5.1 glob semantics). */
export function globToConfigRegexSource(glob: string): string {
  let source = "";
  let pendingStar = false;
  for (const char of glob) {
    if (char === "*") {
      pendingStar = true;
      continue;
    }
    if (pendingStar) {
      source += "[\\s\\S]*";
      pendingStar = false;
    }
    source += char === "?" ? "[\\s\\S]" : escapeConfigRegexChar(char);
  }
  if (pendingStar) {
    source += "[\\s\\S]*";
  }
  return `^(?:${source})$`;
}

function escapeConfigRegexChar(char: string): string {
  return /[\\^$.|?*+()[\]{}]/u.test(char) ? `\\${char}` : char;
}

/** Compile a RE2 source; throws ConfigError(matcher_invalid) on rejection. */
export function compileConfigRegex(source: string, ignoreCase: boolean, path?: ConfigPath): (value: string) => boolean {
  let compiled: RE2;
  try {
    compiled = new RE2(source, ignoreCase ? "iu" : "u");
  } catch (error) {
    throw new ConfigError(
      "matcher_invalid",
      `Invalid RE2 pattern: ${error instanceof Error ? error.message : String(error)}`,
      { path },
    );
  }
  return (value: string) => compiled.test(value);
}

export type CompiledConfigMatcher = (value: string) => boolean;

/** Compile one ConfigMatcher to a predicate (exact/glob/regex, ignore_case). */
export function compileConfigMatcher(matcher: ConfigMatcher, path?: ConfigPath): CompiledConfigMatcher {
  if ("exact" in matcher) {
    // The exact variant has no ignore_case (spec §5.1): plain equality.
    const expected = matcher.exact;
    return (value: string) => value === expected;
  }
  const source = "glob" in matcher ? globToConfigRegexSource(matcher.glob) : matcher.regex;
  return compileConfigRegex(source, matcher.ignore_case === true, path);
}

/** Source variable fields allowed in workspace match source conditions (spec §5.3). */
export const WORKSPACE_MATCH_SOURCE_FIELDS = [
  "vcs",
  "repo_ref",
  "repository",
  "namespace",
  "project_key",
  "branch",
  "ref",
] as const;
export type WorkspaceMatchSourceField = (typeof WORKSPACE_MATCH_SOURCE_FIELDS)[number];

/**
 * Validates a record of source field matchers: known fields only, per-field
 * 4 KiB and total 64 KiB matcher budgets (spec §5.1 limits), and every
 * expression compilable.
 */
export function validateWorkspaceMatchSource(
  value: unknown,
  path?: ConfigPath,
): Readonly<Partial<Record<WorkspaceMatchSourceField, ConfigMatcher>>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("matcher_invalid", "Workspace match source conditions must be a mapping.", { path });
  }
  const result: Partial<Record<WorkspaceMatchSourceField, ConfigMatcher>> = {};
  for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(WORKSPACE_MATCH_SOURCE_FIELDS as readonly string[]).includes(field)) {
      throw new ConfigError(
        "matcher_invalid",
        `Unknown workspace match source field "${field}"; allowed: ${WORKSPACE_MATCH_SOURCE_FIELDS.join(", ")}.`,
        { path: path !== undefined ? [...path, field] : [field] },
      );
    }
    const matcher = validateConfigMatcher(raw, path !== undefined ? [...path, field] : [field]);
    // Compile now so publish rejects an invalid expression (RE2 errors included).
    compileConfigMatcher(matcher, path !== undefined ? [...path, field] : [field]);
    result[field as WorkspaceMatchSourceField] = matcher;
  }
  return result;
}

/** Compiled form of one definition's source conditions (AND across fields). */
export type CompiledWorkspaceMatchSource = (fields: Readonly<Record<string, string | null | undefined>>) => boolean;

export function compileWorkspaceMatchSource(
  matchers: Readonly<Partial<Record<WorkspaceMatchSourceField, ConfigMatcher>>>,
): CompiledWorkspaceMatchSource {
  const compiled = Object.entries(matchers).map(([field, matcher]) => ({
    field,
    test: compileConfigMatcher(matcher as ConfigMatcher, [field]),
  }));
  return (fields) => {
    for (const { field, test } of compiled) {
      const value = fields[field];
      if (typeof value !== "string" || !test(value)) {
        return false;
      }
    }
    return true;
  };
}

/** Sum of UTF-8 expression bytes across one definition's match rules (spec §5.1 total budget). */
export function workspaceMatchExpressionBytes(
  rules: readonly { readonly source?: Readonly<Record<string, ConfigMatcher>> | undefined }[],
): number {
  let total = 0;
  for (const rule of rules) {
    for (const matcher of Object.values(rule.source ?? {})) {
      total += Buffer.byteLength("exact" in matcher ? matcher.exact : "glob" in matcher ? matcher.glob : matcher.regex, "utf8");
    }
  }
  return total;
}

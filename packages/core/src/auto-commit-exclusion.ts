/**
 * Auto-commit source exclusion rules (`review.auto_commit.exclude_sources`).
 *
 * Contract: docs/ai/architecture.md §3.1.1 + docs/ai/decisions.md D35 (M15). Rules identify bot/CI commits by VCS-recorded source fields — never by
 * webhook payload hints, platform accounts, display names, or the AICR service
 * account. Matching happens in the background after source verification, never
 * at HTTP receive time.
 *
 * - Rule shape: `{ id, vcs, match: { <field>: { glob | regex, ignore_case? } } }`.
 *   Conditions inside one rule are AND-ed; rules are OR-ed. Only the fields
 *   listed for the rule's VCS are allowed (git: author/committer name+email,
 *   p4: user+client, svn: author).
 * - Glob matches the entire field: `*` is zero or more Unicode code points
 *   (consecutive `*` collapse), `?` is exactly one code point; every other
 *   character is literal — no basename, path normalization, extglob, or brace
 *   semantics. Regex uses RE2 syntax as a substring search; write anchors for
 *   full-field matches. `ignore_case` affects only matching, never the stored
 *   source key or attribution.
 * - Regexes run on RE2 (re2-wasm, Apache-2.0, pure WASM — verified on Node
 *   24.20 win32; no native build, no engines constraint, rejects lookaround
 *   and backreferences, linear-time). There is deliberately no fallback to
 *   unbounded JavaScript RegExp.
 * - Decisions are three-state per field (match / no_match / unknown). Unknown
 *   fields (missing, conflicted, corrupt, or over the 4 KiB field budget) never
 *   count as no_match; the caller persists `exclusion_metadata_unavailable`
 *   and retries with a bound instead of analyzing or faking an exclusion.
 */

import { z } from "zod";

import { compileConfigRegex, globToConfigRegexSource } from "./config-matcher.js";

export const AUTO_COMMIT_EXCLUSION_LIMITS = {
  maxRules: 128,
  maxPatternBytes: 1024,
  maxTotalPatternBytes: 64 * 1024,
  maxFieldBytes: 4 * 1024,
} as const;

export const EXCLUSION_VCS_FIELDS = {
  git: ["author_name", "author_email", "committer_name", "committer_email"],
  p4: ["user", "client"],
  svn: ["author"],
} as const;

export type ExclusionVcs = keyof typeof EXCLUSION_VCS_FIELDS;
export type ExclusionField = (typeof EXCLUSION_VCS_FIELDS)[ExclusionVcs][number];

const utf8 = new TextEncoder();

/** Compile one matcher to RE2; throws on invalid or unsupported patterns. */
function compileMatcher(matcher: ExclusionMatcherConfig): (value: string) => boolean {
  const source =
    matcher.glob !== undefined ? globToConfigRegexSource(matcher.glob) : (matcher.regex as string);
  return compileConfigRegex(source, matcher.ignore_case === true);
}

const exclusionMatcherSchema = z
  .object({
    glob: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
    ignore_case: z.boolean().optional(),
  })
  .strict()
  .superRefine((matcher, ctx) => {
    if ((matcher.glob === undefined) === (matcher.regex === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "matcher must set exactly one of glob or regex",
      });
      return;
    }
    const pattern = (matcher.glob ?? matcher.regex) as string;
    if (utf8.encode(pattern).length > AUTO_COMMIT_EXCLUSION_LIMITS.maxPatternBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `matcher pattern exceeds ${AUTO_COMMIT_EXCLUSION_LIMITS.maxPatternBytes} UTF-8 bytes`,
      });
      return;
    }
    try {
      compileMatcher(matcher as ExclusionMatcherConfig);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid ${matcher.glob !== undefined ? "glob" : "regex"} pattern: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  });

const exclusionMatchSchema = z
  .object({
    author_name: exclusionMatcherSchema.optional(),
    author_email: exclusionMatcherSchema.optional(),
    committer_name: exclusionMatcherSchema.optional(),
    committer_email: exclusionMatcherSchema.optional(),
    user: exclusionMatcherSchema.optional(),
    client: exclusionMatcherSchema.optional(),
    author: exclusionMatcherSchema.optional(),
  })
  .strict()
  .superRefine((match, ctx) => {
    if (Object.values(match).every((matcher) => matcher === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "match must declare at least one field matcher",
      });
    }
  });

const exclusionRuleSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, {
        message:
          "rule id must be 1–64 ASCII letters/digits/./_/- and start with a letter or digit",
      }),
    vcs: z.enum(["git", "p4", "svn"]),
    match: exclusionMatchSchema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    const allowed: readonly string[] = EXCLUSION_VCS_FIELDS[rule.vcs];
    for (const field of Object.keys(rule.match)) {
      if (!allowed.includes(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `field '${field}' is not matchable for vcs '${rule.vcs}'; allowed: ${allowed.join(", ")}`,
          path: ["match", field],
        });
      }
    }
  });

export const autoCommitExcludeSourcesSchema = z
  .array(exclusionRuleSchema)
  .max(AUTO_COMMIT_EXCLUSION_LIMITS.maxRules, {
    message: `exclude_sources supports at most ${AUTO_COMMIT_EXCLUSION_LIMITS.maxRules} rules`,
  })
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    let totalPatternBytes = 0;
    rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate exclude_sources rule id '${rule.id}'`,
          path: [index, "id"],
        });
      }
      seen.add(rule.id);
      for (const matcher of Object.values(rule.match)) {
        const pattern = matcher?.glob ?? matcher?.regex;
        if (pattern) {
          totalPatternBytes += utf8.encode(pattern).length;
        }
      }
    });
    if (totalPatternBytes > AUTO_COMMIT_EXCLUSION_LIMITS.maxTotalPatternBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `exclude_sources patterns total ${totalPatternBytes} bytes, exceeding the ${AUTO_COMMIT_EXCLUSION_LIMITS.maxTotalPatternBytes}-byte policy budget`,
      });
    }
  });

export type ExclusionMatcherConfig = z.infer<typeof exclusionMatcherSchema>;
export type ExclusionRuleConfig = z.infer<typeof exclusionRuleSchema>;

export interface CompiledExclusionRule {
  readonly id: string;
  readonly vcs: ExclusionVcs;
  readonly matchers: readonly { readonly field: ExclusionField; readonly test: (value: string) => boolean }[];
}

export interface CompiledExclusionPolicy {
  readonly rules: readonly CompiledExclusionRule[];
  /** Canonical encoding of the rule set; stable across processes for versioning. */
  readonly canonical: string;
}

export function compileExclusionRules(
  rules: readonly ExclusionRuleConfig[],
): CompiledExclusionPolicy {
  const compiled: CompiledExclusionRule[] = rules.map((rule) => ({
    id: rule.id,
    vcs: rule.vcs,
    matchers: Object.entries(rule.match)
      .filter((entry): entry is [ExclusionField, ExclusionMatcherConfig] => entry[1] !== undefined)
      .map(([field, matcher]) => ({ field, test: compileMatcher(matcher) })),
  }));
  return { rules: compiled, canonical: JSON.stringify(rules) };
}

/** Per-field evidence as produced by source verification (design §5.1.1). */
export interface ExclusionFieldInput {
  readonly status: "known" | "unavailable" | "conflicted";
  readonly value?: string;
}

export type ExclusionDecision =
  | { readonly kind: "excluded"; readonly ruleId: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "allowed" };

/**
 * Three-state exclusion decision. Rules of other VCS kinds do not apply and
 * never contribute `unknown`. A rule matches only when every one of its
 * conditions explicitly matches; one explicit no_match defeats the rule.
 */
export function decideExclusion(
  policy: CompiledExclusionPolicy,
  vcs: ExclusionVcs,
  fields: Readonly<Partial<Record<ExclusionField, ExclusionFieldInput>>>,
): ExclusionDecision {
  let sawUnknown = false;
  for (const rule of policy.rules) {
    if (rule.vcs !== vcs) continue;
    let ruleUnknown = false;
    let ruleFailed = false;
    for (const matcher of rule.matchers) {
      const input = fields[matcher.field];
      if (
        input === undefined ||
        input.status !== "known" ||
        input.value === undefined ||
        utf8.encode(input.value).length > AUTO_COMMIT_EXCLUSION_LIMITS.maxFieldBytes
      ) {
        ruleUnknown = true;
        continue;
      }
      if (!matcher.test(input.value)) {
        ruleFailed = true;
        break;
      }
    }
    if (ruleFailed) continue;
    if (ruleUnknown) {
      sawUnknown = true;
      continue;
    }
    return { kind: "excluded", ruleId: rule.id };
  }
  return sawUnknown ? { kind: "unknown" } : { kind: "allowed" };
}


const SNAPSHOT_FIELD_TO_EXCLUSION_FIELD = {
  authorName: "author_name",
  authorEmail: "author_email",
  committerName: "committer_name",
  committerEmail: "committer_email",
  user: "user",
  client: "client",
  svnAuthor: "author",
} as const;

/**
 * Bridge a source snapshot's camelCase evidence into the exclusion decision
 * input keyed by schema field names. Field values flow through untouched —
 * only the key naming convention changes.
 */
export function exclusionInputFromSnapshotFields(fields: {
  readonly [K in keyof typeof SNAPSHOT_FIELD_TO_EXCLUSION_FIELD]?: ExclusionFieldInput;
}): Partial<Record<ExclusionField, ExclusionFieldInput>> {
  const input: Partial<Record<ExclusionField, ExclusionFieldInput>> = {};
  for (const [snapshotField, exclusionField] of Object.entries(
    SNAPSHOT_FIELD_TO_EXCLUSION_FIELD,
  ) as [keyof typeof SNAPSHOT_FIELD_TO_EXCLUSION_FIELD, ExclusionField][]) {
    const evidence = fields[snapshotField];
    if (evidence !== undefined) {
      input[exclusionField] = evidence;
    }
  }
  return input;
}
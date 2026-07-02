export const evalPackageName = "@aicr/eval";

const EVAL_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
type EvalSeverity = (typeof EVAL_SEVERITIES)[number];
const evalProblemSeverities = new Set<string>(EVAL_SEVERITIES);
const evalExampleKeys = new Set([
  "id",
  "description",
  "changedFiles",
  "diff",
  "expectedProblems",
  "expectedSkip",
  "tags",
]);
const evalExpectedProblemKeys = new Set([
  "file",
  "line",
  "severity",
  "category",
  "messagePattern",
]);

export interface EvalExample {
  readonly id: string;
  readonly description: string;
  readonly changedFiles: readonly string[];
  readonly diff: string;
  readonly expectedProblems?: readonly EvalExpectedProblem[];
  readonly expectedSkip?: boolean;
  readonly tags?: readonly string[];
}

export interface EvalExpectedProblem {
  readonly file: string;
  readonly line: number;
  readonly severity: EvalSeverity;
  readonly category: string;
  readonly messagePattern?: RegExp | string;
}

export interface EvalResult {
  readonly exampleId: string;
  readonly passed: boolean;
  readonly foundProblems: number;
  readonly expectedProblems: number;
  readonly missingProblems: readonly EvalExpectedProblem[];
  readonly unexpectedProblems: readonly EvalUnexpectedProblem[];
  readonly durationMs: number;
}

export interface EvalUnexpectedProblem {
  readonly file: string;
  readonly line: number;
  readonly severity: string;
  readonly category: string;
  readonly message: string;
}

export interface EvalRunOptions {
  readonly examples: readonly EvalExample[];
  readonly maxConcurrency?: number;
  readonly reviewFn: (example: EvalExample) => Promise<EvalReviewOutput>;
}

export interface EvalReviewOutput {
  readonly problems: readonly EvalUnexpectedProblem[];
  readonly skipReason?: string;
  readonly summary?: string;
}

export interface EvalRunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly EvalResult[];
  readonly durationMs: number;
}

export interface EvalValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface EvalValidationOptions {
  readonly sourceName?: string;
}

export interface EvalValidationResult {
  readonly valid: boolean;
  readonly issues: readonly EvalValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopedPath(path: string, sourceName?: string): string {
  return sourceName ? `${sourceName}:${path}` : path;
}

function addIssue(
  issues: EvalValidationIssue[],
  path: string,
  message: string,
  sourceName?: string,
): void {
  issues.push({ path: scopedPath(path, sourceName), message });
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: EvalValidationIssue[],
  sourceName?: string,
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, path, "must be a non-empty string", sourceName);
    return false;
  }
  return true;
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: EvalValidationIssue[],
  sourceName?: string,
  options: { allowEmpty?: boolean } = {},
): value is string[] {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "must be an array of non-empty strings", sourceName);
    return false;
  }
  if (value.length === 0 && !options.allowEmpty) {
    addIssue(issues, path, "must include at least one entry", sourceName);
  }
  value.forEach((entry, index) => {
    validateNonEmptyString(entry, `${path}[${index}]`, issues, sourceName);
  });
  return value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function validateExpectedProblem(
  value: unknown,
  path: string,
  issues: EvalValidationIssue[],
  sourceName?: string,
): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object", sourceName);
    return;
  }

  for (const key of Object.keys(value)) {
    if (!evalExpectedProblemKeys.has(key)) {
      addIssue(issues, `${path}.${key}`, "is not a supported expected problem field", sourceName);
    }
  }

  validateNonEmptyString(value.file, `${path}.file`, issues, sourceName);
  if (!Number.isInteger(value.line) || (value.line as number) <= 0) {
    addIssue(issues, `${path}.line`, "must be a positive integer", sourceName);
  }
  if (typeof value.severity !== "string" || !evalProblemSeverities.has(value.severity)) {
    addIssue(
      issues,
      `${path}.severity`,
      `must be one of ${EVAL_SEVERITIES.join(", ")}`,
      sourceName,
    );
  }
  validateNonEmptyString(value.category, `${path}.category`, issues, sourceName);
  if (
    value.messagePattern !== undefined &&
    typeof value.messagePattern !== "string" &&
    !(value.messagePattern instanceof RegExp)
  ) {
    addIssue(issues, `${path}.messagePattern`, "must be a string", sourceName);
  }
}

export function validateEvalExample(
  value: unknown,
  options: EvalValidationOptions = {},
): EvalValidationResult {
  const issues: EvalValidationIssue[] = [];
  const sourceName = options.sourceName;

  if (!isRecord(value)) {
    addIssue(issues, "$", "must be an object", sourceName);
    return { valid: false, issues };
  }

  for (const key of Object.keys(value)) {
    if (!evalExampleKeys.has(key)) {
      addIssue(issues, `$.${key}`, "is not a supported eval fixture field", sourceName);
    }
  }

  validateNonEmptyString(value.id, "$.id", issues, sourceName);
  validateNonEmptyString(value.description, "$.description", issues, sourceName);
  validateStringArray(value.changedFiles, "$.changedFiles", issues, sourceName);
  validateNonEmptyString(value.diff, "$.diff", issues, sourceName);

  if (value.expectedProblems !== undefined) {
    if (!Array.isArray(value.expectedProblems)) {
      addIssue(issues, "$.expectedProblems", "must be an array", sourceName);
    } else {
      value.expectedProblems.forEach((problem, index) => {
        validateExpectedProblem(problem, `$.expectedProblems[${index}]`, issues, sourceName);
      });
    }
  }

  if (value.expectedSkip !== undefined && typeof value.expectedSkip !== "boolean") {
    addIssue(issues, "$.expectedSkip", "must be a boolean", sourceName);
  }

  if (value.tags !== undefined) {
    validateStringArray(value.tags, "$.tags", issues, sourceName, { allowEmpty: true });
  }

  return { valid: issues.length === 0, issues };
}

function matchesMessagePattern(message: string, pattern: RegExp | string | undefined): boolean {
  if (pattern === undefined) {
    return true;
  }
  if (typeof pattern === "string") {
    return message.includes(pattern);
  }
  return pattern.test(message);
}

function problemMatchesExpected(
  prob: EvalUnexpectedProblem,
  exp: EvalExpectedProblem,
): boolean {
  return (
    prob.file === exp.file &&
    prob.line === exp.line &&
    prob.severity === exp.severity &&
    prob.category === exp.category &&
    matchesMessagePattern(prob.message, exp.messagePattern)
  );
}

export async function runEval(options: EvalRunOptions): Promise<EvalRunSummary> {
  const start = Date.now();
  const results: EvalResult[] = [];

  for (const example of options.examples) {
    const exampleStart = Date.now();
    const output = await options.reviewFn(example);
    const durationMs = Date.now() - exampleStart;

    const expected = example.expectedProblems ?? [];
    const found = output.problems;

    const missing: EvalExpectedProblem[] = [];
    const unexpected: EvalUnexpectedProblem[] = [];

    for (const exp of expected) {
      const matched = found.some((p) => problemMatchesExpected(p, exp));
      if (!matched) {
        missing.push(exp);
      }
    }

    for (const prob of found) {
      const matched = expected.some((e) => problemMatchesExpected(prob, e));
      if (!matched) {
        unexpected.push(prob);
      }
    }

    const passed = missing.length === 0 && unexpected.length === 0;

    results.push({
      exampleId: example.id,
      passed,
      foundProblems: found.length,
      expectedProblems: expected.length,
      missingProblems: missing,
      unexpectedProblems: unexpected,
      durationMs,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;

  return {
    total: options.examples.length,
    passed: passedCount,
    failed: options.examples.length - passedCount,
    results,
    durationMs: Date.now() - start,
  };
}

export const evalPackageName = "@aicr/eval";

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
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
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

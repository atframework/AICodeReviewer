import { describe, expect, it, vi } from "vitest";

import {
  createGithubProblemIssueDispatcher,
  createGiteaProblemIssueDispatcher,
  createGitlabProblemIssueDispatcher,
  type FetchLike,
  type ProblemResolutionAnalyzer,
  type ReviewProblem,
} from "../src/index.js";

const originalProblems: ReviewProblem[] = ["recurring", "remaining", "fixed"].map(fingerprint => ({
  fingerprint, file: `${fingerprint}.ts`, line: 10, endLine: 12,
  severity: "high", category: "correctness", message: `Original failure: ${fingerprint}.`,
}));
const recurrence: ReviewProblem = { ...originalProblems[0]!, line: 40, endLine: 42, message: "The failure returned at a new location." };
const unrelated: ReviewProblem = { ...originalProblems[0]!, fingerprint: "unrelated", file: "new.ts", message: "New scope only." };

function fingerprints(body: string, kind: "open" | "resolved"): string[] {
  return (new RegExp(`<!-- aicr:${kind}_problems=([^>]*)-->`, "u").exec(body)?.[1] ?? "")
    .trim().split(",").filter(Boolean).sort();
}

interface StoredIssue { number: number; iid: number; title: string; body: string; state: string }
type RunOptions = {
  summary?: string;
  issueMode?: "consolidated" | "per_commit";
  resolvedAction?: "close" | "mark_resolved" | "none";
  reviewedFiles?: readonly string[];
};

describe.each(["github", "gitea", "gitlab"] as const)("%s consolidated issue recurrence", provider => {
  function harness() {
    const issues = new Map<number, StoredIssue>();
    const writes: { method: string; number?: number; body: Record<string, unknown> }[] = [];
    let ancestry = "ahead";
    const response = (raw: unknown): Awaited<ReturnType<FetchLike>> => ({
      ok: true, status: 200, statusText: "OK", json: async () => raw, text: async () => JSON.stringify(raw),
    });
    const fetch: FetchLike = async (url, init) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      if (method === "GET" && (parsed.pathname.includes("/compare/") || parsed.pathname.endsWith("/merge_base"))) {
        if (ancestry === "unknown") return response({});
        return response(provider === "gitlab"
          ? { id: ancestry === "ahead" ? parsed.searchParams.get("refs[]") : "other-branch" }
          : { status: ancestry });
      }
      if (method === "GET" && parsed.pathname.endsWith("/issues")) {
        return response([...issues.values()].filter(issue => issue.state === "open")
          .map(issue => ({ ...issue, description: issue.body })));
      }
      const numberText = /\/issues\/(\d+)(?:\/(?:comments|notes))?$/u.exec(parsed.pathname)?.[1];
      const number = numberText ? Number(numberText) : undefined;
      if (method === "GET" && number !== undefined) {
        const issue = issues.get(number)!;
        return response({ ...issue, description: issue.body });
      }
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      if (method === "POST" && parsed.pathname.endsWith("/issues")) {
        const id = 17 + issues.size;
        const issue = { number: id, iid: id, title: String(body.title), body: String(body.body ?? body.description), state: "open" };
        issues.set(id, issue);
        writes.push({ method, body });
        return response({ ...issue, description: issue.body });
      }
      if (number !== undefined && ["PATCH", "PUT", "POST"].includes(method)) {
        writes.push({ method, number, body });
        if (method === "POST") return response({ id: writes.length });
        const issue = issues.get(number)!;
        if (typeof body.title === "string") issue.title = body.title;
        if (typeof (body.body ?? body.description) === "string") issue.body = String(body.body ?? body.description);
        if (body.state === "closed" || body.state_event === "close") issue.state = "closed";
        return response({ ...issue, description: issue.body });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    };
    const run = (headSha: string, problems: readonly ReviewProblem[], resolutionAnalyzer: ProblemResolutionAnalyzer,
      overrides: RunOptions = {}) => {
      const { reviewedFiles = ["recurring.ts", "remaining.ts", "fixed.ts", "new.ts"], summary = `Summary at ${headSha}`, ...settings } = overrides;
      const options = { owner: "org", repo: "repo", channelName: "findings", targetKind: "push", headSha,
        assignCommitter: false, fetch, resolutionAnalyzer, ...settings };
      const dispatcher = provider === "gitlab" ? createGitlabProblemIssueDispatcher({ ...options, projectId: "org/repo" })
        : provider === "gitea" ? createGiteaProblemIssueDispatcher({ ...options, baseUrl: "https://gitea.example" })
        : createGithubProblemIssueDispatcher(options);
      return dispatcher.reconcileProblems(problems, summary, { reviewedFiles });
    };
    const seed = async () => {
      await run("original", originalProblems, async () => new Set());
      await run("partial-fix", [], async () => new Set(["recurring", "fixed"]));
      expect(fingerprints(issues.get(17)!.body, "open")).toEqual(["remaining"]);
      expect(fingerprints(issues.get(17)!.body, "resolved")).toEqual(["fixed", "recurring"]);
      writes.length = 0;
    };
    return { issues, writes, run, seed, setAncestry: (value: string) => { ancestry = value; } };
  }

  it.each(["reported", "fixed", "unconfirmed", "analysis-failed", "unreviewed"])(
    "restores a recurring finding when the remaining finding is %s", async remaining => {
      const h = harness();
      await h.seed();
      const originalScope = /<!-- aicr:scope_fingerprint=[^>]+-->/u.exec(h.issues.get(17)!.body)![0];
      const analyzer = vi.fn<ProblemResolutionAnalyzer>().mockImplementation(async () => {
        if (remaining === "analysis-failed") throw new Error("offline");
        return new Set(remaining === "fixed" ? ["remaining"] : []);
      });
      const current = [recurrence, unrelated, ...(remaining === "reported" ? [originalProblems[1]!] : [])];
      await h.run("regression", current, analyzer,
        remaining === "unreviewed" ? { reviewedFiles: ["recurring.ts", "new.ts"] } : {});

      const old = h.issues.get(17)!;
      expect(old.state).toBe("open");
      expect(fingerprints(old.body, "open")).toEqual(remaining === "fixed" ? ["recurring"] : ["recurring", "remaining"]);
      expect(fingerprints(old.body, "resolved")).toEqual(remaining === "fixed" ? ["fixed", "remaining"] : ["fixed"]);
      expect(old.body).toContain("`recurring.ts:40-42`");
      expect(old.body).toContain(recurrence.message);
      expect(old.body).toContain("Original failure: fixed.");
      expect(old.body).toContain("Summary at original");
      expect(old.body).toContain(originalScope);
      expect(old.body).not.toContain("New scope only.");
      expect(old.body).not.toContain("new in `regress`");
      const updates = h.writes.filter(write => write.number === 17);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.method).toBe(provider === "gitlab" ? "PUT" : "PATCH");
      expect(updates[0]!.body[provider === "gitlab" ? "description" : "body"]).toBe(old.body);
      if (["reported", "unreviewed"].includes(remaining)) expect(analyzer).not.toHaveBeenCalled();
      else expect(analyzer.mock.calls.map(([candidates]) => candidates.map(p => p.fingerprint))).toEqual([["remaining"]]);

      if (remaining === "reported") {
        // Replaying the same findings cannot rewrite historical progress again.
        h.writes.length = 0;
        await h.run("regression", current, analyzer);
        expect(h.writes.filter(write => write.number === 17)).toHaveLength(0);
        const finalAnalyzer = vi.fn<ProblemResolutionAnalyzer>().mockImplementation(async candidates => new Set(candidates.map(p => p.fingerprint!)));
        await h.run("fixed-again", [], finalAnalyzer);
        expect(old.state).toBe("closed");
        expect(fingerprints(old.body, "open")).toEqual([]);
        expect(fingerprints(old.body, "resolved")).toEqual(["fixed", "recurring", "remaining"]);
        expect(finalAnalyzer.mock.calls.flatMap(([candidates]) => candidates.map(p => p.fingerprint))).not.toContain("fixed");
      }
    },
  );

  it("keeps resolved history out of analysis when no finding recurs", async () => {
    const h = harness();
    await h.seed();
    const before = h.issues.get(17)!.body;
    const analyzer = vi.fn<ProblemResolutionAnalyzer>().mockResolvedValue(new Set());
    await h.run("unrelated-change", [unrelated], analyzer);
    expect(h.issues.get(17)!.body).toBe(before);
    expect(h.writes.filter(write => write.number === 17)).toHaveLength(0);
    expect(analyzer.mock.calls.map(([candidates]) => candidates.map(p => p.fingerprint))).toEqual([["remaining"]]);
  });

  it.each(["diverged", "unknown", "per_commit", "none"] as const)("preserves the %s guard", async guard => {
    const h = harness();
    await h.seed();
    const before = h.issues.get(17)!.body;
    const analyzer = vi.fn<ProblemResolutionAnalyzer>().mockResolvedValue(new Set(["remaining"]));
    if (guard === "diverged" || guard === "unknown") h.setAncestry(guard);
    await h.run("regression", [recurrence, unrelated], analyzer,
      guard === "per_commit" ? { issueMode: "per_commit" } : guard === "none" ? { resolvedAction: "none" } : {});
    expect(h.issues.get(17)!.body).toBe(before);
    expect(h.issues.get(17)!.state).toBe("open");
    expect(h.writes.filter(write => write.number === 17)).toHaveLength(0);
    expect(analyzer).not.toHaveBeenCalled();
  });

  it("bounds cumulative resolved history without losing fingerprints or final closure", async () => {
    const h = harness();
    const resolvedIds = Array.from({ length: 33 }, (_, index) => `resolved-${index}`);
    const longProblems = resolvedIds.map(fingerprint => ({
      ...originalProblems[0]!, fingerprint, file: `${fingerprint}.ts`, message: "x".repeat(1024),
    }));
    const problems = [...originalProblems, ...longProblems];
    const reviewedFiles = problems.map(problem => problem.file);
    await h.run("original", problems, async () => new Set(), { reviewedFiles });
    for (let index = 0; index < resolvedIds.length; index += 1) {
      const current = [...originalProblems.slice(1), ...longProblems.slice(index + 1)];
      await h.run(`resolve-${index}`, current, async candidates => new Set(candidates.map(p => p.fingerprint!)), { reviewedFiles });
    }
    const body = h.issues.get(17)!.body;
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(fingerprints(body, "open")).toEqual(["fixed", "remaining"]);
    const resolved = fingerprints(body, "resolved");
    expect(resolved).toHaveLength(34);
    for (const fingerprint of ["recurring", ...Array.from({ length: 33 }, (_, index) => `resolved-${index}`)]) {
      expect(resolved).toContain(fingerprint);
    }
    await h.run("all-fixed", [], async candidates => new Set(candidates.map(p => p.fingerprint!)), { resolvedAction: "mark_resolved" });
    expect(h.issues.get(17)!.state).toBe("closed");
    expect(h.issues.get(17)!.body).toContain("✅ **Resolved**");
    expect(h.issues.get(17)!.body.length).toBeLessThanOrEqual(65_536);
  });

  it.each(["metadata", "details", "legacy"] as const)("budgets the resolved prefix before omitting resolved %s", async degradation => {
    const problems = [{ ...originalProblems[0]!, message: "d".repeat(400) }];
    const analyzer: ProblemResolutionAnalyzer = async () => new Set(["recurring"]);
    const calibration = harness();
    await calibration.run("original", problems, analyzer, { summary: "Summary" });
    await calibration.run("fixed", [], analyzer);
    const complete = calibration.issues.get(17)!.body;
    const metadata = /<!-- aicr:problem-meta=[^>]+-->\n/u.exec(complete)![0];
    const extra = degradation === "metadata" ? 0 : metadata.length + (degradation === "legacy" ? 200 : -40);
    const summary = "Summary" + "x".repeat(65_536 - complete.length + extra);

    const h = harness();
    if (degradation !== "legacy") {
      await h.run("original", problems, analyzer, { summary });
      expect(h.issues.get(17)!.body.length).toBeLessThanOrEqual(65_536);
    } else {
      await h.run("original", problems, analyzer, { summary: "Summary" });
      // Older GitLab/Gitea releases could persist bodies above the shared budget.
      h.issues.get(17)!.body = h.issues.get(17)!.body.replace("Summary", summary);
      expect(h.issues.get(17)!.body.length).toBeGreaterThan(65_536);
    }
    h.writes.length = 0;
    await h.run("fixed", [], analyzer, { resolvedAction: "mark_resolved" });
    const closed = h.issues.get(17)!;
    expect(closed.state).toBe("closed");
    expect(closed.body.length).toBeLessThanOrEqual(65_536);
    expect(closed.body).toContain("✅ **Resolved**");
    expect(closed.body.includes(summary)).toBe(true);
    expect(fingerprints(closed.body, "open")).toEqual([]);
    expect(fingerprints(closed.body, "resolved")).toEqual(["recurring"]);
    expect(/<!-- aicr:problem-meta=([^>]*)-->/u.exec(closed.body)?.[1]?.trim() ?? "").toBe("");
    if (degradation === "metadata") expect(closed.body).toContain("d".repeat(400));
    else expect(closed.body).not.toContain("d".repeat(400));
    expect(h.writes.filter(write => write.number === 17 && write.method !== "POST")).toHaveLength(1);
  });

  it("rejects an oversized resolved body before lifecycle comments or updates", async () => {
    const h = harness();
    await h.run("original", originalProblems, async () => new Set());
    h.issues.get(17)!.body = h.issues.get(17)!.body.replace("Summary at original", "x".repeat(65_536));
    h.writes.length = 0;
    await expect(h.run("fixed", [], async candidates => new Set(candidates.map(p => p.fingerprint!)), {
      resolvedAction: "mark_resolved",
    })).rejects.toThrow("65536");
    expect(h.issues.get(17)!.state).toBe("open");
    expect(h.writes).toHaveLength(0);
  });

  it("fails closed when required fingerprints alone exceed the body budget", async () => {
    const h = harness();
    const problems = Array.from({ length: 1100 }, (_, index) => ({
      ...originalProblems[0]!, fingerprint: index.toString(16).padStart(64, "0"), file: `f${index}.ts`,
    }));
    await expect(h.run("too-many", problems, async () => new Set())).rejects.toThrow("65536");
    expect(h.issues).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it("truncates resolved diagnostics without lone UTF-16 surrogates", async () => {
    for (const marker of ["🙂", "👩‍💻", "e\u0301"]) {
      const h = harness();
      const problem = { ...originalProblems[0]!, message: `${"x".repeat(399)}${marker}` };
      await h.run("original", [problem], async () => new Set());
      await h.run("resolved", [], async () => new Set(["recurring"]));
      expect(h.issues.get(17)!.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  });
});

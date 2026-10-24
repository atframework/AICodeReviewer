import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";
import { createGithubProblemIssueDispatcher, createGiteaProblemIssueDispatcher, createGitlabProblemIssueDispatcher, computeScopeFingerprint, type FetchLike } from "@aicr/outputs";
import { createProblemResolutionAnalyzer, parseProblemResolutionDecisions } from "../src/problem-resolution.js";

const testModel: ModelSpec = {
  providerKind: "openai_compatible",
  providerId: "triage-provider",
  modelId: "triage-model",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createSourceRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aicr-resolution-"));
  temporaryDirectories.push(dir);
  return dir;
}

describe("parseProblemResolutionDecisions", () => {
  it("accepts only exact expected fingerprints with boolean decisions", () => {
    const decisions = parseProblemResolutionDecisions([
      "```json",
      JSON.stringify({ decisions: [
        { fingerprint: "fp-fixed", resolved: true, reason: "guard added" },
        { fingerprint: "fp-open", resolved: false },
        { fingerprint: "invented", resolved: true },
        { fingerprint: "fp-invalid", resolved: "yes" },
      ] }),
      "```",
    ].join("\n"), new Set(["fp-fixed", "fp-open", "fp-invalid"]));

    expect(decisions).toEqual([
      { fingerprint: "fp-fixed", resolved: true, reason: "guard added" },
      { fingerprint: "fp-open", resolved: false, reason: "" },
    ]);
  });

  it("fails closed for malformed output", () => {
    expect(parseProblemResolutionDecisions("not json", new Set(["fp"]))).toEqual([]);
    expect(parseProblemResolutionDecisions('{"decisions":', new Set(["fp"]))).toEqual([]);
  });

  it("rejects conflicting duplicate verdicts and approvals without evidence", () => {
    expect(parseProblemResolutionDecisions(JSON.stringify({ decisions: [
      { fingerprint: "fp", resolved: false, reason: "Still fails" },
      { fingerprint: "fp", resolved: true, reason: "Fixed" },
      { fingerprint: "no-evidence", resolved: true, reason: " " },
    ] }), new Set(["fp", "no-evidence"]))).toEqual([]);
  });

  it("fails closed for valid verdicts duplicated by invalid entries in either order", () => {
    const valid = { fingerprint: "fp", resolved: true, reason: "Fixed" };
    for (const invalid of [
      { fingerprint: "fp", resolved: "no" },
      { fingerprint: "fp", resolved: true },
    ]) {
      for (const decisions of [[valid, invalid], [invalid, valid]]) {
        expect(parseProblemResolutionDecisions(JSON.stringify({ decisions }), new Set(["fp"]))).toEqual([]);
      }
    }
  });
});

describe("createProblemResolutionAnalyzer", () => {
  it("uses the configured triage model and current source, then caches decisions", async () => {
    const sourceRoot = await createSourceRoot();
    await writeFile(join(sourceRoot, "auth.ts"), "export function authorize(user?: string) {\n  if (!user) return false;\n  return true;\n}\n");
    const complete = vi.fn<ChatCompletionClient["complete"]>().mockResolvedValue({
      providerId: "triage-provider",
      modelId: "triage-model",
      content: JSON.stringify({ decisions: [{ fingerprint: "fp-auth", resolved: true, reason: "guard exists" }] }),
      raw: {},
    });
    const analyzer = createProblemResolutionAnalyzer({ llm: { complete }, model: testModel, sourceRoot });
    const candidate = {
      file: "auth.ts",
      line: 2,
      severity: "high" as const,
      category: "authorization",
      message: "Missing authentication guard.",
      fingerprint: "fp-auth",
    };

    await expect(analyzer([candidate])).resolves.toEqual(new Set(["fp-auth"]));
    await expect(analyzer([candidate])).resolves.toEqual(new Set(["fp-auth"]));

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0].model).toBe(testModel);
    const userPrompt = complete.mock.calls[0]?.[0].messages[1]?.content ?? "";
    expect(userPrompt).toContain("Missing authentication guard.");
    expect(userPrompt).toContain("if (!user) return false");
  });

  it("retains candidates when a valid verdict is duplicated by an invalid entry", async () => {
    const sourceRoot = await createSourceRoot();
    await writeFile(join(sourceRoot, "auth.ts"), "return success;\n");
    const complete = vi.fn<ChatCompletionClient["complete"]>().mockResolvedValue({
      providerId: "triage-provider", modelId: "triage-model", raw: {},
      content: JSON.stringify({ decisions: [
        { fingerprint: "fp-auth", resolved: true, reason: "Success returns." },
        { fingerprint: "fp-auth", resolved: "invalid" },
      ] }),
    });
    const analyzer = createProblemResolutionAnalyzer({ llm: { complete }, model: testModel, sourceRoot });
    await expect(analyzer([{ file: "auth.ts", line: 1, severity: "high", category: "correctness", message: "Missing success", fingerprint: "fp-auth" }]))
      .resolves.toEqual(new Set());
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("retains candidates when source is missing, outside the source root, or omitted by the model", async () => {
    const sourceRoot = await createSourceRoot();
    await writeFile(join(sourceRoot, "present.ts"), "export const value = 1;\n");
    const complete = vi.fn<ChatCompletionClient["complete"]>().mockResolvedValue({
      providerId: "triage-provider",
      modelId: "triage-model",
      content: JSON.stringify({ decisions: [] }),
      raw: {},
    });
    const analyzer = createProblemResolutionAnalyzer({ llm: { complete }, model: testModel, sourceRoot });

    const result = await analyzer([
      { file: "present.ts", line: 1, severity: "low", category: "style", message: "Old diagnostic", fingerprint: "fp-present" },
      { file: "missing.ts", line: 1, severity: "high", category: "bug", message: "Missing", fingerprint: "fp-missing" },
      { file: "../outside.ts", line: 1, severity: "high", category: "bug", message: "Outside", fingerprint: "fp-outside" },
    ]);

    expect(result).toEqual(new Set());
    expect(complete).toHaveBeenCalledTimes(2);
    const prompt = complete.mock.calls[0]?.[0].messages[1]?.content ?? "";
    expect(prompt).toContain("fp-present");
    expect(prompt).not.toContain("fp-missing");
    expect(prompt).not.toContain("fp-outside");
  });

  it.each(["false", "missing"])("rechecks a %s verdict once and preserves earlier approvals", async (firstVerdict) => {
    const sourceRoot = await createSourceRoot();
    await writeFile(join(sourceRoot, "auth.ts"), "if (valid) return success;\nreturn failure;\n");
    const candidates = ["fp-fixed", "fp-recheck", "fp-open"].map(fingerprint => ({
      file: "auth.ts", line: 1, severity: "high" as const, category: "correctness",
      message: "Successful validation falls through to failure.", fingerprint,
    }));
    const complete = vi.fn<ChatCompletionClient["complete"]>()
      .mockResolvedValueOnce({ providerId: "triage-provider", modelId: "triage-model", raw: {},
        content: JSON.stringify({ decisions: [
          { fingerprint: "fp-fixed", resolved: true, reason: "Success returns immediately." },
          ...(firstVerdict === "false" ? [{ fingerprint: "fp-recheck", resolved: false, reason: "The success path is now fixed." }] : []),
          { fingerprint: "fp-open", resolved: false, reason: "Insufficient evidence." },
        ] }),
      })
      .mockResolvedValueOnce({ providerId: "triage-provider", modelId: "triage-model", raw: {},
        content: JSON.stringify({ decisions: [
          { fingerprint: "fp-recheck", resolved: true, reason: "The explicit success return prevents fallthrough." },
          { fingerprint: "fp-open", resolved: false, reason: "Insufficient evidence." },
        ] }),
      });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const analyzer = createProblemResolutionAnalyzer({ llm: { complete }, model: testModel, sourceRoot,
      logContext: { runId: "run-resolution", workspaceId: "test-workspace", headSha: "head-fixed" } });

    await expect(analyzer(candidates)).resolves.toEqual(new Set(["fp-fixed", "fp-recheck"]));
    await expect(analyzer(candidates)).resolves.toEqual(new Set(["fp-fixed", "fp-recheck"]));
    expect(complete).toHaveBeenCalledTimes(2);
    const recheck = complete.mock.calls[1]![0];
    expect(JSON.parse(recheck.messages[1]!.content).candidates.map((c: { fingerprint: string }) => c.fingerprint))
      .toEqual(["fp-recheck", "fp-open"]);
    expect(recheck.messages[0]!.content).toContain("remaining failure path");
    const audit = info.mock.calls.map(([line]) => JSON.parse(String(line)))
      .find(entry => entry.msg === "problem resolution analysis completed");
    expect(audit).toMatchObject({ runId: "run-resolution", workspaceId: "test-workspace", headSha: "head-fixed",
      candidateCount: 3, resolvedCount: 2, recheckedCount: 2 });
    expect(audit.decisions).toContainEqual(expect.objectContaining({ fingerprint: "fp-open", outcome: "retained", reasonCode: "model_unresolved" }));
    expect(JSON.stringify(audit)).not.toContain("if (valid)");
  });

  it("keeps confirmed progress when the confirmation request fails", async () => {
    const sourceRoot = await createSourceRoot();
    await writeFile(join(sourceRoot, "auth.ts"), "return success;\n");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const complete = vi.fn<ChatCompletionClient["complete"]>()
      .mockResolvedValueOnce({ providerId: "triage-provider", modelId: "triage-model", raw: {},
        content: JSON.stringify({ decisions: [{ fingerprint: "fp-fixed", resolved: true, reason: "Success returns." }] }) })
      .mockRejectedValueOnce(new Error("offline"));
    const analyzer = createProblemResolutionAnalyzer({ llm: { complete }, model: testModel, sourceRoot });
    const result = await analyzer(["fp-fixed", "fp-unknown"].map(fingerprint => ({
      file: "auth.ts", line: 1, severity: "high", category: "correctness", message: "Missing success path", fingerprint,
    })));
    expect(result).toEqual(new Set(["fp-fixed"]));
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each(["github", "gitea", "gitlab"])("%s publishes cumulative progress and closes with no open fingerprints", async (provider) => {
    const sourceRoot = await createSourceRoot();
    await writeFile(join(sourceRoot, "auth.ts"), "return success;\n");
    const fingerprints = ["fp-one", "fp-two", "fp-three", "fp-four"];
    let oldIssue = { number: 17, iid: 17, title: "[AICR] four problems", state: "open", body: [
      "<!-- aicr:managed=problem-issue -->", "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=findings -->", "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${computeScopeFingerprint("owner", "repo", "old")} -->`,
      "<!-- aicr:commit=old -->", `<!-- aicr:open_problems=${fingerprints.join(",")} -->`,
      "", "Original review summary", "", "---", "", "#### HIGH (4)", "",
      ...fingerprints.flatMap(fp => [`**correctness** — \`auth.ts:1\` <!-- aicr:fp=${fp} -->`, "", `Missing success return for ${fp}.`, ""]),
    ].join("\n") };
    const writes: { method: string; body: Record<string, unknown> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      const method = init?.method ?? "GET";
      let raw: unknown = [];
      if (url.includes("/compare/")) raw = { status: "ahead" };
      else if (url.includes("/merge_base?")) raw = { id: new URL(url).searchParams.get("refs[]") };
      else if (method === "GET" && url.includes("/issues?")) raw = [{ ...oldIssue, description: oldIssue.body }];
      else if (method !== "GET") {
        const body = JSON.parse(init!.body!) as Record<string, unknown>;
        writes.push({ method, body });
        if (method === "PATCH" || method === "PUT") oldIssue = { ...oldIssue, ...body,
          ...(typeof body.description === "string" ? { body: body.description } : {}),
          ...(body.state_event === "close" ? { state: "closed" } : {}),
        };
        raw = oldIssue;
      } else raw = oldIssue;
      return { ok: true, status: 200, statusText: "OK", json: async () => raw, text: async () => JSON.stringify(raw) };
    };
    const run = async (headSha: string, fixed: readonly string[]) => {
      const complete = vi.fn<ChatCompletionClient["complete"]>().mockImplementation(async input => ({
        providerId: "triage-provider", modelId: "triage-model", raw: {},
        content: JSON.stringify({ decisions: JSON.parse(input.messages[1]!.content).candidates.map((c: { fingerprint: string }) => ({
          fingerprint: c.fingerprint, resolved: fixed.includes(c.fingerprint),
          reason: fixed.includes(c.fingerprint) ? "Success returns." : "The original failure remains.",
        })) }),
      }));
      const resolutionAnalyzer = createProblemResolutionAnalyzer({ llm: { complete }, model: testModel, sourceRoot });
      const options = { owner: "owner", repo: "repo", channelName: "findings", targetKind: "push" as const,
        headSha, fetch, assignCommitter: false, resolutionAnalyzer };
      const dispatcher = provider === "gitlab" ? createGitlabProblemIssueDispatcher({ ...options, projectId: "owner/repo" })
        : provider === "gitea" ? createGiteaProblemIssueDispatcher({ ...options, baseUrl: "https://gitea.example" })
        : createGithubProblemIssueDispatcher(options);
      return dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["auth.ts"] });
    };

    await run("partially-fixed", fingerprints.slice(2));
    expect(oldIssue.body).toContain("Resolved (2)");
    await run("more-fixed", fingerprints.slice(1));
    expect(oldIssue.state).toBe("open");
    expect(oldIssue.body).toContain("<!-- aicr:open_problems=fp-one -->");
    expect(oldIssue.body).toContain("Original review summary");
    for (const fp of fingerprints.slice(1)) expect(oldIssue.body).toContain(fp);
    expect(oldIssue.body).toContain("Resolved (3)");
    expect(oldIssue.body).toContain("Missing success return for fp-four.");
    expect(writes.some(w => ["PATCH", "PUT"].includes(w.method) && typeof (w.body.body ?? w.body.description) === "string")).toBe(true);
    expect(writes.some(w => w.body.state === "closed" || w.body.state_event === "close")).toBe(false);
    await run("all-fixed", fingerprints);
    expect(oldIssue.state).toBe("closed");
    expect(oldIssue.body).toContain("<!-- aicr:open_problems= -->");
    expect(oldIssue.body).toContain("Resolved (4)");
    expect(oldIssue.body).toContain("Missing success return for fp-four.");
    expect(writes.filter(w => w.method === "POST")).toHaveLength(1);
  });

  it("retains every candidate when the model call fails", async () => {
    const sourceRoot = await createSourceRoot();
    await writeFile(join(sourceRoot, "index.ts"), "export const value = 1;\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const analyzer = createProblemResolutionAnalyzer({
      llm: { complete: vi.fn().mockRejectedValue(new Error("offline")) },
      model: testModel,
      sourceRoot,
    });

    await expect(analyzer([{
      file: "index.ts",
      line: 1,
      severity: "medium",
      category: "correctness",
      message: "Old diagnostic",
      fingerprint: "fp-failure",
    }])).resolves.toEqual(new Set());
    expect(warn).toHaveBeenCalledOnce();
  });
});

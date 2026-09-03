import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";
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
    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = complete.mock.calls[0]?.[0].messages[1]?.content ?? "";
    expect(prompt).toContain("fp-present");
    expect(prompt).not.toContain("fp-missing");
    expect(prompt).not.toContain("fp-outside");
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

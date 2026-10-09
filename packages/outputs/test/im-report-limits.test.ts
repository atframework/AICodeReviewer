import { describe, expect, it } from "vitest";

import { createFeishuAppDispatcher, createFeishuBotDispatcher, createWeComBotDispatcher, FeishuAppClient,
  type FetchLike, type ReviewProblem } from "../src/index.js";

const response = (data: unknown) => ({ ok: true, status: 200, statusText: "OK",
  json: async () => data, text: async () => JSON.stringify(data) });
const problem: ReviewProblem = { file: "src/script.cpp", line: 153, severity: "medium", category: "correctness",
  message: "中文分析".repeat(180) + "\n\n完整结论", suggestion: "修复建议".repeat(100),
  codeSnippet: "StringCast<TCHAR>(text.c_str())", codeLanguage: "cpp" };

function capture() {
  const bodies: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "token", expire: 7200 });
    bodies.push(init?.body ?? "{}");
    return response({ code: 0, errcode: 0, data: { message_id: "om_report" } });
  };
  return { bodies, fetch };
}

describe("IM reports use actual platform byte limits", () => {
  it.each(["webhook", "application"] as const)("preserves complete Feishu %s reports below the cap", async kind => {
    const { bodies, fetch } = capture();
    const dispatcher = kind === "webhook" ? createFeishuBotDispatcher({ webhookUrl: "https://example.invalid/hook", fetch })
      : createFeishuAppDispatcher({ client: new FeishuAppClient({ appId: "app", appSecret: "secret", fetch }), receiveId: "oc_report" });
    await dispatcher.publishAggregatedProblems([problem], "Summary", '<at id="ou_author"></at>');
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!);
    const card = kind === "webhook" ? body.card : JSON.parse(body.content);
    const content = card.body.elements[0].content;
    expect(content).toContain(problem.message);
    expect(content).toContain(problem.suggestion);
    expect(content).toContain(problem.codeSnippet);
    expect(content).not.toContain("Report truncated");
  });

  it.each(["webhook", "application"] as const)("bounds serialized Feishu %s payloads and retains links and mentions", async kind => {
    const { bodies, fetch } = capture();
    const dispatcher = kind === "webhook" ? createFeishuBotDispatcher({ webhookUrl: "https://example.invalid/hook", secret: "secret", fetch })
      : createFeishuAppDispatcher({ client: new FeishuAppClient({ appId: "app", appSecret: "secret", fetch }), receiveId: "oc_report" });
    await dispatcher.publishAggregatedProblems([{ ...problem, message: '中文😃"\\'.repeat(10_000) }], "Summary", '<at id="ou_author"></at>',
      { detailLink: { url: "https://example.invalid/report", label: "Report" }, issueLinkCard: "full" },
      kind === "application" ? "ima-00000000-0000-0000-0000-000000000000" : undefined);
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!);
    // The recovery journal may replace the application's random UUID with 48 chars.
    const outgoing = kind === "webhook" ? bodies[0]! : JSON.stringify({ ...body, uuid: "0".repeat(48) });
    expect(Buffer.byteLength(outgoing)).toBeLessThanOrEqual((kind === "webhook" ? 20 : 30) * 1024);
    const card = kind === "webhook" ? body.card : JSON.parse(body.content);
    const content = card.body.elements[0].content;
    expect(content).toContain("Report truncated at the platform message size limit");
    expect(content).toContain("https://example.invalid/report");
    expect(JSON.stringify(card)).toContain("ou_author");
    if (kind === "application") expect(JSON.stringify(card)).toContain("ima-00000000-0000-0000-0000-000000000000");
    expect(content).not.toContain("�");
  });

  it("preserves a complete WeCom report below 4096 UTF-8 bytes", async () => {
    const { bodies, fetch } = capture();
    const full = { ...problem, message: "中文结论".repeat(150), suggestion: "修复建议".repeat(90) };
    await createWeComBotDispatcher({ webhookUrl: "https://example.invalid/hook", fetch })
      .publishAggregatedProblems([full], "Summary", "<@native_author>");
    const content = JSON.parse(bodies[0]!).markdown.content;
    expect(content).toContain(full.message);
    expect(content).toContain(full.suggestion);
    expect(content).toContain(full.codeSnippet);
    expect(content).not.toContain("Report truncated");
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
  });

  it("bounds oversized WeCom reports without splitting Unicode or dropping mentions", async () => {
    const { bodies, fetch } = capture();
    await createWeComBotDispatcher({ webhookUrl: "https://example.invalid/hook", fetch })
      .publishAggregatedProblems([{ ...problem, message: "中文😃".repeat(4000) }], "Summary", "<@native_author>");
    expect(bodies).toHaveLength(1);
    const content = JSON.parse(bodies[0]!).markdown.content;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(content)).toBeGreaterThan(4080);
    expect(content).toContain("Report truncated");
    expect(content).toContain("<@native_author>");
    expect(content).not.toContain("�");
  });

  it("does not truncate a WeCom message at exactly 4096 bytes", async () => {
    const { bodies, fetch } = capture();
    const dispatcher = createWeComBotDispatcher({ webhookUrl: "https://example.invalid/hook", fetch });
    await dispatcher.publishAggregatedProblems([], "S".repeat(4096));
    await dispatcher.publishAggregatedProblems([], "S".repeat(4097));
    expect(JSON.parse(bodies[0]!).markdown.content).toBe("S".repeat(4096));
    expect(JSON.parse(bodies[1]!).markdown.content).toContain("Report truncated");
    expect(Buffer.byteLength(JSON.parse(bodies[1]!).markdown.content)).toBeLessThanOrEqual(4096);
  });

  it("rejects oversized reserved mention metadata before sending", async () => {
    const { bodies, fetch } = capture();
    await expect(createWeComBotDispatcher({ webhookUrl: "https://example.invalid/hook", fetch })
      .publishAggregatedProblems([problem], "Summary", "M".repeat(4097)))
      .rejects.toThrow("metadata exceeds the platform size limit");
    expect(bodies).toHaveLength(0);
  });
});

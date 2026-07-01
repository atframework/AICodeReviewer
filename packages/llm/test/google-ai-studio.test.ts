import { describe, expect, it } from "vitest";

import {
  createGoogleAiStudioChatClient,
  LlmProviderError,
  type FetchLike,
  type ModelSpec,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

const model: ModelSpec = {
  providerKind: "google_ai_studio",
  providerId: "gemini-prod",
  modelId: "gemini-2.5-pro",
  apiKeyEnv: "GEMINI_API_KEY",
};

describe("createGoogleAiStudioChatClient", () => {
  it("posts Gemini generateContent requests and separates thought parts from final text", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createGoogleAiStudioChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  { text: "推理过程", thought: true },
                  { text: '{"summary":"最终结论"}' },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
        });
      },
      apiKeyResolver: (name) => (name === "GEMINI_API_KEY" ? "gemini-secret" : undefined),
    });

    const result = await client.complete({
      model: {
        ...model,
        responseFormat: { kind: "json_object" },
        thinking: { enabled: true, budgetTokens: 2048 },
      },
      messages: [
        { role: "system", content: "review strictly" },
        { role: "user", content: "diff" },
      ],
      temperature: 0.2,
      maxTokens: 512,
    });

    expect(result.content).toBe('{"summary":"最终结论"}');
    expect(result.reasoningContent).toBe("推理过程");
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-goog-api-key": "gemini-secret",
    });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "diff" }] }],
      systemInstruction: { parts: [{ text: "review strictly" }] },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
        thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
      },
    });
  });

  it("extracts cached content tokens from usageMetadata", async () => {
    const client = createGoogleAiStudioChatClient({
      fetch: async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          usageMetadata: {
            promptTokenCount: 6000,
            candidatesTokenCount: 50,
            totalTokenCount: 6050,
            cachedContentTokenCount: 5000,
          },
        }),
      apiKeyResolver: () => "gemini-secret",
    });

    const result = await client.complete({ model, messages: [{ role: "user", content: "diff" }] });

    expect(result.usage).toEqual({
      promptTokens: 6000,
      completionTokens: 50,
      totalTokens: 6050,
      cachedPromptTokens: 5000,
    });
  });

  it("passes JSON schema response configuration", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createGoogleAiStudioChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ candidates: [{ content: { parts: [{ text: "{}" }] } }] });
      },
      apiKeyResolver: () => "key",
    });

    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
    };
    await client.complete({
      model: { ...model, responseFormat: { kind: "json_schema", schema } },
      messages: [{ role: "user", content: "hi" }],
    });

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(schema);
  });

  it("throws a typed error when the API key is missing", async () => {
    const client = createGoogleAiStudioChatClient({
      fetch: async () => jsonResponse({}),
      apiKeyResolver: () => undefined,
    });

    await expect(
      client.complete({ model, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });
});
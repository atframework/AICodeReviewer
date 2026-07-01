import { describe, expect, it } from "vitest";

import { createAnthropicChatClient, type FetchLike, type ModelSpec } from "../src/index.js";

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
  providerKind: "anthropic",
  providerId: "claude-prod",
  modelId: "claude-sonnet-4.5",
  apiKeyEnv: "ANTHROPIC_API_KEY",
};

describe("createAnthropicChatClient", () => {
  it("keeps Claude thinking blocks separate from final text", async () => {
    const client = createAnthropicChatClient({
      fetch: async () =>
        jsonResponse({
          content: [
            { type: "thinking", thinking: "内部推理" },
            { type: "text", text: '{"summary":"最终结论"}' },
          ],
          usage: { input_tokens: 10, output_tokens: 6 },
        }),
      apiKeyResolver: () => "key",
    });

    const result = await client.complete({
      model,
      messages: [{ role: "user", content: "review" }],
    });

    expect(result.content).toBe('{"summary":"最终结论"}');
    expect(result.reasoningContent).toBe("内部推理");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 6 });
  });

  it("extracts cache read and cache creation tokens into total prompt tokens", async () => {
    const client = createAnthropicChatClient({
      fetch: async () =>
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 2000,
          },
        }),
      apiKeyResolver: () => "key",
    });

    const result = await client.complete({
      model,
      messages: [{ role: "user", content: "review" }],
    });

    expect(result.usage).toEqual({
      promptTokens: 8000,
      completionTokens: 50,
      cachedPromptTokens: 5000,
      cacheCreationTokens: 2000,
    });
  });

  it("does not send thinking config when thinking.enabled is false", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createAnthropicChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ content: [{ type: "text", text: "ok" }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model: { ...model, thinking: { enabled: false, budgetTokens: 4096 } },
      messages: [{ role: "user", content: "review" }],
      maxTokens: 1024,
    });

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.max_tokens).toBe(1024);
    expect(body).not.toHaveProperty("thinking");
  });
});
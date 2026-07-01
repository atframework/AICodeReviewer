import { describe, expect, it } from "vitest";

import {
  createOpenAICompatibleChatClient,
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
  providerKind: "openai_compatible",
  providerId: "openai-prod",
  modelId: "gpt-test",
  baseUrl: "https://llm.example/v1/",
  apiKeyEnv: "OPENAI_API_KEY",
};

describe("createOpenAICompatibleChatClient", () => {
  it("posts chat completion requests and extracts text content", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        choices: [{ message: { content: "review result" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };
    const client = createOpenAICompatibleChatClient({
      fetch,
      apiKeyResolver: (name) => (name === "OPENAI_API_KEY" ? "secret-value" : undefined),
    });

    const result = await client.complete({
      model,
      messages: [
        { role: "system", content: "review strictly" },
        { role: "user", content: "diff" },
      ],
      temperature: 0.2,
      maxTokens: 256,
    });

    expect(result.content).toBe("review result");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(calls[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer secret-value",
    });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      model: "gpt-test",
      stream: false,
      temperature: 0.2,
      max_tokens: 256,
      messages: [
        { role: "system", content: "review strictly" },
        { role: "user", content: "diff" },
      ],
    });
  });

  it("extracts cached prompt tokens from prompt_tokens_details", async () => {
    const fetch: FetchLike = async () =>
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 50,
          total_tokens: 1550,
          prompt_tokens_details: { cached_tokens: 1200 },
        },
      });
    const client = createOpenAICompatibleChatClient({ fetch, apiKeyResolver: () => "secret-value" });

    const result = await client.complete({ model, messages: [] });

    expect(result.usage).toEqual({
      promptTokens: 1500,
      completionTokens: 50,
      totalTokens: 1550,
      cachedPromptTokens: 1200,
    });
  });

  it("extracts cached prompt tokens from DeepSeek prompt_cache_hit_tokens", async () => {
    const fetch: FetchLike = async () =>
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 50,
          total_tokens: 1550,
          prompt_cache_hit_tokens: 1200,
          prompt_cache_miss_tokens: 300,
        },
      });
    const client = createOpenAICompatibleChatClient({ fetch, apiKeyResolver: () => "secret-value" });

    const result = await client.complete({ model, messages: [] });

    expect(result.usage).toEqual({
      promptTokens: 1500,
      completionTokens: 50,
      totalTokens: 1550,
      cachedPromptTokens: 1200,
    });
  });

  it("supports OpenAI-compatible array content parts", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: [{ type: "text", text: "part one" }, { text: " part two" }] } }],
        }),
    });

    await expect(
      client.complete({
        model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).resolves.toMatchObject({ content: "part one part two" });
  });

  it("keeps DeepSeek/Kimi/GLM-style reasoning_content separate from final content", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                reasoning_content: "先分析改动影响，再生成结论。",
                content: '{"skipReason":"lgtm"}',
              },
            },
          ],
        }),
    });

    const result = await client.complete({
      model: { providerKind: "openai_compatible", providerId: "deepseek", modelId: "deepseek-v4-pro" },
      messages: [{ role: "user", content: "review" }],
    });

    expect(result.content).toBe('{"skipReason":"lgtm"}');
    expect(result.reasoningContent).toBe("先分析改动影响，再生成结论。");
  });

  it("separates thought parts from final text in OpenAI-compatible multimodal content", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: [
                  { type: "reasoning", text: "内部推理", thought: true },
                  { type: "text", text: '{"summary":"结论"}' },
                ],
              },
            },
          ],
        }),
    });

    const result = await client.complete({
      model: { providerKind: "openai_compatible", providerId: "glm", modelId: "glm-5.1" },
      messages: [{ role: "user", content: "review" }],
    });

    expect(result.content).toBe('{"summary":"结论"}');
    expect(result.reasoningContent).toBe("内部推理");
  });

  it("converts OpenAI function tool calls to AICR JSON toolCalls when content is empty", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "aicr.publish_summary",
                      arguments: '{"markdown":"工具结论"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
    });

    const result = await client.complete({
      model: { providerKind: "openai_compatible", providerId: "openai", modelId: "gpt-4.1" },
      messages: [{ role: "user", content: "review" }],
    });

    expect(JSON.parse(result.content)).toEqual({
      toolCalls: [{ name: "aicr.publish_summary", input: { markdown: "工具结论" } }],
    });
  });

  it("throws provider errors with retry-after details", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => ({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name) => (name.toLowerCase() === "retry-after" ? "10" : null) },
        async json() {
          return {};
        },
        async text() {
          return "rate limited";
        },
      }),
      apiKeyResolver: () => "secret-value",
    });

    await expect(
      client.complete({
        model,
        messages: [{ role: "user", content: "diff" }],
      }),
    ).rejects.toMatchObject({ status: 429, retryAfter: "10", responseBody: "rate limited" });
  });

  it("rejects unsupported provider kinds before making a request", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(
      client.complete({
        model: { providerKind: "anthropic", providerId: "anthropic", modelId: "claude" },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/not OpenAI-compatible/u);
  });

  it("throws a typed error when an API key env var is missing", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => jsonResponse({}),
      apiKeyResolver: () => undefined,
    });

    await expect(
      client.complete({
        model,
        messages: [{ role: "user", content: "diff" }],
      }),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });

  it("throws when the response has no choices array", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => jsonResponse({ id: "no-choices" }),
      apiKeyResolver: () => "key",
    });

    await expect(
      client.complete({ model, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/choices/u);
  });

  it("throws when choices[0] has no message", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => jsonResponse({ choices: [{}] }),
      apiKeyResolver: () => "key",
    });

    await expect(
      client.complete({ model, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/message/u);
  });

  it("throws when message content is not text or array", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => jsonResponse({ choices: [{ message: { content: 42 } }] }),
      apiKeyResolver: () => "key",
    });

    await expect(
      client.complete({ model, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/not text/u);
  });

  it("filters out non-text parts in array content", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: [{ type: "text", text: "ok" }, { type: "image", url: "img.png" }] } }],
        }),
    });

    const result = await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.content).toBe("ok");
  });

  it("omits usage when the response has no usage field", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    });

    const result = await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.usage).toBeUndefined();
  });

  it("includes the organization header when specified", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model: { ...model, organization: "my-org" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(calls[0]?.init?.headers).toMatchObject({ "openai-organization": "my-org" });
  });

  it("merges extraParams and extraBody into the request body", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model: {
        ...model,
        extraParams: { top_p: 0.9 },
        extraBody: { user: "test-user" },
      },
      messages: [{ role: "user", content: "hi" }],
    });

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.top_p).toBe(0.9);
    expect(body.user).toBe("test-user");
  });

  it("passes reasoning and structured-output parameters for GPT-compatible providers", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model: {
        ...model,
        reasoningEffort: "high",
        responseFormat: {
          kind: "json_schema",
          schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
        },
        toolChoice: { name: "aicr.publish_summary" },
        parallelToolCalls: false,
        seed: 123,
        logitBias: { "42": -1 },
      },
      messages: [{ role: "user", content: "hi" }],
    });

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.reasoning_effort).toBe("high");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "aicr_review_result", strict: true },
    });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "aicr.publish_summary" } });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.seed).toBe(123);
    expect(body.logit_bias).toEqual({ "42": -1 });
  });

  it("supports dropParams and allowedOpenaiParams for provider-specific compatibility", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model: {
        ...model,
        reasoningEffort: "medium",
        responseFormat: { kind: "json_object" },
        extraParams: { top_p: 0.8 },
        dropParams: ["top_p"],
        allowedOpenaiParams: ["reasoning_effort"],
      },
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.1,
    });

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.reasoning_effort).toBe("medium");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
  });

  it("uses the default OpenAI base URL when none is specified", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model: { providerKind: "openai_compatible", providerId: "openai", modelId: "gpt-4o" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses the default Ollama base URL when none is specified", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    });

    await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("does not include authorization header when no apiKeyEnv is set", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    });

    await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(calls[0]?.init?.headers).not.toHaveProperty("authorization");
  });

  it("includes extra headers from the model spec", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model: { ...model, extraHeaders: { "x-custom": "value" } },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(calls[0]?.init?.headers).toMatchObject({ "x-custom": "value" });
  });

  it("omits temperature and maxTokens from the body when not specified", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const client = createOpenAICompatibleChatClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model,
      messages: [{ role: "user", content: "hi" }],
    });

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("passes the signal through to the fetch call", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const client = createOpenAICompatibleChatClient({
      fetch: async (_url, init) => {
        capturedSignal = init?.signal;
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
      apiKeyResolver: () => "key",
    });

    await client.complete({
      model,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });

    expect(capturedSignal).toBe(controller.signal);
  });

  it("produces correct providerId and modelId in the result", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    });

    const result = await client.complete({
      model: { providerKind: "ollama", providerId: "my-ollama", modelId: "llama3" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.providerId).toBe("my-ollama");
    expect(result.modelId).toBe("llama3");
  });
});

describe("LlmProviderError", () => {
  it("stores status, retryAfter, and responseBody properties", () => {
    const error = new LlmProviderError("test error", {
      status: 429,
      retryAfter: "30",
      responseBody: "rate limited",
    });

    expect(error.name).toBe("LlmProviderError");
    expect(error.message).toBe("test error");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe("30");
    expect(error.responseBody).toBe("rate limited");
  });

  it("omits optional properties when not provided", () => {
    const error = new LlmProviderError("simple error");

    expect(error.status).toBeUndefined();
    expect(error.retryAfter).toBeUndefined();
    expect(error.responseBody).toBeUndefined();
  });

  it("is an instance of Error", () => {
    const error = new LlmProviderError("msg");

    expect(error).toBeInstanceOf(Error);
  });
});

describe("content extraction edge cases", () => {
  it("returns empty string for empty array content parts", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: [] } }],
        }),
    });

    const result = await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.content).toBe("");
  });

  it("includes raw response in the result", async () => {
    const rawResponse = { id: "chatcmpl-123", choices: [{ message: { content: "ok" } }] };
    const client = createOpenAICompatibleChatClient({
      fetch: async () => jsonResponse(rawResponse),
    });

    const result = await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.raw).toEqual(rawResponse);
  });
});

describe("usage extraction edge cases", () => {
  it("handles partial usage with only prompt_tokens", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100 },
        }),
    });

    const result = await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.usage).toEqual({ promptTokens: 100 });
  });

  it("handles usage where all token fields are numbers", async () => {
    const client = createOpenAICompatibleChatClient({
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
        }),
    });

    const result = await client.complete({
      model: { providerKind: "ollama", providerId: "ollama", modelId: "qwen" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.usage).toEqual({ promptTokens: 50, completionTokens: 25, totalTokens: 75 });
  });
});

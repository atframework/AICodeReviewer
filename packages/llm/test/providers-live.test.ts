import { describe, expect, it } from "vitest";

import { createChatClientFromModelSpec, LlmProviderError, type ModelSpec } from "../src/index.js";

for (const [provider, modelId] of [["zhipu", "glm-5.3-flash"], ["kimi", "kimi-for-coding"]] as const) {
  const prefix = `AICR_${provider.toUpperCase()}_TEST_`;
  const enabled = Object.keys(process.env).some(key => key.startsWith(prefix));
  describe.skipIf(!enabled)(`${provider} live coding endpoint`, () => {
    it("authenticates and returns a code-review answer with usage in one bounded request", async () => {
      const baseUrl = process.env[`${prefix}BASE_URL`];
      const apiKey = process.env[`${prefix}API_KEY`];
      const kind = process.env[`${prefix}KIND`] ?? "openai_compatible";
      if (!baseUrl || !apiKey) throw new Error(`${prefix}BASE_URL and ${prefix}API_KEY are required together.`);
      if (kind !== "openai_compatible" && kind !== "anthropic") throw new Error("Unsupported live test KIND.");
      let url: URL;
      try { url = new URL(baseUrl); } catch { throw new Error("Invalid live LLM base URL."); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error("Live LLM tests require an HTTPS base URL without embedded credentials, query or fragment.");
      }
      const model: ModelSpec = {
        providerId: provider, providerKind: kind, modelId, baseUrl, apiKey,
        // Both official coding endpoints accept this explicit non-thinking mode.
        extraBody: { thinking: { type: "disabled" } },
        extraHeaders: { "User-Agent": "AICodeReviewer/acceptance" },
      };
      let result;
      let failure = "transport or response error";
      try {
        result = await createChatClientFromModelSpec(model).complete({
          model, maxTokens: 256, signal: AbortSignal.timeout(60_000),
          messages: [{ role: "user", content: "Review this synthetic JavaScript function: function sum(a,b){return a-b;} It should add two numbers. Answer in one short sentence naming the bug and correction." }],
        });
      } catch (error) {
        // Provider errors may embed response bodies/credentials; never expose them in test reporters.
        if (error instanceof LlmProviderError) failure = `HTTP ${error.status ?? "unknown"}`;
      }
      if (!result) throw new Error(`Live ${provider}/${kind} request failed (${failure}).`);
      expect(result.content.trim().length > 0).toBe(true);
      expect(result.usage?.promptTokens).toBeGreaterThan(0);
      expect(result.usage?.completionTokens).toBeGreaterThan(0);
      console.info(JSON.stringify({ provider, kind, model: modelId, usage: result.usage }));
    }, 65_000);
  });
}

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatClientFromModelSpec, getModelCatalogBundledSnapshotPath, type ModelSpec } from "../src/index.js";
import { MODEL_PROVIDER_PRESETS, findModelProviderPreset } from "../src/provider-presets.js";

interface RawSnapshotProvider {
	readonly api?: unknown;
	readonly models?: unknown;
}

function loadRawSnapshot(): Readonly<Record<string, RawSnapshotProvider>> {
	return JSON.parse(readFileSync(getModelCatalogBundledSnapshotPath(), "utf8")) as Record<
		string,
		RawSnapshotProvider
	>;
}

describe("MODEL_PROVIDER_PRESETS", () => {
	it("has unique ids and well-formed fields", () => {
		expect(MODEL_PROVIDER_PRESETS.length).toBeGreaterThan(0);
		const ids = new Set<string>();
		for (const preset of MODEL_PROVIDER_PRESETS) {
			expect(ids.has(preset.id), `duplicate preset id ${preset.id}`).toBe(false);
			ids.add(preset.id);
			expect(preset.label.length).toBeGreaterThan(0);
			expect(["openai_compatible", "anthropic"]).toContain(preset.kind);
			expect(() => new URL(preset.baseUrl)).not.toThrow();
			expect(() => new URL(preset.docsUrl)).not.toThrow();
			expect(/^[A-Z][A-Z0-9_]*$/.test(preset.apiKeyEnv), `apiKeyEnv of ${preset.id}`).toBe(true);
			expect(preset.catalogProvider.length).toBeGreaterThan(0);
			expect(preset.suggestedModels.length).toBeGreaterThan(0);
			// Every preset ships an env reference only; credentials are never preset data.
			expect(preset).not.toHaveProperty("apiKey");
		}
	});

	it("pins every catalogProvider to an existing bundled snapshot provider", () => {
		const snapshot = loadRawSnapshot();
		for (const preset of MODEL_PROVIDER_PRESETS) {
			expect(
				Object.hasOwn(snapshot, preset.catalogProvider),
				`preset ${preset.id} references unknown catalog provider ${preset.catalogProvider}`,
			).toBe(true);
		}
	});

	it("keeps suggestedModels resolvable in the bundled snapshot", () => {
		const snapshot = loadRawSnapshot();
		for (const preset of MODEL_PROVIDER_PRESETS) {
			const provider = snapshot[preset.catalogProvider]!;
			const models = provider.models;
			expect(models !== null && typeof models === "object", `models map for ${preset.catalogProvider}`).toBe(true);
			for (const modelId of preset.suggestedModels) {
				expect(
					Object.hasOwn(models as Record<string, unknown>, modelId),
					`preset ${preset.id} suggests unknown model ${preset.catalogProvider}/${modelId}`,
				).toBe(true);
			}
		}
	});

	it("keeps Anthropic-compatible base URLs free of the /v1 suffix", () => {
		// The direct Anthropic client appends /v1/messages to base_url; a preset
		// carrying /v1 would produce a 404 path such as /api/paas/v4/v1/messages.
		for (const preset of MODEL_PROVIDER_PRESETS) {
			if (preset.kind !== "anthropic") continue;
			expect(preset.baseUrl.endsWith("/v1"), `preset ${preset.id}`).toBe(false);
		}
	});

	it("covers both wire protocols for every platform that documents an Anthropic endpoint", () => {
		const byBase = new Map<string, Set<string>>();
		for (const preset of MODEL_PROVIDER_PRESETS) {
			const key = preset.id.replace(/-anthropic$/u, "");
			const kinds = byBase.get(key) ?? new Set<string>();
			kinds.add(preset.kind);
			byBase.set(key, kinds);
		}
		// General prepaid accounts need OpenAI; Anthropic balance billing requires
		// explicit account allowlisting and is not a general platform preset.
		const openAiOnly = new Set(["zhipuai", "zai"]);
		for (const [baseId, kinds] of byBase) {
			if (openAiOnly.has(baseId)) {
				expect(kinds.has("anthropic"), `${baseId} unexpectedly gained an Anthropic preset`).toBe(false);
				continue;
			}
			expect(kinds.has("openai_compatible"), `${baseId} missing OpenAI-compatible preset`).toBe(true);
			expect(kinds.has("anthropic"), `${baseId} missing Anthropic-compatible preset`).toBe(true);
		}
	});

	it("offers current regional Anthropic endpoints and excludes retired recommendations", () => {
		for (const [id, baseUrl] of Object.entries({
			"alibaba-anthropic": "https://dashscope-intl.aliyuncs.com/apps/anthropic",
			"alibaba-token-plan-anthropic": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
			"tencent-token-plan-anthropic": "https://api.lkeap.cloud.tencent.com/plan/anthropic",
			"tencent-tokenhub-anthropic": "https://tokenhub.tencentmaas.com",
		})) {
			expect(findModelProviderPreset(id)).toMatchObject({ kind: "anthropic", baseUrl });
		}
		expect(MODEL_PROVIDER_PRESETS.some(p => p.id.startsWith("alibaba-coding-plan"))).toBe(false);
		expect(findModelProviderPreset("tencent-coding-plan")?.suggestedModels).toEqual(["tc-code-latest"]);
		expect(findModelProviderPreset("zhipuai-anthropic")).toBeUndefined();
		expect(findModelProviderPreset("zai-anthropic")).toBeUndefined();
	});

	it("findModelProviderPreset resolves by id", () => {
		const preset = findModelProviderPreset("zhipuai-coding-plan-anthropic");
		expect(preset?.kind).toBe("anthropic");
		expect(preset?.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
		expect(findModelProviderPreset("no-such-preset")).toBeUndefined();
	});
});

describe("provider preset direct requests", () => {
	afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
	it.each(MODEL_PROVIDER_PRESETS)("routes $id using its configured protocol, path and env credential", async preset => {
		const anthropic = preset.kind === "anthropic";
		const fetch = vi.fn().mockResolvedValue(Response.json(anthropic
			? { content: [{ type: "text", text: "reviewed" }] }
			: { choices: [{ message: { content: "reviewed" } }] }));
		vi.stubGlobal("fetch", fetch);
		vi.stubEnv(preset.apiKeyEnv, "test-preset-key");
		const model: ModelSpec = {
			providerId: preset.id, providerKind: preset.kind, modelId: preset.suggestedModels[0]!,
			baseUrl: `${preset.baseUrl}/`, apiKeyEnv: preset.apiKeyEnv,
		};
		const result = await createChatClientFromModelSpec(model).complete({ model, messages: [{ role: "user", content: "review" }] });
		expect(result.content).toBe("reviewed");
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe(`${preset.baseUrl}${anthropic ? "/v1/messages" : "/chat/completions"}`);
		expect(init.headers[anthropic ? "x-api-key" : "authorization"]).toBe(anthropic ? "test-preset-key" : "Bearer test-preset-key");
		expect(JSON.parse(init.body)).toMatchObject({ model: model.modelId, messages: [{ role: "user", content: "review" }] });
	});
});

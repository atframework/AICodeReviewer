import { describe, expect, it } from "vitest";

import type { ModelSpec } from "../src/index.js";
import {
	mapCatalogEntryToModelSpecFields,
	parseModelsDevApiJson,
	resolveCatalogEntry,
} from "../src/model-catalog.js";

const sampleApiJson = {
	openai: {
		id: "openai",
		name: "OpenAI",
		npm: "@ai-sdk/openai",
		env: ["OPENAI_API_KEY"],
		doc: "https://platform.openai.com/docs",
		models: {
			"gpt-4o": {
				id: "gpt-4o",
				name: "GPT-4o",
				family: "gpt",
				attachment: true,
				reasoning: false,
				tool_call: true,
				structured_output: true,
				temperature: true,
				knowledge: "2023-09",
				release_date: "2024-05-13",
				last_updated: "2024-08-06",
				modalities: { input: ["text", "image", "pdf"], output: ["text"] },
				open_weights: false,
				limit: { context: 128000, output: 16384 },
				cost: { input: 2.5, output: 10, cache_read: 1.25 },
			},
			o3: {
				id: "o3",
				name: "o3",
				family: "o",
				attachment: true,
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
				tool_call: true,
				structured_output: true,
				temperature: false,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 200000, output: 100000 },
				cost: { input: 2, output: 8, cache_read: 0.5 },
			},
		},
	},
	anthropic: {
		id: "anthropic",
		name: "Anthropic",
		npm: "@ai-sdk/anthropic",
		env: ["ANTHROPIC_API_KEY"],
		doc: "https://docs.anthropic.com",
		models: {
			"claude-sonnet-4-5": {
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				family: "claude-sonnet",
				attachment: true,
				reasoning: true,
				reasoning_options: [{ type: "budget_tokens", min: 1024 }],
				tool_call: true,
				temperature: true,
				modalities: { input: ["text", "image", "pdf"], output: ["text"] },
				limit: { context: 200000, output: 64000 },
				cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
			},
		},
	},
	"custom-gateway": {
		id: "custom-gateway",
		name: "Custom Gateway",
		models: {
			"deepseek-v4-flash": {
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: true,
				interleaved: { field: "reasoning_content" },
				reasoning_options: [{ type: "toggle" }],
				tool_call: true,
				temperature: true,
				status: "preview",
				experimental: false,
				modalities: { input: ["text"], output: ["text"] },
				limit: { context: 65536 },
				cost: { input: 0.1, output: 0.3, reasoning: 0.5 },
			},
		},
	},
};

describe("parseModelsDevApiJson", () => {
	it("parses a realistic api.json into keyed entries", () => {
		const catalog = parseModelsDevApiJson(sampleApiJson);
		expect(catalog.size).toBe(4);
		const gpt4o = catalog.get("openai/gpt-4o");
		expect(gpt4o).toBeDefined();
		expect(gpt4o!.contextWindow).toBe(128000);
		expect(gpt4o!.maxOutputTokens).toBe(16384);
		expect(gpt4o!.costInputPerMTok).toBe(2.5);
		expect(gpt4o!.costOutputPerMTok).toBe(10);
		expect(gpt4o!.costCacheReadPerMTok).toBe(1.25);
		expect(gpt4o!.supportsToolCall).toBe(true);
		expect(gpt4o!.supportsVision).toBe(true);
		expect(gpt4o!.supportsCachePrompt).toBe(true);
		expect(gpt4o!.supportsReasoning).toBe(false);
		expect(gpt4o!.supportsStructuredOutput).toBe(true);
		expect(gpt4o!.supportsTemperature).toBe(true);
		expect(gpt4o!.displayName).toBe("GPT-4o");
		expect(gpt4o!.family).toBe("gpt");
		expect(gpt4o!.providerDisplayName).toBe("OpenAI");
		expect(gpt4o!.providerNpmPackage).toBe("@ai-sdk/openai");
		expect(gpt4o!.providerEnvVars).toEqual(["OPENAI_API_KEY"]);
	});

	it("maps reasoning effort options to supportedReasoningEfforts", () => {
		const catalog = parseModelsDevApiJson(sampleApiJson);
		const o3 = catalog.get("openai/o3");
		expect(o3!.supportedReasoningEfforts).toEqual(["low", "medium", "high"]);
		expect(o3!.supportsReasoning).toBe(true);
		expect(o3!.supportsTemperature).toBe(false);
	});

	it("captures non-canonical effort tiers (none/xhigh/max/default) faithfully in source order", () => {
		const catalog = parseModelsDevApiJson({
			openai: {
				id: "openai",
				name: "OpenAI",
				models: {
					"gpt-5.5": {
						id: "gpt-5.5",
						reasoning: true,
						reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", null] }],
						modalities: { input: ["text"], output: ["text"] },
					},
				},
			},
			deepseek: {
				id: "deepseek",
				name: "DeepSeek",
				models: {
					"deepseek-v4-pro": {
						id: "deepseek-v4-pro",
						reasoning: true,
						reasoning_options: [{ type: "effort", values: ["high", "max", "high"] }],
						modalities: { input: ["text"], output: ["text"] },
					},
				},
			},
		});
		// GPT-5.x style: keep xhigh and none, preserve order, drop null.
		expect(catalog.get("openai/gpt-5.5")!.supportedReasoningEfforts).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		// DeepSeek style: keep max, deduplicate repeated tiers.
		expect(catalog.get("deepseek/deepseek-v4-pro")!.supportedReasoningEfforts).toEqual(["high", "max"]);
	});

	it("maps budget_tokens reasoning options to thinkingModes", () => {
		const catalog = parseModelsDevApiJson(sampleApiJson);
		const sonnet = catalog.get("anthropic/claude-sonnet-4-5");
		expect(sonnet!.thinkingModes).toEqual(["budget_tokens"]);
		expect(sonnet!.supportedReasoningEfforts).toBeUndefined();
		expect(sonnet!.supportsCachePrompt).toBe(true);
		expect(sonnet!.costCacheWritePerMTok).toBe(3.75);
	});

	it("maps interleaved reasoning field", () => {
		const catalog = parseModelsDevApiJson(sampleApiJson);
		const ds = catalog.get("custom-gateway/deepseek-v4-flash");
		expect(ds!.supportsInterleavedReasoning).toBe(true);
		expect(ds!.interleavedReasoningField).toBe("reasoning_content");
		expect(ds!.thinkingModes).toEqual(["toggle"]);
		expect(ds!.modelStatus).toBe("preview");
		expect(ds!.costReasoningPerMTok).toBe(0.5);
		expect(ds!.maxOutputTokens).toBeUndefined();
		expect(ds!.supportsVision).toBe(false);
	});

	it("treats experimental flag as modelStatus when status absent", () => {
		const catalog = parseModelsDevApiJson({
			prov: {
				id: "prov",
				models: {
					m1: { id: "m1", experimental: true, modalities: { input: ["text"], output: ["text"] } },
				},
			},
		});
		expect(catalog.get("prov/m1")!.modelStatus).toBe("experimental");
	});

	it("rejects non-object root", () => {
		expect(() => parseModelsDevApiJson("not an object")).toThrow();
		expect(() => parseModelsDevApiJson([1, 2, 3])).toThrow();
	});

	it("skips providers and models that are not plain objects", () => {
		const catalog = parseModelsDevApiJson({
			good: { id: "good", models: { m: { id: "m", modalities: { input: ["text"], output: ["text"] } } } },
			bad: "nope",
			other: { id: "other", models: "nope" },
		});
		expect(catalog.size).toBe(1);
		expect(catalog.has("good/m")).toBe(true);
	});
});

describe("resolveCatalogEntry", () => {
	const catalog = parseModelsDevApiJson(sampleApiJson);

	it("resolves via explicit override catalog_id first", () => {
		const result = resolveCatalogEntry(catalog, "my-provider", "gpt-4o", {
			overrideCatalogId: "openai/gpt-4o",
		});
		expect(result?.matchStrategy).toBe("explicit");
		expect(result?.entry.contextWindow).toBe(128000);
	});

	it("resolves via catalog_provider when direct key misses", () => {
		const result = resolveCatalogEntry(catalog, "my-custom", "gpt-4o", {
			catalogProvider: "openai",
		});
		expect(result?.matchStrategy).toBe("catalog_provider");
		expect(result?.matchedCatalogId).toBe("openai/gpt-4o");
	});

	it("resolves via direct <provider>/<model> key", () => {
		const result = resolveCatalogEntry(catalog, "openai", "gpt-4o");
		expect(result?.matchStrategy).toBe("direct");
	});

	it("falls back to fuzzy match by model id across providers", () => {
		const result = resolveCatalogEntry(catalog, "unknown-provider", "o3");
		expect(result?.matchStrategy).toBe("fuzzy");
		expect(result?.matchedCatalogId).toBe("openai/o3");
	});

	it("reports ambiguous fuzzy matches", () => {
		const ambiguous = parseModelsDevApiJson({
			a: { id: "a", models: { "shared-model": { id: "shared-model", modalities: { input: ["text"], output: ["text"] } } } },
			b: { id: "b", models: { "shared-model": { id: "shared-model", modalities: { input: ["text"], output: ["text"] } } } },
		});
		const result = resolveCatalogEntry(ambiguous, "x", "shared-model");
		expect(result?.matchStrategy).toBe("fuzzy");
		expect(result?.ambiguousMatches).toHaveLength(2);
	});

	it("returns undefined when nothing matches", () => {
		expect(resolveCatalogEntry(catalog, "x", "does-not-exist")).toBeUndefined();
	});

	it("explicit catalog_id that does not exist falls through to other strategies", () => {
		const result = resolveCatalogEntry(catalog, "openai", "gpt-4o", {
			overrideCatalogId: "nonexistent/model",
		});
		expect(result?.matchStrategy).toBe("direct");
	});
});

describe("mapCatalogEntryToModelSpecFields", () => {
	it("maps runtime and vendor fields with a catalog source", () => {
		const catalog = parseModelsDevApiJson(sampleApiJson);
		const entry = catalog.get("openai/gpt-4o")!;
		const fields = mapCatalogEntryToModelSpecFields(entry, "remote") as Partial<ModelSpec>;
		expect(fields.catalogSource).toBe("remote");
		expect(fields.contextWindow).toBe(128000);
		expect(fields.maxOutputTokens).toBe(16384);
		expect(fields.costInputPerMTok).toBe(2.5);
		expect(fields.supportsToolCall).toBe(true);
		expect(fields.supportsVision).toBe(true);
		expect(fields.displayName).toBe("GPT-4o");
		expect(fields.family).toBe("gpt");
		expect(fields.providerNpmPackage).toBe("@ai-sdk/openai");
		expect(fields.catalogId).toBe("openai/gpt-4o");
	});

	it("does not populate request-parameter fields absent from catalog", () => {
		const catalog = parseModelsDevApiJson(sampleApiJson);
		const entry = catalog.get("openai/gpt-4o")!;
		const fields = mapCatalogEntryToModelSpecFields(entry, "bundled");
		expect(fields.supportsSearch).toBeUndefined();
		expect(fields.supportsStreaming).toBeUndefined();
	});
});

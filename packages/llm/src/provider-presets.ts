/**
 * Curated LLM provider presets surfaced by the config management UI
 * (architecture §3.16). Applying a preset only prefills a provider draft
 * (id/kind/base_url/api_key_env/catalog_provider); the saved record is a plain
 * `llm.providers[]` entry with no runtime coupling to this table.
 *
 * Evidence rules (docs/ai/sources/models-and-usage.md, record "China platform
 * endpoints"):
 * - Official platform docs own endpoints and model availability; models.dev
 *   only supplies metadata. A stale catalog row is not endpoint evidence.
 * - Anthropic-compatible `baseUrl` values are NOT in models.dev; each entry
 *   cites the official platform doc in `docsUrl` and must omit the `/v1`
 *   suffix because the direct Anthropic client appends `/v1/messages`.
 * - `suggestedModels` must exist in the snapshot under `catalogProvider`.
 * - `apiKeyEnv` is only the suggested environment variable name; presets never
 *   carry credentials.
 */

export type ModelProviderPresetKind = "openai_compatible" | "anthropic";

export interface ModelProviderPreset {
	/** Stable preset id; also the suggested provider id for the new record. */
	readonly id: string;
	/** Short display label (dashboard UI is English-only). */
	readonly label: string;
	readonly kind: ModelProviderPresetKind;
	/** API base URL exactly as the provider draft should store it. */
	readonly baseUrl: string;
	/** Suggested env var name for the API key (the user may rename it). */
	readonly apiKeyEnv: string;
	/** models.dev provider id used for catalog metadata resolution. */
	readonly catalogProvider: string;
	/** Official documentation page evidencing the endpoint. */
	readonly docsUrl: string;
	/** Models known to exist in the bundled catalog snapshot. */
	readonly suggestedModels: readonly string[];
	/** Optional caveat (billing pool, key format, region) shown in the UI. */
	readonly note?: string;
}

interface PresetPairInput {
	readonly id: string;
	readonly label: string;
	readonly openAiBaseUrl: string;
	readonly anthropicBaseUrl?: string;
	readonly apiKeyEnv: string;
	readonly catalogProvider: string;
	readonly docsUrl: string;
	readonly suggestedModels: readonly string[];
	readonly note?: string;
}

function presetPair(input: PresetPairInput): readonly ModelProviderPreset[] {
	const shared = {
		apiKeyEnv: input.apiKeyEnv,
		catalogProvider: input.catalogProvider,
		docsUrl: input.docsUrl,
		suggestedModels: input.suggestedModels,
		...(input.note !== undefined ? { note: input.note } : {}),
	};
	const openAi: ModelProviderPreset = {
		id: input.id,
		label: `${input.label} (OpenAI-compatible)`,
		kind: "openai_compatible",
		baseUrl: input.openAiBaseUrl,
		...shared,
	};
	if (input.anthropicBaseUrl === undefined) {
		return [openAi];
	}
	return [
		openAi,
		{
			id: `${input.id}-anthropic`,
			label: `${input.label} (Anthropic-compatible)`,
			kind: "anthropic",
			baseUrl: input.anthropicBaseUrl,
			...shared,
		},
	];
}

const PRESET_PAIRS: readonly PresetPairInput[] = [
	{
		id: "kimi-for-coding",
		label: "Kimi For Coding (Kimi Code subscription)",
		openAiBaseUrl: "https://api.kimi.com/coding/v1",
		anthropicBaseUrl: "https://api.kimi.com/coding",
		apiKeyEnv: "KIMI_API_KEY",
		catalogProvider: "kimi-for-coding",
		docsUrl: "https://www.kimi.com/code/docs/",
		suggestedModels: ["kimi-for-coding", "k3-256k", "k3", "kimi-for-coding-highspeed"],
		note: "Subscription-plan key from the Kimi Code console; not interchangeable with Kimi Open Platform (pay-as-you-go) keys.",
	},
	{
		id: "moonshotai-cn",
		label: "Kimi Open Platform (China)",
		openAiBaseUrl: "https://api.moonshot.cn/v1",
		anthropicBaseUrl: "https://api.moonshot.cn/anthropic",
		apiKeyEnv: "MOONSHOT_API_KEY",
		catalogProvider: "moonshotai-cn",
		docsUrl: "https://platform.kimi.com/docs/api/overview",
		suggestedModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
	},
	{
		id: "moonshotai",
		label: "Kimi Open Platform (global)",
		openAiBaseUrl: "https://api.moonshot.ai/v1",
		anthropicBaseUrl: "https://api.moonshot.ai/anthropic",
		apiKeyEnv: "MOONSHOT_API_KEY",
		catalogProvider: "moonshotai",
		docsUrl: "https://platform.kimi.ai/docs/api/overview",
		suggestedModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
	},
	{
		id: "zhipuai",
		label: "Zhipu AI open platform (bigmodel.cn)",
		openAiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKeyEnv: "ZHIPU_API_KEY",
		catalogProvider: "zhipuai",
		docsUrl: "https://zcode.z.ai/en/docs/configuration",
		suggestedModels: ["glm-5.3", "glm-5.3-flash"],
		note: "Use the general OpenAI endpoint for prepaid balance. Anthropic balance billing requires a never-subscribed, allowlisted account; it is not a general pay-as-you-go option.",
	},
	{
		id: "zhipuai-coding-plan",
		label: "Zhipu GLM Coding Plan (bigmodel.cn)",
		openAiBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
		apiKeyEnv: "ZHIPU_API_KEY",
		catalogProvider: "zhipuai-coding-plan",
		docsUrl: "https://docs.bigmodel.cn/cn/coding-plan/quick-start",
		suggestedModels: ["glm-5.3", "glm-5.3-flash"],
		note: "Coding Plan account required. The Anthropic endpoint does not fall back to prepaid balance after plan exhaustion or expiry.",
	},
	{
		id: "zai",
		label: "Z.AI platform",
		openAiBaseUrl: "https://api.z.ai/api/paas/v4",
		apiKeyEnv: "ZAI_API_KEY",
		catalogProvider: "zai",
		docsUrl: "https://zcode.z.ai/en/docs/configuration",
		suggestedModels: ["glm-5.3", "glm-5.3-flash"],
		note: "Use the general OpenAI endpoint for prepaid balance. Anthropic balance billing requires a never-subscribed, allowlisted account; it is not a general pay-as-you-go option.",
	},
	{
		id: "zai-coding-plan",
		label: "Z.AI Coding Plan",
		openAiBaseUrl: "https://api.z.ai/api/coding/paas/v4",
		anthropicBaseUrl: "https://api.z.ai/api/anthropic",
		apiKeyEnv: "ZAI_API_KEY",
		catalogProvider: "zai-coding-plan",
		docsUrl: "https://docs.z.ai/devpack/tool/claude",
		suggestedModels: ["glm-5.3", "glm-5.3-flash"],
		note: "Coding Plan account required. The Anthropic endpoint does not fall back to prepaid balance after plan exhaustion or expiry.",
	},
	{
		id: "alibaba-cn",
		label: "Alibaba Cloud Model Studio (China, pay-as-you-go)",
		openAiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		anthropicBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
		apiKeyEnv: "DASHSCOPE_API_KEY",
		catalogProvider: "alibaba-cn",
		docsUrl: "https://help.aliyun.com/zh/model-studio/base-url",
		suggestedModels: ["qwen3.7-max", "qwen3-coder-plus", "qwen3.6-plus"],
		note: "Beijing region. For production, replace the shared URL with your workspace-specific endpoint from the console; API keys are region-specific.",
	},
	{
		id: "alibaba",
		label: "Alibaba Cloud Model Studio (Singapore, pay-as-you-go)",
		openAiBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		anthropicBaseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
		apiKeyEnv: "DASHSCOPE_API_KEY",
		catalogProvider: "alibaba",
		docsUrl: "https://help.aliyun.com/zh/model-studio/base-url",
		suggestedModels: ["qwen3.7-max", "qwen3-coder-plus", "qwen3.6-plus"],
		note: "Singapore region. For production, replace the shared URL with your workspace-specific endpoint from the console; API keys are region-specific.",
	},
	{
		id: "alibaba-token-plan-cn",
		label: "Alibaba Cloud Token Plan (China)",
		openAiBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		anthropicBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
		apiKeyEnv: "ALIBABA_TOKEN_PLAN_API_KEY",
		catalogProvider: "alibaba-token-plan-cn",
		docsUrl: "https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start",
		suggestedModels: ["qwen3.7-max", "qwen3.6-plus", "kimi-k2.6", "glm-5.2", "deepseek-v4-pro-0813"],
		note: "Beijing Token Plan key (sk-sp-...). Use matching region and plan endpoints. Check plan eligibility for automated reviews; use pay-as-you-go for backend workloads.",
	},
	{
		id: "alibaba-token-plan",
		label: "Alibaba Cloud Token Plan (Singapore)",
		openAiBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		anthropicBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
		apiKeyEnv: "ALIBABA_TOKEN_PLAN_API_KEY",
		catalogProvider: "alibaba-token-plan",
		docsUrl: "https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-quick-start",
		suggestedModels: ["qwen3.7-max", "qwen3.6-plus", "kimi-k2.6", "glm-5.2", "deepseek-v4-pro-0813"],
		note: "Singapore Token Plan key (sk-sp-...). Use matching region and plan endpoints. Check plan eligibility for automated reviews; use pay-as-you-go for backend workloads.",
	},
	{
		id: "tencent-coding-plan",
		label: "Tencent Cloud Coding Plan",
		openAiBaseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
		anthropicBaseUrl: "https://api.lkeap.cloud.tencent.com/coding/anthropic",
		apiKeyEnv: "TENCENT_CODING_PLAN_API_KEY",
		catalogProvider: "tencent-coding-plan",
		docsUrl: "https://cloud.tencent.com/document/product/1823/130092",
		suggestedModels: ["tc-code-latest"],
		note: "Personal coding tools only; the plan excludes automated backend/batch API use. Dedicated sk-sp- key; pay-as-you-go keys are not interchangeable.",
	},
	{
		id: "tencent-token-plan",
		label: "Tencent Cloud Token Plan",
		openAiBaseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
		anthropicBaseUrl: "https://api.lkeap.cloud.tencent.com/plan/anthropic",
		apiKeyEnv: "TENCENT_TOKEN_PLAN_API_KEY",
		catalogProvider: "tencent-token-plan",
		docsUrl: "https://cloud.tencent.com/document/product/1823/130060",
		suggestedModels: ["hy3", "hy4-preview"],
	},
	{
		id: "tencent-tokenhub",
		label: "Tencent TokenHub (pay-as-you-go)",
		openAiBaseUrl: "https://tokenhub.tencentmaas.com/v1",
		anthropicBaseUrl: "https://tokenhub.tencentmaas.com",
		apiKeyEnv: "TENCENT_TOKENHUB_API_KEY",
		catalogProvider: "tencent-tokenhub",
		docsUrl: "https://cloud.tencent.com/document/product/1823/130079",
		suggestedModels: ["hy3", "hy4-preview"],
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		openAiBaseUrl: "https://api.deepseek.com",
		anthropicBaseUrl: "https://api.deepseek.com/anthropic",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		catalogProvider: "deepseek",
		docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api/",
		suggestedModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
	},
];

function buildPresets(): readonly ModelProviderPreset[] {
	const out: ModelProviderPreset[] = [];
	const seen = new Set<string>();
	for (const pair of PRESET_PAIRS) {
		for (const preset of presetPair(pair)) {
			if (seen.has(preset.id)) {
				throw new Error(`duplicate provider preset id: ${preset.id}`);
			}
			seen.add(preset.id);
			out.push(preset);
		}
	}
	return Object.freeze(out);
}

/** Static preset table; validated by test/provider-presets.test.ts against the bundled models.dev snapshot. */
export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = buildPresets();

export function findModelProviderPreset(id: string): ModelProviderPreset | undefined {
	return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

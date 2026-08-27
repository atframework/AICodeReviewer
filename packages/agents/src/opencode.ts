import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import { buildOpencodeModelEntry, isOpenCodeCustomProvider } from "./model-metadata.js";
import type {
	AgentAdapter,
	AgentDetectResult,
	AgentKind,
	AgentMaterializeOptions,
	AgentMaterializeResult,
	AgentSpawnOptions,
} from "./types.js";
import { buildWebSearchCredentialEnvVars, warnUnsupportedWebSearchFields } from "./web-search.js";

export interface OpencodeAdapterOptions {
	readonly binary?: string;
}

const OPENCODE_BINARY = "opencode";
const OPENCODE_VERSION_ARGS = ["--version"];
export const OPENCODE_CONFIG_FILE = "opencode.json";
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * opencode's `websearch` tool fans out to the Exa or Parallel hosted MCP backend.
 * With AICR's custom providers the tool only activates when one of the
 * `OPENCODE_ENABLE_{EXA,PARALLEL}` env vars is set; the ordered provider choice
 * is pinned through `OPENCODE_WEBSEARCH_PROVIDER`. `EXA_API_KEY` and
 * `PARALLEL_API_KEY` enable keyed usage. Verified against opencode.ai/docs/tools
 * and anomalyco/opencode `tool/websearch.ts` (2026-08-27).
 */
const OPENCODE_WEB_SEARCH_CREDENTIAL_ENV_NAMES: Readonly<Record<string, string>> = {
	exa: "EXA_API_KEY",
	parallel: "PARALLEL_API_KEY",
};

const OPENCODE_WEB_SEARCH_FIELD_SUPPORT = {
	providers: true,
	providerIds: ["exa", "parallel"],
	exclude: false,
	timeout: false,
	credentials: Object.keys(OPENCODE_WEB_SEARCH_CREDENTIAL_ENV_NAMES),
	searxng: false,
};

/**
 * Coarse engine selection: opencode exposes only an Exa-vs-Parallel activation
 * switch, so the configured provider chain collapses to whichever backend the
 * operator actually credentialed or listed first.
 */
function resolveOpencodeSearchBackend(
	webSearch: AgentMaterializeOptions["webSearch"],
): "exa" | "parallel" {
	const listed = webSearch?.providers?.find((provider) => provider === "exa" || provider === "parallel");
	if (listed) return listed;
	const hasExaCredential = webSearch?.credentials?.exa !== undefined;
	const hasParallelCredential = webSearch?.credentials?.parallel !== undefined;
	if (hasParallelCredential && !hasExaCredential) return "parallel";
	return "exa";
}

async function detectBinary(
	binary: string,
	versionArgs: readonly string[],
): Promise<AgentDetectResult> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execFileAsync = promisify(execFile);

	try {
		const result = await execFileAsync(binary, versionArgs as string[], {
			timeout: 10_000,
			windowsHide: true,
		});
		const trimmed = result.stdout.trim();
		return { available: true, binary, ...(trimmed ? { version: trimmed } : {}) };
	} catch {
		return { available: false, binary };
	}
}

function buildOpencodeModelOptions(model: ModelSpec): Record<string, unknown> {
	return {
		...(model.extraParams ?? {}),
		...(model.extraBody ?? {}),
		...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
		...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
		...(model.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: model.thinkingBudgetTokens } : {}),
		...(model.thinking ? { thinking: model.thinking } : {}),
		...(model.responseFormat ? { responseFormat: model.responseFormat } : {}),
	};
}

function buildOpencodeProviderConfig(model: ModelSpec): Record<string, unknown> {
	const provider: Record<string, unknown> = {};
	if (isOpenCodeCustomProvider(model)) {
		provider.npm = model.providerNpmPackage ?? "@ai-sdk/openai-compatible";
		provider.name = model.providerDisplayName ?? model.providerId;
	}

	const providerOptions: Record<string, unknown> = {};
	if (model.baseUrl) providerOptions.baseURL = model.baseUrl;
	if (model.apiKeyEnv) providerOptions.apiKey = `{env:${model.apiKeyEnv}}`;
	if (model.extraHeaders) providerOptions.headers = model.extraHeaders;
	if (model.timeoutMs !== undefined) providerOptions.timeout = model.timeoutMs;
	if (model.apiVersion) providerOptions.apiVersion = model.apiVersion;
	if (model.organization) providerOptions.organization = model.organization;
	if (Object.keys(providerOptions).length > 0) {
		provider.options = providerOptions;
	}

	const modelEntry = buildOpencodeModelEntry(model) ?? {};
	const modelOptions = buildOpencodeModelOptions(model);
	if (Object.keys(modelOptions).length > 0) {
		modelEntry.options = modelOptions;
	}
	if (isOpenCodeCustomProvider(model) || Object.keys(modelEntry).length > 0) {
		provider.models = { [model.modelId]: modelEntry };
	}

	return provider;
}

function buildOpencodeModelId(model: ModelSpec): string {
	const providerPrefix = `${model.providerId}/`;
	return model.modelId.startsWith(providerPrefix)
		? model.modelId
		: `${providerPrefix}${model.modelId}`;
}

function buildOpencodeCompaction(options: AgentMaterializeOptions): Record<string, unknown> | undefined {
	const compaction = options.compaction;
	if (!compaction) return undefined;
	if (!compaction.auto) {
		return { auto: false };
	}
	const section: Record<string, unknown> = { auto: true };
	if (compaction.prune !== undefined) {
		section.prune = compaction.prune;
	}
	return section;
}

export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): AgentAdapter {
	const binary = options.binary ?? OPENCODE_BINARY;

	return {
		kind: "opencode" as AgentKind,

		async detect(): Promise<AgentDetectResult> {
			return detectBinary(binary, OPENCODE_VERSION_ARGS);
		},

		// Non-interactive `opencode run` emits the same NDJSON event stream shape kilo
		// inherits (kilo is an opencode fork), so the orchestrator extracts text, tool
		// calls, usage, and cost from `--format json` output for both. Flag surface
		// verified against opencode.ai/docs/cli (2026-08): `--cwd` and `--timeout` are
		// not `run` flags and were removed; `--dir`, `--variant`, and `--auto` are.
		buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
			// `--pure` is a global flag and must precede the subcommand. Runtime bundles
			// are self-contained, so external plugins would only add nondeterministic and
			// potentially privileged behavior to a headless review.
			const args: string[] = [binary, "--pure", "run", "--format", "json"];

			if (spawnOptions.autoApprove !== false) {
				args.push("--auto");
			}

			if (spawnOptions.model?.modelId) {
				args.push("--model", buildOpencodeModelId(spawnOptions.model));
				const variant = spawnOptions.model.defaultReasoningEffort ?? spawnOptions.model.reasoningEffort;
				if (variant) {
					args.push("--variant", variant);
				}
			}

			args.push("--dir", spawnOptions.workingDir);

			return args;
		},

		async materializeConfig(
			model: ModelSpec,
			workingDir: string,
			options?: AgentMaterializeOptions,
		): Promise<AgentMaterializeResult> {
			await mkdir(workingDir, { recursive: true });

			warnUnsupportedWebSearchFields("opencode", options?.webSearch, OPENCODE_WEB_SEARCH_FIELD_SUPPORT);

			const providerConfig = buildOpencodeProviderConfig(model);
			const configJson: Record<string, unknown> = {
				$schema: OPENCODE_CONFIG_SCHEMA,
				provider: {
					[model.providerId]: providerConfig,
				},
			};

			const compactionSection = buildOpencodeCompaction(options ?? {});
			if (compactionSection) {
				configJson.compaction = compactionSection;
			}

			// Explicit permission rule: `--auto` only auto-approves prompts, while a
			// config deny reliably keeps the hosted-backend websearch tool unreachable.
			if (options?.webSearch) {
				configJson.permission = {
					...((configJson.permission as Readonly<Record<string, unknown>> | undefined) ?? {}),
					websearch: options.webSearch.enabled ? "allow" : "deny",
				};
			}

			// The documented project config location is `opencode.json` in the working
			// directory root (opencode.ai/docs/config, 2026-08); `.opencode/` holds
			// agents/skills/commands but is not a config file location.
			const configContent = JSON.stringify(configJson, null, 2);
			const configPath = join(workingDir, OPENCODE_CONFIG_FILE);
			await writeFile(configPath, configContent, "utf8");

			const envVars: Record<string, string> = {};
			if (model.apiKeyEnv) {
				envVars[model.apiKeyEnv] = `\${${model.apiKeyEnv}}`;
			}
			// `--dir` and the sandbox cwd both point at workingDir, so the project-level
			// opencode.json is discovered natively. Do not set OPENCODE_CONFIG to this host
			// path: it is not valid inside docker/podman sandboxes and would load the same
			// project file twice even on native runs.
			envVars.OPENCODE_DISABLE_AUTOUPDATE = "true";
			envVars.OPENCODE_DISABLE_TERMINAL_TITLE = "true";
			envVars.OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
			// Custom-provider sessions only register the websearch tool when one of
			// these activation envs is set; keep it absent for disabled/hermetic runs.
			if (options?.webSearch?.enabled) {
				const backend = resolveOpencodeSearchBackend(options.webSearch);
				envVars[backend === "parallel" ? "OPENCODE_ENABLE_PARALLEL" : "OPENCODE_ENABLE_EXA"] = "1";
				// Current OpenCode uses this explicit override when both hosted
				// backends are available; older versions ignore it and still honor the
				// single activation flag above.
				envVars.OPENCODE_WEBSEARCH_PROVIDER = backend;
				Object.assign(envVars, buildWebSearchCredentialEnvVars(
					options.webSearch,
					{ [backend]: OPENCODE_WEB_SEARCH_CREDENTIAL_ENV_NAMES[backend]! },
				));
			}

			return {
				configFiles: new Map([
					[OPENCODE_CONFIG_FILE, configContent],
				]),
				envVars,
				workingDir,
			};
		},
	};
}

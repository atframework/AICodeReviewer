import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import { buildOpencodeModelEntry } from "./model-metadata.js";
import type {
	AgentAdapter,
	AgentDetectResult,
	AgentKind,
	AgentMaterializeResult,
	AgentSpawnOptions,
} from "./types.js";

export interface OpencodeAdapterOptions {
	readonly binary?: string;
}

const OPENCODE_BINARY = "opencode";
const OPENCODE_VERSION_ARGS = ["--version"];

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

function buildOpencodeProviderConfig(model: ModelSpec): Record<string, unknown> {
	const provider: Record<string, unknown> = {
		name: model.providerId,
		kind: model.providerKind,
	};

	if (model.baseUrl) {
		provider.baseURL = model.baseUrl;
	}

	if (model.apiKeyEnv) {
		provider.apiKey = `\${${model.apiKeyEnv}}`;
	}

	if (model.extraParams) {
		provider.options = model.extraParams;
	}

	const options: Record<string, unknown> = {
		...(model.extraParams ?? {}),
		...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
		...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
		...(model.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: model.thinkingBudgetTokens } : {}),
		...(model.thinking ? { thinking: model.thinking } : {}),
		...(model.responseFormat ? { responseFormat: model.responseFormat } : {}),
	};

	if (Object.keys(options).length > 0) {
		provider.options = options;
	}

	if (model.extraHeaders) {
		provider.extraHeaders = model.extraHeaders;
	}

	if (model.extraBody) {
		provider.extraBody = model.extraBody;
	}

	return provider;
}

export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): AgentAdapter {
	const binary = options.binary ?? OPENCODE_BINARY;

	return {
		kind: "opencode" as AgentKind,

		async detect(): Promise<AgentDetectResult> {
			return detectBinary(binary, OPENCODE_VERSION_ARGS);
		},

		buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
			const timeoutSec = Math.floor((spawnOptions.timeoutMs ?? 600_000) / 1000);
			const args: string[] = [binary, "run", "--auto"];

			if (spawnOptions.model?.modelId) {
				args.push("--model", spawnOptions.model.modelId);
			}

			args.push("--cwd", spawnOptions.workingDir);
			args.push("--timeout", String(timeoutSec));

			return args;
		},

		async materializeConfig(
			model: ModelSpec,
			workingDir: string,
		): Promise<AgentMaterializeResult> {
			await mkdir(workingDir, { recursive: true });

			const opencodeDir = join(workingDir, ".opencode");
			await mkdir(opencodeDir, { recursive: true });

		const providerConfig = buildOpencodeProviderConfig(model);
		const configJson: Record<string, unknown> = {
			provider: [providerConfig],
		};

		const modelEntry = buildOpencodeModelEntry(model);
		if (modelEntry) {
			configJson.models = {
				[model.providerId]: {
					[model.modelId]: modelEntry,
				},
			};
		}

			const configPath = join(opencodeDir, "config.json");
			await writeFile(configPath, JSON.stringify(configJson, null, 2), "utf8");

			const envVars: Record<string, string> = {};
			if (model.apiKeyEnv) {
				envVars.OPENAI_API_KEY = `\${${model.apiKeyEnv}}`;
			}

			return {
				configFiles: new Map([
					[".opencode/config.json", JSON.stringify(configJson, null, 2)],
				]),
				envVars,
				workingDir,
			};
		},
	};
}

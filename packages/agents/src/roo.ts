import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import { buildRooCustomModelInfo } from "./model-metadata.js";
import type {
	AgentAdapter,
	AgentDetectResult,
	AgentKind,
	AgentMaterializeResult,
	AgentSpawnOptions,
} from "./types.js";

export interface RooAdapterOptions {
	readonly binary?: string;
}

const ROO_BINARY = "roo";
const ROO_VERSION_ARGS = ["--version"];

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

export function createRooAdapter(options: RooAdapterOptions = {}): AgentAdapter {
	const binary = options.binary ?? ROO_BINARY;

	return {
		kind: "roo" as AgentKind,

		async detect(): Promise<AgentDetectResult> {
			return detectBinary(binary, ROO_VERSION_ARGS);
		},

		buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
			const timeoutSec = Math.floor((spawnOptions.timeoutMs ?? 600_000) / 1000);
			const args: string[] = [binary, "run"];

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

			const rooDir = join(workingDir, ".roo");
			await mkdir(rooDir, { recursive: true });

			const apiConfiguration: Record<string, unknown> = {};

			if (model.baseUrl) {
				apiConfiguration.openAiBaseUrl = model.baseUrl;
			}

			if (model.modelId) {
				apiConfiguration.openAiModelId = model.modelId;
			}

			if (model.extraParams?.temperature !== undefined) {
				apiConfiguration.modelTemperature = model.extraParams.temperature;
			}

		if (model.extraParams?.top_p !== undefined) {
			apiConfiguration.modelTopP = model.extraParams.top_p;
		}

		const customModelInfo = buildRooCustomModelInfo(model);
		if (customModelInfo) {
			apiConfiguration.openAiCustomModelInfo = customModelInfo;
		}

		const settingsJson = { apiConfiguration };
			const configPath = join(rooDir, "settings.json");
			await writeFile(configPath, JSON.stringify(settingsJson, null, 2), "utf8");

			const envVars: Record<string, string> = {};
			if (model.apiKeyEnv) {
				envVars.OPENAI_API_KEY = `\${${model.apiKeyEnv}}`;
			}

			return {
				configFiles: new Map([
					[".roo/settings.json", JSON.stringify(settingsJson, null, 2)],
				]),
				envVars,
				workingDir,
			};
		},
	};
}

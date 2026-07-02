import type { ModelSpec } from "@aicr/llm";

import type {
	AgentAdapter,
	AgentDetectResult,
	AgentKind,
	AgentMaterializeOptions,
	AgentMaterializeResult,
	AgentSpawnOptions,
} from "./types.js";

export interface CopilotCliAdapterOptions {
	readonly binary?: string;
}

const COPILOT_CLI_BINARY = "gh";
const COPILOT_CLI_VERSION_ARGS = ["--version"];

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

export function createCopilotCliAdapter(options: CopilotCliAdapterOptions = {}): AgentAdapter {
	const binary = options.binary ?? COPILOT_CLI_BINARY;

	return {
		kind: "copilot-cli" as AgentKind,

		async detect(): Promise<AgentDetectResult> {
			return detectBinary(binary, COPILOT_CLI_VERSION_ARGS);
		},

		buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
			const args: string[] = [binary, "copilot", "suggest", "--target", "shell"];

			if (spawnOptions.model?.modelId) {
				args.push("--model", spawnOptions.model.modelId);
			}

			args.push("--cwd", spawnOptions.workingDir);

			return args;
		},

		async materializeConfig(
			model: ModelSpec,
			workingDir: string,
			_options?: AgentMaterializeOptions,
		): Promise<AgentMaterializeResult> {
			const envVars: Record<string, string> = {};

			if (model.apiKeyEnv) {
				envVars.GH_TOKEN = `\${${model.apiKeyEnv}}`;
			}

			return {
				configFiles: new Map(),
				envVars,
				workingDir,
			};
		},
	};
}

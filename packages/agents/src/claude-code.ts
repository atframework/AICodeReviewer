import type { ModelSpec } from "@aicr/llm";

import type {
	AgentAdapter,
	AgentDetectResult,
	AgentKind,
	AgentMaterializeResult,
	AgentSpawnOptions,
} from "./types.js";

export interface ClaudeCodeAdapterOptions {
	readonly binary?: string;
}

const CLAUDE_CODE_BINARY = "claude";
const CLAUDE_CODE_VERSION_ARGS = ["--version"];

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

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): AgentAdapter {
	const binary = options.binary ?? CLAUDE_CODE_BINARY;

	return {
		kind: "claude-code" as AgentKind,

		async detect(): Promise<AgentDetectResult> {
			return detectBinary(binary, CLAUDE_CODE_VERSION_ARGS);
		},

		buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
			const timeoutSec = Math.floor((spawnOptions.timeoutMs ?? 600_000) / 1000);
			const args: string[] = [binary, "--timeout", String(timeoutSec)];

			if (spawnOptions.model?.modelId) {
				args.push("--model", spawnOptions.model.modelId);
			}

			args.push("--cwd", spawnOptions.workingDir);

			return args;
		},

		async materializeConfig(
			model: ModelSpec,
			workingDir: string,
		): Promise<AgentMaterializeResult> {
			const envVars: Record<string, string> = {};

			if (model.apiKeyEnv) {
				envVars.ANTHROPIC_API_KEY = `\${${model.apiKeyEnv}}`;
			}

			if (model.baseUrl) {
				envVars.ANTHROPIC_BASE_URL = model.baseUrl;
			}

			if (model.extraParams?.max_tokens) {
				envVars.ANTHROPIC_MAX_TOKENS = String(model.extraParams.max_tokens);
			}

			return {
				configFiles: new Map(),
				envVars,
				workingDir,
			};
		},
	};
}

import type { ModelSpec } from "@aicr/llm";

import { toClaudeCodeMcpServersJson } from "./mcp-config.js";
import type {
	AgentAdapter,
	AgentDetectResult,
	AgentKind,
	AgentMaterializeOptions,
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

		// Headless review runs use print mode (`-p`) with the review prompt piped via stdin
		// and a structured JSON result envelope on stdout. Flag surface verified against
		// code.claude.com/docs/en/cli-reference (2026-08): `--timeout`, `--cwd`, and
		// `--thinking` are not general session flags and were removed.
		buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
			const args: string[] = [
				binary,
				"-p",
				"--output-format", "json",
			];

			if (spawnOptions.model?.modelId) {
				args.push("--model", spawnOptions.model.modelId);
			}

			// Claude Code --effort accepts low/medium/high/xhigh/max; AICR's "minimal"
			// tier has no Claude equivalent and maps to "low".
			const effort = spawnOptions.model?.defaultReasoningEffort ?? spawnOptions.model?.reasoningEffort;
			if (effort) {
				args.push("--effort", effort === "minimal" ? "low" : effort);
			}

			// Headless runs inside the AICR sandbox cannot answer permission prompts; the
			// sandbox provides the isolation boundary this flag requires.
			if (spawnOptions.autoApprove) {
				args.push("--dangerously-skip-permissions");
			}

			// Wire AICR output MCP tools natively and isolate the run from user/project
			// MCP configuration so review output tooling is deterministic.
			const mcpConfigJson = spawnOptions.mcpServers && spawnOptions.mcpServers.length > 0
				? toClaudeCodeMcpServersJson(spawnOptions.mcpServers)
				: undefined;
			if (mcpConfigJson) {
				args.push("--mcp-config", mcpConfigJson, "--strict-mcp-config");
			}

			return args;
		},

		async materializeConfig(
			model: ModelSpec,
			workingDir: string,
			options?: AgentMaterializeOptions,
		): Promise<AgentMaterializeResult> {
			const envVars: Record<string, string> = {};

			if (model.apiKeyEnv) {
				envVars.ANTHROPIC_API_KEY = `\${${model.apiKeyEnv}}`;
			}

			if (model.baseUrl) {
				envVars.ANTHROPIC_BASE_URL = model.baseUrl;
			}

			// Env-var surface verified against code.claude.com/docs/en/env-vars (2026-08).
			// model.anthropicVersion is intentionally not translated: Claude Code sets the
			// anthropic-version header itself and no env override exists.

			if (model.anthropicBeta && model.anthropicBeta.length > 0) {
				envVars.ANTHROPIC_BETAS = model.anthropicBeta.join(",");
			}

			if (model.extraParams?.max_tokens !== undefined) {
				envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(model.extraParams.max_tokens);
			} else if (model.maxOutputTokens !== undefined) {
				envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(model.maxOutputTokens);
			}

			const thinkingBudget = model.thinking?.enabled === false
				? undefined
				: model.thinking?.budgetTokens ?? model.thinkingBudgetTokens;
			if (thinkingBudget !== undefined) {
				envVars.MAX_THINKING_TOKENS = String(thinkingBudget);
				// A fixed budget is ignored on adaptive-reasoning models (Opus 4.6/Sonnet 4.6)
				// unless adaptive thinking is disabled, so pin it off for explicit budgets.
				envVars.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1";
			}

			if (model.contextWindow !== undefined) {
				// Correct the assumed context window for gateway/custom model IDs that
				// Claude Code does not recognize natively.
				envVars.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(model.contextWindow);
			}

			if (options?.compaction && !options.compaction.auto) {
				envVars.DISABLE_AUTO_COMPACT = "1";
			}

			// Sandboxed one-shot review runs: disable self-update, telemetry, and the
			// background title-generation request print mode would otherwise fire.
			envVars.DISABLE_AUTOUPDATER = "1";
			envVars.DISABLE_TELEMETRY = "1";
			envVars.DISABLE_ERROR_REPORTING = "1";
			envVars.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";

			return {
				configFiles: new Map(),
				envVars,
				workingDir,
			};
		},
	};
}

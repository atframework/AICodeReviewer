import type { ModelSpec } from "@aicr/llm";

import { toCopilotCliMcpServersJson } from "./mcp-config.js";
import type {
	AgentAdapter,
	AgentDetectResult,
	AgentKind,
	AgentMaterializeOptions,
	AgentMaterializeResult,
	AgentSpawnOptions,
} from "./types.js";
import { warnUnsupportedWebSearchFields } from "./web-search.js";

export interface CopilotCliAdapterOptions {
	readonly binary?: string;
}

const COPILOT_CLI_BINARY = "copilot";
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

		// The task is the --prompt argv string.
		taskTransport: "argv",

		async detect(): Promise<AgentDetectResult> {
			return detectBinary(binary, COPILOT_CLI_VERSION_ARGS);
		},

		// Programmatic mode (`-p/--prompt`) runs one prompt to completion and prints the
		// agent response on stdout. Flag surface verified against the GitHub Copilot CLI
		// command reference (docs.github.com, 2026-08); the legacy `gh copilot suggest`
		// extension this adapter previously shelled out to is deprecated.
		buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
			const args: string[] = [
				binary,
				"--prompt", task,
				// Response-only stdout so the orchestrator can treat stdout as the final
				// answer without scraping usage statistics or banners.
				"--silent",
				// Autonomous run: the review agent must not stop to ask the user questions.
				"--no-ask-user",
				"--no-color",
				"--no-auto-update",
			];

			if (spawnOptions.model?.modelId) {
				args.push(`--model=${spawnOptions.model.modelId}`);
			}

			// Copilot CLI --effort accepts low/medium/high/xhigh/max; AICR's "minimal"
			// tier has no Copilot equivalent and maps to "low".
			const effort = spawnOptions.model?.defaultReasoningEffort ?? spawnOptions.model?.reasoningEffort;
			if (effort) {
				args.push(`--effort=${effort === "minimal" ? "low" : effort}`);
			}

			if (spawnOptions.autoApprove) {
				// `--allow-all-tools` is documented as required for programmatic use.
				// URLs stay confirmation-gated: the review agent's context tools are
				// served by the local MCP server, not the network.
				args.push("--allow-all-tools", "--allow-all-paths");
			}

			// URL permissions (`--deny-url`) gate only shell and web-fetch traffic —
			// `web_search` is not covered; the documented way to remove the built-in
			// web tools from the model's toolset is `--excluded-tools` (Copilot CLI
			// docs "Allowing tools", verified against v1.0.80 `copilot help permissions`).
			if (spawnOptions.webSearch?.enabled === false) {
				args.push("--excluded-tools=web_search,web_fetch");
			}

			const mcpConfigJson = spawnOptions.mcpServers && spawnOptions.mcpServers.length > 0
				? toCopilotCliMcpServersJson(spawnOptions.mcpServers)
				: undefined;
			if (mcpConfigJson) {
				args.push(`--additional-mcp-config=${mcpConfigJson}`);
			}

			return args;
		},

		// The prompt travels as the --prompt argument; nothing is piped.
		buildStdin(): string {
			return "";
		},

		async materializeConfig(
			model: ModelSpec,
			workingDir: string,
			options?: AgentMaterializeOptions,
		): Promise<AgentMaterializeResult> {
			const envVars: Record<string, string> = {};

			// Copilot CLI web tools run on the Copilot subscription backend: only the
			// enable switch (buildCommand `--excluded-tools`) is mappable.
			warnUnsupportedWebSearchFields("copilot-cli", options?.webSearch, {
				providers: false,
				exclude: false,
				timeout: false,
				credentials: [],
				searxng: false,
			});

			if (model.apiKeyEnv) {
				// Highest-precedence Copilot CLI auth env for headless use
				// (COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN per the CLI reference).
				envVars.COPILOT_GITHUB_TOKEN = `\${${model.apiKeyEnv}}`;
			}

			return {
				configFiles: new Map(),
				envVars,
				workingDir,
			};
		},
	};
}

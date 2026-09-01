import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import {
  buildPiFamilyEnvVars,
  buildPiFamilyProviderConfig,
  formatPiFamilyModel,
  resolvePiFamilyThinking,
} from "./pi-family.js";
import type {
  AgentAdapter,
  AgentDetectResult,
  AgentKind,
  AgentMaterializeOptions,
  AgentMaterializeResult,
  AgentSpawnOptions,
} from "./types.js";

export interface PiAdapterOptions {
  readonly binary?: string;
}

const PI_BINARY = "pi";
const PI_VERSION_ARGS = ["--version"];

/** Bundle-relative config dir; PI_CODING_AGENT_DIR points here inside the sandbox. */
export const PI_AGENT_DIR_NAME = ".pi-agent";
/** Env var the generated MCP bridge extension reads for its server list. */
export const PI_MCP_SERVERS_ENV = "AICR_PI_MCP_SERVERS";
export const PI_MCP_BRIDGE_EXTENSION_PATH = `${PI_AGENT_DIR_NAME}/extensions/aicr-output.ts`;

async function detectBinary(binary: string, versionArgs: readonly string[]): Promise<AgentDetectResult> {
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

function buildPiModelsJson(model: ModelSpec): string {
  const provider = buildPiFamilyProviderConfig(model, "pi");
  const entry: Record<string, unknown> = {
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey ? `$${provider.apiKey}` : "aicr-local-no-auth",
    ...(provider.headers ? { headers: provider.headers } : {}),
    models: [provider.modelEntry],
  };
  return JSON.stringify({ providers: { [model.providerId]: entry } }, null, 2);
}

function buildPiSettingsJson(options?: AgentMaterializeOptions): string {
  const settings: Record<string, unknown> = {};
  if (options?.compaction) {
    // pi settings.json compaction has no threshold_percent/prune fields; only the
    // on/off state is injected, the rest stays delegated to pi defaults.
    settings.compaction = { enabled: options.compaction.auto };
  }
  return JSON.stringify(settings, null, 2);
}

export function createPiAdapter(options: PiAdapterOptions = {}): AgentAdapter {
  const binary = options.binary ?? PI_BINARY;

  return {
    kind: "pi" as AgentKind,

    // The task is one positional argv string (`-- <task>`).
    taskTransport: "argv",

    async detect(): Promise<AgentDetectResult> {
      return detectBinary(binary, PI_VERSION_ARGS);
    },

    buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
      const args: string[] = [binary, "--mode", "json"];
      // Trust the per-run bundle dir so project `.agents/skills` load; it is fully
      // materialized by AICR and ephemeral.
      args.push("--approve", "--no-session");
      if (spawnOptions.model) {
        args.push("--model", formatPiFamilyModel(spawnOptions.model));
        const thinking = resolvePiFamilyThinking(spawnOptions.model);
        if (thinking) {
          args.push("--thinking", thinking);
        }
      }
      args.push("--", task);
      return args;
    },

    buildStdin(): string {
      // The task is passed as a positional argument (the documented `--mode json`
      // form); keep stdin empty so a stdin-reading CLI never double-feeds the prompt.
      return "";
    },

    async materializeConfig(
      model: ModelSpec,
      workingDir: string,
      materializeOptions?: AgentMaterializeOptions,
    ): Promise<AgentMaterializeResult> {
      const agentDir = join(workingDir, PI_AGENT_DIR_NAME);
      await mkdir(agentDir, { recursive: true });

      const modelsJson = buildPiModelsJson(model);
      const settingsJson = buildPiSettingsJson(materializeOptions);
      await writeFile(join(agentDir, "models.json"), modelsJson, "utf8");
      await writeFile(join(agentDir, "settings.json"), settingsJson, "utf8");

      const envVars: Record<string, string> = {
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        ...buildPiFamilyEnvVars(model),
      };

      return {
        configFiles: new Map([
          [`${PI_AGENT_DIR_NAME}/models.json`, modelsJson],
          [`${PI_AGENT_DIR_NAME}/settings.json`, settingsJson],
        ]),
        envVars,
        workingDir,
      };
    },
  };
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import type {
  AgentAdapter,
  AgentDetectResult,
  AgentKind,
  AgentMaterializeResult,
  AgentSpawnOptions,
} from "./types.js";

export interface KiloAdapterOptions {
  readonly binary?: string;
}

const KILO_BINARY = "kilo";
const KILO_VERSION_ARGS = ["--version"];

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

function buildKiloProviderConfig(model: ModelSpec): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    id: model.providerId,
    type: model.providerKind,
  };

  if (model.baseUrl) {
    provider.baseUrl = model.baseUrl;
  }

  if (model.organization) {
    provider.organization = model.organization;
  }

  if (model.extraParams) {
    Object.assign(provider, model.extraParams);
  }

  if (model.extraHeaders) {
    provider.extraHeaders = model.extraHeaders;
  }

  if (model.extraBody) {
    provider.extraBody = model.extraBody;
  }

  if (model.apiVersion) {
    provider.apiVersion = model.apiVersion;
  }

  if (model.thinkingLevel) {
    provider.thinkingLevel = model.thinkingLevel;
  }

  if (model.thinkingBudgetTokens !== undefined) {
    provider.thinkingBudgetTokens = model.thinkingBudgetTokens;
  }

  if (model.reasoningEffort) {
    provider.reasoningEffort = model.reasoningEffort;
  }

  if (model.thinking) {
    provider.thinking = model.thinking;
  }

  if (model.responseFormat) {
    provider.responseFormat = model.responseFormat;
  }

  if (model.toolChoice) {
    provider.toolChoice = model.toolChoice;
  }

  if (model.parallelToolCalls !== undefined) {
    provider.parallelToolCalls = model.parallelToolCalls;
  }

  return provider;
}

function sanitizeEnvSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
}

export function createKiloAdapter(options: KiloAdapterOptions = {}): AgentAdapter {
  const binary = options.binary ?? KILO_BINARY;

  return {
    kind: "kilo" as AgentKind,

    async detect(): Promise<AgentDetectResult> {
      return detectBinary(binary, KILO_VERSION_ARGS);
    },

    buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
      const timeoutSec = Math.floor((spawnOptions.timeoutMs ?? 600_000) / 1000);
      const args: string[] = [
        binary,
        "run",
        "--auto",
      ];

      if (spawnOptions.model) {
        args.push("--provider", spawnOptions.model.providerId);
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

      const kiloDir = join(workingDir, ".kilo");
      await mkdir(kiloDir, { recursive: true });

      const providerConfig = buildKiloProviderConfig(model);
      const providersJson = {
        providers: [providerConfig],
      };

      const configPath = join(kiloDir, "providers.json");
      await writeFile(configPath, JSON.stringify(providersJson, null, 2), "utf8");

      const envVars: Record<string, string> = {};
      if (model.apiKeyEnv) {
        envVars.KILO_API_KEY = `\${${model.apiKeyEnv}}`;
        envVars[`KILO_API_KEY_${sanitizeEnvSuffix(model.providerId)}`] = `\${${model.apiKeyEnv}}`;
      }

      return {
        configFiles: new Map([
          [".kilo/providers.json", JSON.stringify(providersJson, null, 2)],
        ]),
        envVars,
        workingDir,
      };
    },
  };
}

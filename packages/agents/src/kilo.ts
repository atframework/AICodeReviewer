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

function buildKiloProviderOptions(model: ModelSpec): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  if (model.baseUrl) {
    options.baseURL = model.baseUrl;
  }

  if (model.apiKeyEnv) {
    const apiKey = process.env[model.apiKeyEnv];
    if (apiKey) {
      options.apiKey = apiKey;
    }
  }

  if (model.organization) {
    options.organization = model.organization;
  }

  if (model.timeoutMs !== undefined) {
    options.timeout = model.timeoutMs;
  }

  if (model.extraHeaders) {
    options.extraHeaders = model.extraHeaders;
  }

  if (model.extraBody) {
    options.extraBody = model.extraBody;
  }

  if (model.apiVersion) {
    options.apiVersion = model.apiVersion;
  }

  return options;
}

function buildKiloJsonConfig(model: ModelSpec): Record<string, unknown> {
  const options = buildKiloProviderOptions(model);
  const models: Record<string, unknown> = {
    [model.modelId]: {},
  };

  const providerEntry: Record<string, unknown> = {
    options,
    models,
  };

  const config: Record<string, unknown> = {
    provider: {
      [model.providerId]: providerEntry,
    },
  };

  return config;
}

function sanitizeEnvSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
}

function formatKiloModel(model: ModelSpec): string {
  return model.modelId.includes("/")
    ? model.modelId
    : `${model.providerId}/${model.modelId}`;
}

export function createKiloAdapter(options: KiloAdapterOptions = {}): AgentAdapter {
  const binary = options.binary ?? KILO_BINARY;

  return {
    kind: "kilo" as AgentKind,

    async detect(): Promise<AgentDetectResult> {
      return detectBinary(binary, KILO_VERSION_ARGS);
    },

    buildCommand(task: string, spawnOptions: AgentSpawnOptions): readonly string[] {
      const args: string[] = [
        binary,
        "run",
        "--auto",
        "--dangerously-skip-permissions",
        "--format", "json",
      ];

      if (spawnOptions.model) {
        args.push("--model", formatKiloModel(spawnOptions.model));
      }

      args.push("--dir", spawnOptions.workingDir);
      args.push(task);

      return args;
    },

    async materializeConfig(
      model: ModelSpec,
      workingDir: string,
    ): Promise<AgentMaterializeResult> {
      await mkdir(workingDir, { recursive: true });

      const kiloDir = join(workingDir, ".kilo");
      await mkdir(kiloDir, { recursive: true });

      const kiloJsonConfig = buildKiloJsonConfig(model);
      const kiloJsonContent = JSON.stringify(kiloJsonConfig, null, 2);

      const configPath = join(kiloDir, "kilo.json");
      await writeFile(configPath, kiloJsonContent, "utf8");

      const envVars: Record<string, string> = {};
      if (model.apiKeyEnv) {
        envVars.KILO_API_KEY = `\${${model.apiKeyEnv}}`;
        envVars[`KILO_API_KEY_${sanitizeEnvSuffix(model.providerId)}`] = `\${${model.apiKeyEnv}}`;
      }

      return {
        configFiles: new Map([
          [".kilo/kilo.json", kiloJsonContent],
        ]),
        envVars,
        workingDir,
      };
    },
  };
}

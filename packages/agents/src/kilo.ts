import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import { buildKiloModelInfo } from "./model-metadata.js";
import type {
  AgentAdapter,
  AgentDetectResult,
  AgentKind,
  AgentMaterializeOptions,
  AgentMaterializeResult,
  AgentSpawnOptions,
} from "./types.js";
import { buildWebSearchCredentialEnvVars, warnUnsupportedWebSearchFields } from "./web-search.js";

export interface KiloAdapterOptions {
  readonly binary?: string;
}

const KILO_BINARY = "kilo";
const KILO_VERSION_ARGS = ["--version"];

/**
 * kilo's built-in `websearch` tool calls the Exa hosted MCP
 * (`https://mcp.exa.ai/mcp`; `EXA_API_KEY` switches it to keyed usage, otherwise
 * anonymous). Verified against Kilo-Org/kilocode v7.2.40 `tool/websearch.ts`,
 * `tool/mcp-exa.ts`, and `config/permission.ts` (`permission.websearch` is a
 * known allow/deny/ask key). With AICR's custom providers the tool is only
 * offered to the model when the `KILO_ENABLE_EXA` runtime flag is set
 * (`tool/registry.ts`: `providerID === kilo || Flag.KILO_ENABLE_EXA`), so enabled
 * runs must materialize that activation env alongside the permission rule.
 */
const KILO_WEB_SEARCH_CREDENTIAL_ENV_NAMES: Readonly<Record<string, string>> = {
  exa: "EXA_API_KEY",
};

const KILO_WEB_SEARCH_FIELD_SUPPORT = {
  providers: true,
  providerIds: ["exa"],
  exclude: false,
  timeout: false,
  credentials: Object.keys(KILO_WEB_SEARCH_CREDENTIAL_ENV_NAMES),
  searxng: false,
};

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

  // `{env:NAME}` is substituted by kilo's config loader (`config/variable.ts`)
  // from the spawned process env, so the secret never persists in the per-run
  // bundle (same convention as the opencode adapter).
  if (model.apiKeyEnv) {
    options.apiKey = `{env:${model.apiKeyEnv}}`;
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

function buildKiloModelVariants(model: ModelSpec): Record<string, unknown> | undefined {
  const efforts: string[] = [];
  const push = (effort: string | undefined): void => {
    if (effort && !efforts.includes(effort)) {
      efforts.push(effort);
    }
  };
  for (const effort of model.supportedReasoningEfforts ?? []) {
    push(effort);
  }
  push(model.defaultReasoningEffort);
  push(model.reasoningEffort);

  if (efforts.length === 0) {
    return undefined;
  }

  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]));
}

function resolveKiloVariant(model: ModelSpec): string | undefined {
  return model.defaultReasoningEffort ?? model.reasoningEffort;
}

function buildKiloCompaction(options: AgentMaterializeOptions): Record<string, unknown> | undefined {
  const compaction = options.compaction;
  if (!compaction) return undefined;
  if (!compaction.auto) {
    return { auto: false };
  }
  const section: Record<string, unknown> = { auto: true };
  if (compaction.thresholdPercent !== undefined) {
    section.threshold_percent = compaction.thresholdPercent;
  }
  if (compaction.prune !== undefined) {
    section.prune = compaction.prune;
  }
  return section;
}

function buildKiloJsonConfig(
  model: ModelSpec,
  mcpServers?: Readonly<Record<string, unknown>>,
  options?: AgentMaterializeOptions,
): Record<string, unknown> {
  const providerOptions = buildKiloProviderOptions(model);
  const modelInfo = buildKiloModelInfo(model);
  const modelVariants = buildKiloModelVariants(model);
  const models: Record<string, unknown> = {
    [model.modelId]: {
      ...(modelInfo ?? {}),
      ...(modelVariants ? { variants: modelVariants } : {}),
    },
  };

  const providerEntry: Record<string, unknown> = {
    options: providerOptions,
    models,
  };

  const config: Record<string, unknown> = {
    provider: {
      [model.providerId]: providerEntry,
    },
  };

  const compactionSection = buildKiloCompaction(options ?? {});
  if (compactionSection) {
    config.compaction = compactionSection;
  }

  // `--auto` auto-approves every permission prompt, so kilo's Exa-backed
  // websearch tool is otherwise reachable by default; an explicit config rule is
  // the only reliable switch (deny always wins over auto-approve).
  if (options?.webSearch) {
    config.permission = {
      ...((config.permission as Readonly<Record<string, unknown>> | undefined) ?? {}),
      websearch: options.webSearch.enabled ? "allow" : "deny",
    };
  }

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    config.mcp = { ...mcpServers };
  }

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
        "--format", "json",
      ];

      if (spawnOptions.model) {
        args.push("--model", formatKiloModel(spawnOptions.model));
        const variant = resolveKiloVariant(spawnOptions.model);
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

      const kiloDir = join(workingDir, ".kilo");
      await mkdir(kiloDir, { recursive: true });

      warnUnsupportedWebSearchFields("kilo", options?.webSearch, KILO_WEB_SEARCH_FIELD_SUPPORT);

      const kiloJsonConfig = buildKiloJsonConfig(model, undefined, options);
      const kiloJsonContent = JSON.stringify(kiloJsonConfig, null, 2);

      const configPath = join(kiloDir, "kilo.json");
      await writeFile(configPath, kiloJsonContent, "utf8");

      const envVars: Record<string, string> = {};
      if (model.apiKeyEnv) {
        envVars.KILO_API_KEY = `\${${model.apiKeyEnv}}`;
        envVars[`KILO_API_KEY_${sanitizeEnvSuffix(model.providerId)}`] = `\${${model.apiKeyEnv}}`;
      }
      // Custom-provider sessions only offer the websearch tool to the model when
      // this flag is set; keep it absent for disabled/hermetic runs.
      if (options?.webSearch?.enabled) {
        envVars.KILO_ENABLE_EXA = "1";
      }
      Object.assign(envVars, buildWebSearchCredentialEnvVars(
        options?.webSearch,
        KILO_WEB_SEARCH_CREDENTIAL_ENV_NAMES,
      ));

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

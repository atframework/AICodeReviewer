import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import { buildZooCustomModelInfo } from "./model-metadata.js";
import type {
  AgentAdapter,
  AgentDetectResult,
  AgentKind,
  AgentMaterializeOptions,
  AgentMaterializeResult,
  AgentSpawnOptions,
} from "./types.js";

export interface ZooAdapterOptions {
  readonly binary?: string;
}

// Zoo Code's current upstream CLI still exposes the `roo` binary and `.roo` config paths.
const ZOO_BINARY = "roo";
const ZOO_VERSION_ARGS = ["--version"];

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
    return {
      available: true,
      binary,
      ...(trimmed ? { version: trimmed } : {}),
    };
  } catch {
    return { available: false, binary };
  }
}

function buildZooStdinCommand(task: string): string {
  return `${JSON.stringify({ command: "start", requestId: "aicr-review", prompt: task })}\n`;
}

export function createZooAdapter(
  options: ZooAdapterOptions = {},
): AgentAdapter {
  const binary = options.binary ?? ZOO_BINARY;

  return {
    kind: "zoo" as AgentKind,

    async detect(): Promise<AgentDetectResult> {
      return detectBinary(binary, ZOO_VERSION_ARGS);
    },

    buildCommand(
      _task: string,
      spawnOptions: AgentSpawnOptions,
    ): readonly string[] {
      const args: string[] = [
        binary,
        "--print",
        "--output-format",
        "stream-json",
        "--stdin-prompt-stream",
        "--workspace",
        spawnOptions.workingDir,
        "--exit-on-error",
        "--ephemeral",
        "--oneshot",
      ];

      if (spawnOptions.model?.modelId) {
        args.push("--model", spawnOptions.model.modelId);
      }

      return args;
    },

    buildStdin(task: string): string {
      return buildZooStdinCommand(task);
    },

    async materializeConfig(
      model: ModelSpec,
      workingDir: string,
      options?: AgentMaterializeOptions,
    ): Promise<AgentMaterializeResult> {
      await mkdir(workingDir, { recursive: true });

      const zooCompatibilityDir = join(workingDir, ".roo");
      await mkdir(zooCompatibilityDir, { recursive: true });

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

      const customModelInfo = buildZooCustomModelInfo(model);
      if (customModelInfo) {
        apiConfiguration.openAiCustomModelInfo = customModelInfo;
      }

      const settingsJson: Record<string, unknown> = { apiConfiguration };

      const compaction = options?.compaction;
      if (compaction) {
        settingsJson.autoCondenseContext = compaction.auto;
        if (compaction.thresholdPercent !== undefined) {
          settingsJson.condenseContextPercentThreshold =
            compaction.thresholdPercent;
        }
      }

      const settingsJsonContent = JSON.stringify(settingsJson, null, 2);
      const configPath = join(zooCompatibilityDir, "settings.json");
      await writeFile(configPath, settingsJsonContent, "utf8");

      const envVars: Record<string, string> = {};
      if (model.apiKeyEnv) {
        envVars.OPENAI_API_KEY = `\${${model.apiKeyEnv}}`;
      }

      return {
        configFiles: new Map([[".roo/settings.json", settingsJsonContent]]),
        envVars,
        workingDir,
      };
    },
  };
}

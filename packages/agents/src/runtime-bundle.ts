import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import {
	buildKiloModelInfo,
	buildOpencodeModelEntry,
	buildRooCustomModelInfo,
	isOpenCodeCustomProvider,
} from "./model-metadata.js";
import type { AgentAdapter, AgentKind } from "./types.js";

export interface RuntimeBundleInstruction {
  readonly kind: string;
  readonly label: string;
  readonly content: string;
  readonly path?: string;
}

export interface RuntimeBundleSkill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly path?: string;
}

export interface RuntimeBundleMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface RuntimeBundleMcpServer {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RuntimeBundleInput {
  readonly adapter: AgentAdapter;
  readonly model: ModelSpec;
  readonly workingDir: string;
  readonly instructions?: readonly RuntimeBundleInstruction[];
  readonly skills?: readonly RuntimeBundleSkill[];
  readonly mcpTools?: readonly RuntimeBundleMcpTool[];
  readonly mcpServers?: readonly RuntimeBundleMcpServer[];
  readonly extraEnvVars?: Readonly<Record<string, string>>;
  readonly runId?: string;
}

export interface RuntimeBundleManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly agentKind: AgentKind;
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
    readonly catalogSource?: string;
    readonly metadataInjection?: "injected" | "delegated" | "not_applicable";
  };
  readonly runId?: string;
  readonly instructions: readonly {
    readonly kind: string;
    readonly label: string;
    readonly path: string;
  }[];
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
  }[];
  readonly mcpTools: readonly string[];
  readonly envKeys: readonly string[];
}

export interface RuntimeBundleResult {
  readonly manifest: RuntimeBundleManifest;
  readonly configFiles: ReadonlyMap<string, string>;
  readonly envVars: Readonly<Record<string, string>>;
  readonly workingDir: string;
  readonly manifestPath: string;
}

const INSTRUCTIONS_DIR = "instructions";
const SKILLS_DIR = "skills";
const MANIFEST_FILE = "manifest.json";

function sanitizeFilename(label: string): string {
  return label
    .replace(/[/\\]/gu, "_")
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_|_$/gu, "")
    .slice(0, 120);
}

function instructionFilePath(instruction: RuntimeBundleInstruction, index: number): string {
  if (instruction.path) {
    return posix.join(INSTRUCTIONS_DIR, sanitizeFilename(instruction.path));
  }

  return posix.join(INSTRUCTIONS_DIR, `${instruction.kind}_${index}.md`);
}

function skillFilePath(skill: RuntimeBundleSkill): string {
  if (skill.path) {
    return posix.join(SKILLS_DIR, sanitizeFilename(skill.path));
  }

  return posix.join(SKILLS_DIR, `${sanitizeFilename(skill.name)}.md`);
}

function computeMetadataInjection(kind: AgentKind, model: ModelSpec): "injected" | "delegated" | "not_applicable" {
  switch (kind) {
    case "kilo":
      return buildKiloModelInfo(model) ? "injected" : "delegated";
    case "roo":
      return buildRooCustomModelInfo(model) ? "injected" : "delegated";
    case "opencode":
      return isOpenCodeCustomProvider(model) && buildOpencodeModelEntry(model) ? "injected" : "delegated";
    case "claude-code":
      return "delegated";
    case "copilot-cli":
      return "not_applicable";
    default:
      return "delegated";
  }
}

export async function materializeRuntimeBundle(
  input: RuntimeBundleInput,
): Promise<RuntimeBundleResult> {
  const { adapter, model, workingDir } = input;

  const materialized = await adapter.materializeConfig(model, workingDir);

  const allConfigFiles = new Map(materialized.configFiles);
  const allEnvVars: Record<string, string> = { ...materialized.envVars };

  if (input.extraEnvVars) {
    Object.assign(allEnvVars, input.extraEnvVars);
  }

  const instructionsDir = join(workingDir, INSTRUCTIONS_DIR);
  await mkdir(instructionsDir, { recursive: true });

  const manifestInstructions: Array<{ kind: string; label: string; path: string }> = [];
  for (let i = 0; i < (input.instructions?.length ?? 0); i += 1) {
    const instruction = input.instructions![i]!;
    const relPath = instructionFilePath(instruction, i);
    const absPath = join(workingDir, relPath);

    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, instruction.content, "utf8");

    allConfigFiles.set(relPath, instruction.content);
    manifestInstructions.push({
      kind: instruction.kind,
      label: instruction.label,
      path: relPath,
    });
  }

  const skillsDir = join(workingDir, SKILLS_DIR);
  await mkdir(skillsDir, { recursive: true });

  const manifestSkills: Array<{ name: string; description: string; path: string }> = [];
  for (const skill of input.skills ?? []) {
    const relPath = skillFilePath(skill);
    const absPath = join(workingDir, relPath);

    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, skill.content, "utf8");

    allConfigFiles.set(relPath, skill.content);
    manifestSkills.push({
      name: skill.name,
      description: skill.description,
      path: relPath,
    });
  }

  const mcpToolNames = (input.mcpTools ?? []).map((tool) => tool.name);

  if (input.mcpServers?.length && adapter.kind === "kilo") {
    const kiloConfigKey = ".kilo/kilo.json";
    const existingConfig = allConfigFiles.get(kiloConfigKey);
    if (existingConfig) {
      const parsed = JSON.parse(existingConfig) as Record<string, unknown>;
      const mcpSection: Record<string, unknown> = {};
      for (const server of input.mcpServers) {
        mcpSection[server.name] = server.config;
      }
      parsed.mcp = mcpSection;
      const updatedConfig = JSON.stringify(parsed, null, 2);
      allConfigFiles.set(kiloConfigKey, updatedConfig);
      await writeFile(join(workingDir, ".kilo", "kilo.json"), updatedConfig, "utf8");
    }
  }

  const manifest: RuntimeBundleManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    agentKind: adapter.kind,
    model: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.catalogSource ? { catalogSource: model.catalogSource } : {}),
      metadataInjection: computeMetadataInjection(adapter.kind, model),
    },
    ...(input.runId ? { runId: input.runId } : {}),
    instructions: manifestInstructions,
    skills: manifestSkills,
    mcpTools: mcpToolNames,
    envKeys: Object.keys(allEnvVars),
  };

  const manifestRelPath = MANIFEST_FILE;
  const manifestAbsPath = join(workingDir, manifestRelPath);
  const manifestJson = JSON.stringify(manifest, null, 2);
  await writeFile(manifestAbsPath, manifestJson, "utf8");
  allConfigFiles.set(manifestRelPath, manifestJson);

  return {
    manifest,
    configFiles: allConfigFiles,
    envVars: allEnvVars,
    workingDir,
    manifestPath: manifestAbsPath,
  };
}

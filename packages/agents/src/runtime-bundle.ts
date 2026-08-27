import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import type { ModelSpec } from "@aicr/llm";

import {
	buildKiloModelInfo,
	buildOpencodeModelEntry,
	buildZooCustomModelInfo,
	isOpenCodeCustomProvider,
} from "./model-metadata.js";
import { toOhMyPiMcpServersJson } from "./mcp-config.js";
import { OMP_MCP_CONFIG_PATH } from "./oh-my-pi.js";
import { PI_MCP_BRIDGE_EXTENSION_PATH, PI_MCP_SERVERS_ENV } from "./pi.js";
import { renderPiMcpBridgeExtension } from "./pi-mcp-bridge.js";
import type { AgentAdapter, AgentCompactionOptions, AgentKind, AgentSpawnMcpServer, AgentWebSearchOptions } from "./types.js";

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
  readonly compaction?: AgentCompactionOptions;
  readonly webSearch?: AgentWebSearchOptions;
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
  readonly contextCompaction?: {
    readonly enabled: boolean;
    readonly mode: "injected" | "delegated" | "not_applicable";
  };
  /**
   * Web search control audit. omp/kilo/opencode materialize config-level control
   * (`injected`); claude-code/copilot-cli only map the enable switch onto a CLI
   * flag while the search engine stays owned by the CLI's own backend
   * (`delegated`); zoo/pi have no built-in search tool (`not_applicable`).
   */
  readonly webSearch?: {
    readonly enabled: boolean;
    readonly mode: "injected" | "delegated" | "not_applicable";
  };
  /**
   * Where bundle content was wired into adapter-native discovery surfaces. Makes
   * degradation auditable: adapters without a native MCP/instructions/skills surface
   * show up here as "none" instead of silently relying on prompt-only injection.
   */
  readonly nativeSurfaces?: {
    readonly instructions: readonly string[];
    readonly skills: readonly string[];
    readonly mcp: "config_file" | "cli_flag" | "extension" | "none";
  };
}

export interface RuntimeBundleResult {
  readonly manifest: RuntimeBundleManifest;
  readonly configFiles: ReadonlyMap<string, string>;
  readonly envVars: Readonly<Record<string, string>>;
  readonly workingDir: string;
  readonly manifestPath: string;
}

const INSTRUCTIONS_DIR = "instructions";
const AGENTS_MD_FILE = "AGENTS.md";
const CLAUDE_MD_FILE = "CLAUDE.md";
const AGENTS_SKILLS_DIR = ".agents/skills";
const CLAUDE_SKILLS_DIR = ".claude/skills";
const MANIFEST_FILE = "manifest.json";

function sanitizeFilename(label: string): string {
  return label
    .replace(/[/\\]/gu, "_")
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_|_$/gu, "")
    .slice(0, 120);
}

/**
 * Agent Skills discovery requires the directory name to be a lowercase,
 * hyphen-separated slug matching the frontmatter `name` (agentskills.io naming
 * rules, also enforced by opencode and Copilot CLI). Skill names coming from
 * `.agents/skills/<name>/` already conform; this normalizes defensively.
 */
function sanitizeSkillDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return slug.length > 0 ? slug : "skill";
}

function instructionFilePath(instruction: RuntimeBundleInstruction, index: number): string {
  if (instruction.path) {
    return posix.join(INSTRUCTIONS_DIR, `${index}_${sanitizeFilename(instruction.path)}`);
  }

  return posix.join(INSTRUCTIONS_DIR, `${instruction.kind}_${index}.md`);
}

/**
 * Renders the combined repository/agent instructions as a single AGENTS.md at the
 * agent working-directory root. AGENTS.md is the one instruction surface discovered
 * natively by every supported CLI (Kilo, OpenCode, Copilot CLI, Zoo Code); Claude
 * Code picks the same content up through the generated CLAUDE.md `@AGENTS.md` import.
 */
function renderAgentsMd(instructions: readonly RuntimeBundleInstruction[]): string {
  const sections = instructions.map((instruction) => {
    const sourceNote = instruction.path ? ` (source: \`${instruction.path}\`)` : "";
    return `## ${instruction.label}${sourceNote}\n\n${instruction.content.trim()}`;
  });
  return [
    "<!-- Generated by AICR materializeRuntimeBundle; do not edit. -->",
    "",
    ...sections,
    "",
  ].join("\n");
}

function computeMetadataInjection(kind: AgentKind, model: ModelSpec): "injected" | "delegated" | "not_applicable" {
  switch (kind) {
    case "kilo":
      return buildKiloModelInfo(model) ? "injected" : "delegated";
    case "zoo":
      return buildZooCustomModelInfo(model) ? "injected" : "delegated";
    case "opencode":
      return isOpenCodeCustomProvider(model) && buildOpencodeModelEntry(model) ? "injected" : "delegated";
    case "claude-code":
      return "delegated";
    case "copilot-cli":
      return "not_applicable";
    case "pi":
    case "oh-my-pi":
      // Both CLIs get an explicit custom-provider entry (contextWindow/maxTokens are
      // mandatory there), so metadata is always injected or materializeConfig throws.
      return "injected";
    default:
      return "delegated";
  }
}

function computeContextCompactionManifest(
  kind: AgentKind,
  compaction: AgentCompactionOptions | undefined,
): { readonly enabled: boolean; readonly mode: "injected" | "delegated" | "not_applicable" } {
  switch (kind) {
    case "kilo":
    case "zoo":
    case "opencode":
    case "oh-my-pi":
      return { enabled: !!compaction?.auto, mode: "injected" };
    case "pi":
      // pi only accepts the enable/disable switch from AICR; threshold and
      // compaction timing remain owned by the CLI.
      return { enabled: !!compaction?.auto, mode: "delegated" };
    case "claude-code":
      return { enabled: compaction?.auto !== false, mode: "delegated" };
    case "copilot-cli":
      return { enabled: false, mode: "not_applicable" };
    default:
      return { enabled: false, mode: "delegated" };
  }
}

function computeWebSearchManifest(
  kind: AgentKind,
  webSearch: AgentWebSearchOptions | undefined,
): { readonly enabled: boolean; readonly mode: "injected" | "delegated" | "not_applicable" } {
  switch (kind) {
    case "oh-my-pi":
    case "kilo":
    case "opencode":
      return { enabled: !!webSearch?.enabled, mode: "injected" };
    case "claude-code":
    case "copilot-cli":
      // Switch-only control via CLI flags; the search engine itself is owned by
      // the CLI's own backend (Anthropic / Copilot subscription).
      return { enabled: !!webSearch?.enabled, mode: "delegated" };
    default:
      return { enabled: false, mode: "not_applicable" };
  }
}

export async function materializeRuntimeBundle(
  input: RuntimeBundleInput,
): Promise<RuntimeBundleResult> {
  const { adapter, model, workingDir } = input;

  const materialized = await adapter.materializeConfig(model, workingDir, {
    ...(input.compaction ? { compaction: input.compaction } : {}),
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
  });

  const allConfigFiles = new Map(materialized.configFiles);
  const allEnvVars: Record<string, string> = { ...materialized.envVars };

  if (input.extraEnvVars) {
    Object.assign(allEnvVars, input.extraEnvVars);
  }

  const instructionsDir = join(workingDir, INSTRUCTIONS_DIR);
  await mkdir(instructionsDir, { recursive: true });

  const instructions = input.instructions ?? [];
  const manifestInstructions: Array<{ kind: string; label: string; path: string }> = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const instruction = instructions[i]!;
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

  const skills = input.skills ?? [];
  const manifestSkills: Array<{ name: string; description: string; path: string }> = [];
  const materializedSkillDirs = new Set<string>();
  for (const skill of skills) {
    // Canonical Agent Skills layout. `.agents/skills/<name>/SKILL.md` is discovered
    // natively by OpenCode and Copilot CLI; Kilo picks the same directory up via the
    // generated kilo.json `skills.paths`; Claude Code gets a `.claude/skills` copy
    // below because it only discovers `.claude/skills/<name>/SKILL.md`.
    const skillDir = sanitizeSkillDirName(skill.name);
    if (materializedSkillDirs.has(skillDir)) {
      throw new TypeError(`Runtime bundle skill names collide after normalization: ${skill.name}`);
    }
    materializedSkillDirs.add(skillDir);
    const relPath = posix.join(AGENTS_SKILLS_DIR, skillDir, "SKILL.md");
    const absPath = join(workingDir, relPath);

    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, skill.content, "utf8");

    allConfigFiles.set(relPath, skill.content);

    if (adapter.kind === "claude-code") {
      const claudeRelPath = posix.join(CLAUDE_SKILLS_DIR, skillDir, "SKILL.md");
      const claudeAbsPath = join(workingDir, claudeRelPath);
      await mkdir(join(claudeAbsPath, ".."), { recursive: true });
      await writeFile(claudeAbsPath, skill.content, "utf8");
      allConfigFiles.set(claudeRelPath, skill.content);
    }

    manifestSkills.push({
      name: skill.name,
      description: skill.description,
      path: relPath,
    });
  }

  if (instructions.length > 0) {
    const agentsMdContent = renderAgentsMd(instructions);
    await writeFile(join(workingDir, AGENTS_MD_FILE), agentsMdContent, "utf8");
    allConfigFiles.set(AGENTS_MD_FILE, agentsMdContent);

    if (adapter.kind === "claude-code") {
      // Claude Code only auto-loads CLAUDE.md; the @-import pulls in the shared
      // AGENTS.md body so instruction content is not duplicated on disk.
      const claudeMdContent = `@${AGENTS_MD_FILE}\n`;
      await writeFile(join(workingDir, CLAUDE_MD_FILE), claudeMdContent, "utf8");
      allConfigFiles.set(CLAUDE_MD_FILE, claudeMdContent);
    }
  }

  const mcpToolNames = (input.mcpTools ?? []).map((tool) => tool.name);

  if (adapter.kind === "kilo") {
    const kiloConfigKey = ".kilo/kilo.json";
    const existingConfig = allConfigFiles.get(kiloConfigKey);
    if (existingConfig) {
      const parsed = JSON.parse(existingConfig) as Record<string, unknown>;
      let updated = false;
      if (input.mcpServers?.length) {
        const mcpSection: Record<string, unknown> = {};
        for (const server of input.mcpServers) {
          mcpSection[server.name] = server.config;
        }
        parsed.mcp = mcpSection;
        updated = true;
      }
      if (skills.length > 0) {
        // Verified kilo.json field: extra Agent Skills discovery directories.
        parsed.skills = { paths: [AGENTS_SKILLS_DIR] };
        updated = true;
      }
      if (updated) {
        const updatedConfig = JSON.stringify(parsed, null, 2);
        allConfigFiles.set(kiloConfigKey, updatedConfig);
        await writeFile(join(workingDir, ".kilo", "kilo.json"), updatedConfig, "utf8");
      }
    }
  }

  if (adapter.kind === "opencode") {
    const opencodeConfigKey = "opencode.json";
    const existingConfig = allConfigFiles.get(opencodeConfigKey);
    if (existingConfig) {
      const parsed = JSON.parse(existingConfig) as Record<string, unknown>;
      let updated = false;
      if (input.mcpServers?.length) {
        // OpenCode config `mcp` section: local servers use { type, command[] }, the
        // same canonical shape the bundle receives (opencode.ai/docs/mcp-servers).
        const mcpSection: Record<string, unknown> = {};
        for (const server of input.mcpServers) {
          mcpSection[server.name] = { enabled: true, ...server.config };
        }
        parsed.mcp = mcpSection;
        updated = true;
      }
      if (skills.length > 0) {
        // Let review skills load without an interactive approval prompt
        // (opencode.json `permission.skill` patterns; "*" is allowlisted here
        // because the bundle only contains skills AICR itself materialized).
        const permission = (parsed.permission ?? {}) as Record<string, unknown>;
        permission.skill = { "*": "allow" };
        parsed.permission = permission;
        updated = true;
      }
      if (updated) {
        const updatedConfig = JSON.stringify(parsed, null, 2);
        allConfigFiles.set(opencodeConfigKey, updatedConfig);
        await writeFile(join(workingDir, opencodeConfigKey), updatedConfig, "utf8");
      }
    }
  }

  let piBridgeWritten = false;
  if (adapter.kind === "pi" && input.mcpServers?.length) {
    // pi has no built-in MCP client; the generated extension bridges the canonical
    // local (stdio) servers via pi.registerTool. Remote servers are not bridged —
    // AICR only ever materializes the local aicr-output server.
    const specs: Array<{
      name: string;
      command: readonly string[];
      environment?: Readonly<Record<string, string>>;
    }> = [];
    for (const server of input.mcpServers) {
      const command = server.config.command;
      if (
        server.config.type === "local"
        && Array.isArray(command)
        && command.length > 0
        && command.every((part): part is string => typeof part === "string")
      ) {
        const environment = server.config.environment as Readonly<Record<string, string>> | undefined;
        specs.push({ name: server.name, command, ...(environment ? { environment } : {}) });
      }
    }
    if (specs.length > 0) {
      const bridgeContent = renderPiMcpBridgeExtension();
      const bridgeAbsPath = join(workingDir, PI_MCP_BRIDGE_EXTENSION_PATH);
      await mkdir(join(bridgeAbsPath, ".."), { recursive: true });
      await writeFile(bridgeAbsPath, bridgeContent, "utf8");
      allConfigFiles.set(PI_MCP_BRIDGE_EXTENSION_PATH, bridgeContent);
      allEnvVars[PI_MCP_SERVERS_ENV] = JSON.stringify(specs);
      piBridgeWritten = true;
    }
  }

  let ompMcpWritten = false;
  if (adapter.kind === "oh-my-pi" && input.mcpServers?.length) {
    const mcpJson = toOhMyPiMcpServersJson(input.mcpServers as readonly AgentSpawnMcpServer[]);
    if (mcpJson) {
      const mcpAbsPath = join(workingDir, OMP_MCP_CONFIG_PATH);
      await mkdir(join(mcpAbsPath, ".."), { recursive: true });
      await writeFile(mcpAbsPath, mcpJson, "utf8");
      allConfigFiles.set(OMP_MCP_CONFIG_PATH, mcpJson);
      ompMcpWritten = true;
    }
  }

  const instructionSurfaces: string[] = [];
  const skillSurfaces: string[] = [];
  if (instructions.length > 0) {
    instructionSurfaces.push(AGENTS_MD_FILE);
    if (adapter.kind === "claude-code") instructionSurfaces.push(CLAUDE_MD_FILE);
  }
  if (skills.length > 0) {
    skillSurfaces.push(AGENTS_SKILLS_DIR);
    if (adapter.kind === "claude-code") skillSurfaces.push(CLAUDE_SKILLS_DIR);
    if (adapter.kind === "kilo") skillSurfaces.push("kilo.json:skills.paths");
    if (adapter.kind === "opencode") skillSurfaces.push("opencode.json:permission.skill");
  }
  const hasMcpServers = (input.mcpServers?.length ?? 0) > 0;
  // pi/omp surfaces reflect actual materialization, not just intent: a pi bundle
  // with only remote MCP servers gets no bridge, and an omp bundle whose servers
  // all fail conversion gets no mcp.json — both must report "none".
  const mcpSurface: "config_file" | "cli_flag" | "extension" | "none" = adapter.kind === "pi"
    ? (piBridgeWritten ? "extension" : "none")
    : adapter.kind === "oh-my-pi"
      ? (ompMcpWritten ? "config_file" : "none")
      : !hasMcpServers
        ? "none"
        : adapter.kind === "kilo" || adapter.kind === "opencode"
          ? "config_file"
          : adapter.kind === "claude-code" || adapter.kind === "copilot-cli"
            ? "cli_flag"
            : "none";

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
    contextCompaction: computeContextCompactionManifest(adapter.kind, input.compaction),
    webSearch: computeWebSearchManifest(adapter.kind, input.webSearch),
    nativeSurfaces: {
      instructions: instructionSurfaces,
      skills: skillSurfaces,
      mcp: mcpSurface,
    },
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

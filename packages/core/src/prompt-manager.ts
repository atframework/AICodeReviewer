import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

export type RepoInstructionKind =
  | "nearest_agents"
  | "root_agents"
  | "path_instruction"
  | "copilot_instruction"
  | "alias";

export type PromptAssetKind = RepoInstructionKind | "skill" | "operator_override" | "memory_hint";

export interface PromptConflict {
  winner: string;
  loser: string;
  reason: string;
}

export interface DroppedPromptAssetRef {
  kind: PromptAssetKind;
  label: string;
  reason: string;
  path?: string;
  replacedBy?: string;
}

export interface LoadedPromptAssetRef {
  kind: PromptAssetKind;
  label: string;
  summary: string;
  reason: string;
  priority: number;
  path?: string;
  matchedPaths?: string[];
  appliesTo?: string[];
}

export interface RepoInstructionCandidate extends LoadedPromptAssetRef {
  kind: RepoInstructionKind;
  path: string;
  content: string;
  specificity: number;
}

export interface SkillCandidate extends LoadedPromptAssetRef {
  kind: "skill";
  path: string;
  name: string;
  description: string;
  content: string;
  specificity: number;
}

export interface RepoPromptDiscovery {
  instructions: RepoInstructionCandidate[];
  skills: SkillCandidate[];
  droppedRefs: DroppedPromptAssetRef[];
  conflicts: PromptConflict[];
}

export interface DiscoverRepoPromptAssetsOptions {
  sourceRoot: string;
  changedPaths: string[];
}

export interface PromptAssemblyInput {
  baseSystemPrompt: string;
  discovery: RepoPromptDiscovery;
  operatorOverrides?: string[];
  memoryHints?: string[];
  taskContext: string;
  maxPromptTokens?: number;
}

export interface PromptAssemblyOutput {
  systemPrompt: string;
  tokenEstimate: number;
  repoInstructionSummaries: string[];
  activeSkillSummaries: string[];
  loadedInstructionRefs: LoadedPromptAssetRef[];
  activatedSkillRefs: LoadedPromptAssetRef[];
  droppedInstructionRefs: DroppedPromptAssetRef[];
  conflicts: PromptConflict[];
}

const aliasInstructionFiles = ["CLAUDE.md", "GEMINI.md"] as const;

const instructionBasePriority: Record<RepoInstructionKind, number> = {
  nearest_agents: 500,
  path_instruction: 400,
  root_agents: 300,
  copilot_instruction: 200,
  alias: 100,
};

const skillBasePriority = 50;
const operatorOverridePriority = 1_000;

const frontmatterPattern = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
}

function truncate(text: string, maxChars = 240): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizeMarkdown(markdown: string, maxChars = 240): string {
  const withoutCodeFences = markdown.replace(/```[\s\S]*?```/gu, " ");
  const cleaned = withoutCodeFences
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.replace(/^[-*+]\s+/u, "").replace(/^\d+\.\s+/u, "").replace(/^>\s*/u, ""))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  return truncate(cleaned || "(no summary available)", maxChars);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitMarkdownFrontmatter(content: string): {
  attributes: Record<string, unknown>;
  body: string;
} {
  const match = frontmatterPattern.exec(content);
  if (!match) {
    return { attributes: {}, body: content };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    parsed = undefined;
  }
  return {
    attributes: isPlainObject(parsed) ? parsed : {},
    body: content.slice(match[0].length),
  };
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[\r\n,]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeStringList(entry));
  }

  return [];
}

function countPathSegments(pathValue: string): number {
  const normalized = normalizePath(pathValue);
  if (!normalized || normalized === ".") {
    return 0;
  }

  return normalized.split("/").filter(Boolean).length;
}

function patternSpecificity(patterns: string[]): number {
  return Math.max(
    0,
    ...patterns.map((pattern) => normalizePath(pattern).replace(/[?*]/gu, "").length),
  );
}

function createLoadedRef<TKind extends PromptAssetKind>(
  kind: TKind,
  label: string,
  summary: string,
  reason: string,
  priority: number,
  options?: {
    path?: string;
    matchedPaths?: string[];
    appliesTo?: string[];
  },
): LoadedPromptAssetRef & { kind: TKind } {
  return {
    kind,
    label,
    summary,
    reason,
    priority,
    ...(options?.path ? { path: options.path } : {}),
    ...(options?.matchedPaths?.length ? { matchedPaths: [...options.matchedPaths] } : {}),
    ...(options?.appliesTo?.length ? { appliesTo: [...options.appliesTo] } : {}),
  };
}

function createDroppedRef(
  kind: PromptAssetKind,
  label: string,
  reason: string,
  options?: {
    path?: string;
    replacedBy?: string;
  },
): DroppedPromptAssetRef {
  return {
    kind,
    label,
    reason,
    ...(options?.path ? { path: options.path } : {}),
    ...(options?.replacedBy ? { replacedBy: options.replacedBy } : {}),
  };
}

function compareLoadedRefs(a: LoadedPromptAssetRef, b: LoadedPromptAssetRef): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }

  return a.label.localeCompare(b.label);
}

function segmentPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/([.+^${}()|[\]\\])/gu, "\\$1");
  const regexBody = escaped.replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]");

  return new RegExp(`^${regexBody}$`, "u");
}

function globMatchesPath(pattern: string, pathValue: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(pathValue);

  const patternSegments = normalizedPattern ? normalizedPattern.split("/") : [];
  const pathSegments = normalizedPath ? normalizedPath.split("/") : [];

  function matchAt(patternIndex: number, pathIndex: number): boolean {
    while (patternIndex < patternSegments.length) {
      const patternSegment = patternSegments[patternIndex];
      if (!patternSegment) {
        return false;
      }

      if (patternSegment === "**") {
        if (patternIndex === patternSegments.length - 1) {
          return true;
        }

        for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
          if (matchAt(patternIndex + 1, nextPathIndex)) {
            return true;
          }
        }

        return false;
      }

      const pathSegment = pathSegments[pathIndex];
      if (!pathSegment || !segmentPatternToRegExp(patternSegment).test(pathSegment)) {
        return false;
      }

      patternIndex += 1;
      pathIndex += 1;
    }

    return pathIndex === pathSegments.length;
  }

  return matchAt(0, 0);
}

function normalizeChangedPath(sourceRoot: string, changedPath: string): string {
  const absolutePath = resolve(sourceRoot, changedPath);
  const relativePath = normalizePath(relative(sourceRoot, absolutePath));

  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    throw new RangeError(`Changed path ${changedPath} must stay within ${sourceRoot}`);
  }

  return relativePath;
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function walkFiles(rootDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(rootDirectory, entry.name);
        if (entry.isDirectory()) {
          return walkFiles(entryPath);
        }

        return [entryPath];
      }),
    );

    return files.flat();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function extractAppliesToSectionPatterns(body: string): string[] {
  const lines = body.split(/\r?\n/u);
  const collected: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inSection && /^#{1,6}\s+Applies To\s*$/iu.test(trimmed)) {
      inSection = true;
      continue;
    }

    if (inSection && /^#{1,6}\s+/u.test(trimmed)) {
      break;
    }

    if (inSection && trimmed) {
      const candidate = trimmed
        .replace(/^[-*+]\s+/u, "")
        .replace(/^\d+\.\s+/u, "")
        .replace(/^`(.+)`$/u, "$1")
        .trim();

      if (candidate) {
        collected.push(candidate);
      }
    }
  }

  return collected;
}

function matchPaths(patterns: string[], changedPaths: string[]): string[] {
  if (patterns.length === 0) {
    return [...changedPaths];
  }

  return changedPaths.filter((changedPath) => patterns.some((pattern) => globMatchesPath(pattern, changedPath)));
}

function formatReasonFromPaths(paths: string[], fallback: string): string {
  if (paths.length === 0) {
    return fallback;
  }

  return `matches ${paths.join(", ")}`;
}

function formatInstructionSummary(ref: LoadedPromptAssetRef): string {
  const qualifiers: string[] = [];
  if (ref.path) {
    qualifiers.push(`from \`${ref.path}\``);
  }

  if (ref.matchedPaths?.length) {
    qualifiers.push(`matches \`${ref.matchedPaths.join("`, `")}\``);
  }

  if (ref.appliesTo?.length) {
    qualifiers.push(`applies to \`${ref.appliesTo.join("`, `")}\``);
  }

  const qualifierText = qualifiers.length > 0 ? ` (${qualifiers.join("; ")})` : "";

  return `- [${ref.kind}] ${ref.label}${qualifierText}: ${ref.summary}`;
}

function formatSkillSummary(ref: LoadedPromptAssetRef): string {
  const qualifiers: string[] = [];
  if (ref.path) {
    qualifiers.push(`from \`${ref.path}\``);
  }

  if (ref.appliesTo?.length) {
    qualifiers.push(`applies to \`${ref.appliesTo.join("`, `")}\``);
  }

  const qualifierText = qualifiers.length > 0 ? ` (${qualifiers.join("; ")})` : "";
  return `- \`${ref.label}\`${qualifierText}: ${ref.summary}`;
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.join("\n") : "(none)";
}

function renderPromptTemplate(template: string, sections: Record<string, string>): string {
  return Object.entries(sections).reduce((result, [placeholder, value]) => {
    return result.replaceAll(`{{${placeholder}}}`, value);
  }, template);
}

export async function discoverRepoPromptAssets(
  options: DiscoverRepoPromptAssetsOptions,
): Promise<RepoPromptDiscovery> {
  const sourceRoot = resolve(options.sourceRoot);
  const changedPaths = Array.from(new Set(options.changedPaths.map((pathValue) => normalizeChangedPath(sourceRoot, pathValue))));
  const instructions: RepoInstructionCandidate[] = [];
  const skills: SkillCandidate[] = [];
  const droppedRefs: DroppedPromptAssetRef[] = [];
  const conflicts: PromptConflict[] = [];
  const nearestAgents = new Map<string, Set<string>>();

  for (const changedPath of changedPaths) {
    let currentDirectory = dirname(changedPath);

    while (true) {
      const candidatePath = currentDirectory === "." ? "AGENTS.md" : `${normalizePath(currentDirectory)}/AGENTS.md`;
      const absolutePath = join(sourceRoot, candidatePath);
      const content = await readTextFileIfExists(absolutePath);
      if (content !== undefined) {
        const matchedPaths = nearestAgents.get(candidatePath) ?? new Set<string>();
        matchedPaths.add(changedPath);
        nearestAgents.set(candidatePath, matchedPaths);
        break;
      }

      if (currentDirectory === ".") {
        break;
      }

      const parentDirectory = dirname(currentDirectory);
      if (parentDirectory === currentDirectory) {
        break;
      }

      currentDirectory = parentDirectory;
    }
  }

  for (const [pathValue, matchedPaths] of nearestAgents.entries()) {
    const content = await readFile(join(sourceRoot, pathValue), "utf8");
    const summary = summarizeMarkdown(content);
    const specificity = countPathSegments(dirname(pathValue));
    instructions.push({
      ...createLoadedRef(
        "nearest_agents",
        pathValue,
        summary,
        formatReasonFromPaths([...matchedPaths], "nearest AGENTS.md for the changed paths"),
        instructionBasePriority.nearest_agents + specificity,
        {
          path: pathValue,
          matchedPaths: [...matchedPaths],
        },
      ),
      path: pathValue,
      content,
      specificity,
    });
  }

  const rootAgentsPath = "AGENTS.md";
  const rootAgentsContent = await readTextFileIfExists(join(sourceRoot, rootAgentsPath));
  if (rootAgentsContent !== undefined) {
    if (nearestAgents.has(rootAgentsPath)) {
      droppedRefs.push(
        createDroppedRef(
          "root_agents",
          rootAgentsPath,
          "root AGENTS.md already loaded via nearest AGENTS discovery",
          { path: rootAgentsPath, replacedBy: rootAgentsPath },
        ),
      );
    } else {
      instructions.push({
        ...createLoadedRef(
          "root_agents",
          rootAgentsPath,
          summarizeMarkdown(rootAgentsContent),
          "repo-wide root AGENTS.md",
          instructionBasePriority.root_agents,
          { path: rootAgentsPath },
        ),
        path: rootAgentsPath,
        content: rootAgentsContent,
        specificity: 0,
      });
    }
  }

  const copilotInstructionsPath = ".github/copilot-instructions.md";
  const copilotInstructionsContent = await readTextFileIfExists(join(sourceRoot, copilotInstructionsPath));
  if (copilotInstructionsContent !== undefined) {
    instructions.push({
      ...createLoadedRef(
        "copilot_instruction",
        copilotInstructionsPath,
        summarizeMarkdown(copilotInstructionsContent),
        "repo-wide Copilot instructions",
        instructionBasePriority.copilot_instruction,
        { path: copilotInstructionsPath },
      ),
      path: copilotInstructionsPath,
      content: copilotInstructionsContent,
      specificity: 0,
    });
  }

  const instructionFiles = (await walkFiles(join(sourceRoot, ".github", "instructions"))).filter((pathValue) =>
    pathValue.endsWith(".instructions.md"),
  );

  for (const instructionFile of instructionFiles) {
    const relativePath = normalizePath(relative(sourceRoot, instructionFile));
    const content = await readFile(instructionFile, "utf8");
    const { attributes, body } = splitMarkdownFrontmatter(content);
    const appliesTo = normalizeStringList(attributes.applyTo ?? attributes.apply_to);
    if (appliesTo.length === 0) {
      droppedRefs.push(
        createDroppedRef("path_instruction", relativePath, "missing applyTo frontmatter", {
          path: relativePath,
        }),
      );
      continue;
    }

    const matchedPaths = matchPaths(appliesTo, changedPaths);
    if (matchedPaths.length === 0) {
      droppedRefs.push(
        createDroppedRef(
          "path_instruction",
          relativePath,
          `applyTo did not match changed paths (${appliesTo.join(", ")})`,
          { path: relativePath },
        ),
      );
      continue;
    }

    const specificity = patternSpecificity(appliesTo);
    instructions.push({
      ...createLoadedRef(
        "path_instruction",
        relativePath,
        summarizeMarkdown(body),
        formatReasonFromPaths(matchedPaths, "path-specific instruction matched"),
        instructionBasePriority.path_instruction + specificity,
        {
          path: relativePath,
          matchedPaths,
          appliesTo,
        },
      ),
      path: relativePath,
      content,
      specificity,
    });
  }

  for (const aliasFile of aliasInstructionFiles) {
    const content = await readTextFileIfExists(join(sourceRoot, aliasFile));
    if (content === undefined) {
      continue;
    }

    instructions.push({
      ...createLoadedRef(
        "alias",
        aliasFile,
        summarizeMarkdown(content),
        `compatible alias instruction file ${aliasFile}`,
        instructionBasePriority.alias,
        { path: aliasFile },
      ),
      path: aliasFile,
      content,
      specificity: 0,
    });
  }

  const skillFiles = (await walkFiles(join(sourceRoot, ".agents", "skills"))).filter((pathValue) =>
    normalizePath(pathValue).endsWith("/SKILL.md"),
  );

  for (const skillFile of skillFiles) {
    const relativePath = normalizePath(relative(sourceRoot, skillFile));
    const content = await readFile(skillFile, "utf8");
    const { attributes, body } = splitMarkdownFrontmatter(content);
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const description = typeof attributes.description === "string" ? attributes.description.trim() : "";
    if (!name || !description) {
      droppedRefs.push(
        createDroppedRef("skill", relativePath, "missing name/description in SKILL frontmatter", {
          path: relativePath,
        }),
      );
      continue;
    }

    const appliesTo = extractAppliesToSectionPatterns(body);
    const matchedPaths = matchPaths(appliesTo, changedPaths);
    if (appliesTo.length > 0 && matchedPaths.length === 0) {
      droppedRefs.push(
        createDroppedRef(
          "skill",
          name,
          `Applies To section did not match changed paths (${appliesTo.join(", ")})`,
          { path: relativePath },
        ),
      );
      continue;
    }

    const specificity = patternSpecificity(appliesTo);
    const summaryText = appliesTo.length > 0 ? `${description} Applies to ${appliesTo.join(", ")}.` : description;
    skills.push({
      ...createLoadedRef(
        "skill",
        name,
        truncate(summaryText),
        appliesTo.length > 0 ? formatReasonFromPaths(matchedPaths, "skill applies to the changed paths") : "no Applies To section; treated as repo-wide skill",
        skillBasePriority + specificity,
        {
          path: relativePath,
          matchedPaths,
          appliesTo,
        },
      ),
      path: relativePath,
      name,
      description,
      content,
      specificity,
    });
  }

  instructions.sort((left, right) => compareLoadedRefs(left, right));
  skills.sort((left, right) => compareLoadedRefs(left, right));

  return {
    instructions,
    skills,
    droppedRefs,
    conflicts,
  };
}

export function assemblePrompt(input: PromptAssemblyInput): PromptAssemblyOutput {
  const operatorOverrideRefs = (input.operatorOverrides ?? []).map((override, index) => {
    return createLoadedRef(
      "operator_override",
      `runtime override ${index + 1}`,
      summarizeMarkdown(override),
      "runtime operator/workspace override",
      operatorOverridePriority,
    );
  });

  const instructionRefs = [...operatorOverrideRefs, ...input.discovery.instructions].sort(compareLoadedRefs);
  const skillRefs = [...input.discovery.skills].sort(compareLoadedRefs);
  const memoryHints = [...(input.memoryHints ?? [])];
  const droppedInstructionRefs = [...input.discovery.droppedRefs];

  const createSections = (): {
    repoInstructionSummaries: string[];
    activeSkillSummaries: string[];
    memoryHintSummaries: string[];
    renderedPrompt: string;
  } => {
    const repoInstructionSummaries = instructionRefs.map((ref) => formatInstructionSummary(ref));
    const activeSkillSummaries = skillRefs.map((ref) => formatSkillSummary(ref));
    const memoryHintSummaries = memoryHints.map((hint, index) => `- memory hint ${index + 1}: ${summarizeMarkdown(hint)}`);

    const renderedPrompt = renderPromptTemplate(input.baseSystemPrompt, {
      REPO_INSTRUCTION_SUMMARIES: renderList(repoInstructionSummaries),
      ACTIVE_SKILL_SUMMARIES: renderList(activeSkillSummaries),
      MEMORY_HINTS: renderList(memoryHintSummaries),
      TASK_CONTEXT: input.taskContext.trim() || "(none)",
    });

    return {
      repoInstructionSummaries,
      activeSkillSummaries,
      memoryHintSummaries,
      renderedPrompt,
    };
  };

  let sections = createSections();

  while (input.maxPromptTokens !== undefined && estimateTokens(sections.renderedPrompt) > input.maxPromptTokens) {
    let removed = false;

    if (memoryHints.length > 0) {
      const removedHint = memoryHints.pop();
      if (removedHint) {
        droppedInstructionRefs.push(
          createDroppedRef(
            "memory_hint",
            `memory hint ${memoryHints.length + 1}`,
            `trimmed to stay within prompt budget (${input.maxPromptTokens} tokens)`,
          ),
        );
        removed = true;
      }
    } else if (skillRefs.length > 0) {
      const removedSkill = skillRefs.pop();
      if (removedSkill) {
        droppedInstructionRefs.push(
          createDroppedRef("skill", removedSkill.label, `trimmed to stay within prompt budget (${input.maxPromptTokens} tokens)`, removedSkill.path ? { path: removedSkill.path } : undefined),
        );
        removed = true;
      }
    } else {
      const droppableIndex = instructionRefs.findLastIndex((ref) => ref.kind !== "operator_override");
      if (droppableIndex >= 0) {
        const [removedInstruction] = instructionRefs.splice(droppableIndex, 1);
        if (removedInstruction) {
          droppedInstructionRefs.push(
            createDroppedRef(
              removedInstruction.kind,
              removedInstruction.label,
              `trimmed to stay within prompt budget (${input.maxPromptTokens} tokens)`,
              removedInstruction.path ? { path: removedInstruction.path } : undefined,
            ),
          );
          removed = true;
        }
      }
    }

    if (!removed) {
      break;
    }

    sections = createSections();
  }

  return {
    systemPrompt: sections.renderedPrompt,
    tokenEstimate: estimateTokens(sections.renderedPrompt),
    repoInstructionSummaries: sections.repoInstructionSummaries,
    activeSkillSummaries: sections.activeSkillSummaries,
    loadedInstructionRefs: instructionRefs,
    activatedSkillRefs: skillRefs,
    droppedInstructionRefs,
    conflicts: input.discovery.conflicts,
  };
}

export { estimateTokens as estimatePromptTokens, renderPromptTemplate };
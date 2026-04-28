import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assemblePrompt,
  discoverRepoPromptAssets,
  type LoadedPromptAssetRef,
  type DroppedPromptAssetRef,
  type PromptAssemblyOutput,
  type RepoPromptDiscovery,
} from "./prompt-manager.js";
import type { ReviewEvent } from "./review-event.js";
import { normalizeChangedPath } from "./utils.js";

export interface PrepareReviewPromptInput {
  readonly reviewEvent: ReviewEvent;
  readonly sourceRoot: string;
  readonly baseSystemPrompt: string;
  readonly changedPaths?: readonly string[];
  readonly operatorOverrides?: readonly string[];
  readonly memoryHints?: readonly string[];
  readonly maxPromptTokens?: number;
  readonly taskContext?: string;
}

export interface PreparedReviewPrompt {
  readonly reviewEvent: ReviewEvent;
  readonly sourceRoot: string;
  readonly changedPaths: readonly string[];
  readonly taskContext: string;
  readonly discovery: RepoPromptDiscovery;
  readonly prompt: PromptAssemblyOutput;
}

export interface PreparedReviewPromptSummary {
  readonly sourceRoot: string;
  readonly changedPaths: readonly string[];
  readonly taskContext: string;
  readonly promptTokenEstimate: number;
  readonly instructionCount: number;
  readonly skillCount: number;
  readonly droppedAssetCount: number;
  readonly loadedInstructions: readonly LoadedPromptAssetRef[];
  readonly activeSkills: readonly LoadedPromptAssetRef[];
  readonly droppedAssets: readonly DroppedPromptAssetRef[];
  readonly systemPrompt: string;
}

function uniqueChangedPaths(sourceRoot: string, paths: readonly string[]): string[] {
  return Array.from(
    new Set(
      paths
        .map((pathValue) => pathValue.trim())
        .filter(Boolean)
        .map((pathValue) => normalizeChangedPath(sourceRoot, pathValue)),
    ),
  );
}

export function buildReviewTaskContext(
  reviewEvent: ReviewEvent,
  changedPaths: readonly string[],
): string {
  const lines = [
    `Review target: ${reviewEvent.targetKind}`,
    `Provider: ${reviewEvent.provider}`,
    `Workspace: ${reviewEvent.workspaceId}`,
    `Trigger: ${reviewEvent.triggerName}`,
    `Repository: ${reviewEvent.repoRef}`,
    `Reason: ${reviewEvent.reason}`,
  ];

  if (reviewEvent.baseSha) {
    lines.push(`Base SHA: ${reviewEvent.baseSha}`);
  }

  if (reviewEvent.headSha) {
    lines.push(`Head SHA: ${reviewEvent.headSha}`);
  }

  if (reviewEvent.url) {
    lines.push(`URL: ${reviewEvent.url}`);
  }

  lines.push("Changed files:");

  if (changedPaths.length === 0) {
    lines.push("- (not provided)");
  } else {
    lines.push(...changedPaths.map((pathValue) => `- ${pathValue}`));
  }

  return lines.join("\n");
}

export async function loadSystemPromptTemplate(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function prepareReviewPrompt(
  input: PrepareReviewPromptInput,
): Promise<PreparedReviewPrompt> {
  const sourceRoot = resolve(input.sourceRoot);
  const changedPaths = uniqueChangedPaths(
    sourceRoot,
    input.changedPaths ?? input.reviewEvent.changedFiles ?? [],
  );
  const discovery = await discoverRepoPromptAssets({
    sourceRoot,
    changedPaths,
  });
  const taskContext = input.taskContext?.trim()
    ? input.taskContext.trim()
    : buildReviewTaskContext(input.reviewEvent, changedPaths);
  const prompt = assemblePrompt({
    baseSystemPrompt: input.baseSystemPrompt,
    discovery,
    taskContext,
    ...(input.operatorOverrides ? { operatorOverrides: [...input.operatorOverrides] } : {}),
    ...(input.memoryHints ? { memoryHints: [...input.memoryHints] } : {}),
    ...(input.maxPromptTokens !== undefined ? { maxPromptTokens: input.maxPromptTokens } : {}),
  });

  return {
    reviewEvent: input.reviewEvent,
    sourceRoot,
    changedPaths,
    taskContext,
    discovery,
    prompt,
  };
}

export function summarizePreparedReviewPrompt(
  preparation: PreparedReviewPrompt,
): PreparedReviewPromptSummary {
  return {
    sourceRoot: preparation.sourceRoot,
    changedPaths: preparation.changedPaths,
    taskContext: preparation.taskContext,
    promptTokenEstimate: preparation.prompt.tokenEstimate,
    instructionCount: preparation.prompt.loadedInstructionRefs.length,
    skillCount: preparation.prompt.activatedSkillRefs.length,
    droppedAssetCount: preparation.prompt.droppedInstructionRefs.length,
    loadedInstructions: preparation.prompt.loadedInstructionRefs,
    activeSkills: preparation.prompt.activatedSkillRefs,
    droppedAssets: preparation.prompt.droppedInstructionRefs,
    systemPrompt: preparation.prompt.systemPrompt,
  };
}
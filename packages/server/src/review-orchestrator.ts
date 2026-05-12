import { basename, dirname, join } from "node:path";

import {
  buildReviewTaskContext,
  fixAndValidateMarkdown,
  isPlainObject,
  normalizePath,
  prepareReviewPrompt,
  scrubPromptMessages,
  scrubText,
  type PreparedReviewPrompt,
  type ReviewEvent,
  type ReviewProvider,
  type ScrubMatch,
} from "@aicr/core";
import type { AgentAdapter } from "@aicr/agents";
import {
  type ChatCompletionClient,
  type ChatCompletionResult,
  compressDiff,
  estimatePromptTokenCount,
  shouldTriggerCompression,
  type CompressionConfig,
  type ModelSpec,
} from "@aicr/llm";
import {
  AicrOutputCollector,
  createAicrOutputToolRegistry,
  type AicrOutputToolDefinition,
  type AicrOutputToolName,
  type AicrOutputState,
  type FetchMoreContextInput,
  type ReportProblemInput,
} from "@aicr/mcp-output";
import {
  buildAtMentions,
  buildTemplateTargetContext,
  computeProblemFingerprint,
  createTemplateResolver,
  toTemplateProblem,
  type AuthorResolutionOptions,
  type TemplateContext,
  type TemplateResolver,
  type MentionChannelKind,
} from "@aicr/outputs";
import type { DispatchResult, ReviewProblem } from "@aicr/outputs";
import type { SandboxBackend, SandboxSpawnResult } from "@aicr/sandbox";
import type { ChangeRange, ExtraContextRequest, ParsedDiff, VcsAdapter } from "@aicr/vcs";

export interface DiffCapableVcsAdapter extends VcsAdapter {
  diff?(range: ChangeRange, options?: { readonly contextLines?: number }): Promise<ParsedDiff>;
}

export type ReviewDispatchResult = DispatchResult | readonly DispatchResult[];

export interface ReviewOutputPublisher {
  readonly publishesProblems?: boolean;
  readonly handlesRendering?: boolean;
  readonly publishEmptySummary?: boolean;
  readonly noProblemsAction?: "publish" | "suppress";
  publishProblem?(problem: ReviewProblem): Promise<ReviewDispatchResult>;
  publishSummary?(summary: string, problems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<ReviewDispatchResult>;
}

export interface ReviewSummaryPublishOptions {
  readonly bypassNoProblemsPolicy?: boolean;
}

export type ReviewOutputPublisherResolver = (
  context: ReviewOrchestrationContext,
) => ReviewOutputPublisher | undefined;

export type ReviewOrchestrationProvider = ReviewProvider;

export interface ReviewOrchestrationContext {
  readonly reviewEvent: ReviewEvent;
  readonly payload: unknown;
  readonly provider: ReviewOrchestrationProvider;
  readonly eventName: string;
}

export interface ServerReviewOrchestrationOptions {
  readonly baseSystemPrompt: string;
  readonly sourceRootResolver: (reviewEvent: ReviewEvent) => string | undefined;
  readonly vcs: DiffCapableVcsAdapter;
  readonly vcsFactory?: (sourceRoot: string, context: ReviewOrchestrationContext) => DiffCapableVcsAdapter;
  readonly llm: ChatCompletionClient;
  readonly model: ModelSpec;
  readonly outputPublisher?: ReviewOutputPublisher;
  readonly outputPublisherResolver?: ReviewOutputPublisherResolver;
  readonly changedPathsResolver?: (context: ReviewOrchestrationContext) => readonly string[] | undefined;
  readonly operatorOverrides?: readonly string[];
  readonly memoryHints?: readonly string[];
  readonly maxPromptTokens?: number;
  readonly diffContextLines?: number;
  readonly dryRun?: boolean;
  readonly sandbox?: SandboxBackend;
  readonly agentAdapter?: AgentAdapter;
  readonly agentTimeoutMs?: number;
  readonly scrubSecrets?: boolean;
  readonly taskContextBuilder?: (
    reviewEvent: ReviewEvent,
    changedPaths: readonly string[],
    diff: ParsedDiff | undefined,
  ) => string | undefined;
  readonly compression?: CompressionConfig;
  readonly summarizeModel?: ModelSpec;
  readonly summarizeClient?: ChatCompletionClient;
  readonly templateResolver?: TemplateResolver;
  readonly channelKind?: string;
  readonly mentionAuthor?: boolean;
  readonly authorResolution?: AuthorResolutionOptions;
  readonly ignoreLabelsResolver?: (workspaceId: string) => readonly string[];
}

export interface ReviewOrchestrationResult {
  readonly status: "dry_run" | "published" | "skipped";
  readonly sourceRoot: string;
  readonly changedFiles: readonly string[];
  readonly fetchedFiles: readonly string[];
  readonly diffFileCount: number;
  readonly promptTokenEstimate: number;
  readonly problemCount: number;
  readonly summaryCount: number;
  readonly contextRequestCount: number;
  readonly dispatchCount: number;
  readonly skipReason?: string;
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly preparedPrompt: PreparedReviewPrompt;
  readonly outputState: AicrOutputState;
  readonly dispatchResults: readonly DispatchResult[];
  readonly llmResult: ChatCompletionResult;
  readonly agentResult?: SandboxSpawnResult;
  readonly scrubMatches: readonly ScrubMatch[];
  readonly compressed?: boolean;
  readonly originalTokenEstimate?: number;
  readonly compressedTokenEstimate?: number;
}

export interface ReviewOrchestrationWebhookSummary {
  readonly status: "dry_run" | "published" | "skipped";
  readonly changedFileCount: number;
  readonly fetchedFileCount: number;
  readonly diffFileCount: number;
  readonly promptTokenEstimate: number;
  readonly problemCount: number;
  readonly summaryCount: number;
  readonly contextRequestCount: number;
  readonly dispatchCount: number;
  readonly skipReason?: string;
  readonly compressed?: boolean;
  readonly originalTokenEstimate?: number;
  readonly compressedTokenEstimate?: number;
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
  };
}

interface ToolCallEnvelope {
  readonly name: AicrOutputToolName;
  readonly input: unknown;
}

interface ContextToolResponse {
  readonly path?: string;
  readonly content?: string;
  readonly error?: string;
}

interface InvalidToolCallResponse {
  readonly name: AicrOutputToolName;
  readonly error: string;
}

interface ToolCallExecutionResult {
  readonly toolCallCount: number;
  readonly reviewOutputCount: number;
  readonly contextResponses: readonly ContextToolResponse[];
  readonly invalidContextRequestCount: number;
  readonly invalidReviewOutputCount: number;
  readonly invalidReviewOutputs: readonly InvalidToolCallResponse[];
}

function formatFilePath(file: { readonly oldPath?: string; readonly newPath?: string }): string {
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return `${file.oldPath} -> ${file.newPath}`;
  }

  return file.newPath ?? file.oldPath ?? "(unknown)";
}

export function formatParsedDiffForPrompt(diff: ParsedDiff | undefined): string {
  if (!diff || diff.files.length === 0) {
    return "Diff: (not available)";
  }

  const lines: string[] = ["Diff:"];
  for (const file of diff.files) {
    lines.push(`- ${file.status}: ${formatFilePath(file)}`);
    for (const hunk of file.hunks) {
      const section = hunk.section ? ` ${hunk.section}` : "";
      lines.push(`  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${section}`);
      for (const line of hunk.lines) {
        if (line.kind === "add") {
          lines.push(`  +${line.newLine ?? "?"}: ${line.content}`);
        } else if (line.kind === "delete") {
          lines.push(`  -${line.oldLine ?? "?"}: ${line.content}`);
        } else if (line.kind === "context") {
          lines.push(`   ${line.newLine ?? line.oldLine ?? "?"}: ${line.content}`);
        }
      }
    }
  }

  return lines.join("\n");
}

function buildJsonToolContract(): string {
  return [
    "Model output format:",
    "Return a single JSON object and no prose.",
    "Do not return only aicr.fetch_more_context; after any context request you must return a final review result.",
    "Never call aicr.fetch_more_context with an empty path; path must be one of the changed files listed in this task.",
    "For push/commit/change-commit events, include aicr.publish_summary even when there are no actionable problems so notification channels receive the analysis result.",
    "Preferred shape:",
    '{"toolCalls":[{"name":"aicr.report_problem","input":{"file":"src/file.ts","line":1,"severity":"medium","category":"correctness","message":"..."}}],"notes":"optional"}',
    '{"toolCalls":[{"name":"aicr.publish_summary","input":{"markdown":"Review completed; no actionable problems."}}]}',
    "Alternatively use problems/summary/skipReason fields; AICR will translate them into tool calls.",
  ].join("\n");
}

function buildTaskContext(
  reviewEvent: ReviewEvent,
  changedPaths: readonly string[],
  diff: ParsedDiff | undefined,
): string {
  return [
    buildReviewTaskContext(reviewEvent, changedPaths),
    "",
    formatParsedDiffForPrompt(diff),
    "",
    buildJsonToolContract(),
  ].join("\n");
}

function deriveWorkspaceRuntimeDirs(sourceRoot: string): { agentDir: string; tmpDir: string } {
  const sourceParent = dirname(sourceRoot);
  const workspaceRoot = basename(sourceParent) === "source" ? dirname(sourceParent) : sourceRoot;

  return {
    agentDir: join(workspaceRoot, "agent"),
    tmpDir: join(workspaceRoot, "tmp"),
  };
}

function resolveEnvPlaceholders(envVars: Readonly<Record<string, string>>): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    const envRef = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
    resolved[key] = envRef ? process.env[envRef[1]!] ?? "" : value;
  }

  return resolved;
}

function agentWorkingDirForSandbox(sandbox: SandboxBackend, hostAgentDir: string): string {
  return sandbox.kind === "native" ? hostAgentDir : "/workspace/agent";
}

function extractKiloJsonStreamContent(stdout: string): string {
  const textParts: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "text") {
        const part = event.part as Record<string, unknown> | undefined;
        const text = typeof event.text === "string"
          ? event.text
          : typeof part?.text === "string"
            ? part.text
            : typeof event.content === "string"
              ? event.content
              : undefined;
        if (text) {
          textParts.push(text);
        }
      } else if (event.type === "assistant" && typeof event.content === "string") {
        textParts.push(event.content);
      } else if (event.type === "error") {
        const errorData = event.error as Record<string, unknown> | undefined;
        const message = typeof errorData?.message === "string" ? errorData.message : JSON.stringify(event.error);
        throw new Error(`Kilo agent error: ${message}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Kilo agent error:")) {
        throw error;
      }
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : stdout;
}

async function runAgentReview(
  sourceRoot: string,
  task: string,
  options: ServerReviewOrchestrationOptions,
): Promise<{ readonly llmResult: ChatCompletionResult; readonly agentResult: SandboxSpawnResult }> {
  const sandbox = options.sandbox;
  const agentAdapter = options.agentAdapter;
  if (!sandbox || !agentAdapter) {
    throw new TypeError("Agent review requires both sandbox and agentAdapter options.");
  }

  const dirs = deriveWorkspaceRuntimeDirs(sourceRoot);
  let agentResult: SandboxSpawnResult | undefined;

  try {
    const materializedFs = await sandbox.materializeFs({
      sourceDir: sourceRoot,
      agentDir: dirs.agentDir,
      tmpDir: dirs.tmpDir,
    });
    const materializedAgent = await agentAdapter.materializeConfig(options.model, materializedFs.agentDir);
    const command = agentAdapter.buildCommand(task, {
      workingDir: agentWorkingDirForSandbox(sandbox, materializedAgent.workingDir),
      ...(options.agentTimeoutMs !== undefined ? { timeoutMs: options.agentTimeoutMs } : {}),
      model: options.model,
      autoApprove: true,
      task,
    });
    const env = resolveEnvPlaceholders(materializedAgent.envVars);

    agentResult = await sandbox.spawn({
      command,
      cwd: materializedFs.agentDir,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(options.agentTimeoutMs !== undefined ? { timeoutMs: options.agentTimeoutMs } : {}),
      stdin: task,
    });
  } finally {
    await sandbox.teardown();
  }

  if (agentResult.timedOut) {
    throw new Error(`Agent ${agentAdapter.kind} timed out after ${agentResult.durationMs}ms.`);
  }

  if (agentResult.exitCode !== 0) {
    throw new Error(
      `Agent ${agentAdapter.kind} exited with code ${agentResult.exitCode ?? "unknown"}: ${agentResult.stderr}`,
    );
  }

  const isKiloAgent = agentAdapter.kind === "kilo";
  const rawStdout = agentResult.stdout;
  const content = isKiloAgent ? extractKiloJsonStreamContent(rawStdout) : rawStdout;

  return {
    llmResult: {
      providerId: options.model.providerId,
      modelId: options.model.modelId,
      content,
      raw: {
        agent: agentAdapter.kind,
        exitCode: agentResult.exitCode,
        stderr: agentResult.stderr,
        durationMs: agentResult.durationMs,
      },
    },
    agentResult,
  };
}

async function requestReviewCompletion(
  sourceRoot: string,
  systemPrompt: string,
  options: ServerReviewOrchestrationOptions,
  followUp?: { readonly previousOutput: string; readonly prompt: string },
): Promise<{ readonly llmResult: ChatCompletionResult; readonly agentResult?: SandboxSpawnResult }> {
  if (options.sandbox && options.agentAdapter) {
    const task = followUp
      ? [
          systemPrompt,
          "",
          "Previous model output:",
          followUp.previousOutput,
          "",
          followUp.prompt,
        ].join("\n")
      : systemPrompt;
    return runAgentReview(sourceRoot, task, options);
  }

  const messages = followUp
    ? [
        { role: "system" as const, content: systemPrompt },
        { role: "assistant" as const, content: followUp.previousOutput },
        { role: "user" as const, content: followUp.prompt },
      ]
    : [{ role: "system" as const, content: systemPrompt }];

  return {
    llmResult: await options.llm.complete({
      model: options.model,
      messages,
    }),
  };
}

function stripReasoningBlocks(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/giu, "")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/giu, "");
}

function parseJsonCandidate(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function extractFencedJsonPayload(content: string): unknown | null {
  const fenceRegex = /```(?:json)?\s*\n([\s\S]*?)\n```/giu;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    const parsed = parseJsonCandidate(match[1]!.trim());
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function extractBalancedJsonPayload(content: string): unknown | null {
  for (let start = 0; start < content.length; start++) {
    const open = content[start];
    if (open !== "{" && open !== "[") {
      continue;
    }

    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < content.length; index++) {
      const char = content[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === open) {
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJsonCandidate(content.slice(start, index + 1));
          if (parsed !== null) {
            return parsed;
          }
          break;
        }
      }
    }
  }

  return null;
}

function extractJsonPayload(content: string): unknown {
  const trimmed = stripReasoningBlocks(content).trim();
  if (!trimmed) {
    return null;
  }

  return parseJsonCandidate(trimmed) ?? extractFencedJsonPayload(trimmed) ?? extractBalancedJsonPayload(trimmed);
}

function normalizeToolName(value: unknown): AicrOutputToolName {
  if (
    value === "aicr.report_problem" ||
    value === "aicr.publish_summary" ||
    value === "aicr.skip" ||
    value === "aicr.fetch_more_context"
  ) {
    return value;
  }

  throw new TypeError(`Unsupported AICR tool name: ${String(value)}`);
}

function problemToToolInput(value: unknown): ReportProblemInput {
  if (!isPlainObject(value)) {
    throw new TypeError("problem must be an object.");
  }

  return {
    file: value.file,
    line: value.line,
    ...(value.end_line !== undefined ? { end_line: value.end_line } : {}),
    ...(value.endLine !== undefined ? { end_line: value.endLine } : {}),
    severity: value.severity,
    category: value.category,
    message: value.message,
    ...(value.suggestion !== undefined ? { suggestion: value.suggestion } : {}),
    ...(value.fingerprint !== undefined ? { fingerprint: value.fingerprint } : {}),
  } as ReportProblemInput;
}

function parseXmlToolCalls(content: string): ToolCallEnvelope[] | null {
  const calls: ToolCallEnvelope[] = [];
  const regex = /<tool_call\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/tool_call>/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    try {
      const input = JSON.parse(match[2]!.trim());
      calls.push({ name: normalizeToolName(match[1]), input });
    } catch {
      const innerMatch = /\{[\s\S]*\}/u.exec(match[2]!);
      if (innerMatch) {
        try {
          const input = JSON.parse(innerMatch[0]);
          calls.push({ name: normalizeToolName(match[1]), input });
        } catch {
          continue;
        }
      }
    }
  }

  const selfClosingRegex = /<tool_call\s+name\s*=\s*"([^"]+)"\s*\/>/gu;
  while ((match = selfClosingRegex.exec(content)) !== null) {
    calls.push({ name: normalizeToolName(match[1]), input: {} });
  }

  return calls.length > 0 ? calls : null;
}

function parseToolCalls(content: string): ToolCallEnvelope[] {
  const toolContent = stripReasoningBlocks(content);
  const xmlCalls = parseXmlToolCalls(toolContent);
  if (xmlCalls) {
    return xmlCalls;
  }

  const payload = extractJsonPayload(toolContent);
  if (payload === null || !isPlainObject(payload)) {
    // LLM returned natural language — treat as a summary so the review is not lost
    const text = toolContent.trim();
    if (text.length > 0) {
      return [{ name: "aicr.publish_summary", input: { markdown: text } }];
    }
    return [];
  }

  const toolCalls = (payload as { readonly toolCalls?: unknown }).toolCalls;
  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls)) {
      throw new TypeError("toolCalls must be an array when provided.");
    }

    return toolCalls.map((entry) => {
      if (!isPlainObject(entry)) {
        throw new TypeError("toolCalls entries must be objects.");
      }

      return {
        name: normalizeToolName(entry.name),
        input: entry.input ?? {},
      };
    });
  }

  const hasProblemsField = "problems" in payload;
  const calls: ToolCallEnvelope[] = [];
  if (Array.isArray(payload.problems)) {
    calls.push(
      ...payload.problems.map((problem) => ({
        name: "aicr.report_problem" as const,
        input: problemToToolInput(problem),
      })),
    );
  }

  if (typeof payload.summary === "string" && payload.summary.trim()) {
    calls.push({ name: "aicr.publish_summary", input: { markdown: payload.summary } });
  } else if (isPlainObject(payload.summary) && typeof payload.summary.markdown === "string" && payload.summary.markdown.trim()) {
    calls.push({ name: "aicr.publish_summary", input: { markdown: payload.summary.markdown } });
  }

  if (typeof payload.skipReason === "string" && payload.skipReason.trim()) {
    calls.push({ name: "aicr.skip", input: { reason: payload.skipReason } });
  }

  if (calls.length === 0 && toolCalls === undefined && !hasProblemsField && !("summary" in payload) && !("skipReason" in payload)) {
    const text = toolContent.trim();
    if (text.length > 0) {
      return [{ name: "aicr.publish_summary", input: { markdown: text } }];
    }
  }

  return calls;
}

async function callAicrTools(
  content: string,
  tools: readonly AicrOutputToolDefinition[],
): Promise<ToolCallExecutionResult> {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  let toolCallCount = 0;
  let reviewOutputCount = 0;
  let invalidContextRequestCount = 0;
  let invalidReviewOutputCount = 0;
  const contextResponses: ContextToolResponse[] = [];
  const invalidReviewOutputs: InvalidToolCallResponse[] = [];
  for (const toolCall of parseToolCalls(content)) {
    toolCallCount += 1;
    const tool = toolMap.get(toolCall.name);
    if (!tool) {
      throw new TypeError(`AICR tool ${toolCall.name} is not registered.`);
    }

    try {
      const result = await tool.call(toolCall.input);
      if (toolCall.name === "aicr.fetch_more_context") {
        const input = isPlainObject(toolCall.input) ? toolCall.input : {};
        contextResponses.push({
          ...(typeof input.path === "string" ? { path: input.path } : {}),
          ...(isPlainObject(result) && typeof result.content === "string" ? { content: result.content } : {}),
        });
      } else {
        reviewOutputCount += 1;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (toolCall.name === "aicr.fetch_more_context") {
        invalidContextRequestCount += 1;
        contextResponses.push({ error: errorMessage });
        console.warn(JSON.stringify({
          level: "warn",
          msg: "ignored invalid fetch_more_context tool call",
          error: errorMessage,
        }));
        continue;
      }

      if (toolCall.name === "aicr.publish_summary") {
        invalidReviewOutputCount += 1;
        invalidReviewOutputs.push({ name: toolCall.name, error: errorMessage });
        console.warn(JSON.stringify({
          level: "warn",
          msg: "ignored invalid review output tool call",
          toolName: toolCall.name,
          error: errorMessage,
        }));
        continue;
      }

      throw error;
    }
  }

  return {
    toolCallCount,
    reviewOutputCount,
    contextResponses,
    invalidContextRequestCount,
    invalidReviewOutputCount,
    invalidReviewOutputs,
  };
}

function hasFinalReviewOutput(state: AicrOutputState): boolean {
  return state.problems.length > 0 || state.summaries.length > 0 || Boolean(state.skipReason);
}

function buildContextFollowUpPrompt(
  changedPaths: readonly string[],
  execution: ToolCallExecutionResult,
): string {
  const sections: string[] = [
    "The previous output did not include final review problems, summary, or skip reason.",
    "Use the original task plus the context below to finish the review now.",
    "Return one JSON object only. Prefer problems plus summary; if there are no actionable problems, call aicr.publish_summary with a concise analysis result.",
    "Do not call aicr.fetch_more_context again unless path is exactly one of the changed files listed below.",
    "",
    "Changed files:",
    ...changedPaths.map((path) => `- ${path}`),
  ];

  if (execution.invalidContextRequestCount > 0) {
    sections.push(
      "",
      "Ignored invalid context requests:",
      ...execution.contextResponses
        .filter((response) => response.error)
        .map((response) => `- ${response.error}`),
    );
  }

  if (execution.invalidReviewOutputCount > 0) {
    sections.push(
      "",
      "Ignored invalid review output tool calls:",
      ...execution.invalidReviewOutputs.map((response) => `- ${response.name}: ${response.error}`),
    );
  }

  const validResponses = execution.contextResponses.filter((response) => response.path && response.content !== undefined);
  if (validResponses.length > 0) {
    sections.push("", "Fetched context:");
    for (const response of validResponses) {
      sections.push(
        `\n--- ${response.path} ---`,
        response.content ?? "",
      );
    }
  }

  return sections.join("\n");
}

function buildFallbackReviewSummary(
  reviewEvent: ReviewEvent,
  changedPaths: readonly string[],
): string {
  const target = reviewEvent.headSha ? `${reviewEvent.repoRef}@${reviewEvent.headSha}` : reviewEvent.repoRef;
  return [
    `AICR review completed for ${target}.`,
    `Changed files analyzed: ${changedPaths.length}.`,
    "The model did not return a valid final review payload after a format-repair retry; no actionable problems were published.",
  ].join("\n");
}

function toExtraContextRequest(input: FetchMoreContextInput): ExtraContextRequest {
  return {
    path: input.path,
    reason: input.reason,
    ...(input.range?.start_line !== undefined ? { startLine: input.range.start_line } : {}),
    ...(input.range?.end_line !== undefined ? { endLine: input.range.end_line } : {}),
  };
}

function toReviewProblem(input: ReportProblemInput): ReviewProblem {
  const problem = {
    file: input.file,
    line: input.line,
    ...(input.end_line !== undefined ? { endLine: input.end_line } : {}),
    severity: input.severity,
    category: input.category,
    message: input.message,
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
  };

  return problem.fingerprint ? problem : { ...problem, fingerprint: computeProblemFingerprint(problem) };
}

function pathMatchesDiffFile(problemPath: string, file: ParsedDiff["files"][number]): boolean {
  const normalizedProblemPath = normalizePath(problemPath);
  return [file.newPath, file.oldPath]
    .filter((path): path is string => Boolean(path))
    .some((path) => normalizePath(path) === normalizedProblemPath);
}

function isLineCommentableInDiff(problem: ReviewProblem, diff: ParsedDiff | undefined): boolean | undefined {
  if (!diff) {
    return undefined;
  }

  const matchingFiles = diff.files.filter((file) => pathMatchesDiffFile(problem.file, file));
  if (matchingFiles.length === 0) {
    return false;
  }

  return matchingFiles.some((file) =>
    file.hunks.some((hunk) =>
      hunk.lines.some((line) =>
        (line.kind === "add" || line.kind === "context") && line.newLine === problem.line,
      ),
    ),
  );
}

function publishesProblems(publisher: ReviewOutputPublisher): boolean {
  return publisher.publishesProblems ?? true;
}

function publishProblem(
  publisher: ReviewOutputPublisher,
  problem: ReviewProblem,
): Promise<ReviewDispatchResult> {
  if (!publisher.publishProblem) {
    throw new TypeError("Review output publisher must provide publishProblem.");
  }

  return publisher.publishProblem(problem);
}

function appendDispatchResults(target: DispatchResult[], result: ReviewDispatchResult): void {
  if (Array.isArray(result)) {
    target.push(...(result as readonly DispatchResult[]));
    return;
  }

  target.push(result as DispatchResult);
}

export async function runReviewOrchestration(
  context: ReviewOrchestrationContext,
  options: ServerReviewOrchestrationOptions,
): Promise<ReviewOrchestrationResult> {
  const sourceRoot = options.sourceRootResolver(context.reviewEvent);
  if (!sourceRoot) {
    throw new TypeError("Review orchestration requires a source root.");
  }

  const workspaceRef = {
    id: context.reviewEvent.workspaceId,
    sourceDir: sourceRoot,
  };
  const vcs = options.vcsFactory ? options.vcsFactory(sourceRoot, context) : options.vcs;
  const range = await vcs.listChanges(context.reviewEvent);
  const scopedTree = await vcs.fetchScoped(range, workspaceRef);
  const changedPaths = [
    ...(options.changedPathsResolver?.(context) ?? range.files ?? context.reviewEvent.changedFiles ?? []),
  ];

  if (changedPaths.length === 0 && !options.dryRun) {
    console.info(JSON.stringify({
      level: "info",
      msg: "no changed files after filtering, skipping review",
      triggerName: context.reviewEvent.triggerName,
      workspaceId: context.reviewEvent.workspaceId,
      repoRef: context.reviewEvent.repoRef,
      headSha: context.reviewEvent.headSha,
    }));
    return {
      status: "skipped",
      sourceRoot: scopedTree.rootDir,
      changedFiles: [],
      fetchedFiles: scopedTree.fetchedFiles,
      diffFileCount: 0,
      promptTokenEstimate: 0,
      problemCount: 0,
      summaryCount: 0,
      contextRequestCount: 0,
      dispatchCount: 0,
      skipReason: "no_changed_files",
      model: { providerId: options.model.providerId, modelId: options.model.modelId },
      preparedPrompt: {
        reviewEvent: context.reviewEvent,
        sourceRoot,
        changedPaths: [],
        taskContext: "",
        discovery: { instructions: [], skills: [], droppedRefs: [], conflicts: [] },
        prompt: {
          systemPrompt: "",
          tokenEstimate: 0,
          repoInstructionSummaries: [],
          activeSkillSummaries: [],
          loadedInstructionRefs: [],
          activatedSkillRefs: [],
          droppedInstructionRefs: [],
          conflicts: [],
        },
      },
      outputState: { problems: [], summaries: [], contextRequests: [] },
      dispatchResults: [],
      llmResult: { providerId: options.model.providerId, modelId: options.model.modelId, content: "", raw: null },
      scrubMatches: [],
    };
  }
  let diff: ParsedDiff | undefined;
  if (vcs.diff) {
    try {
      diff = await vcs.diff(
        { ...range, files: changedPaths.length > 0 ? changedPaths : range.files },
        { contextLines: options.diffContextLines ?? 3 },
      );
    } catch {
      diff = undefined;
    }
  }
  const rawTaskContext = options.taskContextBuilder?.(context.reviewEvent, changedPaths, diff) ??
    buildTaskContext(context.reviewEvent, changedPaths, diff);

  let compressed = false;
  let originalTokenEstimate: number | undefined;
  let compressedTokenEstimate: number | undefined;
  let taskContext = rawTaskContext;

  if (diff && options.compression && options.summarizeModel && options.summarizeClient) {
    const preEstimate = estimatePromptTokenCount(rawTaskContext);
    if (shouldTriggerCompression(preEstimate, options.model, options.compression)) {
      const compressionResult = await compressDiff({
        diff,
        promptText: rawTaskContext,
        model: options.model,
        config: options.compression,
        summarizeModel: options.summarizeModel,
        summarizeClient: options.summarizeClient,
      });

      if (compressionResult.compressed) {
        compressed = true;
        originalTokenEstimate = compressionResult.originalTokenEstimate;
        compressedTokenEstimate = compressionResult.compressedTokenEstimate;
        taskContext = [
          buildReviewTaskContext(context.reviewEvent, changedPaths),
          "",
          compressionResult.compactDiff,
          "",
          buildJsonToolContract(),
        ].join("\n");
      }
    }
  }

  const preparedPrompt = await prepareReviewPrompt({
    reviewEvent: context.reviewEvent,
    sourceRoot: scopedTree.rootDir,
    changedPaths,
    baseSystemPrompt: options.baseSystemPrompt,
    taskContext,
    ...(options.operatorOverrides ? { operatorOverrides: options.operatorOverrides } : {}),
    ...(options.memoryHints ? { memoryHints: options.memoryHints } : {}),
    ...(options.maxPromptTokens !== undefined ? { maxPromptTokens: options.maxPromptTokens } : {}),
  });

  const enableScrub = options.scrubSecrets !== false;
  const allScrubMatches: ScrubMatch[] = [];

  const scrubbedPrompt = enableScrub
    ? scrubPromptMessages([{ role: "system", content: preparedPrompt.prompt.systemPrompt }])
    : { messages: [{ role: "system", content: preparedPrompt.prompt.systemPrompt }], matches: [] as ScrubMatch[] };

  if (enableScrub) {
    allScrubMatches.push(...scrubbedPrompt.matches);
  }

  const llmSystemPrompt = (scrubbedPrompt.messages[0] as { role: string; content: string }).content;

  const collector = new AicrOutputCollector();
  const tools = createAicrOutputToolRegistry(collector, async (request) => {
    const result = await vcs.fetchExtraContext(toExtraContextRequest(request), workspaceRef);
    return result.content;
  });
  let completion = await requestReviewCompletion(scopedTree.rootDir, llmSystemPrompt, options);
  const rawModelOutput = completion.llmResult.content;
  const toolExecution = await callAicrTools(rawModelOutput, tools);
  let outputState = collector.snapshot();
  const shouldRepairModelOutput = !hasFinalReviewOutput(outputState) && (
    toolExecution.contextResponses.length > 0 ||
    toolExecution.invalidContextRequestCount > 0 ||
    toolExecution.invalidReviewOutputCount > 0
  );

  if (!hasFinalReviewOutput(outputState) && toolExecution.toolCallCount === 0) {
    const truncatedOutput = rawModelOutput.length > 500
      ? `${rawModelOutput.slice(0, 500)}... (${rawModelOutput.length} chars total)`
      : rawModelOutput;
    console.warn(JSON.stringify({
      level: "warn",
      msg: "model output produced no parseable review payload",
      headSha: context.reviewEvent.headSha,
      toolCallCount: toolExecution.toolCallCount,
      reviewOutputCount: toolExecution.reviewOutputCount,
      outputLength: rawModelOutput.length,
      outputPreview: truncatedOutput,
      ...(completion.agentResult ? {
        agentExitCode: completion.agentResult.exitCode,
        agentDurationMs: completion.agentResult.durationMs,
        agentStderrLength: completion.agentResult.stderr.length,
        agentStderrPreview: completion.agentResult.stderr.length > 200
          ? `${completion.agentResult.stderr.slice(0, 200)}...`
          : completion.agentResult.stderr,
      } : {}),
    }));
    collector.publishSummary({ markdown: buildFallbackReviewSummary(context.reviewEvent, changedPaths) });
    outputState = collector.snapshot();
  }

  if (shouldRepairModelOutput) {
    completion = await requestReviewCompletion(
      scopedTree.rootDir,
      llmSystemPrompt,
      options,
      {
        previousOutput: completion.llmResult.content,
        prompt: buildContextFollowUpPrompt(changedPaths, toolExecution),
      },
    );
    await callAicrTools(completion.llmResult.content, tools);
    outputState = collector.snapshot();
    if (!hasFinalReviewOutput(outputState)) {
      collector.publishSummary({ markdown: buildFallbackReviewSummary(context.reviewEvent, changedPaths) });
      outputState = collector.snapshot();
    }
  }

  const llmResult = completion.llmResult;
  const agentResult = completion.agentResult;
  const dispatchResults: DispatchResult[] = [];
  const outputPublisher = options.outputPublisher ?? options.outputPublisherResolver?.(context);

  if (!options.dryRun && outputPublisher) {
    const resolver = outputPublisher.handlesRendering
      ? undefined
      : options.templateResolver ?? (
          options.channelKind
            ? createTemplateResolver({ channelKind: options.channelKind })
            : undefined
        );
    const mentionChannelKind = options.channelKind as MentionChannelKind | undefined;
    const eventAuthor = context.reviewEvent.author?.username ?? context.reviewEvent.author?.displayName;
    const eventEmail = context.reviewEvent.author?.email;
    const eventDisplayName = context.reviewEvent.author?.displayName;
    const eventCtx: { author?: string; email?: string; displayName?: string; url?: string; title?: string } = {};
    if (eventAuthor !== undefined) {
      eventCtx.author = eventAuthor;
    }
    if (eventEmail !== undefined) {
      eventCtx.email = eventEmail;
    }
    if (eventDisplayName !== undefined) {
      eventCtx.displayName = eventDisplayName;
    }
    if (context.reviewEvent.title !== undefined) {
      eventCtx.title = context.reviewEvent.title;
    }
    if (context.reviewEvent.url !== undefined) {
      eventCtx.url = context.reviewEvent.url;
    }
    const vcsCtx = buildOrchestratorVcsContext(context.reviewEvent);
    const baseTemplateContext: Omit<TemplateContext, "problem" | "problems"> = {
      ...(Object.keys(eventCtx).length > 0 ? { event: eventCtx } : {}),
      target: buildTemplateTargetContext({
        kind: context.reviewEvent.targetKind,
        provider: context.reviewEvent.provider,
        repoRef: context.reviewEvent.repoRef,
        ...(context.reviewEvent.title !== undefined ? { title: context.reviewEvent.title } : {}),
        ...(context.reviewEvent.url !== undefined ? { url: context.reviewEvent.url } : {}),
        ...(context.reviewEvent.baseSha !== undefined ? { baseRevision: context.reviewEvent.baseSha } : {}),
        ...(context.reviewEvent.headSha !== undefined ? { headRevision: context.reviewEvent.headSha } : {}),
        triggerName: context.reviewEvent.triggerName,
        workspaceId: context.reviewEvent.workspaceId,
      }),
      repo: {
        fullName: context.reviewEvent.repoRef,
      },
      ...(mentionChannelKind && options.mentionAuthor !== false
        ? { atMentions: buildAtMentions(
            { ...(context.reviewEvent.author ? { author: context.reviewEvent.author } : {}) },
            mentionChannelKind,
            options.authorResolution,
          ) }
        : {}),
      ...(Object.keys(vcsCtx).length > 0 ? { vcs: vcsCtx } : {}),
    };
    const reviewProblems: ReviewProblem[] = [];
    for (const reportedProblem of outputState.problems) {
      const rawReviewProblem = toReviewProblem(reportedProblem);
      const lineCommentable = isLineCommentableInDiff(rawReviewProblem, diff);
      const reviewProblem: ReviewProblem = lineCommentable === false
        ? { ...rawReviewProblem, lineCommentAllowed: false }
        : rawReviewProblem;
      let renderedMessage: string;
      let renderedSuggestion: string | undefined;
      if (enableScrub) {
        const scrubbedMsg = scrubText(reviewProblem.message);
        const scrubbedSuggestion = reviewProblem.suggestion ? scrubText(reviewProblem.suggestion) : undefined;
        allScrubMatches.push(...scrubbedMsg.matches);
        if (scrubbedSuggestion) {
          allScrubMatches.push(...scrubbedSuggestion.matches);
        }
        renderedMessage = fixAndValidateMarkdown(scrubbedMsg.text);
        renderedSuggestion = scrubbedSuggestion ? fixAndValidateMarkdown(scrubbedSuggestion.text) : undefined;
      } else {
        renderedMessage = fixAndValidateMarkdown(reviewProblem.message);
        renderedSuggestion = reviewProblem.suggestion ? fixAndValidateMarkdown(reviewProblem.suggestion) : undefined;
      }

      if (resolver) {
        const templateCtx: TemplateContext = {
          ...baseTemplateContext,
          problem: toTemplateProblem({
            ...reviewProblem,
            message: renderedMessage,
            ...(renderedSuggestion ? { suggestion: renderedSuggestion } : {}),
          }),
        };
        const renderedMarkdown = fixAndValidateMarkdown(resolver.render("problem", templateCtx));
        const preparedProblem: ReviewProblem = {
          ...reviewProblem,
          message: renderedMessage,
          ...(renderedSuggestion ? { suggestion: renderedSuggestion } : {}),
          renderedMarkdown,
        };
        reviewProblems.push(preparedProblem);
        if (publishesProblems(outputPublisher)) {
          appendDispatchResults(dispatchResults, await publishProblem(outputPublisher, preparedProblem));
        }
        continue;
      }

      const preparedProblem: ReviewProblem = {
        ...reviewProblem,
        message: renderedMessage,
        ...(renderedSuggestion ? { suggestion: renderedSuggestion } : {}),
      };
      reviewProblems.push(preparedProblem);
      if (publishesProblems(outputPublisher)) {
        appendDispatchResults(dispatchResults, await publishProblem(outputPublisher, preparedProblem));
      }
    }

    if (outputPublisher.publishSummary) {
      const suppressNoProblemsSummary = reviewProblems.length === 0
        && outputPublisher.noProblemsAction === "suppress";
      if (!suppressNoProblemsSummary) {
        const summariesToPublish = outputState.summaries.length > 0
          ? outputState.summaries
          : reviewProblems.length > 0 || outputPublisher.publishEmptySummary
            ? [""]
            : [];
        for (const summary of summariesToPublish) {
          let renderedSummary = enableScrub ? fixAndValidateMarkdown(scrubText(summary).text) : fixAndValidateMarkdown(summary);
          if (resolver) {
            const summaryCtx: TemplateContext = {
              ...baseTemplateContext,
              summary: renderedSummary,
              problems: reviewProblems.map((problem) =>
                toTemplateProblem({
                  ...problem,
                  message: problem.message,
                  ...(problem.suggestion ? { suggestion: problem.suggestion } : {}),
                }),
              ),
            };
            renderedSummary = fixAndValidateMarkdown(resolver.render("summary", summaryCtx));
          }
          appendDispatchResults(dispatchResults, await outputPublisher.publishSummary(renderedSummary, reviewProblems));
        }
      }
    }
  }

  {
    const llmContentPreview = llmResult.content.length > 2000
      ? `${llmResult.content.slice(0, 2000)}... (${llmResult.content.length} chars total)`
      : llmResult.content;
    console.info(JSON.stringify({
      level: "info",
      msg: "review model output",
      headSha: context.reviewEvent.headSha,
      triggerName: context.reviewEvent.triggerName,
      workspaceId: context.reviewEvent.workspaceId,
      modelProvider: llmResult.providerId,
      modelId: llmResult.modelId,
      ...(agentResult ? {
        agentKind: "kilo",
        agentExitCode: agentResult.exitCode,
        agentDurationMs: agentResult.durationMs,
      } : {}),
      problemCount: outputState.problems.length,
      summaryCount: outputState.summaries.length,
      llmOutput: llmContentPreview,
      ...(context.reviewEvent.branch ? { branch: context.reviewEvent.branch } : {}),
      ...(context.reviewEvent.author?.username ? { author: context.reviewEvent.author.username } : {}),
      ...(context.reviewEvent.author?.email ? { authorEmail: context.reviewEvent.author.email } : {}),
      ...(outputState.problems.length > 0 ? {
        problems: outputState.problems.map((p) => ({
          file: p.file,
          line: p.line,
          severity: p.severity,
          message: p.message.length > 200 ? `${p.message.slice(0, 200)}...` : p.message,
        })),
      } : {}),
      ...(outputState.summaries.length > 0 ? {
        summaries: outputState.summaries.map((s) =>
          s.length > 500 ? `${s.slice(0, 500)}...` : s,
        ),
      } : {}),
    }));
  }

  const implicitSkipReason = !options.dryRun && !outputState.skipReason && dispatchResults.length === 0
    ? outputState.problems.length > 0 && !outputPublisher
      ? "no_output_publisher"
      : outputState.problems.length === 0 && outputPublisher?.noProblemsAction === "suppress"
        ? "no_problems_suppressed"
        : "no_dispatchable_problems"
    : undefined;
  const skipReason = outputState.skipReason ?? implicitSkipReason;
  const status = skipReason
    ? "skipped"
    : dispatchResults.length > 0
      ? "published"
      : options.dryRun
        ? "dry_run"
        : "published";

  return {
    status,
    sourceRoot: scopedTree.rootDir,
    changedFiles: changedPaths,
    fetchedFiles: scopedTree.fetchedFiles,
    diffFileCount: diff?.files.length ?? 0,
    promptTokenEstimate: preparedPrompt.prompt.tokenEstimate,
    problemCount: outputState.problems.length,
    summaryCount: outputState.summaries.length,
    contextRequestCount: outputState.contextRequests.length,
    dispatchCount: dispatchResults.length,
    ...(skipReason ? { skipReason } : {}),
    model: {
      providerId: llmResult.providerId,
      modelId: llmResult.modelId,
    },
    preparedPrompt,
    outputState,
    dispatchResults,
    llmResult,
    ...(agentResult ? { agentResult } : {}),
    scrubMatches: allScrubMatches,
    ...(compressed ? { compressed } : {}),
    ...(originalTokenEstimate !== undefined ? { originalTokenEstimate } : {}),
    ...(compressedTokenEstimate !== undefined ? { compressedTokenEstimate } : {}),
  };
}

function buildOrchestratorVcsContext(reviewEvent: ReviewEvent): { branch?: string; depot?: string; workspace?: string; repositoryPath?: string } {
  const result: { branch?: string; depot?: string; workspace?: string; repositoryPath?: string } = {};

  if (reviewEvent.branch !== undefined) {
    result.branch = reviewEvent.branch;
  }
  if (reviewEvent.depotPath !== undefined) {
    result.depot = reviewEvent.depotPath;
  }
  if (reviewEvent.p4Workspace !== undefined) {
    result.workspace = reviewEvent.p4Workspace;
  }
  if (reviewEvent.repoRef !== undefined) {
    result.repositoryPath = reviewEvent.repoRef;
  }

  return result;
}

export function summarizeReviewOrchestrationForWebhook(
  result: ReviewOrchestrationResult,
): ReviewOrchestrationWebhookSummary {
  return {
    status: result.status,
    changedFileCount: result.changedFiles.length,
    fetchedFileCount: result.fetchedFiles.length,
    diffFileCount: result.diffFileCount,
    promptTokenEstimate: result.promptTokenEstimate,
    problemCount: result.problemCount,
    summaryCount: result.summaryCount,
    contextRequestCount: result.contextRequestCount,
    dispatchCount: result.dispatchCount,
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    ...(result.compressed ? { compressed: result.compressed } : {}),
    ...(result.originalTokenEstimate !== undefined ? { originalTokenEstimate: result.originalTokenEstimate } : {}),
    ...(result.compressedTokenEstimate !== undefined ? { compressedTokenEstimate: result.compressedTokenEstimate } : {}),
    model: result.model,
  };
}

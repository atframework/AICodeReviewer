import { basename, dirname, join } from "node:path";
import { readFile, rm } from "node:fs/promises";

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
import { materializeRuntimeBundle } from "@aicr/agents";
import type { RuntimeBundleInstruction, RuntimeBundleMcpServer, RuntimeBundleMcpTool, RuntimeBundleSkill } from "@aicr/agents";
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
  type PublishSummaryInput,
  type ReportProblemInput,
  type TryBlameInput,
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
import type { AttributionRequest, ChangeRange, ExtraContextRequest, ParsedDiff, VcsAdapter } from "@aicr/vcs";

export interface DiffCapableVcsAdapter extends VcsAdapter {
  diff?(range: ChangeRange, options?: { readonly contextLines?: number }): Promise<ParsedDiff>;
}

export type ReviewDispatchResult = DispatchResult | readonly DispatchResult[];

export interface ReviewOutputPublisher {
  readonly publishesProblems?: boolean;
  readonly handlesRendering?: boolean;
  readonly publishEmptySummary?: boolean;
  readonly noProblemsAction?: "publish" | "suppress" | "publish_if_summary";
  publishProblem?(problem: ReviewProblem): Promise<ReviewDispatchResult>;
  publishSummary?(summary: string, problems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<ReviewDispatchResult>;
}

export interface ReviewSummaryPublishOptions {
	readonly bypassNoProblemsPolicy?: boolean;
	readonly title?: string;
	readonly reviewedFiles?: readonly string[];
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
  readonly baseSystemPromptResolver?: (workspaceId: string) => Promise<string | undefined> | string | undefined;
  readonly forceSkillsResolver?: (workspaceId: string) => readonly string[] | undefined;
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
  readonly memoryHintsResolver?: (workspaceId: string) => Promise<readonly string[]> | readonly string[];
  readonly postRunCallback?: (result: ReviewOrchestrationResult, context: ReviewOrchestrationContext) => Promise<void>;
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
  readonly outputLanguage?: string;
  readonly logThinking?: boolean;
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

interface ParseToolCallOptions {
  readonly allowNaturalLanguageSummary?: boolean;
}

interface ReviewCompletionFollowUp {
  readonly previousOutput: string;
  readonly prompt: string;
}

interface ReviewCompletionResult {
  readonly llmResult: ChatCompletionResult;
  readonly agentResult?: SandboxSpawnResult;
  readonly mcpState?: AicrOutputState;
  readonly toolCallEvents?: readonly ToolCallEnvelope[];
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

  const lines: string[] = [
    "Diff:",
    "Legend: +N lines are current/new code, plain N lines are current context, and -N lines are deleted old code that is not present after the change. Do not report problems that exist only on -N deleted lines.",
  ];
  for (const file of diff.files) {
    lines.push(`- ${file.status}: ${formatFilePath(file)}`);
    for (const hunk of file.hunks) {
      const section = hunk.section ? ` ${hunk.section}` : "";
      lines.push(`  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${section}`);
      for (const line of hunk.lines) {
        if (line.kind === "add") {
          lines.push(`  +${line.newLine ?? "?"}: ${line.content}`);
        } else if (line.kind === "delete") {
          lines.push(`  -${line.oldLine ?? "?"}: ${line.content}  [deleted old code; not current]`);
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
    "Before reporting any problem, read the full changed file (not just the diff hunk) and any interface, type definition, or caller/callee needed to confirm the issue. Use aicr.fetch_more_context (omit range for full file) or shell inspection (rg, bat) to read surrounding code.",
    "When the diff is unavailable or insufficient, call aicr.fetch_more_context for the changed file; omit range to fetch the full file.",
    "You may call aicr.fetch_more_context for a narrowly related repository file outside the change when it is required to understand an API contract, caller/callee, type definition, or configuration that directly affects a changed line.",
    "Use aicr.try_blame only when VCS-verified line attribution is needed; it returns best-effort blame/annotate metadata and never returns source content. Do not guess authors from names, summaries, or diff text.",
    "When running inside an agent sandbox, inspect already materialized files with read-only shell commands (rg, fd, bat --paging=never --style=plain, jq, yq) before concluding that source code is inaccessible.",
    "If a needed file is not materialized or the MCP tool returns a pending/empty context response, stop making a final no-problem claim; request the concrete file through aicr.fetch_more_context so AICR can pull it from VCS and rerun the final pass.",
    "Never ask the user to provide diff or source context; request it through aicr.fetch_more_context with a concrete path and reason.",
    "Do not speculate. If you have not read the surrounding code, fetch it first. Every reported problem must be backed by code you have actually read.",
    "If there are no actionable problems, or the changed file has no reviewable code, emit aicr.skip with a concise reason such as lgtm or no_reviewable_code.",
    "If you found any actionable problem, emit one aicr.report_problem per problem; never mention found-problem counts only in a summary.",
    "When useful, add a short title to aicr.publish_summary input.title so summary channels can render a concise heading.",
    "Preferred shape:",
    '{"toolCalls":[{"name":"aicr.fetch_more_context","input":{"path":"src/changed-file.ts","reason":"Need the full file to validate control flow around the changed function."}}]}',
    '{"toolCalls":[{"name":"aicr.try_blame","input":{"path":"src/changed-file.ts","range":{"start_line":42,"end_line":42},"reason":"Need VCS-verified attribution for the changed line before deciding ownership-sensitive follow-up."}}]}',
    '{"toolCalls":[{"name":"aicr.report_problem","input":{"file":"src/file.ts","line":1,"severity":"medium","category":"correctness","message":"..."}}],"notes":"optional"}',
    '{"toolCalls":[{"name":"aicr.skip","input":{"reason":"lgtm"}}]}',
    "Alternatively use problems/summary/skipReason fields; AICR will translate them into tool calls.",
  ].join("\n");
}

function buildTaskContext(
  reviewEvent: ReviewEvent,
  changedPaths: readonly string[],
  diff: ParsedDiff | undefined,
  outputLanguage?: string,
): string {
  const lines = [
    buildReviewTaskContext(reviewEvent, changedPaths),
    "",
    formatParsedDiffForPrompt(diff),
    "",
    buildJsonToolContract(),
  ];
  if (outputLanguage && outputLanguage !== "en") {
    lines.push("", `Output language: ${outputLanguage}`);
  }
  return lines.join("\n");
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

interface AgentBundleContext {
  instructions?: readonly RuntimeBundleInstruction[];
  skills?: readonly RuntimeBundleSkill[];
  mcpTools?: readonly RuntimeBundleMcpTool[];
  mcpServers?: readonly RuntimeBundleMcpServer[];
  runId?: string;
}

interface KiloStreamExtractionResult {
  readonly content: string;
  readonly toolCallEvents: readonly ToolCallEnvelope[];
  readonly eventCounts: Readonly<Record<string, number>>;
}

function extractKiloJsonStreamContent(stdout: string): KiloStreamExtractionResult {
  const textParts: string[] = [];
  const toolCallEvents: ToolCallEnvelope[] = [];
  const eventCounts: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const eventType = typeof event.type === "string" ? event.type : "unknown";
      eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;
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
      } else if (
        (event.type === "tool_call" || event.type === "tool_use")
        && typeof event.name === "string"
        && event.input !== undefined
      ) {
        try {
          toolCallEvents.push({ name: normalizeToolName(event.name), input: event.input });
        } catch {
          console.warn(JSON.stringify({
            level: "warn",
            msg: "kilo stream tool call has unsupported name",
            toolName: event.name,
          }));
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Kilo agent error:")) {
        throw error;
      }
    }
  }
  return {
    content: textParts.length > 0 ? textParts.join("\n") : stdout,
    toolCallEvents,
    eventCounts,
  };
}

async function runAgentReview(
  sourceRoot: string,
  task: string,
  options: ServerReviewOrchestrationOptions,
  bundleContext?: AgentBundleContext,
): Promise<ReviewCompletionResult & { readonly agentResult: SandboxSpawnResult }> {
  const sandbox = options.sandbox;
  const agentAdapter = options.agentAdapter;
  if (!sandbox || !agentAdapter) {
    throw new TypeError("Agent review requires both sandbox and agentAdapter options.");
  }

  const dirs = deriveWorkspaceRuntimeDirs(sourceRoot);
  let agentResult: SandboxSpawnResult | undefined;
  let hostAgentDir: string | undefined;

  try {
    const materializedFs = await sandbox.materializeFs({
      sourceDir: sourceRoot,
      agentDir: dirs.agentDir,
      tmpDir: dirs.tmpDir,
    });
    hostAgentDir = materializedFs.agentDir;
    const bundle = await materializeRuntimeBundle({
      adapter: agentAdapter,
      model: options.model,
      workingDir: materializedFs.agentDir,
      ...(bundleContext?.instructions ? { instructions: bundleContext.instructions } : {}),
      ...(bundleContext?.skills ? { skills: bundleContext.skills } : {}),
      ...(bundleContext?.mcpTools ? { mcpTools: bundleContext.mcpTools } : {}),
      ...(bundleContext?.mcpServers ? { mcpServers: bundleContext.mcpServers } : {}),
      ...(bundleContext?.runId ? { runId: bundleContext.runId } : {}),
    });
    const command = agentAdapter.buildCommand(task, {
      workingDir: agentWorkingDirForSandbox(sandbox, bundle.workingDir),
      ...(options.agentTimeoutMs !== undefined ? { timeoutMs: options.agentTimeoutMs } : {}),
      model: options.model,
      autoApprove: true,
      task,
    });
    const env = resolveEnvPlaceholders(bundle.envVars);

    await rm(join(materializedFs.agentDir, ".aicr-output-state.json"), { force: true });

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
  let content: string;
  let kiloToolCalls: readonly ToolCallEnvelope[] = [];
  if (isKiloAgent) {
    const extraction = extractKiloJsonStreamContent(rawStdout);
    content = extraction.content;
    kiloToolCalls = extraction.toolCallEvents;
    if (Object.keys(extraction.eventCounts).length > 0 || kiloToolCalls.length > 0) {
      if (options.logThinking !== false) {
      console.info(JSON.stringify({
        level: "info",
        msg: "kilo agent stream stats",
        eventCounts: extraction.eventCounts,
        streamToolCallCount: kiloToolCalls.length,
        stdoutLength: rawStdout.length,
        extractedContentLength: content.length,
      }));
      }
    }
  } else {
    content = rawStdout;
  }

  let mcpState: AicrOutputState | undefined;
  if (hostAgentDir) {
    const statePath = join(hostAgentDir, ".aicr-output-state.json");
    try {
      const stateContent = await readFile(statePath, "utf8");
      const parsed = JSON.parse(stateContent) as unknown;
      if (isPlainObject(parsed)) {
        mcpState = {
          problems: Array.isArray(parsed.problems) ? parsed.problems : [],
          summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
          contextRequests: Array.isArray(parsed.contextRequests) ? parsed.contextRequests : [],
          ...(Array.isArray(parsed.attributionRequests) ? { attributionRequests: parsed.attributionRequests } : {}),
          ...(typeof parsed.skipReason === "string" ? { skipReason: parsed.skipReason } : {}),
        };
        if (options.logThinking !== false) {
        console.info(JSON.stringify({
          level: "info",
          msg: "read MCP output state from agent workspace",
          problemCount: mcpState.problems.length,
          summaryCount: mcpState.summaries.length,
          contextRequestCount: mcpState.contextRequests.length,
          hasSkipReason: mcpState.skipReason !== undefined,
        }));
        }
      }
    } catch {
      // State file does not exist or is invalid; agent may not have called MCP tools.
    }
  }

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
    ...(mcpState ? { mcpState } : {}),
    ...(kiloToolCalls.length > 0 ? { toolCallEvents: kiloToolCalls } : {}),
  };
}

async function requestReviewCompletion(
  sourceRoot: string,
  systemPrompt: string,
  options: ServerReviewOrchestrationOptions,
  followUp?: ReviewCompletionFollowUp,
  bundleContext?: AgentBundleContext,
): Promise<ReviewCompletionResult> {
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
    return runAgentReview(sourceRoot, task, options, bundleContext);
  }

  return requestDirectLlmCompletion(systemPrompt, options, followUp);
}

async function requestDirectLlmCompletion(
  systemPrompt: string,
  options: ServerReviewOrchestrationOptions,
  followUp?: ReviewCompletionFollowUp,
): Promise<{ readonly llmResult: ChatCompletionResult }> {
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

const KILO_MCP_TOOL_NAME_RE = /^(?:[a-z0-9_-]+)_aicr[_]([a-z_]+)$/iu;
const KILO_MCP_TOOL_MAP: Readonly<Record<string, AicrOutputToolName>> = {
  report_problem: "aicr.report_problem",
  publish_summary: "aicr.publish_summary",
  skip: "aicr.skip",
  fetch_more_context: "aicr.fetch_more_context",
  try_blame: "aicr.try_blame",
};

function normalizeToolName(value: unknown): AicrOutputToolName {
  if (
    value === "aicr.report_problem" ||
    value === "aicr.publish_summary" ||
    value === "aicr.skip" ||
    value === "aicr.fetch_more_context" ||
    value === "aicr.try_blame"
  ) {
    return value;
  }

  if (typeof value === "string") {
    const kiloMatch = KILO_MCP_TOOL_NAME_RE.exec(value);
    if (kiloMatch) {
      const mapped = KILO_MCP_TOOL_MAP[kiloMatch[1]!.toLowerCase()];
      if (mapped) {
        return mapped;
      }
    }
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

function stripXmlToolCalls(content: string): string {
  return content
    .replace(/<tool_call\s+name\s*=\s*"[^"]+"\s*>[\s\S]*?<\/tool_call>/gu, "")
    .replace(/<tool_call\s+name\s*=\s*"[^"]+"\s*\/>/gu, "");
}

function structuredPayloadToToolCalls(payload: Record<string, unknown>): {
  readonly calls: readonly ToolCallEnvelope[];
  readonly hasKnownField: boolean;
} {
  const toolCalls = (payload as { readonly toolCalls?: unknown }).toolCalls;
  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls)) {
      throw new TypeError("toolCalls must be an array when provided.");
    }

    return {
      hasKnownField: true,
      calls: toolCalls.map((entry) => {
        if (!isPlainObject(entry)) {
          throw new TypeError("toolCalls entries must be objects.");
        }

        return {
          name: normalizeToolName(entry.name),
          input: entry.input ?? {},
        };
      }),
    };
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
    calls.push({
      name: "aicr.publish_summary",
      input: {
        markdown: payload.summary.markdown,
        ...("title" in payload.summary ? { title: payload.summary.title } : {}),
      },
    });
  }

  if (typeof payload.skipReason === "string" && payload.skipReason.trim()) {
    calls.push({ name: "aicr.skip", input: { reason: payload.skipReason } });
  }

  return {
    calls,
    hasKnownField: hasProblemsField || "summary" in payload || "skipReason" in payload,
  };
}

function parseToolCalls(content: string, options: ParseToolCallOptions = {}): ToolCallEnvelope[] {
  const allowNaturalLanguageSummary = options.allowNaturalLanguageSummary ?? true;
  const toolContent = stripReasoningBlocks(content);
  const xmlCalls = parseXmlToolCalls(toolContent) ?? [];
  const jsonCandidateContent = xmlCalls.length > 0 ? stripXmlToolCalls(toolContent) : toolContent;

  const payload = extractJsonPayload(jsonCandidateContent);
  if (payload === null || !isPlainObject(payload)) {
    if (xmlCalls.length > 0) {
      return xmlCalls;
    }

    if (allowNaturalLanguageSummary) {
      // Direct LLM returned natural language — treat as a summary so the review is not lost.
      // Agent CLI stdout is stricter and disables this fallback because stdout often contains
      // transient reasoning rather than the final AICR output contract.
      const text = toolContent.trim();
      if (text.length > 0) {
        return [{ name: "aicr.publish_summary", input: { markdown: text } }];
      }
    }

    return [];
  }

  const structured = structuredPayloadToToolCalls(payload);
  if (structured.calls.length > 0 || structured.hasKnownField || xmlCalls.length > 0) {
    return [...xmlCalls, ...structured.calls];
  }

  if (allowNaturalLanguageSummary) {
    const text = toolContent.trim();
    if (text.length > 0) {
      return [{ name: "aicr.publish_summary", input: { markdown: text } }];
    }
  }

  return [];
}

function isContextToolName(name: AicrOutputToolName): boolean {
  return name === "aicr.fetch_more_context" || name === "aicr.try_blame";
}

function emptyToolExecutionResult(): ToolCallExecutionResult {
  return {
    toolCallCount: 0,
    reviewOutputCount: 0,
    contextResponses: [],
    invalidContextRequestCount: 0,
    invalidReviewOutputCount: 0,
    invalidReviewOutputs: [],
  };
}

function mergeToolExecutionResults(
  ...results: readonly ToolCallExecutionResult[]
): ToolCallExecutionResult {
  return results.reduce<ToolCallExecutionResult>(
    (merged, current) => ({
      toolCallCount: merged.toolCallCount + current.toolCallCount,
      reviewOutputCount: merged.reviewOutputCount + current.reviewOutputCount,
      contextResponses: [...merged.contextResponses, ...current.contextResponses],
      invalidContextRequestCount: merged.invalidContextRequestCount + current.invalidContextRequestCount,
      invalidReviewOutputCount: merged.invalidReviewOutputCount + current.invalidReviewOutputCount,
      invalidReviewOutputs: [...merged.invalidReviewOutputs, ...current.invalidReviewOutputs],
    }),
    emptyToolExecutionResult(),
  );
}

async function executeAicrToolCalls(
  toolCalls: readonly ToolCallEnvelope[],
  tools: readonly AicrOutputToolDefinition[],
): Promise<ToolCallExecutionResult> {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  let toolCallCount = 0;
  let reviewOutputCount = 0;
  let invalidContextRequestCount = 0;
  let invalidReviewOutputCount = 0;
  const contextResponses: ContextToolResponse[] = [];
  const invalidReviewOutputs: InvalidToolCallResponse[] = [];
  for (const toolCall of toolCalls) {
    toolCallCount += 1;
    const tool = toolMap.get(toolCall.name);
    if (!tool) {
      throw new TypeError(`AICR tool ${toolCall.name} is not registered.`);
    }

    try {
      const result = await tool.call(toolCall.input);
      if (isContextToolName(toolCall.name)) {
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
      if (isContextToolName(toolCall.name)) {
        invalidContextRequestCount += 1;
        contextResponses.push({ error: errorMessage });
        console.warn(JSON.stringify({
          level: "warn",
          msg: toolCall.name === "aicr.fetch_more_context"
            ? "ignored invalid fetch_more_context tool call"
            : "ignored invalid try_blame tool call",
          toolName: toolCall.name,
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

async function callAicrTools(
  content: string,
  tools: readonly AicrOutputToolDefinition[],
  options: ParseToolCallOptions = {},
): Promise<ToolCallExecutionResult> {
  return executeAicrToolCalls(parseToolCalls(content, options), tools);
}

function contextRequestsToToolCalls(requests: readonly FetchMoreContextInput[]): readonly ToolCallEnvelope[] {
  return requests.map((request) => ({ name: "aicr.fetch_more_context", input: request }));
}

function attributionRequestsToToolCalls(requests: readonly TryBlameInput[]): readonly ToolCallEnvelope[] {
  return requests.map((request) => ({ name: "aicr.try_blame", input: request }));
}

function replayMcpReviewOutputs(state: AicrOutputState, collector: AicrOutputCollector): void {
  for (const problem of state.problems) {
    try {
      collector.reportProblem(problem);
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "MCP state problem rejected by collector",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  for (const summary of state.summaries) {
    try {
      collector.publishSummary(summary);
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "MCP state summary rejected by collector",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (state.skipReason) {
    try {
      collector.skip({ reason: state.skipReason });
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "MCP state skip rejected by collector",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

async function collectCompletionOutputs(
  completion: ReviewCompletionResult,
  tools: readonly AicrOutputToolDefinition[],
  collector: AicrOutputCollector,
  options: ParseToolCallOptions = {},
): Promise<ToolCallExecutionResult> {
  const executions: ToolCallExecutionResult[] = [];

  if (completion.mcpState) {
    replayMcpReviewOutputs(completion.mcpState, collector);
    const attributionRequests = completion.mcpState.attributionRequests ?? [];
    if (completion.mcpState.contextRequests.length > 0 || attributionRequests.length > 0) {
      executions.push(
        await executeAicrToolCalls(
          [
            ...contextRequestsToToolCalls(completion.mcpState.contextRequests),
            ...attributionRequestsToToolCalls(attributionRequests),
          ],
          tools,
        ),
      );
    }
  } else if (completion.toolCallEvents && completion.toolCallEvents.length > 0) {
    executions.push(await executeAicrToolCalls(completion.toolCallEvents, tools));
  }

  executions.push(await callAicrTools(completion.llmResult.content, tools, options));
  return mergeToolExecutionResults(...executions);
}

function hasFinalReviewOutput(state: AicrOutputState): boolean {
  return state.problems.length > 0 || state.summaries.length > 0 || Boolean(state.skipReason);
}

const NO_ACTIONABLE_PROBLEM_RE = /(?:no\s+(?:actionable\s+)?(?:issues?|problems?|findings?)\s+(?:found|detected)|no\s+(?:actionable\s+)?(?:issues?|problems?|findings?)|未发现(?:明显|可执行|可操作|阻塞|严重)?(?:的)?(?:问题|缺陷|风险)|没有发现(?:明显|可执行|可操作|阻塞|严重)?(?:的)?(?:问题|缺陷|风险)|暂无(?:问题|缺陷|风险)|无(?:明显|可执行|可操作|阻塞|严重)?(?:的)?(?:问题|缺陷|风险)|lgtm)/iu;
const ACTIONABLE_PROBLEM_CLAIM_RE = /(?:(?:发现|發現)\s*(?:了\s*)?[1-9]\d*\s*(?:个|個|项|項)?\s*(?:问题|問題|缺陷|风险|風險)|(?:存在|检出|檢出)\s*(?:明显|可执行|阻塞|严重|高风险)?\s*(?:问题|問題|缺陷|风险|風險)|found\s+[1-9]\d*\s+(?:issues?|problems?)|[1-9]\d*\s+(?:issues?|problems?)\s+(?:found|detected)|(?:critical|high[-\s]?risk|blocking)\s+(?:issue|problem)|(?:严重|高风险|阻塞)\s*(?:问题|問題|缺陷|风险|風險))/iu;
const MISSING_CONTEXT_REQUEST_RE = /(?:need(?:s|ed)?\s+(?:the\s+)?(?:diff|source|context)|more\s+context|provide\s+(?:the\s+)?diff|fetch_more_context|(?:cannot|can't|unable\s+to)\s+(?:access|read|inspect|verify).*(?:full\s+)?(?:repo|repository|source|code|context)|无法(?:获取|访问|读取|查看|验证).*(?:diff|上下文|变更内容|源文件|源代码|源码|完整仓库|仓库代码|完整代码|资源)|缺少.*(?:diff|上下文|变更内容|源文件|源代码|源码|完整仓库|仓库代码|完整代码|资源)|需要.*(?:diff|上下文|变更内容|源文件|源代码|源码|完整仓库|仓库代码|完整代码|资源)|请提供.*(?:diff|上下文|变更内容|源文件|源代码|源码|完整仓库|仓库代码|完整代码|资源)|获取.*(?:diff|上下文|变更内容|源文件|源代码|源码|完整仓库|仓库代码|完整代码|资源))/iu;
const NO_REVIEWABLE_CODE_RE = /(?:no\s+(?:reviewable\s+)?(?:code|changes?)\s+to\s+review|nothing\s+to\s+review|empty\s+file|file\s+is\s+empty|文件为空|空文件|内容为空|无代码可(?:审查|评审)|无(?:可|需|需要)?(?:审查|评审)(?:的)?(?:代码|内容)|没有(?:可|需要)?(?:审查|评审)(?:的)?(?:代码|内容))/iu;

type NoActionableSkipReason = "lgtm" | "no_reviewable_code";

function summaryClaimsActionableProblems(markdown: string): boolean {
  if (NO_ACTIONABLE_PROBLEM_RE.test(markdown)) {
    return false;
  }

  return ACTIONABLE_PROBLEM_CLAIM_RE.test(markdown);
}

function summaryOnlyClaimsActionableProblems(state: AicrOutputState): boolean {
  return state.problems.length === 0
    && state.summaries.some((summary) => summaryClaimsActionableProblems(summary.markdown));
}

function outputRequestsMissingContext(state: AicrOutputState): boolean {
  if (state.problems.length > 0) {
    return false;
  }

  return (state.skipReason !== undefined && MISSING_CONTEXT_REQUEST_RE.test(state.skipReason))
    || state.summaries.some((summary) => MISSING_CONTEXT_REQUEST_RE.test(summary.markdown));
}

function classifyUnstructuredNoActionableOutput(content: string): NoActionableSkipReason | undefined {
  const text = stripReasoningBlocks(content).trim();
  if (!text || MISSING_CONTEXT_REQUEST_RE.test(text)) {
    return undefined;
  }

  const noReviewableCode = NO_REVIEWABLE_CODE_RE.test(text);
  const noActionableProblems = NO_ACTIONABLE_PROBLEM_RE.test(text);
  const claimsProblems = ACTIONABLE_PROBLEM_CLAIM_RE.test(text);
  if (claimsProblems) {
    return undefined;
  }

  if (noReviewableCode) {
    return "no_reviewable_code";
  }

  return noActionableProblems ? "lgtm" : undefined;
}

function classifyNoActionableReviewResult(
  state: AicrOutputState,
  rawContent: string,
): NoActionableSkipReason | undefined {
  if (state.problems.length > 0 || state.skipReason) {
    return undefined;
  }

  const candidates = state.summaries.length > 0
    ? state.summaries.map((summary) => summary.markdown)
    : [rawContent];
  let sawNoReviewableCode = false;
  for (const candidate of candidates) {
    const reason = classifyUnstructuredNoActionableOutput(candidate);
    if (!reason) {
      return undefined;
    }
    sawNoReviewableCode ||= reason === "no_reviewable_code";
  }

  return sawNoReviewableCode ? "no_reviewable_code" : "lgtm";
}

function buildContextFollowUpPrompt(
  changedPaths: readonly string[],
  execution: ToolCallExecutionResult,
  options: { readonly summaryOnlyClaimsProblems?: boolean; readonly missingContextRequest?: boolean } = {},
): string {
  const sections: string[] = [
    options.summaryOnlyClaimsProblems
      ? "The previous output claimed actionable problems in a summary but did not emit any aicr.report_problem records."
      : options.missingContextRequest
        ? "The previous output asked for diff/source context instead of using the available AICR context tools."
        : "The previous output did not include parseable final review problems, summary, or skip reason.",
    "Use the original task plus the context below to finish the review now.",
    "Return one JSON object only. Prefer problems plus summary; if there are no actionable problems or no reviewable code, call aicr.skip with a concise reason such as lgtm or no_reviewable_code.",
    "If you found any actionable problem, emit one aicr.report_problem entry per problem with file and line; do not mention problem counts only in a summary.",
    "Use aicr.fetch_more_context only for a concrete changed file or a narrowly related repository file; never ask the user to provide diff or source context.",
    "Use aicr.try_blame only for VCS-verified line attribution; do not guess authors from prose, usernames, or commit summaries.",
    "",
    "Changed files:",
    ...changedPaths.map((path) => `- ${path}`),
  ];

  if (execution.contextResponses.length > 0) {
    sections.push(
      "",
      "AICR fetched the requested context below. Any previous summary or skip output emitted before this context was treated as provisional.",
    );
  }

  if (execution.toolCallCount === 0) {
    sections.push(
      "",
      "The previous stdout was free-form text rather than the AICR tool contract. Do not repeat interim reasoning such as context-gathering notes; convert the final findings into JSON toolCalls.",
    );
  }

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

function toExtraContextRequest(input: FetchMoreContextInput, revision: string | undefined): ExtraContextRequest {
  return {
    path: input.path,
    reason: input.reason,
    ...(input.range?.start_line !== undefined ? { startLine: input.range.start_line } : {}),
    ...(input.range?.end_line !== undefined ? { endLine: input.range.end_line } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };
}

function toAttributionRequest(input: TryBlameInput, revision: string | undefined): AttributionRequest {
  return {
    path: input.path,
    reason: input.reason,
    ...(input.range?.start_line !== undefined ? { startLine: input.range.start_line } : {}),
    ...(input.range?.end_line !== undefined ? { endLine: input.range.end_line } : {}),
    ...(revision !== undefined ? { revision } : {}),
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

const CODE_REFERENCE_CONTEXT_LINES = 2;
const CODE_REFERENCE_MAX_LINES = 12;
const CODE_REFERENCE_MAX_CHARS = 2000;

function inferCodeFenceLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "ts";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "js";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (lower.endsWith(".py")) return "py";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rs";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".c")) return "c";
  if (lower.endsWith(".cc") || lower.endsWith(".cpp") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".hh") || lower.endsWith(".hxx")) return "cpp";
  if (lower.endsWith(".h")) return "c";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  if (lower.endsWith(".ps1")) return "powershell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".sql")) return "sql";
  return "text";
}

function buildCodeReferenceSnippet(problem: ReviewProblem, diff: ParsedDiff | undefined): string | undefined {
  if (!diff) {
    return undefined;
  }

  const matchingFiles = diff.files.filter((file) => pathMatchesDiffFile(problem.file, file));
  const targetStart = Math.min(problem.line, problem.endLine ?? problem.line);
  const targetEnd = Math.max(problem.line, problem.endLine ?? problem.line);
  const windowStart = Math.max(1, targetStart - CODE_REFERENCE_CONTEXT_LINES);
  const windowEnd = targetEnd + CODE_REFERENCE_CONTEXT_LINES;

  for (const file of matchingFiles) {
    for (const hunk of file.hunks) {
      const sourceLines = hunk.lines.filter((line) => line.kind !== "delete" && line.newLine !== undefined);
      const overlapsTarget = sourceLines.some((line) => line.newLine! >= targetStart && line.newLine! <= targetEnd);
      if (!overlapsTarget) {
        continue;
      }

      const selectedLines = sourceLines
        .filter((line) => line.newLine! >= windowStart && line.newLine! <= windowEnd)
        .slice(0, CODE_REFERENCE_MAX_LINES)
        .map((line) => line.content);
      const snippet = selectedLines.join("\n").replace(/\s+$/u, "");
      if (!snippet) {
        continue;
      }

      return snippet.length > CODE_REFERENCE_MAX_CHARS
        ? `${snippet.slice(0, CODE_REFERENCE_MAX_CHARS).replace(/\s+$/u, "")}\n...`
        : snippet;
    }
  }

  return undefined;
}

function withCodeReference(problem: ReviewProblem, diff: ParsedDiff | undefined): ReviewProblem {
  if (problem.codeSnippet) {
    return problem;
  }

  const codeSnippet = buildCodeReferenceSnippet(problem, diff);
  return codeSnippet
    ? { ...problem, codeSnippet, codeLanguage: inferCodeFenceLanguage(problem.file) }
    : problem;
}

function withRenderedProblemContent(
  problem: ReviewProblem,
  message: string,
  suggestion: string | undefined,
  codeSnippet: string | undefined,
): ReviewProblem {
  return {
    file: problem.file,
    line: problem.line,
    ...(problem.endLine !== undefined ? { endLine: problem.endLine } : {}),
    ...(problem.lineCommentAllowed !== undefined ? { lineCommentAllowed: problem.lineCommentAllowed } : {}),
    severity: problem.severity,
    category: problem.category,
    message,
    ...(suggestion ? { suggestion } : {}),
    ...(codeSnippet ? { codeSnippet, codeLanguage: problem.codeLanguage ?? inferCodeFenceLanguage(problem.file) } : {}),
    ...(problem.fingerprint ? { fingerprint: problem.fingerprint } : {}),
  };
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

function countPublishedDispatchResults(results: readonly DispatchResult[]): number {
  return results.filter((result) => result.status === "published").length;
}

function countFailedDispatchResults(results: readonly DispatchResult[]): number {
  return results.filter((result) => result.status === "failed").length;
}

function readDispatchErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function toDispatchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFailedDispatchResult(channel: string, phase: "problem" | "summary", error: unknown): DispatchResult {
  const status = readDispatchErrorStatus(error);
  return {
    channel,
    status: "failed",
    raw: {
      action: "dispatch_failed",
      phase,
      error: toDispatchErrorMessage(error),
      ...(status !== undefined ? { status } : {}),
    },
  };
}

function logDispatchFailure(channel: string, phase: "problem" | "summary", error: unknown): void {
  const status = readDispatchErrorStatus(error);
  console.warn(JSON.stringify({
    level: "warn",
    msg: "output publisher dispatch failed",
    channel,
    phase,
    error: toDispatchErrorMessage(error),
    ...(status !== undefined ? { status } : {}),
  }));
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
      const diffRange = { ...range, files: changedPaths.length > 0 ? changedPaths : range.files };
      diff = await vcs.diff(diffRange, { contextLines: options.diffContextLines ?? 3 });
      if (!diff || diff.files.length === 0) {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "vcs diff returned empty result",
          provider: vcs.kind,
          headSha: context.reviewEvent.headSha,
          changedFileCount: changedPaths.length,
          rangeFileCount: range.files.length,
        }));
      }
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "vcs diff threw an exception",
        provider: vcs.kind,
        headSha: context.reviewEvent.headSha,
        error: error instanceof Error ? error.message : String(error),
      }));
      diff = undefined;
    }
  }
  const rawTaskContext = options.taskContextBuilder?.(context.reviewEvent, changedPaths, diff) ??
    buildTaskContext(context.reviewEvent, changedPaths, diff, options.outputLanguage);

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
        const compactLines = [
          buildReviewTaskContext(context.reviewEvent, changedPaths),
          "",
          compressionResult.compactDiff,
          "",
          buildJsonToolContract(),
        ];
        if (options.outputLanguage && options.outputLanguage !== "en") {
          compactLines.push("", `Output language: ${options.outputLanguage}`);
        }
        taskContext = compactLines.join("\n");
      }
    }
  }

  const resolvedBasePrompt = await (async () => {
    if (options.baseSystemPromptResolver) {
      const resolved = await options.baseSystemPromptResolver(context.reviewEvent.workspaceId);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return options.baseSystemPrompt;
  })();

  const resolvedForceSkills = options.forceSkillsResolver?.(context.reviewEvent.workspaceId);
  const resolvedMemoryHints = options.memoryHintsResolver
    ? await options.memoryHintsResolver(context.reviewEvent.workspaceId)
    : options.memoryHints ?? [];

  const preparedPrompt = await prepareReviewPrompt({
    reviewEvent: context.reviewEvent,
    sourceRoot: scopedTree.rootDir,
    changedPaths,
    baseSystemPrompt: resolvedBasePrompt,
    taskContext,
    ...(resolvedForceSkills?.length ? { forceSkills: resolvedForceSkills } : {}),
    ...(options.operatorOverrides ? { operatorOverrides: options.operatorOverrides } : {}),
    ...(resolvedMemoryHints.length > 0 ? { memoryHints: resolvedMemoryHints } : {}),
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
  const tools = createAicrOutputToolRegistry(
    collector,
    async (request) => {
      const result = await vcs.fetchExtraContext(toExtraContextRequest(request, range.headRevision), workspaceRef);
      return result.content;
    },
    async (request) => {
      if (!vcs.fetchAttribution) {
        return { path: request.path, status: "not_found", entries: [] };
      }

      return vcs.fetchAttribution(toAttributionRequest(request, range.headRevision), workspaceRef);
    },
  );
  const bundleContext: AgentBundleContext = {
    instructions: preparedPrompt.discovery.instructions.map((instruction) => ({
      kind: instruction.kind,
      label: instruction.label,
      content: instruction.content,
      ...(instruction.path ? { path: instruction.path } : {}),
    })),
    skills: preparedPrompt.discovery.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      ...(skill.path ? { path: skill.path } : {}),
    })),
    mcpTools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    mcpServers: [
      {
        name: "aicr-output",
        config: {
          type: "local",
          command: ["node", "/app/packages/mcp-output/dist/server.js"],
          enabled: true,
        },
      },
    ],
  };
  let completion = await requestReviewCompletion(scopedTree.rootDir, llmSystemPrompt, options, undefined, bundleContext);
  let lastAgentResult = completion.agentResult;
  const rawModelOutput = completion.llmResult.content;
  const allowNaturalLanguageSummary = completion.agentResult === undefined;
  const toolExecution = await collectCompletionOutputs(completion, tools, collector, { allowNaturalLanguageSummary });
  let outputState = collector.snapshot();
  const initialNoActionSkipReason = completion.agentResult && !hasFinalReviewOutput(outputState) && toolExecution.toolCallCount === 0
    ? classifyUnstructuredNoActionableOutput(rawModelOutput)
    : undefined;
  const summaryOnlyProblemClaim = summaryOnlyClaimsActionableProblems(outputState);
  const contextNeedsFinalPass = outputState.problems.length === 0 && (
    toolExecution.contextResponses.length > 0 ||
    toolExecution.invalidContextRequestCount > 0
  );
  const missingContextRequest = outputRequestsMissingContext(outputState);
  const shouldRepairModelOutput = !initialNoActionSkipReason && (summaryOnlyProblemClaim
    || contextNeedsFinalPass
    || missingContextRequest
    || (!hasFinalReviewOutput(outputState) && (
      toolExecution.toolCallCount === 0 ||
      toolExecution.invalidReviewOutputCount > 0
    )));

  if (!initialNoActionSkipReason && !hasFinalReviewOutput(outputState) && toolExecution.toolCallCount === 0) {
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
  }

  if (initialNoActionSkipReason) {
    collector.skip({ reason: initialNoActionSkipReason });
    outputState = collector.snapshot();
  } else if (shouldRepairModelOutput) {
    if (summaryOnlyProblemClaim || contextNeedsFinalPass || missingContextRequest) {
      collector.clearReviewOutputs();
    }

    completion = await requestReviewCompletion(
      scopedTree.rootDir,
      llmSystemPrompt,
      options,
      {
        previousOutput: completion.llmResult.content,
        prompt: buildContextFollowUpPrompt(changedPaths, toolExecution, {
          ...(summaryOnlyProblemClaim ? { summaryOnlyClaimsProblems: true } : {}),
          ...(missingContextRequest ? { missingContextRequest: true } : {}),
        }),
      },
      bundleContext,
    );
    if (completion.agentResult) {
      lastAgentResult = completion.agentResult;
    }
    const repairExecution = await collectCompletionOutputs(completion, tools, collector, {
      allowNaturalLanguageSummary: completion.agentResult === undefined,
    });
    outputState = collector.snapshot();

    if (outputState.problems.length === 0 && repairExecution.contextResponses.length > 0) {
      collector.clearReviewOutputs();
      completion = await requestReviewCompletion(
        scopedTree.rootDir,
        llmSystemPrompt,
        options,
        {
          previousOutput: completion.llmResult.content,
          prompt: buildContextFollowUpPrompt(changedPaths, repairExecution),
        },
        bundleContext,
      );
      if (completion.agentResult) {
        lastAgentResult = completion.agentResult;
      }
      await collectCompletionOutputs(completion, tools, collector, {
        allowNaturalLanguageSummary: completion.agentResult === undefined,
      });
      outputState = collector.snapshot();
    }

    const repairNoActionSkipReason = completion.agentResult
      ? classifyNoActionableReviewResult(outputState, completion.llmResult.content)
      : undefined;
    if (repairNoActionSkipReason) {
      collector.clearReviewOutputs();
      collector.skip({ reason: repairNoActionSkipReason });
      outputState = collector.snapshot();
    } else if (!hasFinalReviewOutput(outputState) && completion.agentResult) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "agent repair produced no parseable review payload; retrying with direct LLM",
        headSha: context.reviewEvent.headSha,
        triggerName: context.reviewEvent.triggerName,
        workspaceId: context.reviewEvent.workspaceId,
        agentExitCode: completion.agentResult.exitCode,
        agentDurationMs: completion.agentResult.durationMs,
      }));
      completion = await requestDirectLlmCompletion(
        llmSystemPrompt,
        options,
        {
          previousOutput: completion.llmResult.content,
          prompt: buildContextFollowUpPrompt(changedPaths, repairExecution),
        },
      );
      await collectCompletionOutputs(completion, tools, collector, { allowNaturalLanguageSummary: true });
      outputState = collector.snapshot();

      const directNoActionSkipReason = classifyNoActionableReviewResult(outputState, completion.llmResult.content);
      if (directNoActionSkipReason) {
        collector.clearReviewOutputs();
        collector.skip({ reason: directNoActionSkipReason });
        outputState = collector.snapshot();
      }
    }

    if (summaryOnlyClaimsActionableProblems(outputState)) {
      collector.clearReviewOutputs();
      collector.publishSummary({ markdown: buildFallbackReviewSummary(context.reviewEvent, changedPaths) });
      outputState = collector.snapshot();
    } else if (!hasFinalReviewOutput(outputState)) {
      collector.publishSummary({ markdown: buildFallbackReviewSummary(context.reviewEvent, changedPaths) });
      outputState = collector.snapshot();
    }
  } else if (!hasFinalReviewOutput(outputState) && toolExecution.toolCallCount === 0) {
    collector.publishSummary({ markdown: buildFallbackReviewSummary(context.reviewEvent, changedPaths) });
    outputState = collector.snapshot();
  }

  const llmResult = completion.llmResult;
  const agentResult = completion.agentResult ?? lastAgentResult;
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
    const eventAuthor = context.reviewEvent.author?.username;
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
      const anchoredProblem: ReviewProblem = lineCommentable === false
        ? { ...rawReviewProblem, lineCommentAllowed: false }
        : rawReviewProblem;
      const reviewProblem = withCodeReference(anchoredProblem, diff);
      let renderedMessage: string;
      let renderedSuggestion: string | undefined;
      let renderedCodeSnippet: string | undefined;
      if (enableScrub) {
        const scrubbedMsg = scrubText(reviewProblem.message);
        const scrubbedSuggestion = reviewProblem.suggestion ? scrubText(reviewProblem.suggestion) : undefined;
        const scrubbedCodeSnippet = reviewProblem.codeSnippet ? scrubText(reviewProblem.codeSnippet) : undefined;
        allScrubMatches.push(...scrubbedMsg.matches);
        if (scrubbedSuggestion) {
          allScrubMatches.push(...scrubbedSuggestion.matches);
        }
        if (scrubbedCodeSnippet) {
          allScrubMatches.push(...scrubbedCodeSnippet.matches);
        }
        renderedMessage = fixAndValidateMarkdown(scrubbedMsg.text);
        renderedSuggestion = scrubbedSuggestion ? fixAndValidateMarkdown(scrubbedSuggestion.text) : undefined;
        renderedCodeSnippet = scrubbedCodeSnippet?.text;
      } else {
        renderedMessage = fixAndValidateMarkdown(reviewProblem.message);
        renderedSuggestion = reviewProblem.suggestion ? fixAndValidateMarkdown(reviewProblem.suggestion) : undefined;
        renderedCodeSnippet = reviewProblem.codeSnippet;
      }

      const renderedProblemContent = withRenderedProblemContent(
        reviewProblem,
        renderedMessage,
        renderedSuggestion,
        renderedCodeSnippet,
      );

      if (resolver) {
        const templateCtx: TemplateContext = {
          ...baseTemplateContext,
          problem: toTemplateProblem(renderedProblemContent),
        };
        const renderedMarkdown = fixAndValidateMarkdown(resolver.render("problem", templateCtx));
        const preparedProblem: ReviewProblem = {
          ...renderedProblemContent,
          renderedMarkdown,
        };
        reviewProblems.push(preparedProblem);
        if (publishesProblems(outputPublisher)) {
          try {
            appendDispatchResults(dispatchResults, await publishProblem(outputPublisher, preparedProblem));
          } catch (error) {
            logDispatchFailure("output", "problem", error);
            dispatchResults.push(createFailedDispatchResult("output", "problem", error));
          }
        }
        continue;
      }

      const preparedProblem: ReviewProblem = renderedProblemContent;
      reviewProblems.push(preparedProblem);
      if (publishesProblems(outputPublisher)) {
        try {
          appendDispatchResults(dispatchResults, await publishProblem(outputPublisher, preparedProblem));
        } catch (error) {
          logDispatchFailure("output", "problem", error);
          dispatchResults.push(createFailedDispatchResult("output", "problem", error));
        }
      }
    }

    if (outputPublisher.publishSummary) {
      const suppressNoProblemsSummary = reviewProblems.length === 0
        && (outputPublisher.noProblemsAction === "suppress"
          || (outputPublisher.noProblemsAction === "publish_if_summary"
            && outputState.summaries.every((s) => !s.markdown.trim())));
      if (!suppressNoProblemsSummary) {
        const summariesToPublish: readonly PublishSummaryInput[] = outputState.summaries.length > 0
          ? outputState.summaries
          : reviewProblems.length > 0 || outputPublisher.publishEmptySummary
            ? [{ markdown: "" }]
            : [];
        for (const summaryEntry of summariesToPublish) {
          let renderedSummary: string;
          let renderedSummaryTitle: string | undefined;
          if (enableScrub) {
            const scrubbedSummary = scrubText(summaryEntry.markdown);
            const scrubbedTitle = summaryEntry.title ? scrubText(summaryEntry.title) : undefined;
            allScrubMatches.push(...scrubbedSummary.matches);
            if (scrubbedTitle) {
              allScrubMatches.push(...scrubbedTitle.matches);
            }
            renderedSummary = fixAndValidateMarkdown(scrubbedSummary.text);
            renderedSummaryTitle = scrubbedTitle ? fixAndValidateMarkdown(scrubbedTitle.text) : undefined;
          } else {
            renderedSummary = fixAndValidateMarkdown(summaryEntry.markdown);
            renderedSummaryTitle = summaryEntry.title ? fixAndValidateMarkdown(summaryEntry.title) : undefined;
          }

          if (resolver) {
            const summaryCtx: TemplateContext = {
              ...baseTemplateContext,
              summary: renderedSummary,
              ...(renderedSummaryTitle ? { summaryTitle: renderedSummaryTitle } : {}),
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
          try {
            appendDispatchResults(
              dispatchResults,
              await outputPublisher.publishSummary(
                renderedSummary,
                reviewProblems,
                {
                  ...(renderedSummaryTitle ? { title: renderedSummaryTitle } : {}),
                  ...(changedPaths.length > 0 ? { reviewedFiles: changedPaths } : {}),
                },
              ),
            );
          } catch (error) {
            logDispatchFailure("output", "summary", error);
            dispatchResults.push(createFailedDispatchResult("output", "summary", error));
          }
        }
      }
    }
  }

  if (options.logThinking !== false) {
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
        summaries: outputState.summaries.map((summary) => ({
          ...(summary.title ? {
            title: summary.title.length > 120 ? `${summary.title.slice(0, 120)}...` : summary.title,
          } : {}),
          markdown: summary.markdown.length > 500 ? `${summary.markdown.slice(0, 500)}...` : summary.markdown,
        })),
      } : {}),
    }));
  }

  const publishedDispatchCount = countPublishedDispatchResults(dispatchResults);
  const failedDispatchCount = countFailedDispatchResults(dispatchResults);
  const implicitSkipReason = !options.dryRun && !outputState.skipReason && publishedDispatchCount === 0
    ? failedDispatchCount > 0
      ? "output_dispatch_failed"
      : outputState.problems.length > 0 && !outputPublisher
      ? "no_output_publisher"
      : outputState.problems.length === 0
        && (outputPublisher?.noProblemsAction === "suppress"
          || (outputPublisher?.noProblemsAction === "publish_if_summary"
            && outputState.summaries.every((s) => !s.markdown.trim())))
        ? "no_problems_suppressed"
        : "no_dispatchable_problems"
    : undefined;
  const skipReason = outputState.skipReason ?? implicitSkipReason;
  const status = skipReason
    ? "skipped"
    : publishedDispatchCount > 0
      ? "published"
      : options.dryRun
        ? "dry_run"
        : "published";

  const result: ReviewOrchestrationResult = {
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

  if (options.postRunCallback) {
    try {
      await options.postRunCallback(result, context);
    } catch (callbackError: unknown) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "postRunCallback failed",
        triggerName: context.reviewEvent.triggerName,
        workspaceId: context.reviewEvent.workspaceId,
        error: callbackError instanceof Error ? callbackError.message : String(callbackError),
      }));
    }
  }

  return result;
}

function buildOrchestratorVcsContext(reviewEvent: ReviewEvent): { branch?: string; sourcePath?: string; workspace?: string; repositoryPath?: string } {
  const result: { branch?: string; sourcePath?: string; workspace?: string; repositoryPath?: string } = {};

  if (reviewEvent.branch !== undefined) {
    result.branch = reviewEvent.branch;
  }
  if (reviewEvent.sourcePath !== undefined) {
    result.sourcePath = reviewEvent.sourcePath;
  }
  if (reviewEvent.submitterWorkspace !== undefined) {
    result.workspace = reviewEvent.submitterWorkspace;
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

import {
  buildReviewTaskContext,
  isPlainObject,
  prepareReviewPrompt,
  type PreparedReviewPrompt,
  type ReviewEvent,
} from "@aicr/core";
import type { AgentAdapter } from "@aicr/agents";
import type { ChatCompletionClient, ChatCompletionResult, ModelSpec } from "@aicr/llm";
import {
  AicrOutputCollector,
  createAicrOutputToolRegistry,
  type AicrOutputToolDefinition,
  type AicrOutputToolName,
  type AicrOutputState,
  type FetchMoreContextInput,
  type PublishFindingInput,
} from "@aicr/mcp-output";
import type { DispatchResult, ReviewFinding } from "@aicr/outputs";
import type { SandboxBackend } from "@aicr/sandbox";
import type { ChangeRange, ExtraContextRequest, ParsedDiff, VcsAdapter } from "@aicr/vcs";

export interface DiffCapableVcsAdapter extends VcsAdapter {
  diff?(range: ChangeRange, options?: { readonly contextLines?: number }): Promise<ParsedDiff>;
}

export interface ReviewOutputPublisher {
  publishFinding(finding: ReviewFinding): Promise<DispatchResult>;
}

export type ReviewOutputPublisherResolver = (
  context: ReviewOrchestrationContext,
) => ReviewOutputPublisher | undefined;

export interface ReviewOrchestrationContext {
  readonly reviewEvent: ReviewEvent;
  readonly payload: unknown;
  readonly provider: "gitea" | "forgejo";
  readonly eventName: string;
}

export interface ServerReviewOrchestrationOptions {
  readonly baseSystemPrompt: string;
  readonly sourceRootResolver: (reviewEvent: ReviewEvent) => string | undefined;
  readonly vcs: DiffCapableVcsAdapter;
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
  readonly taskContextBuilder?: (
    reviewEvent: ReviewEvent,
    changedPaths: readonly string[],
    diff: ParsedDiff | undefined,
  ) => string | undefined;
}

export interface ReviewOrchestrationResult {
  readonly status: "dry_run" | "published" | "skipped";
  readonly sourceRoot: string;
  readonly changedFiles: readonly string[];
  readonly fetchedFiles: readonly string[];
  readonly diffFileCount: number;
  readonly promptTokenEstimate: number;
  readonly findingCount: number;
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
}

export interface ReviewOrchestrationWebhookSummary {
  readonly status: "dry_run" | "published" | "skipped";
  readonly changedFileCount: number;
  readonly fetchedFileCount: number;
  readonly diffFileCount: number;
  readonly promptTokenEstimate: number;
  readonly findingCount: number;
  readonly summaryCount: number;
  readonly contextRequestCount: number;
  readonly dispatchCount: number;
  readonly skipReason?: string;
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
  };
}

interface ToolCallEnvelope {
  readonly name: AicrOutputToolName;
  readonly input: unknown;
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
    "Preferred shape:",
    '{"toolCalls":[{"name":"aicr.publish_finding","input":{"file":"src/file.ts","line":1,"severity":"medium","category":"correctness","message":"..."}}],"notes":"optional"}',
    "Alternatively use findings/summary/skipReason fields; AICR will translate them into tool calls.",
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

function extractJsonPayload(content: string): unknown {
  const trimmed = content.trim();
  const fencedMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  const jsonText = fencedMatch?.[1] ?? trimmed;

  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`LLM output was not valid JSON tool output: ${message}`);
  }
}

function normalizeToolName(value: unknown): AicrOutputToolName {
  if (
    value === "aicr.publish_finding" ||
    value === "aicr.publish_summary" ||
    value === "aicr.skip" ||
    value === "aicr.fetch_more_context"
  ) {
    return value;
  }

  throw new TypeError(`Unsupported AICR tool name: ${String(value)}`);
}

function findingToToolInput(value: unknown): PublishFindingInput {
  if (!isPlainObject(value)) {
    throw new TypeError("finding must be an object.");
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
  } as PublishFindingInput;
}

function parseToolCalls(content: string): ToolCallEnvelope[] {
  const payload = extractJsonPayload(content);
  if (!isPlainObject(payload)) {
    throw new TypeError("LLM JSON output must be an object.");
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

  const calls: ToolCallEnvelope[] = [];
  if (Array.isArray(payload.findings)) {
    calls.push(
      ...payload.findings.map((finding) => ({
        name: "aicr.publish_finding" as const,
        input: findingToToolInput(finding),
      })),
    );
  }

  if (typeof payload.summary === "string" && payload.summary.trim()) {
    calls.push({ name: "aicr.publish_summary", input: { markdown: payload.summary } });
  }

  if (typeof payload.skipReason === "string" && payload.skipReason.trim()) {
    calls.push({ name: "aicr.skip", input: { reason: payload.skipReason } });
  }

  return calls;
}

async function callAicrTools(
  content: string,
  tools: readonly AicrOutputToolDefinition[],
): Promise<void> {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  for (const toolCall of parseToolCalls(content)) {
    const tool = toolMap.get(toolCall.name);
    if (!tool) {
      throw new TypeError(`AICR tool ${toolCall.name} is not registered.`);
    }

    await tool.call(toolCall.input);
  }
}

function toExtraContextRequest(input: FetchMoreContextInput): ExtraContextRequest {
  return {
    path: input.path,
    reason: input.reason,
    ...(input.range?.start_line !== undefined ? { startLine: input.range.start_line } : {}),
    ...(input.range?.end_line !== undefined ? { endLine: input.range.end_line } : {}),
  };
}

function toReviewFinding(input: PublishFindingInput): ReviewFinding {
  return {
    file: input.file,
    line: input.line,
    ...(input.end_line !== undefined ? { endLine: input.end_line } : {}),
    severity: input.severity,
    category: input.category,
    message: input.message,
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
  };
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
  const range = await options.vcs.listChanges(context.reviewEvent);
  const scopedTree = await options.vcs.fetchScoped(range, workspaceRef);
  const changedPaths = [
    ...(options.changedPathsResolver?.(context) ?? range.files ?? context.reviewEvent.changedFiles ?? []),
  ];
  const diff = options.vcs.diff
    ? await options.vcs.diff(
        { ...range, files: changedPaths.length > 0 ? changedPaths : range.files },
        { contextLines: options.diffContextLines ?? 3 },
      )
    : undefined;
  const taskContext = options.taskContextBuilder?.(context.reviewEvent, changedPaths, diff) ??
    buildTaskContext(context.reviewEvent, changedPaths, diff);
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
  const collector = new AicrOutputCollector();
  const tools = createAicrOutputToolRegistry(collector, async (request) => {
    const result = await options.vcs.fetchExtraContext(toExtraContextRequest(request), workspaceRef);
    return result.content;
  });
  const llmResult = await options.llm.complete({
    model: options.model,
    messages: [{ role: "system", content: preparedPrompt.prompt.systemPrompt }],
  });

  await callAicrTools(llmResult.content, tools);
  const outputState = collector.snapshot();
  const dispatchResults: DispatchResult[] = [];
  const outputPublisher = options.outputPublisher ?? options.outputPublisherResolver?.(context);

  if (!options.dryRun && outputPublisher) {
    for (const finding of outputState.findings) {
      dispatchResults.push(await outputPublisher.publishFinding(toReviewFinding(finding)));
    }
  }

  const implicitSkipReason = !options.dryRun && !outputState.skipReason && dispatchResults.length === 0
    ? outputState.findings.length > 0 && !outputPublisher
      ? "no_output_publisher"
      : "no_dispatchable_findings"
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
    findingCount: outputState.findings.length,
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
  };
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
    findingCount: result.findingCount,
    summaryCount: result.summaryCount,
    contextRequestCount: result.contextRequestCount,
    dispatchCount: result.dispatchCount,
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    model: result.model,
  };
}

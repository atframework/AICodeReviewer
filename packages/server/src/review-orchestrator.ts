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
  type ScrubFinding,
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
  type PublishFindingInput,
} from "@aicr/mcp-output";
import {
  buildAtMentions,
  computeFindingFingerprint,
  createTemplateResolver,
  toTemplateFinding,
  type AuthorResolutionOptions,
  type TemplateContext,
  type TemplateResolver,
  type MentionChannelKind,
} from "@aicr/outputs";
import type { DispatchResult, ReviewFinding } from "@aicr/outputs";
import type { SandboxBackend, SandboxSpawnResult } from "@aicr/sandbox";
import type { ChangeRange, ExtraContextRequest, ParsedDiff, VcsAdapter } from "@aicr/vcs";

export interface DiffCapableVcsAdapter extends VcsAdapter {
  diff?(range: ChangeRange, options?: { readonly contextLines?: number }): Promise<ParsedDiff>;
}

export type ReviewDispatchResult = DispatchResult | readonly DispatchResult[];

export interface ReviewOutputPublisher {
  readonly publishesFindings?: boolean;
  readonly handlesRendering?: boolean;
  readonly publishEmptySummary?: boolean;
  publishFinding(finding: ReviewFinding): Promise<ReviewDispatchResult>;
  publishSummary?(summary: string, findings?: readonly ReviewFinding[]): Promise<ReviewDispatchResult>;
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
  readonly vcsFactory?: (sourceRoot: string) => DiffCapableVcsAdapter;
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
  readonly agentResult?: SandboxSpawnResult;
  readonly scrubFindings: readonly ScrubFinding[];
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
  readonly findingCount: number;
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

  return {
    llmResult: {
      providerId: options.model.providerId,
      modelId: options.model.modelId,
      content: agentResult.stdout,
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
  const xmlCalls = parseXmlToolCalls(content);
  if (xmlCalls) {
    return xmlCalls;
  }

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
  const finding = {
    file: input.file,
    line: input.line,
    ...(input.end_line !== undefined ? { endLine: input.end_line } : {}),
    severity: input.severity,
    category: input.category,
    message: input.message,
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
  };

  return finding.fingerprint ? finding : { ...finding, fingerprint: computeFindingFingerprint(finding) };
}

function pathMatchesDiffFile(findingPath: string, file: ParsedDiff["files"][number]): boolean {
  const normalizedFindingPath = normalizePath(findingPath);
  return [file.newPath, file.oldPath]
    .filter((path): path is string => Boolean(path))
    .some((path) => normalizePath(path) === normalizedFindingPath);
}

function isLineCommentableInDiff(finding: ReviewFinding, diff: ParsedDiff | undefined): boolean | undefined {
  if (!diff) {
    return undefined;
  }

  const matchingFiles = diff.files.filter((file) => pathMatchesDiffFile(finding.file, file));
  if (matchingFiles.length === 0) {
    return false;
  }

  return matchingFiles.some((file) =>
    file.hunks.some((hunk) =>
      hunk.lines.some((line) =>
        (line.kind === "add" || line.kind === "context") && line.newLine === finding.line,
      ),
    ),
  );
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
  const vcs = options.vcsFactory ? options.vcsFactory(sourceRoot) : options.vcs;
  const range = await vcs.listChanges(context.reviewEvent);
  const scopedTree = await vcs.fetchScoped(range, workspaceRef);
  const changedPaths = [
    ...(options.changedPathsResolver?.(context) ?? range.files ?? context.reviewEvent.changedFiles ?? []),
  ];
  const diff = vcs.diff
    ? await vcs.diff(
        { ...range, files: changedPaths.length > 0 ? changedPaths : range.files },
        { contextLines: options.diffContextLines ?? 3 },
      )
    : undefined;
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
  const allScrubFindings: ScrubFinding[] = [];

  const scrubbedPrompt = enableScrub
    ? scrubPromptMessages([{ role: "system", content: preparedPrompt.prompt.systemPrompt }])
    : { messages: [{ role: "system", content: preparedPrompt.prompt.systemPrompt }], findings: [] as ScrubFinding[] };

  if (enableScrub) {
    allScrubFindings.push(...scrubbedPrompt.findings);
  }

  const llmSystemPrompt = (scrubbedPrompt.messages[0] as { role: string; content: string }).content;

  const collector = new AicrOutputCollector();
  const tools = createAicrOutputToolRegistry(collector, async (request) => {
    const result = await vcs.fetchExtraContext(toExtraContextRequest(request), workspaceRef);
    return result.content;
  });
  const agentExecution = options.sandbox && options.agentAdapter
    ? await runAgentReview(scopedTree.rootDir, llmSystemPrompt, options)
    : undefined;
  const llmResult = agentExecution?.llmResult ?? await options.llm.complete({
    model: options.model,
    messages: [{ role: "system", content: llmSystemPrompt }],
  });

  await callAicrTools(llmResult.content, tools);
  const outputState = collector.snapshot();
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
    const eventCtx: { author?: string; url?: string; title?: string } = {};
    if (eventAuthor !== undefined) {
      eventCtx.author = eventAuthor;
    }
    if (context.reviewEvent.url !== undefined) {
      eventCtx.url = context.reviewEvent.url;
    }
    const baseTemplateContext: Omit<TemplateContext, "finding"> = {
      ...(Object.keys(eventCtx).length > 0 ? { event: eventCtx } : {}),
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
    };
    const reviewFindings: ReviewFinding[] = [];
    for (const finding of outputState.findings) {
      const rawReviewFinding = toReviewFinding(finding);
      const lineCommentable = isLineCommentableInDiff(rawReviewFinding, diff);
      const reviewFinding: ReviewFinding = lineCommentable === false
        ? { ...rawReviewFinding, lineCommentAllowed: false }
        : rawReviewFinding;
      let renderedMessage: string;
      let renderedSuggestion: string | undefined;
      if (enableScrub) {
        const scrubbedMsg = scrubText(reviewFinding.message);
        const scrubbedSuggestion = reviewFinding.suggestion ? scrubText(reviewFinding.suggestion) : undefined;
        allScrubFindings.push(...scrubbedMsg.findings);
        if (scrubbedSuggestion) {
          allScrubFindings.push(...scrubbedSuggestion.findings);
        }
        renderedMessage = fixAndValidateMarkdown(scrubbedMsg.text);
        renderedSuggestion = scrubbedSuggestion ? fixAndValidateMarkdown(scrubbedSuggestion.text) : undefined;
      } else {
        renderedMessage = fixAndValidateMarkdown(reviewFinding.message);
        renderedSuggestion = reviewFinding.suggestion ? fixAndValidateMarkdown(reviewFinding.suggestion) : undefined;
      }

      if (resolver) {
        const templateCtx: TemplateContext = {
          ...baseTemplateContext,
          finding: toTemplateFinding({
            ...reviewFinding,
            message: renderedMessage,
            ...(renderedSuggestion ? { suggestion: renderedSuggestion } : {}),
          }),
        };
        const renderedMarkdown = fixAndValidateMarkdown(resolver.render("finding", templateCtx));
        const preparedFinding: ReviewFinding = {
          ...reviewFinding,
          message: renderedMessage,
          ...(renderedSuggestion ? { suggestion: renderedSuggestion } : {}),
          renderedMarkdown,
        };
        reviewFindings.push(preparedFinding);
        if (outputPublisher.publishesFindings !== false) {
          appendDispatchResults(dispatchResults, await outputPublisher.publishFinding(preparedFinding));
        }
        continue;
      }

      const preparedFinding: ReviewFinding = {
        ...reviewFinding,
        message: renderedMessage,
        ...(renderedSuggestion ? { suggestion: renderedSuggestion } : {}),
      };
      reviewFindings.push(preparedFinding);
      if (outputPublisher.publishesFindings !== false) {
        appendDispatchResults(dispatchResults, await outputPublisher.publishFinding(preparedFinding));
      }
    }

    if (outputPublisher.publishSummary) {
      const summariesToPublish = outputState.summaries.length > 0
        ? outputState.summaries
        : reviewFindings.length > 0 || outputPublisher.publishEmptySummary
          ? [""]
          : [];
      for (const summary of summariesToPublish) {
        let renderedSummary = enableScrub ? fixAndValidateMarkdown(scrubText(summary).text) : fixAndValidateMarkdown(summary);
        if (resolver) {
          const summaryCtx: TemplateContext = {
            ...baseTemplateContext,
            summary: renderedSummary,
            findings: reviewFindings.map((f) =>
              toTemplateFinding({
                ...f,
                message: f.message,
                ...(f.suggestion ? { suggestion: f.suggestion } : {}),
              }),
            ),
          };
          renderedSummary = fixAndValidateMarkdown(resolver.render("summary", summaryCtx));
        }
        appendDispatchResults(dispatchResults, await outputPublisher.publishSummary(renderedSummary, reviewFindings));
      }
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
    ...(agentExecution?.agentResult ? { agentResult: agentExecution.agentResult } : {}),
    scrubFindings: allScrubFindings,
    ...(compressed ? { compressed } : {}),
    ...(originalTokenEstimate !== undefined ? { originalTokenEstimate } : {}),
    ...(compressedTokenEstimate !== undefined ? { compressedTokenEstimate } : {}),
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
    ...(result.compressed ? { compressed: result.compressed } : {}),
    ...(result.originalTokenEstimate !== undefined ? { originalTokenEstimate: result.originalTokenEstimate } : {}),
    ...(result.compressedTokenEstimate !== undefined ? { compressedTokenEstimate: result.compressedTokenEstimate } : {}),
    model: result.model,
  };
}

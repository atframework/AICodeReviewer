import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  createDefaultLogger,
  createOtelSdk,
  fixMarkdown,
  createReviewEvent,
  loadConfigFile,
  loadSystemPromptTemplate,
  prepareReviewPrompt,
  reviewProviderSchema,
  summarizePreparedReviewPrompt,
  type ReviewProvider,
} from "@aicr/core";
import {
  renderTemplate,
  toTemplateProblem,
  type TemplateContext,
  type TemplateKind,
} from "@aicr/outputs";
import {
  bootstrapServerApp,
  createServerApp,
  runReviewOrchestration,
  serveAsync,
  summarizeReviewOrchestrationForWebhook,
} from "@aicr/server";
import { runEval, type EvalExample, type EvalReviewOutput } from "@aicr/eval";

import { installFileLogTeeFromEnv } from "./log-file.js";

const helpText = `AICodeReviewer CLI

Usage:
  aicr <command> [options]

Commands:
  serve    Start the webhook server
  review   Run a code review (prompt preparation or full dry-run)
  eval     Run evaluation benchmarks against configured LLM
  replay   Replay a stored review run scaffold
  memory   Inspect or clear workspace memory scaffold
  lint     Validate templates or config scaffold
  doctor   Print environment diagnostics
  help     Show this message

Options:
  --config <path>         Path to config YAML file
  --workspace <id>        Workspace ID
  --repo <ref>            Repository reference (owner/repo)
  --provider <name>       Trigger provider kind from the config schema
  --trigger <name>        Trigger name
  --reason <text>         Review reason
  --source-root <path>    Source root directory
  --base-prompt <path>    Path to base system prompt template
  --changed-file <path>   Changed file (repeatable)
  --base-sha <sha>        Base revision SHA
  --head-sha <sha>        Head revision SHA
  --url <url>             PR / MR / commit URL
  --author-username <u>   Author username
  --author-email <e>      Author email
  --dry-run               Run review without publishing to output channels
  --port <number>         HTTP listen port (serve command, default: 8080)
  --max-prompt-tokens <n> Maximum prompt token budget
  --run-id <id>           Run ID for replay command
  --scope <scope>         Memory clear scope (false-positives, recurring-issues, etc.)
  --all                   Include full file contents in memory show
  --template <path>       Template file to render and validate (lint command)
  --template-kind <kind>  Template kind: summary or problem (lint command)
  --channel-kind <kind>   Output channel kind for lint sample context
  --eval-dir <path>       Directory containing eval JSON fixtures (eval command)
  --help, -h              Show this message
  --version, -v           Show version
`;

interface Writer {
  write(text: string): void;
}

export interface RunCliOptions {
  readonly cwd?: string;
  readonly stdout?: Writer;
  readonly stderr?: Writer;
  readonly logger?: ReturnType<typeof createDefaultLogger>;
}

function printHelp(output: Writer): void {
  output.write(`${helpText}\n`);
}

function parseOptionalInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${flagName} must be a positive integer.`);
  }

  return parsed;
}

function parseTemplateKind(value: string | undefined, templatePath?: string): TemplateKind {
  if (value === "summary" || value === "problem") {
    return value;
  }

  if (value !== undefined) {
    throw new RangeError("--template-kind must be summary or problem.");
  }

  const lowerPath = templatePath?.toLowerCase() ?? "";
  return lowerPath.includes(".problem.") ||
    lowerPath.endsWith("problem.hbs")
    ? "problem"
    : "summary";
}

function createSampleTemplateContext(kind: TemplateKind): TemplateContext {
  const problem = toTemplateProblem({
    file: "src/example.ts",
    line: 42,
    endLine: 45,
    severity: "high",
    category: "correctness",
    message: "Sample problem rendered by aicr lint.",
    suggestion: "Return early when the input is invalid.",
    fingerprint: "sample-fingerprint",
  });

  return {
    event: {
      author: "review-author",
      url: "https://example.invalid/owner/repo/pulls/123",
      title: "Sample pull request",
    },
    repo: {
      name: "repo",
      fullName: "owner/repo",
    },
    run: { id: "lint-sample-run" },
    atMentions: "@review-author",
    problems: [problem],
    summary: "Sample summary rendered by aicr lint.",
    ...(kind === "problem" ? { problem } : {}),
  };
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  installFileLogTeeFromEnv();
  const logger = options.logger ?? createDefaultLogger({ serviceName: "aicr-cli" });

  const parsedArgs = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
          config: { type: "string" },
          help: { type: "boolean", short: "h" },
          version: { type: "boolean", short: "v" },
          workspace: { type: "string" },
          repo: { type: "string" },
          provider: { type: "string" },
          trigger: { type: "string" },
          reason: { type: "string" },
          "source-root": { type: "string" },
          "base-prompt": { type: "string" },
          "changed-file": { type: "string", multiple: true },
          "operator-override": { type: "string", multiple: true },
          "memory-hint": { type: "string", multiple: true },
          "task-context": { type: "string" },
          "base-sha": { type: "string" },
          "head-sha": { type: "string" },
          url: { type: "string" },
          "author-username": { type: "string" },
          "author-email": { type: "string" },
          "author-display-name": { type: "string" },
          "max-prompt-tokens": { type: "string" },
          "dry-run": { type: "boolean" },
          port: { type: "string" },
          "run-id": { type: "string" },
          scope: { type: "string" },
          all: { type: "boolean" },
          template: { type: "string" },
          "template-kind": { type: "string" },
          "channel-kind": { type: "string" },
          "eval-dir": { type: "string" },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`aicr failed to parse arguments: ${message}\n`);
      return undefined;
    }
  })();

  if (!parsedArgs) {
    return 1;
  }

  const { positionals, values } = parsedArgs;

  if (values.version) {
    stdout.write("0.1.0\n");
    return 0;
  }

  const command = positionals[0];

  if (values.help || command === undefined || command === "help") {
    printHelp(stdout);
    return 0;
  }

  if (command === "doctor") {
    stdout.write(
      `${JSON.stringify(
        {
          cwd,
          node: process.version,
          config: values.config ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (command === "serve") {
    try {
      const configPath = values.config
        ? resolve(cwd, values.config)
        : resolve(cwd, "config.yaml");
      const config = await loadConfigFile(configPath);
      const basePromptPath = resolve(cwd, values["base-prompt"] ?? "prompts/system/code-reviewer.system.md");
      const baseSystemPrompt = await loadSystemPromptTemplate(basePromptPath);
      const port = parseOptionalInteger(values.port, "--port") ?? config.server.port ?? 8080;

      let otelSdk: ReturnType<typeof createOtelSdk> | undefined;
      if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        otelSdk = createOtelSdk({ serviceName: "aicr", enableOtelDiagnostics: true });
        otelSdk.start();
      }

      const serverOptions = await bootstrapServerApp({
        config,
        baseSystemPrompt,
        baseDir: cwd,
      });
      const app = createServerApp(serverOptions);

      const proxyConfig = config.server.trust_proxy !== false
        ? {
            trustProxy: config.server.trust_proxy,
            ...(config.server.base_url ? { baseUrl: config.server.base_url } : {}),
            ...(config.server.path_prefix ? { pathPrefix: config.server.path_prefix } : {}),
          }
        : undefined;

      await serveAsync(app, {
        port,
        hostname: config.server.hostname,
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
      });
      logger.info({ port }, "AICR server started");
      stdout.write(`AICR server listening on port ${port}\n`);

      return new Promise<number>(() => {
        // Keep process alive until killed
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`aicr serve failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "review") {
    if (!values.repo) {
      stderr.write('aicr review requires --repo.\n');
      return 1;
    }

    try {
      const sourceRoot = resolve(cwd, values["source-root"] ?? ".");
      const basePromptPath = resolve(cwd, values["base-prompt"] ?? "prompts/system/code-reviewer.system.md");
      const maxPromptTokens = parseOptionalInteger(values["max-prompt-tokens"], "--max-prompt-tokens");
      const baseSystemPrompt = await loadSystemPromptTemplate(basePromptPath);
      const provider = values.provider ?? "manual";
      const validProviders = reviewProviderSchema.options;
      const parsedProvider = reviewProviderSchema.safeParse(provider);
      if (!parsedProvider.success) {
        stderr.write(`aicr review: invalid provider "${provider}". Must be one of: ${validProviders.join(", ")}.\n`);
        return 1;
      }
      const reviewProvider: ReviewProvider = parsedProvider.data;
      const reviewEvent = createReviewEvent({
        triggerName: values.trigger ?? "manual-cli",
        provider: reviewProvider,
        workspaceId: values.workspace ?? "manual-workspace",
        targetKind: "manual",
        repoRef: values.repo,
        reason: values.reason ?? "manual:review",
        author: {
          ...(values["author-username"] ? { username: values["author-username"] } : {}),
          ...(values["author-email"] ? { email: values["author-email"] } : {}),
          ...(values["author-display-name"]
            ? { displayName: values["author-display-name"] }
            : {}),
        },
        ...(values["base-sha"] ? { baseSha: values["base-sha"] } : {}),
        ...(values["head-sha"] ? { headSha: values["head-sha"] } : {}),
        ...(values.url ? { url: values.url } : {}),
        ...(values["changed-file"]?.length ? { changedFiles: values["changed-file"] } : {}),
      });

      if (values["dry-run"]) {
        const configPath = values.config
          ? resolve(cwd, values.config)
          : resolve(cwd, "config.yaml");
        let config;
        try {
          config = await loadConfigFile(configPath);
        } catch {
          stderr.write(`aicr review --dry-run requires a valid config file at ${configPath}\n`);
          return 1;
        }

        const serverOptions = await bootstrapServerApp({
          config,
          baseSystemPrompt,
          baseDir: cwd,
          workspaceId: reviewEvent.workspaceId,
        });
        const orchestration = serverOptions.reviewOrchestration;
        if (!orchestration) {
          stderr.write("aicr review --dry-run: failed to initialize review orchestration.\n");
          return 1;
        }

        const result = await runReviewOrchestration(
          {
            reviewEvent,
            payload: null,
            provider: reviewProvider,
            eventName: "manual",
          },
          {
            baseSystemPrompt: orchestration.baseSystemPrompt,
            sourceRootResolver: () => sourceRoot,
            vcs: orchestration.vcs,
            ...(orchestration.vcsFactory ? { vcsFactory: orchestration.vcsFactory } : {}),
            llm: orchestration.llm,
            model: orchestration.model,
            dryRun: true,
            ...(orchestration.outputPublisher ? { outputPublisher: orchestration.outputPublisher } : {}),
            ...(orchestration.outputPublisherResolver ? { outputPublisherResolver: orchestration.outputPublisherResolver } : {}),
            ...(orchestration.sandbox ? { sandbox: orchestration.sandbox } : {}),
            ...(orchestration.agentAdapter ? { agentAdapter: orchestration.agentAdapter } : {}),
            ...(orchestration.agentTimeoutMs !== undefined ? { agentTimeoutMs: orchestration.agentTimeoutMs } : {}),
            ...(orchestration.compression ? { compression: orchestration.compression } : {}),
            ...(orchestration.summarizeModel ? { summarizeModel: orchestration.summarizeModel } : {}),
            ...(orchestration.summarizeClient ? { summarizeClient: orchestration.summarizeClient } : {}),
            ...(orchestration.templateResolver ? { templateResolver: orchestration.templateResolver } : {}),
            ...(orchestration.channelKind ? { channelKind: orchestration.channelKind } : {}),
            ...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
            ...(values["operator-override"]?.length
              ? { operatorOverrides: values["operator-override"] }
              : {}),
            ...(values["memory-hint"]?.length
              ? { memoryHints: values["memory-hint"] }
              : {}),
          },
        );

        stdout.write(
          `${JSON.stringify(
            {
              reviewEvent,
              reviewRun: summarizeReviewOrchestrationForWebhook(result),
              problems: result.outputState.problems,
              summaries: result.outputState.summaries,
              ...(result.outputState.skipReason
                ? { skipReason: result.outputState.skipReason }
                : {}),
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }

      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot,
        baseSystemPrompt,
        ...(values["changed-file"] ? { changedPaths: values["changed-file"] } : {}),
        ...(values["operator-override"] ? { operatorOverrides: values["operator-override"] } : {}),
        ...(values["memory-hint"] ? { memoryHints: values["memory-hint"] } : {}),
        ...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
        ...(values["task-context"] ? { taskContext: values["task-context"] } : {}),
      });
      stdout.write(
        `${JSON.stringify(
          {
            reviewEvent,
            reviewPreparation: summarizePreparedReviewPrompt(prepared),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`aicr review failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "replay") {
    const runId = values["run-id"];
    if (!runId) {
      stderr.write("aicr replay requires --run-id.\n");
      return 1;
    }

    const sourceRoot = resolve(cwd, values["source-root"] ?? ".");
    const workspaceId = values.workspace ?? "default";
    const runDir = resolve(sourceRoot, "runs", runId);
    const wsRunDir = resolve(sourceRoot, "workspaces", workspaceId, "runs", runId);

    const effectiveDir = existsSync(runDir) ? runDir
      : existsSync(wsRunDir) ? wsRunDir
      : undefined;

    if (!effectiveDir) {
      stderr.write(`aicr replay: run directory not found at ${runDir} or ${wsRunDir}.\n`);
      stderr.write("Run persistence is available after a review completes with run archiving enabled.\n");
      return 1;
    }

    const eventPath = resolve(effectiveDir, "event.json");
    const problemsPath = resolve(effectiveDir, "problems.json");
    const promptPath = resolve(effectiveDir, "prompt.md");

    const result: Record<string, unknown> = { runId };
    if (existsSync(eventPath)) {
      try {
        result.event = JSON.parse(readFileSync(eventPath, "utf8"));
      } catch {
        result.event = null;
      }
    }
    if (existsSync(problemsPath)) {
      try {
        result.problems = JSON.parse(readFileSync(problemsPath, "utf8"));
      } catch {
        result.problems = null;
      }
    }
    if (existsSync(promptPath)) {
      result.prompt = readFileSync(promptPath, "utf8");
    }
    try {
      const entries = readdirSync(effectiveDir);
      result.availableFiles = entries;
    } catch {
      result.availableFiles = [];
    }

    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "memory") {
    const subcommand = positionals[1] ?? "show";
    const workspaceId = values.workspace ?? "default";
    const sourceRoot = resolve(cwd, values["source-root"] ?? ".");
    const memoryDir = resolve(sourceRoot, "workspaces", workspaceId, "memory");
    const indexPath = resolve(memoryDir, "INDEX.json");

    if (subcommand === "clear") {
      const scope = values.scope;
      if (scope && !["false-positives", "recurring-issues", "hot-paths", "repo-conventions", "all"].includes(scope)) {
        stderr.write(`aicr memory clear: invalid --scope "${scope}". Valid scopes: false-positives, recurring-issues, hot-paths, repo-conventions, all\n`);
        return 1;
      }

      if (!existsSync(memoryDir)) {
        stdout.write(`${JSON.stringify({
          workspaceId,
          action: "clear",
          scope: scope ?? "all",
          cleared: true,
          message: "Memory directory does not exist; nothing to clear.",
        }, null, 2)}\n`);
        return 0;
      }

      stdout.write(`${JSON.stringify({
        workspaceId,
        action: "clear",
        scope: scope ?? "all",
        cleared: true,
      }, null, 2)}\n`);
      return 0;
    }

    if (subcommand !== "show") {
      stderr.write(`aicr memory: unknown subcommand "${subcommand}". Supported: show, clear.\n`);
      return 1;
    }

    if (!existsSync(indexPath)) {
      stdout.write(`${JSON.stringify({
        workspaceId,
        entries: [],
        message: "No memory index found. Memory is created after the first review run completes.",
      }, null, 2)}\n`);
      return 0;
    }

    try {
      const indexJson = JSON.parse(readFileSync(indexPath, "utf8"));
      const entries = indexJson.entries ?? [];

      if (!values.all) {
        stdout.write(`${JSON.stringify({
          workspaceId,
          entries,
          entryCount: entries.length,
        }, null, 2)}\n`);
        return 0;
      }

      const memoryFiles: Record<string, string> = {};
      for (const entry of entries) {
        const filePath = resolve(memoryDir, `runs/${entry.id}.md`);
        if (existsSync(filePath)) {
          memoryFiles[entry.id] = readFileSync(filePath, "utf8");
        }
      }

      stdout.write(`${JSON.stringify({
        workspaceId,
        entries,
        entryCount: entries.length,
        ...(Object.keys(memoryFiles).length > 0 ? { files: memoryFiles } : {}),
      }, null, 2)}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`aicr memory show failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "lint") {
    try {
      const checks: Array<Record<string, unknown>> = [];

      const defaultConfigPath = resolve(cwd, "config.yaml");
      const configPath = values.config
        ? resolve(cwd, values.config)
        : existsSync(defaultConfigPath)
          ? defaultConfigPath
          : undefined;

      if (configPath) {
        const config = await loadConfigFile(configPath);
        checks.push({
          kind: "config",
          path: configPath,
          ok: true,
          triggers: config.triggers.length,
          outputChannels: config.outputs.channels.length,
          workspaces: Object.keys(config.workspaces.instances).length,
        });
      }

      if (values.template) {
        const templatePath = resolve(cwd, values.template);
        const templateKind = parseTemplateKind(values["template-kind"], values.template);
        const source = readFileSync(templatePath, "utf8");
        const rendered = renderTemplate(
          source,
          createSampleTemplateContext(templateKind),
          `cli-lint:${templatePath}:${templateKind}`,
        );
        const markdown = fixMarkdown(rendered);
        checks.push({
          kind: "template",
          path: templatePath,
          templateKind,
          channelKind: values["channel-kind"] ?? "custom_summary",
          ok: true,
          renderedBytes: Buffer.byteLength(rendered, "utf8"),
          markdownChanged: markdown.changed,
          warningCount: markdown.warnings.length,
          warnings: markdown.warnings,
          fixableViolationCount: markdown.violations.length,
        });
      }

      if (checks.length === 0) {
        stderr.write("aicr lint requires --config, --template, or a config.yaml in the current directory.\n");
        return 1;
      }

      stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`aicr lint failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "eval") {
    try {
      const evalDir = values["eval-dir"]
        ? resolve(cwd, values["eval-dir"])
        : resolve(cwd, "eval");
      if (!existsSync(evalDir)) {
        stderr.write(`aicr eval: directory not found at ${evalDir}\n`);
        return 1;
      }

      const exampleFiles = readdirSync(evalDir).filter((f) => f.endsWith(".json"));
      if (exampleFiles.length === 0) {
        stderr.write(`aicr eval: no .json example files found in ${evalDir}\n`);
        return 1;
      }

      const configPath = values.config
        ? resolve(cwd, values.config)
        : resolve(cwd, "config.yaml");
      if (!existsSync(configPath)) {
        stderr.write(`aicr eval: config file not found at ${configPath}\n`);
        return 1;
      }

      const config = await loadConfigFile(configPath);
      const basePromptPath = resolve(cwd, values["base-prompt"] ?? "prompts/system/code-reviewer.system.md");
      const baseSystemPrompt = await loadSystemPromptTemplate(basePromptPath);
      const serverOptions = await bootstrapServerApp({
        config,
        baseSystemPrompt,
        baseDir: cwd,
      });
      const orchestration = serverOptions.reviewOrchestration;
      if (!orchestration) {
        stderr.write("aicr eval: failed to initialize review orchestration.\n");
        return 1;
      }

      const examples: EvalExample[] = [];
      for (const file of exampleFiles) {
        const raw = JSON.parse(readFileSync(resolve(evalDir, file), "utf8"));
        examples.push(raw);
      }

      const reviewFn = async (example: EvalExample): Promise<EvalReviewOutput> => {
        const reviewEvent = createReviewEvent({
          triggerName: "eval",
          provider: "gitea",
          workspaceId: "eval",
          targetKind: "pull_request",
          repoRef: "eval/repo",
          reason: `eval:${example.id}`,
          headSha: "eval-sha",
          changedFiles: [...example.changedFiles],
          author: {},
        });

        const result = await runReviewOrchestration(
          {
            reviewEvent,
            payload: null,
            provider: "gitea",
            eventName: "eval",
          },
          {
            baseSystemPrompt: orchestration.baseSystemPrompt,
            sourceRootResolver: () => cwd,
            vcs: orchestration.vcs,
            ...(orchestration.vcsFactory ? { vcsFactory: orchestration.vcsFactory } : {}),
            llm: orchestration.llm,
            model: orchestration.model,
            dryRun: true,
            taskContextBuilder: () => example.diff,
          },
        );

        return {
          problems: result.outputState.problems.map((p) => ({
            file: p.file,
            line: p.line,
            severity: p.severity,
            category: p.category,
            message: p.message,
          })),
          ...(result.outputState.skipReason ? { skipReason: result.outputState.skipReason } : {}),
          ...(result.outputState.summaries[0]?.markdown ? { summary: result.outputState.summaries[0].markdown } : {}),
        };
      };

      const summary = await runEval({ examples, reviewFn });
      stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return summary.failed > 0 ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`aicr eval failed: ${message}\n`);
      return 1;
    }
  }

  logger.info({ command }, "CLI command scaffolded but not implemented yet");
  stdout.write(`Command "${command}" is scaffolded but not implemented yet.\n`);
  return 0;
}

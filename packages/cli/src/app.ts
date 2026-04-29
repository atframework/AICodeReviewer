import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  createDefaultLogger,
  createReviewEvent,
  loadConfigFile,
  loadSystemPromptTemplate,
  prepareReviewPrompt,
  summarizePreparedReviewPrompt,
} from "@aicr/core";
import {
  bootstrapServerApp,
  createServerApp,
  createVcsAdapterFromConfig,
  createLlmClientFromModelSpec,
  resolveModelSpecFromConfig,
  runReviewOrchestration,
  serveAsync,
  summarizeReviewOrchestrationForWebhook,
} from "@aicr/server";

const helpText = `AICodeReviewer CLI

Usage:
  aicr <command> [options]

Commands:
  serve    Start the webhook server
  review   Run a code review (prompt preparation or full dry-run)
  replay   Replay a stored review run scaffold
  memory   Inspect or clear workspace memory scaffold
  lint     Validate templates or config scaffold
  doctor   Print environment diagnostics
  help     Show this message

Options:
  --config <path>         Path to config YAML file
  --workspace <id>        Workspace ID
  --repo <ref>            Repository reference (owner/repo)
  --provider <name>       Trigger provider (gitea, forgejo, github, etc.)
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

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
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
      const port = parseOptionalInteger(values.port, "--port") ?? 8080;

      const serverOptions = bootstrapServerApp({
        config,
        baseSystemPrompt,
        baseDir: cwd,
      });
      const app = createServerApp(serverOptions);

      await serveAsync(app, { port });
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
      const validProviders = [
        "gitea",
        "forgejo",
        "github",
        "gitlab",
        "p4",
        "svn",
        "scheduled",
        "manual",
      ] as const;
      if (!validProviders.includes(provider as (typeof validProviders)[number])) {
        stderr.write(`aicr review: invalid provider "${provider}". Must be one of: ${validProviders.join(", ")}.\n`);
        return 1;
      }
      const reviewEvent = createReviewEvent({
        triggerName: values.trigger ?? "manual-cli",
        provider: provider as (typeof validProviders)[number],
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

        const model = resolveModelSpecFromConfig(config);
        const llmClient = createLlmClientFromModelSpec(model);
        const vcs = createVcsAdapterFromConfig(config, sourceRoot);

        const result = await runReviewOrchestration(
          {
            reviewEvent,
            payload: null,
            provider: "gitea",
            eventName: "manual",
          },
          {
            baseSystemPrompt,
            sourceRootResolver: () => sourceRoot,
            vcs,
            llm: llmClient,
            model,
            dryRun: true,
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
              findings: result.outputState.findings,
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

  logger.info({ command }, "CLI command scaffolded but not implemented yet");
  stdout.write(`Command "${command}" is scaffolded but not implemented yet.\n`);
  return 0;
}

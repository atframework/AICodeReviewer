import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  createDefaultLogger,
  createReviewEvent,
  loadSystemPromptTemplate,
  prepareReviewPrompt,
  summarizePreparedReviewPrompt,
} from "@aicr/core";

const helpText = `AICodeReviewer CLI

Usage:
  aicr <command> [options]

Commands:
  serve    Start the webhook server scaffold
  review   Prepare a real review prompt from the current workspace
  replay   Replay a stored review run scaffold
  memory   Inspect or clear workspace memory scaffold
  lint     Validate templates or config scaffold
  doctor   Print environment diagnostics
  help     Show this message
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
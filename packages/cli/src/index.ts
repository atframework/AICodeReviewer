#!/usr/bin/env node

import { parseArgs } from "node:util";

import { createDefaultLogger } from "@aicr/core";

const helpText = `AICodeReviewer CLI

Usage:
  aicr <command> [options]

Commands:
  serve    Start the webhook server scaffold
  review   Execute a review run scaffold
  replay   Replay a stored review run scaffold
  memory   Inspect or clear workspace memory scaffold
  lint     Validate templates or config scaffold
  doctor   Print environment diagnostics
  help     Show this message
`;

function printHelp(): void {
  process.stdout.write(`${helpText}\n`);
}

async function main(): Promise<void> {
  const logger = createDefaultLogger({ serviceName: "aicr-cli" });
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    process.stdout.write("0.1.0\n");
    return;
  }

  const command = positionals[0];

  if (values.help || command === undefined || command === "help") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    process.stdout.write(
      `${JSON.stringify(
        {
          cwd: process.cwd(),
          node: process.version,
          config: values.config ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  logger.info({ command }, "CLI command scaffolded but not implemented yet");
  process.stdout.write(`Command "${command}" is scaffolded but not implemented yet.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`aicr failed: ${message}\n`);
  process.exitCode = 1;
});
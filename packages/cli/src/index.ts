#!/usr/bin/env node

import { runCli } from "./app.js";

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`aicr failed: ${message}\n`);
  process.exitCode = 1;
});
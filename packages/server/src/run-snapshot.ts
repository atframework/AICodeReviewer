import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReviewEvent } from "@aicr/core";

import type { ReviewOrchestrationWebhookSummary } from "./review-orchestrator.js";

export interface RunSnapshot {
  readonly runId: string;
  readonly timestamp: string;
  readonly reviewEvent: ReviewEvent;
  readonly reviewRun: ReviewOrchestrationWebhookSummary;
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertSafeRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new TypeError("Invalid run snapshot runId.");
  }
}

export async function saveRunSnapshot(runsDir: string, snapshot: RunSnapshot): Promise<void> {
  assertSafeRunId(snapshot.runId);
  const dir = join(runsDir, snapshot.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "run.json");
  await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
}

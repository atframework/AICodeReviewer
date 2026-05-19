import { describe, expect, it } from "vitest";

import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { saveRunSnapshot } from "../src/run-snapshot.js";

function createSnapshot(runId = "test-run-123") {
  return {
    runId,
    timestamp: "2026-05-19T12:00:00Z",
    reviewEvent: {
      triggerName: "gitea-internal",
      workspaceId: "ws",
      repoRef: "owent/example",
      headSha: "abc123",
      changedFiles: ["src/app.ts"],
      targetKind: "pr" as const,
      provider: "gitea" as const,
    },
    reviewRun: {
      status: "published" as const,
      changedFileCount: 1,
      fetchedFileCount: 1,
      diffFileCount: 1,
      promptTokenEstimate: 1000,
      problemCount: 2,
      summaryCount: 1,
      contextRequestCount: 0,
      dispatchCount: 2,
      model: { providerId: "openai", modelId: "gpt-4" },
    },
  };
}

describe("run-snapshot", () => {
  it("saves a run snapshot to runs/<runId>/run.json", async () => {
    const runsDir = join(tmpdir(), "aicr-test-runs-" + randomUUID());
    await mkdir(runsDir, { recursive: true });

    try {
      const snapshot = createSnapshot();

      await saveRunSnapshot(runsDir, snapshot);

      const path = join(runsDir, "test-run-123", "run.json");
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as typeof snapshot;
      expect(parsed.runId).toBe("test-run-123");
      expect(parsed.reviewRun.status).toBe("published");
      expect(parsed.reviewRun.problemCount).toBe(2);
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  it("rejects run IDs that are not a single safe directory segment", async () => {
    const runsDir = join(tmpdir(), "aicr-test-runs-" + randomUUID());
    await mkdir(runsDir, { recursive: true });

    try {
      await expect(saveRunSnapshot(runsDir, createSnapshot("../escape"))).rejects.toThrow("Invalid run snapshot runId");
      await expect(saveRunSnapshot(runsDir, createSnapshot("nested/run"))).rejects.toThrow("Invalid run snapshot runId");
      await expect(saveRunSnapshot(runsDir, createSnapshot(""))).rejects.toThrow("Invalid run snapshot runId");
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});

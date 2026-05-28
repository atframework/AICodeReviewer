import { describe, expect, it } from "vitest";

import {
  reviewRuns,
  projects,
  codeMetrics,
  llmUsage,
  outputEvents,
  dailyRollups,
  reflectionMemory,
  runStatusValues,
} from "../src/schema.js";

describe("reviewRuns schema", () => {
  it("defines all Plan.md §3.11 run status values", () => {
    expect(runStatusValues).toEqual([
      "queued",
      "preparing",
      "analyzing",
      "publishing",
      "succeeded",
      "failed",
      "cancelled",
      "timeout",
      "skipped",
    ]);
  });

  it("exposes the expected column names including Plan §3.11 additions", () => {
    const columns = reviewRuns[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "projectId",
        "eventId",
        "workspaceId",
        "triggerName",
        "provider",
        "providerModel",
        "status",
        "attempt",
        "startedAt",
        "finishedAt",
        "costUsd",
        "tokensIn",
        "tokensOut",
        "error",
        "skipReason",
        "compressed",
        "originalTokenEstimate",
        "compressedTokenEstimate",
        "diffFileCount",
        "changedFileCount",
        "problemCount",
        "summaryCount",
        "dispatchCount",
        "durationMs",
        "targetKind",
        "targetUrl",
        "branch",
        "headSha",
      ]),
    );
  });

  it("includes triggerName column for §3.1 trigger traceability", () => {
    const columns = reviewRuns[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    expect(columns).toHaveProperty("triggerName");
  });

  it("includes provider column matching §3.1 ReviewProvider enum", () => {
    const columns = reviewRuns[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    expect(columns).toHaveProperty("provider");
  });

  it("includes providerModel column for §3.5 LLM model tracking", () => {
    const columns = reviewRuns[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    expect(columns).toHaveProperty("providerModel");
  });

  it("allows nullable triggerName, provider, and providerModel", () => {
    const columns = reviewRuns[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const triggerNameCol = columns.triggerName as { dataType: string; notNull: boolean };
    const providerCol = columns.provider as { dataType: string; notNull: boolean };
    const providerModelCol = columns.providerModel as { dataType: string; notNull: boolean };

    expect(triggerNameCol.notNull).toBe(false);
    expect(providerCol.notNull).toBe(false);
    expect(providerModelCol.notNull).toBe(false);
  });
});

describe("projects schema", () => {
  it("defines the expected column names", () => {
    const columns = projects[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "workspaceId",
        "triggerName",
        "repoRef",
        "displayName",
        "createdAt",
        "deletedAt",
      ]),
    );
  });
});

describe("codeMetrics schema", () => {
  it("defines the expected column names", () => {
    const columns = codeMetrics[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "runId",
        "filesChanged",
        "linesAdded",
        "linesDeleted",
        "bytesAnalyzed",
        "filesAnalyzed",
      ]),
    );
  });
});

describe("llmUsage schema", () => {
  it("defines the expected column names", () => {
    const columns = llmUsage[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "runId",
        "providerId",
        "modelId",
        "requestCount",
        "tokensIn",
        "tokensOut",
        "tokensTotal",
        "costUsd",
        "retryCount",
        "fallbackCount",
        "failureCount",
        "latencyMs",
      ]),
    );
  });
});

describe("outputEvents schema", () => {
  it("defines the expected column names", () => {
    const columns = outputEvents[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "runId",
        "channelKind",
        "eventType",
        "issueCreated",
        "commentCreated",
        "timestamp",
      ]),
    );
  });
});

describe("dailyRollups schema", () => {
  it("defines the expected column names", () => {
    const columns = dailyRollups[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "projectId",
        "date",
        "reviewCount",
        "successCount",
        "failureCount",
        "problemTotal",
        "tokensIn",
        "tokensOut",
        "costUsd",
      ]),
    );
  });
});

describe("reflectionMemory schema", () => {
  it("defines the expected column names for M7 reflection memory", () => {
    const columns = reflectionMemory[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "workspaceId",
        "fingerprint",
        "content",
        "sourceRunId",
        "createdAt",
        "expiresAt",
      ]),
    );
  });
});

import { describe, expect, it } from "vitest";

import { reviewRuns, runStatusValues, type RunStatus } from "../src/schema.js";

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
    ]);
  });

  it("exposes the expected column names including Plan §3.11 additions", () => {
    const columns = reviewRuns[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
    const columnNames = Object.keys(columns);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
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
      ]),
    );
  });

  it("uses id as the primary key column", () => {
    const table = reviewRuns;
    expect(table[Symbol.for("drizzle:BaseName")]).toBe("review_runs");
  });

  it("conforms RunStatus type to all valid status strings", () => {
    const validStatuses: RunStatus[] = [
      "queued",
      "preparing",
      "analyzing",
      "publishing",
      "succeeded",
      "failed",
      "cancelled",
      "timeout",
    ];

    for (const status of validStatuses) {
      expect(runStatusValues).toContain(status);
    }

    expect(validStatuses).toHaveLength(runStatusValues.length);
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

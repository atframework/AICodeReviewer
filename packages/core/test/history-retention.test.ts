import { describe, expect, it } from "vitest";
import { appConfigSchema, parseEffectiveConfig } from "../src/config.js";
import { historyCutoff, resolveHistoryRetention } from "../src/history-retention.js";
import { applyConfigChangeset, mergeConfigSources, type DatabaseConfigDocument } from "../src/config-source.js";
import { buildConfigUiSpec } from "../src/config-ui-spec.js";
import { createEditorSession, sessionEncode, sessionSetValue } from "../src/config-form-state.js";
import type { ConfigDecodeInput } from "../src/config-ui-runtime.js";

describe("admin history configuration", () => {
  it("saves history fields on Advanced without encoding bootstrap-owned defaults", () => {
    const page = buildConfigUiSpec().pages.find(page => page.id === "advanced")!;
    const base: ConfigDecodeInput = { fields: [
      { path: "config_sources.secret_refs", source: "file", effectiveValue: ["FILE_ONLY"], editable: false, overriddenValues: [] },
      { path: "storage.retention.recent_runs.max_count", source: "default", effectiveValue: 2000, editable: false, overriddenValues: [] },
      { path: "storage.retention.events.max_count", source: "database", effectiveValue: 2000, editable: true, overriddenValues: [] },
      { path: "storage.retention.events.max_age_months", source: "file", effectiveValue: 3, editable: true, overriddenValues: [] },
    ] };
    let session = createEditorSession(page, base);
    session = sessionSetValue(session, "config_sources:secret_refs", []);
    // The server's field permission also wins over a writable schema field.
    session = sessionSetValue(session, "storage:retention.recent_runs.max_count", 333);
    session = sessionSetValue(session, "storage:retention.events.max_count", 1300);
    const { operations } = sessionEncode(session, base);
    expect(operations).toEqual([{ op: "set", path: ["storage", "retention", "events", "max_count"], value: 1300 }]);
  });

  it("defaults to six calendar months with bounded history counts without changing old snapshot shape", () => {
    const config = appConfigSchema.parse({});
    expect(config.storage.retention).toEqual({ deleted_project_grace_days: 30 });
    expect(resolveHistoryRetention(config.storage.retention)).toEqual({
      recent_runs: { max_count: 2000, max_age_months: 6 },
      events: { max_count: 2000, max_age_months: 6 },
      queue: { max_count: 1000, max_age_months: 6 },
    });
    expect(historyCutoff({ max_count: 1, max_age_months: 6 }, Date.parse("2024-08-31T12:30:00Z"))).toBe(Date.parse("2024-02-29T12:30:00Z"));
    expect(historyCutoff({ max_count: 1, max_age_months: 6 }, Date.parse("2025-08-31T12:30:00Z"))).toBe(Date.parse("2025-02-28T12:30:00Z"));
  });

  it.each(["recent_runs", "events", "queue"] as const)("uses database overrides and resets %s to file/default values", (section) => {
    const file = { storage: { retention: { [section]: { max_count: 123, max_age_months: 3 } } } };
    const path = ["storage", "retention", section, "max_count"];
    const database = applyConfigChangeset({}, [{ op: "set", path, value: 456 }], { formatVersion: 2 });
    const read = (document: DatabaseConfigDocument, fileDocument = file) => resolveHistoryRetention(parseEffectiveConfig(
      mergeConfigSources({ file: fileDocument, database: document, formatVersion: 2 }).document, 2).storage.retention)[section];
    expect(read(database)).toEqual({ max_count: 456, max_age_months: 3 });
    const reset = applyConfigChangeset(database, [{ op: "unset", path }], { formatVersion: 2 });
    expect(read(reset)).toEqual({ max_count: 123, max_age_months: 3 });
    expect(read(reset, {} as typeof file)).toEqual({ max_count: section === "queue" ? 1000 : 2000, max_age_months: 6 });
    const fields = buildConfigUiSpec().pages.flatMap(page => page.sections.flatMap(part => part.fields));
    const field = fields.find(field => field.id === `storage:retention.${section}.max_count`)!;
    expect(field.defaultValue).toBe(section === "queue" ? 1000 : 2000);
    expect(field.readonlyReason).toBeUndefined();
  });

  it.each([0, -1, 1.5, 1_000_001])("rejects invalid history counts %s", (max_count) => {
    expect(appConfigSchema.safeParse({ storage: { retention: { events: { max_count } } } }).success).toBe(false);
  });
});

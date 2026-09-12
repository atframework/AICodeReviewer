import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CONFIG_FIELD_INVENTORY,
  CONFIG_FIELD_INVENTORY_BY_PATH,
  appConfigSchema,
  collectSchemaFieldPaths,
  stableSerialize,
  valueKindFromSchemaType,
} from "../src/index.js";

/**
 * U24 consistency gate (spec §8.2): the permanent field inventory must cover
 * exactly the schema-accepted leaves, with matching value kinds and defaults.
 * A schema change without an inventory update fails here, and so does an
 * inventory row pointing at a field the schema no longer accepts.
 */
describe("config field inventory gate (U24)", () => {
  const leaves = new Map(collectSchemaFieldPaths(appConfigSchema).map((leaf) => [leaf.path, leaf]));

  it("every schema leaf has exactly one declared inventory row with matching kind and default", () => {
    const problems: string[] = [];
    const declared = new Map<string, (typeof CONFIG_FIELD_INVENTORY)[number]>();
    for (const row of CONFIG_FIELD_INVENTORY) {
      if (row.schemaStatus === "passthrough") {
        if (leaves.has(row.path)) {
          problems.push(`passthrough row shadows a schema leaf: ${row.path}`);
        }
        continue;
      }
      if (declared.has(row.path)) {
        problems.push(`duplicate inventory row: ${row.path}`);
      }
      declared.set(row.path, row);
      const leaf = leaves.get(row.path);
      if (leaf === undefined) {
        problems.push(`inventory row has no schema leaf: ${row.path}`);
        continue;
      }
      if (row.schemaStatus === "removed" && leaf.typeName !== "ZodNever") {
        problems.push(`removed row is not a ZodNever leaf: ${row.path} (${leaf.typeName})`);
      }
      const kind = valueKindFromSchemaType(leaf.typeName);
      if (row.valueKind !== kind) {
        problems.push(`value kind mismatch at ${row.path}: inventory=${row.valueKind} schema=${kind}`);
      }
      if (row.hasDefault !== leaf.hasDefault) {
        problems.push(`default presence mismatch at ${row.path}: inventory=${row.hasDefault} schema=${leaf.hasDefault}`);
      } else if (row.hasDefault && stableSerialize(row.defaultValue) !== stableSerialize(leaf.defaultValue)) {
        problems.push(`default value mismatch at ${row.path}`);
      }
    }
    for (const path of leaves.keys()) {
      if (!declared.has(path)) {
        problems.push(`schema leaf has no inventory row: ${path}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("inventory rows are well-formed: ownership, entity kind, and UI control", () => {
    const controls = new Set(["text", "number", "toggle", "select", "multiselect", "ordered-list", "map", "secret-ref", "matcher", "path-template"]);
    for (const row of CONFIG_FIELD_INVENTORY) {
      expect(controls.has(row.uiControl), `ui control for ${row.path}`).toBe(true);
      expect(["bootstrap", "business", "entity"]).toContain(row.ownership);
      if (row.ownership === "entity") {
        expect(row.entityKind, `entity kind for ${row.path}`).toBeDefined();
      }
      if (row.schemaStatus === "removed") {
        expect(row.valueKind, `removed row kind for ${row.path}`).toBe("never");
        expect(row.wired, `removed row wiring for ${row.path}`).toBe(false);
      }
      if (!row.wired) {
        expect(row.status, `unwired row must explain itself: ${row.path}`).toBeDefined();
      }
    }
  });

  it("unwired review fields are exactly the audited schema-only set", () => {
    const unwiredGlobals = CONFIG_FIELD_INVENTORY.filter(
      (row) => row.path.startsWith("review.") && !row.path.startsWith("review.auto_commit") && !row.wired,
    ).map((row) => row.path);
    expect(unwiredGlobals.sort()).toEqual(
      [
        "review.commit_strategy",
        "review.fetch_extra.allow_paths",
        "review.fetch_extra.max_bytes",
        "review.fetch_extra.max_files",
        "review.include",
        "review.exclude",
        "review.incremental",
        "review.languages_auto_detect",
        "review.max_files",
        "review.max_patch_bytes",
        "review.reflection.memory.max_size_kb",
        "review.skip_lgtm",
      ].sort(),
    );
  });

  it("CONFIG_FIELD_INVENTORY_BY_PATH mirrors the inventory", () => {
    expect(CONFIG_FIELD_INVENTORY_BY_PATH.size).toBe(CONFIG_FIELD_INVENTORY.length);
    for (const row of CONFIG_FIELD_INVENTORY) {
      expect(CONFIG_FIELD_INVENTORY_BY_PATH.get(row.path)).toBe(row);
    }
  });

  it("all workspace instance fields belong to the locked workspace entity", () => {
    const fields = CONFIG_FIELD_INVENTORY.filter((field) => field.path.startsWith("workspaces.instances.*."));
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field, field.path).toMatchObject({ ownership: "entity", entityKind: "workspace" });
    }
  });
});

describe("collectSchemaFieldPaths", () => {
  it("is deterministic across runs", () => {
    const first = collectSchemaFieldPaths(appConfigSchema);
    const second = collectSchemaFieldPaths(appConfigSchema);
    expect(stableSerialize(first)).toBe(stableSerialize(second));
  });

  it("fails closed on schema constructs it does not understand", () => {
    const weird = z.object({ u: z.discriminatedUnion("kind", [z.object({ kind: z.literal("a") })]) });
    expect(() => collectSchemaFieldPaths(weird)).toThrow(TypeError);
    const nestedUnion = z.object({
      u: z.union([z.object({ a: z.object({ b: z.string() }).strict() }).strict(), z.object({ c: z.string() }).strict()]),
    });
    expect(() => collectSchemaFieldPaths(nestedUnion)).toThrow(TypeError);
  });

  it("classifies unions of primitive-only strict objects as value leaves", () => {
    const matcherLike = z.object({
      u: z.union([
        z.object({ exact: z.string() }).strict(),
        z.object({ glob: z.string(), ignore_case: z.boolean().optional() }).strict(),
      ]),
    });
    const leaves = collectSchemaFieldPaths(matcherLike);
    expect(leaves.map((leaf) => leaf.path)).toEqual(["u"]);
    expect(leaves[0]?.typeName).toBe("union");
  });

  it("captures enum options and inherited object-level defaults", () => {
    const leaves = new Map(collectSchemaFieldPaths(appConfigSchema).map((leaf) => [leaf.path, leaf]));
    expect(leaves.get("agent.default")?.enumValues).toContain("kilo");
    expect(leaves.get("review.include")?.defaultValue).toEqual(["**/*"]);
    expect(leaves.get("agent.sandbox.kind")?.defaultValue).toBe("docker");
  });

  it("matches parsing when a parent default supplies a value overriding a child default", () => {
    const schema = z.object({ choice: z.string().default("child") }).default({ choice: "parent" });
    expect(collectSchemaFieldPaths(schema)[0]?.defaultValue).toBe(schema.parse(undefined).choice);
  });
});

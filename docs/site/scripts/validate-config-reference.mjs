// Validate the docs-site configuration field reference against the Zod schema
// code source of truth (docs/ai/documentation-site-plan.md §7 "配置参考字段
// 覆盖检查", M11-P4).
//
// Checks, for both locales (en + zh-cn) of reference/config-fields.md:
//   1. Schema -> docs: every settable leaf field in `appConfigSchema` must be
//      documented, either as its own row or under an explicitly allowlisted
//      subtree-summary row (e.g. `llm.model_catalog.overrides`).
//   2. Docs -> schema: every field path listed in the reference must exist in
//      the schema, so invented or renamed fields fail.
//   3. Locale parity: en and zh-cn must list the exact same field-path set.
//   4. Enum reference table: each row's values must equal the schema enum
//      options (order included), in both locales.
//
// Requires Node >= 23.6 for native TypeScript type stripping; the docs CI job
// uses Node 24.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { relative } from "node:path";

import { isSchemaLeafDocumented } from "./validation-helpers.mjs";

if (!process.features.typescript) {
  console.error(
    "validate-config-reference requires Node >= 23.6 with native TypeScript type stripping.",
  );
  process.exit(1);
}

register(new URL("./ts-source-hooks.mjs", import.meta.url));

const { appConfigSchema } = await import(
  new URL("../../../packages/core/src/config.ts", import.meta.url)
);

const docsRoot = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const referencePages = ["en/reference/config-fields.md", "zh-cn/reference/config-fields.md"];

// ---------------------------------------------------------------------------
// Zod schema walker
// ---------------------------------------------------------------------------

const PRIMITIVE_TYPES = new Set([
  "ZodString",
  "ZodNumber",
  "ZodBoolean",
  "ZodBigInt",
  "ZodDate",
  "ZodLiteral",
  "ZodEnum",
  "ZodNativeEnum",
  "ZodAny",
  "ZodUnknown",
  "ZodNull",
  "ZodUndefined",
  "ZodVoid",
]);

// Wrapper types and the `_def` key holding the wrapped schema. ZodDefault in
// zod 3.25 has no unwrap(); reading `_def.innerType` uniformly avoids version
// differences between optional/default/nullable/readonly/catch. ZodLazy uses
// a getter and is handled separately below.
const WRAPPER_INNER_KEYS = {
  ZodOptional: "innerType",
  ZodDefault: "innerType",
  ZodNullable: "innerType",
  ZodReadonly: "innerType",
  ZodCatch: "innerType",
};

function unwrap(schema) {
  let current = schema;
  while (current && current._def) {
    const typeName = current._def.typeName;
    const innerKey = WRAPPER_INNER_KEYS[typeName];
    if (innerKey && current._def[innerKey]) {
      current = current._def[innerKey];
      continue;
    }
    if (typeName === "ZodEffects") {
      // z.preprocess wraps the output schema in _def.schema instead of
      // innerType().
      current =
        current._def.effect?.type === "preprocess"
          ? current._def.schema
          : current.innerType();
      continue;
    }
    if (typeName === "ZodLazy") {
      current = current._def.getter();
      continue;
    }
    if (typeName === "ZodPipeline") {
      current = current._def.out;
      continue;
    }
    return current;
  }
  return current;
}

function isPrimitiveLike(schema) {
  const inner = unwrap(schema);
  const typeName = inner._def.typeName;
  if (typeName === "ZodUnion" || typeName === "ZodIntersection") {
    const options =
      typeName === "ZodUnion"
        ? inner.options
        : [inner._def.left, inner._def.right];
    return options.every(isPrimitiveLike);
  }
  return PRIMITIVE_TYPES.has(typeName);
}

function enumOptions(schema) {
  const inner = unwrap(schema);
  if (inner._def.typeName === "ZodEnum") {
    return [...inner.options];
  }
  if (inner._def.typeName === "ZodNativeEnum") {
    return Object.values(inner._def.values);
  }
  return undefined;
}

function recordValueSchema(schema) {
  const inner = unwrap(schema);
  return inner._def.valueType ?? inner.valueSchema;
}

// Collect every addressable node path (objects, arrays, records, leaves) and
// the options of enum leaves. Array-of-object children carry a `[]` segment;
// record children carry an `<id>` placeholder segment. `ZodNever` fields are
// rejected by validation and intentionally not treated as settable fields.
function collectSchemaPaths(schema, path, nodes, enums) {
  const inner = unwrap(schema);
  const typeName = inner._def.typeName;

  if (typeName === "ZodNever") {
    return;
  }
  if (typeName === "ZodObject") {
    if (path) nodes.add(path);
    for (const [key, child] of Object.entries(inner.shape)) {
      collectSchemaPaths(child, path ? `${path}.${key}` : key, nodes, enums);
    }
    return;
  }
  if (typeName === "ZodArray") {
    if (isPrimitiveLike(inner.element)) {
      nodes.add(path);
      return;
    }
    collectSchemaPaths(inner.element, `${path}[]`, nodes, enums);
    return;
  }
  if (typeName === "ZodRecord") {
    nodes.add(path);
    collectSchemaPaths(recordValueSchema(inner), `${path}.<id>`, nodes, enums);
    return;
  }
  if (typeName === "ZodUnion" || typeName === "ZodIntersection") {
    if (isPrimitiveLike(inner)) {
      nodes.add(path);
      return;
    }
    const options =
      typeName === "ZodUnion" ? inner.options : [inner._def.left, inner._def.right];
    for (const option of options) {
      if (!isPrimitiveLike(option)) {
        collectSchemaPaths(option, path, nodes, enums);
      }
    }
    return;
  }

  nodes.add(path);
  const options = enumOptions(inner);
  if (options) {
    enums.set(path, options);
  }
}

const schemaNodes = new Set();
const schemaEnums = new Map();
collectSchemaPaths(appConfigSchema, "", schemaNodes, schemaEnums);

// Documented fields that the schema accepts via `.passthrough()` without
// declaring them. Each entry must stay truthful: the script fails if an
// allowlisted path ever becomes a declared schema field (then remove it here).
const PASSTHROUGH_DOCUMENTED_FIELDS = new Set([
  // llmProviderSchema is .passthrough(); the thinking tier fields are consumed
  // by the LLM config translation but intentionally not declared in the schema.
  "llm.providers[].reasoning_effort",
  "llm.providers[].thinking_level",
  "llm.providers[].thinking_budget_tokens",
]);

// Only these rows intentionally summarize descendants instead of listing
// every leaf. Keeping the list explicit prevents a generic object row such as
// `llm.retry` from silently hiding a newly added child field.
const DOCUMENTED_SUBTREE_SUMMARIES = new Set([
  "llm.fallback_chain[]",
  "llm.retry.backoff",
  "llm.per_provider_overrides",
  "llm.model_catalog.overrides",
  "outputs.channels[].no_problems",
  "outputs.channels[].severity_label_colors",
  "outputs.channels[].notify_feishu",
  "outputs.author_resolution",
  "outputs.routes.default",
  "queue.rate_limit.per_provider_rps",
  "queue.retry.backoff",
  "compression.per_model_overrides",
  "workspaces.defaults.sandbox",
  "workspaces.defaults.review",
  "workspaces.defaults.outputs",
  "workspaces.instances.<id>.review",
  "workspaces.instances.<id>.outputs",
  "workspaces.instances.<id>.sandbox",
  "workspaces.instances.<id>.triage",
  "workspaces.instances.<id>.prompt",
]);

function normalizeDocPath(value) {
  return value.replaceAll(/<[^>]+>/gu, "<id>").trim();
}

// Every prefix of every schema node, so a doc row pointing at any existing
// schema path (leaf or branch) resolves.
const schemaNodePrefixes = new Set();
for (const node of schemaNodes) {
  const segments = node.split(".");
  for (let i = 1; i <= segments.length; i += 1) {
    schemaNodePrefixes.add(segments.slice(0, i).join("."));
  }
}

for (const field of PASSTHROUGH_DOCUMENTED_FIELDS) {
  if ([field, field.replace(/\[\]$/u, "")].some((candidate) => schemaNodePrefixes.has(candidate))) {
    throw new Error(
      `PASSTHROUGH_DOCUMENTED_FIELDS entry \`${field}\` is now a declared schema field; remove it from the allowlist`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reference page parsing
// ---------------------------------------------------------------------------

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.replaceAll("\\|", "|").trim());
}

function isTableDelimiterRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function parseReferencePage(relativePath) {
  const absolutePath = `${docsRoot}${relativePath}`;
  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/u);
  const fieldPaths = new Set();
  const enumRows = [];

  let tableKind = null;
  for (const line of lines) {
    if (!line.trimStart().startsWith("|")) {
      tableKind = null;
      continue;
    }

    const cells = splitTableRow(line);
    if (isTableDelimiterRow(cells)) {
      continue;
    }
    if (tableKind === null) {
      const header = cells[0];
      if (header === "Field" || header === "字段") {
        tableKind = "field";
      } else if (header === "Concept" || header === "概念") {
        tableKind = "enum";
      } else {
        tableKind = "other";
      }
      continue;
    }
    if (tableKind === "field") {
      const match = cells[0].match(/`([^`]+)`/u);
      if (match) {
        fieldPaths.add(normalizeDocPath(match[1]));
      }
    } else if (tableKind === "enum") {
      enumRows.push({
        concept: cells[0],
        values: [...cells[1].matchAll(/`([^`]+)`/gu)].map((m) => m[1]),
      });
    }
  }

  return { fieldPaths, enumRows, absolutePath };
}

// Ordered mapping of the shared enum-reference table rows to schema paths.
// Both locales must keep this row order; position drift between locales is
// itself an error reported by the parity check below.
const enumConceptPaths = [
  "triggers[].kind",
  "agent.default",
  "agent.sandbox.kind",
  "agent.sandbox.engine",
  "queue.kind",
  "storage.database.kind",
  "storage.cache.kind",
  "storage.object.kind",
  "llm.model_catalog.cache.backend",
  "llm.providers[].kind",
];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const violations = [];

function violation(relativePath, message) {
  violations.push(`${relativePath}: ${message}`);
}

const pages = new Map();
for (const relativePath of referencePages) {
  pages.set(relativePath, parseReferencePage(relativePath));
}

for (const summaryPath of DOCUMENTED_SUBTREE_SUMMARIES) {
  if (!schemaNodePrefixes.has(summaryPath)) {
    throw new Error(
      `DOCUMENTED_SUBTREE_SUMMARIES entry \`${summaryPath}\` no longer exists in the schema`,
    );
  }
  if (![...schemaNodes].some((node) => node.startsWith(`${summaryPath}.`))) {
    throw new Error(
      `DOCUMENTED_SUBTREE_SUMMARIES entry \`${summaryPath}\` has no schema descendants`,
    );
  }
  for (const [relativePath, page] of pages) {
    if (!page.fieldPaths.has(summaryPath)) {
      violation(relativePath, `subtree summary \`${summaryPath}\` is missing from the reference`);
    }
  }
}

for (const [relativePath, page] of pages) {
  // 1. Schema -> docs: every leaf needs an exact row or one of the intentional
  //    subtree summaries above. Arbitrary ancestor rows do not count.
  for (const node of schemaNodes) {
    const isLeaf =
      !schemaNodes.has(`${node}[]`) &&
      !schemaNodes.has(`${node}.<id>`) &&
      ![...schemaNodes].some((other) => other.startsWith(`${node}.`));
    if (isLeaf && !isSchemaLeafDocumented(node, page.fieldPaths, DOCUMENTED_SUBTREE_SUMMARIES)) {
      violation(relativePath, `schema field \`${node}\` is not documented`);
    }
  }

  // 2. Docs -> schema: every documented path must exist in the schema or be a
  //    known passthrough-accepted field.
  for (const fieldPath of page.fieldPaths) {
    const candidates = [fieldPath, fieldPath.replace(/\[\]$/u, "")];
    const known =
      PASSTHROUGH_DOCUMENTED_FIELDS.has(fieldPath) ||
      candidates.some((candidate) => schemaNodePrefixes.has(candidate));
    if (!known) {
      violation(relativePath, `documented field \`${fieldPath}\` does not exist in the schema`);
    }
  }

  // 4. Enum table values must equal schema enum options, in order.
  if (page.enumRows.length !== enumConceptPaths.length) {
    violation(
      relativePath,
      `enum reference table has ${page.enumRows.length} rows, expected ${enumConceptPaths.length} (keep in sync with the script's enumConceptPaths)`,
    );
  } else {
    for (const [index, row] of page.enumRows.entries()) {
      const schemaPath = enumConceptPaths[index];
      const options = schemaEnums.get(schemaPath);
      if (!options) {
        throw new Error(
          `enumConceptPaths entry \`${schemaPath}\` did not resolve to a schema enum; update the script mapping`,
        );
      }
      if (row.values.join(",") !== options.join(",")) {
        violation(
          relativePath,
          `enum row "${row.concept}" lists [${row.values.join(", ")}] but schema \`${schemaPath}\` is [${options.join(", ")}]`,
        );
      }
    }
  }
}

// 3. Locale parity: en and zh-cn must document the same field set.
const [enPage, zhPage] = referencePages.map((path) => pages.get(path));
for (const fieldPath of enPage.fieldPaths) {
  if (!zhPage.fieldPaths.has(fieldPath)) {
    violation("zh-cn/reference/config-fields.md", `field \`${fieldPath}\` is documented in en but missing in zh-cn`);
  }
}
for (const fieldPath of zhPage.fieldPaths) {
  if (!enPage.fieldPaths.has(fieldPath)) {
    violation("en/reference/config-fields.md", `field \`${fieldPath}\` is documented in zh-cn but missing in en`);
  }
}

if (violations.length > 0) {
  console.error("Configuration field reference validation failed:");
  for (const message of violations) {
    console.error(`- ${message}`);
  }
  console.error(
    `\nSchema source of truth: ${relative(process.cwd(), fileURLToPath(new URL("../../../packages/core/src/config.ts", import.meta.url)))}`,
  );
  process.exit(1);
}

console.log(
  `Configuration field reference OK: ${schemaNodes.size} schema paths covered by en + zh-cn reference pages, ${enumConceptPaths.length} enum rows verified.`,
);

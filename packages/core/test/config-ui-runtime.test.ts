import { describe, expect, it } from "vitest";

import {
  decodeDraft,
  decodeMapKey,
  encodeChanges,
  encodeMapKey,
  fieldViewEntryInScope,
  isPlainRecord,
  pageGlobalsFieldPaths,
  parseNumberInput,
  resolveFieldState,
  resolveItemOptions,
  resolveOptions,
  validateUiSpec,
  type ConfigApiFieldError,
  type ConfigDecodeInput,
  type ConfigDraft,
  type ConfigDraftField,
  type ConfigEntityRecordView,
  type ConfigFieldViewEntry,
  type ConfigReferenceData,
  type ConfigUiControlKind,
  type ConfigUiField,
  type ConfigUiOperation,
  type ConfigUiPage,
  type ConfigUiSpec,
  type ConfigUiValueKind,
} from "../src/config-ui-runtime.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeField(
  init: { id: string; path: readonly string[]; control: ConfigUiControlKind; valueKind: ConfigUiValueKind } & Partial<ConfigUiField>,
): ConfigUiField {
  const { id, path, control, valueKind, ...rest } = init;
  return {
    id,
    path,
    control,
    valueKind,
    labelKey: `config.fields.${id}`,
    label: `Label ${id}`,
    section: "main",
    optional: true,
    binding: "value",
    hasDefault: false,
    ...rest,
  };
}

function makePage(init: {
  id: string;
  entity?: ConfigUiPage["entity"];
  globals?: boolean;
  fields?: readonly ConfigUiField[];
  sections?: ConfigUiPage["sections"];
}): ConfigUiPage {
  const { id, entity, globals, fields, sections } = init;
  return {
    id,
    label: `Page ${id}`,
    ...(entity !== undefined ? { entity } : {}),
    ...(globals !== undefined ? { globals } : {}),
    sections: sections ?? [{ id: "main", label: "Main", fields: fields ?? [] }],
  };
}

function makeSpec(pages: readonly ConfigUiPage[], optionsSources: readonly string[] = []): ConfigUiSpec {
  return {
    protocolVersion: 1,
    pages,
    optionsSources: optionsSources.map((id) => ({ id, label: `Source ${id}` })),
  };
}

function makeRecord(value: unknown, init?: Partial<ConfigEntityRecordView>): ConfigEntityRecordView {
  return {
    id: "rec-1",
    name: "rec-1",
    enabled: true,
    value,
    source: "database",
    readonly: false,
    shadowedByFile: false,
    effectiveValue: value,
    ...init,
  };
}

function makeInput(init?: Partial<ConfigDecodeInput>): ConfigDecodeInput {
  return { baseRevision: 7, fileDigest: "digest-abc", ...init };
}

function fieldEntry(
  path: string,
  source: "file" | "database" | "default",
  effectiveValue: unknown,
  overriddenValues: ConfigFieldViewEntry["overriddenValues"] = [],
): ConfigFieldViewEntry {
  return { path, source, editable: source !== "file", effectiveValue, overriddenValues };
}

function draftField(init: Partial<ConfigDraftField> & { id: string }): ConfigDraftField {
  const { id, ...rest } = init;
  return {
    id,
    mode: "present",
    inherit: false,
    value: undefined,
    effectiveValue: undefined,
    provenance: "database",
    overriddenValues: [],
    ...rest,
  };
}

function globalsDraft(fields: Record<string, ConfigDraftField>, prefix: readonly string[] = []): ConfigDraft {
  return { scope: { kind: "globals", prefix }, fields, baseRevision: 7, fileDigest: "digest-abc" };
}

function withField(draft: ConfigDraft, field: ConfigDraftField): ConfigDraft {
  return { ...draft, fields: { ...draft.fields, [field.id]: field } };
}

function singleOp(ops: readonly ConfigUiOperation[]): ConfigUiOperation {
  expect(ops).toHaveLength(1);
  return ops[0]!;
}

// ---------------------------------------------------------------------------
// Shared page fixtures (hand-written; mirror the frozen layout conventions)
// ---------------------------------------------------------------------------

const providerPage = makePage({
  id: "providers",
  entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object" },
  fields: [
    makeField({ id: "provider:id", path: ["id"], control: "text", valueKind: "string", optional: false }),
    makeField({
      id: "provider:kind",
      path: ["kind"],
      control: "select",
      valueKind: "enum",
      optional: false,
      options: [{ value: "openai" }, { value: "anthropic" }, { value: "azure_openai" }],
    }),
    makeField({ id: "provider:model", path: ["model"], control: "text", valueKind: "string" }),
    makeField({ id: "provider:api_key_env", path: ["api_key_env"], control: "secret-ref", valueKind: "string" }),
    makeField({ id: "provider:api_version", path: ["api_version"], control: "text", valueKind: "string", kinds: ["azure_openai"] }),
    makeField({
      id: "provider:timeout_seconds",
      path: ["timeout_seconds"],
      control: "number",
      valueKind: "number",
      hasDefault: true,
      defaultValue: 120,
    }),
    makeField({ id: "provider:disabled", path: ["disabled"], control: "toggle", valueKind: "boolean" }),
  ],
});

const providerValue = {
  id: "openai-main",
  kind: "openai",
  model: "gpt-5",
  api_key_env: "OPENAI_API_KEY",
  timeout_seconds: 60,
  disabled: false,
  future_header: { "X-Trace": "on" },
  future_list: ["a", "b"],
};

const modelGroupPage = makePage({
  id: "model-groups",
  entity: { kind: "model_group", collection: "model_groups", idField: null, valueShape: "array" },
  fields: [
    makeField({ id: "model_group:$name", path: [], control: "text", valueKind: "string", optional: false }),
    makeField({
      id: "model_group:entries",
      path: [],
      control: "ordered-list",
      valueKind: "record",
      itemFields: [
        makeField({ id: "model_group:entries[].provider", path: ["provider"], control: "text", valueKind: "string" }),
        makeField({ id: "model_group:entries[].model", path: ["model"], control: "text", valueKind: "string" }),
      ],
    }),
  ],
});

const modelGroupValue = [
  { provider: "openai-main", model: "gpt-5" },
  { provider: "backup", model: "claude-sonnet-4" },
];

const triggerPage = makePage({
  id: "triggers",
  entity: {
    kind: "trigger",
    collection: "triggers",
    idField: "name",
    valueShape: "object",
    kindField: "kind",
    kindOptions: ["github", "p4", "svn"],
  },
  fields: [
    makeField({ id: "trigger:name", path: ["name"], control: "text", valueKind: "string", optional: false }),
    makeField({
      id: "trigger:kind",
      path: ["kind"],
      control: "select",
      valueKind: "enum",
      optional: false,
      options: [{ value: "github" }, { value: "p4" }, { value: "svn" }],
    }),
    makeField({ id: "trigger:app.app_id", path: ["app", "app_id"], control: "number", valueKind: "number", kinds: ["github"] }),
    makeField({
      id: "trigger:app.private_key_env",
      path: ["app", "private_key_env"],
      control: "secret-ref",
      valueKind: "string",
      kinds: ["github"],
    }),
    makeField({ id: "trigger:port", path: ["port"], control: "text", valueKind: "string", kinds: ["p4"] }),
    makeField({ id: "trigger:user_env", path: ["user_env"], control: "secret-ref", valueKind: "string", kinds: ["p4"] }),
    makeField({ id: "trigger:watch_path", path: ["watch_path"], control: "path-template", valueKind: "string", kinds: ["p4", "svn"] }),
  ],
});

const githubTriggerValue = { name: "github-main", kind: "github", app: { app_id: 1234, private_key_env: "GITHUB_APP_KEY" } };
const p4TriggerValue = { name: "p4-main", kind: "p4", port: "ssl:perforce:1666", user_env: "P4USER", watch_path: "//depot/main/..." };

const channelPage = makePage({
  id: "channels",
  entity: { kind: "channel", collection: "channels", idField: "name", valueShape: "object", kindField: "kind" },
  fields: [
    makeField({ id: "channel:name", path: ["name"], control: "text", valueKind: "string", optional: false }),
    makeField({
      id: "channel:kind",
      path: ["kind"],
      control: "select",
      valueKind: "enum",
      optional: false,
      options: [{ value: "gitlab_mr_review" }, { value: "github_pr_review" }],
    }),
    makeField({ id: "channel:trigger", path: ["trigger"], control: "select", valueKind: "string", optionsSource: "triggers" }),
    makeField({ id: "channel:project", path: ["project"], control: "text", valueKind: "string" }),
  ],
});

const gitlabChannelValue = { name: "gl-mr", kind: "gitlab_mr_review", trigger: "gitlab-main", project: "group/repo" };

const workspacePage = makePage({
  id: "workspaces",
  entity: { kind: "workspace", collection: "workspaces", idField: null, valueShape: "object" },
  fields: [
    makeField({ id: "workspace:$name", path: [], control: "text", valueKind: "string", optional: false }),
    makeField({ id: "workspace:work_path", path: ["work_path"], control: "path-template", valueKind: "string" }),
    makeField({
      id: "workspace:match",
      path: ["match"],
      control: "ordered-list",
      valueKind: "record",
      itemFields: [
        makeField({ id: "workspace:match[].triggers", path: ["triggers"], control: "multiselect", valueKind: "string[]" }),
        makeField({ id: "workspace:match[].source", path: ["source"], control: "matcher", valueKind: "union" }),
      ],
    }),
    makeField({ id: "workspace:model_chain", path: ["model_chain"], control: "select", valueKind: "string", optionsSource: "model_groups" }),
  ],
});

const workspaceValue = {
  work_path: "src",
  match: [{ triggers: ["github-main"], source: { glob: "Owner/*", ignore_case: true } }],
  model_chain: "default",
};

const routePage = makePage({
  id: "routing",
  entity: { kind: "route", collection: "routes", idField: "id", valueShape: "object" },
  fields: [
    makeField({ id: "route:id", path: ["id"], control: "text", valueKind: "string", optional: false }),
    makeField({ id: "route:enabled", path: ["enabled"], control: "toggle", valueKind: "boolean", hasDefault: true, defaultValue: true }),
    makeField({ id: "route:priority", path: ["priority"], control: "number", valueKind: "number", hasDefault: true, defaultValue: 0 }),
    makeField({ id: "route:workspace", path: ["workspace"], control: "select", valueKind: "string", optionsSource: "workspaces" }),
    makeField({
      id: "route:match.triggers",
      path: ["match", "triggers"],
      control: "multiselect",
      valueKind: "string[]",
      optionsSource: "triggers",
    }),
    makeField({
      id: "route:analysis.model_chain",
      path: ["analysis", "model_chain"],
      control: "select",
      valueKind: "string",
      optionsSource: "model_groups",
    }),
    makeField({
      id: "route:outputs.summary",
      path: ["outputs", "summary"],
      control: "multiselect",
      valueKind: "string[]",
      optionsSource: "channels",
    }),
  ],
});

const routeValue = {
  id: "r-1",
  enabled: true,
  priority: 5,
  workspace: "ws-1",
  match: { triggers: ["github-main"] },
  analysis: { model_chain: "default" },
  outputs: { summary: ["gl-mr"] },
};

const reviewPage = makePage({
  id: "review",
  globals: true,
  fields: [
    makeField({
      id: "review:max_files",
      path: ["review", "max_files"],
      control: "number",
      valueKind: "number",
      hasDefault: true,
      defaultValue: 50,
    }),
    makeField({ id: "review:skip_lgtm", path: ["review", "skip_lgtm"], control: "toggle", valueKind: "boolean" }),
    makeField({
      id: "review:output_language",
      path: ["review", "output_language"],
      control: "select",
      valueKind: "enum",
      options: [{ value: "zh-CN" }, { value: "en-US" }],
    }),
    makeField({ id: "review:include", path: ["review", "include"], control: "multiselect", valueKind: "string[]" }),
    makeField({ id: "review:source_filter", path: ["review", "source_filter"], control: "matcher", valueKind: "union" }),
    makeField({ id: "review:signing_secret_env", path: ["review", "signing_secret_env"], control: "secret-ref", valueKind: "string" }),
  ],
});

const agentPage = makePage({
  id: "agent",
  globals: true,
  fields: [
    makeField({ id: "agent:default", path: ["agent", "default"], control: "select", valueKind: "enum", options: [{ value: "pi" }] }),
    makeField({
      id: "agent:web_search.providers",
      path: ["agent", "web_search", "providers"],
      control: "multiselect",
      valueKind: "string[]",
    }),
    makeField({
      id: "agent:web_search.searxng.endpoint",
      path: ["agent", "web_search", "searxng", "endpoint"],
      control: "text",
      valueKind: "string",
      visibleWhen: { field: "agent:web_search.providers", equals: "searxng" },
    }),
    makeField({ id: "compression:auto", path: ["compression", "auto"], control: "toggle", valueKind: "boolean" }),
  ],
});

const llmGlobalsPage = makePage({
  id: "llm-globals",
  globals: true,
  fields: [
    makeField({
      id: "llm:default_model_chain",
      path: ["llm", "default_model_chain"],
      control: "select",
      valueKind: "string",
      optionsSource: "model_groups",
    }),
    makeField({
      id: "llm:per_provider_overrides",
      path: ["llm", "per_provider_overrides"],
      control: "map",
      valueKind: "record",
      mapValueKind: "record",
    }),
    makeField({ id: "llm:retry.max_attempts", path: ["llm", "retry", "max_attempts"], control: "number", valueKind: "number" }),
    makeField({
      id: "llm:per_provider_overrides.x~002Ey.base_url",
      path: ["llm", "per_provider_overrides", "x~002Ey", "base_url"],
      control: "text",
      valueKind: "string",
    }),
  ],
});

const channelsDualPage = makePage({
  id: "channels",
  entity: { kind: "channel", collection: "channels", idField: "name", valueShape: "object" },
  globals: true,
  fields: [
    makeField({ id: "channel:name", path: ["name"], control: "text", valueKind: "string", optional: false }),
    makeField({ id: "channel:kind", path: ["kind"], control: "text", valueKind: "string", optional: false }),
    makeField({ id: "outputs:template_engine", path: ["outputs", "template_engine"], control: "text", valueKind: "string" }),
  ],
});

const versionsPage = makePage({ id: "versions", sections: [] });

const validSpec = makeSpec(
  [providerPage, modelGroupPage, triggerPage, channelPage, workspacePage, routePage, reviewPage, agentPage, llmGlobalsPage, versionsPage],
  ["triggers", "model_groups", "workspaces", "channels"],
);

function expectIssues(spec: ConfigUiSpec, expected: readonly { code: string; fieldId?: string }[]): void {
  const issues = validateUiSpec(spec);
  expect(issues.map((issue) => ({ code: issue.code, ...(issue.fieldId !== undefined ? { fieldId: issue.fieldId } : {}) }))).toEqual(
    expected.map((issue) => ({ code: issue.code, ...(issue.fieldId !== undefined ? { fieldId: issue.fieldId } : {}) })),
  );
}

// ---------------------------------------------------------------------------
// U01/U02/U03/U13 — validateUiSpec
// ---------------------------------------------------------------------------

describe("validateUiSpec", () => {
  it("accepts the fully valid fixture spec", () => {
    expect(validateUiSpec(validSpec)).toEqual([]);
  });

  it("U01: flags duplicate field ids within and across pages", () => {
    const pageA = makePage({
      id: "a",
      fields: [
        makeField({ id: "dup:id", path: ["a"], control: "text", valueKind: "string" }),
        makeField({ id: "dup:id", path: ["b"], control: "text", valueKind: "string" }),
      ],
    });
    const pageB = makePage({
      id: "b",
      fields: [makeField({ id: "dup:id", path: ["c"], control: "text", valueKind: "string" })],
    });
    expectIssues(makeSpec([pageA, pageB]), [
      { code: "duplicate_field_id", fieldId: "dup:id" },
      { code: "duplicate_field_id", fieldId: "dup:id" },
    ]);
  });

  it("U01: flags duplicate page and section ids", () => {
    const field = makeField({ id: "f:1", path: ["a"], control: "text", valueKind: "string" });
    const dupPages = makeSpec([
      makePage({ id: "same", fields: [field] }),
      makePage({ id: "same", fields: [makeField({ id: "f:2", path: ["b"], control: "text", valueKind: "string" })] }),
    ]);
    expectIssues(dupPages, [{ code: "duplicate_field_id" }]);
    const sectionField = (id: string) => ({ ...makeField({ id, path: ["a"], control: "text", valueKind: "string" }), section: "sec" });
    const dupSectionPage = makePage({
      id: "s",
      sections: [
        { id: "sec", label: "one", fields: [sectionField("f:1")] },
        { id: "sec", label: "two", fields: [sectionField("f:2")] },
      ],
    });
    expectIssues(makeSpec([dupSectionPage]), [{ code: "duplicate_field_id" }]);
  });

  it("U01: flags fields referencing unknown sections and empty sections", () => {
    const page = makePage({
      id: "p",
      sections: [
        { id: "main", label: "Main", fields: [makeField({ id: "f:1", path: ["a"], control: "text", valueKind: "string", section: "ghost" })] },
        { id: "empty", label: "Empty", fields: [] },
      ],
    });
    const issues = validateUiSpec(makeSpec([page]));
    expect(issues.map((issue) => issue.code)).toEqual(["missing_section", "missing_section"]);
    expect(issues[0]?.message).toContain('section "empty" on page "p" has no fields');
    expect(issues[1]?.fieldId).toBe("f:1");
    expect(issues[1]?.message).toContain('unknown section "ghost"');
  });
  it("U01: flags empty or non-string labels and labelKeys", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:empty-label", path: ["a"], control: "text", valueKind: "string", label: " " }),
        makeField({ id: "f:empty-key", path: ["b"], control: "text", valueKind: "string", labelKey: "" }),
        makeField({ id: "f:bad-label", path: ["c"], control: "text", valueKind: "string", label: 42 as unknown as string }),
        makeField({ id: "f:bad-key", path: ["d"], control: "text", valueKind: "string", labelKey: null as unknown as string }),
      ],
    });
    expectIssues(makeSpec([page]), [
      { code: "missing_label", fieldId: "f:empty-label" },
      { code: "missing_label", fieldId: "f:empty-key" },
      { code: "missing_label", fieldId: "f:bad-label" },
      { code: "missing_label", fieldId: "f:bad-key" },
    ]);
  });

  it("rejects malformed spec roots without throwing", () => {
    expect(validateUiSpec(null as unknown as ConfigUiSpec)).toEqual([
      { code: "invalid_spec", message: "ConfigUiSpec must be an object with a pages array." },
    ]);
    expect(validateUiSpec({ pages: "x" } as unknown as ConfigUiSpec)).toEqual([
      { code: "invalid_spec", message: "ConfigUiSpec must be an object with a pages array." },
    ]);
  });

  it("flags a wrong protocolVersion and malformed pages/sections/fields", () => {
    const spec = {
      protocolVersion: 2,
      pages: [null, { id: "bad", sections: "x" }, { id: "ok", sections: [null, { id: "s", fields: "x" }, { id: "main", fields: [42] }] }],
      optionsSources: [],
    } as unknown as ConfigUiSpec;
    const issues = validateUiSpec(spec);
    expect(issues.map((issue) => issue.code)).toEqual([
      "invalid_spec",
      "invalid_spec",
      "invalid_spec",
      "invalid_spec",
      "invalid_spec",
      "invalid_spec",
    ]);
    expect(issues[0]?.message).toContain("protocolVersion must be 1");
    // A non-string page id is tolerated (no duplicate tracking) while the
    // rest of the page still validates.
    expect(validateUiSpec({ protocolVersion: 1, pages: [{ id: 7, sections: [] }], optionsSources: [] } as unknown as ConfigUiSpec)).toEqual([]);
  });

  it("treats a missing optionsSources array as empty", () => {
    const page = makePage({
      id: "p",
      fields: [makeField({ id: "f:1", path: ["a"], control: "select", valueKind: "string", optionsSource: "providers" })],
    });
    const spec = { protocolVersion: 1, pages: [page], optionsSources: null } as unknown as ConfigUiSpec;
    expectIssues(spec, [{ code: "unknown_options_source", fieldId: "f:1" }]);
  });
  it("U02: rejects prototype path tokens case-insensitively, including escape form", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:1", path: ["__proto__"], control: "text", valueKind: "string" }),
        makeField({ id: "f:2", path: ["Constructor"], control: "text", valueKind: "string" }),
        makeField({ id: "f:3", path: ["a", "~005F~005FPROTO~005F~005F"], control: "text", valueKind: "string" }),
        makeField({ id: "f:4", path: ["~005F~005Fproto~005F~005F"], control: "text", valueKind: "string" }),
      ],
    });
    expectIssues(makeSpec([page]), [
      { code: "prototype_key", fieldId: "f:1" },
      { code: "prototype_key", fieldId: "f:2" },
      { code: "prototype_key", fieldId: "f:3" },
      { code: "prototype_key", fieldId: "f:4" },
    ]);
  });

  it("U02: rejects malformed tokens and accepts raw and canonical escape forms", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:bad-space", path: ["a b"], control: "text", valueKind: "string" }),
        makeField({ id: "f:bad-lower", path: ["x~2ey"], control: "text", valueKind: "string" }),
        makeField({ id: "f:bad-short", path: ["~12"], control: "text", valueKind: "string" }),
        makeField({ id: "f:bad-dot", path: [".abc"], control: "text", valueKind: "string" }),
        makeField({ id: "f:bad-empty", path: [""], control: "text", valueKind: "string" }),
        makeField({ id: "f:bad-type", path: [42 as unknown as string], control: "text", valueKind: "string" }),
        makeField({ id: "f:bad-path", path: "a.b" as unknown as readonly string[], control: "text", valueKind: "string" }),
        makeField({ id: "f:ok-escape", path: ["a~0020b"], control: "text", valueKind: "string" }),
        makeField({ id: "f:ok-tilde", path: ["a~007Eb"], control: "text", valueKind: "string" }),
        makeField({ id: "f:ok-dash", path: ["-x"], control: "text", valueKind: "string" }),
        makeField({ id: "f:ok-raw", path: ["x.y"], control: "text", valueKind: "string" }),
      ],
    });
    const issues = validateUiSpec(makeSpec([page]));
    expect(issues.map((issue) => issue.fieldId)).toEqual([
      "f:bad-space",
      "f:bad-lower",
      "f:bad-short",
      "f:bad-dot",
      "f:bad-empty",
      "f:bad-type",
      "f:bad-path",
    ]);
    expect(issues.every((issue) => issue.code === "unknown_path")).toBe(true);
  });

  it("U03: enforces the control/valueKind compatibility matrix", () => {
    const incompatible: readonly [ConfigUiControlKind, ConfigUiValueKind][] = [
      ["text", "number"],
      ["number", "string"],
      ["toggle", "string"],
      ["select", "number"],
      ["multiselect", "string"],
      ["ordered-list", "string[]"],
      ["map", "string"],
      ["secret-ref", "enum"],
      ["matcher", "string"],
      ["path-template", "union"],
    ];
    for (const [control, valueKind] of incompatible) {
      const page = makePage({ id: "p", fields: [makeField({ id: "f:1", path: ["a"], control, valueKind })] });
      const issues = validateUiSpec(makeSpec([page]));
      expect(issues.map((issue) => issue.code), `${control}/${valueKind}`).toEqual(["incompatible_control"]);
      expect(issues[0]?.message).toContain(`control "${control}" is incompatible with valueKind "${valueKind}"`);
    }
  });

  it("U03: accepts every compatible control/valueKind pair", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:text", path: ["a"], control: "text", valueKind: "string" }),
        makeField({ id: "f:text-union", path: ["b"], control: "text", valueKind: "union" }),
        makeField({ id: "f:number", path: ["c"], control: "number", valueKind: "number" }),
        makeField({ id: "f:toggle", path: ["d"], control: "toggle", valueKind: "boolean" }),
        makeField({ id: "f:select-enum", path: ["e"], control: "select", valueKind: "enum" }),
        makeField({ id: "f:select-union", path: ["f"], control: "select", valueKind: "union" }),
        makeField({ id: "f:multi-string", path: ["g"], control: "multiselect", valueKind: "string[]" }),
        makeField({ id: "f:multi-enum", path: ["h"], control: "multiselect", valueKind: "enum[]" }),
        makeField({ id: "f:multi-number", path: ["i"], control: "multiselect", valueKind: "number[]" }),
        makeField({
          id: "f:list",
          path: ["j"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [makeField({ id: "f:list[].x", path: ["x"], control: "text", valueKind: "string" })],
        }),
        makeField({ id: "f:map", path: ["k"], control: "map", valueKind: "record", mapValueKind: "string" }),
        makeField({ id: "f:secret", path: ["l"], control: "secret-ref", valueKind: "string" }),
        makeField({ id: "f:matcher", path: ["m"], control: "matcher", valueKind: "union" }),
        makeField({ id: "f:matcher-record", path: ["n"], control: "matcher", valueKind: "record" }),
        makeField({ id: "f:template", path: ["o"], control: "path-template", valueKind: "string" }),
        makeField({
          id: "f:removed",
          path: ["p"],
          control: "toggle",
          valueKind: "never",
          readonlyReason: "removed alias for review.skip",
        }),
      ],
    });
    expect(validateUiSpec(makeSpec([page]))).toEqual([]);
  });

  it("U03: rejects removed-alias never fields without readonlyReason", () => {
    const page = makePage({ id: "p", fields: [makeField({ id: "f:1", path: ["a"], control: "toggle", valueKind: "never" })] });
    const issues = validateUiSpec(makeSpec([page]));
    expect(issues.map((issue) => issue.code)).toEqual(["incompatible_control"]);
    expect(issues[0]?.message).toContain('"never" (removed alias) without readonlyReason');
  });

  it("U03: rejects unknown controls and incomplete list/map declarations", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:control", path: ["a"], control: "banana" as unknown as ConfigUiControlKind, valueKind: "string" }),
        makeField({ id: "f:list-none", path: ["b"], control: "ordered-list", valueKind: "record" }),
        makeField({ id: "f:list-empty", path: ["c"], control: "ordered-list", valueKind: "record", itemFields: [] }),
        makeField({ id: "f:map-none", path: ["d"], control: "map", valueKind: "record" }),
      ],
    });
    const issues = validateUiSpec(makeSpec([page]));
    expect(issues.map((issue) => issue.code)).toEqual([
      "incompatible_control",
      "incompatible_control",
      "incompatible_control",
      "incompatible_control",
    ]);
    expect(issues[0]?.message).toContain('unknown control "banana"');
    expect(issues[1]?.message).toContain("requires non-empty itemFields");
    expect(issues[3]?.message).toContain("map control requires mapValueKind");
  });

  it("flags unknown options sources and non-optional inherit-or-override bindings", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:source", path: ["a"], control: "select", valueKind: "string", optionsSource: "ghost" }),
        makeField({ id: "f:binding", path: ["b"], control: "text", valueKind: "string", binding: "inherit-or-override", optional: false }),
        makeField({ id: "f:binding-ok", path: ["c"], control: "text", valueKind: "string", binding: "inherit-or-override" }),
      ],
    });
    expectIssues(makeSpec([page], ["providers"]), [
      { code: "unknown_options_source", fieldId: "f:source" },
      { code: "invalid_spec", fieldId: "f:binding" },
    ]);
  });

  it("validates itemFields recursively (ids, tokens, duplicate registration)", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({
          id: "f:list",
          path: ["a"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [
            makeField({ id: "f:list[].bad", path: ["a b"], control: "text", valueKind: "string" }),
            makeField({ id: "f:list", path: ["x"], control: "text", valueKind: "string" }),
            42 as unknown as ConfigUiField,
          ],
        }),
      ],
    });
    const issues = validateUiSpec(makeSpec([page]));
    expect(issues.map((issue) => issue.code)).toEqual(["unknown_path", "duplicate_field_id", "invalid_spec"]);
  });

  it("U13: flags visibleWhen references to unknown or non-top-level fields", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({
          id: "f:list",
          path: ["a"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [makeField({ id: "f:list[].x", path: ["x"], control: "text", valueKind: "string" })],
        }),
        makeField({ id: "f:ref-missing", path: ["b"], control: "text", valueKind: "string", visibleWhen: { field: "f:ghost", equals: true } }),
        makeField({
          id: "f:ref-item",
          path: ["c"],
          control: "text",
          valueKind: "string",
          visibleWhen: { field: "f:list[].x", equals: true },
        }),
      ],
    });
    expectIssues(makeSpec([page]), [
      { code: "unknown_visible_when", fieldId: "f:ref-missing" },
      { code: "unknown_visible_when", fieldId: "f:ref-item" },
    ]);
  });

  it("U13: detects visibleWhen cycles once per member", () => {
    const cyclic = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:a", path: ["a"], control: "text", valueKind: "string", visibleWhen: { field: "f:b", equals: true } }),
        makeField({ id: "f:b", path: ["b"], control: "text", valueKind: "string", visibleWhen: { field: "f:a", equals: true } }),
        makeField({ id: "f:self", path: ["c"], control: "text", valueKind: "string", visibleWhen: { field: "f:self", equals: true } }),
      ],
    });
    expectIssues(makeSpec([cyclic]), [
      { code: "visible_when_cycle", fieldId: "f:a" },
      { code: "visible_when_cycle", fieldId: "f:b" },
      { code: "visible_when_cycle", fieldId: "f:self" },
    ]);
    const acyclic = makePage({
      id: "p",
      fields: [
        makeField({ id: "f:root", path: ["a"], control: "toggle", valueKind: "boolean" }),
        makeField({ id: "f:mid", path: ["b"], control: "text", valueKind: "string", visibleWhen: { field: "f:root", equals: true } }),
        makeField({ id: "f:leaf", path: ["c"], control: "text", valueKind: "string", visibleWhen: { field: "f:mid", equals: "x" } }),
      ],
    });
    expect(validateUiSpec(makeSpec([acyclic]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U04/U16 — decodeDraft (entity scope)
// ---------------------------------------------------------------------------

describe("decodeDraft entity scope", () => {
  it("U04: create-mode draft separates defaults from user overrides", () => {
    const draft = decodeDraft(providerPage, makeInput({ record: null }));
    expect(draft.scope).toEqual({ kind: "entity", collection: "providers", recordId: null });
    expect(draft.baseRevision).toBe(7);
    expect(draft.fileDigest).toBe("digest-abc");
    expect(draft.fields["provider:id"]).toEqual({
      id: "provider:id",
      mode: "absent",
      inherit: false,
      value: "",
      effectiveValue: undefined,
      provenance: "none",
      overriddenValues: [],
    });
    // hasDefault fields carry the static default for display, still absent.
    expect(draft.fields["provider:timeout_seconds"]).toEqual({
      id: "provider:timeout_seconds",
      mode: "absent",
      inherit: false,
      value: 120,
      effectiveValue: 120,
      provenance: "none",
      overriddenValues: [],
    });
    expect(draft.fields["provider:disabled"]?.value).toBeUndefined();
    expect(draft.fields["provider:kind"]?.value).toBeUndefined();
    expect(draft.fields["provider:api_key_env"]?.value).toBe("");
    expect(draft.fields["$extras"]).toEqual({
      id: "$extras",
      mode: "absent",
      inherit: false,
      value: {},
      effectiveValue: undefined,
      provenance: "none",
      overriddenValues: [],
      extras: {},
    });
  });

  it("decodes a database record with hand-written field expectations", () => {
    const record = makeRecord(providerValue, { id: "openai-main", name: "openai-main" });
    const draft = decodeDraft(providerPage, makeInput({ record }));
    expect(draft.scope).toEqual({ kind: "entity", collection: "providers", recordId: "openai-main" });
    expect(draft.fields["provider:id"]).toEqual({
      id: "provider:id",
      mode: "present",
      inherit: false,
      value: "openai-main",
      effectiveValue: "openai-main",
      provenance: "database",
      overriddenValues: [],
    });
    expect(draft.fields["provider:disabled"]).toEqual({
      id: "provider:disabled",
      mode: "present",
      inherit: false,
      value: false,
      effectiveValue: false,
      provenance: "database",
      overriddenValues: [],
    });
    // api_version is not in the record: absent with control-empty value.
    expect(draft.fields["provider:api_version"]).toEqual({
      id: "provider:api_version",
      mode: "absent",
      inherit: false,
      value: "",
      effectiveValue: undefined,
      provenance: "database",
      overriddenValues: [],
    });
    expect(draft.fields["$extras"]).toEqual({
      id: "$extras",
      mode: "present",
      inherit: false,
      value: { future_header: { "X-Trace": "on" }, future_list: ["a", "b"] },
      effectiveValue: { future_header: { "X-Trace": "on" }, future_list: ["a", "b"] },
      provenance: "database",
      overriddenValues: [],
      extras: { future_header: { "X-Trace": "on" }, future_list: ["a", "b"] },
    });
  });

  it("U05: key existence decides presence; false, 0, null and [] are values", () => {
    const record = makeRecord({ id: "p", kind: "openai", disabled: false, timeout_seconds: 0, model: null, api_key_env: "" });
    const draft = decodeDraft(providerPage, makeInput({ record }));
    expect(draft.fields["provider:disabled"]?.mode).toBe("present");
    expect(draft.fields["provider:disabled"]?.value).toBe(false);
    expect(draft.fields["provider:timeout_seconds"]?.mode).toBe("present");
    expect(draft.fields["provider:timeout_seconds"]?.value).toBe(0);
    expect(draft.fields["provider:model"]?.mode).toBe("present");
    expect(draft.fields["provider:model"]?.value).toBeNull();
    expect(draft.fields["provider:api_key_env"]?.mode).toBe("present");
  });

  it("U16: file-owned and readonly/shadowed records still decode with file provenance", () => {
    const record = makeRecord(providerValue, { source: "file", readonly: true, shadowedByFile: true });
    const draft = decodeDraft(providerPage, makeInput({ record }));
    expect(draft.fields["provider:model"]?.provenance).toBe("file");
    expect(draft.fields["provider:model"]?.mode).toBe("present");
    expect(draft.fields["$extras"]?.provenance).toBe("file");
    const state = resolveFieldState(providerPage, "provider:model", draft, {});
    expect(state.disabled).toBe(true);
    expect(state.disabledReason).toBe("owned by the config file");
  });

  it("reads effectiveValue from the merged effective record independently of presence", () => {
    const record = makeRecord(
      { id: "p", kind: "openai" },
      { effectiveValue: { id: "p", kind: "openai", model: "gpt-5-effective" } },
    );
    const draft = decodeDraft(providerPage, makeInput({ record }));
    expect(draft.fields["provider:model"]?.mode).toBe("absent");
    expect(draft.fields["provider:model"]?.effectiveValue).toBe("gpt-5-effective");
    expect(draft.fields["provider:model"]?.value).toBe("");
  });

  it("decodes the model_group array value shape with row ids and $name", () => {
    const record = makeRecord(modelGroupValue, { id: "default", name: "default" });
    const draft = decodeDraft(modelGroupPage, makeInput({ record }));
    expect(draft.fields["model_group:$name"]).toEqual({
      id: "model_group:$name",
      mode: "present",
      inherit: false,
      value: "default",
      effectiveValue: "default",
      provenance: "database",
      overriddenValues: [],
    });
    expect(draft.fields["model_group:entries"]?.value).toEqual([
      { _rowId: "r1", provider: "openai-main", model: "gpt-5" },
      { _rowId: "r2", provider: "backup", model: "claude-sonnet-4" },
    ]);
    // Arrays have no unknown-key passthrough.
    expect(draft.fields["$extras"]?.mode).toBe("absent");
    expect(draft.fields["$extras"]?.value).toEqual({});
  });

  it("roundtrips a row's own literal _rowId data key", () => {
    const record = makeRecord([{ provider: "p", _rowId: "user-data" }], { id: "g", name: "g" });
    const draft = decodeDraft(modelGroupPage, makeInput({ record }));
    const rows = draft.fields["model_group:entries"]?.value as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["_rowId"]).toBe("r1"); // stable row id
    const ops = encodeChanges(modelGroupPage, draft, makeInput({ record }));
    const op = singleOp(ops) as { value: Record<string, unknown>[] };
    expect(op.value).toEqual([{ provider: "p", _rowId: "user-data" }]);
  });

  it("decodes matcher controls and flags malformed shapes as absent (U11)", () => {
    const matcherPage = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({ id: "trigger:name", path: ["name"], control: "text", valueKind: "string", optional: false }),
        makeField({ id: "trigger:filter", path: ["filter"], control: "matcher", valueKind: "union" }),
      ],
    });
    const draft = decodeDraft(
      matcherPage,
      makeInput({
        record: makeRecord({
          name: "t",
          filter: { exact: "a", glob: "b" },
        }),
      }),
    );
    const filter = draft.fields["trigger:filter"];
    expect(filter?.mode).toBe("absent");
    expect(filter?.value).toEqual({ exact: "a", glob: "b" });
    const state = resolveFieldState(matcherPage, "trigger:filter", draft, {});
    expect(state.error).toBe('unrecognized matcher shape for field "trigger:filter"');
    // encode omits the malformed key rather than corrupting it.
    const ops = encodeChanges(matcherPage, draft, makeInput());
    expect(singleOp(ops)).toEqual({ op: "update", collection: "triggers", recordId: "rec-1", value: { name: "t" } });
    // Every malformed variant decodes absent and surfaces the same error.
    for (const raw of [
      {},
      { exact: "a", extra: 1 },
      { exact: 5 },
      { glob: "x", ignore_case: "yes" },
      { exact: "a", ignore_case: true },
      "not-a-record",
    ]) {
      const malformedDraft = decodeDraft(matcherPage, makeInput({ record: makeRecord({ filter: raw }) }));
      expect(malformedDraft.fields["trigger:filter"]?.mode, JSON.stringify(raw)).toBe("absent");
      expect(malformedDraft.fields["trigger:filter"]?.value).toEqual(raw);
      expect(resolveFieldState(matcherPage, "trigger:filter", malformedDraft, {}).error).toContain("unrecognized matcher shape");
    }
  });

  it("decodes the three valid matcher shapes", () => {
    const matcherPage = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [makeField({ id: "trigger:filter", path: ["filter"], control: "matcher", valueKind: "union" })],
    });
    for (const [raw, expected] of [
      [{ exact: "Owner/Repo" }, { mode: "exact", pattern: "Owner/Repo", ignore_case: false }],
      [{ glob: "Owner/*", ignore_case: true }, { mode: "glob", pattern: "Owner/*", ignore_case: true }],
      [{ regex: "^owner" }, { mode: "regex", pattern: "^owner", ignore_case: false }],
    ] as const) {
      const draft = decodeDraft(matcherPage, makeInput({ record: makeRecord({ filter: raw }) }));
      expect(draft.fields["trigger:filter"]?.value).toEqual(expected);
      expect(draft.fields["trigger:filter"]?.mode).toBe("present");
    }
  });
  it("tolerates non-array list values, non-record map values and non-array multiselects", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({
          id: "trigger:list",
          path: ["list"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [makeField({ id: "trigger:list[].x", path: ["x"], control: "text", valueKind: "string" })],
        }),
        makeField({ id: "trigger:scalars", path: ["scalars"], control: "ordered-list", valueKind: "record" }),
        makeField({ id: "trigger:map", path: ["map"], control: "map", valueKind: "record", mapValueKind: "string" }),
        makeField({ id: "trigger:multi", path: ["multi"], control: "multiselect", valueKind: "string[]" }),
      ],
    });
    const draft = decodeDraft(
      page,
      makeInput({ record: makeRecord({ list: "oops", scalars: ["a", "a", "b"], map: 42, multi: "oops" }) }),
    );
    expect(draft.fields["trigger:list"]?.value).toEqual([]);
    // Scalar lists stay scalar arrays, cloned.
    expect(draft.fields["trigger:scalars"]?.value).toEqual(["a", "a", "b"]);
    expect(draft.fields["trigger:map"]?.value).toEqual([]);
    expect(draft.fields["trigger:multi"]?.value).toEqual([]);
  });

  it("dedupes multiselect values and materializes map rows with row ids", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({ id: "trigger:multi", path: ["multi"], control: "multiselect", valueKind: "string[]" }),
        makeField({ id: "trigger:map", path: ["map"], control: "map", valueKind: "record", mapValueKind: "string" }),
      ],
    });
    const draft = decodeDraft(page, makeInput({ record: makeRecord({ multi: ["b", "a", "b"], map: { k1: "v1", k2: "v2" } }) }));
    expect(draft.fields["trigger:multi"]?.value).toEqual(["b", "a"]);
    expect(draft.fields["trigger:map"]?.value).toEqual([
      { _rowId: "r1", key: "k1", value: "v1" },
      { _rowId: "r2", key: "k2", value: "v2" },
    ]);
  });

  it("decodes array-indexed and deep field paths via get-in", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({ id: "trigger:first", path: ["arr", "0"], control: "text", valueKind: "string" }),
        makeField({ id: "trigger:oob", path: ["arr", "9"], control: "text", valueKind: "string" }),
        makeField({ id: "trigger:bad-index", path: ["arr", "x"], control: "text", valueKind: "string" }),
        makeField({ id: "trigger:through-scalar", path: ["id", "nested"], control: "text", valueKind: "string" }),
      ],
    });
    const draft = decodeDraft(page, makeInput({ record: makeRecord({ arr: ["a", "b"], id: "t" }) }));
    expect(draft.fields["trigger:first"]).toMatchObject({ mode: "present", value: "a" });
    expect(draft.fields["trigger:oob"]?.mode).toBe("absent");
    expect(draft.fields["trigger:bad-index"]?.mode).toBe("absent");
    expect(draft.fields["trigger:through-scalar"]?.mode).toBe("absent");
  });

  it("decodes nested matcher itemFields inside rows, leaving malformed ones raw", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({
          id: "trigger:rules",
          path: ["rules"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [
            makeField({ id: "trigger:rules[].source", path: ["source"], control: "matcher", valueKind: "union" }),
            makeField({ id: "trigger:rules[].window.start", path: ["windows", "0", "start"], control: "matcher", valueKind: "union" }),
          ],
        }),
      ],
    });
    const draft = decodeDraft(
      page,
      makeInput({
        record: makeRecord({
          rules: [
            { source: { exact: "a" }, windows: [{ start: { glob: "09:*", ignore_case: false } }] },
            { source: { exact: "a", glob: "b" } },
            "scalar-row",
          ],
        }),
      }),
    );
    expect(draft.fields["trigger:rules"]?.value).toEqual([
      {
        _rowId: "r1",
        source: { mode: "exact", pattern: "a", ignore_case: false },
        windows: [{ start: { mode: "glob", pattern: "09:*", ignore_case: false } }],
      },
      { _rowId: "r2", source: { exact: "a", glob: "b" } },
      { _rowId: "r3" },
    ]);
  });

  it("partitions dual pages: entity sessions ignore globals fields", () => {
    const record = makeRecord({ name: "gl", kind: "gitlab_mr_review", template_engine: "handlebars" });
    const draft = decodeDraft(channelsDualPage, makeInput({ record }));
    expect(Object.keys(draft.fields).sort()).toEqual(["$extras", "channel:kind", "channel:name"]);
    // outputs:* is not covered by entity fields, so it would be an extra…
    // except the record value here has no such key; template_engine IS unknown
    // to the entity scope and lands in extras.
    expect(draft.fields["$extras"]?.value).toEqual({ template_engine: "handlebars" });
  });

  it("treats an entity page without a record input as a globals session", () => {
    const draft = decodeDraft(providerPage, makeInput({ fields: [] }));
    expect(draft.scope).toEqual({ kind: "globals", prefix: [] });
    expect(draft.fields).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// U04/U05/U16 — decodeDraft (globals scope)
// ---------------------------------------------------------------------------

describe("decodeDraft globals scope", () => {
  const reviewFieldsView = [
    fieldEntry("review.max_files", "database", 80, [{ source: "file", value: 50 }]),
    fieldEntry("review.skip_lgtm", "file", true),
    fieldEntry("review.output_language", "default", "zh-CN"),
    fieldEntry("review.source_filter", "database", { exact: "a", glob: "b" }),
    // review.include and review.signing_secret_env intentionally absent.
  ];

  it("U04/U16: decodes database/file/default provenance per field", () => {
    const draft = decodeDraft(reviewPage, makeInput({ fields: reviewFieldsView }));
    expect(draft.scope).toEqual({ kind: "globals", prefix: ["review"] });
    expect(draft.fields["review:max_files"]).toEqual({
      id: "review:max_files",
      mode: "present",
      inherit: false,
      value: 80,
      effectiveValue: 80,
      provenance: "database",
      overriddenValues: [{ source: "file", value: 50 }],
      editable: true,
    });
    // File-sourced under a database-priority prefix: editable stays true only
    // when the server view says so; here the view marks it not editable.
    expect(draft.fields["review:skip_lgtm"]).toEqual({
      id: "review:skip_lgtm",
      mode: "present",
      inherit: false,
      value: true,
      effectiveValue: true,
      provenance: "file",
      overriddenValues: [],
      editable: false,
    });
    // Default-sourced: absent; the default is display data, never an override.
    expect(draft.fields["review:output_language"]).toEqual({
      id: "review:output_language",
      mode: "absent",
      inherit: false,
      value: undefined,
      effectiveValue: "zh-CN",
      provenance: "default",
      overriddenValues: [],
      editable: true,
    });
    // Missing entry: provenance none.
    expect(draft.fields["review:include"]).toEqual({
      id: "review:include",
      mode: "absent",
      inherit: false,
      value: [],
      effectiveValue: undefined,
      provenance: "none",
      overriddenValues: [],
    });
    // Malformed matcher from the database: treated absent, raw preserved.
    expect(draft.fields["review:source_filter"]).toEqual({
      id: "review:source_filter",
      mode: "absent",
      inherit: false,
      value: { exact: "a", glob: "b" },
      effectiveValue: { exact: "a", glob: "b" },
      provenance: "database",
      overriddenValues: [],
      editable: true,
    });
  });

  it("derives an empty common prefix for multi-root pages and fieldless pages", () => {
    const agentDraft = decodeDraft(agentPage, makeInput({ fields: [] }));
    expect(agentDraft.scope).toEqual({ kind: "globals", prefix: [] });
    const versionsDraft = decodeDraft(versionsPage, makeInput({ fields: [] }));
    expect(versionsDraft.scope).toEqual({ kind: "globals", prefix: [] });
    expect(versionsDraft.fields).toEqual({});
  });

  it("decodes dual pages into globals sessions containing only global fields", () => {
    const draft = decodeDraft(
      channelsDualPage,
      makeInput({ fields: [fieldEntry("outputs.template_engine", "database", "handlebars")] }),
    );
    expect(draft.scope).toEqual({ kind: "globals", prefix: ["outputs", "template_engine"] });
    expect(Object.keys(draft.fields)).toEqual(["outputs:template_engine"]);
    expect(draft.fields["outputs:template_engine"]).toMatchObject({ mode: "present", value: "handlebars" });
  });

  it("rebuilds composite map fields from descendant leaf entries (quoted keys)", () => {
    const draft = decodeDraft(
      llmGlobalsPage,
      makeInput({
        fields: [
          fieldEntry("llm.default_model_chain", "database", "fast"),
          fieldEntry('llm.per_provider_overrides["x.y"].base_url', "database", "https://x"),
          fieldEntry('llm.per_provider_overrides["x.y"].model', "database", "m-1"),
          fieldEntry("llm.retry.max_attempts", "default", 3),
          fieldEntry('["abc', "database", 1),
          fieldEntry('["\\q"]', "database", 1),
          fieldEntry("a)b", "database", 1),
          fieldEntry("a.", "database", 1),
          fieldEntry("", "database", 1),
          fieldEntry('llm.per_provider_overrides["__proto__"].polluted', "database", true),
        ],
      }),
    );
    expect(draft.scope).toEqual({ kind: "globals", prefix: ["llm"] });
    expect(draft.fields["llm:per_provider_overrides"]).toEqual({
      id: "llm:per_provider_overrides",
      mode: "present",
      inherit: false,
      value: [{ _rowId: "r1", key: "x.y", value: { base_url: "https://x", model: "m-1" } }],
      effectiveValue: { "x.y": { base_url: "https://x", model: "m-1" } },
      provenance: "database",
      overriddenValues: [],
      editable: true,
    });
    // Escaped leaf token "x~002Ey" matches the quoted raw segment "x.y".
    expect(draft.fields["llm:per_provider_overrides.x~002Ey.base_url"]).toMatchObject({
      mode: "present",
      inherit: false,
      value: "https://x",
      provenance: "database",
    });
    expect(draft.fields["llm:retry.max_attempts"]).toMatchObject({ mode: "absent", provenance: "default", effectiveValue: 3 });
  });

  it("aggregates file and default composite sources without DB overrides", () => {
    const fileDraft = decodeDraft(
      llmGlobalsPage,
      makeInput({ fields: [fieldEntry('llm.per_provider_overrides["a"].base_url', "file", "https://a")] }),
    );
    expect(fileDraft.fields["llm:per_provider_overrides"]).toMatchObject({
      mode: "present",
      inherit: false,
      provenance: "file",
      value: [{ _rowId: "r1", key: "a", value: { base_url: "https://a" } }],
    });
    const defaultDraft = decodeDraft(
      llmGlobalsPage,
      makeInput({ fields: [fieldEntry('llm.per_provider_overrides["a"].base_url', "default", "https://a")] }),
    );
    expect(defaultDraft.fields["llm:per_provider_overrides"]).toMatchObject({ mode: "absent", inherit: false, provenance: "default" });
    const mixedDraft = decodeDraft(
      llmGlobalsPage,
      makeInput({
        fields: [
          fieldEntry('llm.per_provider_overrides["a"].base_url', "file", "https://a"),
          fieldEntry('llm.per_provider_overrides["b"].model', "database", "m"),
        ],
      }),
    );
    expect(mixedDraft.fields["llm:per_provider_overrides"]?.provenance).toBe("database");
  });
});

// ---------------------------------------------------------------------------
// U05/U10/U17 — encodeChanges (entity scope)
// ---------------------------------------------------------------------------

describe("encodeChanges entity scope", () => {
  it("creates records with id, name, enabled and the materialized value", () => {
    let draft = decodeDraft(providerPage, makeInput({ record: null }));
    draft = withField(draft, draftField({ id: "provider:id", value: "new-provider" }));
    draft = withField(draft, draftField({ id: "provider:kind", value: "openai" }));
    draft = withField(draft, draftField({ id: "provider:disabled", value: false }));
    const ops = encodeChanges(providerPage, draft, makeInput({ record: null }));
    expect(singleOp(ops)).toEqual({
      op: "create",
      collection: "providers",
      record: { id: "new-provider", name: "new-provider", enabled: true, value: { id: "new-provider", kind: "openai", disabled: false } },
    });
  });

  it("creates map-collection records named by the synthetic $name field", () => {
    let draft = decodeDraft(modelGroupPage, makeInput({ record: null }));
    draft = withField(draft, draftField({ id: "model_group:$name", value: "fast" }));
    draft = withField(
      draft,
      draftField({ id: "model_group:entries", value: [{ _rowId: "r1", provider: "p", model: "m" }] }),
    );
    const ops = encodeChanges(modelGroupPage, draft, makeInput({ record: null }));
    expect(singleOp(ops)).toEqual({
      op: "create",
      collection: "model_groups",
      record: { id: "fast", name: "fast", enabled: true, value: [{ provider: "p", model: "m" }] },
    });
  });

  it("refuses to create without a usable entity id", () => {
    const pristine = decodeDraft(providerPage, makeInput({ record: null }));
    expect(() => encodeChanges(providerPage, pristine, makeInput({ record: null }))).toThrow(TypeError);
    expect(() => encodeChanges(providerPage, pristine, makeInput({ record: null }))).toThrow(
      'cannot create a provider record without a non-empty id value',
    );
    const numericId = withField(pristine, draftField({ id: "provider:id", value: 42 }));
    expect(() => encodeChanges(providerPage, numericId, makeInput({ record: null }))).toThrow(TypeError);

    const noNameMapPage = makePage({
      id: "x",
      entity: { kind: "workspace", collection: "workspaces", idField: null, valueShape: "object" },
      fields: [makeField({ id: "workspace:work_path", path: ["work_path"], control: "text", valueKind: "string" })],
    });
    const mapDraft = decodeDraft(noNameMapPage, makeInput({ record: null }));
    expect(() => encodeChanges(noNameMapPage, mapDraft, makeInput({ record: null }))).toThrow("non-empty name value");

    const noIdPage = makePage({
      id: "x",
      entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object" },
      fields: [makeField({ id: "provider:model", path: ["model"], control: "text", valueKind: "string" })],
    });
    const idlessDraft = decodeDraft(noIdPage, makeInput({ record: null }));
    expect(() => encodeChanges(noIdPage, idlessDraft, makeInput({ record: null }))).toThrow(TypeError);
  });

  it("U10: empty secret-ref values encode as absent; masks and bad names throw", () => {
    const base = makeInput({ record: makeRecord(providerValue) });
    const draft = decodeDraft(providerPage, base);
    const cleared = withField(draft, draftField({ id: "provider:api_key_env", value: "" }));
    const ops = encodeChanges(providerPage, cleared, base);
    const op = singleOp(ops);
    expect(op.op).toBe("update");
    if (op.op !== "update") throw new Error("unreachable");
    expect(op.value).not.toHaveProperty("api_key_env");

    const nullValue = withField(draft, draftField({ id: "provider:api_key_env", value: null }));
    expect(() => encodeChanges(providerPage, nullValue, base)).not.toThrow();
    const undefinedValue = withField(draft, draftField({ id: "provider:api_key_env", value: undefined }));
    expect(() => encodeChanges(providerPage, undefinedValue, base)).not.toThrow();

    for (const bad of ["configured", "•••"]) {
      const masked = withField(draft, draftField({ id: "provider:api_key_env", value: bad }));
      expect(() => encodeChanges(providerPage, masked, base)).throw(TypeError, /credential mask/);
    }
    const badName = withField(draft, draftField({ id: "provider:api_key_env", value: "1BAD-NAME" }));
    expect(() => encodeChanges(providerPage, badName, base)).throw(TypeError, /environment variable name/);
    const nonString = withField(draft, draftField({ id: "provider:api_key_env", value: 42 }));
    expect(() => encodeChanges(providerPage, nonString, base)).throw(TypeError, /must be a string/);
  });

  it("U10b: secret-value encodes keep/clear/replace semantics for literal credentials", () => {
    const triggerPage = makePage({
      id: "triggers",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({ id: "trigger:name", path: ["name"], control: "text", valueKind: "string" }),
        makeField({ id: "trigger:token", path: ["token"], control: "secret-value", valueKind: "string" }),
      ],
    });
    const record = makeRecord({ name: "gitea", kind: "gitea", token: "<redacted>" });
    const base = makeInput({ record });
    const draft = decodeDraft(triggerPage, base);

    // Untouched masked value: omitted from the update (server keeps the stored secret).
    const untouched = singleOp(encodeChanges(triggerPage, draft, base));
    if (untouched.op !== "update") throw new Error("unreachable");
    expect(untouched.value).not.toHaveProperty("token");

    // Explicit clear: empty string encodes as JSON null.
    const cleared = withField(draft, draftField({ id: "trigger:token", value: "" }));
    const clearOp = singleOp(encodeChanges(triggerPage, cleared, base));
    if (clearOp.op !== "update") throw new Error("unreachable");
    expect(clearOp.value).toHaveProperty("token", null);

    // Replacement literal passes through verbatim.
    const replaced = withField(draft, draftField({ id: "trigger:token", value: "gtok-new" }));
    const replaceOp = singleOp(encodeChanges(triggerPage, replaced, base));
    if (replaceOp.op !== "update") throw new Error("unreachable");
    expect(replaceOp.value).toMatchObject({ token: "gtok-new" });

    // Mask sentinels and <redacted> are stripped; null/undefined encode as absent;
    // non-strings are rejected.
    for (const masked of ["configured", "•••", "<redacted>"]) {
      const maskedDraft = withField(draft, draftField({ id: "trigger:token", value: masked }));
      const maskedOp = singleOp(encodeChanges(triggerPage, maskedDraft, base));
      if (maskedOp.op !== "update") throw new Error("unreachable");
      expect(maskedOp.value).not.toHaveProperty("token");
    }
    for (const absent of [null, undefined]) {
      const absentDraft = withField(draft, draftField({ id: "trigger:token", value: absent }));
      const absentOp = singleOp(encodeChanges(triggerPage, absentDraft, base));
      if (absentOp.op !== "update") throw new Error("unreachable");
      expect(absentOp.value).not.toHaveProperty("token");
    }
    const nonString = withField(draft, draftField({ id: "trigger:token", value: 42 }));
    expect(() => encodeChanges(triggerPage, nonString, base)).throw(TypeError, /must be a string/);
  });

  it("keeps a masked global secret and unsets it only after an explicit clear", () => {
    const page = makePage({ id: "auth", globals: true, fields: [
      makeField({ id: "auth:api_key", path: ["auth", "api_key"], control: "secret-value", valueKind: "string" }),
    ] });
    const base = makeInput({ fields: [fieldEntry("auth.api_key", "database", "<redacted>")] });
    const draft = decodeDraft(page, base);
    expect(encodeChanges(page, draft, base)).toEqual([]);
    expect(encodeChanges(page, withField(draft, draftField({ id: "auth:api_key", value: "" })), base))
      .toEqual([{ op: "unset", path: ["auth", "api_key"] }]);
  });

  it("encodes matcher controls to the exact/glob/regex union shapes", () => {
    const matcherPage = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [makeField({ id: "trigger:filter", path: ["filter"], control: "matcher", valueKind: "union" })],
    });
    const cases: readonly [unknown, unknown][] = [
      [{ mode: "exact", pattern: "a", ignore_case: false }, { exact: "a" }],
      [{ mode: "exact", pattern: "a", ignore_case: true }, { exact: "a" }],
      [{ mode: "glob", pattern: "a/*", ignore_case: true }, { glob: "a/*", ignore_case: true }],
      [{ mode: "glob", pattern: "a/*", ignore_case: false }, { glob: "a/*" }],
      [{ mode: "regex", pattern: "^a", ignore_case: false }, { regex: "^a" }],
      // Malformed control values pass through verbatim (never silently dropped).
      [{ weird: true }, { weird: true }],
      [{ mode: "exact", pattern: 5 }, { mode: "exact", pattern: 5 }],
      [{ mode: "exact", pattern: "x", ignore_case: "yes" }, { mode: "exact", pattern: "x", ignore_case: "yes" }],
    ];
    for (const [value, expected] of cases) {
      const draft = {
        scope: { kind: "entity", collection: "triggers", recordId: "t" },
        fields: { "trigger:filter": draftField({ id: "trigger:filter", value }) },
        baseRevision: 7,
        fileDigest: "digest-abc",
      } satisfies ConfigDraft;
      const op = singleOp(encodeChanges(matcherPage, draft, makeInput()));
      expect(op).toEqual({ op: "update", collection: "triggers", recordId: "t", value: { filter: expected } });
    }
  });

  it("materializes map rows and rejects duplicate, prototype and malformed keys", () => {
    const mapPage = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [makeField({ id: "trigger:vars", path: ["vars"], control: "map", valueKind: "record", mapValueKind: "string" })],
    });
    const draftWith = (value: unknown): ConfigDraft => ({
      scope: { kind: "entity", collection: "triggers", recordId: "t" },
      fields: { "trigger:vars": draftField({ id: "trigger:vars", value }) },
      baseRevision: 7,
      fileDigest: "digest-abc",
    });
    const ok = singleOp(
      encodeChanges(
        mapPage,
        draftWith([
          { _rowId: "r1", key: "b", value: 1 },
          { _rowId: "r2", key: "a", value: 2 },
        ]),
        makeInput(),
      ),
    );
    expect(ok).toEqual({ op: "update", collection: "triggers", recordId: "t", value: { vars: { b: 1, a: 2 } } });

    expect(() => encodeChanges(mapPage, draftWith([{ key: "a" }, { key: "a" }]), makeInput())).throw(TypeError, /duplicate key "a"/);
    expect(() => encodeChanges(mapPage, draftWith([{ key: "__proto__", value: 1 }]), makeInput())).throw(TypeError, /prototype key/);
    expect(() => encodeChanges(mapPage, draftWith(["nope"]), makeInput())).throw(TypeError, /string key/);
    expect(() => encodeChanges(mapPage, draftWith([{ key: 7, value: 1 }]), makeInput())).throw(TypeError, /string key/);
    // Non-array map values pass through cloned (defensive).
    const passthrough = singleOp(encodeChanges(mapPage, draftWith({ already: "object" }), makeInput()));
    expect(passthrough).toEqual({ op: "update", collection: "triggers", recordId: "t", value: { vars: { already: "object" } } });
  });

  it("U17: merges extras verbatim and refuses prototype keys inside them", () => {
    const base = makeInput({ record: makeRecord(providerValue) });
    const draft = decodeDraft(providerPage, base);
    const op = singleOp(encodeChanges(providerPage, draft, base));
    expect(op.op).toBe("update");
    if (op.op !== "update") throw new Error("unreachable");
    expect(op.value).toEqual({
      future_header: { "X-Trace": "on" },
      future_list: ["a", "b"],
      id: "openai-main",
      kind: "openai",
      model: "gpt-5",
      api_key_env: "OPENAI_API_KEY",
      timeout_seconds: 60,
      disabled: false,
    });

    const badExtras: ConfigDraft = {
      scope: { kind: "entity", collection: "providers", recordId: "p" },
      fields: { $extras: draftField({ id: "$extras", value: "not-an-object" }) },
      baseRevision: 7,
      fileDigest: "digest-abc",
    };
    expect(() => encodeChanges(providerPage, badExtras, base)).throw(TypeError, /\$extras must be a plain object/);

    const protoExtras = (value: unknown): ConfigDraft => ({
      scope: { kind: "entity", collection: "providers", recordId: "p" },
      fields: { $extras: draftField({ id: "$extras", value }) },
      baseRevision: 7,
      fileDigest: "digest-abc",
    });
    expect(() => encodeChanges(providerPage, protoExtras(JSON.parse('{"__proto__":{"x":1}}')), base)).throw(TypeError, /prototype key/);
    expect(() => encodeChanges(providerPage, protoExtras(JSON.parse('{"safe":[{"__proto__":1}]}')), base)).throw(TypeError, /prototype key/);
  });

  it("U17: decodes own __proto__ record keys into extras without pollution", () => {
    const value = JSON.parse('{"__proto__":{"x":1},"id":"p","kind":"openai"}') as unknown;
    const draft = decodeDraft(providerPage, makeInput({ record: makeRecord(value) }));
    const extras = draft.fields["$extras"]?.value as Record<string, unknown>;
    expect(Object.hasOwn(extras, "__proto__")).toBe(true);
    expect((extras as { __proto__: unknown }).__proto__).toEqual({ x: 1 });
    expect(() => encodeChanges(providerPage, draft, makeInput())).throw(TypeError, /prototype key/);
  });

  it("skips fields missing from the draft, absent fields and inherited fields", () => {
    const base = makeInput({ record: makeRecord(providerValue) });
    const decoded = decodeDraft(providerPage, base);
    const { "provider:model": _omitted, ...rest } = decoded.fields;
    let draft: ConfigDraft = { ...decoded, fields: rest };
    draft = withField(draft, draftField({ id: "provider:disabled", mode: "present", inherit: true, value: true }));
    const op = singleOp(encodeChanges(providerPage, draft, base));
    if (op.op !== "update") throw new Error("unreachable");
    expect(op.value).not.toHaveProperty("model");
    expect(op.value).not.toHaveProperty("disabled");
  });

  it("skips non-name path-[] fields on object-shaped records", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object" },
      fields: [
        makeField({ id: "provider:whole", path: [], control: "text", valueKind: "string" }),
        makeField({ id: "provider:id", path: ["id"], control: "text", valueKind: "string" }),
      ],
    });
    const draft = decodeDraft(page, makeInput({ record: makeRecord({ id: "p" }) }));
    expect(draft.fields["provider:whole"]?.mode).toBe("present");
    const op = singleOp(encodeChanges(page, draft, makeInput()));
    expect(op).toEqual({ op: "update", collection: "providers", recordId: "rec-1", value: { id: "p" } });
  });

  it("encodes empty rows for array-shaped records without a list field or value", () => {
    const nameOnlyPage = makePage({
      id: "x",
      entity: { kind: "model_group", collection: "model_groups", idField: null, valueShape: "array" },
      fields: [makeField({ id: "model_group:$name", path: [], control: "text", valueKind: "string" })],
    });
    const noList = singleOp(
      encodeChanges(
        nameOnlyPage,
        { scope: { kind: "entity", collection: "model_groups", recordId: "default" }, fields: {}, baseRevision: 7, fileDigest: "d" },
        makeInput(),
      ),
    );
    expect(noList).toEqual({ op: "update", collection: "model_groups", recordId: "default", value: [] });

    const absentList = singleOp(
      encodeChanges(
        modelGroupPage,
        { scope: { kind: "entity", collection: "model_groups", recordId: "default" }, fields: {}, baseRevision: 7, fileDigest: "d" },
        makeInput(),
      ),
    );
    expect(absentList).toEqual({ op: "update", collection: "model_groups", recordId: "default", value: [] });

    const secretListPage = makePage({
      id: "x",
      entity: { kind: "model_group", collection: "model_groups", idField: null, valueShape: "array" },
      fields: [makeField({ id: "model_group:secret", path: [], control: "secret-ref", valueKind: "string" })],
    });
    const skipList = singleOp(
      encodeChanges(
        secretListPage,
        {
          scope: { kind: "entity", collection: "model_groups", recordId: "default" },
          fields: { "model_group:secret": draftField({ id: "model_group:secret", value: "" }) },
          baseRevision: 7,
          fileDigest: "d",
        },
        makeInput(),
      ),
    );
    expect(skipList).toEqual({ op: "update", collection: "model_groups", recordId: "default", value: [] });
  });

  it("roundtrips string-shaped records (template/prompt documents)", () => {
    const templatePage = makePage({
      id: "templates",
      entity: { kind: "template", collection: "templates", idField: null, valueShape: "string" },
      fields: [
        makeField({ id: "template:$name", path: [], control: "text", valueKind: "string" }),
        makeField({ id: "template:*", path: [], control: "document", valueKind: "string" }),
      ],
    });
    // Decode: the record value IS the document string.
    const draft = decodeDraft(templatePage, makeInput({
      record: makeRecord("Summary {{run.id}}", { name: "pr-summary" }),
    }));
    expect(draft.fields["template:$name"]?.value).toBe("pr-summary");
    expect(draft.fields["template:*"]).toMatchObject({ mode: "present", value: "Summary {{run.id}}" });

    // Encode: edits flow back as the bare string record value.
    const edited: ConfigDraft = {
      ...draft,
      fields: {
        ...draft.fields,
        "template:*": draftField({ id: "template:*", value: "---\nname: x\n---\nNew body\n" }),
      },
    };
    const op = singleOp(encodeChanges(templatePage, edited, makeInput()));
    expect(op).toEqual({ op: "update", collection: "templates", recordId: "rec-1", value: "---\nname: x\n---\nNew body\n" });

    // A blank/absent document encodes as the empty string, never dropped.
    const blanked: ConfigDraft = {
      ...draft,
      fields: { ...draft.fields, "template:*": draftField({ id: "template:*", mode: "absent", value: "" }) },
    };
    expect(singleOp(encodeChanges(templatePage, blanked, makeInput()))).toEqual({
      op: "update", collection: "templates", recordId: "rec-1", value: "",
    });
    const incompletePage = { ...templatePage, sections: templatePage.sections.map(section => ({ ...section,
      fields: section.fields.filter(field => field.control !== "document"),
    })) };
    expect(() => encodeChanges(incompletePage, draft, makeInput())).toThrow(/document field is missing/);
    expect(draft.fields["template:*"]?.value).toBe("Summary {{run.id}}");
  });

  it("creates string-shaped records from a create draft", () => {
    const promptPage = makePage({
      id: "prompts",
      entity: { kind: "prompt", collection: "prompts", idField: null, valueShape: "string" },
      fields: [
        makeField({ id: "prompt:$name", path: [], control: "text", valueKind: "string" }),
        makeField({ id: "prompt:*", path: [], control: "document", valueKind: "string" }),
      ],
    });
    const draft = decodeDraft(promptPage, makeInput({ record: null }));
    const filled: ConfigDraft = {
      ...draft,
      fields: {
        ...draft.fields,
        "prompt:$name": draftField({ id: "prompt:$name", value: "team-base" }),
        "prompt:*": draftField({ id: "prompt:*", value: "You review code." }),
      },
    };
    const op = singleOp(encodeChanges(promptPage, filled, makeInput()));
    expect(op).toEqual({ op: "create", collection: "prompts", record: expect.objectContaining({ name: "team-base", value: "You review code." }) });
  });

  it("re-encodes nested matcher rows through array containers", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({
          id: "trigger:rules",
          path: ["rules"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [
            makeField({ id: "trigger:rules[].source", path: ["source"], control: "matcher", valueKind: "union" }),
            makeField({ id: "trigger:rules[].window.start", path: ["windows", "0", "start"], control: "matcher", valueKind: "union" }),
            makeField({ id: "trigger:rules[].missing", path: ["missing"], control: "matcher", valueKind: "union" }),
          ],
        }),
      ],
    });
    const draft: ConfigDraft = {
      scope: { kind: "entity", collection: "triggers", recordId: "t" },
      fields: {
        "trigger:rules": draftField({
          id: "trigger:rules",
          value: [
            {
              _rowId: "r9",
              source: { mode: "glob", pattern: "a/*", ignore_case: true },
              windows: [{ start: { mode: "exact", pattern: "09:00", ignore_case: false } }],
            },
            "scalar-row",
          ],
        }),
      },
      baseRevision: 7,
      fileDigest: "d",
    };
    const op = singleOp(encodeChanges(page, draft, makeInput()));
    expect(op).toEqual({
      op: "update",
      collection: "triggers",
      recordId: "t",
      value: {
        rules: [{ source: { glob: "a/*", ignore_case: true }, windows: [{ start: { exact: "09:00" } }] }, "scalar-row"],
      },
    });
  });

  it("refuses prototype path tokens when materializing records", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object" },
      fields: [makeField({ id: "provider:evil", path: ["__proto__"], control: "text", valueKind: "string" })],
    });
    const draft: ConfigDraft = {
      scope: { kind: "entity", collection: "providers", recordId: "p" },
      fields: { "provider:evil": draftField({ id: "provider:evil", value: "x" }) },
      baseRevision: 7,
      fileDigest: "d",
    };
    expect(() => encodeChanges(page, draft, makeInput())).throw(TypeError, /refusing prototype path token/);
  });

  it("passes scalar and non-array values through list and multiselect encoders", () => {
    const page = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [
        makeField({ id: "trigger:multi", path: ["multi"], control: "multiselect", valueKind: "string[]" }),
        makeField({ id: "trigger:scalars", path: ["scalars"], control: "ordered-list", valueKind: "record" }),
        makeField({
          id: "trigger:rows",
          path: ["rows"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [makeField({ id: "trigger:rows[].x", path: ["x"], control: "text", valueKind: "string" })],
        }),
      ],
    });
    const draft: ConfigDraft = {
      scope: { kind: "entity", collection: "triggers", recordId: "t" },
      fields: {
        "trigger:multi": draftField({ id: "trigger:multi", value: "not-an-array" }),
        "trigger:scalars": draftField({ id: "trigger:scalars", value: [1, 2] }),
        "trigger:rows": draftField({ id: "trigger:rows", value: "not-an-array" }),
      },
      baseRevision: 7,
      fileDigest: "d",
    };
    expect(singleOp(encodeChanges(page, draft, makeInput()))).toEqual({
      op: "update",
      collection: "triggers",
      recordId: "t",
      value: { multi: "not-an-array", scalars: [1, 2], rows: "not-an-array" },
    });
  });

  it("throws for entity drafts on non-entity pages", () => {
    const draft: ConfigDraft = {
      scope: { kind: "entity", collection: "providers", recordId: "p" },
      fields: {},
      baseRevision: 7,
      fileDigest: "d",
    };
    expect(() => encodeChanges(reviewPage, draft, makeInput())).throw(TypeError, /entity draft requires an entity page/);
  });
});

// ---------------------------------------------------------------------------
// U05/U10 — encodeChanges (globals scope)
// ---------------------------------------------------------------------------

describe("encodeChanges globals scope", () => {
  it("encodes writable structured map rows without leaking editor row identities", () => {
    const page = makePage({ id: "llm", globals: true, fields: [makeField({
      id: "llm:per_provider_overrides", path: ["llm", "per_provider_overrides"], control: "map", valueKind: "record",
      mapValueKind: "record", itemFields: [makeField({ id: "provider:timeout_ms", path: ["timeout_ms"], control: "number", valueKind: "number" })],
    })] });
    const base = makeInput({ fields: [fieldEntry("llm.per_provider_overrides", "database", { local: { timeout_ms: 100 } })] });
    const draft = decodeDraft(page, base);
    expect(encodeChanges(page, draft, base)).toEqual([]);
    const changed = withField(draft, draftField({ id: "llm:per_provider_overrides",
      value: [{ _rowId: "editor-only", key: "local", value: { timeout_ms: 200 } }] }));
    expect(encodeChanges(page, changed, base)).toEqual([
      { op: "set", path: ["llm", "per_provider_overrides"], value: { local: { timeout_ms: 200 } } },
    ]);
  });

  const reviewBase = makeInput({
    fields: [
      fieldEntry("review.max_files", "database", 80, [{ source: "file", value: 50 }]),
      fieldEntry("review.skip_lgtm", "file", true),
      fieldEntry("review.output_language", "default", "zh-CN"),
      fieldEntry("review.source_filter", "database", { exact: "a", glob: "b" }),
    ],
  });

  it("emits only real diffs; deep-equal DB values are no-ops", () => {
    const draft = decodeDraft(reviewPage, reviewBase);
    const ops = encodeChanges(reviewPage, draft, reviewBase);
    // source_filter decodes absent (malformed matcher) over a DB base: unset.
    expect(ops).toEqual([{ op: "unset", path: ["review", "source_filter"] }]);
  });

  it("U05: inherit toggles produce unset only against a database base", () => {
    const draft = decodeDraft(reviewPage, reviewBase);
    const inherited = withField(draft, draftField({ id: "review:max_files", mode: "absent", inherit: true, value: 50 }));
    const ops = encodeChanges(reviewPage, inherited, reviewBase);
    expect(ops).toEqual([
      { op: "unset", path: ["review", "max_files"] },
      { op: "unset", path: ["review", "source_filter"] },
    ]);
    // File-sourced fields never unset, even when the draft drops them.
    const droppedFile = withField(draft, draftField({ id: "review:skip_lgtm", mode: "absent", inherit: true, value: undefined }));
    const fileOps = encodeChanges(reviewPage, droppedFile, reviewBase);
    expect(fileOps).toEqual([{ op: "unset", path: ["review", "source_filter"] }]);
  });

  it("U05: false, 0 and [] are emitted verbatim, never treated as clear", () => {
    const base = makeInput({
      fields: [
        fieldEntry("review.skip_lgtm", "database", true),
        fieldEntry("review.max_files", "database", 80),
        fieldEntry("review.include", "database", ["src/**"]),
      ],
    });
    let draft = decodeDraft(reviewPage, base);
    draft = withField(draft, draftField({ id: "review:skip_lgtm", value: false }));
    draft = withField(draft, draftField({ id: "review:max_files", value: 0 }));
    draft = withField(draft, draftField({ id: "review:include", value: [] }));
    const ops = encodeChanges(reviewPage, draft, base);
    expect(ops).toEqual([
      { op: "set", path: ["review", "max_files"], value: 0 },
      { op: "set", path: ["review", "skip_lgtm"], value: false },
      { op: "set", path: ["review", "include"], value: [] },
    ]);
    // Same values as base: no operations at all.
    const pristine = decodeDraft(reviewPage, base);
    expect(encodeChanges(reviewPage, pristine, base)).toEqual([]);
  });

  it("deep equality is key-order insensitive for objects and strict for arrays", () => {
    const base = makeInput({
      fields: [
        fieldEntry('llm.per_provider_overrides["x.y"].base_url', "database", "https://x"),
        fieldEntry('llm.per_provider_overrides["x.y"].model', "database", "m-1"),
      ],
    });
    const draft = decodeDraft(llmGlobalsPage, base);
    // Decoded map rows match the base composite: no op for the map field;
    // the escaped leaf also matches; default/retry fields have no DB base.
    expect(encodeChanges(llmGlobalsPage, draft, base)).toEqual([]);

    const changed = withField(
      draft,
      draftField({
        id: "llm:per_provider_overrides",
        value: [{ _rowId: "r1", key: "x.y", value: { model: "m-2", base_url: "https://x" } }],
      }),
    );
    const ops = encodeChanges(llmGlobalsPage, changed, base);
    expect(ops).toEqual([{ op: "set", path: ["llm", "per_provider_overrides"], value: { "x.y": { model: "m-2", base_url: "https://x" } } }]);

    const renamed = withField(
      draft,
      draftField({ id: "llm:per_provider_overrides", value: [{ _rowId: "r1", key: "z.z", value: { base_url: "https://x" } }] }),
    );
    // Same key count with a missing key is still a diff, never a false no-op.
    expect(encodeChanges(llmGlobalsPage, renamed, base)).toEqual([
      { op: "set", path: ["llm", "per_provider_overrides"], value: { "z.z": { base_url: "https://x" } } },
    ]);
    const grown = withField(
      draft,
      draftField({
        id: "llm:per_provider_overrides",
        value: [
          { _rowId: "r1", key: "x.y", value: { base_url: "https://x", model: "m-1" } },
          { _rowId: "r2", key: "w", value: { base_url: "https://w" } },
        ],
      }),
    );
    expect(encodeChanges(llmGlobalsPage, grown, base)).toEqual([
      {
        op: "set",
        path: ["llm", "per_provider_overrides"],
        value: { "x.y": { base_url: "https://x", model: "m-1" }, w: { base_url: "https://w" } },
      },
    ]);

    const arrayBase = makeInput({ fields: [fieldEntry("review.include", "database", ["a", "b"])] });
    let arrayDraft = decodeDraft(reviewPage, arrayBase);
    arrayDraft = withField(arrayDraft, draftField({ id: "review:include", value: ["b", "a"] }));
    expect(encodeChanges(reviewPage, arrayDraft, arrayBase)).toEqual([{ op: "set", path: ["review", "include"], value: ["b", "a"] }]);
  });

  it("unescapes path tokens in set/unset operations", () => {
    const base = makeInput({ fields: [fieldEntry('llm.per_provider_overrides["x.y"].base_url', "database", "https://x")] });
    let draft = decodeDraft(llmGlobalsPage, base);
    draft = withField(draft, draftField({ id: "llm:per_provider_overrides.x~002Ey.base_url", value: "https://y" }));
    draft = withField(draft, draftField({ id: "llm:per_provider_overrides", mode: "absent", inherit: true, value: [] }));
    const ops = encodeChanges(llmGlobalsPage, draft, base);
    expect(ops).toEqual([
      { op: "unset", path: ["llm", "per_provider_overrides"] },
      { op: "set", path: ["llm", "per_provider_overrides", "x.y", "base_url"], value: "https://y" },
    ]);
  });

  it("U10: cleared secret-ref globals unset database overrides only", () => {
    const dbBase = makeInput({ fields: [fieldEntry("review.signing_secret_env", "database", "SIGNING_KEY")] });
    const dbDraft = decodeDraft(reviewPage, dbBase);
    const clearedDb = withField(dbDraft, draftField({ id: "review:signing_secret_env", value: "" }));
    expect(encodeChanges(reviewPage, clearedDb, dbBase)).toEqual([{ op: "unset", path: ["review", "signing_secret_env"] }]);

    const replaced = withField(dbDraft, draftField({ id: "review:signing_secret_env", value: "NEW_KEY" }));
    expect(encodeChanges(reviewPage, replaced, dbBase)).toEqual([{ op: "set", path: ["review", "signing_secret_env"], value: "NEW_KEY" }]);

    const defaultBase = makeInput({ fields: [fieldEntry("review.signing_secret_env", "default", undefined)] });
    const defaultDraft = decodeDraft(reviewPage, defaultBase);
    expect(encodeChanges(reviewPage, defaultDraft, defaultBase)).toEqual([]);
  });

  it("cleared optional scalars never encode as a DTO-invalid set (U06 empty=absent)", () => {
    // Value binding + database base: clearing unsets the override.
    const dbBase = makeInput({ fields: [fieldEntry("review.max_files", "database", 12)] });
    const dbDraft = withField(decodeDraft(reviewPage, dbBase), draftField({ id: "review:max_files", value: undefined }));
    expect(encodeChanges(reviewPage, dbDraft, dbBase)).toEqual([{ op: "unset", path: ["review", "max_files"] }]);
    // Value binding + default base: clearing is a no-op, not a set.
    const defaultBase = makeInput({ fields: [fieldEntry("review.max_files", "default", 50)] });
    const defaultDraft = withField(decodeDraft(reviewPage, defaultBase), draftField({ id: "review:max_files", value: undefined }));
    expect(encodeChanges(reviewPage, defaultDraft, defaultBase)).toEqual([]);
    // Inherit-or-override: an empty override is not an implicit inherit (§8.1).
    const inheritPage = makePage({
      id: "inherit",
      globals: true,
      fields: [
        makeField({ id: "review:max_files", path: ["review", "max_files"], control: "number", valueKind: "number", binding: "inherit-or-override", optional: true }),
      ],
    });
    const inheritBase = makeInput({ fields: [fieldEntry("review.max_files", "database", 12)] });
    const inheritDraft = withField(
      decodeDraft(inheritPage, inheritBase),
      draftField({ id: "review:max_files", value: undefined, inherit: false }),
    );
    expect(() => encodeChanges(inheritPage, inheritDraft, inheritBase)).toThrowError(/requires a value/u);
  });

  it("treats NaN as never equal and null as distinct from undefined", () => {
    const nanBase = makeInput({ fields: [fieldEntry("review.max_files", "database", Number.NaN)] });
    const nanDraft = decodeDraft(reviewPage, nanBase);
    expect(nanDraft.fields["review:max_files"]?.value).toBeNaN();
    expect(encodeChanges(reviewPage, nanDraft, nanBase)).toEqual([{ op: "set", path: ["review", "max_files"], value: Number.NaN }]);

    const nullBase = makeInput({ fields: [fieldEntry("review.max_files", "database", null)] });
    const nullDraft = withField(decodeDraft(reviewPage, nullBase), draftField({ id: "review:max_files", value: undefined }));
    // A cleared optional scalar on a value binding encodes as absent (unset),
    // never as a DTO-invalid `set` without a value.
    expect(encodeChanges(reviewPage, nullDraft, nullBase)).toEqual([{ op: "unset", path: ["review", "max_files"] }]);
  });

  it("skips draft fields with no entry and sets everything without a base view", () => {
    const draft = globalsDraft({
      "review:max_files": draftField({ id: "review:max_files", value: 10 }),
    });
    expect(encodeChanges(reviewPage, draft, makeInput())).toEqual([{ op: "set", path: ["review", "max_files"], value: 10 }]);
  });

  it("emits multiselect values deduplicated", () => {
    const base = makeInput({ fields: [fieldEntry("review.include", "database", ["a"])] });
    const draft = globalsDraft({ "review:include": draftField({ id: "review:include", value: ["a", "b", "a"] }) });
    expect(encodeChanges(reviewPage, draft, base)).toEqual([{ op: "set", path: ["review", "include"], value: ["a", "b"] }]);
  });
});

// ---------------------------------------------------------------------------
// U18 — decode/encode roundtrips per entity kind
// ---------------------------------------------------------------------------

describe("U18 entity roundtrips", () => {
  function expectRoundtrip(page: ConfigUiPage, record: ConfigEntityRecordView, expectedValue: unknown): void {
    const input = makeInput({ record });
    const draft = decodeDraft(page, input);
    const op = singleOp(encodeChanges(page, draft, input));
    expect(op).toEqual({ op: "update", collection: page.entity?.collection, recordId: record.id, value: expectedValue });
    const redecoded = decodeDraft(page, makeInput({ record: { ...record, value: expectedValue, effectiveValue: expectedValue } }));
    expect(redecoded).toEqual(draft);
  }

  it("provider (array collection, passthrough extras)", () => {
    const record = makeRecord(providerValue, { id: "openai-main", name: "openai-main" });
    expectRoundtrip(providerPage, record, {
      future_header: { "X-Trace": "on" },
      future_list: ["a", "b"],
      id: "openai-main",
      kind: "openai",
      model: "gpt-5",
      api_key_env: "OPENAI_API_KEY",
      timeout_seconds: 60,
      disabled: false,
    });
  });

  it("model_group (map collection, array value shape)", () => {
    const record = makeRecord(modelGroupValue, { id: "default", name: "default" });
    expectRoundtrip(modelGroupPage, record, [
      { provider: "openai-main", model: "gpt-5" },
      { provider: "backup", model: "claude-sonnet-4" },
    ]);
  });

  it("trigger github app (nested kind-variant fields)", () => {
    const record = makeRecord(githubTriggerValue, { id: "github-main", name: "github-main" });
    expectRoundtrip(triggerPage, record, {
      name: "github-main",
      kind: "github",
      app: { app_id: 1234, private_key_env: "GITHUB_APP_KEY" },
    });
  });

  it("trigger p4 (kind-variant scalar fields)", () => {
    const record = makeRecord(p4TriggerValue, { id: "p4-main", name: "p4-main" });
    expectRoundtrip(triggerPage, record, {
      name: "p4-main",
      kind: "p4",
      port: "ssl:perforce:1666",
      user_env: "P4USER",
      watch_path: "//depot/main/...",
    });
  });

  it("channel gitlab_mr_review", () => {
    const record = makeRecord(gitlabChannelValue, { id: "gl-mr", name: "gl-mr" });
    expectRoundtrip(channelPage, record, {
      name: "gl-mr",
      kind: "gitlab_mr_review",
      trigger: "gitlab-main",
      project: "group/repo",
    });
  });

  it("workspace with match rules and work_path", () => {
    const record = makeRecord(workspaceValue, { id: "ws-1", name: "ws-1" });
    expectRoundtrip(workspacePage, record, {
      work_path: "src",
      match: [{ triggers: ["github-main"], source: { glob: "Owner/*", ignore_case: true } }],
      model_chain: "default",
    });
  });

  it("route with analysis overrides", () => {
    const record = makeRecord(routeValue, { id: "r-1", name: "r-1" });
    expectRoundtrip(routePage, record, {
      id: "r-1",
      enabled: true,
      priority: 5,
      workspace: "ws-1",
      match: { triggers: ["github-main"] },
      analysis: { model_chain: "default" },
      outputs: { summary: ["gl-mr"] },
    });
  });
});

// ---------------------------------------------------------------------------
// U07/U11/U13/U15/U20 — resolveFieldState
// ---------------------------------------------------------------------------

describe("resolveFieldState", () => {
  it("returns a default state for unknown field ids", () => {
    const draft = decodeDraft(providerPage, makeInput({ record: makeRecord(providerValue) }));
    const state = resolveFieldState(providerPage, "provider:ghost", draft, {}, [{ message: "ignored", path: ["kind"] }]);
    expect(state).toEqual({ visible: true, disabled: false, options: [] });
  });

  it("U24: untagged defaults errors never land on same-shaped entity fields", () => {
    // Dual-domain page (workspaces: defaults globals + instance entity) where
    // the entity field's relative keys are a suffix of the globals path.
    const dualPage = makePage({
      id: "workspaces",
      entity: { kind: "workspace", collection: "workspaces", idField: null, valueShape: "object" },
      globals: true,
      fields: [
        makeField({ id: "workspace:review.max_files", path: ["review", "max_files"], control: "number", valueKind: "number" }),
        makeField({ id: "workspaces:defaults.review.max_files", path: ["workspaces", "defaults", "review", "max_files"], control: "number", valueKind: "number" }),
      ],
    });
    const record = makeRecord({ review: { max_files: 7 } }, { id: "ws1", name: "ws1" });
    const entityDraft = decodeDraft(dualPage, makeInput({ record }));
    // An untagged error whose path IS a globals field path belongs to defaults.
    const defaultsError = [{ message: "defaults bad", path: ["workspaces", "defaults", "review", "max_files"] }];
    expect(resolveFieldState(dualPage, "workspace:review.max_files", entityDraft, {}, defaultsError).error).toBeUndefined();
    // A full document path through the entity record still suffix-matches.
    const entityError = [{ message: "entity bad", path: ["workspaces", "instances", "ws1", "review", "max_files"] }];
    expect(resolveFieldState(dualPage, "workspace:review.max_files", entityDraft, {}, entityError).error).toBe("entity bad");
    // Entity-tagged errors keep their strict addressing.
    const tagged = [{ message: "tagged bad", path: ["review", "max_files"], entity: { kind: "workspace", id: "ws1" } }];
    expect(resolveFieldState(dualPage, "workspace:review.max_files", entityDraft, {}, tagged).error).toBe("tagged bad");
    const otherTagged = [{ message: "other record", path: ["review", "max_files"], entity: { kind: "workspace", id: "ws2" } }];
    expect(resolveFieldState(dualPage, "workspace:review.max_files", entityDraft, {}, otherTagged).error).toBeUndefined();
  });

  it("disables fields with readonlyReason and surfaces static options", () => {
    const page = makePage({
      id: "p",
      fields: [
        makeField({
          id: "server:port",
          path: ["server", "port"],
          control: "number",
          valueKind: "number",
          readonlyReason: "bootstrap-owned; edit the config file",
        }),
      ],
    });
    const state = resolveFieldState(page, "server:port", globalsDraft({}), {});
    expect(state).toEqual({ visible: true, disabled: true, disabledReason: "bootstrap-owned; edit the config file", options: [] });

    const kindState = resolveFieldState(providerPage, "provider:kind", decodeDraft(providerPage, makeInput({ record: null })), {});
    expect(kindState.options).toEqual([{ value: "openai" }, { value: "anthropic" }, { value: "azure_openai" }]);
  });

  it("U15: hides kind-variant fields the current kind does not use", () => {
    const githubDraft = decodeDraft(triggerPage, makeInput({ record: makeRecord(githubTriggerValue, { name: "g" }) }));
    const portState = resolveFieldState(triggerPage, "trigger:port", githubDraft, {});
    expect(portState.visible).toBe(false);
    expect(portState.disabled).toBe(true);
    expect(portState.disabledReason).toBe('kind "github" does not use this field');
    const appState = resolveFieldState(triggerPage, "trigger:app.app_id", githubDraft, {});
    expect(appState.visible).toBe(true);
    expect(appState.disabled).toBe(false);

    const p4Draft = decodeDraft(triggerPage, makeInput({ record: makeRecord(p4TriggerValue, { name: "p" }) }));
    const p4PortState = resolveFieldState(triggerPage, "trigger:port", p4Draft, {});
    expect(p4PortState.visible).toBe(true);
    expect(p4PortState.disabled).toBe(false);

    // No kind draft value: visible and enabled (kind unknown).
    const kindless: ConfigDraft = { ...githubDraft, fields: { "trigger:port": githubDraft.fields["trigger:port"]! } };
    const kindlessState = resolveFieldState(triggerPage, "trigger:port", kindless, {});
    expect(kindlessState.visible).toBe(true);
    expect(kindlessState.disabled).toBe(false);

    // Pages without a kindField never hide via kinds.
    const providerDraft = decodeDraft(providerPage, makeInput({ record: makeRecord(providerValue) }));
    expect(resolveFieldState(providerPage, "provider:api_version", providerDraft, {}).visible).toBe(true);

    // Entity pages whose kind field is not in the spec: not hidden.
    const oddPage = makePage({
      id: "x",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object", kindField: "kind" },
      fields: [makeField({ id: "trigger:port", path: ["port"], control: "text", valueKind: "string", kinds: ["p4"] })],
    });
    const oddDraft = decodeDraft(oddPage, makeInput({ record: makeRecord({ port: "x" }) }));
    expect(resolveFieldState(oddPage, "trigger:port", oddDraft, {}).visible).toBe(true);

    // Globals pages ignore kinds entirely.
    const globalsKindsPage = makePage({
      id: "g",
      fields: [makeField({ id: "review:x", path: ["review", "x"], control: "text", valueKind: "string", kinds: ["github"] })],
    });
    expect(resolveFieldState(globalsKindsPage, "review:x", globalsDraft({}), {}).visible).toBe(true);
  });

  it("U15: hides irrelevant fields even for file-owned and statically read-only records", () => {
    const draft = decodeDraft(triggerPage, makeInput({
      record: makeRecord(p4TriggerValue, { name: "p", source: "file", readonly: true }),
    }));
    expect(resolveFieldState(triggerPage, "trigger:app.app_id", draft, {})).toMatchObject({ visible: false, disabled: true });
    expect(resolveFieldState(triggerPage, "trigger:port", draft, {})).toMatchObject({ visible: true, disabled: true });
    const page = makePage({
      id: "triggers",
      entity: triggerPage.entity!,
      fields: [
        makeField({ id: "trigger:kind", path: ["kind"], control: "text", valueKind: "string" }),
        makeField({ id: "trigger:app.app_id", path: ["app", "app_id"], control: "number", valueKind: "number", kinds: ["github"], readonlyReason: "read only" }),
      ],
    });
    expect(resolveFieldState(page, "trigger:app.app_id", draft, {})).toMatchObject({ visible: false, disabled: true });
  });

  it("U20: create errors only decorate their matching field", () => {
    const draft = withField(decodeDraft(triggerPage, makeInput({ record: null })), draftField({ id: "trigger:name", value: "github-main" }));
    const errors = [{ message: "bad app", path: ["app", "app_id"], entity: { kind: "trigger", id: "github-main" } }];
    expect(resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, errors).error).toBe("bad app");
    expect(resolveFieldState(triggerPage, "trigger:name", draft, {}, errors).error).toBeUndefined();
    // An incomplete spec must not attach another entity's error without an id.
    const withoutId = { ...triggerPage, sections: triggerPage.sections.map(section => ({ ...section,
      fields: section.fields.filter(field => field.id !== "trigger:name"),
    })) };
    expect(resolveFieldState(withoutId, "trigger:app.app_id", draft, {}, errors).error).toBeUndefined();
  });

  it("U20: maps errors for new map entities using the synthetic name field", () => {
    const draft = withField(decodeDraft(workspacePage, makeInput({ record: null })), draftField({ id: "workspace:$name", value: "new-ws" }));
    const errors = [{ message: "unsafe path", path: ["work_path"], entity: { kind: "workspace", id: "new-ws" } }];
    expect(resolveFieldState(workspacePage, "workspace:work_path", draft, {}, errors).error).toBe("unsafe path");
    expect(resolveFieldState(workspacePage, "workspace:$name", draft, {}, errors).error).toBeUndefined();
  });

  it("U13: evaluates visibleWhen with boolean equality and multiselect contains", () => {
    const reflectionPage = makePage({
      id: "review",
      globals: true,
      fields: [
        makeField({ id: "review:reflection.enabled", path: ["review", "reflection", "enabled"], control: "toggle", valueKind: "boolean" }),
        makeField({
          id: "review:reflection.memory.max_entries",
          path: ["review", "reflection", "memory", "max_entries"],
          control: "number",
          valueKind: "number",
          visibleWhen: { field: "review:reflection.enabled", equals: true },
        }),
        makeField({
          id: "review:unknown-ref",
          path: ["review", "unknown_ref"],
          control: "text",
          valueKind: "string",
          visibleWhen: { field: "review:ghost", equals: true },
        }),
      ],
    });
    const base = globalsDraft({
      "review:reflection.enabled": draftField({ id: "review:reflection.enabled", value: true }),
      "review:reflection.memory.max_entries": draftField({ id: "review:reflection.memory.max_entries", value: 5 }),
      "review:unknown-ref": draftField({ id: "review:unknown-ref", value: "" }),
    });
    expect(resolveFieldState(reflectionPage, "review:reflection.memory.max_entries", base, {}).visible).toBe(true);

    const disabledToggle = withField(base, draftField({ id: "review:reflection.enabled", value: false }));
    const hiddenState = resolveFieldState(reflectionPage, "review:reflection.memory.max_entries", disabledToggle, {});
    expect(hiddenState.visible).toBe(false);
    expect(hiddenState.disabled).toBe(true);

    // Missing referenced value (absent toggle decodes to undefined): hidden.
    const missing = withField(base, draftField({ id: "review:reflection.enabled", mode: "absent", inherit: true, value: undefined }));
    expect(resolveFieldState(reflectionPage, "review:reflection.memory.max_entries", missing, {}).visible).toBe(false);

    // Unknown referenced field id: deterministically hidden.
    expect(resolveFieldState(reflectionPage, "review:unknown-ref", base, {}).visible).toBe(false);

    // Multiselect contains semantics (agent searxng endpoint).
    const agentDraft = globalsDraft({
      "agent:web_search.providers": draftField({ id: "agent:web_search.providers", value: ["searxng"] }),
      "agent:web_search.searxng.endpoint": draftField({ id: "agent:web_search.searxng.endpoint", value: "http://searx" }),
    });
    expect(resolveFieldState(agentPage, "agent:web_search.searxng.endpoint", agentDraft, {}).visible).toBe(true);
    const otherProviders = withField(agentDraft, draftField({ id: "agent:web_search.providers", value: ["tavily"] }));
    expect(resolveFieldState(agentPage, "agent:web_search.searxng.endpoint", otherProviders, {}).visible).toBe(false);
    const noProviders = withField(agentDraft, draftField({ id: "agent:web_search.providers", mode: "absent", inherit: true, value: [] }));
    expect(resolveFieldState(agentPage, "agent:web_search.searxng.endpoint", noProviders, {}).visible).toBe(false);
  });

  it("U11: surfaces matcher shape errors only for malformed values", () => {
    const matcherPage = makePage({
      id: "custom",
      entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object" },
      fields: [makeField({ id: "trigger:filter", path: ["filter"], control: "matcher", valueKind: "union" })],
    });
    const malformed = {
      scope: { kind: "entity", collection: "triggers", recordId: "t" },
      fields: { "trigger:filter": draftField({ id: "trigger:filter", value: "garbage" }) },
      baseRevision: 7,
      fileDigest: "d",
    } satisfies ConfigDraft;
    expect(resolveFieldState(matcherPage, "trigger:filter", malformed, {}).error).toContain("unrecognized matcher shape");

    const valid = withField(malformed, draftField({ id: "trigger:filter", value: { mode: "exact", pattern: "", ignore_case: false } }));
    expect(resolveFieldState(matcherPage, "trigger:filter", valid, {}).error).toBeUndefined();

    const undefinedValue = withField(malformed, draftField({ id: "trigger:filter", value: undefined }));
    expect(resolveFieldState(matcherPage, "trigger:filter", undefinedValue, {}).error).toBeUndefined();

    const noDraftField: ConfigDraft = { ...malformed, fields: {} };
    expect(resolveFieldState(matcherPage, "trigger:filter", noDraftField, {}).error).toBeUndefined();
  });

  it("U20: maps API errors by entity and path suffix with code prefix", () => {
    const record = makeRecord(githubTriggerValue, { id: "github-main", name: "github-main" });
    const draft = decodeDraft(triggerPage, makeInput({ record }));
    const errors: ConfigApiFieldError[] = [
      { code: "invalid_field_type", message: "expected a number", path: ["value", "app", "app_id"], entity: { kind: "trigger", id: "github-main" } },
    ];
    expect(resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, errors).error).toBe("invalid_field_type: expected a number");
    // Suffix match fails when the error path is shorter than the field path.
    expect(
      resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, [{ message: "x", path: ["app_id"], entity: { kind: "trigger", id: "github-main" } }])
        .error,
    ).toBeUndefined();
    // Without a code the bare message is used.
    expect(
      resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, [
        { message: "plain", path: ["app", "app_id"], entity: { kind: "trigger", id: "github-main" } },
      ]).error,
    ).toBe("plain");
    // Non-matching entity kind or record id do not map.
    expect(
      resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, [
        { message: "x", path: ["app", "app_id"], entity: { kind: "provider", id: "github-main" } },
      ]).error,
    ).toBeUndefined();
    expect(
      resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, [
        { message: "x", path: ["app", "app_id"], entity: { kind: "trigger", id: "other" } },
      ]).error,
    ).toBeUndefined();
    // Record-level errors (no path) are not field-mapped.
    expect(
      resolveFieldState(triggerPage, "trigger:name", draft, {}, [{ message: "x", entity: { kind: "trigger", id: "github-main" } }]).error,
    ).toBeUndefined();
    // Create-mode drafts (recordId null) match entity errors through the id
    // field's draft value; a mismatched or absent id never maps.
    const createDraft = decodeDraft(triggerPage, makeInput({ record: null }));
    const namedCreate = withField(createDraft, draftField({ id: "trigger:name", value: "github-main" }));
    expect(
      resolveFieldState(triggerPage, "trigger:name", namedCreate, {}, [
        { message: "x", path: ["name"], entity: { kind: "trigger", id: "github-main" } },
      ]).error,
    ).toBe("x");
    expect(
      resolveFieldState(triggerPage, "trigger:name", namedCreate, {}, [
        { message: "x", path: ["name"], entity: { kind: "trigger", id: "other" } },
      ]).error,
    ).toBeUndefined();
    expect(
      resolveFieldState(triggerPage, "trigger:name", createDraft, {}, [
        { message: "x", path: ["name"], entity: { kind: "trigger", id: "github-main" } },
      ]).error,
    ).toBeUndefined();
    // Globals drafts on entity pages never match entity errors.
    const asGlobals: ConfigDraft = { scope: { kind: "globals", prefix: [] }, fields: {}, baseRevision: 7, fileDigest: "d" };
    expect(
      resolveFieldState(triggerPage, "trigger:name", asGlobals, {}, [
        { message: "x", path: ["name"], entity: { kind: "trigger", id: "github-main" } },
      ]).error,
    ).toBeUndefined();
    // Globals pages map errors by path alone; entity-tagged errors never match.
    const reviewDraft = decodeDraft(reviewPage, makeInput({ fields: [] }));
    expect(
      resolveFieldState(reviewPage, "review:max_files", reviewDraft, {}, [{ code: "path_not_overridden", message: "no override", path: ["review", "max_files"] }])
        .error,
    ).toBe("path_not_overridden: no override");
    expect(
      resolveFieldState(reviewPage, "review:max_files", reviewDraft, {}, [
        { message: "x", path: ["review", "max_files"], entity: { kind: "trigger", id: "t" } },
      ]).error,
    ).toBeUndefined();
  });

  it("U20b: maps leaf-level error paths to the parent field that edits them", () => {
    const record = makeRecord(githubTriggerValue, { id: "github-main", name: "github-main" });
    const draft = decodeDraft(triggerPage, makeInput({ record }));
    // Validators report the failing leaf below the field's object path.
    expect(
      resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, [
        { message: "leaf", path: ["app", "app_id", "exact"], entity: { kind: "trigger", id: "github-main" } },
      ]).error,
    ).toBe("leaf");
    // ...but an error path shorter than the field path still never matches.
    expect(
      resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, [
        { message: "short", path: ["app"], entity: { kind: "trigger", id: "github-main" } },
      ]).error,
    ).toBeUndefined();
    // Non-empty field paths never match an empty (record-level) error path.
    expect(
      resolveFieldState(triggerPage, "trigger:app.app_id", draft, {}, [
        { message: "root", path: [], entity: { kind: "trigger", id: "github-main" } },
      ]).error,
    ).toBeUndefined();
  });

  it("U20: maps empty-path errors only to empty-path fields", () => {
    const record = makeRecord(modelGroupValue, { id: "default", name: "default" });
    const draft = decodeDraft(modelGroupPage, makeInput({ record }));
    const errors: ConfigApiFieldError[] = [{ message: "group invalid", path: [], entity: { kind: "model_group", id: "default" } }];
    expect(resolveFieldState(modelGroupPage, "model_group:entries", draft, {}, errors).error).toBe("group invalid");
    const nonEmpty: ConfigApiFieldError[] = [{ message: "entry invalid", path: ["0"], entity: { kind: "model_group", id: "default" } }];
    expect(resolveFieldState(modelGroupPage, "model_group:entries", draft, {}, nonEmpty).error).toBeUndefined();
  });

  it("propagates options errors into the field state", () => {
    const draft = decodeDraft(workspacePage, makeInput({ record: makeRecord(workspaceValue, { name: "ws-1" }) }));
    const state = resolveFieldState(workspacePage, "workspace:model_chain", draft, {});
    expect(state.options).toEqual([]);
    expect(state.optionsError).toBe('options source "model_groups" not loaded');
  });

  it("resolves state for itemField ids", () => {
    const draft = decodeDraft(workspacePage, makeInput({ record: makeRecord(workspaceValue, { name: "ws-1" }) }));
    const state = resolveFieldState(workspacePage, "workspace:match[].source", draft, {});
    expect(state.visible).toBe(true);
    expect(state.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U19 — resolveOptions
// ---------------------------------------------------------------------------

describe("resolveOptions", () => {
  const workspaceDraft = decodeDraft(workspacePage, makeInput({ record: makeRecord(workspaceValue, { name: "ws-1" }) }));

  it("returns static options as-is and empty options for plain fields", () => {
    const staticResult = resolveOptions(providerPage, "provider:kind", decodeDraft(providerPage, makeInput({ record: null })), {});
    expect(staticResult.options).toBe(providerPage.sections[0]?.fields[1]?.options);
    expect(staticResult.error).toBeUndefined();
    expect(resolveOptions(providerPage, "provider:model", decodeDraft(providerPage, makeInput({ record: null })), {})).toEqual({ options: [] });
    expect(resolveOptions(providerPage, "provider:ghost", decodeDraft(providerPage, makeInput({ record: null })), {})).toEqual({ options: [] });
  });

  it("reports missing sources and propagates source errors", () => {
    expect(resolveOptions(workspacePage, "workspace:model_chain", workspaceDraft, {})).toEqual({
      options: [],
      error: 'options source "model_groups" not loaded',
    });
    const failed: Readonly<Record<string, ConfigReferenceData>> = {
      model_groups: { source: "model_groups", options: [{ value: "stale" }], error: "failed to load model groups" },
    };
    expect(resolveOptions(workspacePage, "workspace:model_chain", workspaceDraft, failed)).toEqual({
      options: [{ value: "stale" }],
      error: "failed to load model groups",
    });
    // Prototype-named sources cannot smuggle Object.prototype through.
    const protoPage = makePage({
      id: "p",
      fields: [makeField({ id: "f:x", path: ["x"], control: "select", valueKind: "string", optionsSource: "__proto__" })],
    });
    expect(resolveOptions(protoPage, "f:x", globalsDraft({}), {})).toEqual({
      options: [],
      error: 'options source "__proto__" not loaded',
    });
  });

  it("keeps vanished select values as disabled options instead of auto-selecting", () => {
    const references: Readonly<Record<string, ConfigReferenceData>> = {
      model_groups: { source: "model_groups", options: [{ value: "default" }, { value: "fast" }] },
    };
    const result = resolveOptions(workspacePage, "workspace:model_chain", workspaceDraft, references);
    expect(result.options).toEqual([{ value: "default" }, { value: "fast" }]);
    expect(result.error).toBeUndefined();

    const vanishedDraft = withField(workspaceDraft, draftField({ id: "workspace:model_chain", value: "gone" }));
    const vanished = resolveOptions(workspacePage, "workspace:model_chain", vanishedDraft, references);
    expect(vanished.options).toEqual([{ value: "default" }, { value: "fast" }, { value: "gone", label: "gone (missing)", disabled: true }]);
    expect(vanished.error).toBe('referenced option no longer available: "gone"');
  });

  it("keeps vanished multiselect values, reporting all of them", () => {
    const routeDraft = decodeDraft(routePage, makeInput({ record: makeRecord(routeValue) }));
    const references: Readonly<Record<string, ConfigReferenceData>> = {
      channels: { source: "channels", options: [{ value: "gl-mr" }] },
    };
    const kept = resolveOptions(routePage, "route:outputs.summary", routeDraft, references);
    expect(kept.options).toEqual([{ value: "gl-mr" }]);
    expect(kept.error).toBeUndefined();

    const twoMissing = withField(routeDraft, draftField({ id: "route:outputs.summary", value: ["gl-mr", "gone-1", "gone-2"] }));
    const result = resolveOptions(routePage, "route:outputs.summary", twoMissing, references);
    expect(result.options).toEqual([
      { value: "gl-mr" },
      { value: "gone-1", label: "gone-1 (missing)", disabled: true },
      { value: "gone-2", label: "gone-2 (missing)", disabled: true },
    ]);
    expect(result.error).toBe('referenced options no longer available: "gone-1", "gone-2"');

    // Non-string and empty values never produce phantom missing options.
    const oddValues = withField(routeDraft, draftField({ id: "route:outputs.summary", value: ["", 5, "gl-mr"] }));
    expect(resolveOptions(routePage, "route:outputs.summary", oddValues, references).error).toBeUndefined();
  });
});

// U19 — resolveItemOptions (ordered-list row item fields, e.g. model group entries)
describe("resolveItemOptions", () => {
  const providerItem = makeField({ id: "mg:entries[].provider", path: ["entries", "*", "provider"], control: "select", valueKind: "string", optionsSource: "providers" });

  it("returns static options without consulting references", () => {
    const staticItem = makeField({ id: "mg:entries[].role", path: ["entries", "*", "role"], control: "select", valueKind: "string", options: [{ value: "light" }] });
    expect(resolveItemOptions(staticItem, "light", {})).toEqual({ options: [{ value: "light" }] });
    const plain = makeField({ id: "mg:entries[].model", path: ["entries", "*", "model"], control: "text", valueKind: "string" });
    expect(resolveItemOptions(plain, "x", {})).toEqual({ options: [] });
  });

  it("resolves dynamic sources against the row value", () => {
    const references: Readonly<Record<string, ConfigReferenceData>> = {
      providers: { source: "providers", options: [{ value: "file-llm" }] },
    };
    expect(resolveItemOptions(providerItem, "file-llm", references)).toEqual({ options: [{ value: "file-llm" }] });
    // A row value that vanished from the source stays visible, disabled.
    const vanished = resolveItemOptions(providerItem, "gone", references);
    expect(vanished.options).toEqual([{ value: "file-llm" }, { value: "gone", label: "gone (missing)", disabled: true }]);
    expect(vanished.error).toBe('referenced option no longer available: "gone"');
    // Unset rows produce no phantom missing option.
    expect(resolveItemOptions(providerItem, undefined, references).error).toBeUndefined();
  });

  it("reports missing sources and propagates source errors", () => {
    expect(resolveItemOptions(providerItem, "file-llm", {})).toEqual({
      options: [],
      error: 'options source "providers" not loaded',
    });
    const failed: Readonly<Record<string, ConfigReferenceData>> = {
      providers: { source: "providers", options: [{ value: "stale" }], error: "failed to load providers" },
    };
    expect(resolveItemOptions(providerItem, "file-llm", failed)).toEqual({
      options: [{ value: "stale" }],
      error: "failed to load providers",
    });
  });
});

// ---------------------------------------------------------------------------
// U06 — parseNumberInput
// ---------------------------------------------------------------------------

describe("parseNumberInput", () => {
  it("treats empty input as absent, never zero", () => {
    expect(parseNumberInput("")).toEqual({ ok: false, reason: "empty" });
    expect(parseNumberInput("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects NaN and non-finite input", () => {
    expect(parseNumberInput("abc")).toEqual({ ok: false, reason: "nan" });
    expect(parseNumberInput("1.2.3")).toEqual({ ok: false, reason: "nan" });
    expect(parseNumberInput("Infinity")).toEqual({ ok: false, reason: "non-finite" });
    expect(parseNumberInput("-Infinity")).toEqual({ ok: false, reason: "non-finite" });
    expect(parseNumberInput("1e999")).toEqual({ ok: false, reason: "non-finite" });
  });

  it("parses zero, negatives and decimals exactly", () => {
    expect(parseNumberInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseNumberInput("-3.5")).toEqual({ ok: true, value: -3.5 });
    expect(parseNumberInput(" 42 ")).toEqual({ ok: true, value: 42 });
    expect(parseNumberInput("1e3")).toEqual({ ok: true, value: 1000 });
  });
});

// ---------------------------------------------------------------------------
// U09 — encodeMapKey / decodeMapKey
// ---------------------------------------------------------------------------

describe("map key escaping", () => {
  it("passes safe characters through and escapes everything else", () => {
    expect(encodeMapKey("abc-D_09")).toBe("abc-D_09");
    expect(encodeMapKey("a/b")).toBe("a~002Fb");
    expect(encodeMapKey("x.y")).toBe("x~002Ey");
    expect(encodeMapKey("a~b")).toBe("a~007Eb");
    expect(encodeMapKey("a b")).toBe("a~0020b");
    expect(encodeMapKey("é")).toBe("~00E9");
    expect(encodeMapKey("😀")).toBe("~D83D~DE00");
  });

  it("round-trips arbitrary keys", () => {
    for (const key of ["plain", "with/slash", "with.dot", "with~tilde", "with space", "é😀", "~7E", "-leading", "_leading"]) {
      expect(decodeMapKey(encodeMapKey(key))).toBe(key);
    }
    expect(decodeMapKey("plain-token")).toBe("plain-token");
  });

  it("rejects prototype keys on encode", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      expect(() => encodeMapKey(key)).throw(TypeError, /prototype key/);
    }
  });

  it("rejects malformed escape sequences on decode", () => {
    for (const token of ["~", "~12", "a~2", "~zzzz", "a~2e9b"]) {
      expect(() => decodeMapKey(token)).throw(TypeError, /malformed escape/);
    }
  });
});

// ---------------------------------------------------------------------------
// isPlainRecord
// ---------------------------------------------------------------------------

describe("isPlainRecord", () => {
  it("accepts plain and null-prototype objects only", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord("x")).toBe(false);
    expect(isPlainRecord(5)).toBe(false);
    expect(isPlainRecord(new Date())).toBe(false);
    class Custom {}
    expect(isPlainRecord(new Custom())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pageGlobalsFieldPaths / fieldViewEntryInScope
// ---------------------------------------------------------------------------

describe("pageGlobalsFieldPaths", () => {
  it("returns non-empty path keys of all fields when the page has no entity", () => {
    const page = makePage({
      id: "review",
      fields: [
        makeField({ id: "review:enabled", path: ["review", "enabled"], control: "toggle", valueKind: "boolean" }),
        makeField({ id: "review:schedule", path: ["review", "pull_request", "schedule"], control: "text", valueKind: "string" }),
      ],
    });
    expect(pageGlobalsFieldPaths(page)).toEqual([
      ["review", "enabled"],
      ["review", "pull_request", "schedule"],
    ]);
  });

  it("excludes entity-prefixed fields and drops empty paths", () => {
    const page = makePage({
      id: "providers",
      entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object" },
      fields: [
        makeField({ id: "provider:model", path: ["model"], control: "text", valueKind: "string" }),
        makeField({ id: "shared:timeout", path: ["llm", "timeout_seconds"], control: "text", valueKind: "string" }),
        makeField({ id: "provider:$document", path: [], control: "text", valueKind: "string" }),
      ],
    });
    expect(pageGlobalsFieldPaths(page)).toEqual([["llm", "timeout_seconds"]]);
  });
});

describe("fieldViewEntryInScope", () => {
  const keys = [["review", "pull_request"], ["outputs", "channels", "feishu:oc_1"]];

  it("matches exact and descendant formatted paths", () => {
    expect(fieldViewEntryInScope("review.pull_request", keys)).toBe(true);
    expect(fieldViewEntryInScope("review.pull_request.schedule.rules", keys)).toBe(true);
    expect(fieldViewEntryInScope('outputs.channels["feishu:oc_1"].member_directory', keys)).toBe(true);
  });

  it("rejects shorter, mismatching, empty-key and empty-keys paths", () => {
    expect(fieldViewEntryInScope("review", keys)).toBe(false);
    expect(fieldViewEntryInScope("review.other", keys)).toBe(false);
    expect(fieldViewEntryInScope("outputs.channels", keys)).toBe(false);
    expect(fieldViewEntryInScope("review.pull_request", [[]])).toBe(false);
    expect(fieldViewEntryInScope("review.pull_request", [])).toBe(false);
  });

  it("rejects malformed formatted paths", () => {
    expect(fieldViewEntryInScope("[unclosed", keys)).toBe(false);
    expect(fieldViewEntryInScope('["bad\\escape]', keys)).toBe(false);
  });
});

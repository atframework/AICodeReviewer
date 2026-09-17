import { describe, expect, it } from "vitest";
import { buildConfigUiSpec } from "../src/config-ui-spec.js";
import { createEditorSession, rebaseSession, sessionEncode, sessionListOp, sessionMapOp, sessionSetPresent, sessionSetValue, sessionSwitchKind } from "../src/config-form-state.js";
import { applyConfigChangeset } from "../src/config-source.js";
import { decodeDraft, encodeChanges, readRowField, resolveItemOptions, type ConfigDecodeInput } from "../src/config-ui-runtime.js";

const spec = buildConfigUiSpec();
const page = (id: string) => spec.pages.find(p => p.id === id)!;
function input(value: unknown, name = "sample"): ConfigDecodeInput {
  return { record: { id: name, name, source: "database", readonly: false, value, effectiveValue: value }, baseRevision: 1, fileDigest: "a".repeat(64) };
}

describe("P6 real registry and editor contracts", () => {
  it.each([
    [{ value: "replacement" }, { value: "replacement" }],
    [{ value: "" }, undefined],
    ["SEARCH_KEY", "SEARCH_KEY"],
    ["", undefined],
  ])("edits a search credential row using %j", (value, expected) => {
    const raw = { agent: { web_search: { credentials: { exa: { value: "<redacted>" } } } } };
    const base = input(raw);
    const fieldId = "workspace:agent.web_search.credentials.*";
    let session = createEditorSession(page("workspaces"), base);
    session = sessionMapOp(session, fieldId, { type: "setValue", rowId: "r1", value });
    const next = applyConfigChangeset({ entities: { workspaces: { sample: {
      id: "sample", name: "sample", enabled: true,
      value: { agent: { web_search: { credentials: { exa: { value: "old-secret" } } } } },
    } } } }, sessionEncode(session, base).operations, { formatVersion: 2 });
    expect(next.entities?.workspaces?.sample?.value).toEqual({ agent: { web_search: { credentials: expected === undefined ? {} : { exa: expected } } } });
  });

  it("drops obsolete sealed credentials on a provider kind change", () => {
    const base = input({ id: "sample", kind: "bedrock", aws_secret_key: "<redacted>" });
    const session = sessionSwitchKind(createEditorSession(page("providers"), base), "ollama");
    expect(sessionEncode(session, base).operations).toEqual([{ op: "update", collection: "providers", recordId: "sample",
      value: { id: "sample", kind: "ollama", aws_secret_key: null } }]);
  });

  it("preserves masked search credentials and removes a deleted credential map row", () => {
    const masked = { agent: { web_search: { credentials: { exa: { value: "<redacted>" }, tavily: { value: "<redacted>" } } } } };
    const base = input(masked);
    const field = page("workspaces").sections.flatMap(s => s.fields).find(f => f.id === "workspace:agent.web_search.credentials.*")!;
    expect(field.mapValueKind).toBe("credential");
    let session = createEditorSession(page("workspaces"), base);
    const rows = session.draft.fields[field.id]!.value as { _rowId: string; key: string }[];
    session = sessionMapOp(session, field.id, { type: "remove", rowId: rows.find(row => row.key === "tavily")!._rowId });
    const stored = { agent: { web_search: { credentials: { exa: { value: "exa-secret" }, tavily: { value: "tavily-secret" } } } } };
    const next = applyConfigChangeset({ entities: { workspaces: { sample: {
      id: "sample", name: "sample", enabled: true, value: stored,
    } } } }, sessionEncode(session, base).operations, { formatVersion: 2 });
    expect(next.entities?.workspaces?.sample?.value).toEqual({ agent: { web_search: { credentials: { exa: { value: "exa-secret" } } } } });
  });

  it("keeps nested workspace secrets when another field changes", () => {
    const value = { auth: { api_key: "<redacted>" } };
    const base = input(value);
    const session = sessionSetValue(createEditorSession(page("workspaces"), base), "workspace:review.max_files", 12);
    const operations = sessionEncode(session, base).operations;
    const next = applyConfigChangeset({ entities: { workspaces: { sample: {
      id: "sample", name: "sample", enabled: true, value: { auth: { api_key: "stored-secret" } },
    } } } }, operations, { formatVersion: 2 });
    expect(next.entities?.workspaces?.sample?.value).toEqual({ auth: { api_key: "stored-secret" }, review: { max_files: 12 } });
  });

  it("clears a stored literal when its optional field is removed", () => {
    const base = input({ id: "sample", kind: "openai_compatible", api_key: "<redacted>" });
    const session = sessionSetPresent(createEditorSession(page("providers"), base), "provider:api_key", false);
    expect(sessionEncode(session, base).operations).toEqual([{ op: "update", collection: "providers", recordId: "sample",
      value: { id: "sample", kind: "openai_compatible", api_key: null } }]);
  });
  it("uses variable options as template completion instead of validating the whole expression as an enum", () => {
    const field = page("workspaces").sections.flatMap(s => s.fields).find(f => f.control === "path-template")!;
    const options = [{ value: "git.repository", insertText: "{{segment git.repository}}" }];
    expect(resolveItemOptions(field, "repos/{{segment git.repository}}", { path_template_variables: { options } })).toEqual({ options });
  });
  it("preserves workspace match arrays, explicit empty overrides and nested extensions", () => {
    const value = { match: [{ id: "main", triggers: ["manual"], source: { "git.repository": { exact: "org/repo" } } }], review: { max_files: 9, future_flag: false }, outputs: { summary: [] } };
    const base = input(value);
    const session = sessionSetValue(createEditorSession(page("workspaces"), base), "workspace:review.max_files", 12);
    expect(sessionEncode(session, base).operations).toEqual([{ op: "update", collection: "workspaces", recordId: "sample", value: { ...value, review: { max_files: 12, future_flag: false } } }]);
  });

  it("declares nested weekly schedules as atomic lists with row-relative paths", () => {
    const rules = page("review").sections.flatMap(s => s.fields).find(f => f.id === "review:auto_commit.schedule.rules")!;
    expect(rules?.control).toBe("ordered-list");
    expect(rules.path).toEqual(["review", "auto_commit", "schedule", "rules"]);
    const windows = rules.itemFields!.find(f => f.id.endsWith("windows"))!;
    expect(windows.control).toBe("ordered-list");
    expect(windows.path).toEqual(["windows"]);
    expect(windows.itemFields!.map(f => f.path)).toEqual([["start"], ["end"]]);
  });

  it("updates a real model entry field by its spec id without leaking UI keys", () => {
    const base = input([{ provider: "p", model: "old", role: "any", overrides: { seed: 2, extension: false } }]);
    let session = createEditorSession(page("model-groups"), base);
    session = sessionListOp(session, "model_group:entries", { type: "set", rowId: "r1", itemFieldId: "model_group:entries[].model", value: "new" });
    session = sessionListOp(session, "model_group:entries", { type: "set", rowId: "r1", itemFieldId: "model_group:entries[].overrides.seed", value: 3 });
    expect(sessionEncode(session, base).operations).toEqual([{ op: "update", collection: "model_groups", recordId: "sample", value: [{ provider: "p", model: "new", role: "any", overrides: { seed: 3, extension: false } }] }]);
  });

  it("adopts a concurrently changed kind when only a common field was edited", () => {
    const base = input({ id: "sample", kind: "anthropic", timeout_ms: 1000, anthropic_version: "v1" });
    const edited = sessionSetValue(createEditorSession(page("providers"), base), "provider:timeout_ms", 2000);
    const fresh = { ...input({ id: "sample", kind: "azure_openai", timeout_ms: 1000, api_version: "v2" }), baseRevision: 2 };
    const rebased = rebaseSession(edited, fresh);
    expect(rebased.kind).toBe("azure_openai");
    expect(sessionEncode(rebased, fresh).operations).toEqual([{ op: "update", collection: "providers", recordId: "sample", value: { id: "sample", kind: "azure_openai", timeout_ms: 2000, api_version: "v2" } }]);
  });

  it("does not silently recreate an upstream-deleted record during rebase", () => {
    const base = input({ id: "sample", kind: "openai_compatible" });
    const edited = sessionSetValue(createEditorSession(page("providers"), base), "provider:timeout_ms", 2000);
    expect(() => rebaseSession(edited, { record: null, baseRevision: 2, fileDigest: base.fileDigest })).toThrow(/no longer exists/);
  });

  it("does not drop kind-specific values on an unchanged kind", () => {
    const base = input({ id: "sample", kind: "openai_compatible", anthropic_version: "legacy-extension" });
    const session = sessionSetValue(createEditorSession(page("providers"), base), "provider:timeout_ms", 2000);
    expect(sessionEncode(session, base).operations[0]).toMatchObject({ value: { anthropic_version: "legacy-extension" } });
  });

  it("keeps explicit empty nested objects during a no-op roundtrip", () => {
    const base = input({ agent: {}, review: {}, outputs: { summary: [] } });
    expect(encodeChanges(page("workspaces"), decodeDraft(page("workspaces"), base), base)[0]).toMatchObject({ value: base.record!.value });
  });

  it.each([
    ["providers", "provider:id", { id: "sample", kind: "ollama" }, "providers"],
    ["model-groups", "model_group:$name", [{ provider: "p", model: "m", role: "any" }], "model_groups"],
  ] as const)("encodes a %s rename with its value update in the same changeset", (pageId, field, value, collection) => {
    const base = input(value);
    const edited = sessionSetValue(createEditorSession(page(pageId), base), field, "renamed");
    const operations = sessionEncode(edited, base).operations;
    expect(operations[0]).toEqual({ op: "rename", collection, recordId: "sample", newName: "renamed" });
    expect(operations).toHaveLength(2);
    expect(operations[1]).toMatchObject({ op: "update", recordId: "sample" });
  });

  it("preserves catalog maps and exposes row-relative values to the renderer", () => {
    const p = page("model-groups");
    const base: ConfigDecodeInput = { baseRevision: 1, fileDigest: "a".repeat(64), fields: [
      { path: 'llm.model_catalog.overrides["p/model.with.dot"].context_window', source: "database", effectiveValue: 2048, overriddenValues: [] },
    ] };
    const session = createEditorSession(p, base);
    const field = p.sections.flatMap(s => s.fields).find(f => f.id === "llm:model_catalog.overrides")!;
    const entries = session.draft.fields[field.id]!.value as { value: Record<string, unknown> }[];
    const child = field.itemFields!.find(f => f.path[0] === "context_window")!;
    expect(readRowField(entries[0]!.value, child)).toBe(2048);
    expect(sessionEncode(session, base).operations).toEqual([]);
    const rebased = rebaseSession(session, { ...base, baseRevision: 2 });
    expect(rebased.kind).toBeUndefined();
    expect(rebased.dirty).toBe(false);
  });

  it("does not serialize empty secret references nested inside source rows", () => {
    const p = page("workspaces");
    const base = input({ context_repositories: [{ alias: "shared", kind: "git", url: "https://example.test/repo", token_env: "" }] });
    const operation = sessionEncode(createEditorSession(p, base), base).operations[0];
    expect(JSON.parse(JSON.stringify(operation))).toMatchObject({ value: { context_repositories: [{ alias: "shared", kind: "git", url: "https://example.test/repo" }] } });
    expect(JSON.stringify(operation)).not.toContain("token_env");
  });

  it("retains edited connection fields shared by both trigger kinds", () => {
    const base = input({ name: "sample", kind: "gitea", base_url: "https://old.test", token_env: "OLD_TOKEN" });
    const edited = sessionSetValue(createEditorSession(page("triggers"), base), "trigger:base_url", "https://new.test");
    const switched = sessionSwitchKind(edited, "github");
    expect(sessionEncode(switched, base).operations[0]).toMatchObject({ value: { kind: "github", base_url: "https://new.test", token_env: "OLD_TOKEN" } });
  });
});

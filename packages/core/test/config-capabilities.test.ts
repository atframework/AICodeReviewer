import { describe, expect, it } from "vitest";

import {
  CHANNEL_KINDS,
  MODEL_CATALOG_FIELD_ROWS,
  CHANNEL_KIND_FIELDS,
  ConfigError,
  MODEL_CATALOG_HINT_FIELDS,
  PROVIDER_KIND_FIELDS,
  PROVIDER_PASSTHROUGH_FIELDS,
  TRIGGER_KIND_FIELDS,
  applyConfigChangeset,
  validateDatabaseDocument,
  validateEntityCapabilities,
  type DatabaseEntityRecord,
} from "../src/index.js";

function record(name: string, value: Record<string, unknown>): DatabaseEntityRecord {
  return { id: `rec-${name}`, name, enabled: true, value };
}

function expectConfigError(fn: () => unknown, code: string): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    return error as ConfigError;
  }
  throw new Error(`expected ConfigError ${code}`);
}

describe("provider passthrough typed DTO", () => {
  it("accepts valid request and connection fields", () => {
    validateEntityCapabilities("provider", {
      id: "main",
      kind: "openai_compatible",
      organization: "org",
      timeout_ms: 30000,
      max_retries: 2,
      seed: 42,
      logit_bias: { "123": -1 },
      drop_params: ["temperature"],
      extra_headers: { "X-Mode": "test" },
      context_window: 128000,
      supports_tool_call: true,
      model_links: { docs: "https://example.com" },
      default_reasoning_effort: "high",
    });
  });

  it.each([
    ["timeout_ms", "30"],
    ["seed", 1.5],
    ["logit_bias", { a: "high" }],
    ["reasoning_effort", "extreme"],
    ["cache_control", "persist"],
    ["supports_vision", "yes"],
    ["context_window", "128000"],
    ["default_reasoning_effort", "extreme"],
  ])("rejects invalid typed field %s", (field, value) => {
    const provider: Record<string, unknown> = { id: "main", kind: "anthropic", [field]: value };
    const error = expectConfigError(() => validateEntityCapabilities("provider", provider), "invalid_field_type");
    expect(error.path).toEqual([field]);
  });

  it("preserves unknown extension keys without rejection", () => {
    validateEntityCapabilities("provider", { id: "main", kind: "ollama", future_plugin: { nested: true } });
  });
});

describe("provider kind capability", () => {
  it.each([
    ["vertex_ai", { vertex_project: "p", vertex_location: "us-central1", google_application_credentials_env: "GOOGLE_APPLICATION_CREDENTIALS" }],
    ["bedrock", { aws_region: "us-east-1", aws_access_key_env: "AWS_ACCESS_KEY_ID", aws_profile: "default" }],
    ["anthropic", { anthropic_version: "2023-06-01", anthropic_beta: ["prompt-caching"], cache_control: "ephemeral" }],
  ])("accepts %s fields on its own kind", (kind, fields) => {
    validateEntityCapabilities("provider", { id: "main", kind, ...fields });
  });

  it.each([
    ["ollama", "vertex_project"],
    ["openai_compatible", "aws_region"],
    ["azure_openai", "anthropic_beta"],
    ["vertex_ai", "aws_profile"],
  ])("rejects %s carrying %s of another kind", (kind, field) => {
    const error = expectConfigError(
      () => validateEntityCapabilities("provider", { id: "main", kind, [field]: "x" }),
      "unsupported_capability",
    );
    expect(error.path).toEqual([field]);
  });
});

describe("trigger kind capability", () => {
  it("accepts git webhook fields on git kinds and p4/svn fields on their kinds", () => {
    validateEntityCapabilities("trigger", { name: "g", kind: "gitea", token_env: "GITEA_TOKEN", webhook_secret_env: "GITEA_SECRET", base_url: "https://gitea.example.com", repos: [{ match: "owner/repo", workspace: "main" }] });
    validateEntityCapabilities("trigger", { name: "p", kind: "p4", port: "ssl:p4d:1666", user_env: "P4USER", streams: ["//depot/main"], watch_path: ["//depot/..."], exclude_cr_file: ["*.tmp"] });
    validateEntityCapabilities("trigger", { name: "s", kind: "svn", repository_url: "svn://host/repo", trust_server_cert: true, watch_path: ["trunk"] });
  });

  it.each(["gitea", "forgejo", "github", "gitlab"])("rejects file filters on git trigger kind %s (schema-only there)", (kind) => {
    const error = expectConfigError(
      () => validateEntityCapabilities("trigger", { name: "t", kind, watch_path: ["src/**"] }),
      "unsupported_capability",
    );
    expect(error.path).toEqual(["watch_path"]);
  });

  it("rejects github app auth on non-github triggers", () => {
    expectConfigError(
      () => validateEntityCapabilities("trigger", { name: "t", kind: "gitea", app: { app_id: 1 } }),
      "unsupported_capability",
    );
  });

  it("rejects p4 fields on a git trigger and svn fields on p4", () => {
    expectConfigError(
      () => validateEntityCapabilities("trigger", { name: "t", kind: "github", depot_path: "//depot" }),
      "unsupported_capability",
    );
    expectConfigError(
      () => validateEntityCapabilities("trigger", { name: "t", kind: "p4", repository_url: "svn://x" }),
      "unsupported_capability",
    );
  });

  it.each([
    ["p4", "streams", "not-an-array"],
    ["p4", "watch_path", "//depot/..."],
    ["svn", "trust_server_cert", "true"],
    ["gitea", "repos", [{ match: 1, workspace: "w" }]],
  ])("rejects mistyped field %s.%s", (kind, field, value) => {
    expectConfigError(
      () => validateEntityCapabilities("trigger", { name: "t", kind, [field]: value }),
      "invalid_field_type",
    );
  });

  it("rejects unmanaged connection fields on scheduled/manual triggers", () => {
    expectConfigError(
      () => validateEntityCapabilities("trigger", { name: "t", kind: "manual", token_env: "X" }),
      "unsupported_capability",
    );
  });
});

describe("channel kind capability", () => {
  it("rejects a channel kind with no publisher", () => {
    const error = expectConfigError(
      () => validateEntityCapabilities("channel", { name: "c", kind: "slack_bot" }),
      "unsupported_capability",
    );
    expect(error.path).toEqual(["kind"]);
  });

  it("accepts the full field set of each publishable kind", () => {
    validateEntityCapabilities("channel", { name: "c", kind: "gitea_pr_review", review_mode: "auto", review_event: "COMMENT", review_update_strategy: "update_existing", severity_label_prefix: "sev", severity_label_colors: { high: "red" } });
    validateEntityCapabilities("channel", { name: "c", kind: "github_problem_issue", labels: ["bug"], issue_mode: "per_problem", resolved_action: "mark_resolved", assign_committer: true, owners_file: "OWNERS", notify_feishu: { webhook_url_env: "FEISHU_URL" } });
    validateEntityCapabilities("channel", { name: "c", kind: "gitea_problem_issue", label_ids: [1, 2], resolved_action: "delete" });
    validateEntityCapabilities("channel", { name: "c", kind: "gitlab_mr_review", project_id: 42, merge_request_iid: 7, severity_label_prefix: "sev" });
    validateEntityCapabilities("channel", { name: "c", kind: "wecom_bot", webhook_url_env: "WECOM_URL", mentioned_mobile_list: ["13800000000"] });
  });

  it.each([
    ["github_issue", "review_mode", "auto"],
    ["gitea_issue", "severity_label_prefix", "sev"],
    ["gitlab_mr_review", "review_event", "COMMENT"],
    ["github_problem_issue", "label_ids", [1]],
    ["gitea_problem_issue", "labels", ["bug"]],
    ["wecom_bot", "secret_env", "WESECRET"],
    ["feishu_bot", "issue_mode", "per_problem"],
  ])("rejects %s with %s (no consumer)", (kind, field, value) => {
    const error = expectConfigError(
      () => validateEntityCapabilities("channel", { name: "c", kind, [field]: value }),
      "unsupported_capability",
    );
    expect(error.path).toEqual([field]);
  });

  it("rejects resolved_action delete on github_problem_issue (not honored)", () => {
    expectConfigError(
      () => validateEntityCapabilities("channel", { name: "c", kind: "github_problem_issue", resolved_action: "delete" }),
      "unsupported_capability",
    );
  });

  it.each([
    ["gitlab_mr_review", "merge_request_iid", "7"],
    ["gitlab_mr_review", "project_id", -3],
    ["wecom_bot", "mentioned_mobile_list", "138"],
    ["feishu_bot", "webhook_url_env", ""],
  ])("rejects mistyped field %s.%s", (kind, field, value) => {
    expectConfigError(
      () => validateEntityCapabilities("channel", { name: "c", kind, [field]: value }),
      "invalid_field_type",
    );
  });
});

describe("changeset integration", () => {
  it("rejects a database document whose record violates capability rules", () => {
    expectConfigError(
      () =>
        validateDatabaseDocument({
          entities: { channels: { "rec-c": record("c", { name: "c", kind: "github_issue", review_mode: "auto" }) } },
        }),
      "unsupported_capability",
    );
  });

  it("rejects a changeset create with a mistyped passthrough field atomically", () => {
    const base = validateDatabaseDocument({});
    expectConfigError(
      () =>
        applyConfigChangeset(base, [
          { op: "create", collection: "providers", record: record("main", { id: "main", kind: "ollama", seed: "42" }) },
        ]),
      "invalid_field_type",
    );
    expect(base.entities).toBeUndefined();
  });

  it("applies a valid changeset and keeps unknown extension keys", () => {
    const base = validateDatabaseDocument({});
    const next = applyConfigChangeset(base, [
      {
        op: "create",
        collection: "providers",
        record: record("main", { id: "main", kind: "bedrock", aws_region: "us-east-1", future_key: { keep: 1 } }),
      },
    ]);
    expect(next.entities?.providers?.["rec-main"]?.value).toMatchObject({ aws_region: "us-east-1", future_key: { keep: 1 } });
  });
});

describe("contract parity", () => {
  it("channel tables cover exactly the 9 publishable kinds", () => {
    expect(Object.keys(CHANNEL_KIND_FIELDS).sort()).toEqual([...CHANNEL_KINDS].sort());
  });

  it("provider catalog hint DTO keys exactly mirror the documented catalog field set", () => {
    // MODEL_CATALOG_FIELD_ROWS (config-components.ts) is the documented field
    // table; server MODEL_CATALOG_FIELD_KEY_MAP mirrors it. catalog_id is a
    // declared provider field, and the record-typed model_links is dotted in
    // the inventory.
    const documented = MODEL_CATALOG_FIELD_ROWS.filter(([suffix]) => suffix !== "catalog_id").map(([suffix]) =>
      suffix === "model_links.*" ? "model_links" : suffix,
    );
    expect(Object.keys(MODEL_CATALOG_HINT_FIELDS).sort()).toEqual(documented.sort());
    expect(Object.keys(PROVIDER_PASSTHROUGH_FIELDS)).toEqual(
      expect.arrayContaining(Object.keys(MODEL_CATALOG_HINT_FIELDS)),
    );
  });

  it("provider kind tables do not overlap", () => {
    const seen = new Set<string>();
    for (const fields of Object.values(PROVIDER_KIND_FIELDS)) {
      for (const key of Object.keys(fields)) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("trigger kind tables only contain managed kinds", () => {
    expect(Object.keys(TRIGGER_KIND_FIELDS).sort()).toEqual(
      ["gitea", "forgejo", "github", "gitlab", "manual", "p4", "scheduled", "svn"].sort(),
    );
  });
});

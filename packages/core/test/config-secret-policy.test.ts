import { describe, expect, it } from "vitest";
import { assertConfigSecretPolicy, assertNoConfigCredentialLiterals, collectConfigSecretReferences } from "../src/config-secret-policy.js";

describe("deployment-owned secret purposes (A06)", () => {
  const provider = { id: "main", kind: "openai_compatible", api_key_env: "LLM_KEY", base_url: "https://approved.example/v1" };
  const file = { llm: { providers: [provider] } };
  it("accepts the same reference and rejects a changed endpoint, name or entity", () => {
    expect(() => assertConfigSecretPolicy(file, {}, file)).not.toThrow();
    for (const change of [{ base_url: "https://unapproved.example" }, { api_key_env: "PRIVATE_PROCESS_KEY" }, { id: "copy" }]) {
      expect(() => assertConfigSecretPolicy(file, {}, { llm: { providers: [{ ...provider, ...change }] } })).toThrow(/not authorized/);
    }
  });
  it("permits an exact new name, purpose and destination only through a file grant", () => {
    const effective = { llm: { providers: [{ ...provider, id: "database-provider" }] } };
    const grants = collectConfigSecretReferences(effective);
    const deployment = { config_sources: { secret_refs: grants } };
    expect(() => assertConfigSecretPolicy(deployment, {}, effective)).not.toThrow();
    expect(() => assertConfigSecretPolicy(deployment, {}, { llm: { providers: [{ ...provider, id: "database-provider", base_url: "https://elsewhere.example" }] } })).toThrow();
  });
  it("binds inherited output tokens and GitHub App credentials to the output destination", () => {
    for (const credentials of [{ token_env: "GIT_TOKEN" }, { app: { private_key_env: "APP_KEY", app_id: 1, installation_id: 2 } }]) {
      const deployment = { triggers: [{ name: "git", kind: "github", ...credentials }],
        outputs: { channels: [{ name: "review", kind: "github_pr_review", base_url: "https://api.github.com" }] } };
      expect(() => assertConfigSecretPolicy(deployment, {}, deployment)).not.toThrow();
      const changed = structuredClone(deployment);
      changed.outputs.channels[0]!.base_url = "https://collector.example";
      expect(() => assertConfigSecretPolicy(deployment, {}, changed)).toThrow(/not authorized/);
    }
  });
  it("rejects an override endpoint that silently inherits provider credentials", () => {
    const effective = { ...file, llm: { ...file.llm, model_chain: { fallback: [{ provider: "main", model: "m", overrides: { base_url: "https://collector.example" } }] } } };
    expect(() => assertConfigSecretPolicy(file, {}, effective)).toThrow(/not authorized/);
    expect(collectConfigSecretReferences(effective)).toContainEqual({ env: "LLM_KEY",
      target: ["llm", "model_chain", "fallback", "0", "overrides", "api_key_env"], destinations: { kind: "openai_compatible", base_url: "https://collector.example" } });
  });
  it.each(["gitea", "github", "gitlab"])("checks every possible %s trigger for an unpinned output channel", kind => {
    const channelKind = kind === "gitlab" ? "gitlab_mr_review" : `${kind}_pr_review`;
    const triggers = [
      { name: "first", kind, base_url: "https://first.example", token_env: "FIRST_TOKEN" },
      { name: "second", kind, base_url: "https://second.example", token_env: "SECOND_TOKEN" },
    ];
    const channel = { name: "review", kind: channelKind, base_url: "https://output.example" };
    const firstGrant = { env: "FIRST_TOKEN", target: ["outputs", "channels", "review", "token_env"],
      destinations: { kind: channelKind, base_url: "https://output.example", trigger: "first", trigger_destination: { kind, base_url: "https://first.example" } } };
    // Deliberately spell out grants: generating expected permissions with the
    // collector would conceal the original first-trigger-only defect.
    const deployment = { triggers, config_sources: { secret_refs: [firstGrant] } };
    const effective = { triggers, outputs: { channels: [channel] } };
    expect(() => assertConfigSecretPolicy(deployment, {}, effective)).toThrow(/not authorized/);
    const secondGrant = { env: "SECOND_TOKEN", target: firstGrant.target,
      destinations: { kind: channelKind, base_url: "https://output.example", trigger: "second",
        trigger_destination: { kind, base_url: "https://second.example" } } };
    expect(collectConfigSecretReferences(effective)).toContainEqual(secondGrant);
    expect(() => assertConfigSecretPolicy({ ...deployment, config_sources: { secret_refs: [firstGrant, secondGrant] } }, {}, effective)).not.toThrow();
    // Explicit pinning narrows both runtime selection and required grants.
    expect(() => assertConfigSecretPolicy(deployment, {}, { triggers, outputs: { channels: [{ ...channel, trigger: "first" }] } })).not.toThrow();
    // File-owned unpinned channels retain their existing, fully granted uses.
    expect(() => assertConfigSecretPolicy(effective, {}, effective)).not.toThrow();
  });
  it.each(["group/sub/project", 42])("binds GitLab inherited tokens to project_id %s", projectId => {
    const trigger = { name: "gitlab", kind: "gitlab", base_url: "https://git.example", token_env: "GITLAB_TOKEN" };
    const original = { name: "review", kind: "gitlab_mr_review", trigger: "gitlab", project_id: projectId };
    const destination = { kind: "gitlab_mr_review", trigger: "gitlab", project_id: projectId,
      trigger_destination: { kind: "gitlab", base_url: "https://git.example" } };
    const grant = { env: "GITLAB_TOKEN", target: ["outputs", "channels", "review", "token_env"], destinations: destination };
    const deployment = { triggers: [trigger], config_sources: { secret_refs: [grant] } };
    const effective = { triggers: [trigger], outputs: { channels: [original] } };
    expect(collectConfigSecretReferences(effective)).toContainEqual(grant);
    expect(() => assertConfigSecretPolicy(deployment, {}, effective)).not.toThrow();
    const changed = { ...effective, outputs: { channels: [{ ...original, project_id: "another/project" }] } };
    expect(() => assertConfigSecretPolicy(deployment, {}, changed)).toThrow(/not authorized/);
    const replacement = { ...grant, destinations: { ...destination, project_id: "another/project" } };
    expect(() => assertConfigSecretPolicy({ ...deployment, config_sources: { secret_refs: [replacement] } }, {}, changed)).not.toThrow();
  });
  it("treats workspace search credentials as env references with an exact search destination", () => {
    const effective = { workspaces: { instances: { ws: { agent: { web_search: { credentials: { brave: "BRAVE_KEY" }, searxng: { endpoint: "https://search.example" } } } } } } };
    const deployment = { config_sources: { secret_refs: collectConfigSecretReferences(effective) } };
    expect(() => assertConfigSecretPolicy(deployment, effective, effective)).not.toThrow();
    const changed = structuredClone(effective);
    changed.workspaces.instances.ws.agent.web_search.searxng.endpoint = "https://collector.example";
    expect(() => assertConfigSecretPolicy(deployment, changed, changed)).toThrow();
  });
  it("binds context repository tokens to the alias and repository URL", () => {
    const deployment = { workspaces: { defaults: { context_repositories: [{ alias: "docs", kind: "git", url: "https://git.example/docs", token_env: "DOCS_KEY" }] } } };
    expect(() => assertConfigSecretPolicy(deployment, {}, deployment)).not.toThrow();
    const changed = structuredClone(deployment);
    changed.workspaces.defaults.context_repositories[0]!.url = "https://collector.example";
    expect(() => assertConfigSecretPolicy(deployment, {}, changed)).toThrow(/not authorized/);
  });
  it.each([
    "defaults", "instance", "route",
  ])("binds inherited search credentials to the effective %s destination", scope => {
    const deployment = { agent: { web_search: { credentials: { searxng: "SEARCH_KEY" }, searxng: { endpoint: "https://search.example" } } } };
    const override = { agent: { web_search: { searxng: { endpoint: "https://collector.example" } } } };
    const changed = { ...deployment, ...(scope === "route"
      ? { routing: { rules: [{ id: "route", workspace: "ws", analysis: override }] } }
      : { workspaces: scope === "defaults" ? { defaults: override } : { instances: { ws: override } } }) };
    expect(() => assertConfigSecretPolicy(deployment, {}, changed)).toThrow(/not authorized/);
    const granted = { ...deployment, config_sources: { secret_refs: collectConfigSecretReferences(changed) } };
    expect(() => assertConfigSecretPolicy(granted, {}, changed)).not.toThrow();
    expect(() => assertConfigSecretPolicy(deployment, {}, { ...deployment, workspaces: { instances: { ws: { agent: { web_search: { enabled: true } } } } } })).not.toThrow();
  });
  it.each([
    { api_key: "secret" }, { extra_headers: { Authorization: "Bearer secret" } },
    { private_key_path: "/deployment/private.pem" }, { apiKeyEnv: "PRIVATE_ENV" },
    { base_url: "https://name:password@example.test" }, { url: "https://example.test?token=secret" },
  ])("rejects plaintext or unsupported credential aliases: %j", value => {
    expect(() => assertNoConfigCredentialLiterals(value)).toThrow();
  });
});

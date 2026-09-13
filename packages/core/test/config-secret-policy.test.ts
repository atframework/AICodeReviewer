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

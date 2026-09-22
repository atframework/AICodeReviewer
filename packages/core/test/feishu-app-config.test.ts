import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { appConfigSchema, outputChannelSchema } from "../src/config.js";
import { validateEntityCapabilities } from "../src/config-capabilities.js";
import { assertConfigSecretPolicy } from "../src/config-secret-policy.js";
import { carryOverSecretLiterals, createConfigSecretSealing, sealConfigSecretLiterals, openConfigSecretLiterals } from "../src/config-secret-sealing.js";
import { buildConfigUiSpec } from "../src/config-ui-spec.js";

const channel = { name: "app", kind: "feishu_app", app_id: "cli_test", app_secret_env: "FEISHU_SECRET",
  receive_id: "oc_target", member_directory: { chat_id: "oc_members" }, user_mappings: { alice: "ou_alice" } };

describe("Feishu app configuration contract", () => {
  it("requires app credentials and destination and rejects invalid fields at schema/capability boundaries", () => {
    expect(() => outputChannelSchema.parse(channel)).not.toThrow();
    expect(() => validateEntityCapabilities("channel", channel)).not.toThrow();
    for (const change of [{ app_id: undefined }, { receive_id: undefined }, { app_secret_env: undefined },
      { app_secret: "both" }, { receive_id_type: "mobile" }, { base_url: "https://collector.example" },
      { member_directory: { chat_id: "x", cache_ttl_seconds: -1 } }, { member_directory: { chat_id: "x", cache_ttl_seconds: 604_801 } },
      { user_mappings: { alice: "all" } }]) {
      expect(() => outputChannelSchema.parse({ ...channel, ...change })).toThrow();
    }
    expect(() => validateEntityCapabilities("channel", { ...channel, webhook_url: "unused" })).toThrow();
    expect(() => validateEntityCapabilities("channel", { ...channel, kind: "feishu_bot" })).toThrow();
  });
  it("accepts directory cache TTL bounds per channel and in global author resolution", () => {
    expect(() => outputChannelSchema.parse({ ...channel, member_directory: { chat_id: "x", cache_ttl_seconds: 604_800 } })).not.toThrow();
    expect(appConfigSchema.parse({ outputs: { author_resolution: { directory_cache_ttl_seconds: 86_400 } } })
      .outputs.author_resolution?.directory_cache_ttl_seconds).toBe(86_400);
    for (const bad of [-1, 604_801, 1.5]) {
      expect(() => appConfigSchema.parse({ outputs: { author_resolution: { directory_cache_ttl_seconds: bad } } })).toThrow();
    }
  });
  it("seals the literal app secret and binds environment grants to app, recipient and source group", () => {
    const service = createConfigSecretSealing(Buffer.alloc(32, 5));
    const input = { outputs: { channels: [{ ...channel, app_secret_env: undefined, app_secret: "literal-private-secret" }] } };
    const sealed = sealConfigSecretLiterals(input, service);
    expect(JSON.stringify(sealed)).not.toContain("literal-private-secret");
    expect(sealed.outputs.channels[0]?.app_secret).toMatch(/^enc:v1\./);
    expect(openConfigSecretLiterals(sealed, service)).toEqual(input);
    const stored = sealed.outputs.channels[0]!;
    expect(carryOverSecretLiterals(stored, { name: "app" })).toMatchObject({ app_secret: stored.app_secret });
    expect(carryOverSecretLiterals(stored, { name: "app", app_secret: null })).not.toHaveProperty("app_secret");
    const file = { outputs: { channels: [channel] } };
    expect(() => assertConfigSecretPolicy(file, {}, file)).not.toThrow();
    for (const change of [{ app_id: "cli_other" }, { receive_id: "oc_other" }, { receive_id_type: "open_id" },
      { member_directory: { chat_id: "oc_other" } }]) {
      expect(() => assertConfigSecretPolicy(file, {}, { outputs: { channels: [{ ...channel, ...change }] } })).toThrow(/not authorized/);
    }
  });
  it("exposes kind-specific management fields and a masked credential control", () => {
    const spec = buildConfigUiSpec();
    const fields = spec.pages.find(page => page.id === "channels")!.sections.flatMap(section => section.fields);
    expect(fields.find(field => field.path.join(".") === "kind")?.options?.map(option => option.value)).toContain("feishu_app");
    expect(fields.find(field => field.path.join(".") === "app_secret")).toMatchObject({ control: "secret-value", kinds: ["feishu_app"] });
    expect(fields.find(field => field.path.join(".") === "member_directory.chat_id")?.kinds).toEqual(["feishu_app"]);
    expect(fields.find(field => field.path.join(".") === "guess_author")).toMatchObject({ control: "toggle", kinds: ["feishu_app"] });
    for (const pageId of ["model-groups", "workspaces"]) {
      const refs = spec.pages.find(page => page.id === pageId)!.sections.flatMap(section => section.fields)
        .filter(field => field.path.at(-1) === "author_resolution_model_chain");
      expect(refs.length).toBeGreaterThan(0);
      for (const field of refs) expect(field.optionsSource).toBe("model_groups");
    }
  });
  it("validates the runnable example and both public guide examples", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const example = parse(readFileSync(resolve(root, "example/feishu-app.yaml"), "utf8"));
    const config = appConfigSchema.parse(example);
    expect(config.outputs.channels[0]?.kind).toBe("feishu_app");
    const identity = appConfigSchema.parse(parse(readFileSync(resolve(root, "example/feishu-author-model.yaml"), "utf8")));
    expect(identity.llm.author_resolution_model_chain).toBe("directory-identity");
    for (const locale of ["en", "zh-cn"]) {
      const markdown = readFileSync(resolve(root, `docs/site/src/content/docs/${locale}/integrations/im-bots.md`), "utf8");
      const examples = [...markdown.matchAll(/```yaml\r?\n([\s\S]*?)```/gu)].map(match => match[1]!).filter(text => text.includes("kind: feishu_app"));
      expect(examples).toHaveLength(1);
      for (const text of examples) expect(appConfigSchema.parse(parse(text)).outputs.channels[0]?.kind).toBe("feishu_app");
    }
  });
});

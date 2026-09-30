import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import * as core from "../src/index.js";
import { appConfigSchema, outputChannelSchema, parseConfigDocumentText, parseEffectiveConfig } from "../src/config.js";
import { validateEntityCapabilities } from "../src/config-capabilities.js";
import { channelMemberDirectorySchema, imCommandBindingSchema, imConfigSchema, wecomAppTargetSchema } from "../src/im-config.js";

/**
 * IM-01 acceptance C01–C03: schema-level contracts only. Runtime wiring
 * (publishers, callbacks, directories) lands with IM-05+; the capability gate
 * below pins the staged boundary so no consumer-less config can publish.
 */

const legacyFeishuYaml = `
outputs:
  channels:
    - name: feishu-app-inline
      kind: feishu_app
      app_id: cli_legacy
      app_secret_env: FEISHU_SECRET
      receive_id: oc_target
      member_directory:
        chat_id: oc_members
        cache_ttl_seconds: 600
      user_mappings:
        alice: ou_alice
`;

const connections = {
  "corp-review": {
    kind: "wecom_app",
    corp_id: "ww_example",
    agent_id: 1000002,
    app_secret_env: "AICR_WECOM_APP_SECRET",
    callback: {
      enabled: true,
      token_env: "AICR_WECOM_CALLBACK_TOKEN",
      encoding_aes_key_env: "AICR_WECOM_CALLBACK_AES_KEY",
    },
  },
  "corp-bot": {
    kind: "wecom_aibot",
    corp_id: "ww_example",
    aibot_id: "bot-1",
    callback: { enabled: false },
  },
  "feishu-review": {
    kind: "feishu_app",
    app_id: "cli_example",
    app_secret: "literal-secret",
    tenant_key: "tenant-key-1",
    callback: {
      enabled: true,
      verification_token_env: "AICR_FEISHU_VERIFY_TOKEN",
      encrypt_key_env: "AICR_FEISHU_ENCRYPT_KEY",
    },
  },
} as const;

const binding = {
  enabled: true,
  connection: "corp-review",
  conversations: [{ kind: "app_direct" }],
  actors: [{ type: "wecom_userid", id: "alice_zhang" }],
  commands: ["help", "chat-id", "review", "status"],
  repositories: {
    service: { workspace: "service-main", source_trigger: "github-main", repo_ref: "example-org/service" },
  },
  report_policy: "workspace_routes",
};

const wecomAppChannel = {
  name: "wecom-application",
  kind: "wecom_app",
  connection: "corp-review",
  target: { kind: "recipients", users: ["alice_zhang"] },
};

const minimalImConfig = (im: unknown): Record<string, unknown> => ({
  im,
  outputs: { channels: [] },
});

describe("C01: historical documents keep their canonical shape", () => {
  it("parses a legacy feishu inline config without injecting an im node or directory source", () => {
    const loaded = parseConfigDocumentText(legacyFeishuYaml, { fileName: "legacy.yaml" });
    expect(loaded.config.im).toBeUndefined();
    expect(JSON.stringify(loaded.config)).not.toContain('"im"');
    const channel = loaded.config.outputs.channels[0]!;
    expect(channel.member_directory).toEqual({ chat_id: "oc_members", cache_ttl_seconds: 600 });
    expect(channel.user_mappings).toEqual({ alice: "ou_alice" });
    expect(outputChannelSchema.parse(channel)).toEqual(channel);
  });

  it("keeps v2 effective documents free of im defaults and accepts the optional node", () => {
    const v2 = parseEffectiveConfig(parseYaml(legacyFeishuYaml), 2);
    expect(v2.im).toBeUndefined();
    const withIm = parseEffectiveConfig({
      ...parseYaml(legacyFeishuYaml),
      im: { connections: { "corp-review": connections["corp-review"] } },
    }, 2);
    expect(withIm.im?.connections?.["corp-review"]?.kind).toBe("wecom_app");
  });

  it("rejects unknown keys inside the strict im node instead of passthrough-preserving them", () => {
    expect(() => imConfigSchema.parse({ connections, webhook: {} })).toThrow();
  });
});

describe("C02: the three protocols, both targets and both directory sources parse", () => {
  it("accepts connections, bindings, both wecom targets and file/api directories", () => {
    const config = appConfigSchema.parse(minimalImConfig({
      connections,
      command_bindings: { reviewers: binding },
    }));
    expect(config.im?.connections?.["corp-bot"]?.kind).toBe("wecom_aibot");
    expect(config.im?.command_bindings?.reviewers?.repositories?.service?.repo_ref).toBe("example-org/service");
    expect(wecomAppTargetSchema.parse({ kind: "appchat", chat_id: "chat-1" })).toEqual({ kind: "appchat", chat_id: "chat-1" });

    const fileDirectory = channelMemberDirectorySchema.parse({
      source: "file",
      path: "./private/im-members.yaml",
      directory_id: "engineering-wecom",
      identity_scope: { kind: "wecom_corp", id: "ww_example" },
      watch: true,
      debounce_ms: 300,
      poll_interval_seconds: 30,
    });
    expect(fileDirectory).toEqual({
      source: "file",
      path: "./private/im-members.yaml",
      directory_id: "engineering-wecom",
      identity_scope: { kind: "wecom_corp", id: "ww_example" },
      watch: true,
      debounce_ms: 300,
      poll_interval_seconds: 30,
    });
    expect(channelMemberDirectorySchema.parse({ chat_id: "oc_members" })).toEqual({ chat_id: "oc_members" });
    expect(channelMemberDirectorySchema.parse({ source: "feishu_api", chat_id: "oc_members", cache_ttl_seconds: 60 })).toEqual({
      source: "feishu_api", chat_id: "oc_members", cache_ttl_seconds: 60,
    });
  });

  it("resolves the full example draft config through the public exports", () => {
    expect(core.imConfigSchema).toBeDefined();
    expect(core.wecomAppTargetSchema).toBeDefined();
    expect(core.imCommandBindingSchema).toBeDefined();
    const config = appConfigSchema.parse({
      config_sources: { database: { enabled: true, backend: "storage" } },
      im: { connections, command_bindings: { reviewers: binding } },
      outputs: { channels: [wecomAppChannel, {
        name: "wecom-group", kind: "wecom_bot", webhook_url_env: "AICR_WECOM_GROUP_WEBHOOK",
        member_directory: {
          source: "file", path: "./private/im-members.yaml", directory_id: "engineering-wecom",
          identity_scope: { kind: "wecom_corp", id: "ww_example" },
        },
      }] },
    });
    expect(config.outputs.channels[0]?.target).toEqual({ kind: "recipients", users: ["alice_zhang"] });
    expect(config.outputs.channels[1]?.member_directory).toMatchObject({ source: "file" });
  });
});

describe("C03: credential, identity and wiring mistakes fail at exact paths", () => {
  it("rejects literal/env overlap and missing credentials", () => {
    expect(imConfigSchema.safeParse({ connections: { a: { ...connections["corp-review"]!, app_secret: "both" } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ connections: { a: { kind: "wecom_app", corp_id: "ww", agent_id: 2 } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ connections: { a: {
      kind: "feishu_app", app_id: "cli_x", app_secret_env: "S",
      callback: { enabled: true, verification_token: "t", encrypt_key: "k" },
    } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ connections: { a: {
      kind: "feishu_app", app_id: "cli_x", app_secret_env: "S", tenant_key: "t1",
      callback: { enabled: true, verification_token: "t", encrypt_key: "k", encrypt_key_env: "E" },
    } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ connections: { a: { kind: "wecom_app", corp_id: "ww", agent_id: 2, app_secret_env: "S", callback: {} } } }).success).toBe(true);
  });

  it("rejects wrong identity domains and conversation/actor mismatches per protocol", () => {
    expect(imConfigSchema.safeParse({ command_bindings: { b: { ...binding, conversations: [{ kind: "group", id: "g1" }] } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ command_bindings: { b: { ...binding, actors: [{ type: "feishu_open_id", id: "ou_x" }] } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ command_bindings: { b: { ...binding, actors: [{ type: "wecom_encrypted_userid", id: "x" }] } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ command_bindings: { b: {
      enabled: true, connection: "feishu-review", conversations: [{ kind: "bot_direct" }],
      actors: [{ type: "feishu_open_id", id: "ou_x" }], commands: ["status"],
    }, connections } }).success).toBe(false);
  });

  it("requires repository mappings for review commands and known connections for enabled bindings", () => {
    expect(imConfigSchema.safeParse({ command_bindings: { b: { ...binding, repositories: {} } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ command_bindings: { b: { ...binding, repositories: undefined } } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ command_bindings: { b: { ...binding, connection: "missing" } } }).success).toBe(false);
    expect(imCommandBindingSchema.safeParse({ ...binding, commands: ["review", "review"] }).success).toBe(false);
    expect(imCommandBindingSchema.safeParse({ ...binding, commands: ["force"] }).success).toBe(false);
  });

  it("keeps disabled drafts savable and rejects overlapping enabled bindings", () => {
    expect(imConfigSchema.safeParse({ connections, command_bindings: {
      draft: { ...binding, enabled: false, connection: "not-created-yet" },
    } }).success).toBe(true);
    const overlapping = {
      reviewers: binding,
      "reviewers-2": { ...binding, commands: ["status"] },
    };
    expect(imConfigSchema.safeParse({ connections, command_bindings: overlapping }).success).toBe(false);
    expect(imConfigSchema.safeParse({ connections, command_bindings: {
      reviewers: binding,
      other: { ...binding, connection: "corp-bot", conversations: [{ kind: "bot_direct" }] },
    } }).success).toBe(true);
  });

  it("accepts scope matchers on matching platforms and rejects cross-platform kinds", () => {
    const scopeBinding = {
      enabled: true,
      connection: "corp-bot",
      conversations: [{ kind: "bot_direct" }],
      actors: [
        { kind: "wecom_department", id: "2" },
        { kind: "wecom_tag", id: "3", expires_at: "2026-10-06T00:00:00+08:00" },
        { kind: "wecom_extattr", name: "级别", value: "G5" },
        { kind: "any", expires_at: "2026-10-06T00:00:00Z" },
      ],
      commands: ["chat-id"],
    };
    expect(imConfigSchema.safeParse({ connections, command_bindings: { scoped: scopeBinding } }).success).toBe(true);
    // Feishu matcher kinds cannot resolve against WeCom connections.
    expect(imConfigSchema.safeParse({ connections, command_bindings: {
      scoped: { ...scopeBinding, actors: [{ kind: "feishu_chat", chat_id: "oc_x" }] },
    } }).success).toBe(false);
    // Malformed expiry timestamps are rejected.
    expect(imConfigSchema.safeParse({ connections, command_bindings: {
      scoped: { ...scopeBinding, actors: [{ kind: "any", expires_at: "tomorrow" }] },
    } }).success).toBe(false);
  });

  it("treats `any` as overlapping every matcher on the same connection", () => {
    expect(imConfigSchema.safeParse({ connections, command_bindings: {
      open: {
        enabled: true, connection: "corp-bot", conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }], commands: ["chat-id"],
      },
      dept: {
        enabled: true, connection: "corp-bot", conversations: [{ kind: "group", id: "wr_ch" }],
        actors: [{ kind: "wecom_department", id: "2" }], commands: ["review"],
        repositories: { service: binding.repositories.service },
      },
    } }).success).toBe(true);
    expect(imConfigSchema.safeParse({ connections, command_bindings: {
      open: {
        enabled: true, connection: "corp-bot", conversations: [{ kind: "group", id: "wr_ch" }],
        actors: [{ kind: "any" }], commands: ["review"],
        repositories: { service: binding.repositories.service },
      },
      dept: {
        enabled: true, connection: "corp-bot", conversations: [{ kind: "group", id: "wr_ch" }],
        actors: [{ kind: "wecom_department", id: "2" }], commands: ["review"],
        repositories: { service: binding.repositories.service },
      },
    } }).success).toBe(false);
  });

  it("guards channel-level reference and target rules", () => {
    expect(outputChannelSchema.safeParse(wecomAppChannel).success).toBe(true);
    expect(outputChannelSchema.safeParse({ ...wecomAppChannel, target: undefined }).success).toBe(false);
    expect(outputChannelSchema.safeParse({ ...wecomAppChannel, connection: undefined, target: undefined }).success).toBe(false);
    expect(outputChannelSchema.safeParse({ name: "g", kind: "wecom_bot", webhook_url: "https://x/y", connection: "corp-review" }).success).toBe(false);
    expect(outputChannelSchema.safeParse({ name: "g", kind: "wecom_bot", webhook_url: "https://x/y", target: { kind: "appchat", chat_id: "c" } }).success).toBe(false);
    expect(outputChannelSchema.safeParse({
      name: "f", kind: "feishu_app", app_id: "cli_x", app_secret_env: "S", receive_id: "oc_x", connection: "feishu-review",
    }).success).toBe(false);
    expect(outputChannelSchema.safeParse({
      name: "f", kind: "feishu_app", connection: "feishu-review", receive_id: "oc_x",
    }).success).toBe(true);
    expect(outputChannelSchema.safeParse({
      name: "f", kind: "feishu_app", app_id: "cli_x", app_secret_env: "S", receive_id: "oc_x",
      user_mappings: { a: "ou_a" }, author_mappings: { a: "alice" },
    }).success).toBe(false);
    expect(wecomAppTargetSchema.safeParse({ kind: "recipients", users: [], parties: [], tags: [] }).success).toBe(false);
  });

  it("enforces file-directory bounds and rejects cache TTL fields on the file source", () => {
    const fileBase = {
      source: "file", path: "./d.yaml", directory_id: "d", identity_scope: { kind: "wecom_corp", id: "ww" },
    } as const;
    expect(channelMemberDirectorySchema.safeParse({ ...fileBase, cache_ttl_seconds: 60 }).success).toBe(false);
    expect(channelMemberDirectorySchema.safeParse({ ...fileBase, debounce_ms: 10 }).success).toBe(false);
    expect(channelMemberDirectorySchema.safeParse({ ...fileBase, debounce_ms: 2000, poll_interval_seconds: 300 }).success).toBe(true);
    expect(channelMemberDirectorySchema.safeParse({ ...fileBase, poll_interval_seconds: 301 }).success).toBe(false);
    expect(channelMemberDirectorySchema.safeParse({ ...fileBase, identity_scope: { kind: "wecom_corp" } }).success).toBe(false);
  });

  it("rejects prototype-chain keys and malformed entity names in im maps", () => {
    expect(imConfigSchema.safeParse({ connections: { __proto__: connections["corp-review"]! } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ connections: { "-bad": connections["corp-review"]! } }).success).toBe(false);
    expect(imConfigSchema.safeParse({ connections: { ["x".repeat(65)]: connections["corp-review"]! } }).success).toBe(false);
  });

  it("pins the staged capability boundary: schema acceptance alone never publishes", () => {
    // The wecom_app publisher landed with IM-05; its records now publish.
    expect(() => validateEntityCapabilities("channel", wecomAppChannel)).not.toThrow();
    expect(() => validateEntityCapabilities("channel", { ...wecomAppChannel, connection: 42 })).toThrow();
    // File directories landed with IM-06/IM-08; the capability gate accepts
    // them on every IM channel kind now that consumers exist (C03/D14).
    expect(() => validateEntityCapabilities("channel", {
      name: "g", kind: "wecom_bot", webhook_url: "https://x/y",
      member_directory: { source: "file", path: "./d", directory_id: "d", identity_scope: { kind: "wecom_corp", id: "ww" } },
    })).not.toThrow();
    expect(() => validateEntityCapabilities("channel", {
      name: "g", kind: "gitea_issue",
      member_directory: { source: "file", path: "./d", directory_id: "d", identity_scope: { kind: "wecom_corp", id: "ww" } },
    })).toThrow(/no runtime consumer/u);
  });
});

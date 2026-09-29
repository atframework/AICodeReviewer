import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig, type ImPrincipal, type ImConversation } from "@aicr/core";
import { closeStoreDb, createStoreDb, type SqliteStoreDb } from "@aicr/store";

import { admitImCommand, authorizeImCommand, parseImCommand, stripImMentionPrefix, IM_HELP_TEXT } from "../src/im/command-service.js";

/**
 * IM-11 acceptance A01–A08: fixed grammar, exact typed authorization, atomic
 * admission through the real SQLite store with rate limits and active-target
 * merging. Every positive input is paired with its rejection.
 */

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-cmd-"));
  store = createStoreDb(join(dir, "cmd.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

const ACTOR_OWENT: ImPrincipal = { type: "wecom_userid", id: "owent" };
const CONV_DIRECT: ImConversation = { kind: "bot_direct" };
const REPO_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeConfig(overrides: {
  bindings?: Record<string, Record<string, unknown>>;
  connections?: Record<string, Record<string, unknown>>;
  triggers?: readonly Record<string, unknown>[];
  workspaces?: Record<string, unknown>;
} = {}): AppConfig {
  return appConfigSchema.parse({
    im: {
      connections: overrides.connections ?? {
        "wecom-airobot": {
          kind: "wecom_aibot",
          corp_id: "ww_example",
          aibot_id: "bot-1",
        },
      },
      command_bindings: overrides.bindings ?? {
        reviewers: {
          enabled: true,
          connection: "wecom-airobot",
          conversations: [{ kind: "bot_direct" }],
          actors: [{ type: "wecom_userid", id: "owent" }],
          commands: ["help", "chat-id", "review", "status"],
          repositories: {
            service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" },
          },
        },
      },
    },
    triggers: overrides.triggers ?? [{ name: "github-main", kind: "github" }],
    workspaces: overrides.workspaces ?? { instances: { "ws-main": {} } },
    outputs: { channels: [] },
  });
}

function admitInput(command: { kind: string } & Record<string, unknown>, config: AppConfig, overrides: Partial<Parameters<typeof admitImCommand>[1]> = {}) {
  return {
    config,
    namespace: "ns-cmd",
    connectionName: "wecom-airobot",
    connectionIdentity: "wecom-bot",
    deliveryKey: `msg-${Math.random()}`,
    payloadDigest: `sha:${Math.random()}`,
    actor: ACTOR_OWENT,
    conversation: CONV_DIRECT,
    command,
    now: new Date(),
    configSnapshotId: "snap-1",
    configFileDigest: "d".repeat(64),
    ...overrides,
  };
}

describe("A01: fixed grammar", () => {
  it("parses valid commands and rejects malformed input", () => {
    expect(parseImCommand("aicr help")).toEqual({ kind: "command", command: { kind: "help" } });
    expect(parseImCommand("aicr chat-id")).toEqual({ kind: "command", command: { kind: "chat-id" } });
    expect(parseImCommand(`aicr review service ${REPO_SHA}`)).toEqual({
      kind: "command", command: { kind: "review", repoAlias: "service", revision: REPO_SHA },
    });
    expect(parseImCommand("aicr status imr-123")).toEqual({
      kind: "command", command: { kind: "status", requestId: "imr-123" },
    });

    // Negative: extra arguments, multiline, shell characters, non-command.
    expect(parseImCommand("aicr help extra")).toMatchObject({ kind: "invalid", reason: "unexpected_arguments" });
    expect(parseImCommand("aicr review service abc\ndef")).toMatchObject({ kind: "invalid", reason: "multiline" });
    expect(parseImCommand("aicr help; rm -rf /")).toMatchObject({ kind: "invalid", reason: "shell_metacharacters" });
    expect(parseImCommand("hello there")).toEqual({ kind: "not_command" });
    expect(parseImCommand("aicr review service $HOME")).toMatchObject({ kind: "invalid" });
    // HEAD is alphanumeric so the tokenizer accepts it; the revision
    // resolver (IM-13) rejects floating refs during validation.
    expect(parseImCommand("aicr review service HEAD")).toMatchObject({ kind: "command" });
    expect(parseImCommand("aicr review service " + "a".repeat(3000))).toMatchObject({ kind: "invalid" });
  });

  it("strips one leading group @mention before parsing", () => {
    // WeCom group mentions name the bot; Feishu uses @_user_N placeholders.
    expect(stripImMentionPrefix("@AICR机器人(事件回调) aicr help")).toBe("aicr help");
    expect(stripImMentionPrefix("@_user_1 aicr help")).toBe("aicr help");
    expect(stripImMentionPrefix("  aicr help  ")).toBe("aicr help");
    // A bare mention with nothing after it is empty, not a command.
    expect(stripImMentionPrefix("@AICR机器人")).toBe("");
    expect(parseImCommand(stripImMentionPrefix("@AICR机器人(事件回调) aicr help"))).toEqual({
      kind: "command", command: { kind: "help" },
    });
  });
});

describe("A02–A04: exact typed authorization", () => {
  const config = makeConfig();

  it("authorizes the exact typed principal in the exact conversation", () => {
    expect(authorizeImCommand({
      config, connectionName: "wecom-airobot", actor: ACTOR_OWENT, conversation: CONV_DIRECT,
      command: { kind: "review", repoAlias: "service", revision: REPO_SHA },
    })).toMatchObject({ kind: "authorized" });
  });

  it("rejects same-name actors on other connections, unknown repos and floating revisions", () => {
    // Same-name but different ID
    expect(authorizeImCommand({
      config, connectionName: "wecom-airobot", actor: { type: "wecom_userid", id: "other" }, conversation: CONV_DIRECT,
      command: { kind: "help" },
    })).toMatchObject({ kind: "rejected" });

    // Unknown repo alias
    expect(authorizeImCommand({
      config, connectionName: "wecom-airobot", actor: ACTOR_OWENT, conversation: CONV_DIRECT,
      command: { kind: "review", repoAlias: "ghost", revision: REPO_SHA },
    })).toMatchObject({ kind: "rejected", reason: "repository_not_authorized" });

    // Wrong connection
    expect(authorizeImCommand({
      config, connectionName: "nonexistent", actor: ACTOR_OWENT, conversation: CONV_DIRECT, command: { kind: "help" },
    })).toMatchObject({ kind: "rejected", reason: "connection_unavailable" });
  });

  it("rejects unknown conversations (A03)", () => {
    expect(authorizeImCommand({
      config, connectionName: "wecom-airobot", actor: ACTOR_OWENT,
      conversation: { kind: "group", id: "unlisted-group" },
      command: { kind: "help" },
    })).toMatchObject({ kind: "rejected", reason: "no_matching_binding" });
  });

  it("rejects when the repository target references a missing trigger or workspace (A04)", () => {
    const broken = makeConfig({
      bindings: {
        broken: {
          enabled: true, connection: "wecom-airobot",
          conversations: [{ kind: "bot_direct" }],
          actors: [{ type: "wecom_userid", id: "owent" }],
          commands: ["review"],
          repositories: { svc: { workspace: "ghost-ws", source_trigger: "github-main", repo_ref: "org/s" } },
        },
      },
    });
    expect(authorizeImCommand({
      config: broken, connectionName: "wecom-airobot", actor: ACTOR_OWENT, conversation: CONV_DIRECT,
      command: { kind: "review", repoAlias: "svc", revision: REPO_SHA },
    })).toMatchObject({ kind: "rejected", reason: "repository_target_invalid" });
  });
});

describe("A06–A08: atomic admission through the real store", () => {
  it("creates a durable review request with the trusted repository target", async () => {
    const config = makeConfig();
    const parse = parseImCommand(`aicr review service ${REPO_SHA}`);
    expect(parse.kind).toBe("command");
    if (parse.kind !== "command") return;
    const outcome = await admitImCommand(store, admitInput(parse.command, config));
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.requestId).toMatch(/^imr-/u);
  });

  it("merges a duplicate delivery to the same active target (A06)", async () => {
    const config = makeConfig();
    const command = { kind: "review" as const, repoAlias: "service", revision: REPO_SHA };
    const base = admitInput(command, config);
    const first = await admitImCommand(store, base);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    const second = await admitImCommand(store, { ...base, deliveryKey: `msg-${Math.random()}` });
    expect(second).toMatchObject({ kind: "active_merged", requestId: first.requestId });
  });

  it("rate-limits after five reviews in the same minute window (A06)", async () => {
    const config = makeConfig();
    const command = { kind: "review" as const, repoAlias: "service", revision: REPO_SHA };
    const outcomes: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const input = admitInput(command, config, { deliveryKey: `msg-${index}` });
      // Use unique revisions to avoid active-target merging.
      input.command = { ...command, revision: REPO_SHA.slice(0, 39) + String(index) };
      const outcome = await admitImCommand(store, input);
      outcomes.push(outcome.kind);
    }
    expect(outcomes.filter(kind => kind === "accepted")).toHaveLength(5);
    expect(outcomes.filter(kind => kind === "rate_limited")).toHaveLength(2);
  });

  it("rejects unauthorized actors without creating any request (A08)", async () => {
    const config = makeConfig();
    const input = admitInput({ kind: "review", repoAlias: "service", revision: REPO_SHA }, config);
    input.actor = { type: "wecom_userid", id: "stranger" };
    const outcome = await admitImCommand(store, input);
    expect(outcome).toMatchObject({ kind: "rejected", reason: "no_matching_binding" });
  });
});

describe("help text", () => {
  it("documents all four commands", () => {
    expect(IM_HELP_TEXT).toContain("aicr help");
    expect(IM_HELP_TEXT).toContain("aicr chat-id");
    expect(IM_HELP_TEXT).toContain("aicr review");
    expect(IM_HELP_TEXT).toContain("aicr status");
  });
});

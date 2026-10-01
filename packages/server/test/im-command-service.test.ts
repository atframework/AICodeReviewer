import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig, type ImPrincipal, type ImConversation, type ImActorScopes } from "@aicr/core";
import { acceptImDelivery, closeStoreDb, createStoreDb, type SqliteStoreDb } from "@aicr/store";

import { admitImCommand, authorizeImCommand, parseImCommand, processImCommand, stripImMentionPrefix, IM_HELP_TEXT } from "../src/im/command-service.js";

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

function admitInput(command: { kind: string } & Record<string, unknown>, config: AppConfig, overrides: Partial<Parameters<typeof admitImCommand>[1]> & { deliveryDuplicate?: boolean } = {}) {
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
  it("accepts absolute cancellation cutoffs only with an explicit timezone", () => {
    expect(parseImCommand("aicr cancel before 2026-10-01T12:00:00+08:00")).toEqual({ kind: "command",
      command: { kind: "cancel", repoAlias: undefined, revision: undefined, beforeMs: undefined, beforeAt: Date.parse("2026-10-01T04:00:00Z") } });
    expect(parseImCommand("aicr cancel before 2026-10-01T12:00:00").kind).toBe("invalid");
    expect(parseImCommand("aicr cancel before 2026-02-30T12:00:00Z").kind).toBe("invalid");
    expect(parseImCommand("aicr cancel before 9999999999999999999999d").kind).toBe("invalid");
  });
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

describe("A15: query command grammar and dispatch", () => {
  it("parses the eight query commands with optional arguments", () => {
    expect(parseImCommand("aicr projects")).toEqual({ kind: "command", command: { kind: "projects" } });
    expect(parseImCommand("aicr reviews")).toEqual({ kind: "command", command: { kind: "reviews", repoAlias: undefined } });
    expect(parseImCommand("aicr reviews service")).toEqual({ kind: "command", command: { kind: "reviews", repoAlias: "service" } });
    expect(parseImCommand("aicr commits service main")).toEqual({ kind: "command", command: { kind: "commits", repoAlias: "service", branch: "main" } });
    expect(parseImCommand("aicr commits service")).toEqual({ kind: "command", command: { kind: "commits", repoAlias: "service", branch: undefined } });
    expect(parseImCommand("aicr prs service release/1.2")).toEqual({ kind: "command", command: { kind: "prs", repoAlias: "service", branch: "release/1.2" } });
    expect(parseImCommand("aicr detail service " + REPO_SHA)).toEqual({ kind: "command", command: { kind: "detail", repoAlias: "service", revision: REPO_SHA } });
    expect(parseImCommand("aicr prdetail service 42")).toEqual({ kind: "command", command: { kind: "prdetail", repoAlias: "service", prId: "42" } });
    expect(parseImCommand("aicr queue")).toEqual({ kind: "command", command: { kind: "queue" } });
    expect(parseImCommand("aicr running")).toEqual({ kind: "command", command: { kind: "running" } });
    expect(parseImCommand("aicr commits service main extra")).toMatchObject({ kind: "invalid" });
    expect(parseImCommand("aicr commits service bad;branch")).toMatchObject({ kind: "invalid", reason: "shell_metacharacters" });
  });

  it("query commands require the binding to list them and answer through the query service", async () => {
    const config = makeConfig({ bindings: {
      viewer: {
        enabled: true,
        connection: "wecom-airobot",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }],
        commands: ["reviews", "queue", "running"],
      },
    } });
    const answered: string[] = [];
    const query = { answer: async (input: { command: { kind: string } }) => { answered.push(input.command.kind); return `查询结果:${input.command.kind}`; } };
    const reviews = await processImCommand({ store, query, ...admitInput({ kind: "reviews", repoAlias: undefined }, config) });
    expect(reviews.kind).toBe("replied");
    expect(reviews.replyText).toBe("查询结果:reviews");
    expect(answered).toEqual(["reviews"]);

    // Not listed in the binding's commands → rejected before the query runs.
    const projects = await processImCommand({ store, query, ...admitInput({ kind: "projects" }, config) });
    expect(projects.kind).toBe("rejected");
    expect(answered).toEqual(["reviews"]);

    // No query service wired → fail closed with a clear message.
    const queue = await processImCommand({ store, ...admitInput({ kind: "queue" }, config) });
    expect(queue.replyText).toContain("查询服务不可用");
  });
});

describe("cancel command grammar and dispatch", () => {
  it("parses the three cancellation forms and rejects malformed durations", () => {
    expect(parseImCommand(`aicr cancel service ${REPO_SHA.slice(0, 12)}`)).toEqual({
      kind: "command",
      command: { kind: "cancel", repoAlias: "service", revision: REPO_SHA.slice(0, 12), beforeMs: undefined },
    });
    expect(parseImCommand("aicr cancel service before 2h")).toEqual({
      kind: "command",
      command: { kind: "cancel", repoAlias: "service", revision: undefined, beforeMs: 7_200_000 },
    });
    expect(parseImCommand("aicr cancel before 30m")).toEqual({
      kind: "command",
      command: { kind: "cancel", repoAlias: undefined, revision: undefined, beforeMs: 1_800_000 },
    });
    expect(parseImCommand("aicr cancel before 3d")).toMatchObject({ kind: "command" });
    expect(parseImCommand("aicr cancel service before soon")).toMatchObject({ kind: "invalid", reason: "invalid_duration" });
    expect(parseImCommand("aicr cancel before 0h")).toMatchObject({ kind: "invalid", reason: "invalid_duration" });
    expect(parseImCommand("aicr cancel service")).toMatchObject({ kind: "invalid", reason: "wrong_argument_count" });
    expect(parseImCommand("aicr cancel bad$alias abcdef")).toMatchObject({ kind: "invalid" });
  });

  it("requires the binding to list cancel, fails closed without the service, and answers through it", async () => {
    const config = makeConfig({ bindings: {
      operator: {
        enabled: true,
        connection: "wecom-airobot",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }],
        commands: ["cancel"],
        repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    const seen: string[] = [];
    const cancellation = {
      cancel: async (input: { command: { kind: string; repoAlias?: string } }) => {
        seen.push(input.command.repoAlias ?? "*");
        return "已取消 1 个任务";
      },
    };
    const replied = await processImCommand({
      store, cancellation,
      ...admitInput({ kind: "cancel", repoAlias: "service", revision: REPO_SHA.slice(0, 12), beforeMs: undefined }, config),
    });
    expect(replied.kind).toBe("replied");
    expect(replied.replyText).toBe("已取消 1 个任务");
    expect(seen).toEqual(["service"]);

    // No cancellation service wired → fail closed with a clear message.
    const closed = await processImCommand({
      store,
      ...admitInput({ kind: "cancel", repoAlias: undefined, revision: undefined, beforeMs: 3_600_000 }, config),
    });
    expect(closed.replyText).toContain("取消服务不可用");

    // A binding without the cancel command never reaches the service.
    const notListed = makeConfig({ bindings: {
      viewer: {
        enabled: true, connection: "wecom-airobot", conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }], commands: ["status"],
        repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    const rejected = await processImCommand({
      store, cancellation,
      ...admitInput({ kind: "cancel", repoAlias: "service", revision: REPO_SHA.slice(0, 12), beforeMs: undefined }, notListed),
    });
    expect(rejected.kind).toBe("rejected");
    expect(seen).toEqual(["service"]);
  });

  it("cancel with an alias requires the alias to be registered on the binding", async () => {
    const config = makeConfig({ bindings: {
      operator: {
        enabled: true, connection: "wecom-airobot", conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }], commands: ["cancel"],
        repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    const cancellation = { cancel: async () => "已取消 1 个任务" };
    const unknown = await processImCommand({
      store, cancellation,
      ...admitInput({ kind: "cancel", repoAlias: "ghost", revision: REPO_SHA.slice(0, 12), beforeMs: undefined }, config),
    });
    expect(unknown.kind).toBe("rejected");
  });

  it("executes cancellation once per delivery across callback pre-persist and redeliveries", async () => {
    const config = makeConfig({ bindings: {
      operator: {
        enabled: true, connection: "wecom-airobot", conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }], commands: ["cancel"],
        repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    let executed = 0;
    const cancellation = { cancel: async () => { executed++; return "已取消 1 个任务"; } };
    const command = { kind: "cancel", repoAlias: "service", revision: REPO_SHA.slice(0, 12), beforeMs: undefined } as const;

    // Callback shape: the route persists the verified delivery BEFORE command
    // handling and reports it created the row (`deliveryDuplicate: false`).
    const callbackKey = { deliveryKey: "msg-callback", payloadDigest: "sha:callback" };
    await acceptImDelivery(store, {
      delivery: { namespace: "ns-cmd", connectionIdentity: "wecom-bot", deliveryKind: "message", ...callbackKey },
      now: new Date(),
    });
    const first = await processImCommand({
      store, cancellation, ...admitInput(command, config, { ...callbackKey, deliveryDuplicate: false }),
    });
    expect(first.kind).toBe("replied");
    expect(executed).toBe(1);

    // A platform redelivery of the same callback reports the duplicate: the
    // cancellation must not run again, but the user still gets an answer.
    const redelivered = await processImCommand({
      store, cancellation, ...admitInput(command, config, { ...callbackKey, deliveryDuplicate: true }),
    });
    expect(redelivered.kind).toBe("duplicate");
    expect(redelivered.replyText).toContain("请勿重复发送");
    expect(executed).toBe(1);

    // Long-connection shape: no pre-persist outcome — the inbox row created by
    // the first attempt is the dedup signal for a redelivered message.
    const streamKey = { deliveryKey: "msg-stream", payloadDigest: "sha:stream" };
    const streamed = await processImCommand({
      store, cancellation, ...admitInput(command, config, streamKey),
    });
    expect(streamed.kind).toBe("replied");
    expect(executed).toBe(2);
    const repeated = await processImCommand({
      store, cancellation, ...admitInput(command, config, streamKey),
    });
    expect(repeated.kind).toBe("duplicate");
    expect(executed).toBe(2);

    // Same delivery key with a different payload is an integrity conflict.
    const conflicted = await processImCommand({
      store, cancellation, ...admitInput(command, config, { deliveryKey: "msg-stream", payloadDigest: "sha:other" }),
    });
    expect(conflicted.kind).toBe("duplicate");
    expect(executed).toBe(2);
  });
});

describe("A15d: wildcard repository aliases", () => {
  const query = {
    answer: async (input: { command: { kind: string } }) => `查询结果:${input.command.kind}`,
    resolveProjectAlias: async (alias: string) => alias === "service"
      ? { workspaceId: "ws-main", sourceTrigger: "github-main", repoRef: "org/service" }
      : undefined,
  };

  it("review resolves unregistered aliases through the projects table when the binding opts in", async () => {
    const config = makeConfig({ bindings: {
      open: {
        enabled: true,
        connection: "wecom-airobot",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }],
        commands: ["review", "detail"],
        allow_all_repositories: true,
      },
    } });
    const review = await processImCommand({ store, query, ...admitInput({ kind: "review", repoAlias: "service", revision: REPO_SHA }, config) });
    expect(review.kind).toBe("accepted");
    // Unknown alias stays unresolvable — no augmentation, strict rejection.
    const unknown = await processImCommand({ store, query, ...admitInput({ kind: "review", repoAlias: "ghost", revision: REPO_SHA }, config) });
    expect(unknown.kind).toBe("rejected");
  });

  it("bindings without the wildcard keep strict alias registration", async () => {
    const config = makeConfig({ bindings: {
      strict: {
        enabled: true,
        connection: "wecom-airobot",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }],
        commands: ["review"],
        repositories: { registered: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    const result = await processImCommand({ store, query, ...admitInput({ kind: "review", repoAlias: "service", revision: REPO_SHA }, config) });
    expect(result.kind).toBe("rejected");
    const registered = await processImCommand({ store, query, ...admitInput({ kind: "review", repoAlias: "registered", revision: REPO_SHA }, config) });
    expect(registered.kind).toBe("accepted");
  });
});

describe("A15e: running reads the database", () => {
  it("deduplicates aliases and excludes queued markers from running", async () => {
    const { insertReviewRun } = await import("@aicr/store");
    const { ImQueryService } = await import("../src/im/query-service.js");
    const config = makeConfig();
    const original = config.im.command_bindings.reviewers!;
    const target = Object.values(original.repositories)[0]!;
    const binding = { ...original, repositories: { a: target, b: target } };
    for (const [id, status] of [["once-active", "analyzing"], ["waiting", "queued"]] as const) {
      await insertReviewRun(store, { id, eventId: id, workspaceId: target.workspace, triggerName: target.source_trigger,
        repoRef: target.repo_ref, provider: "p", providerModel: "m", status, headSha: id });
    }
    const service = new ImQueryService({ store, getConfig: () => config });
    const reply = await service.answer({ command: { kind: "running" }, connectionName: "wecom-airobot", binding });
    expect(reply.split("once-active")).toHaveLength(2);
    expect(reply).not.toContain("waiting");
  });
  it("lists in-flight runs from review_runs and sweeps them as failed", async () => {
    const { insertReviewRun, updateRunStatus, failActiveReviewRuns } = await import("@aicr/store");
    await insertReviewRun(store, {
      id: "run-live-1", eventId: "run-live-1", workspaceId: "ws-main", triggerName: "github-main",
      repoRef: "org/service", provider: "openai", providerModel: "gpt-test",
      status: "analyzing", startedAt: new Date(), headSha: REPO_SHA, branch: "main",
    });
    const { ImQueryService } = await import("../src/im/query-service.js");
    const config = makeConfig();
    const service = new ImQueryService({ store, getConfig: () => config });
    const binding = config.im.command_bindings.reviewers!;
    const reply = await service.answer({ command: { kind: "running" }, connectionName: "wecom-airobot", binding });
    expect(reply).toContain("进行中的评审");
    expect(reply).toContain(REPO_SHA.slice(0, 12));
    // Restart sweep marks in-flight rows failed; running becomes empty.
    expect(await failActiveReviewRuns(store, "interrupted by restart")).toBe(1);
    expect(updateRunStatus).toBeDefined();
    const after = await service.answer({ command: { kind: "running" }, connectionName: "wecom-airobot", binding });
    expect(after).toContain("当前没有进行中的评审");
  });
});

describe("IM query authorization scope", () => {
  it("isolates records with the same workspace and repo by source trigger", async () => {
    const { insertReviewRun, insertWebhookEvent } = await import("@aicr/store");
    const { ImQueryService } = await import("../src/im/query-service.js");
    const config = makeConfig({ bindings: {
      viewer: {
        enabled: true, connection: "wecom-airobot", conversations: [CONV_DIRECT], actors: [{ kind: "any" }],
        commands: ["projects", "reviews", "running", "detail", "prdetail", "commits", "prs"],
        repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    const ownSha = "a".repeat(40);
    const otherSha = "b".repeat(40);
    for (const [id, triggerName, headSha, prId] of [
      ["own-run", "github-main", ownSha, "41"],
      ["other-run", "github-shadow", otherSha, "42"],
    ] as const) {
      await insertReviewRun(store, {
        id, eventId: id, workspaceId: "ws-main", triggerName, repoRef: "org/service",
        provider: "openai", providerModel: "m", status: "analyzing", startedAt: new Date(),
        headSha, targetKind: "pull_request", targetUrl: `https://example.test/org/service/pull/${prId}`,
      });
    }
    for (const targetKind of ["commit", "pull_request"] as const) {
      for (const [triggerName, branch] of [["github-main", "own-branch"], ["github-shadow", "other-branch"]] as const) {
        await insertWebhookEvent(store, {
          decision: "executed", workspaceId: "ws-main", triggerName, repoRef: "org/service",
          targetKind, branch,
        });
      }
    }
    const binding = config.im.command_bindings.viewer!;
    const query = new ImQueryService({ store, getConfig: () => config });
    const answer = (command: Parameters<ImQueryService["answer"]>[0]["command"]) =>
      query.answer({ command, connectionName: "wecom-airobot", binding });
    expect(await answer({ kind: "projects" })).toContain("github-main");
    expect(await answer({ kind: "projects" })).not.toContain("github-shadow");
    for (const command of [{ kind: "reviews", repoAlias: undefined }, { kind: "running" }] as const) {
      const reply = await answer(command);
      expect(reply).toContain(ownSha.slice(0, 12));
      expect(reply).not.toContain(otherSha.slice(0, 12));
    }
    expect(await answer({ kind: "detail", repoAlias: "service", revision: otherSha })).toContain("未找到");
    expect(await answer({ kind: "prdetail", repoAlias: "service", prId: "42" })).toContain("未找到");
    for (const command of [{ kind: "commits", repoAlias: "service", branch: undefined }, { kind: "prs", repoAlias: "service", branch: undefined }] as const) {
      const reply = await answer(command);
      expect(reply).toContain("own-branch");
      expect(reply).not.toContain("other-branch");
    }
  });

  it("keeps broad reviews and running lists inside the authorized binding", async () => {
    const { insertReviewRun } = await import("@aicr/store");
    const { ImQueryService } = await import("../src/im/query-service.js");
    const config = makeConfig({ bindings: {
      viewer: {
        enabled: true, connection: "wecom-airobot", conversations: [CONV_DIRECT], actors: [{ kind: "any" }],
        commands: ["reviews", "running"],
        repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    await insertReviewRun(store, {
      id: "own-run", eventId: "own-run", workspaceId: "ws-main", triggerName: "github-main",
      repoRef: "org/service", provider: "openai", providerModel: "m", status: "analyzing", startedAt: new Date("2026-09-29T10:00:00Z"), headSha: "a".repeat(40),
    });
    await insertReviewRun(store, {
      id: "other-run", eventId: "other-run", workspaceId: "ws-other", triggerName: "github-other",
      repoRef: "secret/private", provider: "openai", providerModel: "m", status: "analyzing", startedAt: new Date("2026-09-29T11:00:00Z"), headSha: "b".repeat(40),
    });
    const query = new ImQueryService({ store, getConfig: () => config });
    for (const command of [{ kind: "reviews", repoAlias: undefined }, { kind: "running" }] as const) {
      const result = await processImCommand({ store, query, ...admitInput(command, config) });
      expect(result.replyText).toContain("org/service");
      expect(result.replyText).not.toContain("secret/private");
    }
    const unknown = await processImCommand({ store, query, ...admitInput({ kind: "reviews", repoAlias: "unknown" }, config) });
    expect(unknown.replyText).toContain("未知的仓库别名");
  });

  it("shows request status only to its original actor and conversation", async () => {
    const config = makeConfig({ bindings: {
      viewer: {
        enabled: true, connection: "wecom-airobot",
        conversations: [CONV_DIRECT, { kind: "group", id: "group-1" }], actors: [{ kind: "any" }],
        commands: ["review", "status"],
        repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
      },
    } });
    const created = await admitImCommand(store, admitInput({ kind: "review", repoAlias: "service", revision: REPO_SHA }, config));
    expect(created.kind).toBe("accepted");
    if (created.kind !== "accepted") return;
    const command = { kind: "status", requestId: created.requestId };
    const owner = await processImCommand({ store, ...admitInput(command, config) });
    expect(owner.replyText).toContain("已收到请求");
    const otherActor = await processImCommand({ store, ...admitInput(command, config, { actor: { type: "wecom_userid", id: "other" } }) });
    expect(otherActor.replyText).toContain("未找到请求");
    const otherConversation = await processImCommand({ store, ...admitInput(command, config, { conversation: { kind: "group", id: "group-1" } }) });
    expect(otherConversation.replyText).toContain("未找到请求");
  });
});

describe("A14: scope matchers and temporary authorization", () => {
  const WECOM_SCOPES: ImActorScopes = {
    wecom: {
      userid: "owent",
      departments: ["10"],
      departmentsClosure: ["10", "2"],
      position: "高级工程师",
      extattr: new Map([["级别", "G5"]]),
      tagIds: ["3"],
    },
  };

  function authorizeWith(actors: Record<string, unknown>[], actorScopes?: ImActorScopes, now = new Date("2026-09-29T12:00:00Z")) {
    const config = makeConfig({ bindings: {
      scoped: {
        enabled: true,
        connection: "wecom-airobot",
        conversations: [{ kind: "bot_direct" }],
        actors,
        commands: ["chat-id", "status"],
      },
    } });
    return authorizeImCommand({
      config, connectionName: "wecom-airobot",
      actor: ACTOR_OWENT, conversation: CONV_DIRECT,
      command: { kind: "chat-id" },
      ...(actorScopes !== undefined ? { actorScopes } : {}),
      now,
    });
  }

  it("authorizes by recursive department closure and fails closed without scopes", () => {
    // Direct department is 10; the closure covers ancestor 2.
    expect(authorizeWith([{ kind: "wecom_department", id: "2" }], WECOM_SCOPES).kind).toBe("authorized");
    expect(authorizeWith([{ kind: "wecom_department", id: "2" }], undefined).kind).toBe("rejected");
  });

  it("non-recursive departments only match direct membership", () => {
    expect(authorizeWith([{ kind: "wecom_department", id: "10", recursive: false }], WECOM_SCOPES).kind).toBe("authorized");
    expect(authorizeWith([{ kind: "wecom_department", id: "2", recursive: false }], WECOM_SCOPES).kind).toBe("rejected");
  });

  it("authorizes by tag, position and custom extattr field", () => {
    expect(authorizeWith([{ kind: "wecom_tag", id: "3" }], WECOM_SCOPES).kind).toBe("authorized");
    expect(authorizeWith([{ kind: "wecom_tag", id: "4" }], WECOM_SCOPES).kind).toBe("rejected");
    expect(authorizeWith([{ kind: "wecom_position", value: "高级工程师" }], WECOM_SCOPES).kind).toBe("authorized");
    expect(authorizeWith([{ kind: "wecom_extattr", name: "级别", value: "G5" }], WECOM_SCOPES).kind).toBe("authorized");
    expect(authorizeWith([{ kind: "wecom_extattr", name: "级别", value: "G6" }], WECOM_SCOPES).kind).toBe("rejected");
  });

  it("any authorizes anyone on the connection; expires_at retires it", () => {
    expect(authorizeWith([{ kind: "any" }]).kind).toBe("authorized");
    expect(authorizeWith([{ kind: "any", expires_at: "2026-09-28T00:00:00Z" }], undefined, new Date("2026-09-29T12:00:00Z")).kind).toBe("rejected");
    expect(authorizeWith([{ kind: "any", expires_at: "2026-10-06T00:00:00Z" }], undefined, new Date("2026-09-29T12:00:00Z")).kind).toBe("authorized");
  });

  it("expired principal matchers stop matching", () => {
    expect(authorizeWith([{ type: "wecom_userid", id: "owent", expires_at: "2026-09-28T00:00:00Z" }]).kind).toBe("rejected");
  });

  it("feishu chat, department and job-title matchers resolve against the feishu scope", () => {
    const config = makeConfig({
      connections: { "feishu-app": { kind: "feishu_app", app_id: "cli_1", app_secret: "s" } },
      bindings: {
        scoped: {
          enabled: true,
          connection: "feishu-app",
          conversations: [{ kind: "app_direct" }],
          actors: [
            { kind: "feishu_chat", chat_id: "oc_reviewers" },
            { kind: "feishu_department", id: "od-9" },
            { kind: "feishu_job_title", value: "后端工程师" },
          ],
          commands: ["chat-id"],
        },
      },
    });
    const scopes: ImActorScopes = { feishu: { openId: "ou_1", departments: ["od-9"], jobTitle: "后端工程师", chats: new Set(["oc_reviewers"]) } };
    const base = { config, connectionName: "feishu-app", actor: { type: "feishu_open_id", id: "ou_1" } as ImPrincipal, conversation: { kind: "app_direct" } as ImConversation, command: { kind: "chat-id" as const }, now: new Date("2026-09-29T12:00:00Z") };
    expect(authorizeImCommand({ ...base, actorScopes: scopes }).kind).toBe("authorized");
    // No directory facts → all three matchers fail closed.
    expect(authorizeImCommand({ ...base }).kind).toBe("rejected");
  });

  it("processImCommand answers chat-id with the identity and status from the store", async () => {
    const config = makeConfig({ bindings: {
      open: {
        enabled: true,
        connection: "wecom-airobot",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }],
        commands: ["chat-id", "status"],
      },
    } });
    const chatId = await processImCommand({ store, ...admitInput({ kind: "chat-id" }, config) });
    expect(chatId.kind).toBe("replied");
    expect(chatId.replyText).toContain("wecom_userid owent");
    expect(chatId.replyText).toContain("bot_direct");

    const status = await processImCommand({ store, ...admitInput({ kind: "status", requestId: "imr-missing" }, config) });
    expect(status.kind).toBe("replied");
    expect(status.replyText).toContain("未找到请求 imr-missing");
  });

  it("processImCommand rejects scope-only bindings when the directory is absent", async () => {
    const config = makeConfig({ bindings: {
      dept: {
        enabled: true,
        connection: "wecom-airobot",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "wecom_department", id: "2" }],
        commands: ["chat-id"],
      },
    } });
    const result = await processImCommand({ store, ...admitInput({ kind: "chat-id" }, config) });
    expect(result.kind).toBe("rejected");
    expect(result.replyText).toContain("no_matching_binding");
  });
});

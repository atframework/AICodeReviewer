import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";

import { ImAuthorizationDirectory } from "../src/im/authorization-directory.js";

/**
 * A14 directory resolution: WeCom snapshots (departments/users/tags) plus
 * the encrypted open_userid conversion (path/101521), and Feishu profile +
 * chat membership — all against fetch stubs, with fail-closed semantics.
 */

function configWith(overrides: { connections?: Record<string, Record<string, unknown>> } = {}): AppConfig {
  return appConfigSchema.parse({
    im: {
      connections: overrides.connections ?? {
        "corp-directory": {
          kind: "wecom_app",
          corp_id: "ww_example",
          agent_id: 1000002,
          app_secret: "dir-secret",
        },
        "wecom-airobot": { kind: "wecom_aibot", corp_id: "ww_example", aibot_id: "bot-1" },
      },
    },
    outputs: { channels: [] },
  });
}

interface RoutedFetch {
  (url: string | URL, init?: RequestInit): Promise<Response>;
  calls: string[];
}

function wecomDirectoryFetch(): RoutedFetch {
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const target = url.toString();
    fetch.calls.push(`${init?.method ?? "GET"} ${target.replace(/access_token=[^&]+/u, "access_token=***")}`);
    const path = target.replace(/^https:\/\/qyapi\.weixin\.qq\.com/u, "").split("?")[0]!;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/cgi-bin/gettoken") return json({ errcode: 0, access_token: "tok", expires_in: 7200 });
    if (path === "/cgi-bin/department/list") {
      return json({ errcode: 0, department: [
        { id: 1, name: "root", parentid: 0 },
        { id: 2, name: "工程部", parentid: 1 },
        { id: 10, name: "后端组", parentid: 2 },
      ] });
    }
    if (path === "/cgi-bin/user/list") {
      return json({ errcode: 0, userlist: [
        {
          userid: "owent", department: [10], position: "高级工程师",
          extattr: [{ type: 0, name: "级别", text: { value: "G5" } }],
        },
      ] });
    }
    if (path === "/cgi-bin/tag/list") return json({ errcode: 0, taglist: [{ tagid: 3, tagname: "评审员" }] });
    if (path === "/cgi-bin/tag/get") return json({ errcode: 0, userlist: [{ userid: "owent" }] });
    if (path === "/cgi-bin/batch/openuserid_to_userid") {
      return json({ errcode: 0, userid_list: [{ open_userid: "encOWENT", userid: "owent" }], invalid_open_userid_list: [] });
    }
    return json({ errcode: -1, errmsg: `unrouted ${path}` });
  };
  fetch.calls = [];
  return fetch;
}

function feishuDirectoryFetch(): RoutedFetch {
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const target = url.toString();
    fetch.calls.push(`${init?.method ?? "GET"} ${target}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (target.includes("/auth/v3/tenant_access_token/internal")) return json({ code: 0, tenant_access_token: "ftok", expire: 7200 });
    if (target.includes("/contact/v3/users/")) {
      return json({ code: 0, data: { user: { open_id: "ou_1", department_ids: ["od-9"], job_title: "后端工程师" } } });
    }
    if (target.includes("/im/v1/chats/")) {
      return json({ code: 0, data: { has_more: false, items: [{ member_id: "ou_1", member_id_type: "open_id" }] } });
    }
    return json({ code: -1, msg: `unrouted ${target}` });
  };
  fetch.calls = [];
  return fetch;
}

describe("A14: WeCom authorization directory", () => {
  let directory: ImAuthorizationDirectory;
  let fetch: RoutedFetch;

  beforeEach(() => {
    fetch = wecomDirectoryFetch();
    directory = new ImAuthorizationDirectory({
      getConfig: configWith,
      env: () => undefined,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
  });
  afterEach(() => {
    directory.dispose();
  });

  it("resolves plaintext userids from the snapshot without the conversion API", async () => {
    directory.start();
    const scopes = await directory.resolve({
      connectionName: "wecom-airobot",
      actor: { type: "wecom_userid", id: "owent" },
      matchers: [{ kind: "wecom_department", id: "2" }],
    });
    expect(scopes?.wecom?.userid).toBe("owent");
    expect(scopes?.wecom?.departments).toEqual(["10"]);
    // Full ancestor chain: 10 → 2 → 1 → 0 (corporate root).
    expect(scopes?.wecom?.departmentsClosure).toEqual(["10", "2", "1", "0"]);
    expect(scopes?.wecom?.position).toBe("高级工程师");
    expect(scopes?.wecom?.extattr.get("级别")).toBe("G5");
    expect(scopes?.wecom?.tagIds).toEqual(["3"]);
    expect(fetch.calls.some(call => call.includes("openuserid_to_userid"))).toBe(false);
  });

  it("converts encrypted open_userids through batch conversion (path/101521)", async () => {
    directory.start();
    const scopes = await directory.resolve({
      connectionName: "wecom-airobot",
      actor: { type: "wecom_encrypted_userid", id: "encOWENT" },
      matchers: [{ kind: "wecom_tag", id: "3" }],
    });
    expect(fetch.calls.some(call => call.includes("openuserid_to_userid"))).toBe(true);
    expect(scopes?.wecom?.userid).toBe("owent");
    expect(scopes?.wecom?.tagIds).toEqual(["3"]);
  });

  it("fails closed when no wecom_app directory connection exists", async () => {
    const directory2 = new ImAuthorizationDirectory({
      getConfig: () => configWith({ connections: { "wecom-airobot": { kind: "wecom_aibot", corp_id: "ww_example", aibot_id: "b" } } }),
      env: () => undefined,
    });
    try {
      const scopes = await directory2.resolve({
        connectionName: "wecom-airobot",
        actor: { type: "wecom_userid", id: "owent" },
        matchers: [{ kind: "wecom_department", id: "2" }],
      });
      expect(scopes?.wecom).toBeUndefined();
    } finally {
      directory2.dispose();
    }
  });

  it("does not authorize an actor with another corporation's directory", async () => {
    const directory2 = new ImAuthorizationDirectory({
      getConfig: () => configWith({ connections: {
        "corp-directory": { kind: "wecom_app", corp_id: "ww_example", agent_id: 1000002, app_secret: "dir-secret" },
        "other-bot": { kind: "wecom_aibot", corp_id: "ww_other", aibot_id: "bot-2" },
      } }),
      env: () => undefined,
      fetch: wecomDirectoryFetch() as unknown as typeof globalThis.fetch,
    });
    try {
      const scopes = await directory2.resolve({ connectionName: "other-bot", actor: { type: "wecom_userid", id: "owent" }, matchers: [{ kind: "wecom_department", id: "2" }] });
      expect(scopes?.wecom).toBeUndefined();
    } finally {
      directory2.dispose();
    }
  });
});

describe("A14: Feishu authorization directory", () => {
  it("resolves profile departments and chat membership", async () => {
    const fetch = feishuDirectoryFetch();
    const directory = new ImAuthorizationDirectory({
      getConfig: () => configWith({ connections: { "feishu-app": { kind: "feishu_app", app_id: "cli_1", app_secret: "s" } } }),
      env: () => undefined,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    try {
      const scopes = await directory.resolve({
        connectionName: "feishu-app",
        actor: { type: "feishu_open_id", id: "ou_1" },
        matchers: [
          { kind: "feishu_chat", chat_id: "oc_reviewers" },
          { kind: "feishu_department", id: "od-9" },
        ],
      });
      expect(scopes?.feishu?.departments).toEqual(["od-9"]);
      expect(scopes?.feishu?.jobTitle).toBe("后端工程师");
      expect(scopes?.feishu?.chats.has("oc_reviewers")).toBe(true);
    } finally {
      directory.dispose();
    }
  });

  it("uses the receiving application and isolates profile caches across applications", async () => {
    const requestedAppIds: string[] = [];
    const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (target.includes("tenant_access_token/internal")) {
        const body = JSON.parse(String(init?.body)) as { app_id: string };
        requestedAppIds.push(body.app_id);
        return json({ code: 0, tenant_access_token: body.app_id, expire: 7200 });
      }
      if (target.includes("/contact/v3/users/")) {
        const appId = init?.headers && new Headers(init.headers).get("authorization")?.replace("Bearer ", "");
        return json({ code: 0, data: { user: { open_id: "ou_same", department_ids: [appId === "cli_b" ? "dept-b" : "dept-a"] } } });
      }
      return json({ code: -1 });
    };
    const directory = new ImAuthorizationDirectory({
      getConfig: () => configWith({ connections: {
        "app-a": { kind: "feishu_app", app_id: "cli_a", app_secret: "secret-a" },
        "app-b": { kind: "feishu_app", app_id: "cli_b", app_secret: "secret-b" },
      } }),
      env: () => undefined,
      fetch: fetch as typeof globalThis.fetch,
    });
    try {
      const input = { actor: { type: "feishu_open_id" as const, id: "ou_same" }, matchers: [{ kind: "feishu_department" as const, id: "dept-b" }] };
      expect((await directory.resolve({ ...input, connectionName: "app-a" }))?.feishu?.departments).toEqual(["dept-a"]);
      expect((await directory.resolve({ ...input, connectionName: "app-b" }))?.feishu?.departments).toEqual(["dept-b"]);
      expect(requestedAppIds).toEqual(["cli_a", "cli_b"]);
    } finally {
      directory.dispose();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeishuAppClient, createFeishuAppDispatcher, resolveFeishuMention, type FetchLike } from "../src/index.js";

const prefix = "AICR_FEISHU_TEST_";
const enabled = Object.keys(process.env).some(key => key.startsWith(prefix));

describe.skipIf(!enabled)("Feishu application tenant acceptance", () => {
  let client: FeishuAppClient;
  let receiveId: string;
  let directoryId: string;
  let token: string | undefined;
  const messages = new Set<string>();
  const warnings = new Set<string>();
  const request: FetchLike = async (url, init) => {
    const response = await globalThis.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    // Observe the actual production client's response for cleanup; never replace it.
    const body = await response.clone().json() as {
      tenant_access_token?: string; data?: { message_id?: string };
    };
    if (url.endsWith("/tenant_access_token/internal") && typeof body.tenant_access_token === "string") {
      token = body.tenant_access_token;
    }
    if (url.includes("/im/v1/messages?") && typeof body.data?.message_id === "string") messages.add(body.data.message_id);
    return response;
  };

  beforeAll(() => {
    const appId = process.env[`${prefix}APP_ID`];
    const appSecret = process.env[`${prefix}APP_SECRET`];
    const destination = process.env[`${prefix}RECEIVE_ID`];
    if (!appId || !appSecret || !destination) {
      throw new Error("AICR_FEISHU_TEST_APP_ID, APP_SECRET and RECEIVE_ID are required together.");
    }
    if (!/^oc_[A-Za-z0-9_-]+$/u.test(destination)) throw new Error("Feishu acceptance requires a test group chat ID.");
    receiveId = destination;
    directoryId = process.env[`${prefix}DIRECTORY_CHAT_ID`] ?? receiveId;
    client = new FeishuAppClient({ appId, appSecret, fetch: request, onDirectoryWarning: code => warnings.add(code) });
  });

  it("reads the group's real member directory without logging profiles", async () => {
    const members = await client.members(directoryId);
    console.info(JSON.stringify({ members: members.length, warnings: [...warnings],
      visibleEmails: members.filter(member => member.email || member.enterprise_email).length,
      visibleNames: members.filter(member => member.name).length }));
    expect(members.length).toBeGreaterThan(0);
    expect(warnings.has("profiles_unavailable"), "Contact profile permissions/data scope must be accepted separately if unavailable.").toBe(false);
    // Inspect booleans only, so a failed assertion cannot print directory identities.
    expect(members.every(member => /^ou_[A-Za-z0-9_-]+$/u.test(member.open_id))).toBe(true);
  }, 80_000);

  it("publishes one JSON 2.0 review card through the real dispatcher", async () => {
    const mentionId = process.env[`${prefix}MENTION_OPEN_ID`];
    let mention: string | undefined;
    if (mentionId) {
      if (!/^ou_[A-Za-z0-9_-]+$/u.test(mentionId)) throw new Error("Invalid test mention ID.");
      const members = await client.members(directoryId);
      expect(members.some(member => member.open_id === mentionId), "Explicit mention target must belong to the source group.").toBe(true);
      mention = resolveFeishuMention({ author: { username: mentionId } }, members);
      expect(mention === `<at id="${mentionId}"></at>`).toBe(true);
    }
    const result = await createFeishuAppDispatcher({ client, receiveId }).publishAggregatedProblems([],
      "AICR 本地验收：这是一条合成测试卡片，测试结束后自动撤回。", mention);
    expect(result.status).toBe("published");
    expect(typeof result.externalId === "string" && messages.has(result.externalId)).toBe(true);
  }, 90_000);

  afterAll(async () => {
    const failures: string[] = [];
    for (const id of messages) {
      try {
        const response = await globalThis.fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(id)}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
          redirect: "error", signal: AbortSignal.timeout(15_000),
        });
        const body = await response.json() as { code?: number };
        if (!response.ok || body.code !== 0) failures.push(`HTTP ${response.status}, code ${body.code ?? "unknown"}`);
      } catch { failures.push("transport/response error"); }
    }
    token = undefined;
    if (failures.length) throw new Error(`Feishu test card recall failed: ${failures.join("; ")}`);
    if (messages.size) console.info(`Feishu cleanup: recalled ${messages.size} test card(s).`);
  }, 30_000);
});

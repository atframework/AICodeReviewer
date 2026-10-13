import { expect, it, vi } from "vitest";
import { registerSocialIm } from "../../../scripts/register-social-im.mjs";
const reply = (body: unknown) => new Response(JSON.stringify(body));
it("generates an offline Socket Mode manifest without an HTTP slash URL", async () => {
  const result = await registerSocialIm(["--platform", "slack", "--slack-mode", "socket"]);
  expect(result.manifest.settings).toEqual({socket_mode_enabled: true});
  expect(result.manifest.features.slash_commands[0]).not.toHaveProperty("url");
  const http = await registerSocialIm(["--platform", "slack", "--callback-url", "https://example.org/callbacks/im/bot"]);
  expect(http.manifest.settings).toEqual({socket_mode_enabled: false});
});
it("keeps every registration dry-run offline and excludes credential values", async () => {
  const fetch = vi.fn(() => {
    throw new Error("offline");
  });
  for (const argv of [
    [
      "--platform",
      "slack",
      "--callback-url",
      "https://example.org/callbacks/im/bot",
    ],
    [
      "--platform",
      "discord",
      "--application-id",
      "123",
      "--guild-id",
      "456",
      "--token-env",
      "BOT_TOKEN",
    ],
    [
      "--platform",
      "telegram",
      "--bot-id",
      "123",
      "--token-env",
      "BOT_TOKEN",
      "--secret-env",
      "SECRET",
      "--callback-url",
      "https://example.org/callbacks/im/bot",
    ],
  ])
    expect(
      JSON.stringify(
        await registerSocialIm(argv, {
          fetch,
          env: { BOT_TOKEN: "secret-value", SECRET: "webhook-value" },
        }),
      ),
    ).not.toContain("secret-value");
  expect(fetch).not.toHaveBeenCalled();
});
it("updates only the guild aicr command and preserves unrelated commands", async () => {
  const calls: { url: string; method: string }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method! });
    if (url.endsWith("@me")) return reply({ id: "123" });
    if (init.method === "GET")
      return reply([
        { id: "789", name: "aicr", type: 1 },
        { id: "777", name: "other", type: 1 },
      ]);
    return reply({ id: "789", name: "aicr", type: 1 });
  });
  expect(
    await registerSocialIm(
      [
        "--platform",
        "discord",
        "--application-id",
        "123",
        "--guild-id",
        "456",
        "--token-env",
        "BOT_TOKEN",
        "--apply",
      ],
      { fetch, env: { BOT_TOKEN: "test-token" } },
    ),
  ).toMatchObject({ mode: "applied", command_id: "789" });
  expect(calls.at(-1)).toEqual({
    url: "https://discord.com/api/v10/applications/123/guilds/456/commands/789",
    method: "PATCH",
  });
  expect(
    calls.some((call) => call.method === "PUT" || call.method === "DELETE"),
  ).toBe(false);
});
it("rejects Telegram webhook ownership conflicts without any remote write", async () => {
  const fetch = vi.fn(async (url: string) =>
    reply(
      url.endsWith("getMe")
        ? { ok: true, result: { id: 123, is_bot: true } }
        : { ok: true, result: { url: "https://other.example/hook" } },
    ),
  );
  await expect(
    registerSocialIm(
      [
        "--platform",
        "telegram",
        "--bot-id",
        "123",
        "--token-env",
        "BOT_TOKEN",
        "--secret-env",
        "SECRET",
        "--callback-url",
        "https://example.org/callbacks/im/bot",
        "--apply",
      ],
      { fetch, env: { BOT_TOKEN: "123:test-token", SECRET: "webhook-secret" } },
    ),
  ).rejects.toThrow("Another webhook");
  expect(fetch).toHaveBeenCalledTimes(2);
});

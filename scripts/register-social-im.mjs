import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const discordCommand = {
  name: "aicr",
  description: "AICodeReviewer commands",
  type: 1,
  options: [
    {
      name: "command",
      description:
        "help | chat-id | review <alias> <revision> | status <request-id>",
      type: 3,
      required: true,
      max_length: 2048,
    },
  ],
};

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--apply") {
      options.apply = true;
      continue;
    }
    if (
      ![
        "--platform",
        "--callback-url",
        "--application-id",
        "--guild-id",
        "--bot-id",
        "--token-env",
        "--secret-env",
        "--slack-mode",
      ].includes(name) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--") ||
      options[name] !== undefined
    )
      throw new Error("Invalid registration arguments.");
    options[name] = argv[++i];
  }
  return options;
}
function requireId(value) {
  if (!/^[1-9][0-9]{0,31}$/u.test(value ?? ""))
    throw new Error("A decimal string identity is required.");
  return value;
}
function envName(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value ?? ""))
    throw new Error("A credential environment variable name is required.");
  return value;
}
function callbackUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "An HTTPS callback URL without credentials/query/fragment is required.",
    );
  return url.href;
}
export function slackManifest(url, socketMode = false) {
  return {
    display_information: { name: "AICodeReviewer" },
    features: {
      bot_user: { display_name: "AICodeReviewer", always_online: false },
      slash_commands: [
        {
          command: "/aicr",
          description: "Review a fixed revision or query its status",
          ...(socketMode ? {} : { url }),
          usage_hint:
            "help | chat-id | review <alias> <revision> | status <request-id>",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: ["chat:write", "channels:read", "groups:read", "commands"],
      },
    },
    settings: { socket_mode_enabled: socketMode },
  };
}

/** Dry-run is pure. Apply makes at most three reads and one write, with no automatic retry. */
export async function registerSocialIm(
  argv,
  { fetch = globalThis.fetch, env = process.env } = {},
) {
  const opts = parse(argv);
  const platform = opts["--platform"];
  if (!["slack", "discord", "telegram"].includes(platform))
    throw new Error("Choose --platform slack|discord|telegram.");
  if (platform === "slack") {
    const mode = opts["--slack-mode"] ?? "http";
    if (!["http", "socket"].includes(mode))
      throw new Error("Choose --slack-mode http|socket.");
    if (opts.apply)
      throw new Error(
        "Import the reviewed manifest in Slack's application console.",
      );
    return {
      mode: "dry-run",
      manifest: slackManifest(
        mode === "socket" ? undefined : callbackUrl(opts["--callback-url"]),
        mode === "socket",
      ),
    };
  }
  const tokenEnv = envName(opts["--token-env"]);
  const app =
    platform === "discord"
      ? requireId(opts["--application-id"])
      : requireId(opts["--bot-id"]);
  const guild =
    platform === "discord" ? requireId(opts["--guild-id"]) : undefined;
  const secretEnv =
    platform === "telegram" ? envName(opts["--secret-env"]) : undefined;
  const url =
    platform === "telegram" ? callbackUrl(opts["--callback-url"]) : undefined;
  if (!opts.apply)
    return {
      mode: "dry-run",
      platform,
      token_env: tokenEnv,
      ...(platform === "discord"
        ? { application_id: app, guild_id: guild, command: discordCommand }
        : {
            bot_id: app,
            url,
            secret_env: secretEnv,
            allowed_updates: ["message"],
            drop_pending_updates: false,
          }),
    };
  const token = env[tokenEnv];
  if (
    !token ||
    /[\s/\\?#]/u.test(token) ||
    (platform === "telegram" && !/^[1-9][0-9]*:[A-Za-z0-9_-]+$/u.test(token))
  )
    throw new Error("Registration credential is missing or invalid.");
  const origin =
    platform === "discord"
      ? "https://discord.com/api/v10"
      : "https://api.telegram.org/bot" + token;
  async function request(path, method = "GET", body) {
    let response;
    try {
      response = await fetch(origin + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(platform === "discord" ? { Authorization: "Bot " + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(
        method === "GET"
          ? "Registration read failed."
          : "Registration result unknown. Inspect remote state before applying again.",
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Registration response invalid; inspect remote state.");
    }
    if (!response.ok || (platform === "telegram" && data.ok !== true))
      throw new Error(
        "Registration rejected; inspect remote state before applying again.",
      );
    return data;
  }
  if (platform === "discord") {
    const identity = await request("/oauth2/applications/@me");
    if (identity.id !== app) throw new Error("Application identity mismatch.");
    const path = "/applications/" + app + "/guilds/" + guild + "/commands";
    const commands = await request(path);
    if (!Array.isArray(commands))
      throw new Error("Command inventory response invalid.");
    const existing = commands.filter(
      (command) => command.name === "aicr" && command.type === 1,
    );
    if (existing.length > 1) throw new Error("Ambiguous command inventory.");
    if (existing.length && !/^[1-9][0-9]{0,31}$/u.test(existing[0].id))
      throw new Error("Command id invalid.");
    const result = await request(
      existing.length ? path + "/" + existing[0].id : path,
      existing.length ? "PATCH" : "POST",
      discordCommand,
    );
    if (
      result.name !== "aicr" ||
      result.type !== 1 ||
      !/^[1-9][0-9]{0,31}$/u.test(result.id)
    )
      throw new Error("Registration receipt invalid; inspect remote state.");
    return {
      mode: "applied",
      platform,
      command_id: result.id,
      guild_id: guild,
    };
  }
  const secret = env[secretEnv];
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(secret ?? ""))
    throw new Error("Webhook secret missing or invalid.");
  const bot = await request("/getMe");
  if (
    !Number.isSafeInteger(bot.result?.id) ||
    String(bot.result.id) !== app ||
    bot.result.is_bot !== true
  )
    throw new Error("Bot identity mismatch.");
  const current = await request("/getWebhookInfo");
  if (typeof current.result?.url !== "string")
    throw new Error("Webhook inventory response invalid.");
  if (current.result.url && current.result.url !== url)
    throw new Error(
      "Another webhook owns this Bot. Resolve ownership before registration.",
    );
  const result = await request("/setWebhook", "POST", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  if (result.result !== true)
    throw new Error(
      "Webhook registration receipt invalid; inspect remote state.",
    );
  return { mode: "applied", platform, bot_id: app, url };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(await registerSocialIm(process.argv.slice(2)), null, 2),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Registration failed.",
    );
    process.exitCode = 1;
  }
}

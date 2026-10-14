import type { ChannelUser } from "./channel-identity.js";
import type { SocialImConnection } from "./social-im.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (...values: unknown[]): string[] => values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
const invalid = (): never => { throw new Error("Social IM directory unavailable or incomplete."); };
const MAX_MEMBERS = 10_000;

/** Complete, bounded snapshots only. Directory access never grants command authorization. */
export async function loadSocialImDirectory(
  connection: SocialImConnection,
  destination: string,
  read: (path: string) => Promise<unknown>,
): Promise<readonly ChannelUser[]> {
  if (connection.kind === "telegram_bot") return invalid();
  const users: ChannelUser[] = [];
  const seen = new Set<string>();
  if (connection.kind === "slack_app") {
    const pages = async (method: string): Promise<unknown[]> => {
      const members: unknown[] = [];
      const cursors = new Set<string>();
      let cursor = "";
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ limit: "200", ...(method === "conversations.members" ? { channel: destination } : {}), ...(cursor ? { cursor } : {}) });
        const raw = record(await read(`${method}?${query}`));
        if (raw.ok !== true || !Array.isArray(raw.members)) return invalid();
        members.push(...raw.members);
        if (members.length > MAX_MEMBERS) return invalid();
        const next = record(raw.response_metadata).next_cursor;
        if (next !== undefined && typeof next !== "string") return invalid();
        if (!next) {
          if (raw.has_more === true) return invalid();
          return members;
        }
        if (cursors.has(next)) return invalid();
        cursors.add(next);
        cursor = next;
      }
      return invalid();
    };
    const memberIds = await pages("conversations.members");
    if (memberIds.some(id => typeof id !== "string" || !/^[UW][A-Z0-9]{1,63}$/u.test(id))) return invalid();
    const members = new Set(memberIds as string[]);
    for (const item of await pages("users.list")) {
      const user = record(item);
      if (typeof user.id !== "string") return invalid();
      if (!members.has(user.id)) continue;
      if (seen.has(user.id)) return invalid();
      seen.add(user.id);
      if (user.deleted === true || user.is_bot === true || user.id === connection.bot_user_id) continue;
      const profile = record(user.profile);
      users.push({ id: user.id, names: strings(profile.real_name, user.real_name),
        aliases: strings(user.name, profile.display_name), emails: strings(profile.email), identifiers: [] });
    }
    // Slack Connect members absent from users.list cannot form a complete identity snapshot.
    if ([...members].some(id => !seen.has(id))) return invalid();
    return users;
  }
  let after = "0";
  for (let page = 0; page < 100; page++) {
    const rows = await read(`guilds/${encodeURIComponent(connection.guild_id)}/members?limit=1000&after=${after}`);
    if (!Array.isArray(rows) || rows.length > 1000 || seen.size + rows.length > MAX_MEMBERS) return invalid();
    let highest = BigInt(after);
    for (const row of rows) {
      const member = record(row);
      const user = record(member.user);
      if (typeof user.id !== "string" || !/^[1-9][0-9]{0,31}$/u.test(user.id) || BigInt(user.id) <= BigInt(after) || seen.has(user.id)) return invalid();
      seen.add(user.id);
      if (BigInt(user.id) > highest) highest = BigInt(user.id);
      if (user.bot === true || member.pending === true) continue;
      users.push({ id: user.id, names: strings(user.global_name, member.nick),
        aliases: strings(user.username), emails: [], identifiers: [] });
    }
    if (rows.length < 1000) return users;
    after = String(highest);
  }
  return invalid();
}

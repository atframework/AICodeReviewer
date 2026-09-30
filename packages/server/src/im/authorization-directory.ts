import type { AppConfig, ImActorScopes, ImBindingActor, ImPrincipal } from "@aicr/core";
import { FeishuAppClient, WeComAppClient } from "@aicr/outputs";

/**
 * Authorization directory (scope-matcher resolution, design §6 A05): resolves
 * one authenticated actor into corporate-directory facts from cached
 * snapshots — never from per-message API walks.
 *
 * - WeCom: departments/positions/extattr from `user/list`, tags from
 *   `tag/list`+`tag/get`, snapshotted against the first enabled `wecom_app`
 *   connection (sorted by name; deterministic). The smart robot's encrypted
 *   open_userid converts via batch/openuserid_to_userid (path/101521) with a
 *   long-lived cache. Snapshots refresh in the background (`start()`); the
 *   request path only reads memory or awaits an in-flight refresh.
 * - Feishu: user profile (departments, job title) and chat membership through
 *   the application's own client (both TTL-cached per identity).
 *
 * Any failure leaves the section undefined — scope matchers fail closed.
 */

const SNAPSHOT_TTL_MS = 300_000;
const IDENTITY_TTL_MS = 3_600_000;
const CONVERSION_CACHE_LIMIT = 2_000;

export interface ImAuthorizationDirectoryOptions {
  readonly getConfig: () => Promise<AppConfig> | AppConfig;
  readonly env: (name: string) => string | undefined;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly snapshotTtlMs?: number;
  readonly identityTtlMs?: number;
}

interface WecomUserFacts {
  readonly departments: readonly string[];
  readonly departmentsClosure: readonly string[];
  readonly position: string | undefined;
  readonly extattr: ReadonlyMap<string, string>;
}

interface WecomSnapshot {
  readonly users: ReadonlyMap<string, WecomUserFacts>;
  /** tagId → member plaintext userids. */
  readonly tags: ReadonlyMap<string, ReadonlySet<string>>;
}

export class ImAuthorizationDirectory {
  private readonly options: ImAuthorizationDirectoryOptions;
  private readonly now: () => number;
  private wecomSnapshot: { readonly key: string; readonly data: WecomSnapshot; readonly expiresAt: number } | undefined;
  private wecomPending: Promise<WecomSnapshot | undefined> | undefined;
  private readonly openUseridCache = new Map<string, { readonly userid: string | undefined; readonly expiresAt: number }>();
  private readonly feishuProfileCache = new Map<string, { readonly data: { readonly departments: readonly string[]; readonly jobTitle: string | undefined } | undefined; readonly expiresAt: number }>();
  private readonly feishuClients = new Map<string, FeishuAppClient>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(options: ImAuthorizationDirectoryOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  /** Background refresh loop; warms the WeCom snapshot immediately. */
  start(): void {
    if (this.timer !== undefined || this.disposed) return;
    void this.refreshWecom();
    this.timer = setInterval(() => {
      void this.refreshWecom();
    }, this.options.snapshotTtlMs ?? SNAPSHOT_TTL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.wecomSnapshot = undefined;
    this.wecomPending = undefined;
    this.openUseridCache.clear();
    this.feishuProfileCache.clear();
    this.feishuClients.clear();
  }

  /**
   * Resolves directory facts for the given matchers. Returns undefined
   * sections when no matcher needs them or resolution fails (fail closed).
   */
  async resolve(input: {
    readonly connectionName: string;
    readonly actor: ImPrincipal;
    readonly matchers: readonly ImBindingActor[];
  }): Promise<ImActorScopes | undefined> {
    if (this.disposed) return undefined;
    const needsWecom = input.matchers.some(matcher => "kind" in matcher && matcher.kind.startsWith("wecom_"));
    const needsFeishu = input.matchers.some(matcher => "kind" in matcher && matcher.kind.startsWith("feishu_"));
    if (!needsWecom && !needsFeishu) return undefined;

    const scopes: { wecom?: ImActorScopes["wecom"]; feishu?: ImActorScopes["feishu"] } = {};
    if (needsWecom) scopes.wecom = await this.resolveWecom(input.actor);
    if (needsFeishu) {
      const chats = input.matchers
        .filter((matcher): matcher is Extract<ImBindingActor, { readonly kind: "feishu_chat" }> => "kind" in matcher && matcher.kind === "feishu_chat")
        .map(matcher => matcher.chat_id);
      scopes.feishu = await this.resolveFeishu(input.actor, chats);
    }
    return { ...scopes };
  }

  // ---------------------------------------------------------------------------
  // WeCom
  // ---------------------------------------------------------------------------

  private directoryConnection(config: AppConfig): { corpId: string; agentId: number; appSecret: string } | undefined {
    const entries = Object.entries(config.im?.connections ?? {})
      .filter(([, connection]) => connection.kind === "wecom_app" && connection.enabled !== false)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [, connection] of entries) {
      if (connection.kind !== "wecom_app") continue;
      const appSecret = connection.app_secret
        ?? (connection.app_secret_env !== undefined ? this.options.env(connection.app_secret_env) : undefined)
        ?? "";
      if (!appSecret) continue;
      return { corpId: connection.corp_id, agentId: connection.agent_id, appSecret };
    }
    return undefined;
  }

  private async refreshWecom(): Promise<void> {
    try {
      await this.wecomSnapshotData();
    } catch (error) {
      console.warn(JSON.stringify({ msg: "im_directory_wecom_refresh_failed", error: String(error) }));
    }
  }

  private async wecomSnapshotData(): Promise<WecomSnapshot | undefined> {
    const config = await this.options.getConfig();
    const directory = this.directoryConnection(config);
    if (directory === undefined) return undefined;
    const key = `${directory.corpId}:${directory.agentId}`;
    const ttl = this.options.snapshotTtlMs ?? SNAPSHOT_TTL_MS;
    if (this.wecomSnapshot?.key === key && this.wecomSnapshot.expiresAt > this.now()) return this.wecomSnapshot.data;
    if (this.wecomPending !== undefined) return this.wecomPending;
    this.wecomPending = this.buildWecomSnapshot(directory, key, ttl);
    try {
      return await this.wecomPending;
    } finally {
      this.wecomPending = undefined;
    }
  }

  private async buildWecomSnapshot(directory: { corpId: string; agentId: number; appSecret: string }, key: string, ttl: number): Promise<WecomSnapshot | undefined> {
    const client = new WeComAppClient({
      corpId: directory.corpId,
      agentId: directory.agentId,
      appSecret: directory.appSecret,
      ...(this.options.fetch ? { fetch: (url, init) => this.options.fetch!(url, init) } : {}),
    });
    const [departments, users, tags] = await Promise.all([
      client.directoryDepartments().catch(() => []),
      client.directoryUserDetails(1, true),
      client.directoryTags().catch(() => []),
    ]);
    const parents = new Map<string, string | undefined>();
    for (const department of departments) parents.set(String(department.id), department.parentId === undefined ? undefined : String(department.parentId));

    const userFacts = new Map<string, WecomUserFacts>();
    for (const user of users) {
      const direct = user.departments.map(String);
      const closure = new Set(direct);
      for (const id of direct) {
        let current = parents.get(id);
        let guard = 0;
        while (current !== undefined && !closure.has(current) && guard < 32) {
          closure.add(current);
          current = parents.get(current);
          guard += 1;
        }
      }
      userFacts.set(user.userid, { departments: direct, departmentsClosure: [...closure], position: user.position, extattr: user.extattr });
    }

    const tagMembers = new Map<string, ReadonlySet<string>>();
    for (const tag of tags) {
      const members = await client.directoryTagMembers(tag.id).catch(() => []);
      tagMembers.set(String(tag.id), new Set(members));
    }

    const snapshot: WecomSnapshot = { users: userFacts, tags: tagMembers };
    this.wecomSnapshot = { key, data: snapshot, expiresAt: this.now() + ttl };
    console.log(JSON.stringify({ msg: "im_directory_wecom_snapshot", users: userFacts.size, tags: tagMembers.size, departments: departments.length }));
    return snapshot;
  }

  private wecomClient(directory: { corpId: string; agentId: number; appSecret: string }): WeComAppClient {
    return new WeComAppClient({
      corpId: directory.corpId,
      agentId: directory.agentId,
      appSecret: directory.appSecret,
      ...(this.options.fetch ? { fetch: (url, init) => this.options.fetch!(url, init) } : {}),
    });
  }

  private async plaintextUserid(client: WeComAppClient, actor: ImPrincipal): Promise<string | undefined> {
    const ttl = this.options.identityTtlMs ?? IDENTITY_TTL_MS;
    const cached = this.openUseridCache.get(actor.id);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.userid;
    // The aibot's encrypted ids only resolve through the batch conversion;
    // the API reports already-plaintext values as invalid (then the actor is
    // simply not in the app-visible directory).
    try {
      const { converted } = await client.convertOpenUserIds([actor.id]);
      const userid = converted.get(actor.id);
      if (this.openUseridCache.size >= CONVERSION_CACHE_LIMIT) {
        const oldest = this.openUseridCache.keys().next().value;
        if (oldest !== undefined) this.openUseridCache.delete(oldest);
      }
      this.openUseridCache.set(actor.id, { userid, expiresAt: this.now() + ttl });
      return userid;
    } catch (error) {
      console.warn(JSON.stringify({ msg: "im_directory_wecom_convert_failed", error: String(error) }));
      return undefined;
    }
  }

  private async resolveWecom(actor: ImPrincipal): Promise<ImActorScopes["wecom"]> {
    if (actor.type !== "wecom_userid" && actor.type !== "wecom_encrypted_userid") return undefined;
    const snapshot = await this.wecomSnapshotData();
    if (snapshot === undefined) return undefined;
    // Plaintext ids present in the snapshot skip the conversion API entirely.
    let userid: string | undefined = snapshot.users.has(actor.id) ? actor.id : undefined;
    if (userid === undefined) {
      const config = await this.options.getConfig();
      const directory = this.directoryConnection(config);
      if (directory === undefined) return undefined;
      userid = await this.plaintextUserid(this.wecomClient(directory), actor);
      if (userid === undefined || !snapshot.users.has(userid)) return undefined;
    }
    const facts = snapshot.users.get(userid)!;
    const tagIds: string[] = [];
    for (const [tagId, members] of snapshot.tags) {
      if (members.has(userid)) tagIds.push(tagId);
    }
    return {
      userid,
      departments: facts.departments,
      departmentsClosure: facts.departmentsClosure,
      position: facts.position,
      extattr: facts.extattr,
      tagIds,
    };
  }

  // ---------------------------------------------------------------------------
  // Feishu
  // ---------------------------------------------------------------------------

  private feishuClient(config: AppConfig, connectionName: string): FeishuAppClient | undefined {
    const connection = config.im?.connections?.[connectionName];
    if (connection === undefined || connection.kind !== "feishu_app" || connection.enabled === false) return undefined;
    const appSecret = connection.app_secret
      ?? (connection.app_secret_env !== undefined ? this.options.env(connection.app_secret_env) : undefined)
      ?? "";
    if (!appSecret) return undefined;
    const key = `${connectionName}:${connection.app_id}`;
    const cached = this.feishuClients.get(key);
    if (cached !== undefined) return cached;
    const client = new FeishuAppClient({
      appId: connection.app_id,
      appSecret,
      ...(connection.base_url ? { baseUrl: connection.base_url } : {}),
      ...(this.options.fetch ? { fetch: (url, init) => this.options.fetch!(url, init) } : {}),
    });
    this.feishuClients.set(key, client);
    return client;
  }

  private async resolveFeishu(actor: ImPrincipal, chatIds: readonly string[]): Promise<ImActorScopes["feishu"]> {
    if (actor.type !== "feishu_open_id" || actor.id === "") return undefined;
    const config = await this.options.getConfig();
    const client = this.feishuClient(config, this.connectionForFeishu(config));
    if (client === undefined) return undefined;

    const ttl = this.options.identityTtlMs ?? IDENTITY_TTL_MS;
    let profile = this.feishuProfileCache.get(actor.id);
    if (profile === undefined || profile.expiresAt <= this.now()) {
      const data = await client.userProfile(actor.id).catch((error: unknown) => {
        console.warn(JSON.stringify({ msg: "im_directory_feishu_profile_failed", error: String(error) }));
        return undefined;
      });
      profile = { data, expiresAt: this.now() + ttl };
      this.feishuProfileCache.set(actor.id, profile);
    }

    const chats = new Set<string>();
    for (const chatId of [...new Set(chatIds)]) {
      const members = await client.members(chatId, 300).catch((error: unknown) => {
        console.warn(JSON.stringify({ msg: "im_directory_feishu_chat_failed", chatId, error: String(error) }));
        return undefined;
      });
      if (members === undefined) continue;
      if (members.some(member => member.open_id === actor.id)) chats.add(chatId);
    }
    if (profile.data === undefined && chats.size === 0) return undefined;
    return { openId: actor.id, departments: profile.data?.departments ?? [], jobTitle: profile.data?.jobTitle, chats };
  }

  private connectionForFeishu(config: AppConfig): string {
    // The binding's connection owns the directory; resolve() receives the
    // connection name but scope sections are per-tenant — use the first
    // enabled feishu_app connection deterministically, mirroring wecom.
    const entries = Object.entries(config.im?.connections ?? {})
      .filter(([, connection]) => connection.kind === "feishu_app" && connection.enabled !== false)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries[0]?.[0] ?? "";
  }
}

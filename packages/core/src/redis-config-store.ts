/**
 * Redis ConfigStore — immutable configuration generations behind a CAS head
 * pointer per namespace (spec §4.3/§9.3, P2).
 *
 * Key layout (single-instance Redis 7.0+; every multi-key command stays in
 * one cluster slot through `{...}` hash tags; `P` = configurable prefix,
 * default `aicr:config:`):
 * - `{ns}:head`        HASH   active_revision, generation (CAS pointer, S11)
 * - `{ns}:rev:{n}`     STRING immutable ConfigRevisionRecord JSON
 * - `{ns}:rev:z`       ZSET   score=revision (newest-first pagination)
 * - `{ns}:op:{opId}`   STRING revision number (retry dedupe + lookup, S03)
 * - `{ns}:audit:{id}`  STRING audit JSON; `{ns}:audit:z` ZSET score=timestamp
 * - `{snap}:rec:{id}`  HASH   snapshot record; `{snap}:gc:{ns}` ZSET created_at
 * - `{bind}:rec:{id}`  HASH;  `{bind}:all` SET; `{bind}:root:{root}` STRING
 * - `{sess}:rec:{h}`   STRING JSON + PEXPIREAT; `{sess}:z` ZSET expiresAt
 *
 * Snapshots, bindings, and sessions sit under fixed hash tags rather than a
 * config-namespace tag: their contract methods address records by id or
 * token hash only (readSnapshot(id), readAdminSession(hash)), and binding
 * records carry no namespace at all, so a per-namespace tag would leave no
 * key to read them back through.
 *
 * Every multi-step mutation is a Lua script, not WATCH/MULTI — the same
 * reason redis-auto-commit-store.ts is all-Lua: one ioredis connection is
 * shared by interleaved logical operations, and on a shared connection one
 * EXEC discards another operation's WATCH, silently voiding the CAS (S02).
 * Lua keeps check-and-set atomic inside a single hash-tag slot. Redis
 * transactions never roll back (spec §9.3), so scripts validate first and
 * write last.
 */

import { randomUUID } from "node:crypto";

import { ConfigError } from "./config-format.js";
import type {
  ConfigAuditRecord,
  ConfigHeadState,
  ConfigRevisionRecord,
  ConfigRuntimeSnapshotRecord,
  ConfigStore,
  WorkspaceBindingRecord,
  WorkspaceBindingState,
} from "./config-store.js";
import {
  assertNamespace,
  assertStoreOpen,
  contentHashOf,
  sameConfigOperation,
  sameSnapshotContent,
  copyConfigValue,
} from "./config-store.js";

export interface RedisConfigStoreOptions {
  readonly connection: {
    readonly url?: string;
    readonly host?: string;
    readonly port?: number;
    readonly password?: string;
    readonly db?: number;
    readonly tls?: boolean;
  };
  /** Prefix for every config key; default "aicr:config:". */
  readonly prefix?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

// Dynamic import: ioredis is an optionalDependency that is absent unless the
// Redis backend is configured; a static import would crash other backends at
// module load (same pattern as redis-auto-commit-store.ts).
async function loadIoredis(): Promise<unknown> {
  try {
    return await import("ioredis");
  } catch (error) {
    throw new ConfigError(
      "store_unavailable",
      "ioredis is not installed; the Redis config store requires it (pnpm add ioredis).",
      { cause: error },
    );
  }
}

function buildRedisConnection(
  options: RedisConfigStoreOptions["connection"],
): Record<string, unknown> {
  return {
    host: options.host ?? "localhost",
    port: options.port ?? 6379,
    ...(options.password ? { password: options.password } : {}),
    ...(options.db !== undefined ? { db: options.db } : {}),
    ...(options.tls ? { tls: {} } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lua scripts (Redis Lua 5.1 subset: no continue/goto, redis.call only).
// ---------------------------------------------------------------------------

// A Lua runtime error does not undo earlier writes. Validate every index
// type before the first mutation, including indexes used only at the end.
const LUA_VALIDATE_TYPES = `
local function requireType(key, expected)
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expected then
    error('WRONGTYPE config store key must be ' .. expected)
  end
end
`;

// Atomic changeset commit: dedupe the operationId, validate the CAS base,
// then write revision + operation index + audit and move the head. KEYS:
// 1=head, 2=rev:z, 3=op:{operationId}, 4=rev:{n}, 5=audit:{id}, 6=audit:z.
// ARGV: 1=baseRevision ('' = expect empty namespace), 2=revision JSON,
// 3=audit JSON, 4=timestamp, 5=audit id. The next revision number n is
// derived from the head inside the script (active + 1) — never trusted
// from an ARGV — so a head that moved after the caller numbered its
// revision is a revision_conflict, never a renumbered overwrite of a newer
// revision (S02/S04). The CAS pins baseRevision == active, so KEYS[4]
// names exactly this n. Returns {'op', revision, active, generation} |
// {'conflict', active, generation} | {'committed', n, generation}.
const LUA_COMMIT = `
${LUA_VALIDATE_TYPES}
requireType(KEYS[1], 'hash')
requireType(KEYS[2], 'zset')
requireType(KEYS[3], 'string')
requireType(KEYS[4], 'string')
requireType(KEYS[5], 'string')
requireType(KEYS[6], 'zset')
local active = redis.call('HGET', KEYS[1], 'active_revision')
local generation = redis.call('HGET', KEYS[1], 'generation') or '0'
local opRevision = redis.call('GET', KEYS[3])
if opRevision then
  return {'op', opRevision, active or '0', generation}
end
if active then
  if ARGV[1] == '' or ARGV[1] ~= active then
    return {'conflict', active, generation}
  end
elseif ARGV[1] ~= '' then
  return {'conflict', '0', '0'}
end
local n = tonumber(active or '0') + 1
if not string.match(generation, '^%d+$') or (#generation > 1 and string.sub(generation, 1, 1) == '0')
  or #generation > 19 or (#generation == 19 and generation >= '9223372036854775807') then
  error('Invalid or exhausted config generation')
end
if not n or n > 9007199254740991 or n % 1 ~= 0 then
  error('Invalid or exhausted config revision')
end
local revision = string.format('%.0f', n)
redis.call('SET', KEYS[4], ARGV[2])
redis.call('ZADD', KEYS[2], n, revision)
redis.call('SET', KEYS[3], revision)
redis.call('SET', KEYS[5], ARGV[3])
redis.call('ZADD', KEYS[6], tonumber(ARGV[4]), ARGV[5])
redis.call('HSET', KEYS[1], 'active_revision', revision)
redis.call('HINCRBY', KEYS[1], 'generation', 1)
return {'committed', revision, redis.call('HGET', KEYS[1], 'generation')}
`;

// Idempotent snapshot write. KEYS: 1=snap:rec:{id}, 2=snap:gc:{namespace}.
// ARGV: id, contentHash, namespace, fileDigest JSON, databaseRevision,
// resolverVersion, config JSON, createdAt. Returns 1 created | 0 duplicate |
// -1 conflicting id.
const LUA_WRITE_SNAPSHOT = `
${LUA_VALIDATE_TYPES}
requireType(KEYS[1], 'hash')
requireType(KEYS[2], 'zset')
local existing = redis.call('HGET', KEYS[1], 'content_hash')
if existing then
  if existing == ARGV[2] then
    return 0
  end
  return -1
end
redis.call('HSET', KEYS[1],
  'id', ARGV[1],
  'content_hash', ARGV[2],
  'namespace', ARGV[3],
  'file_digest', ARGV[4],
  'database_revision', ARGV[5],
  'resolver_version', ARGV[6],
  'config', ARGV[7],
  'created_at', ARGV[8],
  'pinned', '0',
  'ref_count', '0')
redis.call('ZADD', KEYS[2], tonumber(ARGV[8]), ARGV[1])
return 1
`;

// Clamped refcount adjustment (never below zero). KEYS: 1=snap:rec:{id}.
// ARGV: delta. Returns the new count, or nil when the snapshot is unknown.
const LUA_ADJUST_SNAPSHOT_REFCOUNT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return nil
end
local current = tonumber(redis.call('HGET', KEYS[1], 'ref_count') or '0') or 0
local updated = current + tonumber(ARGV[1])
if updated < 0 then
  updated = 0
end
redis.call('HSET', KEYS[1], 'ref_count', tostring(updated))
return updated
`;

// Durable pin/unpin. KEYS: 1=snap:rec:{id}. ARGV: '1' | '0'.
const LUA_SET_SNAPSHOT_PINNED = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return nil
end
redis.call('HSET', KEYS[1], 'pinned', ARGV[1])
return 1
`;

// GC delete that refuses referenced records. KEYS: 1=snap:rec:{id},
// 2=snap:gc:{namespace}. ARGV: id. Returns 1 deleted | 0 already gone |
// -1 still referenced.
const LUA_DELETE_SNAPSHOT = `
${LUA_VALIDATE_TYPES}
requireType(KEYS[1], 'hash')
requireType(KEYS[2], 'zset')
local pinned = redis.call('HGET', KEYS[1], 'pinned')
if not pinned then
  return 0
end
local refs = tonumber(redis.call('HGET', KEYS[1], 'ref_count') or '0') or 0
if pinned == '1' or refs > 0 then
  return -1
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

// Binding upsert with root uniqueness (S08). KEYS: 1=bind:rec:{instanceId},
// 2=bind:root:{relativeRoot}, 3=bind:all. ARGV: instanceId, relativeRoot,
// definitionId, canonicalProjectKey, layoutVersion, now.
const LUA_UPSERT_BINDING = `
${LUA_VALIDATE_TYPES}
requireType(KEYS[1], 'hash')
requireType(KEYS[2], 'string')
requireType(KEYS[3], 'set')
local existingRoot = redis.call('HGET', KEYS[1], 'relative_root')
if existingRoot then
  if existingRoot ~= ARGV[2] then
    return {'conflict_instance', existingRoot}
  end
  redis.call('HSET', KEYS[1],
    'definition_id', ARGV[3],
    'canonical_project_key', ARGV[4],
    'layout_version', ARGV[5],
    'last_seen_at', ARGV[6])
  local createdAt = redis.call('HGET', KEYS[1], 'created_at')
  local state = redis.call('HGET', KEYS[1], 'state')
  return {'updated', createdAt, state}
end
local owner = redis.call('GET', KEYS[2])
if owner then
  return {'conflict_root', owner}
end
redis.call('HSET', KEYS[1],
  'instance_id', ARGV[1],
  'relative_root', ARGV[2],
  'definition_id', ARGV[3],
  'canonical_project_key', ARGV[4],
  'layout_version', ARGV[5],
  'created_at', ARGV[6],
  'last_seen_at', ARGV[6],
  'state', 'active')
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
return {'created'}
`;

// KEYS: 1=bind:rec:{instanceId}. ARGV: state, now.
const LUA_SET_BINDING_STATE = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return nil
end
redis.call('HSET', KEYS[1], 'state', ARGV[1], 'last_seen_at', ARGV[2])
return 1
`;

// Bounded purge of expired sessions. KEYS: 1=sess:z. ARGV: now, limit,
// record key prefix (same hash tag, so constructed keys share the slot).
const LUA_PURGE_SESSIONS = `
local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, member in ipairs(members) do
  redis.call('DEL', ARGV[3] .. member)
end
if #members > 0 then
  redis.call('ZREM', KEYS[1], unpack(members))
end
return #members
`;

// ---------------------------------------------------------------------------
// Stored-shape helpers
// ---------------------------------------------------------------------------

function toSnapshot(fields: Record<string, string>): ConfigRuntimeSnapshotRecord {
  return {
    id: fields.id ?? "",
    namespace: fields.namespace ?? "",
    fileDigest: JSON.parse(fields.file_digest ?? "null") as string | null,
    databaseRevision: Number(fields.database_revision ?? "0"),
    resolverVersion: Number(fields.resolver_version ?? "0"),
    sanitizedEffectiveConfig: JSON.parse(fields.config ?? "null"),
    contentHash: fields.content_hash ?? "",
    createdAt: Number(fields.created_at ?? "0"),
    pinned: fields.pinned === "1",
    refCount: Number(fields.ref_count ?? "0"),
  };
}

function toBinding(fields: Record<string, string>): WorkspaceBindingRecord {
  return {
    instanceId: fields.instance_id ?? "",
    definitionId: fields.definition_id ?? "",
    canonicalProjectKey: fields.canonical_project_key ?? "",
    layoutVersion: Number(fields.layout_version ?? "0"),
    relativeRoot: fields.relative_root ?? "",
    createdAt: Number(fields.created_at ?? "0"),
    lastSeenAt: Number(fields.last_seen_at ?? "0"),
    state: (fields.state === "disabled" ? "disabled" : "active") as WorkspaceBindingState,
  };
}

export async function createRedisConfigStore(
  options: RedisConfigStoreOptions,
): Promise<ConfigStore> {
  const mod = (await loadIoredis()) as {
    Redis?: new (...args: unknown[]) => RedisClient;
  } & (new (...args: unknown[]) => RedisClient);
  const RedisCtor = mod.Redis ?? mod;
  const connectionOptions = { connectTimeout: 5000, maxRetriesPerRequest: 2 };
  // Let ioredis decode ACL credentials and enable TLS for rediss://.
  const redis: RedisClient = options.connection.url
    ? new RedisCtor(options.connection.url, connectionOptions)
    : new RedisCtor({ ...buildRedisConnection(options.connection), ...connectionOptions });
  const P = options.prefix ?? "aicr:config:";

  let closed = false;
  const open = (): void => assertStoreOpen(closed, "redis");

  /** Validates a config namespace for hash-tag use and returns its key tag. */
  function keyNamespace(namespace: string): string {
    assertNamespace(namespace);
    if (namespace.includes("{") || namespace.includes("}")) {
      throw new ConfigError(
        "store_unavailable",
        `Config namespace must not contain "{" or "}" (Redis hash tag); got ${JSON.stringify(namespace)}.`,
      );
    }
    return `${P}{${namespace}}:`;
  }

  /** Maps driver/connection failures to bounded ConfigErrors; never swallows. */
  async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(
        "store_unavailable",
        `Redis config store ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async function evalScript(
    script: string,
    keys: readonly string[],
    ...args: (string | number)[]
  ): Promise<unknown> {
    return redis.eval(script, keys.length, ...keys, ...args.map((arg) => String(arg)));
  }

  async function getJson<T>(key: string): Promise<T | null> {
    const data = (await redis.get(key)) as string | null;
    return data === null ? null : (JSON.parse(data) as T);
  }

  async function hgetallTyped(key: string): Promise<Record<string, string>> {
    return (await redis.hgetall(key)) as Record<string, string>;
  }

  function checkExec(results: [Error | null, unknown][] | null): void {
    if (results === null) return; // plain MULTI (no WATCH) never aborts
    for (const [error] of results) {
      if (error) throw error;
    }
  }

  const snapRecKey = (id: string) => `${P}{snap}:rec:${id}`;
  const snapGcKey = (namespace: string) => `${P}{snap}:gc:${namespace}`;
  const bindRecKey = (id: string) => `${P}{bind}:rec:${id}`;
  const bindRootKey = (root: string) => `${P}{bind}:root:${root}`;
  const BIND_ALL_KEY = `${P}{bind}:all`;
  const sessRecKey = (hash: string) => `${P}{sess}:rec:${hash}`;
  const SESS_Z_KEY = `${P}{sess}:z`;

  async function readSnapshotFields(id: string): Promise<Record<string, string> | null> {
    const fields = await hgetallTyped(snapRecKey(id));
    return Object.keys(fields).length === 0 ? null : fields;
  }

  async function readHeadInternal(tag: string, namespace: string): Promise<ConfigHeadState | null> {
    const fields = await hgetallTyped(`${tag}head`);
    if (fields.active_revision === undefined) return null;
    return {
      namespace,
      activeRevision: Number(fields.active_revision),
      generation: String(fields.generation ?? "0"),
    };
  }

  return {
    backendKind: "redis",

    async readHead(namespace) {
      open();
      const tag = keyNamespace(namespace);
      return guarded("readHead", () => readHeadInternal(tag, namespace));
    },

    async readRevision(namespace, revision) {
      open();
      const tag = keyNamespace(namespace);
      return guarded("readRevision", () =>
        getJson<ConfigRevisionRecord>(`${tag}rev:${revision}`));
    },

    async listRevisions(namespace, options = {}) {
      open();
      const tag = keyNamespace(namespace);
      return guarded("listRevisions", async () => {
        const max = options.before === undefined ? "+inf" : `(${options.before}`;
        const args: (string | number)[] = options.limit === undefined
          ? [max, "-inf"]
          : [max, "-inf", "LIMIT", 0, options.limit];
        const members = (await redis.zrevrangebyscore(`${tag}rev:z`, ...args)) as string[];
        const records: ConfigRevisionRecord[] = [];
        if (members.length > 0) {
          const rows = (await redis
            .pipeline(members.map((member) => ["get", `${tag}rev:${member}`]))
            .exec()) as [Error | null, string | null][];
          for (const [error, value] of rows) {
            if (error) throw error;
            if (value !== null) records.push(JSON.parse(value) as ConfigRevisionRecord);
          }
        }
        return records;
      });
    },

    async readOperation(namespace, operationId) {
      open();
      const tag = keyNamespace(namespace);
      return guarded("readOperation", async () => {
        const revision = (await redis.get(`${tag}op:${operationId}`)) as string | null;
        if (revision === null) return null;
        return getJson<ConfigRevisionRecord>(`${tag}rev:${revision}`);
      });
    },

    async commitChangeset(input) {
      open();
      const tag = keyNamespace(input.namespace);
      return guarded("commitChangeset", async () => {
        // The revision number follows from the CAS base by definition: the
        // script commits only when the head still equals baseRevision and
        // derives the same n = active + 1 atomically from the head itself,
        // so no stale pre-read can renumber or overwrite a newer revision.
        const expectedBase = input.baseRevision;
        const n = expectedBase === null ? 1 : expectedBase + 1;

        const revision: ConfigRevisionRecord = {
          namespace: input.namespace,
          revision: n,
          parentRevision: expectedBase,
          formatVersion: input.formatVersion,
          document: copyConfigValue(input.document),
          contentHash: contentHashOf(input.document),
          fileDigest: input.fileDigest,
          createdAt: input.now,
          actor: input.actor,
          operationId: input.operationId,
        };
        const auditId = `audit-${randomUUID()}`;
        const audit: ConfigAuditRecord = {
          ...input.audit,
          entityRefs: [...input.audit.entityRefs],
          redactedDiff: copyConfigValue(input.audit.redactedDiff),
          namespace: input.namespace,
          id: auditId,
          operationId: input.operationId,
          beforeRevision: expectedBase,
          afterRevision: n,
          actor: input.actor,
          timestamp: input.now,
        };

        const reply = (await evalScript(
          LUA_COMMIT,
          [
            `${tag}head`,
            `${tag}rev:z`,
            `${tag}op:${input.operationId}`,
            `${tag}rev:${n}`,
            `${tag}audit:${auditId}`,
            `${tag}audit:z`,
          ],
          input.baseRevision === null ? "" : input.baseRevision,
          JSON.stringify(revision),
          JSON.stringify(audit),
          input.now,
          auditId,
        )) as unknown[];
        const kind = String(reply[0]);

        if (kind === "op") {
          // Dedupe precedes base validation (S03): a retry carrying the
          // original baseRevision must fold into the committed revision.
          const stored = await getJson<ConfigRevisionRecord>(`${tag}rev:${String(reply[1])}`);
          if (stored === null) {
            throw new ConfigError(
              "store_unavailable",
              `Operation "${input.operationId}" indexes missing revision ${String(reply[1])} (namespace "${input.namespace}").`,
            );
          }
          if (sameConfigOperation(stored, input)) {
            return {
              status: "committed" as const,
              revision: stored,
              head: {
                namespace: input.namespace,
                activeRevision: Number(reply[2]),
                generation: String(reply[3]),
              },
              duplicate: true,
            };
          }
          throw new ConfigError(
            "operation_conflict",
            `Operation "${input.operationId}" was already committed with different content (namespace "${input.namespace}").`,
          );
        }
        if (kind === "conflict") {
          return {
            status: "revision_conflict" as const,
            head: {
              namespace: input.namespace,
              activeRevision: Number(reply[1]),
              generation: String(reply[2]),
            },
          };
        }
        return {
          status: "committed" as const,
          revision,
          head: {
            namespace: input.namespace,
            activeRevision: Number(reply[1]),
            generation: String(reply[2]),
          },
          duplicate: false,
        };
      });
    },

    async readAudit(namespace, options = {}) {
      open();
      const tag = keyNamespace(namespace);
      return guarded("readAudit", async () => {
        const ids = options.beforeTimestamp === undefined
          ? ((await redis.zrange(`${tag}audit:z`, 0, -1)) as string[])
          : ((await redis.zrevrangebyscore(
              `${tag}audit:z`,
              `(${options.beforeTimestamp}`,
              "-inf",
            )) as string[]);
        const records: ConfigAuditRecord[] = [];
        if (ids.length > 0) {
          const rows = (await redis
            .pipeline(ids.map((id) => ["get", `${tag}audit:${id}`]))
            .exec()) as [Error | null, string | null][];
          for (const [error, value] of rows) {
            if (error) throw error;
            if (value !== null) records.push(JSON.parse(value) as ConfigAuditRecord);
          }
        }
        const filtered = records
          .filter((entry) => options.operationId === undefined || entry.operationId === options.operationId)
          .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
        return options.limit === undefined ? filtered : filtered.slice(0, options.limit);
      });
    },

    async writeSnapshot(input) {
      open();
      keyNamespace(input.namespace); // validates the namespace used in the GC key
      return guarded("writeSnapshot", async () => {
        const result = (await evalScript(
          LUA_WRITE_SNAPSHOT,
          [snapRecKey(input.id), snapGcKey(input.namespace)],
          input.id,
          input.contentHash,
          input.namespace,
          JSON.stringify(input.fileDigest),
          input.databaseRevision,
          input.resolverVersion,
          JSON.stringify(input.sanitizedEffectiveConfig ?? null),
          input.now,
        )) as number;
        if (result === -1) {
          throw new ConfigError(
            "snapshot_invalid",
            `Snapshot "${input.id}" already exists with different content.`,
          );
        }
        const fields = await readSnapshotFields(input.id);
        if (fields === null) {
          throw new ConfigError(
            "store_unavailable",
            `Snapshot "${input.id}" vanished immediately after write.`,
          );
        }
        const snapshot = toSnapshot(fields);
        if (!sameSnapshotContent(snapshot, input)) throw new ConfigError("snapshot_invalid", `Snapshot "${input.id}" already exists with different content.`);
        return snapshot;
      });
    },

    async readSnapshot(id) {
      open();
      return guarded("readSnapshot", async () => {
        const fields = await readSnapshotFields(id);
        return fields === null ? null : toSnapshot(fields);
      });
    },

    async adjustSnapshotRefCount(id, delta) {
      open();
      return guarded("adjustSnapshotRefCount", async () => {
        const updated = (await evalScript(
          LUA_ADJUST_SNAPSHOT_REFCOUNT,
          [snapRecKey(id)],
          delta,
        )) as number | null;
        if (updated === null) return null;
        const fields = await readSnapshotFields(id);
        return fields === null ? null : toSnapshot(fields);
      });
    },

    async setSnapshotPinned(id, pinned) {
      open();
      return guarded("setSnapshotPinned", async () => {
        const updated = (await evalScript(
          LUA_SET_SNAPSHOT_PINNED,
          [snapRecKey(id)],
          pinned ? "1" : "0",
        )) as number | null;
        if (updated === null) return null;
        const fields = await readSnapshotFields(id);
        return fields === null ? null : toSnapshot(fields);
      });
    },

    async listUnreferencedSnapshots(namespace, olderThan, limit = 100) {
      open();
      keyNamespace(namespace); // validates the namespace used in the GC key
      return guarded("listUnreferencedSnapshots", async () => {
        const ids = (await redis.zrangebyscore(
          snapGcKey(namespace),
          "-inf",
          olderThan,
        )) as string[];
        const result: ConfigRuntimeSnapshotRecord[] = [];
        if (ids.length > 0) {
          const rows = (await redis
            .pipeline(ids.map((id) => ["hgetall", snapRecKey(id)]))
            .exec()) as [Error | null, Record<string, string>][];
          for (const [error, fields] of rows) {
            if (error) throw error;
            if (fields === null || Object.keys(fields).length === 0) continue;
            const record = toSnapshot(fields);
            if (!record.pinned && record.refCount === 0 && record.createdAt <= olderThan) {
              result.push(record);
            }
          }
        }
        result.sort((a, b) => a.createdAt - b.createdAt);
        return result.slice(0, limit);
      });
    },

    async deleteSnapshot(id) {
      open();
      return guarded("deleteSnapshot", async () => {
        const namespace = (await redis.hget(snapRecKey(id), "namespace")) as string | null;
        if (namespace === null) return; // already gone; delete is idempotent
        const result = (await evalScript(
          LUA_DELETE_SNAPSHOT,
          [snapRecKey(id), snapGcKey(namespace)],
          id,
        )) as number;
        if (result === -1) {
          throw new ConfigError(
            "snapshot_invalid",
            `Snapshot "${id}" is still referenced and cannot be deleted.`,
          );
        }
      });
    },

    async upsertWorkspaceBinding(input) {
      open();
      return guarded("upsertWorkspaceBinding", async () => {
        const reply = (await evalScript(
          LUA_UPSERT_BINDING,
          [bindRecKey(input.instanceId), bindRootKey(input.relativeRoot), BIND_ALL_KEY],
          input.instanceId,
          input.relativeRoot,
          input.definitionId,
          input.canonicalProjectKey,
          input.layoutVersion,
          input.now,
        )) as unknown[];
        const kind = String(reply[0]);
        if (kind === "conflict_instance") {
          throw new ConfigError(
            "binding_conflict",
            `Binding "${input.instanceId}" already owns root "${String(reply[1])}".`,
          );
        }
        if (kind === "conflict_root") {
          throw new ConfigError(
            "binding_conflict",
            `Root "${input.relativeRoot}" is already owned by binding "${String(reply[1])}" (S08).`,
          );
        }
        const created = kind === "created";
        return {
          instanceId: input.instanceId,
          definitionId: input.definitionId,
          canonicalProjectKey: input.canonicalProjectKey,
          layoutVersion: input.layoutVersion,
          relativeRoot: input.relativeRoot,
          createdAt: created ? input.now : Number(reply[1]),
          lastSeenAt: input.now,
          state: (created ? "active" : String(reply[2])) as WorkspaceBindingState,
        };
      });
    },

    async readWorkspaceBinding(instanceId) {
      open();
      return guarded("readWorkspaceBinding", async () => {
        const fields = await hgetallTyped(bindRecKey(instanceId));
        return Object.keys(fields).length === 0 ? null : toBinding(fields);
      });
    },

    async listWorkspaceBindings(namespace) {
      // Bindings are deployment-global (the record carries no namespace),
      // matching the memory backend; the parameter exists for backends that
      // can scope them.
      void namespace;
      open();
      return guarded("listWorkspaceBindings", async () => {
        const ids = (await redis.smembers(BIND_ALL_KEY)) as string[];
        const result: WorkspaceBindingRecord[] = [];
        if (ids.length > 0) {
          const rows = (await redis
            .pipeline(ids.map((id) => ["hgetall", bindRecKey(id)]))
            .exec()) as [Error | null, Record<string, string>][];
          for (const [error, fields] of rows) {
            if (error) throw error;
            if (fields !== null && Object.keys(fields).length > 0) {
              result.push(toBinding(fields));
            }
          }
        }
        result.sort((a, b) => a.createdAt - b.createdAt);
        return result;
      });
    },

    async setWorkspaceBindingState(instanceId, state, now) {
      open();
      return guarded("setWorkspaceBindingState", async () => {
        const updated = (await evalScript(
          LUA_SET_BINDING_STATE,
          [bindRecKey(instanceId)],
          state,
          now,
        )) as number | null;
        if (updated === null) return null;
        const fields = await hgetallTyped(bindRecKey(instanceId));
        return Object.keys(fields).length === 0 ? null : toBinding(fields);
      });
    },

    async saveAdminSession(record) {
      open();
      return guarded("saveAdminSession", async () => {
        // Absolute expiry: no wall clock read anywhere; an already-expired
        // record is deleted by PEXPIREAT as soon as it lands (S12).
        const results = (await redis
          .multi()
          .set(
            sessRecKey(record.tokenHash),
            JSON.stringify({
              tokenHash: record.tokenHash,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
            }),
          )
          .pexpireat(sessRecKey(record.tokenHash), record.expiresAt)
          .zadd(SESS_Z_KEY, record.expiresAt, record.tokenHash)
          .exec()) as [Error | null, unknown][] | null;
        checkExec(results);
      });
    },

    async readAdminSession(tokenHash, now) {
      open();
      return guarded("readAdminSession", async () => {
        const data = (await redis.get(sessRecKey(tokenHash))) as string | null;
        if (data === null) return null;
        const parsed = JSON.parse(data) as {
          tokenHash: string;
          createdAt: number;
          expiresAt: number;
        };
        if (parsed.expiresAt <= now) return null;
        return {
          tokenHash: parsed.tokenHash,
          createdAt: parsed.createdAt,
          expiresAt: parsed.expiresAt,
        };
      });
    },

    async deleteAdminSession(tokenHash) {
      open();
      return guarded("deleteAdminSession", async () => {
        // Revocation lands in the same MULTI as the index removal, so every
        // replica observing this backend sees the logout immediately (S12).
        const results = (await redis
          .multi()
          .del(sessRecKey(tokenHash))
          .zrem(SESS_Z_KEY, tokenHash)
          .exec()) as [Error | null, unknown][] | null;
        checkExec(results);
      });
    },

    async deleteExpiredAdminSessions(now, limit = 500) {
      open();
      return guarded("deleteExpiredAdminSessions", async () => {
        const removed = (await evalScript(
          LUA_PURGE_SESSIONS,
          [SESS_Z_KEY],
          now,
          limit,
          `${P}{sess}:rec:`,
        )) as number;
        return Number(removed);
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      try { await (redis.quit() as Promise<unknown>).catch(() => undefined); }
      finally { redis.disconnect(); }
    },
  };
}

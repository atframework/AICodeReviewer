/**
 * Redis AutoCommitStore — durable scheduling truth in AICR-owned keys.
 *
 * Key layout (namespace `<keyPrefix>ac:`, BullMQ private keys untouched):
 * - `ctr:receiptSeq` / `ctr:fairnessSeq`       string counters (INCR)
 * - `receipt:<id>`                              hash: data = receipt JSON
 * - `receipt:<id>:members`                      zset (score 0, lex) of member ids
 * - `delivery:<deliveryKey>`                    string → receipt id (idempotency)
 * - `member:<id>`                               hash: data = { record, coverSeq } JSON
 * - `member:<id>:receipts`                      zset (score 0, lex) of receipt ids
 * - `stream:<id>`                               hash: data = StreamHead JSON
 * - `stream:<id>:receipts`                      zset score=receiptSeq → receipt id
 * - `stream:<id>:elig`                          zset score=eligibility → receipt id
 *                                               (unexpanded receipts only)
 * - `stream:<id>:memberElig`                    zset score=eligibleAt → member id
 *                                               (pending members only)
 * - `stream:<id>:pending`                       zset (score 0, lex) pending sort keys
 * - `ws:<id>`                                   hash: data = WorkspaceHead JSON
 * - `ws:<id>:streamNb`                          zset score=notBefore → stream id
 * - `ws:<id>:streamNull`                        zset (score 0, lex) streams with null notBefore
 * - `idx:ws:notBefore`                          zset score=notBefore → workspace id
 * - `batch:<id>`                                hash: data = batch JSON, status, rnb
 * - `outbox:<id>`                               hash: data, claimToken, claimExpiry
 * - `idx:outbox`                                zset score=nextAttemptAt → batch id (pending)
 * - `idx:lease`                                 zset score=leaseExpiry → batch id (running)
 *
 * Atomicity: every read-modify-write mutation (receipt acceptance, metadata
 * page upsert, exclusion verdicts, reservations, head updates, sealing,
 * dispatch claim/confirm/abort, execution lease lifecycle, reclaim) is a
 * single EVAL script, so the whole check-and-write is atomic on the Redis
 * command timeline. Scripts are bounded: batch members ≤ 50, metadata page
 * members ≤ 256, claim/reclaim fan-out ≤ caller limit, and every loop iterates
 * a caller-supplied page — never a full keyspace scan.
 *
 * notBefore maintenance mirrors the memory reference exactly but computes the
 * minima through the sorted-set indexes above (O(log n) reads) instead of
 * iterating stream records.
 */

import { randomUUID } from "node:crypto";
import { mergeSourceEvidence } from "./auto-commit-store.js";

import {
  AUTO_COMMIT_BATCH_LIMITS,
  computeMemberId,
  computeStreamId,
} from "./auto-commit-identity.js";
import type {
  AcceptReceiptInput,
  AcceptReceiptResult,
  AcceptRoutingReceiptInput,
  AcceptRoutingReceiptResult,
  FrozenScopeResolution,
  ApplyMetadataPageInput,
  ApplyMetadataPageResult,
  AutoCommitReceipt,
  AutoCommitStore,
  BatchCompletion,
  BatchExecutionCheckpoint,
  ClaimedDispatch,
  CommitBatchRecord,
  CommitMemberRecord,
  MemberExclusionState,
  NextWake,
  Page,
  ReceiptQueryResult,
  RoutingReceiptRecord,
  SealBatchInput,
  SealBatchResult,
  StreamHead,
  StreamHeadUpdate,
  StreamReservation,
  WorkspaceHead,
} from "./auto-commit-store.js";

export interface RedisAutoCommitStoreOptions {
  readonly connection: {
    readonly url?: string;
    readonly host?: string;
    readonly port?: number;
    readonly password?: string;
    readonly db?: number;
    readonly tls?: boolean;
  };
  readonly keyPrefix?: string;
}

/** Cap on claim candidates fetched per scan (bounded fan-out). */
const CLAIM_SCAN_MULTIPLIER = 4;
const CLAIM_SCAN_CAP = 256;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

// Dynamic import: ioredis is an optionalDependency that is absent unless the
// Redis backend is configured; a static import would crash other backends at
// module load (same pattern as redis-queue.ts's loadBullMq).
async function loadIoredis(): Promise<unknown> {
  try {
    return await import("ioredis");
  } catch {
    throw new Error(
      "ioredis is not installed. Install it with: pnpm add ioredis\n" +
        "Redis auto-commit store requires the ioredis package.",
    );
  }
}

function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: Number(parsed.port) || 6379,
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.pathname && parsed.pathname !== "/"
      ? { db: Number(parsed.pathname.slice(1)) }
      : {}),
  };
}

function buildRedisConnection(
  options: RedisAutoCommitStoreOptions["connection"],
): Record<string, unknown> {
  if (options.url) {
    return parseRedisUrl(options.url);
  }
  return {
    host: options.host ?? "localhost",
    port: options.port ?? 6379,
    ...(options.password ? { password: options.password } : {}),
    ...(options.db !== undefined ? { db: options.db } : {}),
    ...(options.tls ? { tls: {} } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lua scripts (Redis Lua 5.1 subset: no continue/goto, redis.call, cjson).
// ---------------------------------------------------------------------------

const LUA_PRELUDE = `
local P = ARGV[1]
pcall(function() cjson.encode_number_precision(17) end)
local DISPATCH_CLAIM_TTL_MS = 30000
local function kReceipt(id) return P.."receipt:"..id end
local function kReceiptMembers(id) return P.."receipt:"..id..":members" end
local function kDelivery(dk) return P.."delivery:"..dk end
local function kMember(id) return P.."member:"..id end
local function kMemberReceipts(id) return P.."member:"..id..":receipts" end
local function kStream(id) return P.."stream:"..id end
local function kStreamReceipts(id) return P.."stream:"..id..":receipts" end
local function kStreamElig(id) return P.."stream:"..id..":elig" end
local function kStreamMemberElig(id) return P.."stream:"..id..":memberElig" end
local function kStreamPending(id) return P.."stream:"..id..":pending" end
local function kWs(id) return P.."ws:"..id end
local function kWsStreamNb(id) return P.."ws:"..id..":streamNb" end
local function kWsStreamNull(id) return P.."ws:"..id..":streamNull" end
local function kBatch(id) return P.."batch:"..id end
local function kOutbox(id) return P.."outbox:"..id end
local K_CTR_RECEIPT = P.."ctr:receiptSeq"
local K_CTR_FAIR = P.."ctr:fairnessSeq"
local K_IDX_WS_NB = P.."idx:ws:notBefore"
local K_IDX_OUTBOX = P.."idx:outbox"
local K_IDX_LEASE = P.."idx:lease"
local K_IDX_RUNNING = P.."idx:running"
local function kRouting(id) return P.."routing:"..id end
local function kRoutingKey(key) return P.."routingkey:"..key end
local K_IDX_ROUTING_DUE = P.."idx:routing:due"
local function kWsRunning(ws) return P.."ws:"..ws..":running" end
local function isNull(v) return v == nil or v == cjson.null end
local function pendingSortKey(rec)
  if isNull(rec.orderKey) then return "0"..rec.memberId end
  return "1"..rec.orderKey..string.char(0)..rec.memberId
end
local function indexStream(ws, sid, nb)
  if nb == nil then
    redis.call("ZREM", kWsStreamNb(ws), sid)
    redis.call("ZADD", kWsStreamNull(ws), 0, sid)
  else
    redis.call("ZADD", kWsStreamNb(ws), nb, sid)
    redis.call("ZREM", kWsStreamNull(ws), sid)
  end
end
local function wsRecompute(ws)
  local wdata = redis.call("HGET", kWs(ws), "data")
  if not wdata then return end
  local whead = cjson.decode(wdata)
  local m = redis.call("ZRANGE", kWsStreamNb(ws), 0, 0, "WITHSCORES")
  if #m >= 2 then
    local nb = tonumber(m[2])
    whead.notBefore = nb
    redis.call("ZADD", K_IDX_WS_NB, nb, ws)
  else
    whead.notBefore = cjson.null
    redis.call("ZREM", K_IDX_WS_NB, ws)
  end
  whead.version = whead.version + 1
  redis.call("HSET", kWs(ws), "data", cjson.encode(whead))
end
local function streamRecompute(sid)
  local sdata = redis.call("HGET", kStream(sid), "data")
  if not sdata then return end
  local head = cjson.decode(sdata)
  local nb = nil
  local e = redis.call("ZRANGE", kStreamElig(sid), 0, 0, "WITHSCORES")
  if #e >= 2 then nb = tonumber(e[2]) end
  local m = redis.call("ZRANGE", kStreamMemberElig(sid), 0, 0, "WITHSCORES")
  if #m >= 2 then
    local v = tonumber(m[2])
    if nb == nil or v < nb then nb = v end
  end
  local ab = head.activeBatchId
  if not isNull(ab) then
    local bstatus = redis.call("HGET", kBatch(ab), "status")
    if bstatus == "retry_wait" then
      local rnb = redis.call("HGET", kBatch(ab), "rnb")
      local v = 0
      if rnb and rnb ~= "" then v = tonumber(rnb) end
      if nb == nil or v < nb then nb = v end
    end
  end
  -- The persisted resume floor (scheduler backoff/calendar bound) only raises
  -- an existing wake; it never wakes an otherwise idle stream. Blobs written
  -- before the field existed decode as nil and are treated as no floor.
  if nb ~= nil and not isNull(head.resumeNotBefore) and head.resumeNotBefore > nb then
    nb = head.resumeNotBefore
  end
  if nb == nil then head.notBefore = cjson.null else head.notBefore = nb end
  redis.call("HSET", kStream(sid), "data", cjson.encode(head))
  indexStream(head.workspaceId, sid, nb)
  wsRecompute(head.workspaceId)
end
local function saveBatch(rec)
  local rnb = ""
  if not isNull(rec.retryNotBefore) then rnb = tostring(rec.retryNotBefore) end
  redis.call("HSET", kBatch(rec.batchId), "data", cjson.encode(rec), "status", rec.status, "rnb", rnb)
end
local function saveOutbox(entry, claimToken, claimExpiry)
  redis.call("HSET", kOutbox(entry.batchId), "data", cjson.encode(entry),
    "claimToken", claimToken, "claimExpiry", tostring(claimExpiry))
  if entry.status == "pending" then
    redis.call("ZADD", K_IDX_OUTBOX, entry.nextAttemptAt, entry.batchId)
  else
    redis.call("ZREM", K_IDX_OUTBOX, entry.batchId)
  end
end
local function setMembersTerminal(batchId, members, status, reason)
  for _, m in ipairs(members) do
    local mdata = redis.call("HGET", kMember(m.memberId), "data")
    if mdata then
      local ms = cjson.decode(mdata)
      if ms.record.batchId == batchId then
        ms.record.status = status
        if reason ~= nil then
          ms.record.terminalReason = reason
        end
        redis.call("HSET", kMember(m.memberId), "data", cjson.encode(ms))
      end
    end
  end
end
`;

const LUA_ACCEPT_RECEIPT =
  LUA_PRELUDE +
  `
local input = cjson.decode(ARGV[2])
local existing = redis.call("GET", kDelivery(input.deliveryKey))
if existing then
  local rdata = redis.call("HGET", kReceipt(existing), "data")
  if rdata then
    return cjson.encode({ duplicate = true, receipt = rdata })
  end
end
local seq = redis.call("INCR", K_CTR_RECEIPT)
local receipt = {
  receiptId = input.receiptId,
  receiptSeq = seq,
  deliveryKey = input.deliveryKey,
  workspaceId = input.workspaceId,
  triggerName = input.triggerName,
  provider = input.provider,
  vcs = input.vcs,
  sourceNamespace = input.sourceNamespace,
  scopeRef = input.scopeRef,
  historyGeneration = input.historyGeneration,
  coverage = input.coverage,
  envelope = input.envelope,
  firstAcceptedAt = input.now,
  delaySeconds = input.delaySeconds,
  policyVersion = input.policyVersion,
  streamId = input.streamId,
  metadataCursor = cjson.null,
  metadataAttempts = 0,
  metadataNextAttemptAt = cjson.null,
  metadataTerminalError = cjson.null,
  resolution = input.resolution or cjson.null,
}
redis.call("SET", kDelivery(input.deliveryKey), input.receiptId)
redis.call("HSET", kReceipt(input.receiptId), "data", cjson.encode(receipt))
redis.call("ZADD", kStreamReceipts(input.streamId), seq, input.receiptId)
redis.call("ZADD", kStreamElig(input.streamId), input.now + input.delaySeconds * 1000, input.receiptId)
local sid = input.streamId
if redis.call("HEXISTS", kStream(sid), "data") == 0 then
  local head = {
    streamId = sid,
    workspaceId = input.workspaceId,
    triggerName = input.triggerName,
    vcs = input.vcs,
    sourceNamespace = input.sourceNamespace,
    scopeRef = input.scopeRef,
    historyGeneration = input.historyGeneration,
    notBefore = cjson.null,
    activeBatchId = cjson.null,
    reservationOwner = cjson.null,
    reservationToken = cjson.null,
    reservationExpiry = cjson.null,
    coverageCursor = 0,
    latestReceiptSeq = 0,
    assemblyCutSeq = cjson.null,
    assemblyAt = cjson.null,
    resumeNotBefore = cjson.null,
    version = 0,
  }
  redis.call("HSET", kStream(sid), "data", cjson.encode(head))
end
-- Receipt high-water mark: monotonic per stream, never rewound by dedup or
-- later failure. Direct field write (no version bump) — derived state, not a
-- CAS-guarded scheduling decision.
local hdata = redis.call("HGET", kStream(sid), "data")
if hdata then
  local h = cjson.decode(hdata)
  h.latestReceiptSeq = seq
  redis.call("HSET", kStream(sid), "data", cjson.encode(h))
end
local ws = input.workspaceId
if redis.call("HEXISTS", kWs(ws), "data") == 0 then
  local whead = { workspaceId = ws, notBefore = cjson.null, fairnessSeq = redis.call("INCR", K_CTR_FAIR), version = 0 }
  redis.call("HSET", kWs(ws), "data", cjson.encode(whead))
end
streamRecompute(sid)
return cjson.encode({ duplicate = false, receipt = cjson.encode(receipt) })
`;

const LUA_ACCEPT_ROUTING =
  LUA_PRELUDE +
  `
local input = cjson.decode(ARGV[2])
local existing = redis.call("GET", kRoutingKey(input.routingKey))
if existing then
  local rdata = redis.call("HGET", kRouting(existing), "data")
  if rdata then
    return cjson.encode({ duplicate = true, receipt = rdata })
  end
end
local record = {
  routingId = input.routingId,
  routingKey = input.routingKey,
  provider = input.provider,
  triggerName = input.triggerName,
  envelope = input.envelope,
  parentDeliveryId = input.parentDeliveryId or cjson.null,
  firstAcceptedAt = input.now,
  attempts = 0,
  nextAttemptAt = cjson.null,
  terminalError = cjson.null,
  convertedReceiptIds = {},
  completedAt = cjson.null,
  note = cjson.null,
  resolution = cjson.null,
}
redis.call("SET", kRoutingKey(input.routingKey), input.routingId)
redis.call("HSET", kRouting(input.routingId), "data", cjson.encode(record))
redis.call("ZADD", K_IDX_ROUTING_DUE, input.now, input.routingId)
return cjson.encode({ duplicate = false, receipt = cjson.encode(record) })
`;

const LUA_ROUTING_FAILURE =
  LUA_PRELUDE +
  `
local routingId = ARGV[2]
local error = ARGV[3]
local retryAt = ARGV[4]
local rdata = redis.call("HGET", kRouting(routingId), "data")
if not rdata then
  return "missing"
end
local record = cjson.decode(rdata)
if not isNull(record.terminalError) or not isNull(record.completedAt) then
  return "settled"
end
record.attempts = (record.attempts or 0) + 1
if retryAt == "terminal" then
  record.terminalError = error
  redis.call("ZREM", K_IDX_ROUTING_DUE, routingId)
else
  record.nextAttemptAt = tonumber(retryAt)
  redis.call("ZADD", K_IDX_ROUTING_DUE, tonumber(retryAt), routingId)
end
redis.call("HSET", kRouting(routingId), "data", cjson.encode(record))
return "ok"
`;

const LUA_ROUTING_RESOLUTION =
  LUA_PRELUDE +
  `
local routingId = ARGV[2]
local resolution = ARGV[3]
local rdata = redis.call("HGET", kRouting(routingId), "data")
if not rdata then
  return cjson.encode({ status = "missing" })
end
local record = cjson.decode(rdata)
-- V14: first interpretation wins; a retried/concurrent attempt reads back
-- the frozen value instead of re-resolving against changed config.
if isNull(record.resolution) then
  record.resolution = cjson.decode(resolution)
  redis.call("HSET", kRouting(routingId), "data", cjson.encode(record))
end
return cjson.encode({ status = "ok", receipt = cjson.encode(record) })
`;

const LUA_ROUTING_CONVERSION =
  LUA_PRELUDE +
  `
local routingId = ARGV[2]
local input = cjson.decode(ARGV[3])
local now = tonumber(ARGV[4])
local rdata = redis.call("HGET", kRouting(routingId), "data")
if not rdata then
  return cjson.encode({ status = "missing" })
end
local record = cjson.decode(rdata)
local seen = {}
for _, id in ipairs(record.convertedReceiptIds or {}) do
  seen[id] = true
end
for _, id in ipairs(input.addedReceiptIds or {}) do
  if not seen[id] then
    table.insert(record.convertedReceiptIds, id)
    seen[id] = true
  end
end
if input.complete == true and isNull(record.completedAt) then
  record.completedAt = now
  redis.call("ZREM", K_IDX_ROUTING_DUE, routingId)
end
if input.note then
  record.note = input.note
end
redis.call("HSET", kRouting(routingId), "data", cjson.encode(record))
return cjson.encode({ status = "ok", receipt = cjson.encode(record) })
`;

const LUA_APPLY_METADATA_PAGE =
  LUA_PRELUDE +
  `
local streamId = ARGV[2]
local receiptId = ARGV[3]
local upserts = cjson.decode(ARGV[4])
local rdata = redis.call("HGET", kReceipt(receiptId), "data")
if not rdata then
  return "ERRRANGE Unknown receipt "..receiptId
end
local receipt = cjson.decode(rdata)
if receipt.streamId ~= streamId then return "ERRRANGE Receipt stream mismatch" end
local rseq = receipt.receiptSeq
-- Validate the entire bounded page before writing any association. Source
-- merging and SHA-256 happen in JS; CAS keeps concurrent evidence lossless.
for _, upsert in ipairs(upserts) do
  local current = redis.call("HGET", kMember(upsert.memberId), "data")
  if (current or "") ~= upsert.expectedData then return "RETRY" end
end
local created = 0
local updated = 0
local conflicted = {}
for _, upsert in ipairs(upserts) do
  local mid = upsert.memberId
  redis.call("ZADD", kReceiptMembers(receiptId), 0, mid)
  redis.call("ZADD", kMemberReceipts(mid), 0, receiptId)
  local mdata = redis.call("HGET", kMember(mid), "data")
  if mdata then
    local ms = cjson.decode(mdata)
    local rec = ms.record
    if rec.status == "pending" and rseq < ms.coverSeq then
      ms.coverSeq = rseq
      rec.coverReceiptId = receipt.receiptId
      rec.firstAcceptedAt = receipt.firstAcceptedAt
      rec.eligibleAt = receipt.firstAcceptedAt + receipt.delaySeconds * 1000
      if rec.status == "pending" then
        redis.call("ZADD", kStreamMemberElig(streamId), rec.eligibleAt, mid)
      end
    end
    if rec.status == "pending" and isNull(rec.batchId) then
      if isNull(rec.sourceSnapshot) then
        rec.orderKey = upsert.orderKey
        rec.parents = upsert.parents
        rec.sourceSnapshot = upsert.sourceSnapshot
        redis.call("ZREM", kStreamPending(streamId), "0"..mid)
        redis.call("ZADD", kStreamPending(streamId), 0, pendingSortKey(rec))
        updated = updated + 1
      else
        rec.sourceSnapshot = upsert.sourceSnapshot
        if rec.sourceSnapshot.status == "conflicted" then conflicted[#conflicted + 1] = mid end
        updated = updated + 1
      end
    end
    redis.call("HSET", kMember(mid), "data", cjson.encode(ms))
  else
    local rec = {
      memberId = mid,
      streamId = streamId,
      revision = upsert.revision,
      coverReceiptId = receipt.receiptId,
      orderKey = upsert.orderKey,
      parents = upsert.parents,
      status = "pending",
      sourceSnapshot = upsert.sourceSnapshot,
      exclusion = { state = "undecided", ruleId = cjson.null, policyVersion = cjson.null },
      eligibleAt = receipt.firstAcceptedAt + receipt.delaySeconds * 1000,
      firstAcceptedAt = receipt.firstAcceptedAt,
      batchId = cjson.null,
      terminalReason = cjson.null,
    }
    local ms = { record = rec, coverSeq = rseq }
    redis.call("HSET", kMember(mid), "data", cjson.encode(ms))
    redis.call("ZADD", kStreamMemberElig(streamId), rec.eligibleAt, mid)
    redis.call("ZADD", kStreamPending(streamId), 0, pendingSortKey(rec))
    created = created + 1
  end
end
streamRecompute(streamId)
return { created, updated, cjson.encode(conflicted) }
`;

const LUA_APPLY_EXCLUSION_VERDICTS =
  LUA_PRELUDE +
  `
local streamId = ARGV[2]
local verdicts = cjson.decode(ARGV[3])
for _, v in ipairs(verdicts) do
  local mdata = redis.call("HGET", kMember(v.memberId), "data")
  if mdata then
    local ms = cjson.decode(mdata)
    local rec = ms.record
    if rec.streamId == streamId and rec.status == "pending" then
      local excluded = v.state == "excluded"
      -- "unavailable" is terminal: unavailable/conflicted source evidence
      -- blocks merging forever (design §5.1.1) and v1 has no manual allow
      -- path, so the member fails explicitly — never silently re-keyed.
      local failed = v.state == "unavailable"
      rec.exclusion = {
        state = v.state,
        ruleId = v.ruleId,
        policyVersion = v.policyVersion,
      }
      if excluded or failed then
        redis.call("ZREM", kStreamPending(streamId), pendingSortKey(rec))
        redis.call("ZREM", kStreamMemberElig(streamId), v.memberId)
        if excluded then
          rec.status = "skipped"
          rec.terminalReason = "excluded_source"
        else
          rec.status = "failed"
          if isNull(v.ruleId) then rec.terminalReason = "source_unavailable" else rec.terminalReason = v.ruleId end
        end
      end
      redis.call("HSET", kMember(v.memberId), "data", cjson.encode(ms))
    end
  end
end
streamRecompute(streamId)
return 1
`;

const LUA_ACQUIRE_RESERVATION =
  LUA_PRELUDE +
  `
local sdata = redis.call("HGET", kStream(ARGV[2]), "data")
if not sdata then return nil end
local head = cjson.decode(sdata)
if not isNull(head.activeBatchId) then return nil end
if not isNull(head.reservationToken) and not isNull(head.reservationExpiry)
  and head.reservationExpiry > tonumber(ARGV[6]) then
  return nil
end
head.reservationOwner = ARGV[3]
head.reservationToken = ARGV[4]
head.reservationExpiry = tonumber(ARGV[5])
head.version = head.version + 1
redis.call("HSET", kStream(ARGV[2]), "data", cjson.encode(head))
return cjson.encode({ streamId = ARGV[2], token = ARGV[4], expiry = tonumber(ARGV[5]), version = head.version })
`;

const LUA_RENEW_RESERVATION =
  LUA_PRELUDE +
  `
local sdata = redis.call("HGET", kStream(ARGV[2]), "data")
if not sdata then return 0 end
local head = cjson.decode(sdata)
if head.reservationToken ~= ARGV[3] or isNull(head.reservationExpiry)
  or head.reservationExpiry <= tonumber(ARGV[5]) then
  return 0
end
head.reservationExpiry = tonumber(ARGV[4])
head.version = head.version + 1
redis.call("HSET", kStream(ARGV[2]), "data", cjson.encode(head))
return 1
`;

const LUA_RELEASE_RESERVATION =
  LUA_PRELUDE +
  `
local sdata = redis.call("HGET", kStream(ARGV[2]), "data")
if not sdata then return 0 end
local head = cjson.decode(sdata)
if head.reservationToken ~= ARGV[3] then return 0 end
head.reservationOwner = cjson.null
head.reservationToken = cjson.null
head.reservationExpiry = cjson.null
head.version = head.version + 1
redis.call("HSET", kStream(ARGV[2]), "data", cjson.encode(head))
return 1
`;

const LUA_UPDATE_STREAM_HEAD =
  LUA_PRELUDE +
  `
local sid = ARGV[2]
local sdata = redis.call("HGET", kStream(sid), "data")
if not sdata then return 0 end
local head = cjson.decode(sdata)
if head.version ~= tonumber(ARGV[3]) then return 0 end
if ARGV[4] == "1" then
  if ARGV[5] == "" then head.notBefore = cjson.null else head.notBefore = tonumber(ARGV[5]) end
end
if ARGV[6] == "1" then
  local cursor = tonumber(ARGV[7])
  local previous = head.coverageCursor
  head.coverageCursor = cursor
  local consumed = redis.call("ZRANGEBYSCORE", kStreamReceipts(sid), "("..tostring(previous), cursor)
  for _, rid in ipairs(consumed) do
    redis.call("ZREM", kStreamElig(sid), rid)
  end
end
if ARGV[8] == "1" then
  head.historyGeneration = tonumber(ARGV[9])
end
if ARGV[10] == "1" then
  if ARGV[11] == "" then head.resumeNotBefore = cjson.null else head.resumeNotBefore = tonumber(ARGV[11]) end
end
if ARGV[12] == "1" then
  if ARGV[13] == "" then head.assemblyCutSeq = cjson.null else head.assemblyCutSeq = tonumber(ARGV[13]) end
end
if ARGV[14] == "1" then
  if ARGV[15] == "" then head.assemblyAt = cjson.null else head.assemblyAt = tonumber(ARGV[15]) end
end
head.version = head.version + 1
redis.call("HSET", kStream(sid), "data", cjson.encode(head))
-- Mirror the memory/sqlite backends: every head mutation re-derives the wake
-- bound from components (resume floor applied inside streamRecompute), so an
-- explicit notBefore write is transient by contract.
streamRecompute(sid)
return 1
`;

const LUA_SET_METADATA_CURSOR =
  LUA_PRELUDE +
  `
local rid = ARGV[2]
local rdata = redis.call("HGET", kReceipt(rid), "data")
if not rdata then return "ERRRANGE Unknown receipt "..rid end
local rec = cjson.decode(rdata)
if ARGV[3] == "" then rec.metadataCursor = cjson.null else rec.metadataCursor = ARGV[3] end
-- Progress clears any pending retry wake: the next attempt continues from the
-- persisted cursor on the normal schedule.
rec.metadataNextAttemptAt = cjson.null
redis.call("HSET", kReceipt(rid), "data", cjson.encode(rec))
local sid = rec.streamId
local sdata = redis.call("HGET", kStream(sid), "data")
if sdata then
  local head = cjson.decode(sdata)
  -- Restore the base eligibility score, but only for a receipt the coverage
  -- cursor has not consumed yet; resurrecting a consumed receipt's wake
  -- would re-open an already-expanded range.
  if rec.receiptSeq > head.coverageCursor and isNull(rec.metadataTerminalError) then
    redis.call("ZADD", kStreamElig(sid), rec.firstAcceptedAt + rec.delaySeconds * 1000, rid)
  end
  streamRecompute(sid)
end
return 1
`;

const LUA_RECORD_METADATA_FAILURE =
  LUA_PRELUDE +
  `
local rid = ARGV[2]
local rdata = redis.call("HGET", kReceipt(rid), "data")
if not rdata then return "ERRRANGE Unknown receipt "..rid end
local rec = cjson.decode(rdata)
rec.metadataAttempts = (rec.metadataAttempts or 0) + 1
local retryAt = ARGV[4]
if retryAt == "" then
  rec.metadataNextAttemptAt = cjson.null
  rec.metadataTerminalError = ARGV[3]
else
  rec.metadataNextAttemptAt = tonumber(retryAt)
  rec.metadataTerminalError = cjson.null
end
redis.call("HSET", kReceipt(rid), "data", cjson.encode(rec))
local sid = rec.streamId
local sdata = redis.call("HGET", kStream(sid), "data")
if sdata then
  local head = cjson.decode(sdata)
  if rec.receiptSeq > head.coverageCursor then
    if retryAt == "" then
      -- Terminal failures stop contributing a wake entirely (design: 记录原因
      -- 并有界重试; a terminal receipt waits for explicit handling).
      redis.call("ZREM", kStreamElig(sid), rid)
    else
      local base = rec.firstAcceptedAt + rec.delaySeconds * 1000
      local score = tonumber(retryAt)
      if base > score then score = base end
      redis.call("ZADD", kStreamElig(sid), score, rid)
    end
  end
  streamRecompute(sid)
end
return 1
`;

const LUA_DEFER_BATCH =
  LUA_PRELUDE +
  `
local bdata = redis.call("HGET", kBatch(ARGV[2]), "data")
if not bdata then return 0 end
local rec = cjson.decode(bdata)
-- Requeue a dispatched-but-not-started batch without consuming an execution
-- attempt (schedule-window deferral); running batches are untouched.
if rec.status ~= "queued" then return 0 end
rec.status = "retry_wait"
rec.retryNotBefore = tonumber(ARGV[3])
rec.leaseExpiry = cjson.null
saveBatch(rec)
saveOutbox({ batchId = ARGV[2], status = "pending", nextAttemptAt = tonumber(ARGV[3]) }, "", "0")
streamRecompute(rec.streamId)
return 1
`;

const LUA_ROTATE_FAIRNESS =
  LUA_PRELUDE +
  `
local wdata = redis.call("HGET", kWs(ARGV[2]), "data")
local whead
if wdata then
  whead = cjson.decode(wdata)
else
  whead = { workspaceId = ARGV[2], notBefore = cjson.null, fairnessSeq = 0, version = 0 }
end
whead.fairnessSeq = redis.call("INCR", K_CTR_FAIR)
whead.version = whead.version + 1
redis.call("HSET", kWs(ARGV[2]), "data", cjson.encode(whead))
return 1
`;

const LUA_SEAL_BATCH =
  LUA_PRELUDE +
  `
local input = cjson.decode(ARGV[2])
local sid = input.streamId
local sdata = redis.call("HGET", kStream(sid), "data")
if not sdata then
  return cjson.encode({ kind = "conflict", reason = "reservation_lost" })
end
local head = cjson.decode(sdata)
if head.reservationToken ~= input.reservationToken or isNull(head.reservationExpiry)
  or head.reservationExpiry <= input.now then
  return cjson.encode({ kind = "conflict", reason = "reservation_lost" })
end
if head.version ~= input.expectedStreamVersion then
  return cjson.encode({ kind = "conflict", reason = "stream_version_mismatch" })
end
if not isNull(head.activeBatchId) then
  return cjson.encode({ kind = "conflict", reason = "active_batch" })
end
if #input.members == 0 or #input.members > 50 or redis.call("EXISTS", kBatch(input.batchId)) == 1 then return cjson.encode({ kind = "conflict", reason = "member_unavailable" }) end
local seen = {}
for _, m in ipairs(input.members) do
  if seen[m.memberId] then return cjson.encode({ kind = "conflict", reason = "member_unavailable" }) end
  seen[m.memberId] = true
  local mdata = redis.call("HGET", kMember(m.memberId), "data")
  if not mdata then
    return cjson.encode({ kind = "conflict", reason = "member_unavailable", memberId = m.memberId })
  end
  local ms = cjson.decode(mdata)
  if ms.record.streamId ~= sid or ms.record.status ~= "pending" or not isNull(ms.record.batchId) or (not isNull(ms.record.sourceSnapshot) and ms.record.sourceSnapshot.status == "conflicted") then
    return cjson.encode({ kind = "conflict", reason = "member_unavailable", memberId = m.memberId })
  end
  if ms.record.eligibleAt > input.now then
    return cjson.encode({ kind = "conflict", reason = "member_ineligible", memberId = m.memberId })
  end
end
local batch = {
  executionCheckpoint = cjson.null,
  batchId = input.batchId,
  runId = input.runId,
  streamId = sid,
  workspaceId = head.workspaceId,
  triggerName = head.triggerName,
  vcs = head.vcs,
  sourceNamespace = head.sourceNamespace,
  scopeRef = head.scopeRef,
  historyGeneration = head.historyGeneration,
  sourceKey = input.sourceKey,
  members = input.members,
  base = input.base,
  head = input.head,
  exclusionPolicyVersion = input.exclusionPolicyVersion,
  configPolicyVersion = input.configPolicyVersion,
  status = "dispatch_pending",
  attempt = 0,
  maxAttempts = input.maxAttempts,
  retryNotBefore = cjson.null,
  leaseToken = cjson.null,
  leaseOwner = cjson.null,
  leaseExpiry = cjson.null,
  lastError = cjson.null,
  createdAt = input.now,
}
saveBatch(batch)
saveOutbox({ batchId = input.batchId, status = "pending", nextAttemptAt = input.now }, "", "0")
for _, m in ipairs(input.members) do
  local ms = cjson.decode(redis.call("HGET", kMember(m.memberId), "data"))
  redis.call("ZREM", kStreamPending(sid), pendingSortKey(ms.record))
  redis.call("ZREM", kStreamMemberElig(sid), m.memberId)
  ms.record.status = "batched"
  ms.record.batchId = input.batchId
  redis.call("HSET", kMember(m.memberId), "data", cjson.encode(ms))
end
head.activeBatchId = input.batchId
head.reservationOwner = cjson.null
head.reservationToken = cjson.null
head.reservationExpiry = cjson.null
head.version = head.version + 1
redis.call("HSET", kStream(sid), "data", cjson.encode(head))
streamRecompute(sid)
return cjson.encode({ kind = "sealed" })
`;

const LUA_CLAIM_DISPATCH =
  LUA_PRELUDE +
  `
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local fetchN = tonumber(ARGV[4])
local tokens = cjson.decode(ARGV[5])
local due = redis.call("ZRANGEBYSCORE", K_IDX_OUTBOX, "-inf", now, "LIMIT", 0, fetchN)
local out = {}
local ti = 1
for _, bid in ipairs(due) do
  if ti > limit then break end
  local odata = redis.call("HGET", kOutbox(bid), "data")
  if odata then
    local entry = cjson.decode(odata)
    local ct = redis.call("HGET", kOutbox(bid), "claimToken")
    local ce = tonumber(redis.call("HGET", kOutbox(bid), "claimExpiry") or "0")
    if entry.status == "pending" and (not ct or ct == "" or ce <= now) then
      local token = tokens[ti]
      ti = ti + 1
      redis.call("HSET", kOutbox(bid), "claimToken", token, "claimExpiry", tostring(now + DISPATCH_CLAIM_TTL_MS))
      out[#out + 1] = bid
      out[#out + 1] = token
    end
  end
end
return out
`;

const LUA_CONFIRM_DISPATCH =
  LUA_PRELUDE +
  `
local odata = redis.call("HGET", kOutbox(ARGV[2]), "data")
if not odata then return 0 end
local ct = redis.call("HGET", kOutbox(ARGV[2]), "claimToken")
if not ct or ct ~= ARGV[3] then return 0 end
local bdata = redis.call("HGET", kBatch(ARGV[2]), "data")
if not bdata then return 0 end
local entry = cjson.decode(odata)
entry.status = "dispatched"
redis.call("HSET", kOutbox(ARGV[2]), "data", cjson.encode(entry), "claimToken", "", "claimExpiry", "0")
redis.call("ZREM", K_IDX_OUTBOX, ARGV[2])
local rec = cjson.decode(bdata)
rec.status = "queued"
rec.leaseExpiry = tonumber(ARGV[4]) + DISPATCH_CLAIM_TTL_MS
redis.call("ZADD", K_IDX_LEASE, rec.leaseExpiry, ARGV[2])
redis.call("HSET", kBatch(ARGV[2]), "data", cjson.encode(rec), "status", "queued")
return 1
`;

const LUA_ABORT_DISPATCH =
  LUA_PRELUDE +
  `
local odata = redis.call("HGET", kOutbox(ARGV[2]), "data")
if not odata then return 0 end
local ct = redis.call("HGET", kOutbox(ARGV[2]), "claimToken")
if not ct or ct ~= ARGV[3] then return 0 end
local entry = { batchId = ARGV[2], status = "pending", nextAttemptAt = tonumber(ARGV[4]) }
redis.call("HSET", kOutbox(ARGV[2]), "data", cjson.encode(entry), "claimToken", "", "claimExpiry", "0")
redis.call("ZADD", K_IDX_OUTBOX, entry.nextAttemptAt, ARGV[2])
return 1
`;

const LUA_START_EXECUTION =
  LUA_PRELUDE +
  `
local bdata = redis.call("HGET", kBatch(ARGV[2]), "data")
if not bdata then return nil end
local rec = cjson.decode(bdata)
if rec.status ~= "queued" then return nil end
if not isNull(rec.leaseToken) and not isNull(rec.leaseExpiry) and rec.leaseExpiry > tonumber(ARGV[6]) then
  return nil
end
local now = tonumber(ARGV[6])
if redis.call("ZCOUNT", K_IDX_RUNNING, "("..tostring(now), "+inf") >= tonumber(ARGV[7]) then return nil end
if redis.call("ZCOUNT", kWsRunning(rec.workspaceId), "("..tostring(now), "+inf") >= tonumber(ARGV[8]) then return nil end
rec.status = "running"
rec.attempt = rec.attempt + 1
rec.leaseToken = ARGV[4]
rec.leaseOwner = ARGV[3]
rec.leaseExpiry = tonumber(ARGV[5])
redis.call("HSET", kBatch(ARGV[2]), "data", cjson.encode(rec), "status", "running")
redis.call("ZADD", K_IDX_LEASE, rec.leaseExpiry, ARGV[2])
redis.call("ZADD", K_IDX_RUNNING, rec.leaseExpiry, ARGV[2])
redis.call("ZADD", kWsRunning(rec.workspaceId), rec.leaseExpiry, ARGV[2])
return ARGV[4]
`;

const LUA_RENEW_BATCH_LEASE =
  LUA_PRELUDE +
  `
local bdata = redis.call("HGET", kBatch(ARGV[2]), "data")
if not bdata then return 0 end
local rec = cjson.decode(bdata)
if rec.status ~= "running" or rec.leaseToken ~= ARGV[3] or isNull(rec.leaseExpiry)
  or rec.leaseExpiry <= tonumber(ARGV[5]) then
  return 0
end
rec.leaseExpiry = tonumber(ARGV[4])
redis.call("HSET", kBatch(ARGV[2]), "data", cjson.encode(rec))
redis.call("ZADD", K_IDX_LEASE, rec.leaseExpiry, ARGV[2])
redis.call("ZADD", K_IDX_RUNNING, rec.leaseExpiry, ARGV[2])
redis.call("ZADD", kWsRunning(rec.workspaceId), rec.leaseExpiry, ARGV[2])
return 1
`;

const LUA_COMPLETE_BATCH =
  LUA_PRELUDE +
  `
local bdata = redis.call("HGET", kBatch(ARGV[2]), "data")
if not bdata then return 0 end
local rec = cjson.decode(bdata)
if rec.status ~= "running" or rec.leaseToken ~= ARGV[3] or isNull(rec.leaseExpiry) or rec.leaseExpiry <= tonumber(ARGV[6]) then return 0 end
rec.status = ARGV[4]
rec.leaseToken = cjson.null
rec.leaseOwner = cjson.null
rec.leaseExpiry = cjson.null
redis.call("HSET", kBatch(ARGV[2]), "data", cjson.encode(rec), "status", ARGV[4])
redis.call("ZREM", K_IDX_LEASE, ARGV[2])
redis.call("ZREM", K_IDX_RUNNING, ARGV[2])
redis.call("ZREM", kWsRunning(rec.workspaceId), ARGV[2])
local reason = nil
if ARGV[4] == "skipped" then reason = ARGV[5] end
setMembersTerminal(ARGV[2], rec.members, ARGV[4], reason)
redis.call("DEL", kOutbox(ARGV[2]))
redis.call("ZREM", K_IDX_OUTBOX, ARGV[2])
local sdata = redis.call("HGET", kStream(rec.streamId), "data")
if sdata then
  local head = cjson.decode(sdata)
  if head.activeBatchId == ARGV[2] then
    head.activeBatchId = cjson.null
    head.version = head.version + 1
    redis.call("HSET", kStream(rec.streamId), "data", cjson.encode(head))
  end
end
streamRecompute(rec.streamId)
return 1
`;

const LUA_FAIL_BATCH =
  LUA_PRELUDE +
  `
local bdata = redis.call("HGET", kBatch(ARGV[2]), "data")
if not bdata then return 0 end
local rec = cjson.decode(bdata)
if rec.status ~= "running" or rec.leaseToken ~= ARGV[3] or isNull(rec.leaseExpiry) or rec.leaseExpiry <= tonumber(ARGV[7]) then return 0 end
local exhausted = ARGV[6] == "1" or rec.attempt >= rec.maxAttempts
rec.lastError = ARGV[4]
rec.leaseToken = cjson.null
rec.leaseOwner = cjson.null
rec.leaseExpiry = cjson.null
redis.call("ZREM", K_IDX_LEASE, ARGV[2])
redis.call("ZREM", K_IDX_RUNNING, ARGV[2])
redis.call("ZREM", kWsRunning(rec.workspaceId), ARGV[2])
if exhausted then
  rec.status = "dead"
  saveBatch(rec)
  setMembersTerminal(ARGV[2], rec.members, "dead", ARGV[4])
else
  rec.status = "retry_wait"
  if ARGV[5] == "" then rec.retryNotBefore = cjson.null else rec.retryNotBefore = tonumber(ARGV[5]) end
  saveBatch(rec)
  local naa = tonumber(ARGV[7])
  if ARGV[5] ~= "" then naa = tonumber(ARGV[5]) end
  saveOutbox({ batchId = ARGV[2], status = "pending", nextAttemptAt = naa }, "", "0")
end
streamRecompute(rec.streamId)
return 1
`;

const LUA_RECLAIM_LEASES =
  LUA_PRELUDE +
  `
local now = tonumber(ARGV[2])
local due = redis.call("ZRANGEBYSCORE", K_IDX_LEASE, "-inf", now, "LIMIT", 0, tonumber(ARGV[3]))
local reclaimed = {}
for _, bid in ipairs(due) do
  local bdata = redis.call("HGET", kBatch(bid), "data")
  if bdata then
    local rec = cjson.decode(bdata)
    if (rec.status == "running" or rec.status == "queued") and not isNull(rec.leaseExpiry) and rec.leaseExpiry <= now then
      redis.call("ZREM", K_IDX_LEASE, bid)
      redis.call("ZREM", K_IDX_RUNNING, bid)
      redis.call("ZREM", kWsRunning(rec.workspaceId), bid)
      rec.lastError = "lease_expired"
      rec.leaseToken = cjson.null
      rec.leaseOwner = cjson.null
      rec.leaseExpiry = cjson.null
      if rec.status == "running" and rec.attempt >= rec.maxAttempts then
        rec.status = "dead"
        saveBatch(rec)
        setMembersTerminal(bid, rec.members, "dead", "lease_expired")
      else
        rec.status = "retry_wait"
        rec.retryNotBefore = cjson.null
        saveBatch(rec)
        saveOutbox({ batchId = bid, status = "pending", nextAttemptAt = now }, "", "0")
      end
      streamRecompute(rec.streamId)
      reclaimed[#reclaimed + 1] = bid
    end
  end
end
return reclaimed
`;

// ---------------------------------------------------------------------------
// Stored JSON shapes
// ---------------------------------------------------------------------------

interface StoredReceipt extends AutoCommitReceipt {
  readonly streamId: string;
}

function toReceipt(stored: StoredReceipt): AutoCommitReceipt {
  const { streamId, ...receipt } = stored;
  void streamId;
  // Blobs written before the cursor/retry-accounting fields existed decode
  // as undefined; normalize to the zero-value contract.
  return {
    ...receipt,
    metadataCursor: receipt.metadataCursor ?? null,
    metadataAttempts: receipt.metadataAttempts ?? 0,
    metadataNextAttemptAt: receipt.metadataNextAttemptAt ?? null,
    metadataTerminalError: receipt.metadataTerminalError ?? null,
    resolution: receipt.resolution ?? null,
  };
}

/** Normalize routing blobs written before later field additions existed. */
function toRoutingReceipt(stored: RoutingReceiptRecord): RoutingReceiptRecord {
  return {
    ...stored,
    parentDeliveryId: stored.parentDeliveryId ?? null,
    attempts: stored.attempts ?? 0,
    nextAttemptAt: stored.nextAttemptAt ?? null,
    terminalError: stored.terminalError ?? null,
    convertedReceiptIds: stored.convertedReceiptIds ?? [],
    completedAt: stored.completedAt ?? null,
    note: stored.note ?? null,
    resolution: stored.resolution ?? null,
  };
}

/** Normalize stream head blobs written before the v3 head fields existed. */
function toStreamHead(stored: StreamHead): StreamHead {
  return {
    ...stored,
    latestReceiptSeq: stored.latestReceiptSeq ?? 0,
    assemblyCutSeq: stored.assemblyCutSeq ?? null,
    assemblyAt: stored.assemblyAt ?? null,
    resumeNotBefore: stored.resumeNotBefore ?? null,
  };
}

interface StoredMember {
  readonly coverSeq: number;
  readonly record: CommitMemberRecord;
}

/** Lex member of the stream pending zset for a record (score is always 0). */
function pendingLexMember(orderKey: string | null, memberId: string): string {
  return orderKey === null ? `0${memberId}` : `1${orderKey}\0${memberId}`;
}

/** Rebuild the store cursor (`${orderKey ?? ""}${memberId}`) from a zset member. */
function cursorFromLexMember(lexMember: string): string {
  if (lexMember.startsWith("0")) return lexMember.slice(1);
  const memberId = lexMember.slice(-64);
  const orderKey = lexMember.slice(1, -65);
  return `${orderKey}${memberId}`;
}

function lexMemberFromCursor(cursor: string): string {
  const memberId = cursor.slice(-64);
  const orderKey = cursor.slice(0, -64);
  return pendingLexMember(orderKey === "" ? null : orderKey, memberId);
}

export async function createRedisAutoCommitStore(
  options: RedisAutoCommitStoreOptions,
): Promise<AutoCommitStore> {
  const mod = (await loadIoredis()) as {
    Redis?: new (opts: Record<string, unknown>) => RedisClient;
  } & (new (opts: Record<string, unknown>) => RedisClient);
  const RedisCtor = mod.Redis ?? mod;
  const redis: RedisClient = new RedisCtor(
    buildRedisConnection(options.connection),
  );
  const P = `${options.keyPrefix ?? "aicr:"}ac:`;

  async function evalScript(
    script: string,
    ...args: (string | number)[]
  ): Promise<unknown> {
    return redis.eval(script, 0, ...args.map((arg) => String(arg)));
  }

  async function hgetJson<T>(key: string): Promise<T | undefined> {
    const data = (await redis.hget(key, "data")) as string | null;
    return data === null ? undefined : (JSON.parse(data) as T);
  }

  async function hgetJsonMany<T>(
    keys: readonly string[],
  ): Promise<(T | undefined)[]> {
    return (await hgetMany(keys)).map((value) =>
      value === null ? undefined : (JSON.parse(value) as T),
    );
  }

  async function hgetMany(keys: readonly string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const rows = (await redis
      .pipeline(keys.map((key) => ["hget", key, "data"]))
      .exec()) as [Error | null, string | null][];
    return rows.map(([error, value]) => {
      if (error) throw error;
      return value ?? null;
    });
  }

  const receiptKey = (id: string) => `${P}receipt:${id}`;
  const memberKey = (id: string) => `${P}member:${id}`;
  const streamKey = (id: string) => `${P}stream:${id}`;

  return {
    backendKind: "redis",

    async acceptReceipt(
      input: AcceptReceiptInput,
    ): Promise<AcceptReceiptResult> {
      const streamId = computeStreamId({
        workspaceId: input.workspaceId,
        triggerName: input.triggerName,
        vcs: input.vcs,
        sourceNamespace: input.sourceNamespace,
        scopeRef: input.scopeRef,
        historyGeneration: input.historyGeneration,
      });
      const payload = { ...input, receiptId: randomUUID(), streamId };
      const raw = (await evalScript(
        LUA_ACCEPT_RECEIPT,
        P,
        JSON.stringify(payload),
      )) as string;
      const result = JSON.parse(raw) as { duplicate: boolean; receipt: string };
      const stored = JSON.parse(result.receipt) as StoredReceipt;
      return { receipt: toReceipt(stored), duplicate: result.duplicate };
    },

    async acceptRoutingReceipt(
      input: AcceptRoutingReceiptInput,
    ): Promise<AcceptRoutingReceiptResult> {
      const payload = { ...input, routingId: randomUUID() };
      const raw = (await evalScript(
        LUA_ACCEPT_ROUTING,
        P,
        JSON.stringify(payload),
      )) as string;
      const result = JSON.parse(raw) as { duplicate: boolean; receipt: string };
      const record = JSON.parse(result.receipt) as RoutingReceiptRecord;
      return { receipt: toRoutingReceipt(record), duplicate: result.duplicate };
    },

    async readDueRoutingReceipts(
      now: number,
      limit: number,
    ): Promise<readonly RoutingReceiptRecord[]> {
      const ids = (await redis.zrangebyscore(
        `${P}idx:routing:due`,
        "-inf",
        now,
        "LIMIT",
        0,
        limit,
      )) as string[];
      const records: RoutingReceiptRecord[] = [];
      for (const id of ids) {
        const data = (await redis.hget(`${P}routing:${id}`, "data")) as string | null;
        if (data !== null) {
          records.push(toRoutingReceipt(JSON.parse(data) as RoutingReceiptRecord));
        }
      }
      records.sort((a, b) => a.firstAcceptedAt - b.firstAcceptedAt);
      return records;
    },

    async getRoutingReceipt(
      routingId: string,
    ): Promise<RoutingReceiptRecord | undefined> {
      const data = (await redis.hget(`${P}routing:${routingId}`, "data")) as string | null;
      return data !== null ? toRoutingReceipt(JSON.parse(data) as RoutingReceiptRecord) : undefined;
    },

    async recordRoutingReceiptFailure(
      routingId: string,
      error: string,
      retryAt: number | null,
    ): Promise<void> {
      await evalScript(
        LUA_ROUTING_FAILURE,
        P,
        routingId,
        error,
        retryAt === null ? "terminal" : String(retryAt),
      );
    },

    async recordRoutingReceiptResolution(
      routingId: string,
      resolution: readonly FrozenScopeResolution[],
      _now: number,
    ): Promise<RoutingReceiptRecord> {
      const raw = (await evalScript(
        LUA_ROUTING_RESOLUTION,
        P,
        routingId,
        JSON.stringify(resolution),
      )) as string;
      const result = JSON.parse(raw) as { status: string; receipt?: string };
      if (result.status !== "ok" || result.receipt === undefined) {
        throw new Error(`Unknown routing receipt ${routingId}.`);
      }
      return toRoutingReceipt(JSON.parse(result.receipt) as RoutingReceiptRecord);
    },

    async recordRoutingReceiptConversion(
      routingId: string,
      input: {
        readonly addedReceiptIds?: readonly string[];
        readonly complete?: boolean;
        readonly note?: string;
      },
      now: number,
    ): Promise<RoutingReceiptRecord> {
      const raw = (await evalScript(
        LUA_ROUTING_CONVERSION,
        P,
        routingId,
        JSON.stringify(input),
        String(now),
      )) as string;
      const result = JSON.parse(raw) as { status: string; receipt?: string };
      if (result.status !== "ok" || result.receipt === undefined) {
        throw new Error(`Unknown routing receipt ${routingId}.`);
      }
      return toRoutingReceipt(JSON.parse(result.receipt) as RoutingReceiptRecord);
    },

    async applyMetadataPage(
      input: ApplyMetadataPageInput,
    ): Promise<ApplyMetadataPageResult> {
      const upserts = input.members.map((upsert) => ({
        memberId: computeMemberId(input.streamId, upsert.revision),
        revision: upsert.revision,
        orderKey: upsert.orderKey,
        parents: upsert.parents,
        sourceSnapshot: upsert.sourceSnapshot,
      }));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const [receiptData, ...memberData] = await hgetMany([
          receiptKey(input.receiptId),
          ...upserts.map((member) => memberKey(member.memberId)),
        ]);
        if (!receiptData)
          throw new RangeError(`Unknown receipt ${input.receiptId}`);
        const receipt = JSON.parse(receiptData) as StoredReceipt;
        const members = upserts.map((upsert, index) => {
          const expectedData = memberData[index] ?? "";
          const prior = expectedData
            ? (JSON.parse(expectedData) as StoredMember)
            : undefined;
          return {
            ...upsert,
            expectedData,
            sourceSnapshot: prior?.record.sourceSnapshot
              ? mergeSourceEvidence(
                  prior.record.sourceSnapshot,
                  upsert.sourceSnapshot,
                  receipt.receiptSeq <= prior.coverSeq,
                )
              : upsert.sourceSnapshot,
          };
        });
        const raw = (await evalScript(
          LUA_APPLY_METADATA_PAGE,
          P,
          input.streamId,
          input.receiptId,
          JSON.stringify(members),
        )) as [number, number, string] | string;
        if (raw === "RETRY") continue;
        if (typeof raw === "string" && raw.startsWith("ERRRANGE ")) {
          throw new RangeError(raw.slice("ERRRANGE ".length));
        }
        const [created, updated, conflictedJson] = raw as [
          number,
          number,
          string,
        ];
        const conflicted = JSON.parse(conflictedJson) as unknown;
        return {
          created: Number(created),
          updated: Number(updated),
          conflicted: Array.isArray(conflicted) ? (conflicted as string[]) : [],
        };
      }
      throw new Error(
        "Auto-commit metadata page changed concurrently; retry the page",
      );
    },

    async setReceiptMetadataCursor(
      receiptId: string,
      cursor: string | null,
    ): Promise<void> {
      const raw = (await evalScript(
        LUA_SET_METADATA_CURSOR,
        P,
        receiptId,
        cursor ?? "",
      )) as number | string;
      if (typeof raw === "string" && raw.startsWith("ERRRANGE ")) {
        throw new RangeError(raw.slice("ERRRANGE ".length));
      }
    },

    async recordReceiptMetadataFailure(
      receiptId: string,
      error: string,
      retryAt: number | null,
    ): Promise<void> {
      const raw = (await evalScript(
        LUA_RECORD_METADATA_FAILURE,
        P,
        receiptId,
        error,
        retryAt === null ? "" : retryAt,
      )) as number | string;
      if (typeof raw === "string" && raw.startsWith("ERRRANGE ")) {
        throw new RangeError(raw.slice("ERRRANGE ".length));
      }
    },

    async readMembers(
      memberIds: readonly string[],
    ): Promise<readonly CommitMemberRecord[]> {
      if (memberIds.length > 512)
        throw new RangeError("Member lookup exceeds 512");
      if (memberIds.length === 0) return [];
      const states = await hgetJsonMany<StoredMember>(memberIds.map(memberKey));
      return memberIds.flatMap((id, index) => {
        const state = states[index];
        return state ? [state.record] : [];
      });
    },

    async applyExclusionVerdicts(input: {
      readonly streamId: string;
      readonly verdicts: readonly {
        readonly memberId: string;
        readonly state: MemberExclusionState;
        readonly ruleId?: string;
        readonly policyVersion: string;
      }[];
      readonly now: number;
    }): Promise<void> {
      const verdicts = input.verdicts.map((verdict) => ({
        memberId: verdict.memberId,
        state: verdict.state,
        ruleId: verdict.ruleId ?? null,
        policyVersion: verdict.policyVersion,
      }));
      await evalScript(
        LUA_APPLY_EXCLUSION_VERDICTS,
        P,
        input.streamId,
        JSON.stringify(verdicts),
      );
    },

    async readRunnableWorkspaceHeads(
      now: number,
      limit: number,
    ): Promise<readonly WorkspaceHead[]> {
      // Bounded candidate scan: lowest notBefore first, then fairness order.
      const ids = (await redis.zrangebyscore(
        `${P}idx:ws:notBefore`,
        "-inf",
        String(now),
        "LIMIT",
        0,
        AUTO_COMMIT_BATCH_LIMITS.maxWorkspaceHeadsPerScan,
      )) as string[];
      const heads = (
        await hgetJsonMany<WorkspaceHead>(ids.map((id) => `${P}ws:${id}`))
      ).filter(
        (head): head is WorkspaceHead =>
          head !== undefined &&
          head.notBefore !== null &&
          head.notBefore <= now,
      );
      heads.sort((a, b) => a.fairnessSeq - b.fairnessSeq);
      return heads.slice(0, limit);
    },

    async readStreamHeads(
      workspaceId: string,
      limit: number,
    ): Promise<readonly StreamHead[]> {
      const dueIds = (await redis.zrange(
        `${P}ws:${workspaceId}:streamNb`,
        0,
        limit - 1,
      )) as string[];
      let ids = dueIds;
      if (ids.length < limit) {
        const nullIds = (await redis.zrangebylex(
          `${P}ws:${workspaceId}:streamNull`,
          "-",
          "+",
          "LIMIT",
          0,
          limit - ids.length,
        )) as string[];
        ids = [...ids, ...nullIds];
      }
      const heads = await hgetJsonMany<StreamHead>(ids.map(streamKey));
      return heads
        .filter((head): head is StreamHead => head !== undefined)
        .map(toStreamHead);
    },

    async readStreamHead(streamId: string): Promise<StreamHead | undefined> {
      const head = await hgetJson<StreamHead>(streamKey(streamId));
      return head ? toStreamHead(head) : undefined;
    },

    async readPendingMembers(
      streamId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<CommitMemberRecord>> {
      const key = `${P}stream:${streamId}:pending`;
      const min = cursor === null ? "-" : `(${lexMemberFromCursor(cursor)}`;
      const lexMembers = (await redis.zrangebylex(
        key,
        min,
        "+",
        "LIMIT",
        0,
        limit,
      )) as string[];
      const memberIds = lexMembers.map((entry) => entry.slice(-64));
      const states = await hgetJsonMany<StoredMember>(memberIds.map(memberKey));
      const items = states
        .filter((state): state is StoredMember => state !== undefined)
        .map((state) => state.record);
      const last = lexMembers[lexMembers.length - 1];
      return {
        items,
        nextCursor:
          lexMembers.length === limit && last
            ? cursorFromLexMember(last)
            : null,
      };
    },

    async readStreamReceipts(
      streamId: string,
      fromSeq: number,
      toSeq: number,
      limit: number,
    ): Promise<readonly AutoCommitReceipt[]> {
      const ids = (await redis.zrangebyscore(
        `${P}stream:${streamId}:receipts`,
        `(${fromSeq}`,
        String(toSeq),
        "LIMIT",
        0,
        limit,
      )) as string[];
      const receipts = await hgetJsonMany<StoredReceipt>(ids.map(receiptKey));
      return receipts
        .filter((receipt): receipt is StoredReceipt => receipt !== undefined)
        .map(toReceipt);
    },

    async readMemberReceipts(
      memberId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<string>> {
      const min = cursor === null ? "-" : `(${cursor}`;
      const ids = (await redis.zrangebylex(
        `${P}member:${memberId}:receipts`,
        min,
        "+",
        "LIMIT",
        0,
        limit,
      )) as string[];
      const last = ids[ids.length - 1];
      return {
        items: ids,
        nextCursor: ids.length === limit && last ? last : null,
      };
    },

    async readReceiptMembers(
      receiptId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<CommitMemberRecord>> {
      const min = cursor === null ? "-" : `(${cursor}`;
      const ids = (await redis.zrangebylex(
        `${P}receipt:${receiptId}:members`,
        min,
        "+",
        "LIMIT",
        0,
        limit,
      )) as string[];
      const states = await hgetJsonMany<StoredMember>(ids.map(memberKey));
      const items = states
        .filter((state): state is StoredMember => state !== undefined)
        .map((state) => state.record);
      const last = ids[ids.length - 1];
      return { items, nextCursor: ids.length === limit && last ? last : null };
    },

    async acquireStreamReservation(
      streamId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
    ): Promise<StreamReservation | undefined> {
      const token = `${ownerId}-${randomUUID()}`;
      const raw = (await evalScript(
        LUA_ACQUIRE_RESERVATION,
        P,
        streamId,
        ownerId,
        token,
        now + ttlMs,
        now,
      )) as string | null;
      return raw === null ? undefined : (JSON.parse(raw) as StreamReservation);
    },

    async renewStreamReservation(
      streamId: string,
      token: string,
      ttlMs: number,
      now: number,
    ): Promise<boolean> {
      const raw = (await evalScript(
        LUA_RENEW_RESERVATION,
        P,
        streamId,
        token,
        now + ttlMs,
        now,
      )) as number;
      return raw === 1;
    },

    async releaseStreamReservation(
      streamId: string,
      token: string,
      _now: number,
    ): Promise<void> {
      await evalScript(LUA_RELEASE_RESERVATION, P, streamId, token);
    },

    async updateStreamHead(
      streamId: string,
      expectedVersion: number,
      update: StreamHeadUpdate,
      _now: number,
    ): Promise<boolean> {
      const raw = (await evalScript(
        LUA_UPDATE_STREAM_HEAD,
        P,
        streamId,
        expectedVersion,
        update.notBefore !== undefined ? "1" : "0",
        update.notBefore === undefined || update.notBefore === null
          ? ""
          : update.notBefore,
        update.coverageCursor !== undefined ? "1" : "0",
        update.coverageCursor ?? "",
        update.historyGeneration !== undefined ? "1" : "0",
        update.historyGeneration ?? "",
        update.resumeNotBefore !== undefined ? "1" : "0",
        update.resumeNotBefore === undefined || update.resumeNotBefore === null
          ? ""
          : update.resumeNotBefore,
        update.assemblyCutSeq !== undefined ? "1" : "0",
        update.assemblyCutSeq === undefined || update.assemblyCutSeq === null
          ? ""
          : update.assemblyCutSeq,
        update.assemblyAt !== undefined ? "1" : "0",
        update.assemblyAt === undefined || update.assemblyAt === null
          ? ""
          : update.assemblyAt,
      )) as number;
      return raw === 1;
    },

    async rotateWorkspaceFairness(
      workspaceId: string,
      _now: number,
    ): Promise<void> {
      await evalScript(LUA_ROTATE_FAIRNESS, P, workspaceId);
    },

    async sealBatch(input: SealBatchInput): Promise<SealBatchResult> {
      const raw = (await evalScript(
        LUA_SEAL_BATCH,
        P,
        JSON.stringify(input),
      )) as string;
      return JSON.parse(raw) as SealBatchResult;
    },

    async claimDispatch(
      now: number,
      ownerId: string,
      limit: number,
    ): Promise<readonly ClaimedDispatch[]> {
      if (limit <= 0) return [];
      const fetchN = Math.min(limit * CLAIM_SCAN_MULTIPLIER, CLAIM_SCAN_CAP);
      const tokens = Array.from(
        { length: limit },
        () => `${ownerId}-${randomUUID()}`,
      );
      const raw = (await evalScript(
        LUA_CLAIM_DISPATCH,
        P,
        now,
        limit,
        fetchN,
        JSON.stringify(tokens),
      )) as string[];
      const claimed: ClaimedDispatch[] = [];
      const batchIds: string[] = [];
      for (let i = 0; i + 1 < raw.length; i += 2) {
        batchIds.push(raw[i] as string);
      }
      const batches = await hgetJsonMany<CommitBatchRecord>(
        batchIds.map((id) => `${P}batch:${id}`),
      );
      for (let i = 0; i < batchIds.length; i += 1) {
        const batch = batches[i];
        if (batch) {
          claimed.push({ batch, claimToken: raw[i * 2 + 1] as string });
        }
      }
      return claimed;
    },

    async confirmDispatch(
      batchId: string,
      claimToken: string,
      now: number,
    ): Promise<void> {
      await evalScript(LUA_CONFIRM_DISPATCH, P, batchId, claimToken, now);
    },

    async abortDispatch(
      batchId: string,
      claimToken: string,
      nextAttemptAt: number,
      _now: number,
    ): Promise<void> {
      await evalScript(
        LUA_ABORT_DISPATCH,
        P,
        batchId,
        claimToken,
        nextAttemptAt,
      );
    },

    async startBatchExecution(
      batchId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
      limits = { global: 1, workspace: 1 },
    ): Promise<string | undefined> {
      const token = `${ownerId}-${randomUUID()}`;
      const raw = (await evalScript(
        LUA_START_EXECUTION,
        P,
        batchId,
        ownerId,
        token,
        now + ttlMs,
        now,
        limits.global,
        limits.workspace,
      )) as string | null;
      return raw === null ? undefined : raw;
    },

    async deferBatchExecution(
      batchId: string,
      nextAttemptAt: number,
    ): Promise<void> {
      await evalScript(LUA_DEFER_BATCH, P, batchId, nextAttemptAt);
    },

    async checkpointBatchExecution(
      batchId: string,
      token: string,
      checkpoint: BatchExecutionCheckpoint,
      now: number,
    ): Promise<boolean> {
      const json = JSON.stringify(checkpoint);
      if (Buffer.byteLength(json) > 1_048_576)
        throw new RangeError("Execution checkpoint exceeds 1 MiB");
      const raw = await evalScript(
        LUA_PRELUDE +
          `
local raw = redis.call("HGET", kBatch(ARGV[2]), "data")
if not raw then return 0 end
local rec = cjson.decode(raw)
if rec.status ~= "running" or rec.leaseToken ~= ARGV[3] or isNull(rec.leaseExpiry) or rec.leaseExpiry <= tonumber(ARGV[5]) then return 0 end
rec.executionCheckpoint = cjson.decode(ARGV[4])
saveBatch(rec)
return 1
`,
        P,
        batchId,
        token,
        json,
        now,
      );
      return raw === 1;
    },

    async renewBatchLease(
      batchId: string,
      token: string,
      ttlMs: number,
      now: number,
    ): Promise<boolean> {
      const raw = (await evalScript(
        LUA_RENEW_BATCH_LEASE,
        P,
        batchId,
        token,
        now + ttlMs,
        now,
      )) as number;
      return raw === 1;
    },

    async completeBatch(
      batchId: string,
      token: string,
      completion: BatchCompletion,
      now: number,
    ): Promise<void> {
      await evalScript(
        LUA_COMPLETE_BATCH,
        P,
        batchId,
        token,
        completion.outcome,
        completion.outcome === "skipped" ? completion.reason : "",
        now,
      );
    },

    async failBatch(
      batchId: string,
      token: string,
      error: string,
      retryNotBefore: number | null,
      dead: boolean,
      now: number,
    ): Promise<void> {
      await evalScript(
        LUA_FAIL_BATCH,
        P,
        batchId,
        token,
        error,
        retryNotBefore === null ? "" : retryNotBefore,
        dead ? "1" : "0",
        now,
      );
    },

    async reclaimExpiredBatchLeases(
      now: number,
      limit: number,
    ): Promise<readonly string[]> {
      const raw = (await evalScript(
        LUA_RECLAIM_LEASES,
        P,
        now,
        limit,
      )) as string[];
      return raw;
    },

    async readBatch(batchId: string): Promise<CommitBatchRecord | undefined> {
      return hgetJson<CommitBatchRecord>(`${P}batch:${batchId}`);
    },

    async getReceipt(
      receiptId: string,
    ): Promise<ReceiptQueryResult | undefined> {
      const receipt = await hgetJson<StoredReceipt>(receiptKey(receiptId));
      if (!receipt) return undefined;
      const memberIds = (await redis.zrangebylex(
        `${P}receipt:${receiptId}:members`,
        "-",
        "+",
      )) as string[];
      const states = await hgetJsonMany<StoredMember>(memberIds.map(memberKey));
      const counts: Record<string, number> = {
        pending: 0,
        batched: 0,
        completed: 0,
        skipped: 0,
        dead: 0,
        failed: 0,
      };
      for (const state of states) {
        if (state) {
          counts[state.record.status] = (counts[state.record.status] ?? 0) + 1;
        }
      }
      return {
        receipt: toReceipt(receipt),
        memberCounts: counts as ReceiptQueryResult["memberCounts"],
      };
    },

    async readNextWake(): Promise<NextWake | undefined> {
      const [wsMin, outboxMin, leaseMin, routingMin] = (await Promise.all([
        redis.zrange(`${P}idx:ws:notBefore`, 0, 0, "WITHSCORES"),
        redis.zrange(`${P}idx:outbox`, 0, 0, "WITHSCORES"),
        redis.zrange(`${P}idx:lease`, 0, 0, "WITHSCORES"),
        redis.zrange(`${P}idx:routing:due`, 0, 0, "WITHSCORES"),
      ])) as [string[], string[], string[], string[]];
      let best: NextWake | undefined;
      const consider = (entry: string[], reason: NextWake["reason"]) => {
        if (entry.length < 2) return;
        const at = Number(entry[1]);
        if (!best || at < best.at) {
          best = { at, reason };
        }
      };
      consider(wsMin, "delay");
      consider(outboxMin, "outbox_dispatch");
      consider(leaseMin, "lease_reclaim");
      consider(routingMin, "routing_resolution");
      return best;
    },

    close(): void {
      void (redis.quit() as Promise<unknown>).catch(() => undefined);
    },
  };
}

/**
 * Admin session authentication (P2 item 97).
 *
 * Sessions are durable and multi-process consistent: only the sha256 hash of
 * the bearer token is persisted (S12 — a token is never stored plaintext),
 * with the TTL enforced at read time. Login on one replica is visible to all
 * others, and logout revokes immediately everywhere because both operations
 * hit the shared session store (any ConfigStore backend).
 *
 * The Bearer wire protocol is unchanged: clients see opaque tokens and the
 * same 401 responses; only the storage layer moved off the process-local Map.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AdminSessionRecord } from "@aicr/core";
import type { Context, Next } from "hono";

export interface AdminAuthConfig {
  readonly username: string;
  readonly password?: string;
  readonly passwordHash?: string;
  readonly sessionTtlSeconds: number;
}

export interface AdminSession {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Durable session storage. Structurally the session slice of the core
 * ConfigStore contract; any backend (memory/sqlite/postgres/redis) satisfies
 * it, which keeps tests on the memory backend honest about the same semantics.
 */
export interface AdminSessionStore {
  saveAdminSession(record: AdminSessionRecord): Promise<void>;
  readAdminSession(tokenHash: string, now: number): Promise<AdminSessionRecord | null>;
  deleteAdminSession(tokenHash: string): Promise<void>;
  deleteExpiredAdminSessions(now: number, limit?: number): Promise<number>;
}

export interface AdminAuthContext {
  readonly config: AdminAuthConfig;
  readonly sessions: AdminSessionStore;
  /** Injectable clock; defaults to wall time. */
  readonly now?: (() => number) | undefined;
}

const SESSION_TOKEN_BYTES = 32;
const BEARER_PREFIX = "bearer ";
const SHA256_PREFIX = "sha256:";
const EXPIRED_SWEEP_LIMIT = 500;

function hashPassword(password: string): string {
  return `${SHA256_PREFIX}${createHash("sha256").update(password).digest("hex")}`;
}

/** Token identity seen by the store; the plaintext token never persists. */
export function hashAdminSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function verifyPassword(input: string, stored: string, storedIsHash: boolean): boolean {
  const inputSecret = storedIsHash ? hashPassword(input) : input;
  return constantTimeStringEqual(inputSecret, stored);
}

function clockOf(context: AdminAuthContext): () => number {
  return context.now ?? Date.now;
}

export async function createAdminSession(
  context: AdminAuthContext,
  username: string,
  password: string,
): Promise<AdminSession | null> {
  const { config } = context;
  if (username !== config.username) return null;

  const storedSecret = config.passwordHash ?? config.password;
  if (!storedSecret) return null;
  if (!verifyPassword(password, storedSecret, config.passwordHash !== undefined)) return null;

  const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
  const now = clockOf(context)();
  const expiresAt = now + config.sessionTtlSeconds * 1000;
  await context.sessions.saveAdminSession({
    tokenHash: hashAdminSessionToken(token),
    createdAt: now,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function validateAdminSession(context: AdminAuthContext, token: string): Promise<boolean> {
  const record = await context.sessions.readAdminSession(hashAdminSessionToken(token), clockOf(context)());
  return record !== null;
}

export async function revokeAdminSession(context: AdminAuthContext, token: string): Promise<void> {
  await context.sessions.deleteAdminSession(hashAdminSessionToken(token));
}

export function createAdminAuthMiddleware(context: AdminAuthContext) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const authorization = c.req.header("authorization");
    if (!authorization || !authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
      return c.json({ error: "unauthorized", message: "Admin authentication required." }, 401);
    }

    const token = authorization.slice(BEARER_PREFIX.length);
    if (!(await validateAdminSession(context, token))) {
      return c.json({ error: "unauthorized", message: "Invalid or expired session." }, 401);
    }

    await next();
  };
}

/** Bounded sweep of expired rows; reads already treat expired as absent. */
export async function cleanupExpiredSessions(context: AdminAuthContext): Promise<number> {
  return context.sessions.deleteExpiredAdminSessions(clockOf(context)(), EXPIRED_SWEEP_LIMIT);
}

export function resolveAdminAuthConfig(
  _config: Record<string, unknown>,
  envLookup: (name: string) => string | undefined,
): AdminAuthConfig | undefined {
  const admin = _config.admin as Record<string, unknown> | undefined;
  if (!admin || typeof admin !== "object") return undefined;

  const usernameEnv = admin.username_env as string | undefined;
  const passwordEnv = admin.password_env as string | undefined;
  const passwordHashEnv = admin.password_hash_env as string | undefined;
  const ttlSeconds = admin.session_ttl_seconds as number | undefined;

  const username = usernameEnv ? envLookup(usernameEnv) : undefined;
  const password = passwordEnv ? envLookup(passwordEnv) : undefined;
  const passwordHash = passwordHashEnv ? envLookup(passwordHashEnv) : undefined;

  if (!username || (!password && !passwordHash)) return undefined;

  return {
    username,
    ...(password ? { password } : {}),
    ...(passwordHash ? { passwordHash } : {}),
    sessionTtlSeconds: ttlSeconds ?? 86400,
  };
}

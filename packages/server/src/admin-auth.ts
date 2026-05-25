import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

const SESSION_TOKEN_BYTES = 32;
const sessions = new Map<string, AdminSession>();

const BEARER_PREFIX = "bearer ";
const SHA256_PREFIX = "sha256:";

function hashPassword(password: string): string {
  return `${SHA256_PREFIX}${createHash("sha256").update(password).digest("hex")}`;
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

export function createAdminSession(config: AdminAuthConfig, username: string, password: string): AdminSession | null {
  if (username !== config.username) return null;

  const storedSecret = config.passwordHash ?? config.password;
  if (!storedSecret) return null;
  if (!verifyPassword(password, storedSecret, config.passwordHash !== undefined)) return null;

  const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
  const session: AdminSession = {
    token,
    expiresAt: Date.now() + config.sessionTtlSeconds * 1000,
  };
  sessions.set(token, session);
  return session;
}

export function validateAdminSession(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function revokeAdminSession(token: string): void {
  sessions.delete(token);
}

export function createAdminAuthMiddleware(_config: AdminAuthConfig) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const authorization = c.req.header("authorization");
    if (!authorization || !authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
      return c.json({ error: "unauthorized", message: "Admin authentication required." }, 401);
    }

    const token = authorization.slice(BEARER_PREFIX.length);
    if (!validateAdminSession(token)) {
      return c.json({ error: "unauthorized", message: "Invalid or expired session." }, 401);
    }

    await next();
  };
}

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
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

import { createHash } from "node:crypto";

import { createMemoryConfigStore } from "@aicr/core";
import { describe, expect, it } from "vitest";

import {
  cleanupExpiredSessions,
  createAdminSession,
  hashAdminSessionToken,
  revokeAdminSession,
  validateAdminSession,
  type AdminAuthConfig,
  type AdminAuthContext,
  type AdminSessionStore,
  resolveAdminAuthConfig,
} from "../src/admin-auth.js";

const TEST_CONFIG: AdminAuthConfig = {
  username: "admin",
  password: "test-password-123",
  sessionTtlSeconds: 3600,
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function makeContext(overrides: Partial<AdminAuthContext> = {}, store?: AdminSessionStore): AdminAuthContext {
  return {
    config: TEST_CONFIG,
    sessions: store ?? createMemoryConfigStore(),
    ...overrides,
  };
}

describe("admin auth", () => {
  it("creates session with valid credentials", async () => {
    const context = makeContext();
    const session = await createAdminSession(context, "admin", "test-password-123");
    expect(session).not.toBeNull();
    expect(session?.token).toHaveLength(64);
    expect(session?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects wrong username", async () => {
    const session = await createAdminSession(makeContext(), "wrong", "test-password-123");
    expect(session).toBeNull();
  });

  it("rejects wrong password", async () => {
    const session = await createAdminSession(makeContext(), "admin", "wrong-password");
    expect(session).toBeNull();
  });

  it("validates active session token", async () => {
    const context = makeContext();
    const session = await createAdminSession(context, "admin", "test-password-123");
    expect(session).not.toBeNull();
    expect(await validateAdminSession(context, session!.token)).toBe(true);
  });

  it("rejects invalid session token", async () => {
    expect(await validateAdminSession(makeContext(), "nonexistent")).toBe(false);
  });

  it("rejects revoked session token", async () => {
    const context = makeContext();
    const session = await createAdminSession(context, "admin", "test-password-123");
    await revokeAdminSession(context, session!.token);
    expect(await validateAdminSession(context, session!.token)).toBe(false);
  });

  it("stores only the token hash, never the plaintext token (S12)", async () => {
    const store = createMemoryConfigStore();
    const context = makeContext({}, store);
    const session = await createAdminSession(context, "admin", "test-password-123");
    const tokenHash = hashAdminSessionToken(session!.token);
    expect(tokenHash).toBe(sha256(session!.token));
    // The store record is addressable only by the hash.
    const record = await store.readAdminSession(tokenHash, Date.now());
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain(session!.token);
  });

  it("shares login and logout across processes via the durable store", async () => {
    // Two contexts = two replicas; one shared backend.
    const store = createMemoryConfigStore();
    const replicaA = makeContext({}, store);
    const replicaB = makeContext({}, store);
    const session = await createAdminSession(replicaA, "admin", "test-password-123");
    expect(await validateAdminSession(replicaB, session!.token)).toBe(true);
    await revokeAdminSession(replicaB, session!.token);
    expect(await validateAdminSession(replicaA, session!.token)).toBe(false);
  });

  it("rejects expired sessions and sweeps them in bounded batches", async () => {
    let now = 1_800_000_000_000;
    const store = createMemoryConfigStore();
    const context = makeContext({ now: () => now }, store);
    const session = await createAdminSession(context, "admin", "test-password-123");
    now += 3600 * 1000 + 1;
    expect(await validateAdminSession(context, session!.token)).toBe(false);
    expect(await cleanupExpiredSessions(context)).toBe(1);
    expect(await cleanupExpiredSessions(context)).toBe(0);
  });

  it("supports password hash verification", async () => {
    const hashConfig: AdminAuthConfig = {
      username: "admin",
      passwordHash: `sha256:${sha256("secret-password")}`,
      sessionTtlSeconds: 3600,
    };
    const context = makeContext({ config: hashConfig });
    expect(await createAdminSession(context, "admin", "secret-password")).not.toBeNull();
    expect(await createAdminSession(context, "admin", "wrong")).toBeNull();
  });

  it("treats password_env as a raw password even when it has a hash-like prefix", async () => {
    const rawConfig: AdminAuthConfig = {
      username: "admin",
      password: "sha256:notreallyahash",
      sessionTtlSeconds: 3600,
    };
    const context = makeContext({ config: rawConfig });
    expect(await createAdminSession(context, "admin", "sha256:notreallyahash")).not.toBeNull();
    expect(await createAdminSession(context, "admin", "notreallyahash")).toBeNull();
  });

  it("resolves admin auth config from env", () => {
    const config = resolveAdminAuthConfig(
      {
        admin: {
          username_env: "AICR_ADMIN_USER",
          password_env: "AICR_ADMIN_PASS",
          session_ttl_seconds: 7200,
        },
      },
      (name) => ({ AICR_ADMIN_USER: "root", AICR_ADMIN_PASS: "s3cret" })[name],
    );
    expect(config).toEqual({ username: "root", password: "s3cret", sessionTtlSeconds: 7200 });
  });

  it("resolves admin auth config with hash-only secret", () => {
    const config = resolveAdminAuthConfig(
      {
        admin: {
          username_env: "AICR_ADMIN_USER",
          password_hash_env: "AICR_ADMIN_HASH",
        },
      },
      (name) => ({ AICR_ADMIN_USER: "root", AICR_ADMIN_HASH: "sha256:abc" })[name],
    );
    expect(config).toEqual({ username: "root", passwordHash: "sha256:abc", sessionTtlSeconds: 86400 });
  });

  it("uses default admin env variable names from parsed config", () => {
    const config = resolveAdminAuthConfig(
      {
        admin: {
          username_env: "AICR_ADMIN_USER",
          password_env: "AICR_ADMIN_PASS",
        },
      },
      (name) => ({ AICR_ADMIN_USER: "root", AICR_ADMIN_PASS: "s3cret" })[name],
    );
    expect(config?.sessionTtlSeconds).toBe(86400);
  });

  it("returns undefined when username or password not set", () => {
    expect(resolveAdminAuthConfig({ admin: {} }, () => undefined)).toBeUndefined();
    expect(
      resolveAdminAuthConfig(
        { admin: { username_env: "AICR_ADMIN_USER" } },
        (name) => ({ AICR_ADMIN_USER: "root" })[name],
      ),
    ).toBeUndefined();
  });
});

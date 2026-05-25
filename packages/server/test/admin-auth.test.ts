import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  createAdminSession,
  validateAdminSession,
  revokeAdminSession,
  resolveAdminAuthConfig,
  cleanupExpiredSessions,
  type AdminAuthConfig,
} from "../src/admin-auth.js";

const TEST_CONFIG: AdminAuthConfig = {
  username: "admin",
  password: "test-password-123",
  sessionTtlSeconds: 3600,
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("admin auth", () => {
  beforeEach(() => {
    cleanupExpiredSessions();
  });

  it("creates session with valid credentials", () => {
    const session = createAdminSession(TEST_CONFIG, "admin", "test-password-123");
    expect(session).not.toBeNull();
    expect(session!.token).toBeDefined();
    expect(session!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects wrong username", () => {
    const session = createAdminSession(TEST_CONFIG, "wrong", "test-password-123");
    expect(session).toBeNull();
  });

  it("rejects wrong password", () => {
    const session = createAdminSession(TEST_CONFIG, "admin", "wrong");
    expect(session).toBeNull();
  });

  it("validates active session token", () => {
    const session = createAdminSession(TEST_CONFIG, "admin", "test-password-123");
    expect(validateAdminSession(session!.token)).toBe(true);
  });

  it("rejects invalid session token", () => {
    expect(validateAdminSession("nonexistent")).toBe(false);
  });

  it("rejects revoked session token", () => {
    const session = createAdminSession(TEST_CONFIG, "admin", "test-password-123");
    revokeAdminSession(session!.token);
    expect(validateAdminSession(session!.token)).toBe(false);
  });

  it("supports password hash verification", () => {
    const config: AdminAuthConfig = {
      username: TEST_CONFIG.username,
      sessionTtlSeconds: TEST_CONFIG.sessionTtlSeconds,
      passwordHash: "sha256:" + sha256("test-password-123"),
    };
    const session = createAdminSession(config, "admin", "test-password-123");
    expect(session).not.toBeNull();
  });

  it("treats password_env as a raw password even when it has a hash-like prefix", () => {
    const config: AdminAuthConfig = {
      username: "admin",
      password: "sha256:not-a-password-hash",
      sessionTtlSeconds: 3600,
    };

    const session = createAdminSession(config, "admin", "sha256:not-a-password-hash");
    expect(session).not.toBeNull();
  });

  it("resolves admin auth config from env", () => {
    const config = resolveAdminAuthConfig(
      { admin: { username_env: "USER", password_env: "PASS", session_ttl_seconds: 7200 } },
      (name) => (name === "USER" ? "admin" : name === "PASS" ? "secret" : undefined),
    );
    expect(config).toBeDefined();
    expect(config!.username).toBe("admin");
    expect(config!.password).toBe("secret");
    expect(config!.sessionTtlSeconds).toBe(7200);
  });

  it("resolves admin auth config with hash-only secret", () => {
    const config = resolveAdminAuthConfig(
      {
        admin: {
          username_env: "USER",
          password_hash_env: "PASS_HASH",
          session_ttl_seconds: 7200,
        },
      },
      (name) => (name === "USER" ? "admin" : name === "PASS_HASH" ? "sha256:" + sha256("secret") : undefined),
    );

    expect(config).toBeDefined();
    expect(config!.username).toBe("admin");
    expect(config!.password).toBeUndefined();
    expect(config!.passwordHash).toBe("sha256:" + sha256("secret"));
    expect(createAdminSession(config!, "admin", "secret")).not.toBeNull();
  });

  it("uses default admin env variable names from parsed config", () => {
    const config = resolveAdminAuthConfig(
      {
        admin: {
          username_env: "AICR_ADMIN_USERNAME",
          password_env: "AICR_ADMIN_PASSWORD",
          session_ttl_seconds: 86400,
        },
      },
      (name) => (name === "AICR_ADMIN_USERNAME" ? "admin" : name === "AICR_ADMIN_PASSWORD" ? "secret" : undefined),
    );

    expect(config).toMatchObject({
      username: "admin",
      password: "secret",
      sessionTtlSeconds: 86400,
    });
  });

  it("returns undefined when username or password not set", () => {
    const config = resolveAdminAuthConfig(
      { admin: { username_env: "MISSING", password_env: "MISSING2" } },
      () => undefined,
    );
    expect(config).toBeUndefined();
  });
});

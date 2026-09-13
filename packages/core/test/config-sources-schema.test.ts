/**
 * config_sources schema tests (P4): the dynamic-config switch is
 * bootstrap-owned, defaults to file-only, and a redis backend requires the
 * shared storage.cache.redis connection declaration.
 */
import { describe, expect, it } from "vitest";

import {
  appConfigSchema,
  configSourcesSchema,
  effectiveConfigV2Schema,
  mergeConfigLayers,
} from "../src/config.js";

describe("configSourcesSchema", () => {
  it("defaults to a disabled database source with the default namespace", () => {
    const parsed = configSourcesSchema.parse({});
    expect(parsed).toEqual({
      database: { enabled: false, backend: "storage", namespace: "default" },
      runtime: { refresh_interval_seconds: 5 },
    });
  });

  it("accepts an enabled storage backend with a custom namespace", () => {
    const parsed = configSourcesSchema.parse({
      database: { enabled: true, backend: "storage", namespace: "team-a" },
      runtime: { refresh_interval_seconds: 30 },
    });
    expect(parsed.database.enabled).toBe(true);
    expect(parsed.database.namespace).toBe("team-a");
    expect(parsed.runtime.refresh_interval_seconds).toBe(30);
  });

  it("rejects unknown backends and the memory backend", () => {
    expect(() => configSourcesSchema.parse({ database: { enabled: true, backend: "memory" } })).toThrow();
    expect(() => configSourcesSchema.parse({ database: { enabled: true, backend: "sqlite" } })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => configSourcesSchema.parse({ migrations: { mode: "auto" } })).toThrow();
  });

  it("empty app config materializes the disabled file-only defaults", () => {
    const merged = mergeConfigLayers({});
    expect(merged.config_sources.database.enabled).toBe(false);
    expect(merged.config_sources.database.backend).toBe("storage");
    expect(merged.config_sources.database.namespace).toBe("default");
    expect(merged.config_sources.runtime.refresh_interval_seconds).toBe(5);
  });
});

describe("config_sources redis refinement", () => {
  it("rejects a redis config backend without storage.cache.redis", () => {
    const result = appConfigSchema.safeParse({
      config_sources: { database: { enabled: true, backend: "redis" } },
      storage: { cache: { kind: "memory" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(" | ");
      expect(messages).toContain("config_sources.database.backend 'redis' requires storage.cache.kind 'redis'");
    }
  });

  it("rejects a redis config backend when the cache is redis but url_env is missing", () => {
    const result = appConfigSchema.safeParse({
      config_sources: { database: { enabled: true, backend: "redis" } },
      storage: { cache: { kind: "redis" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(" | ");
      expect(messages).toContain("requires storage.cache.redis.url_env");
    }
  });

  it("accepts a redis config backend with a declared cache connection", () => {
    const result = effectiveConfigV2Schema.safeParse({
      config_sources: { database: { enabled: true, backend: "redis", namespace: "ops" } },
      storage: { cache: { kind: "redis", redis: { url_env: "AICR_REDIS_URL" } } },
    });
    expect(result.success).toBe(true);
  });

  it("storage backend needs no cache declaration", () => {
    const result = appConfigSchema.safeParse({
      config_sources: { database: { enabled: true, backend: "storage" } },
    });
    expect(result.success).toBe(true);
  });
});

it.each(["invalid namespace", "../escape", "a".repeat(65)])("rejects namespace %s before bootstrap and API mounting", (namespace) => {
  expect(() => configSourcesSchema.parse({ database: { namespace } })).toThrow();
});

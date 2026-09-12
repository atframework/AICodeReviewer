import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../src/config-format.js";
import type { ConfigStore } from "../src/config-store.js";
import { createConfigStoreFromDatabaseConfig, type DatabaseStorageConfig } from "../src/config-store-factory.js";
import { createPgConfigStore } from "../src/pg-config-store.js";

// The PG backend needs a live server; the factory's contract under test is
// backend selection and DSN resolution, so the store constructor is stubbed
// and the resolved connection is asserted.
vi.mock("../src/pg-config-store.js", () => ({
  createPgConfigStore: vi.fn(),
}));

const pgMock = vi.mocked(createPgConfigStore);
const ENV_NAME = "AICR_TEST_FACTORY_PG_URL";

function pgDatabase(postgres: Record<string, unknown>): DatabaseStorageConfig {
  return {
    kind: "postgres",
    migrate: "verify",
    sqlite: { path: "unused.sqlite" },
    postgres,
  } as unknown as DatabaseStorageConfig;
}

function stubPgStore(): void {
  pgMock.mockResolvedValue({ backendKind: "postgres" } as unknown as ConfigStore);
}

afterEach(() => {
  pgMock.mockReset();
  delete process.env[ENV_NAME];
});

describe("createConfigStoreFromDatabaseConfig postgres DSN resolution", () => {
  it("resolves the DSN from url_env", async () => {
    process.env[ENV_NAME] = "postgres://env-host/db";
    stubPgStore();

    await createConfigStoreFromDatabaseConfig(pgDatabase({ url_env: ENV_NAME }), (name) => process.env[name]);

    expect(pgMock).toHaveBeenCalledWith({ connection: { url: "postgres://env-host/db" }, migrationMode: "verify" });
  });

  it("falls back to postgres.url when url_env is absent", async () => {
    stubPgStore();

    await createConfigStoreFromDatabaseConfig(pgDatabase({ url: "postgres://plain-host/db" }), () => undefined);

    expect(pgMock).toHaveBeenCalledWith({ connection: { url: "postgres://plain-host/db" }, migrationMode: "verify" });
  });

  it("falls back to postgres.url when url_env does not resolve", async () => {
    stubPgStore();

    await createConfigStoreFromDatabaseConfig(
      pgDatabase({ url_env: ENV_NAME, url: "postgres://plain-host/db" }),
      () => undefined,
    );

    expect(pgMock).toHaveBeenCalledWith({ connection: { url: "postgres://plain-host/db" }, migrationMode: "verify" });
  });

  it("prefers a resolved url_env over postgres.url", async () => {
    process.env[ENV_NAME] = "postgres://env-host/db";
    stubPgStore();

    await createConfigStoreFromDatabaseConfig(
      pgDatabase({ url_env: ENV_NAME, url: "postgres://plain-host/db" }),
      (name) => process.env[name],
    );

    expect(pgMock).toHaveBeenCalledWith({ connection: { url: "postgres://env-host/db" }, migrationMode: "verify" });
  });

  it("rejects before opening a store when neither source resolves", async () => {
    await expect(
      createConfigStoreFromDatabaseConfig(pgDatabase({}), () => undefined),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ConfigError && error.code === "store_unavailable" && error.message.includes("url_env"),
    );
    expect(pgMock).not.toHaveBeenCalled();
  });

  it("rejects when url_env names an unset variable and no url fallback exists", async () => {
    await expect(
      createConfigStoreFromDatabaseConfig(pgDatabase({ url_env: ENV_NAME }), () => undefined),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ConfigError && error.code === "store_unavailable" && error.message.includes(ENV_NAME),
    );
    expect(pgMock).not.toHaveBeenCalled();
  });
});

describe("createConfigStoreFromDatabaseConfig sqlite", () => {
  it("opens a sqlite store at the configured path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aicr-factory-"));
    try {
      const store = await createConfigStoreFromDatabaseConfig({
        kind: "sqlite",
        migrate: "auto",
        sqlite: { path: join(dir, "config.sqlite") },
      } as unknown as DatabaseStorageConfig);
      try {
        expect(store.backendKind).toBe("sqlite");
        await expect(store.readHead("ns")).resolves.toBeNull();
      } finally {
        await store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

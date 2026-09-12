/**
 * Selects the ConfigStore backend from the deployment's durable database
 * config (`storage.database`). This is the single switch P4 runtime wiring
 * and the migrate CLI reuse, so backend selection never forks across
 * consumers.
 *
 * `storage.database.migrate` gates startup migrations (M19): `auto` applies
 * pending steps at open, `verify` refuses to start while the ledger is
 * behind, drifted, or newer than this program.
 */

import { ConfigError } from "./config-format.js";
import type { AppConfig } from "./config.js";
import type { ConfigStore } from "./config-store.js";
import { createPgConfigStore } from "./pg-config-store.js";
import { createSqliteConfigStore } from "./sqlite-config-store.js";

export type DatabaseStorageConfig = AppConfig["storage"]["database"];

export async function createConfigStoreFromDatabaseConfig(
  database: DatabaseStorageConfig,
  envLookup: (name: string) => string | undefined = () => undefined,
): Promise<ConfigStore> {
  const migrationMode = database.migrate;
  if (database.kind === "sqlite") {
    return createSqliteConfigStore({ path: database.sqlite.path, migrationMode });
  }
  if (database.kind === "postgres") {
    const postgres = (database.postgres ?? {}) as Record<string, unknown>;
    const urlEnv = typeof postgres.url_env === "string" ? postgres.url_env : undefined;
    // `postgres.url` is honored as the fallback when `url_env` is absent or
    // unresolved, matching the business-store wiring in the server bootstrap.
    // The `storage.database` connection string is a pre-existing deployment
    // contract; spec §8.4's env-only secret boundary targets the new
    // config-source entity model, not this operational DSN.
    const url = (urlEnv !== undefined ? envLookup(urlEnv) : undefined)
      ?? (typeof postgres.url === "string" ? postgres.url : undefined);
    if (url === undefined) {
      throw new ConfigError(
        "store_unavailable",
        urlEnv === undefined
          ? "storage.database.kind=postgres requires postgres.url_env naming the connection-string variable (or a plaintext postgres.url)."
          : `storage.database.postgres.url_env points at "${urlEnv}" but it is not set, and no postgres.url fallback is configured; refusing to guess a DSN.`,
      );
    }
    return createPgConfigStore({ connection: { url }, migrationMode });
  }
  throw new ConfigError(
    "store_unavailable",
    `Unsupported storage.database.kind "${String((database as { kind?: unknown }).kind)}" for the config store.`,
  );
}

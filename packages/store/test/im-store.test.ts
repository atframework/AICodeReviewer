import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeStoreDb, createStoreDb, type SqliteStoreDb } from "../src/database.js";
import { STORE_SQLITE_MIGRATIONS } from "../src/database.js";
import { runImStoreConformance } from "./im-store-conformance.js";

/** IM-09 R01–R06 on the SQLite backend (real file database, real migrations). */

let tmpDir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "aicr-im-store-"));
  store = createStoreDb(join(tmpDir, "im.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("im store conformance [sqlite]", () => {
  it("accepts, merges, fences, dispatches and retains atomically (R02–R06)", async () => {
    await runImStoreConformance(store);
  });
});

describe("R01: migration registry", () => {
  it("ships the 011_im_tables step as the next append-only version", () => {
    const names = STORE_SQLITE_MIGRATIONS.map(step => step.name);
    expect(names).toContain("011_im_tables");
    expect(names.at(-1)).toBe("012_review_event");
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(12);
  });

  it("verifies an existing store without rewriting it", async () => {
    const verify = createStoreDb({ kind: "sqlite", path: join(tmpDir, "im.db"), migrationMode: "verify" });
    expect(verify.kind).toBe("sqlite");
    await closeStoreDb(verify);
  });
});

describe("fresh-store restart", () => {
  it("reopens an existing database with all IM tables intact", async () => {
    const { acceptImDelivery } = await import("../src/im-store.js");
    const delivery = {
      delivery: {
        namespace: `ns-${randomUUID()}`,
        connectionIdentity: "c",
        deliveryKind: "message" as const,
        deliveryKey: "k",
        payloadDigest: "sha256:1",
      },
      now: new Date(),
    };
    const first = await acceptImDelivery(store, delivery);
    expect(first).toMatchObject({ kind: "created" });
    const path = join(tmpDir, "im.db");
    await closeStoreDb(store);
    const reopened = createStoreDb(path);
    const again = await acceptImDelivery(reopened, delivery);
    expect(again).toMatchObject({ kind: "duplicate" });
    await closeStoreDb(reopened);
    // Restore the per-test handle for afterEach.
    store = createStoreDb(path) as typeof store;
    await acceptImDelivery(store, delivery);
  });
});

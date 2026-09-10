import { randomUUID } from "node:crypto";

import { parseModelsDevApiJson } from "@aicr/llm";
import { describe, expect, it } from "vitest";

import {
  createRedisModelCatalogBackend,
  type ModelCatalogBackend,
} from "../src/model-catalog-service.js";

const url = process.env.AICR_REDIS_TEST_URL;

describe.skipIf(!url)("model catalog with a real Redis connection", () => {
  it("reloads entries, source provenance and indexes through fresh connections without crossing namespaces", async () => {
    const prefix = `aicr-catalog-test:${randomUUID()}:`;
    const backends: ModelCatalogBackend[] = [];
    const open = async (keyPrefix = prefix) => {
      const backend = await createRedisModelCatalogBackend({
        url: url!,
        keyPrefix,
        scanCount: 1,
      });
      backends.push(backend);
      return backend;
    };
    const entries = [
      ...parseModelsDevApiJson({
        first: {
          id: "first",
          models: {
            shared: { id: "shared", limit: { context: 4096, output: 512 } },
          },
        },
        second: {
          id: "second",
          models: {
            shared: { id: "shared", limit: { context: 8192, output: 1024 } },
          },
        },
      }).values(),
    ];
    expect(entries).toHaveLength(2);
    const sourceUrl = "https://catalog.example.test/api.json?channel=local";
    const metadata = {
      lastRefreshedAt: new Date("2026-09-10T00:00:00Z"),
      etag: '"local-v1"',
    };
    try {
      const writer = await open();
      writer.upsertMany(entries, "remote");
      writer.setSourceMeta(sourceUrl, metadata);
      await writer.close?.();
      backends.splice(backends.indexOf(writer), 1);

      const reader = await open();
      expect(
        reader
          .getEntriesByModelId("shared")
          .map((value) => value.entry.catalogId)
          .sort(),
      ).toEqual(["first/shared", "second/shared"]);
      expect(reader.getEntry("first/shared")).toEqual({
        entry: entries[0],
        source: "remote",
      });
      expect(reader.getSourceMeta(sourceUrl)).toEqual(metadata);
      const isolated = await open(`${prefix}isolated:`);
      expect(isolated.getEntriesByModelId("shared")).toEqual([]);
      expect(isolated.getSourceMeta(sourceUrl)).toBeUndefined();

      // The model-id index must lose its old entry after a catalog correction,
      // and a new process must rebuild the same index from stored rows.
      reader.upsertMany([{ ...entries[0]!, modelId: "renamed" }], "override");
      await reader.flushPending?.();
      const reopened = await open();
      expect(
        reopened
          .getEntriesByModelId("shared")
          .map((value) => value.entry.catalogId),
      ).toEqual(["second/shared"]);
      expect(reopened.getEntriesByModelId("renamed")[0]?.source).toBe(
        "override",
      );
      expect(reopened.getSourceMeta(sourceUrl)).toEqual(metadata);
    } finally {
      await Promise.all(backends.map((backend) => backend.close?.()));
      // Each test owns a random prefix; never flush or mutate another namespace.
      const { Redis } = await import("ioredis");
      const cleanup = new Redis(url!);
      try {
        let cursor = "0";
        do {
          const [next, keys] = await cleanup.scan(
            cursor,
            "MATCH",
            `${prefix}*`,
            "COUNT",
            100,
          );
          if (keys.length) await cleanup.del(...keys);
          cursor = next;
        } while (cursor !== "0");
      } finally {
        await cleanup.quit();
      }
    }
  });
});

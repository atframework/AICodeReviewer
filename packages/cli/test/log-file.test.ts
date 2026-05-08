import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RotatingFileWriter } from "../src/log-file.js";

async function listLogFiles(logDir: string): Promise<string[]> {
  return (await readdir(logDir)).filter((name) => name.endsWith(".log")).sort();
}

describe("RotatingFileWriter", () => {
  it("tees logs to the current file and rotates by size while keeping at most the configured file count", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-log-writer-"));
    let tick = 0;

    try {
      const writer = new RotatingFileWriter({
        logDir: tempDir,
        fileName: "aicr.log",
        maxBytes: 10,
        maxFiles: 3,
        maxAgeDays: 7,
        now: () => new Date(Date.UTC(2026, 4, 8, 0, 0, tick++)),
      });

      writer.write("1234567890");
      writer.write("abcdefghij");
      writer.write("KLMNOPQRST");
      writer.write("uv");

      const files = await listLogFiles(tempDir);
      expect(files.length).toBeLessThanOrEqual(3);
      expect(files).toContain("aicr.log");
      expect(files.filter((file) => file.startsWith("aicr-")).length).toBeLessThanOrEqual(2);

      for (const file of files) {
        const stats = await stat(join(tempDir, file));
        expect(stats.size).toBeLessThanOrEqual(10);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes rotated logs older than the configured retention window", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-log-retention-"));

    try {
      const stalePath = join(tempDir, "aicr-2026-04-01T00-00-00-000Z.log");
      await writeFile(stalePath, "stale\n", "utf8");
      const staleDate = new Date(Date.UTC(2026, 3, 1));
      await utimes(stalePath, staleDate, staleDate);

      const writer = new RotatingFileWriter({
        logDir: tempDir,
        fileName: "aicr.log",
        maxBytes: 100,
        maxFiles: 3,
        maxAgeDays: 7,
        now: () => new Date(Date.UTC(2026, 4, 8)),
      });
      writer.write("fresh\n");

      const files = await listLogFiles(tempDir);
      expect(files).toEqual(["aicr.log"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces the active log file when it is older than the retention window", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-log-active-retention-"));

    try {
      const activePath = join(tempDir, "aicr.log");
      await writeFile(activePath, "old\n", "utf8");
      const staleDate = new Date(Date.UTC(2026, 3, 1));
      await utimes(activePath, staleDate, staleDate);

      const writer = new RotatingFileWriter({
        logDir: tempDir,
        fileName: "aicr.log",
        maxBytes: 100,
        maxFiles: 3,
        maxAgeDays: 7,
        now: () => new Date(Date.UTC(2026, 4, 8)),
      });
      writer.write("fresh\n");

      const files = await listLogFiles(tempDir);
      expect(files).toEqual(["aicr.log"]);
      await expect(readFile(activePath, "utf8")).resolves.toBe("fresh\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

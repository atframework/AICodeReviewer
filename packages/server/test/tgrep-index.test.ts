import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { resolveSearchTgrepConfig, type WorkspaceLayout } from "@aicr/core";
import {
  buildTgrepGuidance,
  TgrepIndexManager,
  type TgrepSearchHandle,
} from "../src/tgrep-index.js";

function layoutFor(root: string): WorkspaceLayout {
  return {
    kind: "isolated_v2",
    instanceRoot: root,
    sourceRoot: join(root, "source"),
    agentDir: join(root, "agent"),
    tmpDir: join(root, "tmp"),
    contextReposDir: join(root, "context-repos"),
    templatesDir: join(root, "templates"),
  } as WorkspaceLayout;
}

function fakeProcess(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdout?: EventEmitter & { pipe?: unknown };
    stderr?: EventEmitter;
    stdin?: unknown;
    unref: () => void;
    kill: (signal?: string) => void;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.kill = () => {};
  child.on("error", () => {});
  return child;
}

describe("TgrepIndexManager", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aicr-tgrep-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses one persistent cache root per workspace instance", () => {
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      logger: () => {},
    });
    const layout = layoutFor(root);
    expect(manager.cacheRootFor({ workspaceId: "w1", layout })).toBe(join(root, ".tgrep-cache"));
  });

  it("resolves documented defaults when the search section is absent", () => {
    const resolved = resolveSearchTgrepConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.dataDir).toBeUndefined();
    expect(resolved.indexTtlMs).toBe(86400 * 1000);
    expect(resolved.cleanupAfterMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(resolved.buildTimeoutMs).toBe(600 * 1000);
  });

  it("honors explicit overrides", () => {
    const resolved = resolveSearchTgrepConfig({
      tgrep: {
        enabled: false,
        data_dir: "/tmp/x",
        index_ttl_seconds: 60,
        cleanup_after_days: 1,
        build_timeout_seconds: 30,
      },
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.dataDir).toBe("/tmp/x");
    expect(resolved.indexTtlMs).toBe(60_000);
    expect(resolved.cleanupAfterMs).toBe(86400_000);
    expect(resolved.buildTimeoutMs).toBe(30_000);
  });

  it("returns a degraded handle when disabled", async () => {
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig({ tgrep: { enabled: false } }),
      logger: () => {},
    });
    const handle = await manager.prepare({
      workspaceId: "w1",
      layout: layoutFor(root),
      sourceRoot: join(root, "source"),
      revision: "abc",
    });
    expect(handle.state).toBe("degraded");
    expect(handle.detail).toBe("disabled");
  });

  it("degrades instead of failing the review when git is unavailable", async () => {
    const spawnProcess = vi.fn(() => {
      const child = fakeProcess();
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      return child;
    });
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      spawnProcess: spawnProcess as never,
      logger: () => {},
    });
    const handle = await manager.prepare({
      workspaceId: "w1",
      layout: layoutFor(root),
      sourceRoot: join(root, "source"),
      revision: "abc",
    });
    expect(handle.state).toBe("degraded");
  });

  it("sweeps only caches unused past the retention window", async () => {
    const now = Date.now();
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig({ tgrep: { cleanup_after_days: 7 } }),
      logger: () => {},
      now: () => now,
      isProcessAlive: () => false,
    });
    const staleRoot = join(root, "instances", "old", ".tgrep-cache");
    const freshRoot = join(root, "instances", "new", ".tgrep-cache");
    await mkdir(staleRoot, { recursive: true });
    await mkdir(freshRoot, { recursive: true });
    await writeFile(
      join(staleRoot, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: "old",
        lastUsedAt: new Date(now - 8 * 86400_000).toISOString(),
      }),
    );
    await writeFile(
      join(freshRoot, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: "new",
        lastUsedAt: new Date(now - 86400_000).toISOString(),
      }),
    );
    await manager.sweepWorkspacesRoot(join(root, "instances"));
    await expect(readdir(staleRoot)).rejects.toThrow();
    expect(await readdir(freshRoot)).toContain("meta.json");
  });
});

describe("buildTgrepGuidance", () => {
  const ready: TgrepSearchHandle = {
    enabled: true,
    state: "ready",
    cacheRoot: "/cache",
    checkoutDir: "/cache/checkout",
    indexDir: "/cache/index",
  };

  it("points shell searches at the host paths for native sandboxes", () => {
    const text = buildTgrepGuidance(ready);
    expect(text).toContain("aicr.search_code");
    expect(text).toContain("/cache/checkout");
    expect(text).toContain("--index-path /cache/index");
  });

  it("translates paths for container sandboxes", () => {
    const text = buildTgrepGuidance(ready, "/workspace/tgrep-cache");
    expect(text).toContain("/workspace/tgrep-cache/checkout");
    expect(text).toContain("--index-path /workspace/tgrep-cache/index");
  });

  it("degrades to rg guidance when the index is unavailable", () => {
    const text = buildTgrepGuidance({ ...ready, state: "degraded" });
    expect(text).toContain("rg");
    expect(text).not.toContain("search_code tool");
  });
});

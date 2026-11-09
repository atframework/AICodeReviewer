import { execFile, spawn, type SpawnOptions } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSearchTgrepConfig, type WorkspaceLayout } from "@aicr/core";
import { executeTgrepSearch } from "@aicr/mcp-output";
import { buildTgrepGuidance, TgrepIndexManager } from "../src/tgrep-index.js";

const exec = promisify(execFile);
const testTgrep = process.env.AICR_TGREP_TEST_EXECUTABLE;
const cacheDirectory = resolve("build/tmp");
const dayMs = 86_400_000;

function layoutFor(root: string): WorkspaceLayout {
  return {
    kind: "isolated_v2",
    workspacesRoot: root,
    instanceRoot: root,
    sourceRoot: join(root, "source"),
    agentDir: join(root, "agent"),
    tmpDir: join(root, "tmp"),
    contextReposDir: join(root, "context-repos"),
    templatesDir: join(root, "templates"),
    policyRoot: root,
  };
}

const fakeIndex = `
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const [index, checkout] = process.argv.slice(1);
  mkdirSync(index);
  for (const file of ["files.bin", "files-extra.bin", "index.bin", "lookup.bin"]) {
    writeFileSync(join(index, file), "fixture");
  }
  writeFileSync(join(index, "meta.json"), JSON.stringify({
    root_path: checkout, complete: true,
  }));
`;

describe("TgrepIndexManager", () => {
  let root: string;
  let sourceRoot: string;
  let now: number;
  let revision: string;
  const runGit = async (args: string[]) =>
    (await exec("git", args, { cwd: sourceRoot })).stdout.trim();

  async function commit(contents: string): Promise<string> {
    await writeFile(join(sourceRoot, "app.ts"), contents);
    await runGit(["add", "app.ts"]);
    await runGit([
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "user.name=Fixture",
      "commit",
      "-qm",
      "fixture",
    ]);
    return runGit(["rev-parse", "HEAD"]);
  }

  function spawnIndexer(
    command: string,
    args: string[],
    options: SpawnOptions,
  ) {
    if (command !== "tgrep") return spawn(command, args, options);
    return args[0] === "index"
      ? spawn(process.execPath, ["-e", fakeIndex, args[4]!, args[5]!], options)
      : spawn(process.execPath, ["--version"], options);
  }

  function prepareInput(head = revision, rootDir = root) {
    return {
      workspaceId: "shared-rule",
      layout: layoutFor(rootDir),
      sourceRoot,
      revision: head,
    };
  }

  beforeEach(async () => {
    await mkdir(cacheDirectory, { recursive: true });
    root = await mkdtemp(join(cacheDirectory, "aicr-tgrep-"));
    sourceRoot = join(root, "source");
    await mkdir(sourceRoot);
    await runGit(["init", "-q"]);
    await runGit(["config", "core.autocrlf", "false"]);
    revision = await commit("first.revision\n");
    now = Date.now();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("archives a normal Git repository and rebases only sandbox index metadata", async () => {
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      spawnProcess: spawnIndexer as typeof spawn,
    });
    const handle = await manager.prepare(prepareInput());
    expect(handle.state).toBe("ready");
    expect(await readFile(join(handle.checkoutDir, "app.ts"), "utf8")).toBe(
      "first.revision\n",
    );
    const host = JSON.parse(
      await readFile(join(handle.indexDir, "meta.json"), "utf8"),
    );
    const sandbox = JSON.parse(
      await readFile(join(handle.sandboxIndexDir!, "meta.json"), "utf8"),
    );
    expect(host.root_path).toBe(handle.checkoutDir);
    expect(sandbox).toEqual({
      ...host,
      root_path: "/workspace/tgrep-cache/checkout",
    });
    expect(
      await readFile(join(handle.sandboxIndexDir!, "index.bin"), "utf8"),
    ).toBe("fixture");
  });

  it.each([0, 2])(
    "drains delayed Git archive padding before handling exit %i",
    async (exitCode) => {
      const archivePath = join(root, "fixture.tar");
      const { stdout } = await exec(
        "git",
        ["archive", "--format=tar", revision],
        { cwd: sourceRoot, encoding: "buffer" },
      );
      await writeFile(archivePath, stdout);
      const producer = `
      process.stdout.write(require("node:fs").readFileSync(process.argv[1]));
      setTimeout(() => {
        process.exitCode = Number(process.argv[2]);
        process.stdout.end(Buffer.alloc(10_240));
      }, 250);
    `;
      const manager = new TgrepIndexManager({
        config: resolveSearchTgrepConfig(undefined),
        spawnProcess: ((
          command: string,
          args: string[],
          options: SpawnOptions,
        ) =>
          command === "git"
            ? spawn(
                process.execPath,
                ["-e", producer, archivePath, String(exitCode)],
                options,
              )
            : spawnIndexer(command, args, options)) as typeof spawn,
        logger: () => {},
      });

      const input = prepareInput();
      const handle = await manager.prepare(input);
      if (exitCode === 0) {
        expect(handle.state).toBe("ready");
        expect(await readFile(join(handle.checkoutDir, "app.ts"), "utf8")).toBe(
          "first.revision\n",
        );
      } else {
        expect(handle).toMatchObject({
          state: "degraded",
          detail: "git archive failed (exit 2)",
        });
        expect(await readdir(manager.cacheRootFor(input))).toEqual([]);
      }
    },
  );

  it("reuses fresh snapshots, separates concurrent revisions and renews on TTL", async () => {
    const spawnProcess = vi.fn(spawnIndexer);
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      spawnProcess: spawnProcess as typeof spawn,
      now: () => now,
    });
    const secondRevision = await commit("second.revision\n");
    const [first, duplicate, second] = await Promise.all([
      manager.prepare(prepareInput()),
      manager.prepare(prepareInput()),
      manager.prepare(prepareInput(secondRevision)),
    ]);
    expect(duplicate.indexDir).toBe(first.indexDir);
    expect(second.indexDir).not.toBe(first.indexDir);
    expect(await readFile(join(first.checkoutDir, "app.ts"), "utf8")).toBe(
      "first.revision\n",
    );
    expect(await readFile(join(second.checkoutDir, "app.ts"), "utf8")).toBe(
      "second.revision\n",
    );
    expect(
      spawnProcess.mock.calls.filter(([, args]) => args[0] === "index"),
    ).toHaveLength(2);

    now += dayMs;
    const renewed = await manager.prepare(prepareInput());
    expect(renewed.indexDir).not.toBe(first.indexDir);
    expect(await readFile(join(first.checkoutDir, "app.ts"), "utf8")).toBe(
      "first.revision\n",
    );
    first.release?.();
    duplicate.release?.();
    await manager.sweepWorkspacesRoot(root);
    await expect(readdir(first.cacheRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(renewed.cacheRoot)).toContain("ready.json");
  });

  it("separates instances sharing one workspace definition in an external cache", () => {
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig({
        tgrep: { data_dir: join(root, "external") },
      }),
    });
    expect(
      manager.cacheRootFor(prepareInput(revision, join(root, "instance-a"))),
    ).not.toBe(
      manager.cacheRootFor(prepareInput(revision, join(root, "instance-b"))),
    );
  });

  it("expires idle generations and legacy caches while protecting leased snapshots", async () => {
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      spawnProcess: spawnIndexer as typeof spawn,
      now: () => now,
    });
    const instanceRoot = join(root, "nested", "workspace", "instance");
    const input = prepareInput(revision, instanceRoot);
    const [first, second] = await Promise.all([
      manager.prepare(input),
      manager.prepare(input),
    ]);
    const legacy = manager.cacheRootFor(input);
    await mkdir(join(legacy, "checkout"));
    await writeFile(
      join(legacy, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        lastUsedAt: new Date(now).toISOString(),
        serverPid: process.pid,
      }),
    );
    first.release?.();
    first.release?.();
    now += 8 * dayMs;
    await manager.sweepWorkspacesRoot(root);
    expect(await readdir(first.cacheRoot)).toContain("ready.json");
    await expect(readdir(join(legacy, "checkout"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    second.release?.();
    await manager.sweepWorkspacesRoot(root);
    await expect(readdir(first.cacheRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cleans failed builds and allows the same revision to retry", async () => {
    let fail = true;
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      spawnProcess: ((
        command: string,
        args: string[],
        options: SpawnOptions,
      ) =>
        fail && command === "tgrep" && args[0] === "index"
          ? spawn(process.execPath, ["-e", "process.exit(2)"], options)
          : spawnIndexer(command, args, options)) as typeof spawn,
      logger: () => {},
    });
    const input = prepareInput();
    expect((await manager.prepare(input)).state).toBe("degraded");
    expect(await readdir(manager.cacheRootFor(input))).toEqual([]);
    fail = false;
    expect((await manager.prepare(input)).state).toBe("ready");
  });

  it("degrades without spawning for disabled and cancelled reviews", async () => {
    const spawnProcess = vi.fn(spawnIndexer);
    const disabled = new TgrepIndexManager({
      config: resolveSearchTgrepConfig({ tgrep: { enabled: false } }),
      spawnProcess: spawnProcess as typeof spawn,
    });
    expect(await disabled.prepare(prepareInput())).toMatchObject({
      state: "degraded",
      detail: "disabled",
    });
    const enabled = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      spawnProcess: spawnProcess as typeof spawn,
      logger: () => {},
    });
    expect(
      await enabled.prepare({ ...prepareInput(), signal: AbortSignal.abort() }),
    ).toMatchObject({ state: "degraded" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("aborts an in-flight index build without publishing a snapshot", async () => {
    const controller = new AbortController();
    const startIndex = vi.fn();
    const manager = new TgrepIndexManager({
      config: resolveSearchTgrepConfig(undefined),
      spawnProcess: ((
        command: string,
        args: string[],
        options: SpawnOptions,
      ) => {
        if (command !== "tgrep" || args[0] !== "index")
          return spawnIndexer(command, args, options);
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          options,
        );
        child.once("spawn", () => {
          startIndex();
          controller.abort();
        });
        return child;
      }) as typeof spawn,
      logger: () => {},
    });
    const input = { ...prepareInput(), signal: controller.signal };
    expect(await manager.prepare(input)).toMatchObject({ state: "degraded" });
    expect(startIndex).toHaveBeenCalledOnce();
    expect(await readdir(manager.cacheRootFor(input))).toEqual([]);
  });

  it.skipIf(!testTgrep)(
    "queries a real v1.2.7 index with host and remapped metadata",
    async () => {
      const spawnProcess = ((
        command: string,
        args: string[],
        options: SpawnOptions,
      ) =>
        spawn(
          command === "tgrep" ? testTgrep! : command,
          args,
          options,
        )) as typeof spawn;
      const manager = new TgrepIndexManager({
        config: resolveSearchTgrepConfig(undefined),
        spawnProcess,
      });
      const handle = await manager.prepare(prepareInput());
      expect(handle.state).toBe("ready");
      const query = { pattern: "first.revision", literal: true };
      expect(
        await executeTgrepSearch(query, {
          indexDir: handle.indexDir,
          sourceDir: handle.checkoutDir,
          spawnProcess,
        }),
      ).toMatch(/app\.ts:1:first\.revision/u);

      // Reproduce a container's different mount destination on the test host.
      const mountedCheckout = join(root, "mounted-checkout");
      await mkdir(mountedCheckout);
      await writeFile(join(mountedCheckout, "app.ts"), "first.revision\n");
      const indexDir = handle.sandboxIndexDir!;
      const metaPath = join(indexDir, "meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8"));
      await writeFile(
        metaPath,
        JSON.stringify({ ...meta, root_path: mountedCheckout }),
      );
      const result = await exec(
        testTgrep!,
        [
          "--stats",
          "--hidden",
          "--index-path",
          indexDir,
          "--",
          query.pattern,
          ".",
        ],
        { cwd: mountedCheckout },
      );
      expect(result.stdout).toMatch(/app\.ts.*first\.revision/u);
      expect(result.stderr).toContain("Query plan:");
    },
  );
});

describe("buildTgrepGuidance", () => {
  const ready = {
    enabled: true,
    state: "ready" as const,
    cacheRoot: "/cache",
    checkoutDir: "/cache/checkout",
    indexDir: "/cache/index",
    sandboxIndexDir: "/cache/sandbox-index",
  };

  it("advertises only the current route's capabilities", () => {
    expect(buildTgrepGuidance(ready, "native")).toContain('"/cache/index"');
    expect(buildTgrepGuidance(ready, "container")).toContain(
      '"/workspace/tgrep-cache/index"',
    );
    expect(buildTgrepGuidance(ready, "container")).toContain(
      "wait for the host result",
    );
    const nativeLlm = buildTgrepGuidance(ready, "host-tools");
    expect(nativeLlm).toContain("next pass");
    expect(nativeLlm).not.toContain("/cache");
    expect(buildTgrepGuidance(undefined, "host-tools")).toContain(
      "aicr.fetch_more_context",
    );
  });
});

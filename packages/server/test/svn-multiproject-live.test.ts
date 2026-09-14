import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  computeStreamId,
  createSqliteAutoCommitStore,
  parseConfigDocumentText,
  projectEventResolution,
  resolveAutoCommitPolicy,
  type WorkspaceResolution,
} from "@aicr/core";
import { SvnVcsAdapter } from "@aicr/vcs";
import type { ReviewProblem } from "@aicr/outputs";
import { describe, expect, it, vi } from "vitest";

import {
  AutoCommitRuntime,
  reviewEventForBatch,
} from "../src/auto-commit-runtime.js";
import {
  AutoCommitScheduler,
  type BatchExecutionContext,
} from "../src/auto-commit-scheduler.js";
import { resolveSvnTriggerConfigs } from "../src/bootstrap.js";
import { createServerApp } from "../src/index.js";
import { serveAsync } from "../src/node-serve.js";
import { RoutingReceiptResolver } from "../src/routing-resolver.js";
import { createWorkspaceRuntime } from "../src/workspace-runtime.js";
import { runReviewOrchestration } from "../src/review-orchestrator.js";

const svn = process.env.AICR_SVN_TEST_EXECUTABLE;
const exec = promisify(execFile);
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\"'\"'")}'`;

describe.skipIf(!svn)(
  "svnserve post-commit split across two project roots (E07)",
  () => {
    it("routes one revision touching both projects into two scoped executions on the real chain", async () => {
      const root = resolve("build/tmp/svn-multiproject-live");
      await mkdir(root, { recursive: true });
      const fixture = await mkdtemp(join(root, "run-"));
      const repo = join(fixture, "repo");
      const wc = join(fixture, "wc");
      const bin = (name: string) =>
        join(
          dirname(svn!),
          `${name}${process.platform === "win32" ? ".exe" : ""}`,
        );
      const run = (exe: string, args: readonly string[]) =>
        exec(exe, [...args], {
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        });
      const runner = async (args: readonly string[]) => {
        const result = await run(svn!, args);
        return { stdout: result.stdout, stderr: result.stderr };
      };
      await run(bin("svnadmin"), ["create", repo]);
      await writeFile(
        join(repo, "conf", "svnserve.conf"),
        "[general]\nanon-access = read\nauth-access = write\npassword-db = passwd\nrealm = local-multiproject\n",
      );
      await writeFile(
        join(repo, "conf", "passwd"),
        "[users]\nalice = test-alice\n",
      );

      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      if (!address || typeof address === "string")
        throw new Error("Expected ephemeral TCP port");
      await new Promise<void>((done, reject) =>
        reservation.close((error) => (error ? reject(error) : done())),
      );
      const repositoryUrl = `svn://127.0.0.1:${address.port}/repo`;
      const scopeA = `${repositoryUrl}/projectA/trunk`;
      const scopeB = `${repositoryUrl}/projectB/trunk`;
      const daemon = spawn(
        bin("svnserve"),
        [
          "--daemon",
          "--foreground",
          "--listen-host",
          "127.0.0.1",
          "--listen-port",
          String(address.port),
          "--root",
          fixture,
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      let spawnError: Error | undefined;
      daemon.on("error", (error) => {
        spawnError = error;
      });
      const exited = new Promise<void>((done) => {
        daemon.once("exit", () => done());
        daemon.once("error", () => done());
      });
      const cleanups: Array<() => unknown> = [
        () => {
          daemon.kill();
          return exited;
        },
      ];
      try {
        const store = await createSqliteAutoCommitStore({
          path: join(fixture, "queue.sqlite"),
        });
        cleanups.push(() => store.close?.());
        const policy = resolveAutoCommitPolicy({ delay_seconds: 0 }, undefined, undefined);
        const runtime = new AutoCommitRuntime({
          store,
          getPolicyLayers: () => ({ global: { delay_seconds: 0 } }),
        });
        // One svn trigger profile with two explicit project roots; each
        // project is a match-resolved workspace instance (spec §5.2/§5.3).
        const config = parseConfigDocumentText(`
triggers:
  - name: svn-main
    kind: svn
    repository_url: "${repositoryUrl}"
    project_roots:
      - { prefix: /projectA/trunk, project: project-a, branch: trunk }
      - { prefix: /projectB/trunk, project: project-b, branch: trunk }
workspaces:
  instances:
    project-a:
      match:
        - triggers: [svn-main]
          source:
            repo_ref: { glob: "${scopeA}" }
      work_path: project-a
    project-b:
      match:
        - triggers: [svn-main]
          source:
            repo_ref: { glob: "${scopeB}" }
      work_path: project-b
`).config;
        const workspaceRuntime = createWorkspaceRuntime(config, fixture);
        const svnConfigs = resolveSvnTriggerConfigs(
          config,
          undefined,
          workspaceRuntime,
        );
        expect(svnConfigs).toHaveLength(1);
        expect(svnConfigs[0]!.projectRoots).toHaveLength(2);
        expect(svnConfigs[0]!.resolveWorkspace).toBeDefined();
        const apiKey = "local-multiproject-fixture-key";
        const app = createServerApp({
          svn: svnConfigs,
          autoCommit: runtime,
          asyncTriggers: true,
          auth: {
            enabled: true,
            globalApiKey: apiKey,
            workspaceApiKeys: new Map(),
          },
        });
        const http = await serveAsync(app, { port: 0, hostname: "127.0.0.1" });
        cleanups.push(() => {
          http.closeAllConnections();
          return new Promise<void>((done, reject) =>
            http.close((error) => (error ? reject(error) : done())),
          );
        });
        const httpAddress = http.address();
        if (!httpAddress || typeof httpAddress === "string")
          throw new Error("Expected HTTP port");
        const endpoint = `http://127.0.0.1:${httpAddress.port}/triggers/svn`;

        let ready = false;
        for (let i = 0; i < 30; i++) {
          if (spawnError) throw spawnError;
          try {
            await run(svn!, ["info", "--non-interactive", repositoryUrl]);
            ready = true;
            break;
          } catch {
            await delay(100);
          }
        }
        expect(ready).toBe(true);
        await run(svn!, ["checkout", "-q", repositoryUrl, wc]);

        const svnCommit = async (message: string) => {
          const result = await run(svn!, [
            "commit",
            "--non-interactive",
            "--no-auth-cache",
            "--username",
            "alice",
            "--password",
            "test-alice",
            "-m",
            message,
            wc,
          ]);
          expect(result.stderr).not.toContain("post-commit hook failed");
        };
        // r1: the two-project layout lands BEFORE the hook is installed, so
        // exactly one hook notification exists for the multi-project commit.
        await mkdir(join(wc, "projectA", "trunk"), { recursive: true });
        await mkdir(join(wc, "projectB", "trunk"), { recursive: true });
        await run(svn!, ["add", join(wc, "projectA"), join(wc, "projectB")]);
        await svnCommit("project layout");

        const receiptLog = join(fixture, "receipts.jsonl");
        const hookScript = join(fixture, "post-commit.mjs");
        // Real platform hook entrypoint; the payload author is deliberately
        // untrusted noise — per-scope author must come from VCS metadata.
        await writeFile(
          hookScript,
          [
            'import { appendFile } from "node:fs/promises";',
            `const response = await fetch(${JSON.stringify(endpoint)}, { method: "POST",`,
            `  headers: { "content-type": "application/json", "x-api-key": ${JSON.stringify(apiKey)} },`,
            '  body: JSON.stringify({ revision: process.argv[3], author: "payload-is-not-source-evidence" }),',
            "  signal: AbortSignal.timeout(10000) });",
            "const body = await response.json();",
            `await appendFile(${JSON.stringify(receiptLog)}, JSON.stringify({ status: response.status, body }) + "\\n");`,
            "if (response.status !== 202) process.exitCode = 1;",
          ].join("\n"),
        );
        const hook =
          process.platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${hookScript}" "%~1" "%~2"\r\nexit /b %errorlevel%\r\n`
            : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hookScript)} "$1" "$2"\n`;
        await writeFile(
          join(
            repo,
            "hooks",
            process.platform === "win32" ? "post-commit.bat" : "post-commit",
          ),
          hook,
          { mode: 0o755 },
        );

        // r2: ONE revision touches both project roots.
        await writeFile(join(wc, "projectA", "trunk", "main-a.txt"), "alpha\n");
        await writeFile(join(wc, "projectB", "trunk", "util-b.txt"), "beta\n");
        await run(svn!, [
          "add",
          join(wc, "projectA", "trunk", "main-a.txt"),
          join(wc, "projectB", "trunk", "util-b.txt"),
        ]);
        await svnCommit("touch both projects");

        const notifications = (await readFile(receiptLog, "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                status: number;
                body: { processing: { routingIds?: string[] } };
              },
          );
        expect(notifications.map((entry) => entry.status)).toEqual([202]);
        const routingId = notifications[0]!.body.processing.routingIds?.[0];
        expect(routingId).toEqual(expect.any(String));

        // ONE routing receipt (provider svn) persisted by the webhook.
        const pending = await store.getRoutingReceipt(routingId!);
        expect(pending?.provider).toBe("svn");
        expect(pending?.triggerName).toBe("svn-main");

        const repoAdapter = new SvnVcsAdapter({
          repositoryDir: wc,
          repositoryUrl,
          svn: runner,
        });
        const resolver = new RoutingReceiptResolver({
          store,
          config,
          runtime,
          workspaceRuntime,
          adapterFor: () => repoAdapter,
          profileFor: (triggerName, _provider) => {
            const profile = resolveSvnTriggerConfigs(
              config,
              triggerName,
              workspaceRuntime,
            )[0];
            return profile
              ? {
                  workspaceId: profile.workspaceId,
                  repositoryUrl: profile.repositoryUrl,
                  ...(profile.projectRoots
                    ? { projectRoots: profile.projectRoots }
                    : {}),
                }
              : undefined;
          },
        });
        const executions: BatchExecutionContext[] = [];
        const spyErrors: unknown[] = [];
        const layouts = new Map<
          string,
          { instanceRoot: string; sourceRoot: string }
        >();
        const scheduler = new AutoCommitScheduler({
          store,
          getPolicy: () => policy,
          getAdapter: (stream) =>
            new SvnVcsAdapter({
              repositoryDir: wc,
              repositoryUrl: stream.scopeRef,
              svn: runner,
            }),
          routingResolver: resolver,
          executeBatch: async (context) => {
            try {
              executions.push(context);
              const event = reviewEventForBatch(context);
              // Real SvnVcsAdapter evidence per project scope: the batch for
              // one project must contain only its own files, range r1..r2.
              const scopeAdapter = new SvnVcsAdapter({
                repositoryDir: wc,
                repositoryUrl: event.repoRef,
                svn: runner,
              });
              const range = await scopeAdapter.listChanges(event);
              const diff = await scopeAdapter.diff(range);
              const ownFile =
                context.batch.workspaceId === "project-a"
                  ? "main-a.txt"
                  : "util-b.txt";
              expect(event.author.username).toBe("alice");
              expect([context.batch.base, context.batch.head]).toEqual([
                "1",
                "2",
              ]);
              expect([...range.files]).toEqual([ownFile]);
              expect(diff.files).toHaveLength(1);
              expect(diff.files[0]).toMatchObject({ newPath: ownFile, status: "added" });
              expect(diff.files[0]!.oldPath).toBeUndefined();

              // Execution layout from the pinned receipt resolution (the seam
              // production execution uses): per-project roots on the real FS.
              const resolution = context.receipt.resolution;
              if (resolution?.kind !== "match")
                throw new Error("expected a pinned match resolution");
              const layout = workspaceRuntime.layoutForEvent({
                triggerName: context.batch.triggerName,
                workspaceId: context.batch.workspaceId,
                repoRef: event.repoRef,
                resolution: projectEventResolution(resolution),
              });
              await mkdir(layout.sourceRoot, { recursive: true });
              const published = vi.fn(async (_problem: ReviewProblem) => ({ channel: "test", status: "published" as const }));
              const complete = vi.fn(async () => ({ providerId: "local", modelId: "fixture", raw: null,
                content: JSON.stringify({ problems: [{ file: ownFile, line: 1, severity: "high", category: "correctness",
                  message: `Review ${context.batch.workspaceId}`, fingerprint: context.batch.workspaceId }], summary: "Scoped review" }),
              }));
              const review = await runReviewOrchestration({ reviewEvent: event, payload: {}, provider: "svn", eventName: "commit" }, {
                baseSystemPrompt: "{{TASK_CONTEXT}}", sourceRootResolver: () => layout.sourceRoot,
                vcs: scopeAdapter, model: { providerId: "local", modelId: "fixture", providerKind: "openai_compatible" },
                llm: { complete }, outputPublisher: { publishProblem: published },
              });
              expect(review.status).toBe("published");
              expect(review.diffFileCount).toBe(1);
              expect(complete).toHaveBeenCalledTimes(1);
              expect(review.preparedPrompt.taskContext).toContain(ownFile);
              expect(review.preparedPrompt.taskContext).not.toContain("\t(revision");
              expect(published).toHaveBeenCalledTimes(1);
              expect(published.mock.calls[0]?.[0]).toMatchObject({ file: ownFile, line: 1,
                codeSnippet: context.batch.workspaceId === "project-a" ? "alpha" : "beta" });
              await writeFile(
                join(layout.instanceRoot, "writable.txt"),
                context.batch.workspaceId,
              );
              layouts.set(context.batch.workspaceId, {
                instanceRoot: layout.instanceRoot,
                sourceRoot: layout.sourceRoot,
              });
            } catch (error) {
              spyErrors.push(error);
              throw error;
            }
          },
        });
        for (let i = 0; i < 20 && executions.length < 2; i++)
          await scheduler.tick();
        expect(executions).toHaveLength(2);
        expect(
          spyErrors.map((error) =>
            error instanceof Error ? error.message : String(error),
          ),
        ).toEqual([]);
        expect(
          executions.map((context) => context.batch.workspaceId).sort(),
        ).toEqual(["project-a", "project-b"]);

        // Stage C conversion: TWO formal receipts, distinct instances,
        // per-scope variables from real adapter metadata.
        const converted = await store.getRoutingReceipt(routingId!);
        expect(converted?.terminalError).toBeNull();
        expect(converted?.completedAt, converted?.note ?? undefined).not.toBeNull();
        expect(converted?.convertedReceiptIds).toHaveLength(2);
        const receipts = await Promise.all(
          converted!.convertedReceiptIds.map((id) => store.getReceipt(id)),
        );
        expect(
          receipts.map((entry) => entry!.receipt.workspaceId).sort(),
        ).toEqual(["project-a", "project-b"]);
        expect(
          receipts.map((entry) => entry!.receipt.scopeRef).sort(),
        ).toEqual([scopeA, scopeB].sort());
        const resolutions = receipts.map(
          (entry) =>
            entry!.receipt.resolution as WorkspaceResolution & {
              kind: "match";
            },
        );
        for (const resolution of resolutions) {
          expect(resolution.kind).toBe("match");
          const fields = resolution.variables.svn as Record<
            string,
            string | null
          >;
          expect(fields.branch).toBe("trunk");
          expect(fields.author).toBe("alice");
          expect(fields.revision).toBe("2");
          expect(fields.repository_uuid).toEqual(expect.any(String));
        }
        expect(
          new Set(resolutions.map((entry) => entry.binding.instanceId)).size,
        ).toBe(2);

        // Per-project workspace roots exist on disk, are deterministically
        // distinct, and never share a writable directory.
        expect([...layouts.keys()].sort()).toEqual(["project-a", "project-b"]);
        const layoutA = layouts.get("project-a")!;
        const layoutB = layouts.get("project-b")!;
        for (const layout of [layoutA, layoutB]) {
          await stat(layout.instanceRoot);
          await stat(layout.sourceRoot);
        }
        expect(layoutA.instanceRoot).not.toBe(layoutB.instanceRoot);
        expect(layoutA.sourceRoot).not.toBe(layoutB.sourceRoot);
        for (const [from, to] of [
          [layoutA.instanceRoot, layoutB.instanceRoot],
          [layoutB.instanceRoot, layoutA.instanceRoot],
        ] as const) {
          expect(relative(from, to).startsWith(`..${sep}`)).toBe(true);
        }
        await expect(
          readFile(join(layoutA.instanceRoot, "writable.txt"), "utf8"),
        ).resolves.toBe("project-a");
        await expect(
          readFile(join(layoutB.instanceRoot, "writable.txt"), "utf8"),
        ).resolves.toBe("project-b");
        // Layout is a pure function of the pinned resolution (deterministic).
        for (const context of executions) {
          const resolution = context.receipt.resolution;
          if (resolution?.kind !== "match")
            throw new Error("expected a pinned match resolution");
          const recomputed = workspaceRuntime.layoutForEvent({
            triggerName: context.batch.triggerName,
            workspaceId: context.batch.workspaceId,
            repoRef: reviewEventForBatch(context).repoRef,
            resolution: projectEventResolution(resolution),
          });
          expect(recomputed.instanceRoot).toBe(
            layouts.get(context.batch.workspaceId)!.instanceRoot,
          );
        }

        // Redelivery: the same post-commit replay is a duplicate — no third
        // execution, routing/formal receipt counts stable.
        const streamReceiptCounts = async () =>
          Promise.all(
            receipts.map(async (entry) => {
              const streamReceipts = await store.readStreamReceipts(
                computeStreamId(entry!.receipt),
                0,
                Number.MAX_SAFE_INTEGER,
                10,
              );
              return streamReceipts.length;
            }),
          );
        expect(await streamReceiptCounts()).toEqual([1, 1]);
        const redelivery = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: '{"revision":"2"}',
        });
        expect(redelivery.status).toBe(202);
        const redeliveryBody = (await redelivery.json()) as {
          processing: { routingIds?: string[] };
        };
        expect(redeliveryBody.processing.routingIds).toEqual([routingId]);
        await scheduler.tick();
        await scheduler.tick();
        expect(executions).toHaveLength(2);
        expect(
          (await store.getRoutingReceipt(routingId!))?.convertedReceiptIds,
        ).toEqual(converted!.convertedReceiptIds);
        expect(await streamReceiptCounts()).toEqual([1, 1]);
        await scheduler.stopAndDrain();
      } finally {
        await Promise.all(cleanups.map(async (cleanup) => cleanup()));
      }
    }, 90_000);
  },
);

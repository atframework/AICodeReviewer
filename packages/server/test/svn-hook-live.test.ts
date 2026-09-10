import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  computeStreamId,
  createSqliteAutoCommitStore,
  resolveAutoCommitPolicy,
} from "@aicr/core";
import { SvnVcsAdapter } from "@aicr/vcs";
import { describe, expect, it } from "vitest";

import {
  AutoCommitRuntime,
  reviewEventForBatch,
} from "../src/auto-commit-runtime.js";
import {
  AutoCommitScheduler,
  type BatchExecutionContext,
} from "../src/auto-commit-scheduler.js";
import { createServerApp } from "../src/index.js";
import { serveAsync } from "../src/node-serve.js";

const svn = process.env.AICR_SVN_TEST_EXECUTABLE;
const exec = promisify(execFile);
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\"'\"'")}'`;

describe.skipIf(!svn)(
  "svnserve post-commit to persistent automatic review",
  () => {
    it("accepts authenticated real hooks, merges source streaks across receipts, and deduplicates redelivery", async () => {
      const root = resolve("build/tmp/svn-hook-acceptance");
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
      await run(bin("svnadmin"), ["create", repo]);
      await writeFile(
        join(repo, "conf", "svnserve.conf"),
        "[general]\nanon-access = read\nauth-access = write\npassword-db = passwd\nrealm = local-acceptance\n",
      );
      await writeFile(
        join(repo, "conf", "passwd"),
        "[users]\nalice = test-alice\nbob = test-bob\n",
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
        const policy = resolveAutoCommitPolicy({ delay_seconds: 0 });
        const runtime = new AutoCommitRuntime({
          store,
          getPolicyLayers: () => ({ global: { delay_seconds: 0 } }),
        });
        const apiKey = "local-hook-fixture-key";
        const app = createServerApp({
          svn: {
            triggerName: "local-svn",
            workspaceId: "local-workspace",
            repositoryUrl,
          },
          autoCommit: runtime,
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
        const receiptLog = join(fixture, "receipts.jsonl");
        const hookScript = join(fixture, "post-commit.mjs");
        // Use the real platform hook entrypoint and absolute executable paths:
        // https://subversion.apache.org/faq#hook-debugging
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
        const headers = {
          "content-type": "application/json",
          "x-api-key": apiKey,
        };
        const unauthorized = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"revision":"1"}',
        });
        expect(unauthorized.status).toBe(401);
        await unauthorized.text();

        for (const [index, author] of ["alice", "alice", "bob"].entries()) {
          await writeFile(join(wc, "file.txt"), `revision ${index + 1}\n`);
          if (index === 0) await run(svn!, ["add", join(wc, "file.txt")]);
          const result = await run(svn!, [
            "commit",
            "--non-interactive",
            "--no-auth-cache",
            "--username",
            author,
            "--password",
            `test-${author}`,
            "-m",
            `commit ${index + 1}`,
            wc,
          ]);
          expect(result.stderr).not.toContain("post-commit hook failed");
        }
        const notifications = (await readFile(receiptLog, "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                status: number;
                body: { processing: { receiptId: string } };
              },
          );
        expect(
          notifications.map((notification) => notification.status),
        ).toEqual([202, 202, 202]);
        const first = (await store.getReceipt(
          notifications[0]!.body.processing.receiptId,
        ))!;
        expect(
          await store.readStreamReceipts(
            computeStreamId(first.receipt),
            0,
            Number.MAX_SAFE_INTEGER,
            10,
          ),
        ).toHaveLength(3);
        const adapter = new SvnVcsAdapter({
          repositoryDir: wc,
          repositoryUrl,
          svn: async (args) => {
            const result = await run(svn!, args);
            return { stdout: result.stdout, stderr: result.stderr };
          },
        });
        const executions: BatchExecutionContext[] = [];
        const scheduler = new AutoCommitScheduler({
          store,
          getPolicy: () => policy,
          getAdapter: () => adapter,
          executeBatch: async (context) => {
            executions.push(context);
            const event = reviewEventForBatch(context);
            const range = await adapter.listChanges(event);
            const diff = await adapter.diff(range);
            expect(diff.files).toHaveLength(1);
            expect(event.author.username).toBe(
              executions.length === 1 ? "alice" : "bob",
            );
          },
        });
        for (let i = 0; i < 3; i++) await scheduler.tick();
        expect(
          executions.map((context) =>
            context.members.map((member) => member.revision),
          ),
        ).toEqual([["1", "2"], ["3"]]);
        expect(
          executions.map((context) => [context.batch.base, context.batch.head]),
        ).toEqual([
          ["0", "2"],
          ["2", "3"],
        ]);
        const redelivery = await fetch(endpoint, {
          method: "POST",
          headers,
          body: '{"revision":"2"}',
        });
        expect(
          ((await redelivery.json()) as { processing: { status: string } })
            .processing.status,
        ).toBe("duplicate");
        await scheduler.tick();
        expect(executions).toHaveLength(2);
        await scheduler.stopAndDrain();
        for (const notification of notifications) {
          expect(
            (await store.getReceipt(notification.body.processing.receiptId))
              ?.memberCounts.completed,
          ).toBe(1);
        }
      } finally {
        await Promise.all(cleanups.map(async (cleanup) => cleanup()));
      }
    }, 60_000);
  },
);

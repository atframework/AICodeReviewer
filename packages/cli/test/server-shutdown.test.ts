import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";

import { waitForServerShutdown } from "../src/server-shutdown.js";

it("drains active HTTP requests and workers before closing stores, including repeated signals", async () => {
  let finishHttp!: () => void;
  const entered = new Promise<void>(resolve => {
    finishHttp = resolve;
  });
  let releaseHttp!: () => void;
  const body = new Promise<void>(resolve => { releaseHttp = resolve; });
  const server = createServer(async (_req, res) => { finishHttp(); await body; res.end("completed"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  let releaseWorker!: () => void;
  const worker = new Promise<void>(resolve => { releaseWorker = resolve; });
  const beginDrain = vi.fn(() => worker);
  const close = vi.fn(async () => {});
  const signals = new EventEmitter();
  const stdout = { write: vi.fn() };
  const done = waitForServerShutdown({ server, beginDrain, close, stdout, stderr: { write: vi.fn() }, signals });
  const request = fetch(`http://127.0.0.1:${port}/`);
  try {
    await entered;
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(beginDrain).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    releaseHttp();
    expect(await (await request).text()).toBe("completed");
    expect(close).not.toHaveBeenCalled();
    releaseWorker();
    expect(await done).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenLastCalledWith("AICR server drained and closed.\n");
  } finally {
    releaseHttp(); releaseWorker(); server.closeAllConnections(); server.close();
  }
});

it("reports a drain failure without closing stores underneath unfinished work", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const close = vi.fn(async () => {});
  const stderr = { write: vi.fn() };
  const signals = new EventEmitter();
  const result = waitForServerShutdown({ server, signals, close, stderr, stdout: { write() {} },
    beginDrain: async () => { throw new Error("not drained"); } });
  signals.emit("SIGTERM");
  expect(await result).toBe(1);
  expect(close).not.toHaveBeenCalled();
  expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("do not migrate"));
  server.closeAllConnections();
});

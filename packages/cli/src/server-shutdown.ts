import type { EventEmitter } from "node:events";
import type { Server } from "node:http";

/** SIGTERM/SIGINT stop new work and wait for accepted work before closing stores. */
export function waitForServerShutdown(options: {
  server: Server;
  beginDrain: () => Promise<void>;
  close: () => Promise<void>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  signals?: Pick<EventEmitter, "on" | "removeListener">;
}): Promise<number> {
  const signals = options.signals ?? process;
  return new Promise(resolve => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      options.stdout.write("AICR server draining: admission and claim stopped; waiting for accepted work.\n");
      const httpClosed = new Promise<void>((done, reject) => {
        options.server.close(error => error ? reject(error) : done());
      });
      void Promise.all([options.beginDrain(), httpClosed]).then(() => options.close()).then(() => {
        options.stdout.write("AICR server drained and closed.\n");
        resolve(0);
      }, () => {
        options.stderr.write("AICR server has not drained cleanly; do not migrate while the old process is running.\n");
        resolve(1);
      }).finally(() => {
        signals.removeListener("SIGTERM", shutdown);
        signals.removeListener("SIGINT", shutdown);
      });
    };
    signals.on("SIGTERM", shutdown);
    signals.on("SIGINT", shutdown);
  });
}

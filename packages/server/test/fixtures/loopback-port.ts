import { randomInt } from "node:crypto";
import { createServer } from "node:net";

/** Probe explicit candidates: port 0 can repeatedly choose the same port. */
export async function freeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(10_000, 49_152);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  }
  throw new Error("No available loopback port after 100 explicit bind attempts.");
}

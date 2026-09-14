/**
 * In-process stub gitea services for the browser gate (P7 run isolation leg).
 * Hosted by start-fixture.mjs alongside the real CLI server child:
 *   127.0.0.1:9399 ← fixture trigger git-main (VCS remote + run-1 channel)
 *   127.0.0.1:9398 ← fixture trigger git-preview (run-2 channel)
 *
 * Two responsibilities:
 *  1. Request capture: every request (minus the /__ introspection endpoints)
 *     is recorded as {method, url, headers, body}; GET /__captured returns the
 *     per-port array, GET /__reset clears it. POSTs under /api/v1/ answer
 *     200 {id:7} like a gitea write endpoint.
 *  2. Minimal git smart-HTTP: the real VCS adapter runs
 *     `git fetch --prune origin` against <trigger base_url>/acme/app.git at the
 *     start of every run. Advertising ZERO refs satisfies the fetch (verified:
 *     git exits 0 and issues no upload-pack POST) while the pre-seeded local
 *     clone supplies the actual base/head commits for diff/show.
 */

import http from "node:http";

/** pkt-line service header + flush + empty ref advertisement + flush. */
const EMPTY_GIT_ADVERTISEMENT = Buffer.from("001e# service=git-upload-pack\n00000000");

function createStubListener(captured) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "/";

      if (url === "/__captured") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(captured));
        return;
      }
      if (url === "/__reset") {
        captured.length = 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      captured.push({ method: req.method, url, headers: { ...req.headers }, body });

      if (req.method === "GET" && url.includes(".git/info/refs")) {
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
        res.end(EMPTY_GIT_ADVERTISEMENT);
        return;
      }
      // Unreachable with an empty advertisement; answered defensively so a
      // protocol surprise fails the run fast instead of hanging the agent.
      if (req.method === "POST" && url.endsWith(".git/git-upload-pack")) {
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
        res.end(Buffer.from("0000"));
        return;
      }
      if (req.method === "POST" && url.startsWith("/api/v1/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 7 }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "stub service: not found" }));
    });
  });
}

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
}

/**
 * Starts both stub listeners. Resolves once both accept connections; the
 * returned handle closes them (used on fixture shutdown).
 */
export async function startStubServices() {
  const main = createStubListener([]);
  const preview = createStubListener([]);
  await Promise.all([listen(main, 9399), listen(preview, 9398)]);
  return {
    async close() {
      main.closeAllConnections?.();
      preview.closeAllConnections?.();
      await Promise.all([
        new Promise((r) => main.close(() => r())),
        new Promise((r) => preview.close(() => r())),
      ]);
    },
  };
}

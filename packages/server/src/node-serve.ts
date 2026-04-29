import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Hono } from "hono";

export interface ServeOptions {
  readonly port?: number;
  readonly hostname?: string;
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function toWebRequest(req: IncomingMessage, hostname: string): Promise<Request> {
  const protocol = (req.socket as unknown as Record<string, boolean>).encrypted ? "https" : "http";
  const url = `${protocol}://${hostname}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    ...(hasBody ? { body: await collectBody(req) } : {}),
  });
}

async function sendResponse(res: ServerResponse, webResponse: Response): Promise<void> {
  res.statusCode = webResponse.status;

  webResponse.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!webResponse.body) {
    res.end();
    return;
  }

  const reader = (webResponse.body as ReadableStream).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
  }

  res.end();
}

export function serve(app: Hono, options: ServeOptions = {}): Server {
  const port = options.port ?? 8080;
  const hostname = options.hostname ?? "0.0.0.0";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const request = await toWebRequest(req, hostname);
      const response = await app.fetch(request);
      await sendResponse(res, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "internal_server_error", message }));
    }
  });

  server.listen(port, hostname);
  return server;
}

export function serveAsync(app: Hono, options: ServeOptions = {}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve(app, options);
    server.on("listening", () => resolve(server));
    server.on("error", reject);
  });
}

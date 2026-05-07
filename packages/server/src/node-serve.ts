import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Hono } from "hono";

export interface TrustProxyConfig {
  readonly trustProxy: boolean | "loopback" | "linklocal" | "uniquelocal" | readonly string[];
  readonly baseUrl?: string;
  readonly pathPrefix?: string;
}

export interface ServeOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly proxy?: TrustProxyConfig;
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const parts = ip.split(".");
  if (parts.length === 4) {
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    if (first === 172 && second >= 16 && second <= 31) return true;
  }
  return false;
}

function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

function isLinkLocalIp(ip: string): boolean {
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fe80.")) return true;
  return false;
}

function isUniqueLocalIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const normalizedIp = ip.includes(":") && ip.startsWith("::ffff:")
    ? ip.slice("::ffff:".length)
    : ip;
  const slashIndex = cidr.indexOf("/");
  if (slashIndex === -1) return normalizedIp === cidr;
  const network = cidr.slice(0, slashIndex);
  const bitsStr = cidr.slice(slashIndex + 1);
  const bits = Number(bitsStr);
  const ipParts = normalizedIp.split(".").map(Number);
  const netParts = network.split(".").map(Number);
  if (ipParts.length !== 4 || netParts.length !== 4) return false;
  const ipNum = ((ipParts[0] ?? 0) << 24) | ((ipParts[1] ?? 0) << 16) | ((ipParts[2] ?? 0) << 8) | (ipParts[3] ?? 0);
  const netNum = ((netParts[0] ?? 0) << 24) | ((netParts[1] ?? 0) << 16) | ((netParts[2] ?? 0) << 8) | (netParts[3] ?? 0);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ipNum >>> 0) & mask) === ((netNum >>> 0) & mask);
}

function isTrustedProxy(remoteAddress: string | undefined, trustProxy: TrustProxyConfig["trustProxy"]): boolean {
  if (trustProxy === false) return false;
  if (trustProxy === true) return true;
  if (!remoteAddress) return false;
  if (trustProxy === "loopback") return isLoopbackIp(remoteAddress);
  if (trustProxy === "linklocal") return isLinkLocalIp(remoteAddress) || isLoopbackIp(remoteAddress);
  if (trustProxy === "uniquelocal") return isUniqueLocalIp(remoteAddress) || isLoopbackIp(remoteAddress);
  if (Array.isArray(trustProxy)) return trustProxy.some((cidr) => ipMatchesCidr(remoteAddress, cidr));
  return false;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extractHostPort(hostHeader: string): { host: string; port: string | undefined } {
  const bracketClose = hostHeader.indexOf("]");
  if (bracketClose !== -1) {
    const colonAfter = hostHeader.indexOf(":", bracketClose);
    if (colonAfter !== -1) {
      return { host: hostHeader.slice(0, colonAfter), port: hostHeader.slice(colonAfter + 1) };
    }
    return { host: hostHeader, port: undefined };
  }
  const colonIndex = hostHeader.lastIndexOf(":");
  if (colonIndex !== -1) {
    const afterColon = hostHeader.slice(colonIndex + 1);
    if (/^\d+$/.test(afterColon)) {
      return { host: hostHeader.slice(0, colonIndex), port: afterColon };
    }
  }
  return { host: hostHeader, port: undefined };
}

function resolveEffectiveBaseUrl(
  proxyConfig: TrustProxyConfig,
  headers: Record<string, string | string[] | undefined>,
): URL | undefined {
  if (proxyConfig.baseUrl) {
    try {
      return new URL(proxyConfig.baseUrl);
    } catch {
      return undefined;
    }
  }

  const proto =
    firstHeaderValue(headers["x-forwarded-proto"])
    ?? firstHeaderValue(headers["x-forwarded-scheme"]);

  const forwardedHost =
    firstHeaderValue(headers["x-forwarded-host"])
    ?? firstHeaderValue(headers["host"]);

  if (!proto && !forwardedHost) return undefined;

  const scheme = proto ?? "https";
  const rawHost = forwardedHost ?? "localhost";
  const forwardedPort = firstHeaderValue(headers["x-forwarded-port"]);
  const { host, port: hostPort } = extractHostPort(rawHost);
  const port = hostPort ?? (/^\d+$/u.test(forwardedPort ?? "") ? forwardedPort : undefined);

  let origin: string;
  if (port) {
    const isStandard = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
    origin = isStandard ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
  } else {
    origin = `${scheme}://${host}`;
  }

  const prefix =
    proxyConfig.pathPrefix
    ?? firstHeaderValue(headers["x-forwarded-prefix"])
    ?? "";

  try {
    return new URL(prefix || "/", origin);
  } catch {
    return undefined;
  }
}

function toWebRequest(
  req: IncomingMessage,
  hostname: string,
  proxyConfig: TrustProxyConfig | undefined,
): Promise<Request> {
  const remoteAddress = req.socket.remoteAddress;

  if (proxyConfig && proxyConfig.trustProxy !== false && isTrustedProxy(remoteAddress, proxyConfig.trustProxy)) {
    const effectiveBaseUrl = resolveEffectiveBaseUrl(proxyConfig, req.headers);
    let url: string;
    if (effectiveBaseUrl) {
      const path = req.url ?? "/";
      url = `${effectiveBaseUrl.origin}${path}`;
    } else {
      const protocol = (req.socket as unknown as Record<string, boolean>).encrypted ? "https" : "http";
      url = `${protocol}://${hostname}${req.url ?? "/"}`;
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      }
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    if (!hasBody) {
      return Promise.resolve(
        new Request(url, {
          method: req.method ?? "GET",
          headers,
        }),
      );
    }

    return collectBody(req).then(
      (body) =>
        new Request(url, {
          method: req.method ?? "GET",
          headers,
          body,
        }),
    );
  }

  const protocol = (req.socket as unknown as Record<string, boolean>).encrypted ? "https" : "http";
  const url = `${protocol}://${hostname}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  if (!hasBody) {
    return Promise.resolve(
      new Request(url, {
        method: req.method ?? "GET",
        headers,
      }),
    );
  }

  return collectBody(req).then(
    (body) =>
      new Request(url, {
        method: req.method ?? "GET",
        headers,
        body,
      }),
  );
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
      const request = await toWebRequest(req, hostname, options.proxy);
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

export {
  isTrustedProxy,
  resolveEffectiveBaseUrl,
  extractHostPort,
  isLoopbackIp,
  isPrivateIp,
  isLinkLocalIp,
  isUniqueLocalIp,
  ipMatchesCidr,
};

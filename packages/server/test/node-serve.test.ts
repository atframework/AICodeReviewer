import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  extractHostPort,
  ipMatchesCidr,
  isLinkLocalIp,
  isLoopbackIp,
  isPrivateIp,
  isTrustedProxy,
  isUniqueLocalIp,
  resolveEffectiveBaseUrl,
  serveAsync,
  type TrustProxyConfig,
} from "../src/node-serve.js";

describe("isLoopbackIp", () => {
  it("accepts only loopback addresses", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("10.0.0.1")).toBe(false);
  });
});

describe("isPrivateIp", () => {
  it("returns true for 127.0.0.1", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("returns true for ::ffff:127.0.0.1", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns true for 10.x.x.x", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  it("returns true for 192.168.x.x", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("returns true for 172.16.x.x through 172.31.x.x", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  it("returns false for 172.15.x.x", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
  });

  it("returns false for 172.32.x.x", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("returns false for public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.2.3.4")).toBe(false);
  });
});

describe("isLinkLocalIp", () => {
  it("returns true for 169.254.x.x", () => {
    expect(isLinkLocalIp("169.254.1.1")).toBe(true);
  });

  it("returns true for fe80: prefix", () => {
    expect(isLinkLocalIp("fe80::1")).toBe(true);
  });

  it("returns false for private IPs", () => {
    expect(isLinkLocalIp("192.168.1.1")).toBe(false);
  });

  it("returns false for public IPs", () => {
    expect(isLinkLocalIp("8.8.8.8")).toBe(false);
  });
});

describe("isUniqueLocalIp", () => {
  it("returns true for fc prefix", () => {
    expect(isUniqueLocalIp("fc00::1")).toBe(true);
  });

  it("returns true for fd prefix", () => {
    expect(isUniqueLocalIp("fd00::1")).toBe(true);
  });

  it("returns false for public IPs", () => {
    expect(isUniqueLocalIp("2001:db8::1")).toBe(false);
  });
});

describe("ipMatchesCidr", () => {
  it("matches exact IP without mask", () => {
    expect(ipMatchesCidr("192.168.1.1", "192.168.1.1")).toBe(true);
  });

  it("rejects non-matching IP without mask", () => {
    expect(ipMatchesCidr("192.168.1.2", "192.168.1.1")).toBe(false);
  });

  it("matches /24 CIDR", () => {
    expect(ipMatchesCidr("192.168.1.100", "192.168.1.0/24")).toBe(true);
  });

  it("rejects IP outside /24 CIDR", () => {
    expect(ipMatchesCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
  });

  it("matches /16 CIDR", () => {
    expect(ipMatchesCidr("10.20.30.40", "10.20.0.0/16")).toBe(true);
  });

  it("rejects IP outside /16 CIDR", () => {
    expect(ipMatchesCidr("10.21.0.1", "10.20.0.0/16")).toBe(false);
  });

  it("matches /0 CIDR (any IP)", () => {
    expect(ipMatchesCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });

  it("matches /32 CIDR (exact IP)", () => {
    expect(ipMatchesCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(ipMatchesCidr("10.0.0.2", "10.0.0.1/32")).toBe(false);
  });

  it("handles IPv4-mapped IPv6 addresses", () => {
    expect(ipMatchesCidr("::ffff:192.168.1.1", "192.168.1.0/24")).toBe(true);
  });
});

describe("isTrustedProxy", () => {
  it("returns false when trustProxy is false", () => {
    expect(isTrustedProxy("127.0.0.1", false)).toBe(false);
  });

  it("returns true when trustProxy is true and remote exists", () => {
    expect(isTrustedProxy("1.2.3.4", true)).toBe(true);
  });

  it("returns true when trustProxy is true and remote is undefined", () => {
    expect(isTrustedProxy(undefined, true)).toBe(true);
  });

  it("returns true for loopback IPs when trustProxy is loopback", () => {
    expect(isTrustedProxy("127.0.0.1", "loopback")).toBe(true);
    expect(isTrustedProxy("::1", "loopback")).toBe(true);
  });

  it("does not trust private non-loopback IPs when trustProxy is loopback", () => {
    expect(isTrustedProxy("10.0.0.1", "loopback")).toBe(false);
    expect(isTrustedProxy("192.168.1.2", "loopback")).toBe(false);
  });

  it("returns false for public IPs when trustProxy is loopback", () => {
    expect(isTrustedProxy("8.8.8.8", "loopback")).toBe(false);
  });

  it("returns true for link-local + loopback when trustProxy is linklocal", () => {
    expect(isTrustedProxy("169.254.1.1", "linklocal")).toBe(true);
    expect(isTrustedProxy("127.0.0.1", "linklocal")).toBe(true);
  });

  it("returns true for unique-local + loopback when trustProxy is uniquelocal", () => {
    expect(isTrustedProxy("fc00::1", "uniquelocal")).toBe(true);
    expect(isTrustedProxy("127.0.0.1", "uniquelocal")).toBe(true);
  });

  it("returns true for IPs matching CIDR array", () => {
    expect(isTrustedProxy("192.168.1.50", ["192.168.1.0/24", "10.0.0.0/8"])).toBe(true);
    expect(isTrustedProxy("10.5.5.5", ["192.168.1.0/24", "10.0.0.0/8"])).toBe(true);
  });

  it("returns false for IPs not matching CIDR array", () => {
    expect(isTrustedProxy("8.8.8.8", ["192.168.1.0/24", "10.0.0.0/8"])).toBe(false);
  });

  it("returns false when remote address is undefined and not true", () => {
    expect(isTrustedProxy(undefined, "loopback")).toBe(false);
  });
});

describe("extractHostPort", () => {
  it("extracts host and port from host:port", () => {
    const result = extractHostPort("example.com:8443");
    expect(result).toEqual({ host: "example.com", port: "8443" });
  });

  it("returns only host for standard hostname without port", () => {
    const result = extractHostPort("example.com");
    expect(result).toEqual({ host: "example.com", port: undefined });
  });

  it("handles IPv6 with port", () => {
    const result = extractHostPort("[::1]:8080");
    expect(result).toEqual({ host: "[::1]", port: "8080" });
  });

  it("handles IPv6 without port", () => {
    const result = extractHostPort("[::1]");
    expect(result).toEqual({ host: "[::1]", port: undefined });
  });

  it("handles hostname with non-numeric suffix after colon", () => {
    const result = extractHostPort("example.com:abc");
    expect(result).toEqual({ host: "example.com:abc", port: undefined });
  });
});

describe("resolveEffectiveBaseUrl", () => {
  const makeConfig = (
    trustProxy: TrustProxyConfig["trustProxy"] = true,
    baseUrl?: string,
    pathPrefix?: string,
  ): TrustProxyConfig => ({
    trustProxy,
    ...(baseUrl ? { baseUrl } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
  });

  it("returns configured base_url when set", () => {
    const config = makeConfig(true, "https://aicr.example.com/aicr");
    const result = resolveEffectiveBaseUrl(config, {});
    expect(result?.href).toBe("https://aicr.example.com/aicr");
  });

  it("derives from X-Forwarded-Proto + X-Forwarded-Host", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "aicr.example.com",
    });
    expect(result?.href).toBe("https://aicr.example.com/");
  });

  it("derives with non-standard port from X-Forwarded-Host", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "aicr.example.com:8443",
    });
    expect(result?.href).toBe("https://aicr.example.com:8443/");
  });

  it("omits standard HTTPS port 443", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "aicr.example.com:443",
    });
    expect(result?.href).toBe("https://aicr.example.com/");
  });

  it("omits standard HTTP port 80", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "http",
      "x-forwarded-host": "aicr.example.com:80",
    });
    expect(result?.href).toBe("http://aicr.example.com/");
  });

  it("derives from X-Forwarded-Scheme as fallback", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-scheme": "https",
      "x-forwarded-host": "aicr.example.com",
    });
    expect(result?.href).toBe("https://aicr.example.com/");
  });

  it("falls back to Host header when X-Forwarded-Host is missing", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      host: "aicr.example.com:9090",
    });
    expect(result?.href).toBe("https://aicr.example.com:9090/");
  });

  it("uses X-Forwarded-Port when X-Forwarded-Host has no port", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "aicr.example.com",
      "x-forwarded-port": "6023",
    });
    expect(result?.href).toBe("https://aicr.example.com:6023/");
  });

  it("prefers an explicit port in X-Forwarded-Host over X-Forwarded-Port", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "aicr.example.com:8443",
      "x-forwarded-port": "6023",
    });
    expect(result?.href).toBe("https://aicr.example.com:8443/");
  });

  it("uses X-Forwarded-Prefix when pathPrefix is not configured", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "aicr.example.com",
      "x-forwarded-prefix": "/aicr",
    });
    expect(result?.href).toBe("https://aicr.example.com/aicr");
  });

  it("prefers configured pathPrefix over X-Forwarded-Prefix", () => {
    const config = makeConfig(true, undefined, "/custom");
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "aicr.example.com",
      "x-forwarded-prefix": "/aicr",
    });
    expect(result?.href).toBe("https://aicr.example.com/custom");
  });

  it("defaults to https when only host is provided", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-host": "aicr.example.com",
    });
    expect(result?.href).toBe("https://aicr.example.com/");
  });

  it("returns undefined when no proxy headers are present", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {});
    expect(result).toBeUndefined();
  });

  it("handles array-valued headers", () => {
    const config = makeConfig(true);
    const result = resolveEffectiveBaseUrl(config, {
      "x-forwarded-proto": ["https"],
      "x-forwarded-host": ["aicr.example.com:8443"],
    });
    expect(result?.href).toBe("https://aicr.example.com:8443/");
  });
});

describe("serve with proxy headers", () => {
  it("trusts X-Forwarded headers from loopback when trustProxy is loopback", async () => {
    const app = new Hono();
    let receivedUrl = "";
    app.get("/test", (c) => {
      receivedUrl = c.req.url;
      return c.json({ ok: true });
    });

    const server = await serveAsync(app, {
      port: 0,
      proxy: { trustProxy: "loopback" },
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/test`, {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "aicr.example.com:8443",
          "X-Forwarded-Prefix": "/aicr",
        },
      });
      expect(response.status).toBe(200);
      expect(receivedUrl).toContain("https://aicr.example.com:8443/test");
    } finally {
      server.close();
    }
  });

  it("ignores X-Forwarded headers when trustProxy is false", async () => {
    const app = new Hono();
    let receivedUrl = "";
    app.get("/test", (c) => {
      receivedUrl = c.req.url;
      return c.json({ ok: true });
    });

    const server = await serveAsync(app, {
      port: 0,
      proxy: { trustProxy: false },
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/test`, {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "aicr.example.com",
        },
      });
      expect(response.status).toBe(200);
      expect(receivedUrl).toContain("http://");
      expect(receivedUrl).not.toContain("https://aicr.example.com");
    } finally {
      server.close();
    }
  });

  it("ignores X-Forwarded headers from untrusted remote", async () => {
    const app = new Hono();
    let receivedUrl = "";
    app.get("/test", (c) => {
      receivedUrl = c.req.url;
      return c.json({ ok: true });
    });

    const server = await serveAsync(app, {
      port: 0,
      proxy: { trustProxy: ["192.168.1.0/24"] },
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/test`, {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "aicr.example.com",
        },
      });
      expect(response.status).toBe(200);
      expect(receivedUrl).toContain("http://");
      expect(receivedUrl).not.toContain("https://aicr.example.com");
    } finally {
      server.close();
    }
  });
});

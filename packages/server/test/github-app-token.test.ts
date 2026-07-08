import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GithubAppTokenService,
  createGithubAppTokenService,
  decodePrivateKey,
  resolveGithubApiBaseUrl,
  resolveGithubAppTriggerAuth,
  resolvePrivateKey,
} from "../src/github-app-token.js";

interface TestKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

function generateRsaKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey: publicKey.toString(), privateKey: privateKey.toString() };
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerB64, payloadB64] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>,
  };
}

function mockFetchForToken(
  keyPair: TestKeyPair,
  options: {
    readonly installationToken?: string;
    readonly installationId?: number;
    readonly expiresAt?: string;
    readonly tokenStatus?: number;
    readonly installationStatus?: number;
    readonly calls?: { url: string; method: string; auth: string }[];
  },
): typeof fetch {
  const calls = options.calls ?? [];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const auth = init?.headers instanceof Headers
      ? init.headers.get("Authorization") ?? ""
      : (init?.headers as Record<string, string>)?.Authorization ?? "";
    calls.push({ url: urlStr, method: init?.method ?? "GET", auth });

    if (urlStr.includes("/app/installations/") && urlStr.endsWith("/access_tokens")) {
      const status = options.tokenStatus ?? 201;
      if (status !== 200 && status !== 201) {
        return new Response("{}", { status });
      }
      return new Response(
        JSON.stringify({
          token: options.installationToken ?? "ghs_TESTTOKEN123456",
          expires_at: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        { status },
      );
    }

    if (urlStr.includes("/repos/") && urlStr.endsWith("/installation")) {
      const status = options.installationStatus ?? 200;
      if (status !== 200) {
        return new Response("{}", { status });
      }
      return new Response(
        JSON.stringify({ id: options.installationId ?? 999999 }),
        { status },
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("GithubAppTokenService", () => {
  const keyPair = generateRsaKeyPair();

  describe("JWT signing", () => {
    it("signs an RS256 JWT with correct header, issuer, iat and exp", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const fixedNow = new Date("2026-01-15T12:00:00Z");
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls }),
        now: () => fixedNow,
      });

      return service.getInstallationToken(7890123).then(() => {
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        expect(tokenCall).toBeDefined();
        const auth = tokenCall!.auth;
        expect(auth).toMatch(/^Bearer eyJ/u);

        const jwt = auth.replace(/^Bearer /u, "");
        const decoded = decodeJwt(jwt);
        expect(decoded.header).toEqual({ alg: "RS256", typ: "JWT" });
        expect(decoded.payload.iss).toBe("123456");

        const expectedIat = Math.floor(fixedNow.getTime() / 1000) - 60;
        const expectedExp = expectedIat + 540;
        expect(decoded.payload.iat).toBe(expectedIat);
        expect(decoded.payload.exp).toBe(expectedExp);
      });
    });

    it("uses client_id as issuer when app_id is not set", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        clientId: "Iv1.0123456789abcdef",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls }),
      });

      return service.getInstallationToken(1).then(() => {
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        const jwt = tokenCall!.auth.replace(/^Bearer /u, "");
        const decoded = decodeJwt(jwt);
        expect(decoded.payload.iss).toBe("Iv1.0123456789abcdef");
      });
    });
  });

  describe("installation token", () => {
    it("POSTs to /app/installations/{id}/access_tokens with JWT and correct headers", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, {
          calls,
          installationToken: "ghs_MYTOKEN",
        }),
      });

      return service.getInstallationToken(7890123).then((token) => {
        expect(token).toBe("ghs_MYTOKEN");
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        expect(tokenCall!.method).toBe("POST");
        expect(tokenCall!.url).toContain("/app/installations/7890123/access_tokens");
      });
    });

    it("caches the installation token and reuses it within validity window", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls, expiresAt: expiresAt.toISOString() }),
      });

      return service.getInstallationToken(42).then((token1) =>
        service.getInstallationToken(42).then((token2) => {
          expect(token1).toBe(token2);
          const tokenCalls = calls.filter((c) => c.url.includes("/access_tokens"));
          expect(tokenCalls).toHaveLength(1);
        }),
      );
    });

    it("refreshes the token when remaining validity is less than 5 minutes", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      let callCount = 0;
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        callCount++;
        calls.push({ url: urlStr, method: init?.method ?? "GET", auth: "" });

        if (urlStr.includes("/access_tokens")) {
          const expiresIn = callCount === 1 ? 3 * 60 * 1000 : 60 * 60 * 1000;
          return new Response(
            JSON.stringify({
              token: `ghs_TOKEN${callCount}`,
              expires_at: new Date(Date.now() + expiresIn).toISOString(),
            }),
            { status: 201 },
          );
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl,
      });

      return service.getInstallationToken(1).then((token1) => {
        expect(token1).toBe("ghs_TOKEN1");
        return service.getInstallationToken(1).then((token2) => {
          expect(token2).toBe("ghs_TOKEN2");
          const tokenCalls = calls.filter((c) => c.url.includes("/access_tokens"));
          expect(tokenCalls).toHaveLength(2);
        });
      });
    });
  });

  describe("installation resolution", () => {
    it("GETs /repos/{owner}/{repo}/installation and caches the id", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls, installationId: 555555 }),
      });

      return service.resolveInstallationId("my-org", "my-repo").then((id) => {
        expect(id).toBe(555555);
        const installCall = calls.find((c) => c.url.includes("/repos/my-org/my-repo/installation"));
        expect(installCall!.method).toBe("GET");

        return service.resolveInstallationId("my-org", "my-repo").then((id2) => {
          expect(id2).toBe(555555);
          const installCalls = calls.filter((c) => c.url.includes("/repos/my-org/my-repo/installation"));
          expect(installCalls).toHaveLength(1);
        });
      });
    });

    it("getInstallationTokenForRepo uses configured installationId when set", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        installationId: 7777777,
        fetchImpl: mockFetchForToken(keyPair, { calls }),
      });

      return service.getInstallationTokenForRepo("my-org", "my-repo").then(() => {
        const installLookupCalls = calls.filter((c) => c.url.includes("/repos/"));
        expect(installLookupCalls).toHaveLength(0);
        const tokenCalls = calls.filter((c) => c.url.includes("/access_tokens"));
        expect(tokenCalls[0]!.url).toContain("/app/installations/7777777/access_tokens");
      });
    });

    it("getInstallationTokenForRepo resolves installation id then fetches token", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls, installationId: 333333 }),
      });

      return service.getInstallationTokenForRepo("my-org", "my-repo").then((token) => {
        expect(token).toBe("ghs_TESTTOKEN123456");
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        expect(tokenCall!.url).toContain("/app/installations/333333/access_tokens");
      });
    });
  });

  describe("GHE base URL", () => {
    it("derives /api/v3 from a GHE base_url", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        baseUrl: "https://ghe.example.com",
        fetchImpl: mockFetchForToken(keyPair, { calls }),
      });

      return service.getInstallationToken(1).then(() => {
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        expect(tokenCall!.url).toContain("https://ghe.example.com/api/v3/app/installations/1/access_tokens");
      });
    });

    it("uses https://api.github.com for github.com base_url", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        baseUrl: "https://github.com",
        fetchImpl: mockFetchForToken(keyPair, { calls }),
      });

      return service.getInstallationToken(1).then(() => {
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        expect(tokenCall!.url).toContain("https://api.github.com/app/installations/1/access_tokens");
      });
    });

    it("uses https://api.github.com when no base_url is set", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls }),
      });

      return service.getInstallationToken(1).then(() => {
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        expect(tokenCall!.url).toContain("https://api.github.com/app/installations/1/access_tokens");
      });
    });
  });

  describe("error mapping", () => {
    it("maps 401 to a JWT rejection error", () => {
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { tokenStatus: 401 }),
      });

      return expect(service.getInstallationToken(1)).rejects.toThrow(/JWT rejected \(401\)/u);
    });

    it("maps 403 to a permissions error", () => {
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { tokenStatus: 403 }),
      });

      return expect(service.getInstallationToken(1)).rejects.toThrow(/forbidden \(403\)/u);
    });

    it("maps 404 on installation lookup to a not-found error", () => {
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { installationStatus: 404 }),
      });

      return expect(service.resolveInstallationId("my-org", "my-repo"))
        .rejects.toThrow(/not found \(404\).*my-org\/my-repo/u);
    });
  });

  describe("private key decode", () => {
    it("passes through raw PEM", () => {
      expect(decodePrivateKey(keyPair.privateKey)).toBe(keyPair.privateKey.trim());
    });

    it("decodes base64-encoded PEM", () => {
      const encoded = Buffer.from(keyPair.privateKey, "utf8").toString("base64");
      expect(decodePrivateKey(encoded)).toBe(keyPair.privateKey.trim());
    });
  });

  describe("resolvePrivateKey", () => {
    it("reads PEM from env var", async () => {
      const pem = await resolvePrivateKey("MY_KEY", undefined, (name) =>
        name === "MY_KEY" ? keyPair.privateKey : undefined,
      );
      expect(pem).toBe(keyPair.privateKey.trim());
    });

    it("decodes base64 PEM from env var", async () => {
      const encoded = Buffer.from(keyPair.privateKey, "utf8").toString("base64");
      const pem = await resolvePrivateKey("MY_KEY", undefined, (name) =>
        name === "MY_KEY" ? encoded : undefined,
      );
      expect(pem).toBe(keyPair.privateKey.trim());
    });

    it("throws when env var is not set", async () => {
      await expect(resolvePrivateKey("MISSING_KEY", undefined, () => undefined))
        .rejects.toThrow(/not set in the environment/u);
    });

    it("throws when neither env nor path is provided", async () => {
      await expect(resolvePrivateKey(undefined, undefined, () => undefined))
        .rejects.toThrow(/requires private_key_env or private_key_path/u);
    });
  });

  describe("resolveGithubAppTriggerAuth", () => {
    it("resolves app config from trigger config", async () => {
      const auth = await resolveGithubAppTriggerAuth(
        {
          app: {
            app_id: "123456",
            private_key_env: "MY_KEY",
          },
          base_url: "https://ghe.example.com",
        },
        (name) => (name === "MY_KEY" ? keyPair.privateKey : undefined),
      );

      expect(auth.appId).toBe("123456");
      expect(auth.privateKey).toBe(keyPair.privateKey.trim());
      expect(auth.baseUrl).toBe("https://ghe.example.com");
    });

    it("coerces numeric installation_id", async () => {
      const auth = await resolveGithubAppTriggerAuth(
        {
          app: {
            client_id: "Iv1.test",
            private_key_env: "MY_KEY",
            installation_id: 7890123,
          },
        },
        (name) => (name === "MY_KEY" ? keyPair.privateKey : undefined),
      );

      expect(auth.clientId).toBe("Iv1.test");
      expect(auth.installationId).toBe(7890123);
    });
  });

  describe("createGithubAppTokenService", () => {
    it("creates a service from resolved auth", () => {
      const service = createGithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        baseUrl: "https://ghe.example.com",
      });

      expect(service).toBeInstanceOf(GithubAppTokenService);
    });
  });

  describe("evict", () => {
    it("evicts a single installation token", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls }),
      });

      return service.getInstallationToken(1).then(() => {
        service.evict(1);
        return service.getInstallationToken(1).then(() => {
          const tokenCalls = calls.filter((c) => c.url.includes("/access_tokens"));
          expect(tokenCalls).toHaveLength(2);
        });
      });
    });

    it("evicts all caches when called without an installationId", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        fetchImpl: mockFetchForToken(keyPair, { calls }),
      });

      return service.getInstallationToken(1).then(() => {
        service.evict();
        return service.getInstallationToken(1).then(() => {
          const tokenCalls = calls.filter((c) => c.url.includes("/access_tokens"));
          expect(tokenCalls).toHaveLength(2);
        });
      });
    });
  });

  describe("NaN installation_id safety", () => {
    it("falls back to repo-based resolution when installationId is NaN", () => {
      const calls: { url: string; method: string; auth: string }[] = [];
      const service = new GithubAppTokenService({
        appId: "123456",
        privateKey: keyPair.privateKey,
        installationId: NaN,
        fetchImpl: mockFetchForToken(keyPair, { calls, installationId: 555555 }),
      });

      return service.getInstallationTokenForRepo("my-org", "my-repo").then(() => {
        const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
        expect(tokenCall!.url).toContain("/app/installations/555555/access_tokens");
        expect(tokenCall!.url).not.toContain("NaN");
      });
    });
  });
});

describe("GithubAppTokenService validation", () => {
  it("throws when neither appId nor clientId is provided", () => {
    expect(() => new GithubAppTokenService({ privateKey: "key" })).toThrow(/appId or clientId/u);
  });

  it("throws when privateKey is empty", () => {
    expect(() => new GithubAppTokenService({ appId: "1", privateKey: "" })).toThrow(/private key/u);
  });
});

describe("resolveGithubApiBaseUrl", () => {
  it("defaults to https://api.github.com when no base_url is set", () => {
    expect(resolveGithubApiBaseUrl(undefined)).toBe("https://api.github.com");
  });

  it("maps the github.com host to the REST API host", () => {
    expect(resolveGithubApiBaseUrl("https://github.com")).toBe("https://api.github.com");
    expect(resolveGithubApiBaseUrl("https://github.com/")).toBe("https://api.github.com");
    expect(resolveGithubApiBaseUrl("http://github.com")).toBe("https://api.github.com");
  });

  it("passes through https://api.github.com unchanged", () => {
    expect(resolveGithubApiBaseUrl("https://api.github.com")).toBe("https://api.github.com");
    expect(resolveGithubApiBaseUrl("https://api.github.com/")).toBe("https://api.github.com");
  });

  it("derives /api/v3 from a GHE host", () => {
    expect(resolveGithubApiBaseUrl("https://ghe.example.com")).toBe("https://ghe.example.com/api/v3");
    expect(resolveGithubApiBaseUrl("https://ghe.example.com/")).toBe("https://ghe.example.com/api/v3");
  });

  it("passes through a GHE /api/v3 URL unchanged (backward compatible)", () => {
    expect(resolveGithubApiBaseUrl("https://ghe.example.com/api/v3")).toBe("https://ghe.example.com/api/v3");
    expect(resolveGithubApiBaseUrl("https://ghe.example.com/api/v3/")).toBe("https://ghe.example.com/api/v3");
  });
});

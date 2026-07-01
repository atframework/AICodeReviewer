import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { createAuthMiddleware, resolveWorkspaceAuth, type AuthConfig } from "../src/auth.js";

function buildProtectedApp(config: AuthConfig): Hono {
	const app = new Hono();
	app.use("*", createAuthMiddleware(config));
	app.all("/protected", (c) => c.json({ ok: true }, 200));
	return app;
}

describe("createAuthMiddleware", () => {
	describe("passthrough (no enforcement)", () => {
		it("passes through when enabled but no global or workspace keys are configured", async () => {
			const app = buildProtectedApp({ enabled: true, workspaceApiKeys: new Map() });
			const res = await app.request("/protected");
			expect(res.status).toBe(200);
		});

		it("passes through when auth is disabled", async () => {
			const app = buildProtectedApp({ enabled: false, workspaceApiKeys: new Map() });
			const res = await app.request("/protected");
			expect(res.status).toBe(200);
		});

		it("still passes through with a workspace key map that is empty even if a global key is missing", async () => {
			const app = buildProtectedApp({ enabled: true, workspaceApiKeys: new Map() });
			const res = await app.request("/protected", { headers: { "x-api-key": "anything" } });
			expect(res.status).toBe(200);
		});
	});

	describe("token enforcement", () => {
		const config: AuthConfig = {
			enabled: true,
			globalApiKey: "global-secret",
			workspaceApiKeys: new Map([
				["ws-a", "ws-a-secret"],
			]),
		};

		it("rejects a request without any token with 401 unauthorized", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected");
			expect(res.status).toBe(401);
			const body = await res.json();
			expect(body.error).toBe("unauthorized");
		});

		it("rejects a request with a wrong token with 403 forbidden", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected", { headers: { "x-api-key": "wrong" } });
			expect(res.status).toBe(403);
			const body = await res.json();
			expect(body.error).toBe("forbidden");
		});

		it("rejects a token of a different length via timing-safe comparison", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected", { headers: { "x-api-key": "x" } });
			expect(res.status).toBe(403);
		});

		it("accepts a valid global key via the X-API-Key header", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected", { headers: { "x-api-key": "global-secret" } });
			expect(res.status).toBe(200);
		});

		it("accepts a valid global key via Authorization: Bearer", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected", { headers: { authorization: "Bearer global-secret" } });
			expect(res.status).toBe(200);
		});

		it("matches the Bearer scheme case-insensitively", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected", { headers: { authorization: "bearer global-secret" } });
			expect(res.status).toBe(200);
		});

		it("does not extract a raw token sent in Authorization without the Bearer scheme", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected", { headers: { authorization: "global-secret" } });
			expect(res.status).toBe(401);
		});

		it("accepts a per-workspace key", async () => {
			const app = buildProtectedApp(config);
			const res = await app.request("/protected", { headers: { "x-api-key": "ws-a-secret" } });
			expect(res.status).toBe(200);
		});

		it("prefers X-API-Key over Authorization when both headers are present", async () => {
			const app = buildProtectedApp({
				enabled: true,
				globalApiKey: "global-secret",
				workspaceApiKeys: new Map(),
			});
			const res = await app.request("/protected", {
				headers: { "x-api-key": "global-secret", authorization: "Bearer wrong" },
			});
			expect(res.status).toBe(200);
		});

		it("enforces auth for a workspace-only configuration", async () => {
			const app = buildProtectedApp({
				enabled: true,
				workspaceApiKeys: new Map([["ws-b", "ws-b-secret"]]),
			});
			expect((await app.request("/protected")).status).toBe(401);
			expect(
				(await app.request("/protected", { headers: { "x-api-key": "ws-b-secret" } })).status,
			).toBe(200);
			expect(
				(await app.request("/protected", { headers: { "x-api-key": "global-secret" } })).status,
			).toBe(403);
		});
	});
});

describe("resolveWorkspaceAuth", () => {
	it("resolves the api key from the configured env var", () => {
		const result = resolveWorkspaceAuth(
			{ auth: { api_key_env: "WS_KEY", enabled: true } },
			(name) => (name === "WS_KEY" ? "resolved-key" : undefined),
		);
		expect(result).toEqual({ apiKey: "resolved-key", enabled: true });
	});

	it("defaults enabled to true when auth config omits enabled", () => {
		const result = resolveWorkspaceAuth(
			{ auth: { api_key_env: "WS_KEY" } },
			(name) => (name === "WS_KEY" ? "resolved-key" : undefined),
		);
		expect(result?.enabled).toBe(true);
		expect(result?.apiKey).toBe("resolved-key");
	});

	it("returns enabled false when explicitly disabled", () => {
		const result = resolveWorkspaceAuth(
			{ auth: { api_key_env: "WS_KEY", enabled: false } },
			() => "ignored",
		);
		expect(result?.enabled).toBe(false);
	});

	it("omits apiKey when the env var cannot be resolved", () => {
		const result = resolveWorkspaceAuth(
			{ auth: { api_key_env: "MISSING" } },
			() => undefined,
		);
		expect(result).toEqual({ enabled: true });
		expect("apiKey" in (result ?? {})).toBe(false);
	});

	it("returns undefined when no auth config is present", () => {
		expect(resolveWorkspaceAuth({}, () => "x")).toBeUndefined();
	});

	it("returns undefined when auth is not an object", () => {
		expect(resolveWorkspaceAuth({ auth: "not-an-object" }, () => "x")).toBeUndefined();
	});
});

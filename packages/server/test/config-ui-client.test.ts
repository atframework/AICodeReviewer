import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigApiClient } from "../src/dashboard/client/api-client.js";

afterEach(() => vi.unstubAllGlobals());
const client = () => createConfigApiClient({ getToken: () => "test-token", onUnauthorized: vi.fn() });
const page = (revision: number, records: object[], nextOffset: number | null) => ({ head: { activeRevision: revision }, fileDigest: "a", collections: { provider: { count: 3, records, nextOffset } } });

describe("configuration browser API client", () => {
  it("reads all entity pages without mixing revisions", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(page(1, [{ id: "a" }], 1)))
      .mockResolvedValueOnce(Response.json(page(1, [{ id: "b" }, { id: "c" }], null)));
    vi.stubGlobal("fetch", fetch);
    expect((await client().getCollection("provider")).collections.provider.records).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(fetch.mock.calls[0]?.[0]).toContain("collections/provider");
    expect(fetch.mock.calls[1]?.[0]).toContain("offset=1");
  });
  it("rejects a collection whose head moves during pagination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(page(1, [{ id: "a" }], 1)))
      .mockResolvedValueOnce(Response.json(page(2, [{ id: "b" }], null))));
    await expect(client().getCollection("provider")).rejects.toMatchObject({ kind: "conflict" });
  });
  it("rejects an incomplete later page instead of silently dropping records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(page(1, [{ id: "a" }], 1)))
      .mockResolvedValueOnce(Response.json({ head: { activeRevision: 1 }, fileDigest: "a", collections: {} })));
    await expect(client().getCollection("provider")).rejects.toMatchObject({ kind: "network" });
  });
  it("builds shell, fields, globals and builtin-assets requests", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ head: null, fileDigest: "a" })));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    await api.getShell();
    await api.getFields({ page: "review" });
    await api.getFields({ prefix: "outputs.routes" });
    await api.getGlobals("outputs.routes");
    await api.getBuiltinAssets("templates");
    await api.getProviderPresets();
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toMatch(/admin\/config$/);
    expect(urls[1]).toContain("fields?page=review");
    expect(urls[2]).toContain("prefix=outputs.routes");
    expect(urls[3]).toContain("globals?prefix=outputs.routes");
    expect(urls[4]).toContain("builtin-assets?kind=templates");
    expect(urls[5]).toContain("provider-presets");
  });
  it("treats an interrupted successful POST response as an unknown network outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"status":"committed"', { status: 200 })));
    await expect(client().saveChangeset({ baseRevision: 1, fileDigest: "a", operationId: "op-12345", operations: [] })).rejects.toMatchObject({ kind: "network" });
  });
  it("retains 202 activation state and invokes the unauthorized callback", async () => {
    const unauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ revision: { revision: 2 } }, { status: 202 }))
      .mockResolvedValueOnce(new Response("expired", { status: 401 })));
    const api = createConfigApiClient({ getToken: () => "x", onUnauthorized: unauthorized });
    await expect(api.getOperation("op-12345")).rejects.toMatchObject({ kind: "activating", revision: { revision: 2 } });
    await expect(api.getStatus()).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});

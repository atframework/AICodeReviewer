import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigApiClient } from "../src/dashboard/client/api-client.js";

afterEach(() => vi.unstubAllGlobals());
const client = () => createConfigApiClient({ getToken: () => "test-token", onUnauthorized: vi.fn() });
const view = (revision: number, records: object[], nextOffset: number | null) => ({ head: { activeRevision: revision }, fileDigest: "a", collections: { provider: { count: 3, records, nextOffset } }, fields: [] });

describe("configuration browser API client", () => {
  it("reads all entity pages without mixing revisions", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(view(1, [{ id: "a" }], 1)))
      .mockResolvedValueOnce(Response.json(view(1, [{ id: "b" }, { id: "c" }], null)));
    vi.stubGlobal("fetch", fetch);
    expect((await client().getView()).collections.provider.records).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(fetch.mock.calls[1]?.[0]).toContain("offset=1");
  });
  it("rejects a view whose head moves during pagination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(view(1, [{ id: "a" }], 1)))
      .mockResolvedValueOnce(Response.json(view(2, [{ id: "b" }], null))));
    await expect(client().getView()).rejects.toMatchObject({ kind: "conflict" });
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

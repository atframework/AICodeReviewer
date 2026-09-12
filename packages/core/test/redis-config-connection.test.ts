import { describe, expect, it, vi } from "vitest";
import { createRedisConfigStore } from "../src/redis-config-store.js";

const calls = vi.hoisted(() => ({ constructor: vi.fn(), quit: vi.fn(async () => {}), disconnect: vi.fn() }));
vi.mock("ioredis", () => ({ Redis: class {
  constructor(...args: unknown[]) { calls.constructor(...args); }
  quit = calls.quit;
  disconnect = calls.disconnect;
} }));

describe("Redis config connection options", () => {
  it("preserves TLS, ACL username and escaped credentials for native URL parsing", async () => {
    const url = "rediss://config-user:p%40ss%2Fword@redis.example:6380/4";
    const store = await createRedisConfigStore({ connection: { url } });
    expect(calls.constructor).toHaveBeenLastCalledWith(url, expect.objectContaining({ connectTimeout: 5000, maxRetriesPerRequest: 2 }));
    calls.quit.mockRejectedValueOnce(new Error("connection lost"));
    await store.close();
    expect(calls.disconnect).toHaveBeenCalled();
  });
});

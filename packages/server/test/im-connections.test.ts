import { describe, expect, it } from "vitest";

import { ImConnectionRegistry, resolveWeComAppCredentials } from "../src/im/connections.js";

describe("WeCom application credential resolution (IM-04)", () => {
  it("literal wins, env fallback resolves, and missing credentials fail loudly", () => {
    expect(resolveWeComAppCredentials({ corp_id: "ww", agent_id: 1, app_secret: "lit", app_secret_env: "X" }, () => "env"))
      .toMatchObject({ appSecret: "lit" });
    expect(resolveWeComAppCredentials({ corp_id: "ww", agent_id: 1, app_secret_env: "X" }, (name) => (name === "X" ? "env-value" : undefined)))
      .toMatchObject({ appSecret: "env-value" });
    expect(() => resolveWeComAppCredentials({ corp_id: "ww", agent_id: 1, app_secret_env: "X" }, () => undefined))
      .toThrow(/app_secret/u);
    expect(() => resolveWeComAppCredentials({ corp_id: "ww", agent_id: 1 }, () => "unused")).toThrow(/app_secret/u);
  });

  it("caches by credential identity: rotation and agent changes isolate clients", () => {
    const registry = new ImConnectionRegistry({ env: (name) => (name === "ROTATED" ? "rotated-secret" : undefined) });
    const first = registry.wecomApp({ corp_id: "ww", agent_id: 1, app_secret: "a" });
    expect(registry.wecomApp({ corp_id: "ww", agent_id: 1, app_secret: "a" })).toBe(first);
    expect(registry.wecomApp({ corp_id: "ww", agent_id: 2, app_secret: "a" })).not.toBe(first);
    expect(registry.wecomApp({ corp_id: "ww", agent_id: 1, app_secret: "b" })).not.toBe(first);
    expect(registry.wecomApp({ corp_id: "ww", agent_id: 1, app_secret_env: "ROTATED" })).not.toBe(first);
    expect(registry.wecomApp({ corp_id: "ww", agent_id: 1, app_secret: "a" })).toBe(first);
  });

  it("dispose drops cached clients; unresolved env names surface configuration errors", () => {
    const registry = new ImConnectionRegistry();
    const first = registry.wecomApp({ corp_id: "ww", agent_id: 1, app_secret: "a" });
    registry.dispose();
    expect(registry.wecomApp({ corp_id: "ww", agent_id: 1, app_secret: "a" })).not.toBe(first);
    const bare = new ImConnectionRegistry();
    expect(() => bare.wecomApp({ corp_id: "ww", agent_id: 1, app_secret_env: "NO_ACCESS" })).toThrow(/app_secret/u);
  });
});

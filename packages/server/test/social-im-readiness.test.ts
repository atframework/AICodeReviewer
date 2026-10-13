import { describe, expect, it, vi } from "vitest";
import { createStoreDb, closeStoreDb } from "@aicr/store";
import type { FetchLike } from "@aicr/outputs";
import { SocialImReadinessService } from "../src/im/connections.js";
import { handleSocialCallback } from "../src/im/social-callback.js";
import {
  apiFixture,
  callbackRequest,
  fixture,
  NOW,
  platforms,
} from "./social-im-fixtures.js";

describe.each(platforms)("%s background readiness", (platform) => {
  it("refreshes before expiry and acknowledges commands while metadata refresh is pending", async () => {
    const f = fixture(platform);
    let time = NOW;
    let blocked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = apiFixture(platform);
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (blocked) await gate;
      return normal(url, init);
    });
    const service = new SocialImReadinessService({
      getConfig: () => f.config,
      fetch,
      now: () => time,
    });
    const store = createStoreDb(":memory:");
    try {
      await service.refresh();
      const client = service.client(f.config, "bot")!;
      expect(client.isReady(f.destination)).toBe(true);
      const warmedCalls = fetch.mock.calls.length;
      time = NOW + 239999;
      await service.refresh();
      expect(fetch).toHaveBeenCalledTimes(warmedCalls);
      time = NOW + 240000;
      blocked = true;
      const refresh = service.refresh();
      expect(fetch).toHaveBeenCalledTimes(warmedCalls + 1);
      expect(client.isReady(f.destination)).toBe(true);
      const response = await handleSocialCallback(
        callbackRequest(platform, "help"),
        "bot",
        f.config,
        f.connection,
        { snapshotId: null, fileDigest: "fixture" },
        {
          store,
          namespace: "readiness-test",
          env: () => undefined,
          now: () => time,
          socialClient: (config, name) => service.client(config, name),
        },
      );
      expect(response.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(warmedCalls + 1);
      expect(
        store.sqlite.prepare("SELECT COUNT(*) AS count FROM im_inbox").get(),
      ).toEqual({ count: 1 });
      time = NOW + 299999;
      release();
      await refresh;
      time = NOW + 300000;
      expect(client.isReady(f.destination)).toBe(true);
      const renewedCalls = fetch.mock.calls.length;
      await service.refresh();
      expect(fetch).toHaveBeenCalledTimes(renewedCalls);
      expect(
        store.sqlite
          .prepare("SELECT COUNT(*) AS count FROM im_review_requests")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      release();
      service.dispose();
      await closeStoreDb(store);
    }
  });
});

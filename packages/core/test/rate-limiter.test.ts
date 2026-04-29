import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createTokenBucketRateLimiter,
  createMultiProviderRateLimiter,
} from "../src/rate-limiter.js";

describe("createTokenBucketRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a rate limiter with the given name", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10 });
    expect(limiter.name).toBe("test");
  });

  it("acquires tokens up to burst limit", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10, burst: 5 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.acquire()).toBe(true);
    }
    expect(limiter.acquire()).toBe(false);
  });

  it("defaults burst to max(rps, 1)", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 3 });
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(false);
  });

  it("refills tokens over time", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10, burst: 5 });
    for (let i = 0; i < 5; i++) {
      limiter.acquire();
    }
    expect(limiter.acquire()).toBe(false);

    vi.advanceTimersByTime(200);
    expect(limiter.acquire()).toBe(true);
  });

  it("never exceeds burst capacity", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10, burst: 3 });
    vi.advanceTimersByTime(10000);
    expect(limiter.getAvailableTokens()).toBe(3);
  });

  it("returns correct available tokens", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10, burst: 10 });
    expect(limiter.getAvailableTokens()).toBe(10);
    limiter.acquire();
    limiter.acquire();
    expect(limiter.getAvailableTokens()).toBe(8);
  });

  it("returns correct wait time when no tokens available", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10, burst: 1 });
    limiter.acquire();
    const waitMs = limiter.getWaitMs();
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(1000);
  });

  it("returns zero wait time when tokens available", () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10, burst: 5 });
    expect(limiter.getWaitMs()).toBe(0);
  });

  it("acquireAsync waits until token available", async () => {
    const limiter = createTokenBucketRateLimiter("test", { rps: 10, burst: 1 });
    limiter.acquire();

    const acquirePromise = limiter.acquireAsync();
    vi.advanceTimersByTime(110);
    await acquirePromise;
  });
});

describe("createMultiProviderRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates limiters for each provider", () => {
    const multi = createMultiProviderRateLimiter({ openai: 10, anthropic: 5 });
    expect(multi.getLimiter("openai")).toBeDefined();
    expect(multi.getLimiter("anthropic")).toBeDefined();
    expect(multi.getLimiter("unknown")).toBeUndefined();
  });

  it("acquires tokens per provider independently", () => {
    const multi = createMultiProviderRateLimiter({ openai: 2, anthropic: 3 });
    expect(multi.acquire("openai")).toBe(true);
    expect(multi.acquire("openai")).toBe(true);
    expect(multi.acquire("openai")).toBe(false);
    expect(multi.acquire("anthropic")).toBe(true);
    expect(multi.acquire("anthropic")).toBe(true);
    expect(multi.acquire("anthropic")).toBe(true);
    expect(multi.acquire("anthropic")).toBe(false);
  });

  it("returns true for unconfigured providers (no limit)", () => {
    const multi = createMultiProviderRateLimiter({ openai: 10 });
    expect(multi.acquire("unknown-provider")).toBe(true);
    expect(multi.acquire("unknown-provider")).toBe(true);
    expect(multi.acquire("unknown-provider")).toBe(true);
  });

  it("returns Infinity available tokens for unconfigured providers", () => {
    const multi = createMultiProviderRateLimiter({ openai: 10 });
    expect(multi.getAvailableTokens("unknown")).toBe(Infinity);
  });

  it("acquireAsync waits for configured providers", async () => {
    const multi = createMultiProviderRateLimiter({ openai: 10, anthropic: 10 });
    for (let i = 0; i < 10; i++) {
      multi.acquire("openai");
    }

    const acquirePromise = multi.acquireAsync("openai");
    vi.advanceTimersByTime(200);
    await acquirePromise;
  });

  it("acquireAsync returns immediately for unconfigured providers", async () => {
    const multi = createMultiProviderRateLimiter({ openai: 10 });
    await multi.acquireAsync("unknown");
  });

  it("respects per-provider rate limits independently", () => {
    const multi = createMultiProviderRateLimiter({ providerA: 1, providerB: 1 });

    multi.acquire("providerA");
    expect(multi.acquire("providerA")).toBe(false);
    expect(multi.acquire("providerB")).toBe(true);
    expect(multi.acquire("providerB")).toBe(false);
  });
});

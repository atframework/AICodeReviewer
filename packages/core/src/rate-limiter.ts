export interface RateLimiterConfig {
  readonly rps: number;
  readonly burst?: number;
}

export interface RateLimiter {
  readonly name: string;
  acquire(): boolean;
  acquireAsync(): Promise<void>;
  getAvailableTokens(): number;
  getWaitMs(): number;
}

export function createTokenBucketRateLimiter(
  name: string,
  config: RateLimiterConfig | (() => RateLimiterConfig),
): RateLimiter {
  const readConfig = () => typeof config === "function" ? config() : config;
  let rps = readConfig().rps;
  let burst = readConfig().burst ?? Math.max(rps, 1);
  let tokens = burst;
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(burst, tokens + elapsed * rps);
    lastRefill = now;
    const latest = readConfig();
    rps = latest.rps;
    burst = latest.burst ?? Math.max(rps, 1);
    tokens = Math.min(tokens, burst);
  }

  return {
    name,

    acquire(): boolean {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },

    async acquireAsync(): Promise<void> {
      while (true) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const waitMs = Math.ceil(((1 - tokens) / rps) * 1000);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(waitMs, 10));
        });
      }
    },

    getAvailableTokens(): number {
      refill();
      return Math.floor(tokens);
    },

    getWaitMs(): number {
      refill();
      if (tokens >= 1) return 0;
      return Math.ceil(((1 - tokens) / rps) * 1000);
    },
  };
}

export interface MultiProviderRateLimiter {
  acquire(providerId: string): boolean;
  acquireAsync(providerId: string): Promise<void>;
  getAvailableTokens(providerId: string): number;
  getLimiter(providerId: string): RateLimiter | undefined;
}

export function createMultiProviderRateLimiter(
  configs: Readonly<Record<string, number>> | (() => Readonly<Record<string, number>>),
): MultiProviderRateLimiter {
  const limiters = new Map<string, RateLimiter>();

  const readConfigs = () => typeof configs === "function" ? configs() : configs;
  const getLimiter = (providerId: string): RateLimiter | undefined => {
    const rps = readConfigs()[providerId];
    if (rps === undefined) return undefined;
    let limiter = limiters.get(providerId);
    if (!limiter) {
      limiter = createTokenBucketRateLimiter(providerId, () => ({ rps: readConfigs()[providerId] ?? rps }));
      limiters.set(providerId, limiter);
    }
    return limiter;
  };

  return {
    acquire(providerId: string): boolean {
      const limiter = getLimiter(providerId);
      if (!limiter) return true;
      return limiter.acquire();
    },

    async acquireAsync(providerId: string): Promise<void> {
      const limiter = getLimiter(providerId);
      if (!limiter) return;
      await limiter.acquireAsync();
    },

    getAvailableTokens(providerId: string): number {
      const limiter = getLimiter(providerId);
      if (!limiter) return Infinity;
      return limiter.getAvailableTokens();
    },

    getLimiter(providerId: string): RateLimiter | undefined {
      return getLimiter(providerId);
    },
  };
}

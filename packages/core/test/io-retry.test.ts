import { describe, expect, it, vi } from "vitest";

import {
  computeTransientIoRetryDelay,
  isTransientIoError,
  isTransientIoHttpStatus,
  withTransientIoRetry,
} from "../src/io-retry.js";

describe("isTransientIoError", () => {
  it("detects Node system error codes", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH", "EPIPE"]) {
      const error = new Error("network failure") as Error & { code: string };
      error.code = code;
      expect(isTransientIoError(error), code).toBe(true);
    }
  });

  it("detects undici codes on the cause chain", () => {
    const cause = new Error("connect timeout") as Error & { code: string };
    cause.code = "UND_ERR_CONNECT_TIMEOUT";
    const error = new TypeError("fetch failed", { cause });
    expect(isTransientIoError(error)).toBe(true);
  });

  it("detects undici fetch failed by message", () => {
    expect(isTransientIoError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientIoError(new TypeError("terminated"))).toBe(true);
  });

  it("detects TimeoutError by name", () => {
    const error = new Error("deadline exceeded");
    error.name = "TimeoutError";
    expect(isTransientIoError(error)).toBe(true);
  });

  it("detects transient HTTP statuses carried on errors", () => {
    for (const status of [408, 500, 502, 503, 504]) {
      const error = new Error(`HTTP ${status}`) as Error & { status: number };
      error.status = status;
      expect(isTransientIoError(error), String(status)).toBe(true);
    }
  });

  it("detects timeout phrases in messages", () => {
    expect(isTransientIoError(new Error("Agent kilo timed out after 600061ms."))).toBe(true);
    expect(isTransientIoError(new Error("socket hang up"))).toBe(true);
  });

  it("detects VCS CLI network failures in messages", () => {
    expect(isTransientIoError(new Error("Command failed: git fetch\nfatal: unable to access 'https://example': Could not resolve host: example"))).toBe(true);
    expect(isTransientIoError(new Error("ssh: connect to host example port 22: Connection timed out"))).toBe(true);
    expect(isTransientIoError(new Error("fatal: The remote end hung up unexpectedly"))).toBe(true);
    expect(isTransientIoError(new Error("Perforce client error:\n\tConnect to server failed; check $P4PORT."))).toBe(true);
    expect(isTransientIoError(new Error("svn: E175002: Unable to connect to a repository at URL 'https://example'"))).toBe(true);
  });

  it("rejects permanent errors", () => {
    expect(isTransientIoError(new Error("fatal: path 'src/a.ts' does not exist in 'abc123'"))).toBe(false);
    expect(isTransientIoError(new Error("fatal: Invalid revision range 1..2"))).toBe(false);
    expect(isTransientIoError(new Error("401 Unauthorized"))).toBe(false);
    expect(isTransientIoError(null)).toBe(false);
    expect(isTransientIoError(undefined)).toBe(false);
    expect(isTransientIoError("ETIMEDOUT")).toBe(false);
    expect(isTransientIoError(new Error("worker terminated with exit code 1"))).toBe(false);
  });

  it("honors an explicit non-retryable marker anywhere in the cause chain", () => {
    const sideEffectError = Object.assign(new Error("fetch failed"), { retryable: false as const });
    const wrapped = new Error("Failed to post triage comment: fetch failed", { cause: sideEffectError });
    expect(isTransientIoError(wrapped)).toBe(false);
  });

  it("rejects non-transient HTTP statuses", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      const error = new Error(`HTTP ${status}`) as Error & { status: number };
      error.status = status;
      expect(isTransientIoError(error), String(status)).toBe(false);
    }
  });

  it("treats any 5xx as transient but excludes 429 (Retry-After must be honored upstream)", () => {
    expect(isTransientIoHttpStatus(501)).toBe(true);
    expect(isTransientIoHttpStatus(511)).toBe(true);
    expect(isTransientIoHttpStatus(429)).toBe(false);
    expect(isTransientIoHttpStatus(600)).toBe(false);
  });

  it("does not confuse the p4 trust warning with a transient failure", () => {
    const trustWarning = new Error(
      "Command failed: p4 describe -s 7216\n******* WARNING P4PORT IDENTIFICATION HAS CHANGED! *******\nTo allow connection use the 'p4 trust' command.\n",
    );
    expect(isTransientIoError(trustWarning)).toBe(false);
  });
});

describe("isTransientIoHttpStatus", () => {
  it("matches the transient status set", () => {
    expect(isTransientIoHttpStatus(503)).toBe(true);
    expect(isTransientIoHttpStatus(200)).toBe(false);
  });
});

describe("computeTransientIoRetryDelay", () => {
  it("grows exponentially and caps at maxMs", () => {
    const options = { baseMs: 100, maxMs: 250, jitter: false };
    expect(computeTransientIoRetryDelay(1, options)).toBe(100);
    expect(computeTransientIoRetryDelay(2, options)).toBe(200);
    expect(computeTransientIoRetryDelay(3, options)).toBe(250);
    expect(computeTransientIoRetryDelay(10, options)).toBe(250);
  });

  it("stays within jitter bounds", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = computeTransientIoRetryDelay(1, { baseMs: 100, maxMs: 1000, jitter: true });
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });
});

describe("withTransientIoRetry", () => {
  const fastOptions = { baseMs: 1, maxMs: 2, jitter: false };

  it("returns the first successful result without retrying", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    await expect(withTransientIoRetry(operation, fastOptions)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(1);
  });

  it("retries transient failures until success", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue("ok");
    await expect(withTransientIoRetry(operation, fastOptions)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-transient failures immediately", async () => {
    const permanent = new Error("404 not found");
    const operation = vi.fn().mockRejectedValue(permanent);
    await expect(withTransientIoRetry(operation, fastOptions)).rejects.toBe(permanent);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error after exhausting attempts", async () => {
    const failure = new TypeError("fetch failed");
    const operation = vi.fn().mockRejectedValue(failure);
    await expect(withTransientIoRetry(operation, { ...fastOptions, attempts: 2 })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("reports retries through onRetry", async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");
    await withTransientIoRetry(operation, { ...fastOptions, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(TypeError), 2, expect.any(Number));
  });

  it("honors a custom isRetryable predicate", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("custom retryable"));
    await expect(
      withTransientIoRetry(operation, { ...fastOptions, attempts: 2, isRetryable: () => true }),
    ).rejects.toThrow("custom retryable");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("keeps invalid attempt counts bounded", async () => {
    const operation = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      withTransientIoRetry(operation, { ...fastOptions, attempts: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("fetch failed");
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

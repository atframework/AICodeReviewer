import { computeBackoffDelay } from "./queue.js";

const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTCONN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_MESSAGE_RES: readonly RegExp[] = [
  /\bfetch failed\b/iu,
  /\bsocket hang up\b/iu,
  /\btimed out\b/iu,
  /^\s*terminated\s*$/iu,
  /\bECONNRESET\b|\bECONNREFUSED\b|\bECONNABORTED\b|\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b/u,
  /\bENOTFOUND\b|\bEAI_AGAIN\b/u,
  /\bEHOSTUNREACH\b|\bENETUNREACH\b|\bENETRESET\b/u,
  /could not resolve host/iu,
  /failed to connect/iu,
  /unable to (?:access|connect)/iu,
  /connect to server failed/iu,
  /connection (?:timed out|refused|reset|closed)/iu,
  /the remote end hung up/iu,
  /temporary failure in name resolution/iu,
  /network is unreachable/iu,
  /no route to host/iu,
  /early eof/iu,
  /rpc failed/iu,
];

const MAX_CAUSE_DEPTH = 5;

// 429 is deliberately excluded: rate-limited responses must honor the
// server's Retry-After directive, which this layer cannot see. The LLM
// gateway handles 429 with dedicated Retry-After support.
export function isTransientIoHttpStatus(status: number): boolean {
  return status === 408 || (status >= 500 && status <= 599);
}

export function isTransientIoError(error: unknown): boolean {
  const candidates: Array<{
    readonly code?: unknown;
    readonly name?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
    readonly cause?: unknown;
    readonly retryable?: unknown;
  }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== "object" && typeof current !== "function") {
      break;
    }

    const candidate = current as {
      readonly code?: unknown;
      readonly name?: unknown;
      readonly status?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
      readonly retryable?: unknown;
    };
    candidates.push(candidate);
    current = candidate.cause;
  }

  // An outer workflow can mark an operation as unsafe to replay after a
  // non-idempotent side effect. Check the whole cause chain before matching a
  // wrapper message such as "fetch failed".
  if (candidates.some((candidate) => candidate.retryable === false)) {
    return false;
  }

  for (const candidate of candidates) {
    if (typeof candidate.code === "string" && TRANSIENT_ERROR_CODES.has(candidate.code)) {
      return true;
    }
    if (candidate.name === "TimeoutError") {
      return true;
    }
    if (typeof candidate.status === "number" && isTransientIoHttpStatus(candidate.status)) {
      return true;
    }
    if (typeof candidate.message === "string" && candidate.message.length > 0) {
      const message = candidate.message;
      if (TRANSIENT_MESSAGE_RES.some((pattern) => pattern.test(message))) {
        return true;
      }
    }
  }

  return false;
}

export interface TransientIoRetryOptions {
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly jitter?: boolean;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
}

export function computeTransientIoRetryDelay(
  failedAttempt: number,
  options?: { readonly baseMs?: number; readonly maxMs?: number; readonly jitter?: boolean },
): number {
  const baseMs = options?.baseMs ?? 500;
  const maxMs = options?.maxMs ?? 5000;
  const jitter = options?.jitter ?? true;

  return Math.round(
    computeBackoffDelay(Math.max(0, failedAttempt - 1), { kind: "exponential", baseMs, maxMs, jitter }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export async function withTransientIoRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: TransientIoRetryOptions,
): Promise<T> {
  const configuredAttempts = Math.floor(options?.attempts ?? 3);
  const attempts = Number.isFinite(configuredAttempts) ? Math.max(1, configuredAttempts) : 3;
  const isRetryable = options?.isRetryable ?? isTransientIoError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) {
        throw error;
      }
      const delayMs = computeTransientIoRetryDelay(attempt, {
        ...(options?.baseMs !== undefined ? { baseMs: options.baseMs } : {}),
        ...(options?.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
        ...(options?.jitter !== undefined ? { jitter: options.jitter } : {}),
      });
      options?.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  throw new Error("withTransientIoRetry: unreachable state");
}

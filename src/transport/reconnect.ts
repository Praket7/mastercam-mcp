export { CircuitBreaker, CircuitState, CircuitBreakerOpenError } from "./circuit-breaker.js";
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Total retry budget. Each attempt receives only the remaining time. */
  deadlineMs?: number;
  /** Only ever set true for proven idempotent reads (status, listings, inspection). */
  idempotent: boolean;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Executes `fn` with bounded, deadline-aware retries. Non-idempotent operations
 * get exactly one attempt: after a lost response there is no way to know whether
 * a write landed, so blind retry could double-apply it.
 */
export async function withRetry<T>(
  options: RetryOptions,
  fn: (attempt: number, remainingMs: number) => Promise<T>
): Promise<T> {
  const maxAttempts = options.idempotent ? Math.max(1, options.maxAttempts ?? 3) : 1;
  const startedAt = Date.now();
  const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingBeforeAttempt = Math.max(0, deadlineMs - (Date.now() - startedAt));
    if (remainingBeforeAttempt <= 0) {
      throw lastError ?? new Error("TIMEOUT: retry budget exhausted before next attempt");
    }

    try {
      return await fn(attempt, remainingBeforeAttempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableError(error)) break;

      const base = options.baseDelayMs ?? 100;
      const max = options.maxDelayMs ?? 2000;
      const jittered = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (remaining <= jittered) break;
      await sleep(jittered);
    }
  }
  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const retryableCodes = ["TIMEOUT", "BACKEND_UNAVAILABLE", "RATE_LIMITED"];
  const semanticCodes = ["OPERATION_NOT_FOUND", "TARGET_REQUIRED", "STALE_PREVIEW", "STALE_STATE", "VALIDATION_FAILED", "UNSUPPORTED_CAPABILITY", "UNSUPPORTED_TOOL", "APPROVAL_TOKEN", "IDEMPOTENCY_CONFLICT", "PROFILE_DENIED", "CANCELLED", "REQUEST_TOO_LARGE", "RESPONSE_TOO_LARGE"];
  for (const code of semanticCodes) if (message.includes(code)) return false;
  for (const code of retryableCodes) if (message.includes(code)) return true;
  if (error instanceof Error && (error as Error & { retryable?: boolean }).retryable === true) return true;
  return false;
}

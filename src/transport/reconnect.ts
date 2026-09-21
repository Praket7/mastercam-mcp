export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Only ever set true for proven idempotent reads (status, listings, inspection). */
  idempotent: boolean;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Executes `fn` with bounded retries. Non-idempotent operations get exactly one
 * attempt: after a lost response there is no way to know whether a write landed,
 * so blind retry could double-apply it (audit REL-03/74.5).
 * Only transport-retryable errors are retried; semantic errors (OPERATION_NOT_FOUND, etc.) are not.
 */
export async function withRetry<T>(options: RetryOptions, fn: (attempt: number) => Promise<T>): Promise<T> {
  const maxAttempts = options.idempotent ? Math.max(1, options.maxAttempts ?? 3) : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      if (!isRetryableError(error)) break;
      const base = options.baseDelayMs ?? 100;
      const max = options.maxDelayMs ?? 2000;
      const jittered = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      await sleep(jittered);
    }
  }
  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const retryableCodes = ["TIMEOUT", "BACKEND_UNAVAILABLE", "CANCELLED", "RESPONSE_TOO_LARGE", "REQUEST_TOO_LARGE"];
  // Transport errors are retryable; semantic errors are not
  const semanticCodes = ["OPERATION_NOT_FOUND", "TARGET_REQUIRED", "STALE_PREVIEW", "STALE_STATE", "VALIDATION_FAILED", "UNSUPPORTED_CAPABILITY", "UNSUPPORTED_TOOL", "APPROVAL_TOKEN", "IDEMPOTENCY_CONFLICT", "PROFILE_DENIED"];
  for (const code of semanticCodes) if (message.includes(code)) return false;
  for (const code of retryableCodes) if (message.includes(code)) return true;
  // Default: check if error has retryable flag
  if (error instanceof Error && (error as unknown as { retryable?: boolean }).retryable === true) return true;
  // Unknown errors are not retryable for idempotent reads (fail safe)
  return false;
}

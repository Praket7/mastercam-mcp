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
      const base = options.baseDelayMs ?? 100;
      const max = options.maxDelayMs ?? 2000;
      const jittered = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      await sleep(jittered);
    }
  }
  throw lastError;
}

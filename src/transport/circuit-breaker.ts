export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  halfOpenSuccesses?: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`BACKEND_UNAVAILABLE: circuit breaker open, retry in ~${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitBreakerOpenError";
  }
}

export const CircuitState = { CLOSED: "CLOSED" as const, OPEN: "OPEN" as const, HALF_OPEN: "HALF_OPEN" as const };
export type CircuitState = typeof CircuitState[keyof typeof CircuitState];

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly requiredHalfOpenSuccesses: number;

  constructor(options: CircuitBreakerOptions & { timeout?: number; failureThreshold?: number } = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = (options as any).timeout ?? options.cooldownMs ?? 5000;
    this.requiredHalfOpenSuccesses = options.halfOpenSuccesses ?? 2;
  }

  get currentState(): BreakerState { return this.state; }
  getState(): BreakerState { return this.state; }

  /** Wraps an attempt; throws CircuitBreakerOpenError while open. */
  async execute<T>(attempt: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      const remaining = this.cooldownMs - (Date.now() - this.openedAt);
      if (remaining > 0) throw new CircuitBreakerOpenError(remaining);
      this.state = "HALF_OPEN";
      this.halfOpenSuccesses = 0;
    }
    try {
      const result = await attempt();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.isDomainError(error)) {
        throw error;
      }
      this.onFailure();
      throw error;
    }
  }

  private isDomainError(error: any): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message;
    if (
      msg.includes("OPERATION_NOT_FOUND") ||
      msg.includes("INVALID_ARGUMENTS") ||
      msg.includes("UNSUPPORTED_CAPABILITY") ||
      msg.includes("PERMISSION_DENIED") ||
      msg.includes("VALIDATION_FAILED") ||
      msg.includes("CANCELLED") ||
      msg.includes("REQUEST_TOO_LARGE") ||
      msg.includes("RESPONSE_TOO_LARGE") ||
      msg.includes("STALE_PREVIEW") ||
      msg.includes("STALE_STATE") ||
      msg.includes("APPROVAL_TOKEN") ||
      msg.includes("IDEMPOTENCY") ||
      msg.includes("UNSUPPORTED_TOOL") ||
      msg.includes("TARGET_REQUIRED") ||
      msg.includes("PROFILE_DENIED")
    ) {
      return true;
    }
    return false;
  }

  private isTransportError(error: any): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message;
    return (
      msg.includes("ECONNRESET") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("broken pipe") ||
      msg.includes("connection timeout") ||
      msg.includes("socket hang up") ||
      msg.includes("network error") ||
      msg.includes("read ECONNRESET") ||
      msg.includes("write ECONNRESET")
    );
  }


  private onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.requiredHalfOpenSuccesses) {
        this.state = "CLOSED";
        this.failures = 0;
      }
      return;
    }
    this.state = "CLOSED";
    this.failures = 0;
  }

  private onFailure(): void {
    if (this.state === "HALF_OPEN") {
      this.trip();
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = "OPEN";
    this.openedAt = Date.now();
    this.failures = this.failureThreshold;
  }
}

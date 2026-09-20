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

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly requiredHalfOpenSuccesses: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 5000;
    this.requiredHalfOpenSuccesses = options.halfOpenSuccesses ?? 2;
  }

  get currentState(): BreakerState { return this.state; }

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
      this.onFailure();
      throw error;
    }
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

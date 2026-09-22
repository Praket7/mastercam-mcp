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

export const CircuitState = {
  CLOSED: "CLOSED" as const,
  OPEN: "OPEN" as const,
  HALF_OPEN: "HALF_OPEN" as const
};
export type CircuitState = typeof CircuitState[keyof typeof CircuitState];

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failures = 0;
  private halfOpenSuccesses = 0;
  private halfOpenProbeInFlight = false;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly requiredHalfOpenSuccesses: number;

  constructor(options: CircuitBreakerOptions & { timeout?: number } = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.timeout ?? options.cooldownMs ?? 5000;
    this.requiredHalfOpenSuccesses = options.halfOpenSuccesses ?? 2;
  }

  get currentState(): BreakerState { return this.state; }
  getState(): BreakerState { return this.state; }

  async execute<T>(attempt: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      const remaining = this.cooldownMs - (Date.now() - this.openedAt);
      if (remaining > 0) throw new CircuitBreakerOpenError(remaining);
      this.state = "HALF_OPEN";
      this.halfOpenSuccesses = 0;
    }

    const halfOpenProbe = this.state === "HALF_OPEN";
    if (halfOpenProbe) {
      if (this.halfOpenProbeInFlight) {
        throw new CircuitBreakerOpenError(Math.max(1, Math.min(this.cooldownMs, 250)));
      }
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await attempt();
      this.onSuccess();
      return result;
    } catch (error) {
      if (!this.isTransportError(error)) throw error;
      this.onFailure();
      throw error;
    } finally {
      if (halfOpenProbe) this.halfOpenProbeInFlight = false;
    }
  }

  private isTransportError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "BACKEND_UNAVAILABLE",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "broken pipe",
      "connection timed out",
      "connection timeout",
      "socket hang up",
      "socket error",
      "network error",
      "invalid bridge response",
      "RESPONSE_TOO_LARGE"
    ].some(token => message.includes(token));
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
    this.halfOpenSuccesses = 0;
  }
}

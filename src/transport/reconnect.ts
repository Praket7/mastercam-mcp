export interface CircuitBreakerOptions {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  // Only count transport/network errors as failures, not semantic/domain errors
  isRetryableError?: (error: Error) => boolean;
}

export enum CircuitState { CLOSED, OPEN, HALF_OPEN }

export class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      successThreshold: options.successThreshold ?? 2,
      timeout: options.timeout ?? 30000,
      isRetryableError: options.isRetryableError ?? this.defaultIsRetryableError
    };
  }

  private defaultIsRetryableError(error: Error): boolean {
    // Transport/network errors are retryable
    const transportErrors = [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "EPIPE",
      "socket hang up",
      "Connection timeout",
      "Connection refused",
      "Connection reset",
      "network"
    ];
    const message = error.message.toLowerCase();
    return transportErrors.some(e => message.includes(e.toLowerCase()));
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.options.timeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successes = 0;
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error as Error);
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.successes = 0;
      }
    }
  }

  private onFailure(error: Error) {
    // Only count retryable (transport) errors towards circuit breaker
    if (this.options.isRetryableError(error)) {
      this.failures++;
      this.lastFailureTime = Date.now();
      this.successes = 0;
      if (this.state === CircuitState.HALF_OPEN || this.failures >= this.options.failureThreshold) {
        this.state = CircuitState.OPEN;
      }
    }
    // Non-retryable (semantic) errors don't affect the circuit breaker
  }

  getState(): CircuitState { return this.state; }
  reset() { this.state = CircuitState.CLOSED; this.failures = 0; this.successes = 0; }
}
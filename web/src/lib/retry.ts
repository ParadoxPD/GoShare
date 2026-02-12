// ===================================
// RETRY + CIRCUIT BREAKER UTILITIES
// ===================================

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 300,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterMs: 100,
};

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const config: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < config.maxAttempts;
      const retryAllowed = config.shouldRetry
        ? config.shouldRetry(error, attempt)
        : true;

      if (!canRetry || !retryAllowed) {
        break;
      }

      const exponential = config.initialDelayMs * config.backoffMultiplier ** (attempt - 1);
      const jitter = config.jitterMs ? Math.random() * config.jitterMs : 0;
      const waitMs = Math.min(exponential + jitter, config.maxDelayMs);
      await delay(waitMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry failed");
}

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = "closed";
  private maxFailures: number;
  private resetTimeoutMs: number;

  constructor(maxFailures = 5, resetTimeoutMs = 60_000) {
    this.maxFailures = maxFailures;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const canProbe = Date.now() - this.openedAt >= this.resetTimeoutMs;
      if (!canProbe) {
        throw new Error("Circuit breaker is open");
      }
      this.state = "half_open";
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.state = "closed";
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.maxFailures) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

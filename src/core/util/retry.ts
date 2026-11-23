/**
 * Retry utility with exponential backoff
 * Handles transient failures in API calls
 *
 * Lifted from packages/shared/src/utils/retry.ts at 7d1d56f8, without
 * retryPrismaOperation.
 */

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_RETRYABLE_ERRORS = [
  // Database errors
  "Timed out fetching a new connection",
  "Connection pool timeout",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "connection pool",
  "prisma",
  // API/Network errors
  "ECONNRESET",
  "socket hang up",
  "network error",
  "Rate limit exceeded",
  "429",
  "503",
  "502",
  "500", // Sometimes transient
];

/**
 * Check if an error is retryable
 */
function isRetryableError(error: Error, retryableErrors: string[]): boolean {
  const errorMessage = error.message.toLowerCase();
  const errorString = error.toString().toLowerCase();

  return retryableErrors.some(
    (pattern) =>
      errorMessage.includes(pattern.toLowerCase()) || errorString.includes(pattern.toLowerCase())
  );
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number
): number {
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter (±25% randomness) to prevent thundering herd
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);

  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns Result of the function
 * @throws Last error if all retries fail
 *
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   async () => await prisma.draft.create({ data: { ... } }),
 *   {
 *     maxAttempts: 3,
 *     onRetry: (error, attempt) => {
 *       console.log(`Retry attempt ${attempt}: ${error.message}`);
 *     },
 *   }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryableErrors = DEFAULT_RETRYABLE_ERRORS,
    onRetry,
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is the last attempt
      if (attempt === maxAttempts) {
        throw lastError;
      }

      // Check if error is retryable
      if (!isRetryableError(lastError, retryableErrors)) {
        throw lastError;
      }

      // Calculate delay and notify
      const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);

      if (onRetry) {
        onRetry(lastError, attempt);
      }

      // Wait before next attempt
      await sleep(delay);
    }
  }

  // TypeScript doesn't know lastError is always set here
  throw lastError!;
}

/**
 * Retry specifically for LLM API calls
 * Pre-configured with API-specific error patterns
 */
export async function retryLLMCall<T>(
  fn: () => Promise<T>,
  options: Omit<RetryOptions, "retryableErrors"> = {}
): Promise<T> {
  return retryWithBackoff(fn, {
    maxAttempts: 5, // More attempts for API calls
    initialDelayMs: 2000, // Longer initial delay
    ...options,
    retryableErrors: [
      "Rate limit exceeded",
      "429",
      "503",
      "502",
      "500",
      "529", // Anthropic: overloaded
      "ECONNRESET",
      "socket hang up",
      "network error",
      "timeout",
      "ETIMEDOUT",
    ],
  });
}

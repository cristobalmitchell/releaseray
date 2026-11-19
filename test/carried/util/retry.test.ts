/**
 * Unit tests for Retry Utilities
 *
 * Tests exponential backoff retry logic.
 *
 * Carried from packages/shared/src/utils/retry.test.ts at 7d1d56f8. The
 * retryPrismaOperation cases retired with the function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retryWithBackoff, retryLLMCall } from "../../../src/core/util/retry";

describe("Retry Utilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("retryWithBackoff", () => {
    it("should return result on first success", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await retryWithBackoff(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on retryable error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Connection pool timeout"))
        .mockResolvedValue("success");

      const promise = retryWithBackoff(fn, {
        initialDelayMs: 100,
        maxAttempts: 3,
      });

      // Fast-forward through the delay
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);

      const result = await promise;

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should not retry on non-retryable error", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("User not found"));

      await expect(retryWithBackoff(fn)).rejects.toThrow("User not found");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should throw after max attempts", async () => {
      const error = new Error("ECONNREFUSED");
      const fn = vi.fn(() => Promise.reject(error));

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 100,
      }).catch((e) => e); // Catch to prevent unhandled rejection

      // Advance through all retries
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("ECONNREFUSED");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should call onRetry callback", async () => {
      const onRetry = vi.fn();
      const fn = vi.fn().mockRejectedValueOnce(new Error("ETIMEDOUT")).mockResolvedValue("success");

      const promise = retryWithBackoff(fn, {
        initialDelayMs: 100,
        onRetry,
      });

      await vi.advanceTimersByTimeAsync(200);

      await promise;

      expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
    });

    it("should use custom retryable errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Custom error"))
        .mockResolvedValue("success");

      const promise = retryWithBackoff(fn, {
        initialDelayMs: 100,
        retryableErrors: ["Custom error"],
      });

      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should handle non-Error exceptions", async () => {
      const fn = vi.fn().mockRejectedValue("string error");

      await expect(retryWithBackoff(fn)).rejects.toThrow("string error");
    });

    it("should retry on 429 rate limit", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockResolvedValue("success");

      const promise = retryWithBackoff(fn, { initialDelayMs: 100 });

      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;

      expect(result).toBe("success");
    });

    it("should retry on 503 service unavailable", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("503 Service Unavailable"))
        .mockResolvedValue("success");

      const promise = retryWithBackoff(fn, { initialDelayMs: 100 });

      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;

      expect(result).toBe("success");
    });
  });

  describe("retryLLMCall", () => {
    it("should use higher max attempts for LLM calls", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Rate limit exceeded"))
        .mockRejectedValueOnce(new Error("Rate limit exceeded"))
        .mockRejectedValueOnce(new Error("Rate limit exceeded"))
        .mockResolvedValue("AI response");

      const promise = retryLLMCall(fn, { initialDelayMs: 100 });

      // Advance through all retries
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }

      const result = await promise;

      expect(result).toBe("AI response");
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it("should retry on timeout errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Request timeout"))
        .mockResolvedValue("success");

      const promise = retryLLMCall(fn, { initialDelayMs: 100 });

      await vi.advanceTimersByTimeAsync(500);

      const result = await promise;

      expect(result).toBe("success");
    });

    it("should retry on socket hang up", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValue("success");

      const promise = retryLLMCall(fn, { initialDelayMs: 100 });

      await vi.advanceTimersByTimeAsync(500);

      const result = await promise;

      expect(result).toBe("success");
    });
  });
});

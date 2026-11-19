/**
 * Throttling, retry and usage counting for every GitHub REST request
 * (CONVERSION-PLAN §5.8, item 2). It wraps the request function of the one
 * Octokit the run uses, so reads, writes and retries all pass through here.
 *
 * Written here rather than taken from @octokit/plugin-throttling: that
 * plugin sleeps until the primary-limit reset whenever told to retry, which
 * can outlast the job's timeout and cancel it before it exits or writes a
 * summary. Here the wait happens only within `maxWaitMinutes`.
 */
import { EXIT_CODES, ReleaseRayError } from "../errors";

/** Request options as Octokit passes them to its request hook. */
export interface RequestOptions {
  method?: string;
  url?: string;
  [key: string]: unknown;
}

/** The parts of a response this module reads. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string | number | undefined>;
  data: unknown;
}

/** A request function, such as Octokit's `request`. */
export type RequestFn = (options: RequestOptions) => Promise<HttpResponse>;

/** An HTTP error with a status, shaped like Octokit's `RequestError`. */
export interface HttpErrorLike {
  status: number;
  message?: string;
  response?: { headers?: Record<string, string | number | undefined> };
}

/**
 * Whether a value is an HTTP error with a status code.
 *
 * @param error - Anything thrown
 * @returns True when it carries a numeric `status`
 */
export function isHttpError(error: unknown): error is HttpErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number"
  );
}

/** The latest rate-limit figures seen in response headers. */
export interface RateLimitHeaders {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  reset: number;
}

/** Requests made so far, for the summary and `notes.json`. */
export interface UsageSnapshot {
  /** Requests counted against the primary limit (everything but GET /rate_limit). */
  total: number;
  /** Count per `METHOD /route` template. */
  byRoute: Record<string, number>;
  retries: number;
  /** Rate-limit headers from the first and latest counted responses. */
  first?: RateLimitHeaders;
  latest?: RateLimitHeaders;
  /** Milliseconds per request, in order. */
  latencyMs: number[];
}

/** Settings for {@link createRequestPolicy}. */
export interface PolicyOptions {
  /** Parallel reads (`github.concurrency`). Writes are always serial. */
  concurrency: number;
  /** Longest wait for a primary-limit reset (`github.maxWaitMinutes`). */
  maxWaitMinutes: number;
  sleep: (ms: number) => Promise<void>;
  /** Current time in milliseconds. */
  now: () => number;
  /** Minimum gap between writes. */
  writeSpacingMs?: number;
}

/** Most retries for secondary limits and server errors. */
const MAX_RETRIES = 2;
/** Minimum wait after a secondary-limit response without `retry-after`. */
const SECONDARY_MIN_WAIT_MS = 60_000;
/** Base wait after a 5xx. */
const SERVER_ERROR_WAIT_MS = 2_000;

function header(
  headers: Record<string, string | number | undefined> | undefined,
  name: string
): string | undefined {
  const value = headers?.[name];
  return value === undefined ? undefined : String(value);
}

function readRateLimit(
  headers: Record<string, string | number | undefined> | undefined
): RateLimitHeaders | undefined {
  const limit = header(headers, "x-ratelimit-limit");
  const remaining = header(headers, "x-ratelimit-remaining");
  const reset = header(headers, "x-ratelimit-reset");
  if (limit === undefined || remaining === undefined || reset === undefined) return undefined;
  return { limit: Number(limit), remaining: Number(remaining), reset: Number(reset) };
}

function routeOf(options: RequestOptions): string {
  return `${(options.method ?? "GET").toUpperCase()} ${options.url ?? ""}`;
}

/** A counting semaphore. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((release) => waiting.push(release));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** The wrapper and its counters. */
export interface RequestPolicy {
  /**
   * Sends one request through throttling and retry.
   *
   * @throws ReleaseRayError (exit 4) when the primary limit is exhausted past `maxWaitMinutes`
   * @throws The last HTTP error once retries are spent
   */
  send(request: RequestFn, options: RequestOptions): Promise<HttpResponse>;
  usage(): UsageSnapshot;
}

/**
 * Creates the request policy for one run.
 *
 * @param options - Concurrency, wait limit and clock
 * @returns The policy
 */
export function createRequestPolicy(options: PolicyOptions): RequestPolicy {
  const reads = createLimiter(Math.max(1, options.concurrency));
  const writes = createLimiter(1);
  const spacing = options.writeSpacingMs ?? 1000;
  let lastWrite = Number.NEGATIVE_INFINITY;
  const usage: UsageSnapshot = { total: 0, byRoute: {}, retries: 0, latencyMs: [] };

  function record(route: string, headers: HttpResponse["headers"] | undefined, ms: number): void {
    if (route === "GET /rate_limit") return;
    usage.total++;
    usage.byRoute[route] = (usage.byRoute[route] ?? 0) + 1;
    usage.latencyMs.push(ms);
    const limits = readRateLimit(headers);
    if (limits) {
      usage.first ??= limits;
      usage.latest = limits;
    }
  }

  /** Milliseconds to wait before retrying, or null when the error is final. */
  function retryDelay(error: unknown, attempt: number): number | null {
    if (!isHttpError(error)) return null;
    const headers = error.response?.headers;
    if (error.status === 403 || error.status === 429) {
      const limits = readRateLimit(headers);
      if (limits && limits.remaining === 0) {
        const waitMs = limits.reset * 1000 - options.now();
        if (attempt === 0 && waitMs <= options.maxWaitMinutes * 60_000) {
          return Math.max(0, waitMs) + 1000;
        }
        throw new ReleaseRayError(
          `GitHub's primary rate limit is exhausted until ${new Date(limits.reset * 1000).toISOString()}`,
          EXIT_CODES.incomplete,
          [
            `Re-run after the reset, raise github.maxWaitMinutes (now ${options.maxWaitMinutes}), or pass a PAT or GitHub App token`,
          ],
          { cause: error }
        );
      }
      if (attempt >= MAX_RETRIES) return null;
      const retryAfter = header(headers, "retry-after");
      if (retryAfter !== undefined && Number.isFinite(Number(retryAfter))) {
        return Number(retryAfter) * 1000;
      }
      const secondary = error.status === 429 || /secondary rate limit/i.test(error.message ?? "");
      return secondary ? SECONDARY_MIN_WAIT_MS * 2 ** attempt : null;
    }
    if (error.status >= 500 && attempt < MAX_RETRIES) return SERVER_ERROR_WAIT_MS * 2 ** attempt;
    return null;
  }

  async function attempt(request: RequestFn, req: RequestOptions): Promise<HttpResponse> {
    const route = routeOf(req);
    for (let n = 0; ; n++) {
      const started = options.now();
      try {
        const response = await request(req);
        record(route, response.headers, options.now() - started);
        return response;
      } catch (error) {
        record(
          route,
          isHttpError(error) ? error.response?.headers : undefined,
          options.now() - started
        );
        const delay = retryDelay(error, n);
        if (delay === null) throw error;
        usage.retries++;
        await options.sleep(delay);
      }
    }
  }

  return {
    send(request, req) {
      const method = (req.method ?? "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") return reads(() => attempt(request, req));
      return writes(async () => {
        const gap = lastWrite + spacing - options.now();
        if (gap > 0) await options.sleep(gap);
        try {
          return await attempt(request, req);
        } finally {
          lastWrite = options.now();
        }
      });
    },
    usage: () => ({
      ...usage,
      byRoute: { ...usage.byRoute },
      latencyMs: [...usage.latencyMs],
    }),
  };
}

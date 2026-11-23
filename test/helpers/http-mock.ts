/**
 * A small stand-in for the parts of Mock Service Worker (MSW) the carried
 * notification suites use: `http.get`/`post`/`put`, `HttpResponse`, and
 * `setupServer` with `listen`, `use`, `resetHandlers`, `close` and
 * `events.on("request:start")`.
 *
 * The hosted suites ran on MSW; this repository does not take MSW and its
 * dependency tree for three suites, so the carried tests change only the
 * import path. It replaces `globalThis.fetch` between `listen` and `close`.
 * Semantics kept from MSW 2: later `use` handlers win, `*` matches any
 * characters, `:name` matches one path segment, a resolver that throws gives
 * a 500 response, and `onUnhandledRequest: "error"` fails the request.
 *
 * @see https://mswjs.io/docs/api/setup-server
 */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a resolver receives. */
export interface ResolverInfo {
  request: Request;
  params: Record<string, string>;
}

/** Returns the mocked response. */
export type Resolver = (info: ResolverInfo) => Response | Promise<Response>;

/** One method and URL pattern with its resolver. */
export interface RequestHandler {
  method: Method;
  pattern: string;
  matcher: RegExp;
  resolver: Resolver;
}

function compile(pattern: string): RegExp {
  let source = "";
  for (const part of pattern.split(/(\*|:[A-Za-z_][A-Za-z0-9_]*)/)) {
    if (part === "*") source += ".*";
    else if (part.startsWith(":") && part.length > 1) source += `(?<${part.slice(1)}>[^/]+)`;
    else source += part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}/?$`);
}

function handler(method: Method) {
  return (pattern: string, resolver: Resolver): RequestHandler => ({
    method,
    pattern,
    matcher: compile(pattern),
    resolver,
  });
}

/** Request handlers by method, as MSW's `http` namespace. */
export const http = {
  get: handler("GET"),
  post: handler("POST"),
  put: handler("PUT"),
  patch: handler("PATCH"),
  delete: handler("DELETE"),
};

/** A `Response` with MSW's static helpers. */
export class HttpResponse extends Response {
  /**
   * A text response.
   *
   * @param body - Response text
   * @param init - Status and headers
   * @returns The response
   */
  static text(body: string, init?: ResponseInit): HttpResponse {
    return new HttpResponse(body, {
      ...init,
      headers: { "Content-Type": "text/plain", ...init?.headers },
    });
  }

  /**
   * A JSON response.
   *
   * @param body - Value to serialize
   * @param init - Status and headers
   * @returns The response
   */
  static override json(body: unknown, init?: ResponseInit): HttpResponse {
    return new HttpResponse(JSON.stringify(body), {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  }
}

/** Listeners for each intercepted request, before it is resolved. */
type RequestListener = (event: { request: Request }) => void;

/** The server returned by {@link setupServer}. */
export interface MockServer {
  listen(options?: { onUnhandledRequest?: "error" | "bypass" | "warn" }): void;
  use(...handlers: RequestHandler[]): void;
  resetHandlers(...handlers: RequestHandler[]): void;
  close(): void;
  events: {
    on(type: "request:start", listener: RequestListener): void;
    removeAllListeners(): void;
  };
}

/**
 * Creates a mock server over `globalThis.fetch`.
 *
 * @param initial - Default handlers, kept across `resetHandlers()`
 * @returns The server; inactive until `listen`
 */
export function setupServer(...initial: RequestHandler[]): MockServer {
  let defaults = [...initial];
  let overrides: RequestHandler[] = [];
  const listeners: RequestListener[] = [];
  let original: typeof fetch | null = null;
  let unhandled: "error" | "bypass" | "warn" = "warn";

  const mocked = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    for (const listener of listeners) listener({ request: request.clone() });
    const url = new URL(request.url);
    const target = `${url.origin}${url.pathname}`;
    for (const h of [...overrides, ...defaults]) {
      if (h.method !== request.method) continue;
      const match = h.matcher.exec(target);
      if (!match) continue;
      try {
        return await h.resolver({ request, params: { ...match.groups } });
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        return HttpResponse.json(
          { name: e.name, message: e.message, stack: e.stack },
          { status: 500, statusText: "Unhandled Exception" }
        );
      }
    }
    if (unhandled === "error") {
      throw new TypeError(`[http-mock] unhandled request: ${request.method} ${target}`);
    }
    return (original ?? fetch)(request);
  };

  return {
    listen(options = {}) {
      unhandled = options.onUnhandledRequest ?? "warn";
      if (original) return;
      original = globalThis.fetch;
      globalThis.fetch = mocked as typeof fetch;
    },
    use(...handlers) {
      overrides = [...handlers, ...overrides];
    },
    resetHandlers(...handlers) {
      overrides = [];
      if (handlers.length > 0) defaults = handlers;
    },
    close() {
      if (original) globalThis.fetch = original;
      original = null;
      overrides = [];
      listeners.length = 0;
    },
    events: {
      on(_type, listener) {
        listeners.push(listener);
      },
      removeAllListeners() {
        listeners.length = 0;
      },
    },
  };
}

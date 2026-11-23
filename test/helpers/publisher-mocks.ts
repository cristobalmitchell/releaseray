/**
 * Mock Service Worker (MSW) handlers for publisher integration tests
 *
 * Mocks HTTP requests to Slack, Teams and Intercom APIs
 * to enable reliable integration testing without hitting real endpoints.
 *
 * Carried from packages/shared/src/test/mocks/publishers.ts at 7d1d56f8
 * (CONVERSION-PLAN §6.5, Phase 5). The Resend handlers and types were not
 * carried: email stays a recipe. The handlers run on ./http-mock, a
 * stand-in for the MSW API.
 *
 * @see https://mswjs.io/docs/
 */

import { http, HttpResponse, setupServer } from "./http-mock";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface IntercomArticleRequest {
  title: string;
  body: string;
  author_id?: number;
  state?: "draft" | "published";
  parent_id?: string;
  parent_type?: string;
  description?: string;
}

// Fixed timestamp for test determinism (avoids flaky tests)
const FIXED_TIMESTAMP = 1234567890000;

// ============================================================================
// SUCCESS HANDLERS
// ============================================================================

/**
 * Default success handlers for all publisher APIs
 */
export const publisherHandlers = [
  // ============================================================================
  // SLACK WEBHOOK MOCKS
  // ============================================================================

  /**
   * Slack incoming webhook - Success
   * @see https://api.slack.com/messaging/webhooks
   */
  http.post("https://hooks.slack.com/services/*", () => {
    return HttpResponse.text("ok");
  }),

  // ============================================================================
  // MICROSOFT TEAMS WEBHOOK MOCKS
  // ============================================================================

  /**
   * Teams incoming webhook - Success
   * @see https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
   */
  http.post("https://*.webhook.office.com/*", () => {
    return HttpResponse.text("1");
  }),

  // ============================================================================
  // INTERCOM API MOCKS
  // ============================================================================

  /**
   * Intercom List Articles - Success (empty by default)
   * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/ListArticles
   */
  http.get("https://api.intercom.io/articles", () => {
    return HttpResponse.json({
      type: "list",
      data: [],
      total_count: 0,
      pages: {
        type: "pages",
        page: 1,
        per_page: 50,
        total_pages: 1,
      },
    });
  }),

  /**
   * Intercom Create Article - Success
   * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/createArticle
   */
  http.post("https://api.intercom.io/articles", async ({ request }) => {
    const body = (await request.json()) as IntercomArticleRequest;

    return HttpResponse.json({
      type: "article",
      id: "123456",
      workspace_id: "workspace-1",
      title: body.title,
      description: body.description || "Latest release notes",
      body: body.body,
      author_id: body.author_id || "author-1",
      state: body.state || "published",
      created_at: FIXED_TIMESTAMP,
      updated_at: FIXED_TIMESTAMP,
      url: "https://help.company.com/en/articles/123456-release-v1-0-0",
      parent_id: body.parent_id || "collection-1",
      parent_type: body.parent_type || "collection",
    });
  }),

  /**
   * Intercom Update Article - Success
   * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/updateArticle
   */
  http.put("https://api.intercom.io/articles/:id", ({ params }) => {
    return HttpResponse.json({
      type: "article",
      id: params.id,
      workspace_id: "workspace-1",
      title: "Release v1.0.0 (Updated)",
      description: "Latest release notes (updated)",
      body: "<p>Updated release notes content</p>",
      author_id: "author-1",
      state: "published",
      created_at: FIXED_TIMESTAMP - 3600000,
      updated_at: FIXED_TIMESTAMP,
      url: `https://help.company.com/en/articles/${params.id}-release-v1-0-0`,
      parent_id: "collection-1",
      parent_type: "collection",
    });
  }),
];

// ============================================================================
// MSW SERVER INSTANCE
// ============================================================================

/**
 * Factory function to create a new MSW server instance for Node.js tests
 *
 * **Note:** Creates a fresh server instance to avoid test interference
 * when tests run in parallel or when multiple test files import this module.
 *
 * Usage in tests:
 * ```typescript
 * import { createPublisherServer } from '../../helpers/publisher-mocks';
 *
 * const publisherServer = createPublisherServer();
 * beforeAll(() => publisherServer.listen({ onUnhandledRequest: 'error' }));
 * afterEach(() => publisherServer.resetHandlers());
 * afterAll(() => publisherServer.close());
 * ```
 */
export function createPublisherServer() {
  return setupServer(...publisherHandlers);
}

/**
 * Default MSW server instance for convenience
 * @deprecated Use createPublisherServer() for better test isolation
 */
export const publisherServer = createPublisherServer();

// ============================================================================
// ERROR HANDLERS (for testing failure scenarios)
// ============================================================================

/**
 * Error scenario handlers for testing failure cases
 *
 * Use these in tests to simulate API failures:
 * ```typescript
 * import { publisherServer, errorHandlers } from '../../helpers/publisher-mocks';
 *
 * it('should handle 401 error', async () => {
 *   publisherServer.use(errorHandlers.slack404);
 *   // ... test code
 * });
 * ```
 */
export const errorHandlers = {
  // ============================================================================
  // SLACK ERROR HANDLERS
  // ============================================================================

  /**
   * Slack webhook - 404 Not Found (invalid URL)
   */
  slack404: http.post("https://hooks.slack.com/services/*", () => {
    return new HttpResponse("Webhook not found", { status: 404 });
  }),

  /**
   * Slack webhook - 500 Server Error
   */
  slack500: http.post("https://hooks.slack.com/services/*", () => {
    return new HttpResponse("Internal Server Error", { status: 500 });
  }),

  // ============================================================================
  // TEAMS ERROR HANDLERS
  // ============================================================================

  /**
   * Teams webhook - 404 Not Found (invalid URL)
   */
  teams404: http.post("https://*.webhook.office.com/*", () => {
    return new HttpResponse("Webhook not found", { status: 404 });
  }),

  /**
   * Teams webhook - 500 Server Error
   */
  teams500: http.post("https://*.webhook.office.com/*", () => {
    return new HttpResponse("Internal Server Error", { status: 500 });
  }),

  // ============================================================================
  // INTERCOM ERROR HANDLERS
  // ============================================================================

  /**
   * Intercom - 401 Unauthorized (invalid API token)
   */
  intercom401: http.post("https://api.intercom.io/articles", () => {
    return HttpResponse.json(
      {
        type: "error.list",
        errors: [
          {
            code: "unauthorized",
            message: "Access Token Invalid",
          },
        ],
      },
      { status: 401 }
    );
  }),

  /**
   * Intercom - 403 Forbidden (insufficient permissions)
   */
  intercom403: http.post("https://api.intercom.io/articles", () => {
    return HttpResponse.json(
      {
        type: "error.list",
        errors: [
          {
            code: "forbidden",
            message: "Insufficient permissions to create articles",
          },
        ],
      },
      { status: 403 }
    );
  }),

  /**
   * Intercom - 404 Not Found (collection not found)
   */
  intercom404: http.post("https://api.intercom.io/articles", () => {
    return HttpResponse.json(
      {
        type: "error.list",
        errors: [
          {
            code: "not_found",
            message: "Collection not found",
          },
        ],
      },
      { status: 404 }
    );
  }),

  /**
   * Intercom - 500 Server Error
   */
  intercom500: http.post("https://api.intercom.io/articles", () => {
    return HttpResponse.json(
      {
        type: "error.list",
        errors: [
          {
            code: "server_error",
            message: "Internal Server Error",
          },
        ],
      },
      { status: 500 }
    );
  }),
};

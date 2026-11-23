/**
 * Intercom Publisher
 * Creates or updates a Help Center article with the release notes
 *
 * Lifted from apps/app/src/lib/publishers/intercom.ts at 7d1d56f8
 * (CONVERSION-PLAN §7.4, PD-15). Changes: the core logger replaces the
 * `@/lib/logger` alias, and Markdown is converted by a local `Marked`
 * instance instead of the shared global one. The caller builds the title from
 * `titleTemplate` and the release key, and passes the access token, which the
 * Action entry layer reads from the variable named by `apiKeyEnv`; this module
 * reads no environment.
 *
 * Idempotency is by title (GITHUB-APP-SURFACE D-48): an article renamed by
 * hand is not found again, and the next run creates a new one.
 *
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/article/
 */
import { Marked } from "marked";
import { createLogger } from "../../core/logger";

const logger = createLogger("intercom-publisher");

/**
 * Intercom API version
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/
 */
const INTERCOM_API_VERSION = "2.14";

/**
 * Intercom API base URL
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/
 */
const INTERCOM_API_BASE = "https://api.intercom.io";

/** What to publish. */
export interface IntercomPublishOptions {
  apiKey: string;
  collectionId: string;
  title: string;
  body: string;
  version: string;
  repoFullName: string;
  state?: "draft" | "published";
  authorId?: number;
  description?: string;
}

/** The outcome of a publish. */
export interface IntercomPublishResult {
  success: boolean;
  url?: string;
  articleId?: string;
  error?: string;
}

/**
 * Article response from Intercom API
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/article/
 */
interface IntercomArticle {
  id: string;
  type: string;
  title: string;
  body: string;
  state: "draft" | "published";
  author_id?: number;
  parent_id?: string;
  parent_type?: string;
  url?: string;
}

/**
 * Article list response from Intercom API
 */
interface IntercomArticleList {
  type: "list";
  data: IntercomArticle[];
  total_count: number;
  pages: {
    type: string;
    page: number;
    per_page: number;
    total_pages: number;
  };
}

/**
 * Publish or update an article in Intercom Help Center
 *
 * This function is idempotent - it will update an existing article if found,
 * or create a new one if not found.
 *
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/article/
 * @param options - Article configuration
 * @returns Result with URL and article ID
 */
export async function publishToIntercom(
  options: IntercomPublishOptions
): Promise<IntercomPublishResult> {
  const {
    apiKey,
    collectionId,
    title,
    body,
    version,
    repoFullName,
    state = "draft",
    authorId,
    description,
  } = options;

  logger.info("Publishing to Intercom", { title, version, repoFullName });

  try {
    // Convert markdown to HTML (Intercom expects HTML)
    const htmlBody = await markdownToHtml(body);

    // Check if article with this title already exists (for idempotency)
    const existingArticle = await findArticleByTitle(title, apiKey);

    if (existingArticle) {
      // Update existing article
      const updatePayload: Partial<IntercomArticle> = {
        title,
        body: htmlBody,
        state,
      };

      const response = await fetch(`${INTERCOM_API_BASE}/articles/${existingArticle.id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Intercom-Version": INTERCOM_API_VERSION,
        },
        body: JSON.stringify(updatePayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Intercom API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as IntercomArticle;

      // Build article URL
      // Format: https://app.intercom.com/a/apps/YOUR_APP_ID/articles/articles/ARTICLE_ID
      const articleUrl = data.url || `https://intercom.help/articles/${data.id}`;

      logger.info("Updated Intercom article", {
        articleId: data.id,
        url: articleUrl,
      });

      return {
        success: true,
        url: articleUrl,
        articleId: data.id,
      };
    } else {
      // Create new article
      const payload: Partial<IntercomArticle> & {
        parent_id: string;
        parent_type: string;
        description?: string;
      } = {
        title,
        body: htmlBody,
        state,
        parent_id: collectionId,
        parent_type: "collection",
      };

      if (description) {
        payload.description = description;
      }

      if (authorId) {
        payload.author_id = authorId;
      }

      const response = await fetch(`${INTERCOM_API_BASE}/articles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Intercom-Version": INTERCOM_API_VERSION,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Intercom API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as IntercomArticle;

      // Build article URL
      const articleUrl = data.url || `https://intercom.help/articles/${data.id}`;

      logger.info("Created Intercom article", {
        articleId: data.id,
        url: articleUrl,
      });

      return {
        success: true,
        url: articleUrl,
        articleId: data.id,
      };
    }
  } catch (error) {
    logger.error("Intercom publish failed", {
      title,
      version,
      repoFullName,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Find article by title (for idempotency)
 *
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/ListArticles/
 * @param title - Article title to search for
 * @param apiKey - Intercom API key
 * @returns Article if found, null otherwise
 */
async function findArticleByTitle(title: string, apiKey: string): Promise<{ id: string } | null> {
  try {
    const response = await fetch(`${INTERCOM_API_BASE}/articles`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
    });

    if (!response.ok) {
      logger.warn("Failed to search articles", { status: response.status });
      return null;
    }

    const data = (await response.json()) as IntercomArticleList;
    const article = data.data?.find((a) => a.title === title);

    return article ? { id: article.id } : null;
  } catch (error) {
    logger.error("Failed to search articles", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

// Intercom-friendly options: \n becomes <br>, and GitHub Flavored Markdown
// (tables, strikethrough) is on.
const markdown = new Marked({ breaks: true, gfm: true });

/**
 * Convert markdown to HTML for Intercom using the marked library
 *
 * Intercom supports rich HTML including:
 * - Headers (h1-h6), paragraphs, lists
 * - Bold, italic, links
 * - Images with captions
 * - Code blocks with syntax highlighting
 * - Blockquotes
 * - Tables
 *
 * @see https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Articles/article/
 * @param text - Markdown content
 * @returns HTML content
 */
async function markdownToHtml(text: string): Promise<string> {
  try {
    const html = await markdown.parse(text);

    // Clean up and optimize HTML for Intercom
    const cleanHtml = html
      // Remove extra whitespace
      .replace(/\s+/g, " ")
      .trim()
      // Ensure proper paragraph spacing
      .replace(/<\/p>\s*<p>/g, "</p>\n<p>")
      // Add proper list spacing
      .replace(/<\/ul>\s*<p>/g, "</ul>\n\n<p>")
      .replace(/<\/ol>\s*<p>/g, "</ol>\n\n<p>");

    logger.info("Converted markdown to HTML", {
      markdownLength: text.length,
      htmlLength: cleanHtml.length,
    });

    return cleanHtml;
  } catch (error) {
    logger.error("Markdown to HTML conversion failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    // Fallback: return markdown wrapped in <p> tags
    return `<p>${text.replace(/\n\n/g, "</p><p>")}</p>`;
  }
}

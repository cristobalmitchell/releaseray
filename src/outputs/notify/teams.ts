/**
 * Microsoft Teams Publisher
 *
 * Sends release notes to Microsoft Teams via Incoming Webhooks
 *
 * Lifted from apps/app/src/server/publish/teams.ts at 7d1d56f8 (CONVERSION-PLAN
 * §7.4, PD-15). Changes: the core logger replaces the `@/lib/logger` alias,
 * the missing-URL message names `webhookUrlEnv` instead of the hosted settings
 * page, and the connection-test sender `testTeamsWebhook` was not lifted. The
 * webhook URL is passed in by the Action entry layer; this module reads no
 * environment.
 *
 * API Reference:
 * https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
 *
 * Message Card Format:
 * https://learn.microsoft.com/en-us/outlook/actionable-messages/message-card-reference
 */
import { createLogger } from "../../core/logger";

const logger = createLogger("teams-publisher");

/** What to post. */
export interface TeamsPublishOptions {
  title: string;
  body: string;
  version: string;
  repoName: string;
  compareUrl?: string;
  releaseUrl?: string;
  webhookUrl?: string;
}

/** The outcome of a post. */
export interface TeamsPublishResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Format release notes for Teams MessageCard format
 * Converts markdown to Teams-compatible formatting
 */
function formatBodyForTeams(markdown: string): string {
  // Teams supports basic markdown in text fields
  // Keep it as-is for most formatting, but handle special cases

  // Truncate if too long (Teams has ~28KB limit per card)
  const maxLength = 10000;
  if (markdown.length > maxLength) {
    return markdown.substring(0, maxLength) + "\n\n... (content truncated)";
  }

  return markdown;
}

/**
 * Create Teams MessageCard payload
 *
 * Uses the legacy MessageCard format which is widely supported
 * For Adaptive Cards, see: https://adaptivecards.io/designer/
 */
function createMessageCard(options: TeamsPublishOptions): object {
  const { title, body, version, repoName, compareUrl, releaseUrl } = options;

  // Format body with better readability
  const formattedBody = formatBodyForTeams(body);

  // Build sections
  const sections: Record<string, unknown>[] = [
    {
      activityTitle: `**${title}**`,
      activitySubtitle: `Version ${version} • ${repoName}`,
      text: formattedBody,
      markdown: true,
    },
  ];

  // Build potential actions
  const potentialAction: Record<string, unknown>[] = [];

  if (releaseUrl) {
    potentialAction.push({
      "@type": "OpenUri",
      name: "View Release",
      targets: [
        {
          os: "default",
          uri: releaseUrl,
        },
      ],
    });
  }

  if (compareUrl) {
    potentialAction.push({
      "@type": "OpenUri",
      name: "View Changes",
      targets: [
        {
          os: "default",
          uri: compareUrl,
        },
      ],
    });
  }

  // Create MessageCard
  const card = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    summary: `${repoName} ${version} Released`,
    themeColor: "0078D4", // Microsoft blue
    sections,
    potentialAction: potentialAction.length > 0 ? potentialAction : undefined,
  };

  return card;
}

/**
 * Publish release notes to Microsoft Teams channel via Incoming Webhook
 *
 * The URL must be https on a `*.webhook.office.com` or `*.office365.com` host.
 *
 * @param options - Release note configuration
 * @returns Result with success status and error if failed
 *
 * @example
 * ```typescript
 * const result = await publishToTeams({
 *   title: "Release v1.2.0",
 *   body: "## Features\n- Added dark mode\n- Fixed bugs",
 *   version: "v1.2.0",
 *   repoName: "owner/repo",
 *   releaseUrl: "https://github.com/owner/repo/releases/tag/v1.2.0",
 *   webhookUrl,
 * });
 * ```
 */
export async function publishToTeams(options: TeamsPublishOptions): Promise<TeamsPublishResult> {
  const { title, version, repoName, webhookUrl } = options;

  logger.info("Publishing to Microsoft Teams", { repoName, version });

  try {
    // Webhook URL must be provided by the caller (no global fallback)
    if (!webhookUrl) {
      throw new Error(
        "Teams webhook URL not provided. Set the environment variable named by webhookUrlEnv."
      );
    }

    // Validate webhook URL to prevent SSRF
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      throw new Error("Invalid Teams webhook URL format");
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      parsedUrl.protocol !== "https:" ||
      !(hostname.endsWith(".webhook.office.com") || hostname.endsWith(".office365.com"))
    ) {
      throw new Error(
        "Invalid Teams webhook URL: must be an https://*.webhook.office.com or https://*.office365.com URL"
      );
    }

    // Create MessageCard payload
    const card = createMessageCard(options);

    // Send to Teams
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(card),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Teams API error (${response.status}): ${errorText}`);
    }

    // Teams webhooks return "1" on success
    const responseText = await response.text();
    if (responseText !== "1") {
      throw new Error(`Unexpected Teams response: ${responseText}`);
    }

    logger.info("Published to Teams successfully", {
      repoName,
      version,
    });

    // Teams webhooks don't return a message URL, so we return a generic success
    return {
      success: true,
      url: "teams://", // Generic Teams protocol URL (can't get specific message link)
    };
  } catch (error) {
    logger.error("Teams publish failed", {
      title,
      version,
      repoName,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

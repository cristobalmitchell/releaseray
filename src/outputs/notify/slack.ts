/**
 * Slack Publisher
 * Sends release notes to Slack channels via webhook
 *
 * Lifted from apps/app/src/lib/publishers/slack.ts at 7d1d56f8 (CONVERSION-PLAN
 * §7.4, PD-15). Changes: the core logger replaces the `@/lib/logger` alias,
 * and the block types replace `any`. The host allowlist is unchanged. The
 * webhook URL is passed in by the Action entry layer, which reads it from the
 * variable named by `webhookUrlEnv`; this module reads no environment.
 *
 * @see https://api.slack.com/messaging/webhooks
 */
import { createLogger } from "../../core/logger";

const logger = createLogger("slack-publisher");

/** A button in an `actions` block. */
export interface SlackButton {
  type: string;
  text: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  url: string;
  action_id: string;
}

/** A Block Kit block. */
export interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  elements?: SlackButton[];
  accessory?: Record<string, unknown>;
}

/** The webhook payload: fallback text and blocks. */
export interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

/** Links shown as buttons under the message. */
export interface SlackUrls {
  github?: string;
  changelog?: string;
  /** A page that hosts the notes, if any. The Action itself hosts none. */
  hosted?: string;
}

/**
 * Format release notes for Slack
 * Creates rich message with blocks: the version header, the repository and
 * persona, and the first three non-blank lines of the text (at most 300
 * characters).
 *
 * @param params - Version, repository, persona text, persona slug and links
 * @returns The webhook payload
 */
export function formatForSlack(params: {
  version: string;
  repoFullName: string;
  content: string;
  persona: string;
  urls: SlackUrls;
}): SlackMessage {
  const { version, repoFullName, content, persona, urls } = params;

  // Extract first few lines for summary
  const lines = content.split("\n").filter((l) => l.trim());
  const summary = lines.slice(0, 3).join("\n");

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🎉 ${version} Released`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${repoFullName}*\nPersona: _${persona}_`,
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${summary.substring(0, 300)}${summary.length > 300 ? "..." : ""}`,
      },
    },
  ];

  // Add action buttons if URLs available
  const elements: SlackButton[] = [];

  if (urls.github) {
    elements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "View on GitHub",
        emoji: true,
      },
      url: urls.github,
      action_id: "github_release",
    });
  }

  if (urls.changelog) {
    elements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "View CHANGELOG",
        emoji: true,
      },
      url: urls.changelog,
      action_id: "changelog",
    });
  }

  if (urls.hosted) {
    elements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "View Release Notes",
        emoji: true,
      },
      url: urls.hosted,
      action_id: "hosted",
    });
  }

  if (elements.length > 0) {
    blocks.push({
      type: "actions",
      elements,
    });
  }

  return {
    text: `${version} released for ${repoFullName}`,
    blocks,
  };
}

/** The only hosts a Slack webhook URL may name. */
export const SLACK_WEBHOOK_HOSTS = ["hooks.slack.com", "hooks.slack-gov.com"] as const;

/**
 * Validate that a webhook URL points to a legitimate Slack endpoint.
 * Prevents SSRF by restricting to known Slack webhook hostnames.
 *
 * @see https://api.slack.com/messaging/webhooks
 * @param webhookUrl - The URL to check
 * @throws Error when the URL is malformed, not https, or not a Slack webhook host
 */
export function validateSlackWebhookUrl(webhookUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error("Invalid Slack webhook URL");
  }

  const allowedHosts: readonly string[] = SLACK_WEBHOOK_HOSTS;
  if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname)) {
    throw new Error(
      "Invalid Slack webhook URL: must start with https://hooks.slack.com/ or https://hooks.slack-gov.com/"
    );
  }
}

/**
 * Send message to Slack webhook
 *
 * @param webhookUrl - Incoming webhook URL; must pass the host allowlist
 * @param message - The payload
 * @returns Success, or the error message
 */
export async function sendToSlack(
  webhookUrl: string,
  message: SlackMessage
): Promise<{ success: boolean; error?: string }> {
  try {
    validateSlackWebhookUrl(webhookUrl);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Slack API error: ${response.status} ${text}`);
    }

    return { success: true };
  } catch (error) {
    logger.error("Failed to send Slack message", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Publish release notes to Slack
 *
 * @param params - Webhook URL plus the {@link formatForSlack} parameters
 * @returns Success, or the error message
 */
export async function publishToSlack(params: {
  webhookUrl: string;
  version: string;
  repoFullName: string;
  content: string;
  persona: string;
  urls: SlackUrls;
}): Promise<{ success: boolean; error?: string }> {
  const { webhookUrl, ...messageParams } = params;

  // Format message
  const message = formatForSlack(messageParams);

  // Send to Slack
  const result = await sendToSlack(webhookUrl, message);

  if (result.success) {
    logger.info("Published to Slack", { version: messageParams.version });
  }

  return result;
}

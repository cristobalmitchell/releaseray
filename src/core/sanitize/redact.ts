/**
 * Redaction of internal links and file paths.
 *
 * Lifted from packages/shared/src/utils/index.ts at 7d1d56f8 (the redaction
 * functions only).
 */

/**
 * Redact internal URLs and paths from text
 * @param text - Input text that may contain sensitive links
 * @param allowedDomains - List of public domains to preserve
 * @returns Redacted text
 */
export function redactInternalLinks(text: string, allowedDomains: string[] = []): string {
  const defaultAllowed = ["github.com", "gitlab.com"];
  const allowed = [...defaultAllowed, ...allowedDomains];

  // Regex to match URLs
  const urlRegex = /https?:\/\/[^\s)]+/g;

  return text.replace(urlRegex, (url) => {
    try {
      const urlObj = new URL(url);
      const isAllowed = allowed.some((domain) => urlObj.hostname.endsWith(domain));
      return isAllowed ? url : "[redacted]";
    } catch {
      // Invalid URL, redact it
      return "[redacted]";
    }
  });
}

/**
 * Redact file paths from text
 * @param text - Input text that may contain file paths
 * @returns Redacted text
 */
export function redactFilePaths(text: string): string {
  // Match common path patterns, but not URLs
  // First, temporarily replace URLs with placeholders to protect them
  const urls: string[] = [];
  const urlPlaceholder = "___URL_PLACEHOLDER___";

  // Extract URLs
  const textWithPlaceholders = text.replace(/https?:\/\/[^\s)]+/g, (url) => {
    urls.push(url);
    return `${urlPlaceholder}${urls.length - 1}${urlPlaceholder}`;
  });

  // Now redact file paths
  const pathRegex = /(?:\/[\w.-]+)+(?:\.[\w]+)?|\b[\w.-]+\/[\w.-]+(?:\/[\w.-]+)+/g;
  const redacted = textWithPlaceholders.replace(pathRegex, "[path]");

  // Restore URLs
  return redacted.replace(
    new RegExp(`${urlPlaceholder}(\\d+)${urlPlaceholder}`, "g"),
    (_match: string, index: string): string => {
      return urls[parseInt(index)] || "";
    }
  );
}

/**
 * Comprehensive redaction utility
 * @param text - Input text to redact
 * @param options - Configuration options
 * @returns Fully redacted text
 */
export function redactSensitiveInfo(
  text: string,
  options: {
    allowedDomains?: string[];
    redactPaths?: boolean;
  } = {}
): string {
  let redacted = text;

  // Redact internal URLs
  redacted = redactInternalLinks(redacted, options.allowedDomains);

  // Redact file paths if enabled
  if (options.redactPaths !== false) {
    redacted = redactFilePaths(redacted);
  }

  return redacted;
}

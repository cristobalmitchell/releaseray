/**
 * GitHub Releases API helpers
 *
 * Lifted from packages/shared/src/github-releases.ts at 7d1d56f8, with these
 * changes (CONVERSION-PLAN PD-10):
 * - `updateRelease` sends only the body: an update never changes `draft`,
 *   `name` or `prerelease`, so a user's draft stays a draft and keeps its title;
 * - `createRelease` sets `prerelease` from SemVer pre-release syntax and the
 *   name from `nameTemplate`;
 * - `isSemverPrerelease` replaces the substring check `isPreReleaseTag`, which
 *   flagged any tag containing "dev", "rc", "next" and similar strings;
 * - compare URLs take the server URL, for GitHub Enterprise Server.
 *
 * `fetchAllReleases`, `getReleaseById`, `releaseExistsForTag` and
 * `getPreviousTag` were not lifted.
 *
 * @see https://docs.github.com/en/rest/releases/releases
 */

import type { Octokit } from "@octokit/rest";
import { parseSemver } from "../../core/util/semver";

/**
 * GitHub Release object from the API
 * @see https://docs.github.com/en/rest/releases/releases#list-releases
 */
export interface GitHubRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  author: {
    login: string;
    id: number;
    avatar_url: string;
  };
  html_url: string;
  assets: Array<{
    id: number;
    name: string;
    size: number;
    download_count: number;
    browser_download_url: string;
  }>;
}

/** Name given to a release the Action creates, unless configured (Q3). */
export const DEFAULT_NAME_TEMPLATE = "Release {{tag}}";

/**
 * Get a release by tag name
 *
 * @param octokit - Authenticated Octokit instance
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param tag - Git tag name
 * @returns The GitHub release or null if not found
 * @throws The API error for anything but 404
 *
 * @see https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name
 */
export async function getReleaseByTag(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string
): Promise<GitHubRelease | null> {
  try {
    const response = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag,
    });
    return response.data as GitHubRelease;
  } catch (error: unknown) {
    if (error instanceof Error && "status" in error && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Replace the body of an existing release. Nothing else is sent, so the
 * release keeps its draft state, name and pre-release flag.
 *
 * @param octokit - Authenticated Octokit instance
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param releaseId - GitHub release ID
 * @param body - New release body in Markdown
 * @returns Updated release data
 *
 * @see https://docs.github.com/en/rest/releases/releases#update-a-release
 */
export async function updateRelease(
  octokit: Octokit,
  owner: string,
  repo: string,
  releaseId: number,
  body: string
): Promise<GitHubRelease> {
  const response = await octokit.rest.repos.updateRelease({
    owner,
    repo,
    release_id: releaseId,
    body,
  });
  return response.data as GitHubRelease;
}

/**
 * Fill `{{tag}}` in a release-name template.
 *
 * @param template - Template such as "Release {{tag}}"
 * @param tag - Git tag name
 * @returns The release name
 * @throws Error for any placeholder other than `{{tag}}`
 */
export function renderReleaseName(template: string, tag: string): string {
  return template.replace(/\{\{\s*([^{}\s]*)\s*\}\}/g, (_match, name: string) => {
    if (name !== "tag") throw new Error(`Unknown placeholder {{${name}}} in nameTemplate`);
    return tag;
  });
}

/**
 * Create a new GitHub release. The name comes from `nameTemplate` and the
 * pre-release flag from SemVer pre-release syntax in the tag.
 *
 * @param octokit - Authenticated Octokit instance
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param tagName - Git tag name
 * @param options - Release options
 * @returns Created release data
 *
 * @see https://docs.github.com/en/rest/releases/releases#create-a-release
 */
export async function createRelease(
  octokit: Octokit,
  owner: string,
  repo: string,
  tagName: string,
  options: {
    body: string;
    /** Release-name template; default "Release {{tag}}" */
    nameTemplate?: string;
    draft?: boolean;
    target_commitish?: string;
  }
): Promise<GitHubRelease> {
  const { body, nameTemplate = DEFAULT_NAME_TEMPLATE, draft = false, target_commitish } = options;
  const response = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tagName,
    name: renderReleaseName(nameTemplate, tagName),
    body,
    draft,
    prerelease: isSemverPrerelease(tagName),
    ...(target_commitish ? { target_commitish } : {}),
  });
  return response.data as GitHubRelease;
}

/**
 * Determine if a tag names a SemVer pre-release: a version with a
 * pre-release component after a hyphen, such as `v1.2.0-rc.1`. Text before
 * the version does not count, so `devtools-v1.2.0` is not a pre-release.
 *
 * @param tag - Git tag name
 * @returns True if the tag's version has a pre-release component
 */
export function isSemverPrerelease(tag: string): boolean {
  return (parseSemver(tag)?.prerelease.length ?? 0) > 0;
}

/**
 * Generate a compare URL for a release range
 *
 * @param serverUrl - Server URL, e.g. https://github.com or a GHES host
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param fromTag - Starting tag (older)
 * @param toTag - Ending tag (newer)
 * @returns Compare URL
 */
export function generateCompareUrl(
  serverUrl: string,
  owner: string,
  repo: string,
  fromTag: string,
  toTag: string
): string {
  return `${serverUrl.replace(/\/+$/, "")}/${owner}/${repo}/compare/${fromTag}...${toTag}`;
}

/**
 * Unit tests for GitHub Releases Helpers
 *
 * Tests helper functions for working with GitHub releases.
 * API functions are tested via mocked Octokit.
 *
 * Carried from packages/shared/src/github-releases.test.ts at 7d1d56f8.
 * Edited: pre-release detection is re-asserted against SemVer pre-release
 * syntax (PD-10), and compare URLs take a server URL. The getPreviousTag,
 * fetchAllReleases, getReleaseById and releaseExistsForTag cases retired.
 * @see https://docs.github.com/en/rest/releases/releases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isSemverPrerelease,
  generateCompareUrl,
  type GitHubRelease,
} from "../../../src/outputs/github-release/api";

describe("GitHub Releases Helpers", () => {
  // ============================================================================
  // Test Data
  // ============================================================================

  const mockReleases: GitHubRelease[] = [
    {
      id: 1,
      tag_name: "v2.0.0",
      target_commitish: "main",
      name: "v2.0.0",
      body: "Major release",
      draft: false,
      prerelease: false,
      created_at: "2024-01-15T10:00:00Z",
      published_at: "2024-01-15T12:00:00Z",
      author: { login: "user", id: 123, avatar_url: "https://example.com" },
      html_url: "https://github.com/org/repo/releases/tag/v2.0.0",
      assets: [],
    },
    {
      id: 2,
      tag_name: "v1.1.0",
      target_commitish: "main",
      name: "v1.1.0",
      body: "Minor release",
      draft: false,
      prerelease: false,
      created_at: "2024-01-10T10:00:00Z",
      published_at: "2024-01-10T12:00:00Z",
      author: { login: "user", id: 123, avatar_url: "https://example.com" },
      html_url: "https://github.com/org/repo/releases/tag/v1.1.0",
      assets: [],
    },
    {
      id: 3,
      tag_name: "v1.0.0",
      target_commitish: "main",
      name: "v1.0.0",
      body: "Initial release",
      draft: false,
      prerelease: false,
      created_at: "2024-01-01T10:00:00Z",
      published_at: "2024-01-01T12:00:00Z",
      author: { login: "user", id: 123, avatar_url: "https://example.com" },
      html_url: "https://github.com/org/repo/releases/tag/v1.0.0",
      assets: [],
    },
  ];

  // ============================================================================
  // isSemverPrerelease Tests (re-asserted against SemVer)
  // ============================================================================

  describe("isSemverPrerelease", () => {
    describe("Alpha Releases", () => {
      it("should detect alpha in tag", () => {
        expect(isSemverPrerelease("v1.0.0-alpha")).toBe(true);
      });

      it("should detect alpha.1 format", () => {
        expect(isSemverPrerelease("v1.0.0-alpha.1")).toBe(true);
      });

      it("should detect ALPHA uppercase", () => {
        expect(isSemverPrerelease("v1.0.0-ALPHA")).toBe(true);
      });
    });

    describe("Beta Releases", () => {
      it("should detect beta in tag", () => {
        expect(isSemverPrerelease("v1.0.0-beta")).toBe(true);
      });

      it("should detect beta.2 format", () => {
        expect(isSemverPrerelease("v2.0.0-beta.2")).toBe(true);
      });

      it("should detect BETA uppercase", () => {
        expect(isSemverPrerelease("v1.0.0-BETA")).toBe(true);
      });
    });

    describe("Release Candidate (RC)", () => {
      it("should detect rc in tag", () => {
        expect(isSemverPrerelease("v1.0.0-rc")).toBe(true);
      });

      it("should detect rc.1 format", () => {
        expect(isSemverPrerelease("v1.0.0-rc.1")).toBe(true);
      });

      it("should detect RC uppercase", () => {
        expect(isSemverPrerelease("v1.0.0-RC1")).toBe(true);
      });
    });

    describe("Dev Releases", () => {
      it("should detect dev in tag", () => {
        expect(isSemverPrerelease("v1.0.0-dev")).toBe(true);
      });

      it("should detect dev.123 format", () => {
        expect(isSemverPrerelease("v1.0.0-dev.123")).toBe(true);
      });
    });

    describe("Preview Releases", () => {
      it("should detect preview in tag", () => {
        expect(isSemverPrerelease("v1.0.0-preview")).toBe(true);
      });

      it("should detect preview.1 format", () => {
        expect(isSemverPrerelease("v1.0.0-preview.1")).toBe(true);
      });
    });

    describe("Canary Releases", () => {
      it("should detect canary in tag", () => {
        expect(isSemverPrerelease("v1.0.0-canary")).toBe(true);
      });

      it("should detect canary.abc123 format", () => {
        expect(isSemverPrerelease("v1.0.0-canary.abc123")).toBe(true);
      });
    });

    describe("Next Releases", () => {
      it("should detect next in tag", () => {
        expect(isSemverPrerelease("v1.0.0-next")).toBe(true);
      });

      it("should detect next.1 format", () => {
        expect(isSemverPrerelease("v1.0.0-next.1")).toBe(true);
      });
    });

    describe("Stable Releases", () => {
      it("should return false for stable semver tag", () => {
        expect(isSemverPrerelease("v1.0.0")).toBe(false);
      });

      it("should return false for stable tag without v prefix", () => {
        expect(isSemverPrerelease("1.0.0")).toBe(false);
      });

      it("should return false for patch version", () => {
        expect(isSemverPrerelease("v2.5.10")).toBe(false);
      });

      it("should return true for any pre-release identifier, such as -release", () => {
        expect(isSemverPrerelease("v1.0.0-release")).toBe(true);
      });

      it("should return true for any pre-release identifier, such as -stable", () => {
        expect(isSemverPrerelease("v1.0.0-stable")).toBe(true);
      });
    });

    describe("Edge Cases", () => {
      it("should handle empty string", () => {
        expect(isSemverPrerelease("")).toBe(false);
      });

      it("should handle just version number", () => {
        expect(isSemverPrerelease("1.2.3")).toBe(false);
      });

      it("should not detect a pre-release word outside the version", () => {
        expect(isSemverPrerelease("release-alpha-v1")).toBe(false);
      });

      it("should handle mixed case", () => {
        expect(isSemverPrerelease("v1.0.0-BeTa")).toBe(true);
      });
    });
  });

  // ============================================================================
  // generateCompareUrl Tests
  // ============================================================================

  describe("generateCompareUrl", () => {
    it("should generate correct compare URL", () => {
      const result = generateCompareUrl("https://github.com", "owner", "repo", "v1.0.0", "v2.0.0");
      expect(result).toBe("https://github.com/owner/repo/compare/v1.0.0...v2.0.0");
    });

    it("should handle tags without v prefix", () => {
      const result = generateCompareUrl("https://github.com", "owner", "repo", "1.0.0", "2.0.0");
      expect(result).toBe("https://github.com/owner/repo/compare/1.0.0...2.0.0");
    });

    it("should handle organization with hyphens", () => {
      const result = generateCompareUrl(
        "https://github.com",
        "my-org",
        "my-repo",
        "v1.0.0",
        "v2.0.0"
      );
      expect(result).toBe("https://github.com/my-org/my-repo/compare/v1.0.0...v2.0.0");
    });

    it("should handle pre-release tags", () => {
      const result = generateCompareUrl(
        "https://github.com",
        "owner",
        "repo",
        "v1.0.0",
        "v2.0.0-beta.1"
      );
      expect(result).toBe("https://github.com/owner/repo/compare/v1.0.0...v2.0.0-beta.1");
    });

    it("should handle commit SHA as tag", () => {
      const result = generateCompareUrl(
        "https://github.com",
        "owner",
        "repo",
        "abc123def",
        "v1.0.0"
      );
      expect(result).toBe("https://github.com/owner/repo/compare/abc123def...v1.0.0");
    });

    it("should handle branch name as reference", () => {
      const result = generateCompareUrl("https://github.com", "owner", "repo", "main", "v1.0.0");
      expect(result).toBe("https://github.com/owner/repo/compare/main...v1.0.0");
    });

    it("should handle special characters in org/repo names", () => {
      const result = generateCompareUrl(
        "https://github.com",
        "org_name",
        "repo.name",
        "v1.0.0",
        "v2.0.0"
      );
      expect(result).toBe("https://github.com/org_name/repo.name/compare/v1.0.0...v2.0.0");
    });

    it("should generate URL for consecutive patch versions", () => {
      const result = generateCompareUrl("https://github.com", "owner", "repo", "v1.0.0", "v1.0.1");
      expect(result).toBe("https://github.com/owner/repo/compare/v1.0.0...v1.0.1");
    });

    it("should generate URL for major version jump", () => {
      const result = generateCompareUrl("https://github.com", "owner", "repo", "v1.9.9", "v2.0.0");
      expect(result).toBe("https://github.com/owner/repo/compare/v1.9.9...v2.0.0");
    });
  });

  // ============================================================================
  // getReleaseByTag Tests
  // ============================================================================

  describe("getReleaseByTag", () => {
    const mockOctokit = {
      rest: {
        repos: {
          getReleaseByTag: vi.fn(),
        },
      },
    } as any;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should return release by tag", async () => {
      mockOctokit.rest.repos.getReleaseByTag.mockResolvedValue({
        data: mockReleases[0],
      });

      const { getReleaseByTag } = await import("../../../src/outputs/github-release/api");
      const result = await getReleaseByTag(mockOctokit, "owner", "repo", "v2.0.0");

      expect(result).toEqual(mockReleases[0]);
    });

    it("should return null for 404", async () => {
      const error = new Error("Not found");
      (error as any).status = 404;
      mockOctokit.rest.repos.getReleaseByTag.mockRejectedValue(error);

      const { getReleaseByTag } = await import("../../../src/outputs/github-release/api");
      const result = await getReleaseByTag(mockOctokit, "owner", "repo", "unknown");

      expect(result).toBeNull();
    });

    it("should throw other errors", async () => {
      mockOctokit.rest.repos.getReleaseByTag.mockRejectedValue(new Error("API error"));

      const { getReleaseByTag } = await import("../../../src/outputs/github-release/api");

      await expect(getReleaseByTag(mockOctokit, "owner", "repo", "v1.0.0")).rejects.toThrow(
        "API error"
      );
    });
  });
});

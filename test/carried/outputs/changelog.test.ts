/**
 * Carried from apps/app/src/lib/publishers/changelog.test.ts at 7d1d56f8. The
 * Unreleased case is re-asserted, and the publishToChangelog cases retired.
 */
import { describe, it, expect } from "vitest";
import {
  formatAsChangelog,
  parseChangelog,
  prependToChangelog,
  createDefaultChangelog,
} from "../../../src/outputs/changelog";

describe("formatAsChangelog", () => {
  it("should format entry with version, date, and content", () => {
    const entry = {
      version: "1.2.0",
      date: "2024-01-15",
      content: "### Added\n- New feature X",
    };

    const result = formatAsChangelog(entry);

    expect(result).toContain("## [1.2.0] - 2024-01-15");
    expect(result).toContain("### Added");
    expect(result).toContain("- New feature X");
  });

  it("should include compare URL when provided", () => {
    const entry = {
      version: "1.2.0",
      date: "2024-01-15",
      content: "### Added\n- New feature",
      compareUrl: "https://github.com/user/repo/compare/v1.1.0...v1.2.0",
    };

    const result = formatAsChangelog(entry);

    expect(result).toContain("[1.2.0]: https://github.com/user/repo/compare/v1.1.0...v1.2.0");
  });

  it("should handle Unreleased version", () => {
    const entry = {
      version: "Unreleased",
      date: "2024-01-15",
      content: "### Added\n- Upcoming feature",
    };

    const result = formatAsChangelog(entry);

    expect(result).toContain("## [Unreleased] - 2024-01-15");
  });
});

describe("parseChangelog", () => {
  it("should parse simple changelog with one entry", () => {
    const content = `# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

    const result = parseChangelog(content);

    expect(result.header).toContain("# Changelog");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.version).toBe("1.0.0");
    expect(result.entries[0]?.date).toBe("2024-01-01");
    expect(result.entries[0]?.content).toContain("### Added");
    expect(result.entries[0]?.content).toContain("- Initial release");
  });

  it("should parse multiple entries maintaining order", () => {
    const content = `# Changelog

## [1.2.0] - 2024-01-15

### Added
- Feature X

## [1.1.0] - 2024-01-01

### Fixed
- Bug Y

## [1.0.0] - 2023-12-01

### Added
- Initial release`;

    const result = parseChangelog(content);

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.version).toBe("1.2.0");
    expect(result.entries[1]?.version).toBe("1.1.0");
    expect(result.entries[2]?.version).toBe("1.0.0");
  });

  it("should handle Unreleased section at top", () => {
    const content = `# Changelog

## [Unreleased]

### Added
- Upcoming feature

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

    const result = parseChangelog(content);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.version).toBe("Unreleased");
    expect(result.entries[1]?.version).toBe("1.0.0");
  });

  it("should extract compare URLs from footer", () => {
    const content = `# Changelog

## [1.1.0] - 2024-01-01

### Added
- Feature

[1.1.0]: https://github.com/user/repo/compare/v1.0.0...v1.1.0`;

    const result = parseChangelog(content);

    expect(result.entries[0]?.compareUrl).toBe(
      "https://github.com/user/repo/compare/v1.0.0...v1.1.0"
    );
  });

  it("should handle empty changelog", () => {
    const content = `# Changelog

All notable changes to this project will be documented in this file.`;

    const result = parseChangelog(content);

    expect(result.header).toContain("# Changelog");
    expect(result.entries).toHaveLength(0);
  });

  it("should preserve header content", () => {
    const content = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

    const result = parseChangelog(content);

    expect(result.header).toContain("# Changelog");
    expect(result.header).toContain("Keep a Changelog");
    expect(result.header).toContain("Semantic Versioning");
  });
});

describe("prependToChangelog", () => {
  describe("Basic prepending behavior", () => {
    it("should prepend new entry to empty changelog (newest first)", () => {
      const existingContent = `# Changelog

All notable changes to this project will be documented in this file.`;

      const newEntry = {
        version: "1.0.0",
        date: "2024-01-01",
        content: "### Added\n- Initial release",
      };

      const result = prependToChangelog(existingContent, newEntry);

      expect(result).toContain("# Changelog");
      expect(result).toContain("## [1.0.0] - 2024-01-01");
      expect(result).toContain("### Added");
      expect(result).toContain("- Initial release");
    });

    it("should prepend new entry at the TOP (newest first) - CRITICAL TEST", () => {
      const existingContent = `# Changelog

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

      const newEntry = {
        version: "1.1.0",
        date: "2024-01-15",
        content: "### Added\n- New feature",
      };

      const result = prependToChangelog(existingContent, newEntry);

      // Verify order: newest (1.1.0) should appear BEFORE oldest (1.0.0)
      const indexOfNew = result.indexOf("## [1.1.0]");
      const indexOfOld = result.indexOf("## [1.0.0]");

      expect(indexOfNew).toBeLessThan(indexOfOld);
      expect(indexOfNew).toBeGreaterThan(0); // Should exist
      expect(result).toContain("## [1.1.0] - 2024-01-15");
    });

    it("should maintain reverse chronological order with multiple entries", () => {
      const existingContent = `# Changelog

## [1.1.0] - 2024-01-10

### Added
- Feature Y

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

      const newEntry = {
        version: "1.2.0",
        date: "2024-01-20",
        content: "### Added\n- Feature Z",
      };

      const result = prependToChangelog(existingContent, newEntry);

      // Extract all version headers
      const versionMatches = result.match(/## \[([^\]]+)\]/g);

      expect(versionMatches).toEqual([
        "## [1.2.0]", // Newest
        "## [1.1.0]", // Middle
        "## [1.0.0]", // Oldest
      ]);
    });
  });

  describe("Idempotency (duplicate prevention)", () => {
    it("should skip duplicate entry (idempotent behavior)", () => {
      const existingContent = `# Changelog

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

      const newEntry = {
        version: "1.0.0",
        date: "2024-01-01",
        content: "### Added\n- Different content",
      };

      const result = prependToChangelog(existingContent, newEntry);

      // Should return unchanged content
      expect(result).toBe(existingContent);

      // Should NOT have duplicate entries
      const versionMatches = result.match(/## \[1\.0\.0\]/g);
      expect(versionMatches).toHaveLength(1);
    });

    it("should allow same version with different date (edge case)", () => {
      const existingContent = `# Changelog

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

      const newEntry = {
        version: "1.0.0-beta",
        date: "2023-12-15",
        content: "### Added\n- Beta release",
      };

      const result = prependToChangelog(existingContent, newEntry);

      // Different version strings, so both should exist
      expect(result).toContain("## [1.0.0-beta]");
      expect(result).toContain("## [1.0.0]");
    });
  });

  describe("Header and footer preservation", () => {
    it("should preserve header at the top", () => {
      const existingContent = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

      const newEntry = {
        version: "1.1.0",
        date: "2024-01-15",
        content: "### Added\n- New feature",
      };

      const result = prependToChangelog(existingContent, newEntry);

      // Header should still be at the very top
      expect(result.startsWith("# Changelog")).toBe(true);
      expect(result).toContain("Keep a Changelog");

      // New entry should be after header but before old entries
      const headerEnd = result.indexOf("## [");
      const newEntryIndex = result.indexOf("## [1.1.0]");
      expect(newEntryIndex).toBe(headerEnd);
    });

    it("should preserve compare URLs/footer", () => {
      const existingContent = `# Changelog

## [1.0.0] - 2024-01-01

### Added
- Initial release

[1.0.0]: https://github.com/user/repo/releases/tag/v1.0.0`;

      const newEntry = {
        version: "1.1.0",
        date: "2024-01-15",
        content: "### Added\n- New feature",
        compareUrl: "https://github.com/user/repo/compare/v1.0.0...v1.1.0",
      };

      const result = prependToChangelog(existingContent, newEntry);

      expect(result).toContain("[1.1.0]: https://github.com/user/repo/compare/v1.0.0...v1.1.0");
      expect(result).toContain("[1.0.0]: https://github.com/user/repo/releases/tag/v1.0.0");
    });
  });

  describe("Edge cases", () => {
    it("should keep the Unreleased section first", () => {
      const existingContent = `# Changelog

## [Unreleased]

### Added
- Work in progress

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

      const newEntry = {
        version: "1.1.0",
        date: "2024-01-15",
        content: "### Added\n- New feature",
      };

      const result = prependToChangelog(existingContent, newEntry);

      // Re-asserted (CONVERSION-PLAN §7.3): Keep a Changelog keeps Unreleased
      // first, so the order is Unreleased → 1.1.0 → 1.0.0.
      const unreleasedIndex = result.indexOf("## [Unreleased]");
      const newIndex = result.indexOf("## [1.1.0]");
      const oldIndex = result.indexOf("## [1.0.0]");

      expect(unreleasedIndex).toBeLessThan(newIndex);
      expect(newIndex).toBeLessThan(oldIndex);
    });

    it("should handle pre-release versions", () => {
      const existingContent = `# Changelog

## [1.0.0] - 2024-01-01

### Added
- Initial release`;

      const newEntry = {
        version: "1.1.0-beta.1",
        date: "2024-01-10",
        content: "### Added\n- Beta feature",
      };

      const result = prependToChangelog(existingContent, newEntry);

      expect(result).toContain("## [1.1.0-beta.1]");
      const betaIndex = result.indexOf("## [1.1.0-beta.1]");
      const releaseIndex = result.indexOf("## [1.0.0]");
      expect(betaIndex).toBeLessThan(releaseIndex);
    });

    it("should handle multiple releases same day (maintains version order)", () => {
      const existingContent = `# Changelog

## [1.0.0] - 2024-01-15

### Added
- Feature A`;

      const newEntry = {
        version: "1.0.1",
        date: "2024-01-15", // Same day
        content: "### Fixed\n- Hotfix B",
      };

      const result = prependToChangelog(existingContent, newEntry);

      // 1.0.1 should be before 1.0.0 (newest first)
      const indexNew = result.indexOf("## [1.0.1]");
      const indexOld = result.indexOf("## [1.0.0]");
      expect(indexNew).toBeLessThan(indexOld);
    });

    it("should handle empty content sections", () => {
      const existingContent = `# Changelog

## [1.0.0] - 2024-01-01`;

      const newEntry = {
        version: "1.1.0",
        date: "2024-01-15",
        content: "",
      };

      const result = prependToChangelog(existingContent, newEntry);

      expect(result).toContain("## [1.1.0]");
      expect(result).toContain("## [1.0.0]");
    });
  });
});

describe("createDefaultChangelog", () => {
  it("should create changelog with proper header", () => {
    const firstEntry = {
      version: "1.0.0",
      date: "2024-01-01",
      content: "### Added\n- Initial release",
    };

    const result = createDefaultChangelog(firstEntry);

    expect(result).toContain("# Changelog");
    expect(result).toContain("All notable changes to this project will be documented in this file");
    expect(result).toContain("Keep a Changelog");
    expect(result).toContain("Semantic Versioning");
  });

  it("should include the first entry", () => {
    const firstEntry = {
      version: "1.0.0",
      date: "2024-01-01",
      content: "### Added\n- Initial release",
    };

    const result = createDefaultChangelog(firstEntry);

    expect(result).toContain("## [1.0.0] - 2024-01-01");
    expect(result).toContain("### Added");
    expect(result).toContain("- Initial release");
  });

  it("should handle Unreleased as first entry", () => {
    const firstEntry = {
      version: "Unreleased",
      date: "2024-01-01",
      content: "### Added\n- Work in progress",
    };

    const result = createDefaultChangelog(firstEntry);

    expect(result).toContain("## [Unreleased]");
  });
});

describe("Industry standard compliance - Keep a Changelog", () => {
  it("should follow 'newest first' standard (integration test)", () => {
    // Start with empty changelog
    let changelog = `# Changelog

All notable changes to this project will be documented in this file.`;

    // Add versions in chronological order (oldest first)
    const entries = [
      {
        version: "1.0.0",
        date: "2024-01-01",
        content: "### Added\n- Initial release",
      },
      {
        version: "1.1.0",
        date: "2024-01-15",
        content: "### Added\n- Feature X",
      },
      {
        version: "1.2.0",
        date: "2024-02-01",
        content: "### Added\n- Feature Y",
      },
    ];

    // Prepend each entry (simulating releases over time)
    for (const entry of entries) {
      changelog = prependToChangelog(changelog, entry);
    }

    // Verify final order is REVERSE chronological (newest first)
    const versionMatches = changelog.match(/## \[([^\]]+)\]/g);

    expect(versionMatches).toEqual([
      "## [1.2.0]", // Newest (published last)
      "## [1.1.0]", // Middle
      "## [1.0.0]", // Oldest (published first)
    ]);
  });

  it("should match Keep a Changelog example structure", () => {
    const changelog = createDefaultChangelog({
      version: "1.0.0",
      date: "2024-01-01",
      content: "### Added\n- Initial release",
    });

    // Verify structure matches Keep a Changelog format
    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain("All notable changes");
    expect(changelog).toContain("Keep a Changelog");
    expect(changelog).toContain("Semantic Versioning");
    expect(changelog).toContain("## [1.0.0]");
    expect(changelog).toContain("### Added");
  });
});

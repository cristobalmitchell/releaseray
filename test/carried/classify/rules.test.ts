/**
 * Carried from packages/shared/src/utils/enhanced-classification.test.ts at 7d1d56f8.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  enhancedClassifyChanges,
  enhancedFallbackClassification,
  type PRCommentInput,
} from "../../../src/core/classify/rules";

describe("enhancedClassifyChanges", () => {
  const mockPRs: Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    linkedIssueIds: number[];
    author: string;
  }> = [
    {
      number: 101,
      title: "feat: Add user authentication",
      body: "Implements OAuth 2.0 authentication flow",
      labels: ["type:feature"],
      linkedIssueIds: [],
      author: "dev1",
    },
    {
      number: 102,
      title: "fix: Resolve memory leak in worker process",
      body: "Fixes #45\nThis resolves a critical memory leak",
      labels: ["type:bug", "priority:high"],
      linkedIssueIds: [45],
      author: "dev2",
    },
    {
      number: 103,
      title: "BREAKING: Remove legacy API endpoints",
      body: "**Breaking Change**\n\nRemoves deprecated v1 API endpoints",
      labels: ["breaking"],
      linkedIssueIds: [],
      author: "dev3",
    },
    {
      number: 104,
      title: "security: Patch CVE-2024-1234 vulnerability",
      body: "Addresses security vulnerability CVE-2024-1234",
      labels: ["security"],
      linkedIssueIds: [],
      author: "dev4",
    },
    {
      number: 105,
      title: "perf: Optimize database queries",
      body: "Reduces query time by 50%",
      labels: ["type:performance"],
      linkedIssueIds: [],
      author: "dev5",
    },
  ];

  const mockIssues = [
    {
      number: 45,
      title: "Memory leak in background worker",
      body: "Worker process consumes increasing memory",
      labels: ["type:bug"],
    },
  ];

  it("should classify feature PRs correctly", async () => {
    const result = await enhancedClassifyChanges([mockPRs[0]!], []);

    expect(result.grouped).toBeDefined();
    const featureGroup = result.grouped.find(
      (g: { category: string }) => g.category === "Features"
    );
    expect(featureGroup).toBeDefined();
    expect(featureGroup?.items).toHaveLength(1);
    expect(featureGroup?.items[0]?.ref.pr).toBe(101);
  });

  it("should classify bug fixes correctly", async () => {
    const result = await enhancedClassifyChanges([mockPRs[1]!], mockIssues);

    const fixGroup = result.grouped.find((g: { category: string }) => g.category === "Fixes");
    expect(fixGroup).toBeDefined();
    expect(fixGroup?.items).toHaveLength(1);
  });

  it("should prioritize breaking changes", async () => {
    const result = await enhancedClassifyChanges([mockPRs[2]!], []);

    const breakingGroup = result.grouped.find((g) => g.category === "Breaking Changes");
    expect(breakingGroup).toBeDefined();
    expect(breakingGroup?.items[0]?.flags.breaking).toBe(true);
    expect(breakingGroup?.items[0]?.signals).toContain("priority:breaking");
  });

  it("should prioritize security issues", async () => {
    const result = await enhancedClassifyChanges([mockPRs[3]!], []);

    const securityGroup = result.grouped.find((g) => g.category === "Security");
    expect(securityGroup).toBeDefined();
    expect(securityGroup?.items[0]?.flags.security).toBe(true);
    expect(securityGroup?.items[0]?.signals).toContain("priority:security");
  });

  it("should classify performance improvements", async () => {
    const result = await enhancedClassifyChanges([mockPRs[4]!], []);

    const perfGroup = result.grouped.find((g) => g.category === "Performance");
    expect(perfGroup).toBeDefined();
    expect(perfGroup?.items[0]?.confidence).toBeGreaterThan(0.5);
  });

  it("should include confidence scores", async () => {
    const result = await enhancedClassifyChanges(mockPRs, mockIssues);

    for (const group of result.grouped) {
      for (const item of group.items) {
        expect(item.confidence).toBeGreaterThan(0);
        expect(item.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it("should include classification signals", async () => {
    const result = await enhancedClassifyChanges([mockPRs[0]!], []);

    const item = result.grouped[0]?.items[0];
    expect(item?.signals).toBeDefined();
    expect(Array.isArray(item?.signals)).toBe(true);
    expect(item?.signals?.length).toBeGreaterThan(0);
  });

  it("should handle PRs with no labels", async () => {
    const unlabeledPR = {
      number: 999,
      title: "Update README documentation",
      body: "Minor documentation update",
      labels: [],
      linkedIssueIds: [],
      author: "dev99",
    };

    const result = await enhancedClassifyChanges([unlabeledPR], []);
    expect(result.grouped).toBeDefined();
    expect(result.grouped.length).toBeGreaterThan(0);
  });

  it("should truncate long titles and descriptions", async () => {
    const longPR = {
      number: 200,
      title: "A".repeat(200),
      body: "B".repeat(300),
      labels: ["type:feature"],
      linkedIssueIds: [],
      author: "dev",
    };

    const result = await enhancedClassifyChanges([longPR], []);
    const item = result.grouped[0]?.items[0];

    expect(item?.title.length).toBeLessThanOrEqual(140);
    expect(item?.description.length).toBeLessThanOrEqual(200);
  });
});

describe("enhancedFallbackClassification", () => {
  it("should classify PRs without LLM calls", () => {
    const prs = [
      {
        number: 1,
        title: "feat: Add new feature",
        body: null,
        labels: ["feature"],
        linkedIssueIds: [],
      },
      {
        number: 2,
        title: "fix: Bug fix",
        body: null,
        labels: ["bug"],
        linkedIssueIds: [],
      },
    ];

    const result = enhancedFallbackClassification(prs);

    expect(result.grouped).toBeDefined();
    expect(result.grouped.length).toBeGreaterThan(0);
  });

  it("should handle breaking changes in fallback mode", () => {
    const prs = [
      {
        number: 1,
        title: "BREAKING: Remove old API",
        body: "This is a breaking change",
        labels: ["breaking"],
        linkedIssueIds: [],
      },
    ];

    const result = enhancedFallbackClassification(prs);
    const breakingGroup = result.grouped.find((g) => g.category === "Breaking Changes");

    expect(breakingGroup).toBeDefined();
    expect(breakingGroup?.items[0]?.flags.breaking).toBe(true);
  });

  it("should detect security issues in fallback mode", () => {
    const prs = [
      {
        number: 1,
        title: "Security fix for CVE-2024-1234",
        body: "Fixes CVE-2024-1234 vulnerability",
        labels: ["security"],
        linkedIssueIds: [],
      },
    ];

    const result = enhancedFallbackClassification(prs);
    const securityGroup = result.grouped.find((g) => g.category === "Security");

    expect(securityGroup).toBeDefined();
    expect(securityGroup?.items[0]?.flags.security).toBe(true);
  });

  it("should default to Improvements for unclassifiable PRs", () => {
    const prs = [
      {
        number: 1,
        title: "Update something",
        body: null,
        labels: [],
        linkedIssueIds: [],
      },
    ];

    const result = enhancedFallbackClassification(prs);
    const improvementGroup = result.grouped.find((g) => g.category === "Improvements");

    expect(improvementGroup).toBeDefined();
  });

  it("should include medium confidence for fallback classifications", () => {
    const prs = [
      {
        number: 1,
        title: "Update feature",
        body: null,
        labels: [],
        linkedIssueIds: [],
      },
    ];

    const result = enhancedFallbackClassification(prs);
    const item = result.grouped[0]?.items[0];

    expect(item?.confidence).toBe(0.7);
  });
});

describe("enhancedClassifyChanges with comments", () => {
  it("should detect security issues from PR comments", async () => {
    const prs = [
      {
        number: 1,
        title: "Update authentication module",
        body: "Refactor auth code",
        labels: [],
        linkedIssueIds: [],
        author: "dev1",
        comments: [
          {
            body: "This fixes a security vulnerability we found in the auth flow",
            author: "reviewer1",
            commentType: "review_body",
            reviewState: "APPROVED",
          },
        ] as PRCommentInput[],
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    const securityGroup = result.grouped.find((g) => g.category === "Security");
    expect(securityGroup).toBeDefined();
    expect(securityGroup?.items[0]?.signals).toContain("priority:security");
  });

  it("should detect breaking changes from PR comments", async () => {
    const prs = [
      {
        number: 1,
        title: "Update API endpoints",
        body: "Improve API response format",
        labels: [],
        linkedIssueIds: [],
        author: "dev1",
        comments: [
          {
            body: "This is a breaking change - the response format is different",
            author: "reviewer1",
            commentType: "issue_comment",
          },
        ] as PRCommentInput[],
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    const breakingGroup = result.grouped.find((g) => g.category === "Breaking Changes");
    expect(breakingGroup).toBeDefined();
    expect(breakingGroup?.items[0]?.flags.breaking).toBe(true);
  });

  it("should detect performance improvements from comments", async () => {
    const prs = [
      {
        number: 1,
        title: "Refactor database module",
        body: "Clean up database code",
        labels: [],
        linkedIssueIds: [],
        author: "dev1",
        comments: [
          {
            body: "Nice optimization! The benchmark shows 50% faster queries now",
            author: "reviewer1",
            commentType: "review_body",
            reviewState: "APPROVED",
          },
        ] as PRCommentInput[],
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    const perfGroup = result.grouped.find((g) => g.category === "Performance");
    expect(perfGroup).toBeDefined();
    expect(perfGroup?.items[0]?.signals).toContain("comment:performance");
  });

  it("should detect deprecation mentions from comments", async () => {
    const prs = [
      {
        number: 1,
        title: "Update legacy code",
        body: "Modernize old module",
        labels: [],
        linkedIssueIds: [],
        author: "dev1",
        comments: [
          {
            body: "This deprecates the old API - we should add sunset warnings",
            author: "reviewer1",
            commentType: "issue_comment",
          },
        ] as PRCommentInput[],
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    const item = result.grouped[0]?.items[0];
    expect(item?.flags.deprecation).toBe(true);
  });

  it("should work with PRs without comments", async () => {
    const prs = [
      {
        number: 1,
        title: "feat: Add new feature",
        body: "Implement new functionality",
        labels: ["type:feature"],
        linkedIssueIds: [],
        author: "dev1",
        comments: [], // Empty comments array
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    expect(result.grouped).toBeDefined();
    const featureGroup = result.grouped.find((g) => g.category === "Features");
    expect(featureGroup).toBeDefined();
  });

  it("should work with PRs with undefined comments", async () => {
    const prs = [
      {
        number: 1,
        title: "feat: Add new feature",
        body: "Implement new functionality",
        labels: ["type:feature"],
        linkedIssueIds: [],
        author: "dev1",
        // comments field is undefined
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    expect(result.grouped).toBeDefined();
    const featureGroup = result.grouped.find((g) => g.category === "Features");
    expect(featureGroup).toBeDefined();
  });

  it("should analyze issue comments for linked issues", async () => {
    const prs = [
      {
        number: 1,
        title: "Fix bug",
        body: "Fixes #10",
        labels: [],
        linkedIssueIds: [10],
        author: "dev1",
      },
    ];

    const issues = [
      {
        number: 10,
        title: "Something is broken",
        body: "It doesn't work",
        labels: [],
        comments: [
          {
            body: "This is a security issue - data is being exposed",
            author: "user1",
          },
        ],
      },
    ];

    const result = await enhancedClassifyChanges(prs, issues);

    const securityGroup = result.grouped.find((g) => g.category === "Security");
    expect(securityGroup).toBeDefined();
    expect(securityGroup?.items[0]?.signals).toContain("issue-comment:security");
  });

  it("should extract key points from review comments", async () => {
    const prs = [
      {
        number: 1,
        title: "Update module",
        body: "Some changes",
        labels: [],
        linkedIssueIds: [],
        author: "dev1",
        comments: [
          {
            body: "This improves the overall user experience significantly. Great work!",
            author: "reviewer1",
            commentType: "review_body",
            reviewState: "APPROVED",
          },
        ] as PRCommentInput[],
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    const item = result.grouped[0]?.items[0];
    // The description should be enhanced with key points
    expect(item?.description).toBeDefined();
  });

  it("should handle multiple comment types", async () => {
    const prs = [
      {
        number: 1,
        title: "Refactor code",
        body: "Clean up",
        labels: [],
        linkedIssueIds: [],
        author: "dev1",
        comments: [
          {
            body: "Consider the security implications here",
            author: "reviewer1",
            commentType: "issue_comment",
          },
          {
            body: "This looks like a breaking change to me",
            author: "reviewer2",
            commentType: "review_comment",
          },
          {
            body: "LGTM - approved!",
            author: "reviewer3",
            commentType: "review_body",
            reviewState: "APPROVED",
          },
        ] as PRCommentInput[],
      },
    ];

    const result = await enhancedClassifyChanges(prs, []);

    // Should detect both security and breaking from comments
    const item = result.grouped[0]?.items[0];
    expect(item?.flags.breaking).toBe(true);
    expect(item?.flags.security).toBe(true);
  });
});

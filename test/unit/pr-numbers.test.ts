import { describe, expect, it } from "vitest";
import fixture from "../fixtures/pr-extract.json";
import {
  extractPRNumbers,
  HOSTED_PR_TITLE_PATTERNS,
  HOSTED_SUBJECT_PATTERNS,
  partitionByTitle,
} from "../../src/core/range/pr-numbers";
import { classifyCommits, extractLabelsFromCommit } from "../../src/core/classify/commits";

const commits = (...subjects: string[]) => subjects.map((message) => ({ message }));

describe("extractPRNumbers", () => {
  it("keeps 'Release validation fix (#12)' with empty patterns", () => {
    expect(extractPRNumbers(commits("Release validation fix (#12)"))).toEqual({
      prNumbers: [12],
      excludedPRNumbers: [],
    });
  });

  it("excludes only the trailing (#n) of a matching subject", () => {
    const result = extractPRNumbers(
      commits("chore: promote develop to staging (#7) (#9)", "feat: x (#7)"),
      {
        titlePatterns: [/promote/i],
      }
    );
    expect(result).toEqual({ prNumbers: [7], excludedPRNumbers: [9] });
  });

  it("reads merge commits and squash subjects with several numbers", () => {
    expect(
      extractPRNumbers(commits("Merge pull request #5 from owner/branch", "feat: a (#6 #8)"))
        .prNumbers
    ).toEqual([5, 6, 8]);
  });

  it("yields no PR number for a rebase-style subject", () => {
    expect(extractPRNumbers(commits("fix: handle empty input")).prNumbers).toEqual([]);
  });

  describe("with today's patterns configured, matches the hosted extractor on every fixture range", () => {
    for (const c of fixture.cases) {
      it(c.range, () => {
        const result = extractPRNumbers(commits(...c.subjects), {
          titlePatterns: HOSTED_SUBJECT_PATTERNS,
        });
        expect(result.prNumbers).toEqual(c.expected.prNumbers);
        expect(result.excludedPRNumbers).toEqual(c.expected.promotionPRNumbers);
      });
    }
  });

  it("the fixture covers the plan's measured ranges", () => {
    const counts = Object.fromEntries(
      fixture.cases.map((c) => [c.range, c.expected.prNumbers.length])
    );
    expect(counts).toMatchObject({
      "v3.6.0..v4.0.0": 24,
      "v4.1.0..v4.2.0": 25,
      "v1.3.0..v1.4.0": 27,
      "v4.6.1..v4.7.0": 4,
    });
  });
});

describe("partitionByTitle", () => {
  it("keeps everything with no patterns and records the matching pattern otherwise", () => {
    const prs = [{ title: "Promote staging to production" }, { title: "Add SSO" }];
    expect(partitionByTitle(prs).kept).toHaveLength(2);
    const { kept, excluded } = partitionByTitle(prs, HOSTED_PR_TITLE_PATTERNS);
    expect(kept).toEqual([{ title: "Add SSO" }]);
    expect(excluded).toEqual([{ pr: prs[0], pattern: "promote" }]);
  });
});

describe("commit fallback", () => {
  it("maps feat: and fix: subjects to the features and fixes categories", async () => {
    expect(extractLabelsFromCommit("feat(api): add endpoint")).toEqual(["feature"]);
    expect(extractLabelsFromCommit("fix: crash on start")).toEqual(["bug"]);
    const grouped = await classifyCommits([
      {
        sha: "a",
        message: "feat(api): add endpoint",
        subject: "feat(api): add endpoint",
        author: "x",
      },
      { sha: "b", message: "fix: crash on start", subject: "fix: crash on start", author: "y" },
    ]);
    expect(Object.fromEntries(grouped.grouped.map((g) => [g.category, g.items.length]))).toEqual({
      Features: 1,
      Fixes: 1,
    });
  });

  it("labels an unconventional message 'other'", () => {
    expect(extractLabelsFromCommit("Update README")).toEqual(["other"]);
  });
});

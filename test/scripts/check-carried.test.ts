import { describe, expect, it } from "vitest";
import {
  compareCarried,
  renderSummary,
  type CarriedManifest,
  type ListedTest,
} from "../../scripts/check-carried";

const manifest: CarriedManifest = {
  sourceCommit: "7d1d56f8",
  files: { "packages/shared/src/a.test.ts": "test/carried/a.test.ts" },
  tests: [
    {
      sourceFile: "packages/shared/src/a.test.ts",
      fullName: "a > one",
      status: "carry",
      reason: "",
    },
    {
      sourceFile: "packages/shared/src/a.test.ts",
      fullName: "a > two",
      status: "edit",
      reason: "x",
    },
    {
      sourceFile: "packages/shared/src/a.test.ts",
      fullName: "a > old",
      status: "retire",
      reason: "y",
    },
  ],
};

const listed: ListedTest[] = [
  { file: "test/carried/a.test.ts", fullName: "a > one" },
  { file: "test/carried/a.test.ts", fullName: "a > two" },
  { file: "test/unit/new.test.ts", fullName: "new > anything" },
];

describe("compareCarried", () => {
  it("passes when every kept title is collected and nothing else is in carried files", () => {
    const report = compareCarried(manifest, listed);
    expect(report.missing).toEqual([]);
    expect(report.unlisted).toEqual([]);
    expect(report.totals).toEqual([
      {
        sourceFile: "packages/shared/src/a.test.ts",
        targetFile: "test/carried/a.test.ts",
        carry: 1,
        edit: 1,
        retire: 1,
        collected: 2,
      },
    ]);
  });

  it("fails when a manifest carry title is missing", () => {
    const report = compareCarried(manifest, listed.slice(1));
    expect(report.missing.map((t) => t.fullName)).toEqual(["a > one"]);
  });

  it("fails when an extra carry title is in the manifest but not collected", () => {
    const extra: CarriedManifest = {
      ...manifest,
      tests: [
        ...manifest.tests,
        {
          sourceFile: "packages/shared/src/a.test.ts",
          fullName: "a > extra",
          status: "carry",
          reason: "",
        },
      ],
    };
    expect(compareCarried(extra, listed).missing.map((t) => t.fullName)).toEqual(["a > extra"]);
  });

  it("fails when a carried file holds an unlisted title", () => {
    const report = compareCarried(manifest, [
      ...listed,
      { file: "test/carried/a.test.ts", fullName: "a > sneaked in" },
    ]);
    expect(report.unlisted.map((t) => t.fullName)).toEqual(["a > sneaked in"]);
  });

  it("renders totals as Markdown", () => {
    const text = renderSummary(compareCarried(manifest, listed));
    expect(text).toContain("2 carried, 1 of them edited, and 1 retired.");
    expect(text).toContain("| `test/carried/a.test.ts` | 2 | 1 | 1 | 2 |");
  });
});

describe("renamed edits", () => {
  it("matches an edited test by its targetName", () => {
    const renamed: CarriedManifest = {
      ...manifest,
      tests: manifest.tests.map((t) =>
        t.fullName === "a > two" ? { ...t, targetName: "a > two, re-asserted" } : t
      ),
    };
    const report = compareCarried(renamed, [
      listed[0],
      { file: "test/carried/a.test.ts", fullName: "a > two, re-asserted" },
    ]);
    expect(report.missing).toEqual([]);
    expect(report.unlisted).toEqual([]);
  });
});

describe("test/carried/manifest.json", () => {
  it("lists 550 tests: 484 carry or edit, 46 of them edit, and 66 retire", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const real = JSON.parse(
      readFileSync(join(__dirname, "..", "carried", "manifest.json"), "utf8")
    ) as CarriedManifest;
    const count = (status: string) => real.tests.filter((t) => t.status === status).length;
    expect(real.tests).toHaveLength(550);
    expect(count("carry") + count("edit")).toBe(484);
    expect(count("edit")).toBe(46);
    expect(count("retire")).toBe(66);
    expect(Object.keys(real.files)).toHaveLength(15);
    expect(real.tests.every((t) => t.sourceFile in real.files)).toBe(true);
  });
});

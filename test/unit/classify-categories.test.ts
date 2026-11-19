import { describe, expect, it } from "vitest";
import {
  classifyByLabels,
  enhancedClassifyChanges,
  enhancedFallbackClassification,
  labelRulesFromCategories,
} from "../../src/core/classify/rules";
import {
  BUILTIN_CATEGORIES,
  createGroupedChangesSchema,
  GroupedChangesSchema,
} from "../../src/core/types";

const pr = (
  overrides: Partial<{ number: number; title: string; body: string; labels: string[] }>
) => ({
  number: 1,
  title: "Update things",
  body: "Some changes to the system",
  labels: [] as string[],
  linkedIssueIds: [] as number[],
  author: "dev",
  ...overrides,
});

describe("categories as data", () => {
  const categories = [...BUILTIN_CATEGORIES, "Infrastructure"];
  const labelRules = labelRulesFromCategories([
    { title: "Infrastructure", labels: ["area: infra"] },
  ]);

  it("a custom infrastructure category classifies a PR carrying its label", async () => {
    const result = await enhancedClassifyChanges([pr({ number: 7, labels: ["area: infra"] })], [], {
      labelRules,
      categories,
    });
    expect(result.grouped.map((g) => g.category)).toEqual(["Infrastructure"]);
    expect(result.grouped[0].items[0].signals).toContain("label:infrastructure");
    expect(createGroupedChangesSchema(categories).safeParse(result).success).toBe(true);
  });

  it("configured labels match whole and ignore case", () => {
    expect(classifyByLabels(["AREA: INFRA"], labelRules)).toBe("Infrastructure");
    expect(classifyByLabels(["area: infra-legacy"], labelRules)).toBeNull();
  });

  it("the same label is ignored when its category is not configured", async () => {
    const result = await enhancedClassifyChanges([pr({ labels: ["area: infra"] })], []);
    expect(result.grouped.map((g) => g.category)).toEqual(["Improvements"]);
  });

  it("a category outside the configured list falls back", async () => {
    const result = await enhancedClassifyChanges([pr({ labels: ["type: docs"] })], [], {
      categories: ["Features", "Improvements"],
    });
    expect(result.grouped.map((g) => g.category)).toEqual(["Improvements"]);
  });
});

describe("Internal", () => {
  it("an internal item from the classifier validates against the built-in schema", async () => {
    const result = await enhancedClassifyChanges([pr({ labels: ["type: chore"] })], []);
    expect(result.grouped[0].category).toBe("Internal");
    expect(GroupedChangesSchema.safeParse(result).success).toBe(true);
  });

  it("the fallback classifier keeps Internal PRs instead of dropping them", () => {
    const result = enhancedFallbackClassification([pr({ number: 9, labels: ["type: refactor"] })]);
    expect(result.grouped).toHaveLength(1);
    expect(result.grouped[0].category).toBe("Internal");
    expect(result.grouped[0].items[0].ref.pr).toBe(9);
  });
});

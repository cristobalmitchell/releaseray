/**
 * The acceptance criteria the hermetic e2e suite covers, and the test file
 * for each (CONVERSION-PLAN §12.2: Phase 3, plus Phase 4 criteria 4 and 8).
 *
 * Out of scope: Phase 3 #13, #15, #17 and the real `release: published`
 * trigger part of #9 need real GitHub, so they are not covered here.
 */

/** Covered criteria by id, with the file that checks each. */
export const COVERED = {
  "3.1": { title: "Append once", file: "flow1.e2e.ts" },
  "3.2": { title: "Re-run is a no-op", file: "flow1.e2e.ts" },
  "3.3": { title: "Lost-CHANGELOG repair", file: "changelog.e2e.ts" },
  "3.4": { title: "Parallel tags", file: "changelog.e2e.ts" },
  "3.5": { title: "Human edit", file: "flow1.e2e.ts" },
  "3.6": { title: "PR body edit", file: "flow1.e2e.ts" },
  "3.7": { title: "Comment only", file: "flow1.e2e.ts" },
  "3.8": { title: "Draft and name", file: "flow1.e2e.ts" },
  "3.9": { title: "Event, input and clone guards", file: "guards.e2e.ts" },
  "3.10": { title: "Visibility", file: "guards.e2e.ts" },
  "3.11": { title: "Hardened split", file: "hardened.e2e.ts" },
  "3.12": { title: "Marker round-trip", file: "flow1.e2e.ts" },
  "3.14": { title: "Summary size", file: "summary.e2e.ts" },
  "3.16": { title: "Published text is filtered", file: "flow1.e2e.ts" },
  "3.18": { title: "Tools workflow", file: "tools.e2e.ts" },
  "4.4": { title: "Quickstart through the real openai adapter", file: "quickstart.e2e.ts" },
  "4.8": { title: "Starter config passes validate-config", file: "quickstart.e2e.ts" },
} as const;

export type CriterionId = keyof typeof COVERED;

import { describe, expect, it } from "vitest";
import { shiftHeadings } from "../../src/core/render/markdown";
import {
  canonicalJson,
  generationDigest,
  inputDigest,
  outputDigest,
  type InputSnapshotSource,
} from "../../src/core/state/digest";
import { writeMarkedBlock } from "../../src/core/state/marker";
import {
  findStoredText,
  generatesUnpersisted,
  hasUnmarkedEntry,
  planSink,
  type PlanTarget,
} from "../../src/core/state/planner";

const KEY = "v1.4.0";
const GEN = "3f1c9a07b2d4e815";
const TEXT = "## Features\n\n- Added export (#12)";

function block(inner = TEXT, gen = GEN, persona = "engineer", out = outputDigest(inner)) {
  return writeMarkedBlock({ key: KEY, persona, gen, out }, inner);
}

function release(text: string, extra: Partial<PlanTarget> = {}): PlanTarget {
  return {
    sink: "github-release",
    exists: true,
    text,
    mode: "section",
    onHumanEdit: "skip",
    createIfMissing: false,
    ...extra,
  };
}

function changelog(text: string, extra: Partial<PlanTarget> = {}): PlanTarget {
  return { ...release(text, extra), sink: "changelog", createIfMissing: true, ...extra };
}

const request = { key: KEY, persona: "engineer", gen: GEN, force: false };
const changed = { ...request, gen: "aaaaaaaaaaaaaaaa" };

describe("digests", () => {
  type Mutable = Omit<InputSnapshotSource, "pulls"> & {
    pulls: Array<InputSnapshotSource["pulls"][number]>;
  };
  const source = (): Mutable => ({
    range: { from: "v1.3.0", to: KEY, commits: [{ sha: "a1" }, { sha: "b2" }] },
    pulls: [
      {
        number: 12,
        title: "Add export",
        body: "Adds CSV export.",
        labels: ["type: feature", "area: ui"],
        author: "dev",
        mergedAt: "2026-09-01T00:00:00Z",
        comments: [],
      },
    ],
    issues: [],
    comments: false,
  });

  it("ignores a new comment when comments are off, and changes when a body is edited", () => {
    const base = inputDigest(source());
    const withComment = source();
    withComment.pulls[0] = {
      ...withComment.pulls[0],
      comments: [{ author: "lead", body: "Nice", association: "MEMBER", kind: "comment" }],
    };
    expect(inputDigest(withComment)).toBe(base);

    const edited = source();
    edited.pulls[0].body = "Adds CSV and JSON export.";
    expect(inputDigest(edited)).not.toBe(base);

    const parts = {
      persona: { id: "engineer" },
      templates: { system: "s", persona: "p" },
      provider: "openai",
      model: "gpt-5-mini",
      maxCompletionTokens: 16384,
      render: {},
    };
    expect(generationDigest({ ...parts, input: inputDigest(withComment) })).toBe(
      generationDigest({ ...parts, input: base })
    );
    expect(generationDigest({ ...parts, input: inputDigest(edited) })).not.toBe(
      generationDigest({ ...parts, input: base })
    );
  });

  it("counts comments when comment enrichment is on", () => {
    const on = { ...source(), comments: true };
    const withComment = {
      ...on,
      pulls: on.pulls.map((p) => ({ ...p, comments: [] as typeof p.comments })),
    };
    withComment.pulls[0] = {
      ...withComment.pulls[0],
      comments: [{ author: "lead", body: "Nice", association: "MEMBER", kind: "comment" }],
    };
    expect(inputDigest(withComment)).not.toBe(inputDigest(on));
  });

  it("does not depend on label order or key order", () => {
    const reordered = source();
    reordered.pulls[0].labels = ["area: ui", "type: feature"];
    expect(inputDigest(reordered)).toBe(inputDigest(source()));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });

  it("changes gen with the model, the template or the Action major version", () => {
    const parts = {
      input: "x",
      persona: {},
      templates: { system: "s", persona: "p" },
      provider: "openai",
      model: "gpt-5-mini",
      maxCompletionTokens: 16384,
      render: {},
    };
    const base = generationDigest(parts);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(generationDigest({ ...parts, model: "gpt-5" })).not.toBe(base);
    expect(generationDigest({ ...parts, templates: { system: "s2", persona: "p" } })).not.toBe(
      base
    );
    expect(generationDigest({ ...parts, actionMajor: "2" })).not.toBe(base);
  });

  it("treats CRLF line endings as unedited", () => {
    expect(outputDigest("a\r\nb")).toBe(outputDigest("a\nb"));
  });
});

describe("planner: one test per row of the plan table", () => {
  it("release missing, createIfMissing false: skip with a notice", () => {
    const plan = planSink(release("", { exists: false }), request);
    expect(plan).toMatchObject({ action: "skip", needsText: false });
    expect(plan.notice).toMatch(/createIfMissing: true/);
  });

  it("release missing, createIfMissing true: create", () => {
    expect(planSink(release("", { exists: false, createIfMissing: true }), request)).toMatchObject({
      action: "create",
      needsText: true,
    });
  });

  it("target exists, no block, section mode: create, warning when the body is unmarked", () => {
    expect(planSink(release(""), request)).toEqual({ action: "create", needsText: true });
    const unmarked = planSink(release("Notes written by hand."), request);
    expect(unmarked.action).toBe("create");
    expect(unmarked.warning).toMatch(/adopt/);
    const otherPersona = planSink(release(block(TEXT, GEN, "customer")), request);
    expect(otherPersona).toEqual({ action: "create", needsText: true });
  });

  it("target exists, no block, replace mode: update the body", () => {
    expect(planSink(release("Old notes", { mode: "replace" }), request)).toMatchObject({
      action: "update",
      needsText: true,
    });
  });

  it("unmarked CHANGELOG entry for the version: skip-human or update", () => {
    const text = "# Changelog\n\n## [v1.4.0] - 2026-09-13\n\n- Hand-written\n";
    expect(hasUnmarkedEntry(text, KEY)).toBe(true);
    expect(planSink(changelog(text), request)).toMatchObject({ action: "skip-human" });
    expect(planSink(changelog(text, { onHumanEdit: "overwrite" }), request)).toMatchObject({
      action: "update",
      needsText: true,
    });
  });

  it("block exists and gen matches, or is adopted: noop", () => {
    expect(planSink(release(block()), request)).toMatchObject({ action: "noop", needsText: false });
    expect(planSink(release(block(TEXT, "adopted")), changed)).toMatchObject({ action: "noop" });
  });

  it("gen differs, block unedited: update", () => {
    expect(planSink(release(block()), changed)).toMatchObject({
      action: "update",
      needsText: true,
    });
  });

  it("gen differs, human edit, skip: skip-human with a warning", () => {
    const edited = block(TEXT, GEN, "engineer", outputDigest("something else"));
    const plan = planSink(release(edited), changed);
    expect(plan).toMatchObject({ action: "skip-human", needsText: false });
    expect(plan.warning).toMatch(/edited by hand/);
  });

  it("gen differs, human edit, overwrite: update", () => {
    const edited = block(TEXT, GEN, "engineer", outputDigest("something else"));
    expect(planSink(release(edited, { onHumanEdit: "overwrite" }), changed)).toMatchObject({
      action: "update",
    });
  });

  it("force: update unedited blocks, and edited ones only under overwrite", () => {
    const forced = { ...request, force: true };
    expect(planSink(release(block()), forced)).toMatchObject({ action: "update", needsText: true });
    const edited = block(TEXT, GEN, "engineer", outputDigest("something else"));
    expect(planSink(release(edited), forced)).toMatchObject({ action: "skip-human" });
    expect(planSink(release(edited, { onHumanEdit: "overwrite" }), forced)).toMatchObject({
      action: "update",
    });
  });
});

describe("stored text", () => {
  it("reuses a matching release block with no LLM call", () => {
    expect(findStoredText([release(block())], request)).toEqual({
      text: TEXT,
      from: "github-release",
    });
  });

  it("reuses a matching CHANGELOG block, shifted back to release headings", () => {
    const shifted = shiftHeadings(TEXT, 1);
    expect(findStoredText([changelog(block(shifted))], request)).toEqual({
      text: TEXT,
      from: "changelog",
    });
  });

  it("finds nothing for another gen, an edited block, or under force", () => {
    expect(findStoredText([release(block())], changed)).toBeNull();
    const edited = block(TEXT, GEN, "engineer", outputDigest("x"));
    expect(findStoredText([release(edited)], request)).toBeNull();
    expect(findStoredText([release(block())], { ...request, force: true })).toBeNull();
  });
});

describe("personas without a persisted sink", () => {
  it("are generated only without persisted sinks, when the primary changes, or under force", () => {
    expect(
      generatesUnpersisted({ persistedEnabled: false, primaryChanged: false, force: false })
    ).toBe(true);
    expect(
      generatesUnpersisted({ persistedEnabled: true, primaryChanged: true, force: false })
    ).toBe(true);
    expect(
      generatesUnpersisted({ persistedEnabled: true, primaryChanged: false, force: true })
    ).toBe(true);
    expect(
      generatesUnpersisted({ persistedEnabled: true, primaryChanged: false, force: false })
    ).toBe(false);
  });
});

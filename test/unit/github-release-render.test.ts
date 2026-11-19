import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  createRelease,
  generateCompareUrl,
  isSemverPrerelease,
  renderReleaseName,
  updateRelease,
} from "../../src/outputs/github-release/api";
import {
  CANONICAL_RENDER_OPTIONS,
  renderToMarkdown,
  shiftHeadings,
} from "../../src/core/render/markdown";

function fakeOctokit() {
  const updateRelease = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const createRelease = vi.fn().mockResolvedValue({ data: { id: 2 } });
  return {
    octokit: { rest: { repos: { updateRelease, createRelease } } } as unknown as Octokit,
    updateRelease,
    createRelease,
  };
}

describe("isSemverPrerelease", () => {
  it("does not treat a prefix as a pre-release", () => {
    expect(isSemverPrerelease("devtools-v1.2.0")).toBe(false);
    expect(isSemverPrerelease("next-v3.0.0")).toBe(false);
  });

  it("detects a SemVer pre-release component", () => {
    expect(isSemverPrerelease("v1.2.0-rc.1")).toBe(true);
    expect(isSemverPrerelease("devtools-v1.2.0-beta")).toBe(true);
    expect(isSemverPrerelease("1.2.0+build.5")).toBe(false);
  });
});

describe("updateRelease", () => {
  it("sends only the body", async () => {
    const { octokit, updateRelease: call } = fakeOctokit();
    await updateRelease(octokit, "o", "r", 42, "new body");
    expect(call).toHaveBeenCalledWith({ owner: "o", repo: "r", release_id: 42, body: "new body" });
  });
});

describe("createRelease", () => {
  it("sets prerelease from SemVer and name from the default template", async () => {
    const { octokit, createRelease: call } = fakeOctokit();
    await createRelease(octokit, "o", "r", "v2.0.0-beta.1", { body: "notes" });
    expect(call).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      tag_name: "v2.0.0-beta.1",
      name: "Release v2.0.0-beta.1",
      body: "notes",
      draft: false,
      prerelease: true,
    });
  });

  it("uses nameTemplate and keeps a stable tag as a full release", async () => {
    const { octokit, createRelease: call } = fakeOctokit();
    await createRelease(octokit, "o", "r", "devtools-v1.2.0", {
      body: "b",
      nameTemplate: "DevTools {{ tag }}",
      target_commitish: "abc123",
    });
    expect(call.mock.calls[0][0]).toMatchObject({
      name: "DevTools devtools-v1.2.0",
      prerelease: false,
      target_commitish: "abc123",
    });
  });

  it("rejects an unknown placeholder in nameTemplate", () => {
    expect(() => renderReleaseName("{{version}}", "v1")).toThrow("Unknown placeholder {{version}}");
  });
});

describe("compare links", () => {
  it("use the server URL", () => {
    expect(generateCompareUrl("https://ghe.example.com/", "o", "r", "v1", "v2")).toBe(
      "https://ghe.example.com/o/r/compare/v1...v2"
    );
    const md = renderToMarkdown(
      { highlights: [], sections: [] },
      {
        ...CANONICAL_RENDER_OPTIONS,
        repoFullName: "o/r",
        fromTag: "v1",
        toTag: "v2",
        serverUrl: "https://ghe.example.com",
      }
    );
    expect(md).toContain("(https://ghe.example.com/o/r/compare/v1...v2)");
  });
});

describe("shiftHeadings", () => {
  const md = [
    "## Features",
    "- item",
    "",
    "```md",
    "## not a heading",
    "```",
    "~~~",
    "# also not",
    "~~~",
    "### Sub",
    "#hashtag stays",
  ].join("\n");

  it("shifts headings and skips fenced code", () => {
    const shifted = shiftHeadings(md, 1);
    expect(shifted.split("\n")).toEqual([
      "### Features",
      "- item",
      "",
      "```md",
      "## not a heading",
      "```",
      "~~~",
      "# also not",
      "~~~",
      "#### Sub",
      "#hashtag stays",
    ]);
  });

  it("round-trips", () => {
    expect(shiftHeadings(shiftHeadings(md, 1), -1)).toBe(md);
  });
});

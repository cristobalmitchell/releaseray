import { describe, expect, it } from "vitest";
import {
  findMarkedBlocks,
  parseMarkerLine,
  writeBeginMarker,
  writeEndMarker,
  writeMarkedBlock,
  type MarkerFields,
} from "../../src/core/state/marker";
import { compareSemver, parseSemver } from "../../src/core/util/semver";
import { upsertChangelogEntry } from "../../src/outputs/changelog";

const fields = (key: string, gen = "3f1c9a07b2d4e815"): MarkerFields => ({
  key,
  persona: "engineer",
  gen,
  out: "9a07c3d1e6f2b408",
});

const HEADER =
  "# Changelog\n\nAll notable changes to this project will be documented in this file.";

describe("markers", () => {
  it("round-trip through write and parse byte for byte", () => {
    const begin =
      "<!-- releaseray:begin v=1 key=v1.4.0 persona=engineer gen=3f1c9a07b2d4e815 out=9a07c3d1e6f2b408 -->";
    const end = "<!-- releaseray:end key=v1.4.0 persona=engineer -->";
    const parsed = parseMarkerLine(begin);
    expect(parsed).toEqual({ type: "begin", version: 1, fields: fields("v1.4.0") });
    expect(writeBeginMarker(fields("v1.4.0"))).toBe(begin);
    expect(parseMarkerLine(end)).toEqual({ type: "end", key: "v1.4.0", persona: "engineer" });
    expect(writeEndMarker(fields("v1.4.0"))).toBe(end);

    const block = writeMarkedBlock(fields("v1.4.0"), "## Features\n\n- a");
    const [found] = findMarkedBlocks(`intro\n\n${block}\n\noutro`);
    expect(found.fields).toEqual(fields("v1.4.0"));
    expect(found.inner).toBe("## Features\n\n- a");
    expect(writeMarkedBlock(found.fields, found.inner)).toBe(block);
  });

  it("ignores a begin comment whose end comment was deleted", () => {
    const text = `${writeBeginMarker(fields("v1"))}\n\ntext\n\n${writeMarkedBlock(fields("v2"), "b")}`;
    expect(findMarkedBlocks(text).map((b) => b.fields.key)).toEqual(["v2"]);
  });

  it("rejects values that could break the comment", () => {
    expect(() => writeBeginMarker(fields("a b"))).toThrow();
    expect(() => writeBeginMarker(fields("x--y"))).toThrow();
  });
});

describe("upsertChangelogEntry", () => {
  const entry = (version: string, content = "### Features\n\n- New") => ({
    version,
    date: "2026-09-13",
    content,
  });

  it("replaces a marked entry for the same version, leaving other text unchanged", () => {
    const first = upsertChangelogEntry(
      `${HEADER}\n`,
      entry("v1.4.0", "### Fixes\n\n- old"),
      fields("v1.4.0", "aaaaaaaaaaaaaaaa")
    );
    const withHuman =
      first.content.replace(HEADER, `${HEADER}\n\nHand-written note.`) +
      "\n## [v1.3.0] - 2026-08-01\n\n- human text\n";
    const second = upsertChangelogEntry(
      withHuman,
      entry("v1.4.0", "### Fixes\n\n- new"),
      fields("v1.4.0", "bbbbbbbbbbbbbbbb")
    );
    expect(second.action).toBe("replaced");
    expect(second.content).toContain("- new");
    expect(second.content).not.toContain("- old");
    expect(second.content).toContain("gen=bbbbbbbbbbbbbbbb");
    expect(second.content.match(/## \[v1\.4\.0\]/g)).toHaveLength(1);
    expect(second.content).toContain("Hand-written note.");
    expect(second.content.endsWith("## [v1.3.0] - 2026-08-01\n\n- human text\n")).toBe(true);
  });

  it("leaves an unmarked entry for the same version unchanged, with a warning", () => {
    const existing = `${HEADER}\n\n## [v1.4.0] - 2026-09-13\n\n- written by hand\n`;
    const result = upsertChangelogEntry(existing, entry("v1.4.0"), fields("v1.4.0"));
    expect(result.action).toBe("skipped-unmarked");
    expect(result.content).toBe(existing);
    expect(result.warning).toContain("adopt");
  });

  it("overwrites an unmarked entry when onHumanEdit is overwrite", () => {
    const existing = `${HEADER}\n\n## [v1.4.0] - 2026-09-13\n\n- written by hand\n`;
    const result = upsertChangelogEntry(existing, entry("v1.4.0"), fields("v1.4.0"), {
      onHumanEdit: "overwrite",
    });
    expect(result.action).toBe("replaced");
    expect(result.content).not.toContain("written by hand");
  });

  it("inserts an older version below a newer one", () => {
    const existing = `${HEADER}\n\n## [v2.0.0] - 2026-10-01\n\n- two\n\n## [v1.0.0] - 2026-01-01\n\n- one\n`;
    const result = upsertChangelogEntry(existing, entry("v1.5.0"), fields("v1.5.0"));
    expect(result.content.match(/## \[[^\]]+\]/g)).toEqual([
      "## [v2.0.0]",
      "## [v1.5.0]",
      "## [v1.0.0]",
    ]);
  });

  it("puts a new entry directly below [Unreleased]", () => {
    const existing = `${HEADER}\n\n## [Unreleased]\n\n- wip\n\n## [v1.0.0] - 2026-01-01\n\n- one\n`;
    const result = upsertChangelogEntry(existing, entry("v1.1.0"), fields("v1.1.0"));
    expect(result.content.match(/## \[[^\]]+\]/g)).toEqual([
      "## [Unreleased]",
      "## [v1.1.0]",
      "## [v1.0.0]",
    ]);
    expect(result.content.indexOf("- wip")).toBeLessThan(
      result.content.indexOf("releaseray:begin")
    );
  });

  it("puts a non-SemVer key above the newest SemVer entry", () => {
    const existing = `${HEADER}\n\n## [v1.0.0] - 2026-01-01\n\n- one\n`;
    const result = upsertChangelogEntry(existing, entry("2026-W40"), fields("2026-W40"));
    expect(result.content.match(/## \[[^\]]+\]/g)).toEqual(["## [2026-W40]", "## [v1.0.0]"]);
  });

  it("appends the oldest version above trailing link references", () => {
    const existing = `${HEADER}\n\n## [v2.0.0] - 2026-10-01\n\n- two\n\n[v2.0.0]: https://example.com/compare\n`;
    const result = upsertChangelogEntry(existing, entry("v1.0.0"), fields("v1.0.0"));
    expect(result.content.trimEnd().endsWith("[v2.0.0]: https://example.com/compare")).toBe(true);
    expect(result.content.indexOf("## [v1.0.0]")).toBeGreaterThan(
      result.content.indexOf("## [v2.0.0]")
    );
  });

  it("is idempotent for the same marked entry", () => {
    const once = upsertChangelogEntry(`${HEADER}\n`, entry("v1.0.0"), fields("v1.0.0")).content;
    const twice = upsertChangelogEntry(once, entry("v1.0.0"), fields("v1.0.0")).content;
    expect(twice).toBe(once);
  });
});

describe("semver", () => {
  it("orders pre-releases below their release", () => {
    const v = (t: string) => parseSemver(t)!;
    expect(compareSemver(v("v1.0.0-rc.1"), v("v1.0.0"))).toBeLessThan(0);
    expect(compareSemver(v("1.0.0-alpha"), v("1.0.0-alpha.1"))).toBeLessThan(0);
    expect(compareSemver(v("1.0.0-alpha.beta"), v("1.0.0-beta"))).toBeLessThan(0);
    expect(compareSemver(v("1.0.0-beta.2"), v("1.0.0-beta.11"))).toBeLessThan(0);
    expect(compareSemver(v("v1.10.0"), v("v1.9.0"))).toBeGreaterThan(0);
    expect(parseSemver("2026-W40")).toBeNull();
  });
});

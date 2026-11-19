import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findHostedSdks, isHostedSdk } from "../../scripts/check-deps";
import {
  purityViolations,
  scanSource,
  scanTree,
  stripComments,
} from "../../scripts/check-boundary";

const fixtures = join(__dirname, "fixtures");
const repoRoot = join(__dirname, "..", "..");

function runScript(script: string, arg: string): number {
  try {
    execFileSync(process.execPath, ["--import", "tsx", join(repoRoot, "scripts", script), arg], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

describe("check-deps", () => {
  it("exits 1 for a lockfile containing bullmq", () => {
    expect(runScript("check-deps.ts", join(fixtures, "lock-bullmq", "pnpm-lock.yaml"))).toBe(1);
  });

  it("exits 0 for a lockfile without hosted SDKs", () => {
    expect(runScript("check-deps.ts", join(fixtures, "lock-clean", "pnpm-lock.yaml"))).toBe(0);
  });

  it("matches names, scopes and prefixes but not look-alikes", () => {
    expect(isHostedSdk("next")).toBe(true);
    expect(isHostedSdk("@prisma/client")).toBe(true);
    expect(isHostedSdk("@vercel/blob")).toBe(true);
    expect(isHostedSdk("posthog-js")).toBe(true);
    expect(isHostedSdk("nextra-like")).toBe(false);
    expect(isHostedSdk("@octokit/rest")).toBe(false);
  });

  it("reads quoted scoped keys", () => {
    expect(findHostedSdks("packages:\n\n  '@sentry/node@8.0.0':\n    resolution: {}\n")).toEqual([
      "@sentry/node",
    ]);
  });
});

describe("purity check", () => {
  it("fails on a process.env read under src/core", () => {
    const violations = scanTree(join(fixtures, "purity"));
    expect(purityViolations(violations)).toEqual([
      { file: "src/core/reads-env.ts", line: 2, kind: "process-env" },
    ]);
    expect(runScript("check-boundary.ts", join(fixtures, "purity"))).toBe(1);
  });

  it("ignores process.env in comments", () => {
    expect(scanSource("src/core/a.ts", "/** no process.env here */\n// process.env\n")).toEqual([]);
  });
});

describe("check-boundary", () => {
  it("fails when src/core imports @actions/core", () => {
    expect(scanTree(join(fixtures, "boundary-core"))).toEqual([
      { file: "src/core/uses-actions.ts", line: 1, kind: "actions-import" },
    ]);
    expect(runScript("check-boundary.ts", join(fixtures, "boundary-core"))).toBe(1);
  });

  it("passes when only src/action imports @actions/* and reads process.env", () => {
    expect(scanTree(join(fixtures, "boundary-action"))).toEqual([]);
    expect(runScript("check-boundary.ts", join(fixtures, "boundary-action"))).toBe(0);
  });

  it("catches dynamic imports, require and subpaths", () => {
    const source = [
      'const a = await import("@actions/github");',
      'const b = require("@actions/core");',
      'import "@actions/core/lib/summary";',
    ].join("\n");
    expect(scanSource("src/outputs/x.ts", source).map((v) => v.line)).toEqual([1, 2, 3]);
  });

  it("keeps URLs while stripping comments", () => {
    expect(stripComments('const u = "https://example.com"; // note')).toBe(
      'const u = "https://example.com"; '
    );
  });
});

describe("vitest setup", () => {
  it("sets no environment variables", async () => {
    const { readFileSync } = await import("node:fs");
    const setup = stripComments(readFileSync(join(repoRoot, "vitest.setup.ts"), "utf8"));
    expect(setup).not.toMatch(/process\s*\.\s*env|vi\.stubEnv/);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../../src/config/load";
import { jsonSchemaErrors } from "../helpers/json-schema";

const ROOT = join(__dirname, "..", "..");
/** Our own Action: `@v1` before the first release, then a full SHA (scripts/pin-examples.ts). */
const SELF = "cristobalmitchell/releaseray@";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  permissions?: unknown;
  jobs: Record<string, Job>;
}

const actionInputs = Object.keys(
  (parse(readFileSync(join(ROOT, "action.yml"), "utf8")) as { inputs: Record<string, unknown> })
    .inputs
);

const files = ["workflows", "recipes"].flatMap((dir) =>
  readdirSync(join(ROOT, "examples", dir))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => join("examples", dir, f))
);

describe("example workflows and recipes", () => {
  it("covers every documented flow and recipe", () => {
    expect(files.sort()).toEqual(
      [
        "examples/recipes/app-token.yml",
        "examples/recipes/artifact.yml",
        "examples/recipes/changelog-pr.yml",
        "examples/workflows/in-release-job-dispatch.yml",
        "examples/workflows/in-release-job.yml",
        "examples/workflows/release-notes-hardened.yml",
        "examples/workflows/release-notes-on-tag.yml",
        "examples/workflows/release-notes-preview.yml",
        "examples/workflows/release-notes.yml",
        "examples/workflows/releaseray-tools.yml",
      ].sort()
    );
  });

  for (const file of files) {
    describe(file, () => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const workflow = parse(text) as Workflow;
      const jobs = Object.entries(workflow.jobs);

      it("grants nothing at workflow level and least privilege per job", () => {
        expect(workflow.permissions).toEqual({});
        for (const [, job] of jobs) expect(job.permissions, "job permissions").toBeDefined();
      });

      it("runs on ubuntu-latest with a timeout of at most 20 minutes (60 for paced adopt)", () => {
        for (const [name, job] of jobs) {
          expect(job["runs-on"]).toBe("ubuntu-latest");
          expect(job["timeout-minutes"]).toBeGreaterThan(0);
          // adopt paces up to 400 release writes 7.2 seconds apart (CONVERSION-PLAN §5.7).
          const paced = file.endsWith("releaseray-tools.yml") && name === "migrate";
          expect(job["timeout-minutes"], name).toBeLessThanOrEqual(paced ? 60 : 20);
        }
      });

      it("pins every third-party action to a full commit SHA with its version", () => {
        for (const line of text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) {
          const ref = line.replace(/^\s*-?\s*uses:\s*/, "");
          if (ref.startsWith(SELF)) continue;
          expect(ref, line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
        }
      });

      it("passes only declared inputs to ReleaseRay", () => {
        const steps = jobs.flatMap(([, job]) => job.steps).filter((s) => s.uses?.startsWith(SELF));
        expect(steps.length).toBeGreaterThan(file.includes("dispatch") ? -1 : 0);
        for (const step of steps) {
          for (const key of Object.keys(step.with ?? {})) expect(actionInputs, key).toContain(key);
        }
      });

      it("never interpolates expressions into run scripts", () => {
        for (const [, job] of jobs) {
          for (const step of job.steps) {
            if (step.run) expect(step.run, step.run).not.toContain("${{");
          }
        }
      });
    });
  }
});

describe("examples/config/releaseray.yml", () => {
  it("passes validate-config and the JSON Schema", () => {
    const text = readFileSync(join(ROOT, "examples/config/releaseray.yml"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# yaml-language-server: \$schema=/);
    expect(jsonSchemaErrors(parse(text))).toEqual([]);
    const loaded = loadConfig({ workspace: ROOT, path: "examples/config/releaseray.yml" });
    expect(loaded.personas.map((p) => p.id)).toEqual(["engineer", "internal", "customer", "sales"]);
  });
});

describe("pin-examples", () => {
  it("pins every reference to the release SHA and tag, and is idempotent", async () => {
    const { pinText, referencingFiles } = await import("../../scripts/pin-examples");
    const sha = "a".repeat(40);
    const text =
      "uses: cristobalmitchell/releaseray@v1 # pin to the full commit SHA of the release you use\n" +
      "      - uses: cristobalmitchell/releaseray@v1\n";
    const pinned = pinText(text, sha, "v1.0.0");
    expect(pinned.count).toBe(2);
    expect(pinned.text).toBe(
      `uses: cristobalmitchell/releaseray@${sha} # v1.0.0\n      - uses: cristobalmitchell/releaseray@${sha} # v1.0.0\n`
    );
    expect(pinText(pinned.text, sha, "v1.0.0").text).toBe(pinned.text);
    expect(referencingFiles()).toContain("README.md");
    expect(referencingFiles().filter((f) => f.startsWith("examples/"))).toHaveLength(10);
  });
});

/**
 * Reads the README's quickstart workflow and starter config, so the
 * quickstart scenario follows exactly what a new user copies.
 */
import { parse } from "yaml";

/** The ReleaseRay step of the quickstart workflow. */
export interface QuickstartStep {
  with: Record<string, string>;
  env: Record<string, string>;
}

function yamlBlockAfter(readme: string, heading: string): string {
  const at = readme.indexOf(`\n${heading}\n`);
  if (at === -1) throw new Error(`README has no "${heading}" section`);
  const m = /```yaml\n([\s\S]*?)```/.exec(readme.slice(at));
  if (!m) throw new Error(`No YAML block under "${heading}"`);
  return m[1];
}

/**
 * The starter config, as printed under "## Starter config".
 *
 * @param readme - README text
 * @returns The YAML text
 */
export function starterConfig(readme: string): string {
  return yamlBlockAfter(readme, "## Starter config");
}

/**
 * The ReleaseRay step of the workflow under "## Quickstart".
 *
 * @param readme - README text
 * @returns Its `with` and `env`
 */
export function quickstartStep(readme: string): QuickstartStep {
  const workflow = parse(yamlBlockAfter(readme, "## Quickstart")) as {
    jobs: Record<
      string,
      {
        steps: Array<{
          uses?: string;
          with?: Record<string, unknown>;
          env?: Record<string, unknown>;
        }>;
      }
    >;
  };
  const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);
  const step = steps.find((s) => s.uses?.startsWith("cristobalmitchell/releaseray@"));
  if (!step) throw new Error("The quickstart workflow has no ReleaseRay step");
  const strings = (o: Record<string, unknown> = {}) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
  return { with: strings(step.with), env: strings(step.env) };
}

/** The expressions the quickstart uses, and their values on a `release: published` event. */
const ON_RELEASE: Record<string, (tag: string) => string> = {
  "${{ github.event.release.tag_name || inputs.to }}": (tag) => tag,
  "${{ github.event_name == 'release' || inputs.publish }}": () => "true",
};

/**
 * The step's inputs on a published release. Throws on any expression it
 * does not know, so a change to the README's workflow fails the scenario
 * instead of passing unnoticed.
 *
 * @param step - The quickstart step
 * @param tag - The release's tag
 * @returns Input values
 */
export function inputsOnRelease(step: QuickstartStep, tag: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(step.with).map(([name, value]) => {
      if (!value.includes("${{")) return [name, value];
      const evaluate = ON_RELEASE[value];
      if (!evaluate) throw new Error(`Unknown expression in the quickstart: ${name}: ${value}`);
      return [name, evaluate(tag)];
    })
  );
}

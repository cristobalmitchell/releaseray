/**
 * Pins every `uses: cristobalmitchell/releaseray@…` in the README and the
 * examples to a release's full commit SHA, for the docs pull request that
 * follows a release.
 *
 * Usage: tsx scripts/pin-examples.ts <tag>   (for example v1.0.0)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that reference the Action. */
export function referencingFiles(root = ROOT): string[] {
  const yml = (dir: string) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith(".yml"))
      .map((f) => join(dir, f));
  return ["README.md", ...yml("examples/workflows"), ...yml("examples/recipes")];
}

/**
 * Rewrites the Action references in one text.
 *
 * @param text - File content
 * @param sha - Full commit SHA of the release
 * @param tag - The release tag, written as the trailing comment
 * @returns The rewritten text and how many references changed
 */
export function pinText(text: string, sha: string, tag: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/cristobalmitchell\/releaseray@[\w.-]+(?:[ \t]+#[^\n]*)?/g, () => {
    count++;
    return `cristobalmitchell/releaseray@${sha} # ${tag}`;
  });
  return { text: out, count };
}

function main(): void {
  const tag = process.argv[2];
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error("Usage: tsx scripts/pin-examples.ts vX.Y.Z");
    process.exit(2);
  }
  const sha = execFileSync("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  for (const file of referencingFiles()) {
    const path = join(ROOT, file);
    const { text, count } = pinText(readFileSync(path, "utf8"), sha, tag);
    if (count > 0) {
      writeFileSync(path, text);
      console.log(`${file}: ${count} reference(s) pinned to ${sha} (${tag})`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

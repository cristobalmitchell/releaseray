/**
 * Builds the single-file bundle `dist/action.js` and `dist/licenses.txt`,
 * the license text of every bundled package. CI rebuilds and fails when the
 * committed `dist/` differs.
 *
 * Usage: tsx scripts/build.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

/** The package directory and name for a bundled input path, or null for our own sources. */
function packageOf(input: string): { dir: string; name: string } | null {
  const marker = "node_modules/";
  const at = input.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = input.slice(at + marker.length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return { dir: join(ROOT, input.slice(0, at + marker.length), name), name };
}

function licenseText(dir: string): string {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  return file ? readFileSync(join(dir, file), "utf8").trim() : "(no license file in the package)";
}

const result = await build({
  entryPoints: [join(ROOT, "src", "action", "index.ts")],
  outfile: join(DIST, "action.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // CommonJS dependencies inside an ES module bundle still call require().
  banner: {
    js: 'import { createRequire as __releaserayCreateRequire } from "node:module";\nconst require = __releaserayCreateRequire(import.meta.url);',
  },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const packages = new Map<string, { dir: string; version: string; license: string }>();
for (const input of Object.keys(result.metafile.inputs)) {
  const pkg = packageOf(input);
  if (!pkg || packages.has(pkg.name) || !existsSync(join(pkg.dir, "package.json"))) continue;
  const meta = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8")) as {
    version?: string;
    license?: string;
  };
  packages.set(pkg.name, {
    dir: pkg.dir,
    version: meta.version ?? "",
    license: meta.license ?? "",
  });
}

mkdirSync(DIST, { recursive: true });
const sections = [...packages.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([name, p]) => `${name}@${p.version}\n${p.license}\n\n${licenseText(p.dir)}`);
writeFileSync(
  join(DIST, "licenses.txt"),
  `Licenses of the packages bundled into dist/action.js.\n\n${sections.join("\n\n-----\n\n")}\n`
);
console.log(`Bundled ${packages.size} packages into dist/action.js`);

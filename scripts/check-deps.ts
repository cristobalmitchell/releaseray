/**
 * Fails when the lockfile contains an SDK of the hosted product's services.
 *
 * The Action runs on the user's runner and talks only to GitHub and the user's
 * LLM provider, so none of these packages may ever be installed
 * (CONVERSION-PLAN §10.6).
 *
 * Usage: tsx scripts/check-deps.ts [path/to/pnpm-lock.yaml]
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Exact package names that must not appear. */
const FORBIDDEN_NAMES = new Set(["bullmq", "ioredis", "next", "resend", "stripe"]);

/** Package scopes or name prefixes that must not appear. */
const FORBIDDEN_PREFIXES = ["@prisma/", "@supabase/", "@sentry/", "@vercel/", "posthog-"];

/**
 * Returns true when a package name belongs to the hosted product's stack.
 *
 * @param name - An npm package name such as `@prisma/client` or `zod`
 * @returns Whether the package is forbidden
 */
export function isHostedSdk(name: string): boolean {
  return FORBIDDEN_NAMES.has(name) || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Lists the forbidden packages named in a pnpm lockfile.
 *
 * Reads package keys such as `  bullmq@5.1.9:` or `  '@prisma/client@5.0.0(...)':`
 * from the `packages` and `snapshots` sections, and importer dependency names.
 *
 * @param lockText - The contents of `pnpm-lock.yaml`
 * @returns Sorted, de-duplicated forbidden package names
 */
export function findHostedSdks(lockText: string): string[] {
  const found = new Set<string>();
  const keyPattern = /^\s+'?((?:@[^/@\s']+\/)?[^@\s'/:]+)@/;
  const importerDepPattern = /^\s{6}'?((?:@[^/@\s']+\/)?[^@\s'/:]+)'?:\s*$/;
  for (const line of lockText.split("\n")) {
    const name = keyPattern.exec(line)?.[1] ?? importerDepPattern.exec(line)?.[1];
    if (name && isHostedSdk(name)) found.add(name);
  }
  return [...found].sort();
}

/**
 * CLI entry: prints forbidden packages and returns the exit code.
 *
 * @param lockPath - Path to the lockfile
 * @returns 0 when clean, 1 when a forbidden package is present
 */
export function main(lockPath = "pnpm-lock.yaml"): number {
  const hosted = findHostedSdks(readFileSync(lockPath, "utf8"));
  if (hosted.length === 0) {
    console.log(`check-deps: ${lockPath} contains no hosted-product SDK`);
    return 0;
  }
  console.error(`check-deps: ${lockPath} contains hosted-product SDKs:`);
  for (const name of hosted) console.error(`  - ${name}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv[2]));
}

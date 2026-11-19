/**
 * SemVer parsing and precedence for tags such as `v1.2.0`, `1.2.0-rc.1` or
 * `devtools-v1.2.0`.
 *
 * @see https://semver.org/#spec-item-11
 */

export interface SemverVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers; empty for a release */
  prerelease: string[];
}

const SEMVER =
  /^(?:.*?[-_/@])?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * Parses the SemVer version at the end of a tag, after an optional prefix.
 *
 * @param tag - Tag or version string
 * @returns The version, or null when the tag holds none
 */
export function parseSemver(tag: string): SemverVersion | null {
  const match = SEMVER.exec(tag.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two versions by SemVer precedence.
 *
 * @param a - First version
 * @param b - Second version
 * @returns Negative when a < b, zero when equal, positive when a > b
 */
export function compareSemver(a: SemverVersion, b: SemverVersion): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] - b[field];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // A release outranks any of its pre-releases.
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const diff = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

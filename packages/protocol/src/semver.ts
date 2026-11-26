/**
 * Pure SemVer comparison helper for update checks and version-mismatch detection.
 * Supports optional leading "v" and prerelease suffixes (e.g. "2.3.2-rc.1").
 */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(raw: string): ParsedSemver | null {
  const m = raw.trim().match(SEMVER_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  };
}

/**
 * Compares two semver strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal (or unparseable).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease) return 1; // stable > prerelease
  if (!pb.prerelease) return -1;
  return pa.prerelease > pb.prerelease ? 1 : -1;
}

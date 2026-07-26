/**
 * Minimal semver parsing / comparison / range satisfaction (issue #585).
 *
 * Campaign modules carry a semver `version` and a `compatibility` range, so both the
 * server and the web app need to answer "does 1.4.0 satisfy ^1.2.0?" without pulling a
 * runtime dependency into `@campfire/schema` (which is imported by the browser bundle).
 *
 * Supported version grammar: `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]` with numeric-only
 * MAJOR/MINOR/PATCH. Build metadata is parsed and then IGNORED for ordering, per semver.
 *
 * Supported range grammar (deliberately a subset — enough for a module compatibility
 * contract, small enough to be exhaustively testable):
 *   - `*` / `` (empty) / `x`      — any version
 *   - `1.2.3`  / `=1.2.3`         — exact
 *   - `>1.2.3` `>=1.2.3` `<2.0.0` `<=1.9.9`
 *   - `^1.2.3`                    — compatible-with: >=1.2.3 <2.0.0 (and for 0.x: >=0.2.3 <0.3.0)
 *   - `~1.2.3`                    — approximately: >=1.2.3 <1.3.0
 *   - space-separated comparators are ANDed:  `>=1.2.0 <2.0.0`
 *   - `||` separates alternatives (ORed):     `^1.0.0 || ^2.0.0`
 *
 * Anything unparseable is reported as such rather than silently treated as "matches";
 * callers surface an explicit compatibility warning instead of guessing.
 */

export type Semver = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, or [] for a release version. */
  prerelease: readonly (string | number)[];
  /** Build metadata identifiers; parsed for round-tripping, never used for ordering. */
  build: readonly string[];
};

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** Parse a strict semver string, or null when it is not valid semver. */
export function parseSemver(input: string): Semver | null {
  if (typeof input !== 'string') return null;
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, pre, build] = match;
  // Leading zeros are not valid semver numeric identifiers (except "0" itself).
  for (const part of [major, minor, patch]) {
    if (part.length > 1 && part.startsWith('0')) return null;
  }
  const prerelease: (string | number)[] = [];
  if (pre != null && pre.length > 0) {
    for (const id of pre.split('.')) {
      if (id.length === 0) return null;
      if (/^\d+$/.test(id)) {
        if (id.length > 1 && id.startsWith('0')) return null;
        prerelease.push(Number(id));
      } else {
        prerelease.push(id);
      }
    }
  }
  const buildIds = build != null && build.length > 0 ? build.split('.') : [];
  if (buildIds.some((id) => id.length === 0)) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
    build: buildIds,
  };
}

export function isValidSemver(input: string): boolean {
  return parseSemver(input) != null;
}

export function formatSemver(v: Semver): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : '';
  const build = v.build.length > 0 ? `+${v.build.join('.')}` : '';
  return `${core}${pre}${build}`;
}

function comparePrerelease(a: Semver['prerelease'], b: Semver['prerelease']): number {
  // A version WITHOUT a prerelease outranks one with (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // shorter set of identifiers sorts first
    if (y === undefined) return 1;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) {
      if (x !== y) return (x as number) < (y as number) ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return (x as string) < (y as string) ? -1 : 1;
  }
  return 0;
}

/** -1 / 0 / 1 ordering of two parsed semvers (build metadata ignored). */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Compare two version STRINGS; unparseable inputs sort last (and equal to each other). */
export function compareVersionStrings(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) return compareSemver(pa, pb);
  if (pa) return -1;
  if (pb) return 1;
  return 0;
}

type Comparator = { op: '<' | '<=' | '>' | '>=' | '='; version: Semver };

function anyVersionToken(token: string): boolean {
  return token === '' || token === '*' || token === 'x' || token === 'X';
}

/** Expand one range token into the comparators it implies, or null when unparseable. */
function parseComparatorToken(token: string): Comparator[] | null {
  if (anyVersionToken(token)) return [];
  if (token.startsWith('^') || token.startsWith('~')) {
    const base = parseSemver(token.slice(1));
    if (!base) return null;
    let upper: Semver;
    if (token.startsWith('~')) {
      upper = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [], build: [] };
    } else if (base.major > 0) {
      upper = { major: base.major + 1, minor: 0, patch: 0, prerelease: [], build: [] };
    } else if (base.minor > 0) {
      // 0.x is treated as unstable: ^0.2.3 allows patches, not 0.3.0.
      upper = { major: 0, minor: base.minor + 1, patch: 0, prerelease: [], build: [] };
    } else {
      upper = { major: 0, minor: 0, patch: base.patch + 1, prerelease: [], build: [] };
    }
    return [
      { op: '>=', version: base },
      { op: '<', version: upper },
    ];
  }
  const opMatch = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!opMatch) return null;
  const op = (opMatch[1] ?? '=') as Comparator['op'];
  const version = parseSemver(opMatch[2]);
  if (!version) return null;
  return [{ op, version }];
}

export type SemverRange = {
  /** Each alternative is a conjunction of comparators; the range matches if ANY alternative matches. */
  alternatives: Comparator[][];
};

/** Parse a range expression, or null when any token is unparseable. */
export function parseSemverRange(input: string): SemverRange | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (anyVersionToken(raw)) return { alternatives: [[]] };
  const alternatives: Comparator[][] = [];
  for (const alt of raw.split('||')) {
    const conjunction: Comparator[] = [];
    for (const token of alt.trim().split(/\s+/)) {
      const parsed = parseComparatorToken(token.trim());
      if (parsed == null) return null;
      conjunction.push(...parsed);
    }
    alternatives.push(conjunction);
  }
  return { alternatives };
}

function satisfiesComparator(version: Semver, cmp: Comparator): boolean {
  const c = compareSemver(version, cmp.version);
  switch (cmp.op) {
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '=':
    default:
      return c === 0;
  }
}

/**
 * Does `version` satisfy `range`?
 *
 * Returns `false` (never throws) when either side is unparseable — use
 * {@link parseSemver} / {@link parseSemverRange} first when you need to tell
 * "does not match" apart from "is not a valid range".
 *
 * Prerelease policy: a prerelease version only satisfies a comparator set when at
 * least one comparator names the same major.minor.patch tuple, mirroring npm semver.
 * That keeps `1.0.0-rc.1` out of `^0.9.0 || >=0.5.0` style ranges by accident.
 */
export function satisfiesSemverRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  const r = parseSemverRange(range);
  if (!v || !r) return false;
  return r.alternatives.some((conjunction) => {
    if (!conjunction.every((cmp) => satisfiesComparator(v, cmp))) return false;
    if (v.prerelease.length === 0) return true;
    if (conjunction.length === 0) return true;
    return conjunction.some(
      (cmp) =>
        cmp.version.prerelease.length > 0 &&
        cmp.version.major === v.major &&
        cmp.version.minor === v.minor &&
        cmp.version.patch === v.patch,
    );
  });
}

/** 'upgrade' | 'downgrade' | 'same' for a version transition (unparseable => 'unknown'). */
export function semverTransition(from: string, to: string): 'upgrade' | 'downgrade' | 'same' | 'unknown' {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return 'unknown';
  const c = compareSemver(a, b);
  if (c < 0) return 'upgrade';
  if (c > 0) return 'downgrade';
  return 'same';
}

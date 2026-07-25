/**
 * Session-zero charter editor helpers (issue #641).
 */

export type SessionZeroCharterDraft = {
  lines: string[];
  veils: string[];
  safetyTools: string[];
  houseRules: string;
  toneAndExpectations: string;
};

export function isSessionZeroCharterDirty(
  draft: SessionZeroCharterDraft,
  baseline: SessionZeroCharterDraft,
): boolean {
  return !sessionZeroCharterDraftsEqual(draft, baseline);
}

export function sessionZeroCharterDraftsEqual(
  a: SessionZeroCharterDraft,
  b: SessionZeroCharterDraft,
): boolean {
  return (
    a.houseRules === b.houseRules &&
    a.toneAndExpectations === b.toneAndExpectations &&
    stringArraysEqual(a.lines, b.lines) &&
    stringArraysEqual(a.veils, b.veils) &&
    stringArraysEqual(a.safetyTools, b.safetyTools)
  );
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

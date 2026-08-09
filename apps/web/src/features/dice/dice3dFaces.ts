/**
 * Face-numbering for the 3D dice roll (from the design project's `dice3d.js`).
 *
 * Split out of dice3d.ts because it is pure integer bookkeeping with no three.js
 * dependency: the physics decides WHICH face lands up, and these functions decide
 * which number is painted on it. Keeping them here lets the unit tier test the
 * part that actually encodes a rule (the rolled value must end up on the landing
 * face, and a d6's opposite faces must still sum to 7) without a WebGL context.
 */

/**
 * Numbers for every face of a non-d6 die, with `value` moved onto `upIdx` — the
 * face the recorded throw comes to rest on. The number that was already there
 * swaps into the slot `value` vacated, so each face still carries a distinct
 * number.
 */
export function faceValues(
  sides: number,
  value: number,
  upIdx: number,
  faceCount: number,
): number[] {
  const count = faceCount || sides;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((i % sides) + 1);
  const at = out.indexOf(value);
  if (upIdx >= 0 && upIdx < count && at >= 0) {
    out[at] = out[upIdx];
    out[upIdx] = value;
  }
  return out;
}

/**
 * Pip counts for a d6's six box faces in three.js material order
 * (+x, -x, +y, -y, +z, -z), with `value` on `upIdx`. Opposite faces are adjacent
 * in that order, so the 7-sum pairing a real die has is preserved: the face
 * across from the landing face gets `7 - value`, and the two remaining pairs are
 * filled from whichever of [1,6] / [2,5] / [3,4] is still unused.
 */
export function d6Values(value: number, upIdx: number): number[] {
  const out: (number | null)[] = [null, null, null, null, null, null];
  const opp = upIdx % 2 === 0 ? upIdx + 1 : upIdx - 1;
  out[upIdx] = value;
  out[opp] = 7 - value;
  const pairs = [
    [1, 6],
    [2, 5],
    [3, 4],
  ].filter((p) => p.indexOf(value) < 0 && p.indexOf(7 - value) < 0);
  for (let i = 0, k = 0; i < 6; i += 2) {
    if (out[i] != null) continue;
    const p = pairs[k++] || [2, 5];
    out[i] = p[0];
    out[i + 1] = p[1];
  }
  return out as number[];
}

import { expect, test } from '@playwright/test';
import { d6Values, faceValues } from '../../src/features/dice/dice3dFaces';

/**
 * The 3D roll records the throw first and then paints numbers onto the faces, so
 * the rolled value showing face-up is a property of THIS numbering, not of the
 * physics. If these break, a d20 lands showing something other than what the
 * server rolled — a silent, wrong result rather than a visual glitch.
 */

const POLY: { sides: number; faces: number }[] = [
  { sides: 4, faces: 4 },
  { sides: 8, faces: 8 },
  { sides: 10, faces: 10 },
  { sides: 12, faces: 12 },
  { sides: 20, faces: 20 },
];

test.describe('faceValues', () => {
  test('puts the rolled value on the landing face for every die and every face', () => {
    for (const { sides, faces } of POLY) {
      for (let value = 1; value <= sides; value++) {
        for (let upIdx = 0; upIdx < faces; upIdx++) {
          const out = faceValues(sides, value, upIdx, faces);
          expect(
            out[upIdx],
            `d${sides} value ${value} on face ${upIdx}`,
          ).toBe(value);
        }
      }
    }
  });

  test('keeps every face distinct — no number appears twice', () => {
    for (const { sides, faces } of POLY) {
      for (let value = 1; value <= sides; value++) {
        const out = faceValues(sides, value, (value * 3) % faces, faces);
        expect(out).toHaveLength(faces);
        expect([...out].sort((a, b) => a - b)).toEqual(
          Array.from({ length: sides }, (_, i) => i + 1),
        );
      }
    }
  });

  test('leaves the numbering untouched when the landing face is out of range', () => {
    expect(faceValues(20, 7, 20, 20)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(faceValues(20, 7, -1, 20)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

test.describe('d6Values', () => {
  test('puts the rolled pip count on the landing face', () => {
    for (let value = 1; value <= 6; value++) {
      for (let upIdx = 0; upIdx < 6; upIdx++) {
        expect(d6Values(value, upIdx)[upIdx], `${value} on face ${upIdx}`).toBe(value);
      }
    }
  });

  test('keeps opposite faces summing to 7, like a real die', () => {
    for (let value = 1; value <= 6; value++) {
      for (let upIdx = 0; upIdx < 6; upIdx++) {
        const out = d6Values(value, upIdx);
        // three's box material order is +x, -x, +y, -y, +z, -z — opposite faces
        // are the adjacent pairs (0,1), (2,3), (4,5).
        for (let i = 0; i < 6; i += 2) {
          expect(out[i] + out[i + 1], `pair ${i} of ${value}@${upIdx}`).toBe(7);
        }
        expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      }
    }
  });
});

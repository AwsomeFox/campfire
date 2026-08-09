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

  test('a d100 shows its result even though the solid has only ten faces', () => {
    // The server accepts d100 and the dice tray offers it, but no solid carries a
    // hundred faces — it is thrown on the ten-face percentile die. 90 of the 100
    // results are therefore absent from the base 1..10 numbering, and writing the
    // result onto the landing face is the only thing that keeps the die honest.
    for (let value = 1; value <= 100; value++) {
      for (let upIdx = 0; upIdx < 10; upIdx++) {
        expect(faceValues(100, value, upIdx, 10)[upIdx], `d100 ${value}@${upIdx}`).toBe(value);
      }
    }
  });

  test('a d2 shows its result on whatever solid it is thrown on', () => {
    // d2 is typeable (the server allows it) but absent from the tray, so it falls
    // through to the twenty-face solid numbered 1,2,1,2,…
    for (let value = 1; value <= 2; value++) {
      for (let upIdx = 0; upIdx < 20; upIdx++) {
        expect(faceValues(2, value, upIdx, 20)[upIdx], `d2 ${value}@${upIdx}`).toBe(value);
      }
    }
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

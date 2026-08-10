/**
 * Map-object resize math (issue #2175). The drag-grip size computation lives in
 * `mapRenderedBounds` alongside the other shared map math so the overlay's live preview and
 * BattleMap's committed PATCH read byte-identical values. Pure-logic (no React, no browser).
 */
import { expect, test } from '@playwright/test';
import { mapObjectSizeFromDrag, type Rect } from '../../src/features/encounters/mapRenderedBounds';

const RECT: Rect = { left: 0, top: 0, width: 1000, height: 800 };

test.describe('mapObjectSizeFromDrag (issue #2175)', () => {
  test('size is twice the pointer radius, as a percent of the map width', () => {
    // Centre (50,50) → layerPx (500,400); pointer 100px east → radius 100px → 2*100/1000*100 = 20%.
    expect(mapObjectSizeFromDrag({ x: 50, y: 50 }, { x: 60, y: 50 }, RECT)).toBe(20);
    // Pointer 50px east → radius 50px → 10%.
    expect(mapObjectSizeFromDrag({ x: 50, y: 50 }, { x: 55, y: 50 }, RECT)).toBe(10);
  });

  test('uses Euclidean layer-px distance — a 3-4-5 diagonal and an equal-length axial drag give the same size', () => {
    // Centre (50,50) → layerPx (500,400) on a 1000x800 map.
    // Axial: 100px east → pointer (60,50) → (600,400) → radius 100 → size 20 (covered above).
    // Diagonal 3-4-5: 60px east + 80px south → pointer (56,60) → (560,480) → radius hypot(60,80)=100 → size 20.
    expect(mapObjectSizeFromDrag({ x: 50, y: 50 }, { x: 56, y: 60 }, RECT)).toBe(20);
  });

  test('clamps to the schema [1, 100] bounds', () => {
    // A near-zero drag rounds down to the minimum of 1 (never 0 — the object must stay visible).
    expect(mapObjectSizeFromDrag({ x: 50, y: 50 }, { x: 50.001, y: 50 }, RECT)).toBe(1);
    // A drag past the opposite corner clamps to the maximum of 100.
    expect(mapObjectSizeFromDrag({ x: 50, y: 50 }, { x: 0, y: 0 }, RECT)).toBe(100);
  });

  test('rounds to one decimal so the live preview and the committed PATCH match', () => {
    // Centre (0,0) → layerPx (0,0); pointer (12.3,0) → 123px radius → 24.6%.
    expect(mapObjectSizeFromDrag({ x: 0, y: 0 }, { x: 12.3, y: 0 }, RECT)).toBe(24.6);
  });

  test('returns the default (5) for a degenerate map rect instead of NaN', () => {
    expect(mapObjectSizeFromDrag({ x: 50, y: 50 }, { x: 60, y: 50 }, null)).toBe(5);
    expect(mapObjectSizeFromDrag({ x: 50, y: 50 }, { x: 60, y: 50 }, { left: 0, top: 0, width: 0, height: 0 })).toBe(5);
  });
});

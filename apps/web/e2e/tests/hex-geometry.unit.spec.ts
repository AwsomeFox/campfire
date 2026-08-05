/**
 * Hex grid geometry (issue #467).
 *
 * Pure unit tests for axial/cube conversions, hex-center snapping, hex-aware distance,
 * footprints, and overlay parity with the shared hexGeometry module.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  axialRound,
  hexDistance,
  hexPolygons,
  hexesInRadius,
  mapPercentGridDistance,
  mapPercentToAxial,
  snapLayerPxToHex,
  snapMapPercentToHex,
  tokenHexRadius,
} from '../../src/features/encounters/hexGeometry';
import {
  calibrationToPx,
  computeContainedRect,
  mapPercentToLayerPx,
  resolveGridCalibration,
} from '../../src/features/encounters/mapRenderedBounds';
import { DEFAULT_GRID_DISTANCE_RULE } from '@campfire/schema';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');
const SURFACE = { w: 800, h: 600 };
const SQUARE = { w: 1000, h: 1000 };

test.describe('hex axial math (issue #467)', () => {
  test('cube distance between neighbours is 1', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 1, r: 0 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: -1 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 })).toBe(2);
  });

  test('axialRound lands on integer coords', () => {
    const rounded = axialRound({ q: 0.1, r: 0.2 });
    expect(Number.isInteger(rounded.q)).toBe(true);
    expect(Number.isInteger(rounded.r)).toBe(true);
  });

  test('token hex radius scales with size', () => {
    expect(tokenHexRadius('medium')).toBe(0);
    expect(tokenHexRadius('large')).toBe(1);
    expect(hexesInRadius({ q: 0, r: 0 }, 1)).toHaveLength(7);
  });
});

test.describe('hex-center snapping (issue #467)', () => {
  test('snapLayerPxToHex lands on a hex centre in the calibrated grid frame', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 })!;
    const calPx = calibrationToPx(cal, rect.width);
    const nudged = { x: calPx.cellWpx * 0.37 + calPx.originXpx, y: calPx.cellHpx * 0.62 + calPx.originYpx };
    const snapped = snapLayerPxToHex(nudged, calPx, 'pointy');
    const again = snapLayerPxToHex(snapped, calPx, 'pointy');
    expect(again).toEqual(snapped);
  });

  test('snapMapPercentToHex is idempotent', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 })!;
    const pt = { x: 33, y: 44 };
    const once = snapMapPercentToHex(pt, cal, rect, 'pointy', true);
    const twice = snapMapPercentToHex(once, cal, rect, 'pointy', true);
    expect(twice).toEqual(once);
  });
});

test.describe('hex-aware distance (issue #467)', () => {
  test('hex distance counts whole hex steps, not Euclidean squares', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 })!;
    const cellPx = calibrationToPx(cal, rect.width).cellWpx;
    const a = { x: 50, y: 50 };
    const bAxial = mapPercentToAxial(a, cal, rect, 'pointy');
    const bCenter = mapPercentToLayerPx(
      snapMapPercentToHex(a, cal, rect, 'pointy', true),
      rect,
    );
    const neighbourPx = {
      x: bCenter.x + cellPx,
      y: bCenter.y,
    };
    const neighbour = snapMapPercentToHex(
      { x: (neighbourPx.x / rect.width) * 100, y: (neighbourPx.y / rect.height) * 100 },
      cal,
      rect,
      'pointy',
      true,
    );
    const hexSteps = mapPercentGridDistance(a, neighbour, rect, cellPx, 'hex', cal, 'pointy', DEFAULT_GRID_DISTANCE_RULE);
    expect(hexSteps).toBeGreaterThanOrEqual(1);
    expect(hexSteps).toBeLessThanOrEqual(2);
    void bAxial;
  });
});

test.describe('hex overlay (issue #467)', () => {
  test('hexPolygons honours calibration and emits polygons', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 })!;
    const calPx = calibrationToPx(cal, rect.width);
    const polys = hexPolygons(rect.width, rect.height, calPx, 'pointy');
    expect(polys.length).toBeGreaterThan(0);
    expect(polys[0]).toMatch(/^-?\d/);
  });
});

test.describe('RunSessionPage wiring (issue #467)', () => {
  test('imports shared hexGeometry module', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toMatch(/from '\.\.\/hexGeometry'/);
    expect(source).toMatch(/snapMapPercentToHex/);
    expect(source).toMatch(/mapPercentGridDistance/);
    expect(source).not.toMatch(/function hexPolygons\(/);
  });
});

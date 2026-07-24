/**
 * VTT grid calibration transform (issue #417).
 *
 * A single shared transform aligns the overlay to a map's own printed grid: origin
 * offset, independent cell width/height, rotation, and overlay opacity. Snapping, the
 * overlay, and the ruler all consume THIS module, and every viewport renders the same
 * server-persisted calibration — so these pure functions are the correctness core.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  calibrationToPx,
  computeContainedRect,
  DEFAULT_GRID_OPACITY,
  layerPxToMapPercent,
  resolveGridCalibration,
  snapLayerPxToGrid,
  snapMapPercentCalibrated,
} from '../../src/features/encounters/mapRenderedBounds';

const BOUNDS_MODULE = resolve(__dirname, '../../src/features/encounters/mapRenderedBounds.ts');
const SURFACE = { w: 800, h: 600 };
const SQUARE = { w: 1000, h: 1000 };

test.describe('resolveGridCalibration (issue #417)', () => {
  test('no positive gridSize → null (grid off)', () => {
    expect(resolveGridCalibration({ gridSize: null })).toBeNull();
    expect(resolveGridCalibration({ gridSize: 0 })).toBeNull();
    expect(resolveGridCalibration({})).toBeNull();
  });

  test('bare gridSize reproduces the pre-#417 top-left square grid', () => {
    const cal = resolveGridCalibration({ gridSize: 10 });
    expect(cal).toEqual({
      cellW: 10,
      cellH: 10, // square: cellH mirrors cellW
      offsetX: 0,
      offsetY: 0,
      rotationDeg: 0,
      opacity: DEFAULT_GRID_OPACITY,
    });
  });

  test('independent cell height, offset, rotation, and opacity carry through', () => {
    const cal = resolveGridCalibration({
      gridSize: 8,
      gridCellHeight: 12,
      gridOffsetX: 3,
      gridOffsetY: -2,
      gridRotation: 15,
      gridOpacity: 0.6,
    });
    expect(cal).toEqual({ cellW: 8, cellH: 12, offsetX: 3, offsetY: -2, rotationDeg: 15, opacity: 0.6 });
  });

  test('null cell height means square; opacity is clamped to 0..1', () => {
    expect(resolveGridCalibration({ gridSize: 8, gridCellHeight: null })!.cellH).toBe(8);
    expect(resolveGridCalibration({ gridSize: 8, gridOpacity: 5 })!.opacity).toBe(1);
    expect(resolveGridCalibration({ gridSize: 8, gridOpacity: -1 })!.opacity).toBe(0);
  });
});

test.describe('calibrationToPx is isotropic in map width (issue #417)', () => {
  test('every dimension scales by map width / 100', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!; // 600x600 centred
    const cal = resolveGridCalibration({ gridSize: 10, gridCellHeight: 20, gridOffsetX: 5, gridOffsetY: 5, gridRotation: 30 })!;
    const px = calibrationToPx(cal, rect.width);
    expect(px.cellWpx).toBeCloseTo(rect.width * 0.1, 5);
    expect(px.cellHpx).toBeCloseTo(rect.width * 0.2, 5);
    expect(px.originXpx).toBeCloseTo(rect.width * 0.05, 5);
    expect(px.originYpx).toBeCloseTo(rect.width * 0.05, 5);
    expect(px.rotationDeg).toBe(30);
    expect(px.rotationRad).toBeCloseTo(Math.PI / 6, 5);
  });
});

test.describe('snapLayerPxToGrid honours offset, cell size, and rotation (issue #417)', () => {
  test('unrotated snap lands on a half-cell offset from the origin', () => {
    const cal = calibrationToPx(
      resolveGridCalibration({ gridSize: 10, gridOffsetX: 0, gridOffsetY: 0 })!,
      1000,
    ); // cell 100x100, origin 0,0
    // A point near (140, 260) snaps to the centre of the cell it's in: (150, 250).
    expect(snapLayerPxToGrid({ x: 140, y: 260 }, cal)).toEqual({ x: 150, y: 250 });
  });

  test('origin offset shifts the snap lattice', () => {
    const cal = calibrationToPx(
      resolveGridCalibration({ gridSize: 10, gridOffsetX: 5, gridOffsetY: 5 })!,
      1000,
    ); // cell 100x100, origin 50,50
    // Cell centres are at 50 + (n + .5)*100. Point 120,120 → cell 0 → centre 100,100.
    const snapped = snapLayerPxToGrid({ x: 120, y: 120 }, cal);
    expect(snapped.x).toBeCloseTo(100, 5);
    expect(snapped.y).toBeCloseTo(100, 5);
  });

  test('rotated snap centres are exactly one cell apart along the rotated axis', () => {
    // Rotation stays within the encounter schema's validated ±45° domain (issue #417).
    const deg = 45;
    const cal = calibrationToPx(resolveGridCalibration({ gridSize: 10, gridRotation: deg })!, 1000);
    // Snapped centres tile a 100px lattice rotated by 45°. Stepping a start point by exactly
    // one cell along the rotated +x axis lands it in the adjacent cell, so the two snapped
    // centres are ~100px apart.
    const rad = (deg * Math.PI) / 180;
    const a = snapLayerPxToGrid({ x: 300, y: 300 }, cal);
    const b = snapLayerPxToGrid({ x: 300 + 100 * Math.cos(rad), y: 300 + 100 * Math.sin(rad) }, cal);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    expect(dist).toBeCloseTo(100, 3);
  });

  test('degenerate cell returns the point unchanged', () => {
    const cal = calibrationToPx({ cellW: 0, cellH: 0, offsetX: 0, offsetY: 0, rotationDeg: 0, opacity: 0.35 }, 1000);
    expect(snapLayerPxToGrid({ x: 7, y: 9 }, cal)).toEqual({ x: 7, y: 9 });
  });
});

test.describe('snapMapPercentCalibrated round-trips through the shared transform (issue #417)', () => {
  test('snap off returns the clamped point untouched', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 });
    expect(snapMapPercentCalibrated({ x: 33, y: 66 }, cal, rect, false)).toEqual({ x: 33, y: 66 });
  });

  test('snapped map-percent lands on a calibrated cell centre for a letterboxed map', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!; // 600x600, left offset 100
    const cal = resolveGridCalibration({ gridSize: 10 })!; // cell = 60px, origin 0,0
    const snapped = snapMapPercentCalibrated({ x: 12, y: 12 }, cal, rect, true);
    // Re-project into layer px and assert a half-cell landing.
    const px = { x: (snapped.x / 100) * rect.width, y: (snapped.y / 100) * rect.height };
    const cell = rect.width * 0.1;
    expect(px.x % cell).toBeCloseTo(cell / 2, 4);
    expect(px.y % cell).toBeCloseTo(cell / 2, 4);
  });

  test('layerPxToMapPercent inverts mapPercentToLayerPx', () => {
    const rect = { left: 0, top: 0, width: 400, height: 300 };
    expect(layerPxToMapPercent({ x: 200, y: 150 }, rect)).toEqual({ x: 50, y: 50 });
  });
});

test.describe('module documents the calibration issue', () => {
  test('mapRenderedBounds references issue #417', () => {
    expect(readFileSync(BOUNDS_MODULE, 'utf8')).toMatch(/#417/);
  });
});

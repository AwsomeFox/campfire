/**
 * VTT rendered-map bounds (issue #464).
 *
 * Coordinates / cell size / snap / letterbox rejection must follow the
 * object-contain image rect inside the fixed 16:9 surface — not the surface
 * itself. Covers square, portrait, 4:3, 16:9, and ultrawide intrinsic ratios.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cellSizePx,
  computeContainedRect,
  isInsideMapRect,
  mapPercentDistanceCells,
  mapPercentToLayerPx,
  pointerToMapPercent,
  snapMapPercent,
} from '../../src/features/encounters/mapRenderedBounds';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const BOUNDS_MODULE = resolve(__dirname, '../../src/features/encounters/mapRenderedBounds.ts');

/** Classic 16:9 surface used by the battle-map shell (836×470 ≈ the audit repro). */
const SURFACE = { w: 836, h: 470 };

const RATIOS: Array<{ name: string; intrinsic: { w: number; h: number } }> = [
  { name: 'square', intrinsic: { w: 1000, h: 1000 } },
  { name: 'portrait', intrinsic: { w: 768, h: 1024 } },
  { name: '4:3', intrinsic: { w: 1600, h: 1200 } },
  { name: '16:9', intrinsic: { w: 1920, h: 1080 } },
  { name: 'ultrawide', intrinsic: { w: 3440, h: 1440 } },
  // Explicit audit repro: 20×15 map letterboxed inside 836×470.
  { name: '20×15 audit', intrinsic: { w: 20, h: 15 } },
];

test.describe('computeContainedRect (issue #464)', () => {
  for (const { name, intrinsic } of RATIOS) {
    test(`${name}: fits inside the surface without cropping`, () => {
      const rect = computeContainedRect(SURFACE, intrinsic);
      expect(rect).not.toBeNull();
      expect(rect!.width).toBeLessThanOrEqual(SURFACE.w + 1e-6);
      expect(rect!.height).toBeLessThanOrEqual(SURFACE.h + 1e-6);
      expect(rect!.left).toBeGreaterThanOrEqual(-1e-6);
      expect(rect!.top).toBeGreaterThanOrEqual(-1e-6);
      expect(rect!.left + rect!.width).toBeLessThanOrEqual(SURFACE.w + 1e-6);
      expect(rect!.top + rect!.height).toBeLessThanOrEqual(SURFACE.h + 1e-6);

      // Aspect ratio of the rendered rect matches the intrinsic image.
      const renderedRatio = rect!.width / rect!.height;
      const intrinsicRatio = intrinsic.w / intrinsic.h;
      expect(renderedRatio).toBeCloseTo(intrinsicRatio, 5);

      // At least one axis fills the surface (object-contain).
      const fillsWidth = Math.abs(rect!.width - SURFACE.w) < 1e-6;
      const fillsHeight = Math.abs(rect!.height - SURFACE.h) < 1e-6;
      expect(fillsWidth || fillsHeight).toBe(true);
    });
  }

  test('20×15 audit case matches letterboxed 627×470 inside 836×470', () => {
    const rect = computeContainedRect(SURFACE, { w: 20, h: 15 })!;
    expect(rect.width).toBeCloseTo(627, 0);
    expect(rect.height).toBeCloseTo(470, 0);
    expect(rect.left).toBeCloseTo((836 - 627) / 2, 0);
    expect(rect.top).toBeCloseTo(0, 5);
  });

  test('unknown intrinsic falls back to the full surface', () => {
    expect(computeContainedRect(SURFACE, null)).toEqual({
      left: 0,
      top: 0,
      width: SURFACE.w,
      height: SURFACE.h,
    });
  });

  test('empty surface yields null', () => {
    expect(computeContainedRect({ w: 0, h: 470 }, { w: 100, h: 100 })).toBeNull();
  });
});

test.describe('cellSizePx / snap / distance use map width (issue #464)', () => {
  test('cell edge is a percent of the rendered map width, not the 16:9 surface', () => {
    const rect = computeContainedRect(SURFACE, { w: 20, h: 15 })!;
    const gridSize = 10; // 10% of map width
    const mapCell = cellSizePx(gridSize, rect.width);
    const surfaceCell = cellSizePx(gridSize, SURFACE.w);
    expect(mapCell).toBeCloseTo(rect.width * 0.1, 5);
    // The bug: using surface width overstates the cell on letterboxed maps.
    expect(surfaceCell).toBeGreaterThan(mapCell);
    expect(mapCell / surfaceCell).toBeCloseTo(rect.width / SURFACE.w, 5);
  });

  test('snap centres land on map-percent cell centres for every ratio', () => {
    for (const { name, intrinsic } of RATIOS) {
      const rect = computeContainedRect(SURFACE, intrinsic)!;
      const cell = cellSizePx(8, rect.width);
      expect(cell, name).toBeGreaterThan(0);
      const snapped = snapMapPercent({ x: 12, y: 12 }, cell, rect, true);
      // Re-project to pixels and assert we landed on a half-cell.
      const px = (snapped.x / 100) * rect.width;
      const py = (snapped.y / 100) * rect.height;
      expect(px % cell, name).toBeCloseTo(cell / 2, 5);
      expect(py % cell, name).toBeCloseTo(cell / 2, 5);
    }
  });

  test('ruler distance uses map-space pixels', () => {
    const rect = computeContainedRect(SURFACE, { w: 1000, h: 1000 })!;
    const cell = cellSizePx(10, rect.width);
    // Move exactly two cells right in map percent.
    const cells = mapPercentDistanceCells({ x: 0, y: 50 }, { x: 20, y: 50 }, rect, cell);
    expect(cells).toBeCloseTo(2, 5);
  });

  test('mapPercentToLayerPx is origin-relative to the map rect', () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };
    expect(mapPercentToLayerPx({ x: 50, y: 50 }, rect)).toEqual({ x: 200, y: 150 });
  });
});

test.describe('letterbox interaction rejection (issue #464)', () => {
  test('pointer in side letterbox bands returns null; clamp pins to edge', () => {
    const rect = computeContainedRect(SURFACE, { w: 20, h: 15 })!;
    const surfaceClient = { left: 0, top: 0, width: SURFACE.w, height: SURFACE.h };

    // Left letterbox (x < rect.left).
    expect(
      pointerToMapPercent(rect.left / 2, SURFACE.h / 2, surfaceClient, rect),
    ).toBeNull();
    // Right letterbox.
    expect(
      pointerToMapPercent(rect.left + rect.width + 10, SURFACE.h / 2, surfaceClient, rect),
    ).toBeNull();

    // Inside the map → valid percents.
    const mid = pointerToMapPercent(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      surfaceClient,
      rect,
    );
    expect(mid).toEqual({ x: 50, y: 50 });

    // Clamp keeps a drag that leaves the map on the edge.
    const clamped = pointerToMapPercent(0, SURFACE.h / 2, surfaceClient, rect, { clamp: true });
    expect(clamped).toEqual({ x: 0, y: 50 });
  });

  test('portrait pillarbox rejects left/right bands', () => {
    // Tall image on a wide surface → side bars (pillarbox), not top/bottom.
    const rect = computeContainedRect(SURFACE, { w: 768, h: 1024 })!;
    expect(rect.left).toBeGreaterThan(0);
    expect(rect.top).toBeCloseTo(0, 5);
    const surfaceClient = { left: 0, top: 0, width: SURFACE.w, height: SURFACE.h };
    expect(pointerToMapPercent(rect.left / 2, SURFACE.h / 2, surfaceClient, rect)).toBeNull();
    expect(
      pointerToMapPercent(rect.left + rect.width + 5, SURFACE.h / 2, surfaceClient, rect),
    ).toBeNull();
    expect(isInsideMapRect(rect.left + 1, SURFACE.h / 2, rect)).toBe(true);
  });

  test('ultrawide letterbox rejects top/bottom bands', () => {
    const rect = computeContainedRect(SURFACE, { w: 3440, h: 1440 })!;
    expect(rect.top).toBeGreaterThan(0);
    const surfaceClient = { left: 0, top: 0, width: SURFACE.w, height: SURFACE.h };
    expect(pointerToMapPercent(SURFACE.w / 2, rect.top / 2, surfaceClient, rect)).toBeNull();
    expect(
      pointerToMapPercent(SURFACE.w / 2, rect.top + rect.height + 5, surfaceClient, rect),
    ).toBeNull();
  });

  test('exact surface-ratio image fills with no letterbox', () => {
    const rect = computeContainedRect(SURFACE, { w: SURFACE.w, h: SURFACE.h })!;
    expect(rect.left).toBeCloseTo(0, 5);
    expect(rect.top).toBeCloseTo(0, 5);
    expect(rect.width).toBeCloseTo(SURFACE.w, 5);
    expect(rect.height).toBeCloseTo(SURFACE.h, 5);
    const surfaceClient = { left: 0, top: 0, width: SURFACE.w, height: SURFACE.h };
    expect(pointerToMapPercent(0, 0, surfaceClient, rect)).toEqual({ x: 0, y: 0 });
    expect(pointerToMapPercent(SURFACE.w, SURFACE.h, surfaceClient, rect)).toEqual({
      x: 100,
      y: 100,
    });
  });
});

test.describe('RunSessionPage wires the shared transform (issue #464)', () => {
  test('imports mapRenderedBounds helpers instead of hard-coding surface width for cells', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/from ['"]\.\/mapRenderedBounds['"]/);
    expect(source).toMatch(/computeContainedRect/);
    expect(source).toMatch(/pointerToMapPercent/);
    expect(source).toMatch(/cellSizePx/);
    // The old bug: cell size from the 16:9 surface width.
    expect(source).not.toMatch(/\(gridSize! \/ 100\) \* surfaceW/);
    // Module must document the issue id for future calibrations (#417).
    expect(readFileSync(BOUNDS_MODULE, 'utf8')).toMatch(/#464/);
  });
});

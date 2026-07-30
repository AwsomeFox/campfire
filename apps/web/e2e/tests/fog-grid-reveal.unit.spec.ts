import { expect, test } from '@playwright/test';
import type { FogRect } from '@campfire/schema';
import { resolveGridCalibration, type Rect } from '../../src/features/encounters/mapRenderedBounds';
import { gridCellRevealRect, type GridRevealResult } from '../../src/features/encounters/fogGridReveal';

function assertFogRect(result: GridRevealResult): FogRect {
  if ('reason' in result) {
    throw new Error(`Expected a FogRect, got reason: ${result.reason}`);
  }
  return result;
}

test.describe('gridCellRevealRect (issue #472)', () => {
  const mapRect: Rect = { left: 0, top: 0, width: 800, height: 450 };

  test('returns one grid cell rect for an unrotated grid', () => {
    const cal = resolveGridCalibration({ gridSize: 10, gridOffsetX: 0, gridOffsetY: 0 });
    expect(cal).not.toBeNull();
    const rect = assertFogRect(gridCellRevealRect({ x: 15, y: 25 }, cal!, mapRect));
    expect(rect).toMatchObject({ x: 10, w: 10 });
    expect(rect.y).toBeCloseTo(17.78, 1);
    expect(rect.h).toBeCloseTo(17.78, 1);
  });
});

test.describe('gridCellRevealRect tall and wide maps (issue #1460)', () => {
  test('reveals a cell on a 1000×4000 map with gridSize 1.5', () => {
    const mapRect: Rect = { left: 0, top: 0, width: 1000, height: 4000 };
    const cal = resolveGridCalibration({ gridSize: 1.5 });
    expect(cal).not.toBeNull();
    const rect = assertFogRect(gridCellRevealRect({ x: 50, y: 50 }, cal!, mapRect));
    expect(rect.w).toBeCloseTo(1.5, 2);
    expect(rect.h).toBeCloseTo(0.375, 3);
    expect(rect.w * mapRect.width / 100).toBeCloseTo(15, 1);
    expect(rect.h * mapRect.height / 100).toBeCloseTo(15, 1);
  });

  test('reveals a cell on a 4000×1000 wide map symmetrically', () => {
    const mapRect: Rect = { left: 0, top: 0, width: 4000, height: 1000 };
    // 0.375% of the 4000 px width is the same 15 px cell as 1.5% of the 1000 px width.
    const cal = resolveGridCalibration({ gridSize: 0.375 });
    expect(cal).not.toBeNull();
    const rect = assertFogRect(gridCellRevealRect({ x: 50, y: 50 }, cal!, mapRect));
    expect(rect.w).toBeCloseTo(0.375, 3);
    expect(rect.h).toBeCloseTo(1.5, 2);
    expect(rect.w * mapRect.width / 100).toBeCloseTo(15, 1);
    expect(rect.h * mapRect.height / 100).toBeCloseTo(15, 1);
  });
});

test.describe('gridCellRevealRect degenerate inputs (issue #1460)', () => {
  test('returns a reason for a zero-size map', () => {
    const cal = resolveGridCalibration({ gridSize: 10 });
    const result = gridCellRevealRect({ x: 50, y: 50 }, cal!, { left: 0, top: 0, width: 0, height: 0 });
    expect(result).toHaveProperty('reason');
  });

  test('returns a reason for a missing calibration', () => {
    const mapRect: Rect = { left: 0, top: 0, width: 1000, height: 1000 };
    const result = gridCellRevealRect({ x: 50, y: 50 }, null, mapRect);
    expect(result).toHaveProperty('reason');
  });

  test('returns a reason for a zero grid size', () => {
    const mapRect: Rect = { left: 0, top: 0, width: 1000, height: 1000 };
    const cal = resolveGridCalibration({ gridSize: 0 });
    expect(cal).toBeNull();
    const result = gridCellRevealRect({ x: 50, y: 50 }, cal, mapRect);
    expect(result).toHaveProperty('reason');
  });

  test('returns a reason for an out-of-bounds reveal point', () => {
    const mapRect: Rect = { left: 0, top: 0, width: 1000, height: 1000 };
    const cal = resolveGridCalibration({ gridSize: 10 });
    expect(cal).not.toBeNull();
    expect(gridCellRevealRect({ x: -1, y: 50 }, cal!, mapRect)).toHaveProperty('reason');
    expect(gridCellRevealRect({ x: 50, y: -1 }, cal!, mapRect)).toHaveProperty('reason');
    expect(gridCellRevealRect({ x: 101, y: 50 }, cal!, mapRect)).toHaveProperty('reason');
    expect(gridCellRevealRect({ x: 50, y: 101 }, cal!, mapRect)).toHaveProperty('reason');
  });
});

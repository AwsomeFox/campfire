import { expect, test } from '@playwright/test';
import { resolveGridCalibration, type Rect } from '../../src/features/encounters/mapRenderedBounds';
import { gridCellRevealRect } from '../../src/features/encounters/fogGridReveal';

test.describe('gridCellRevealRect (issue #472)', () => {
  const mapRect: Rect = { left: 0, top: 0, width: 800, height: 450 };

  test('returns one grid cell rect for an unrotated grid', () => {
    const cal = resolveGridCalibration({ gridSize: 10, gridOffsetX: 0, gridOffsetY: 0 });
    expect(cal).not.toBeNull();
    const rect = gridCellRevealRect({ x: 15, y: 25 }, cal!, mapRect);
    expect(rect).toMatchObject({ x: 10, w: 10 });
    expect(rect!.y).toBeCloseTo(17.78, 1);
    expect(rect!.h).toBeCloseTo(17.78, 1);
  });
});

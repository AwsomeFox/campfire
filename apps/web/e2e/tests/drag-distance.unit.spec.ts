/**
 * Token-drag distance + movement budget (issue #1911).
 *
 * Pure unit tests for the helpers BattleMap.tsx composes with the SAME
 * `mapPercentGridDistance` + `formatRulerReadout` path the Measure tool already uses
 * (square euclidean, square alternating-diagonal, and hex cube distance), plus the
 * movement-budget line and the current-actor write gate.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dragBudget, dragMoveFt, isCurrentActorDrag, roundCellsToGridStep } from '../../src/features/encounters/dragDistance';
import { mapPercentGridDistance, snapMapPercentToHex } from '../../src/features/encounters/hexGeometry';
import { calibrationToPx, computeContainedRect, mapPercentToLayerPx, resolveGridCalibration } from '../../src/features/encounters/mapRenderedBounds';
import { rulerDistanceFeet } from '../../src/features/encounters/rulerReadout';
import type { GridDistanceRule } from '@campfire/schema';
import { DEFAULT_GRID_DISTANCE_RULE } from '@campfire/schema';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');
const SURFACE = { w: 800, h: 600 };
const SQUARE = { w: 1000, h: 1000 };

test.describe('dragBudget (issue #1911)', () => {
  test('composes movementUsedFt + in-flight feet, rounded to two decimals', () => {
    expect(dragBudget(10, 5, 30)).toEqual({ usedFt: 15, maxFt: 30, overBudget: false });
    expect(dragBudget(10, 5.005, 30)).toEqual({ usedFt: 15.01, maxFt: 30, overBudget: false });
  });

  test('is not over budget exactly at the max', () => {
    expect(dragBudget(20, 10, 30)).toEqual({ usedFt: 30, maxFt: 30, overBudget: false });
  });

  test('tints over budget by even a fraction over the max — advisory only, never a block', () => {
    expect(dragBudget(20, 10.5, 30)).toEqual({ usedFt: 30.5, maxFt: 30, overBudget: true });
  });

  test('zero max (gridless/unbounded adapter default) is over budget on any movement', () => {
    expect(dragBudget(0, 1, 0).overBudget).toBe(true);
  });
});

test.describe('roundCellsToGridStep / dragMoveFt (issue #1911)', () => {
  test('rounds fractional cells to the nearest whole grid step', () => {
    expect(roundCellsToGridStep(2.4)).toBe(2);
    expect(roundCellsToGridStep(2.6)).toBe(3);
    expect(roundCellsToGridStep(0.4)).toBe(0);
  });

  test('moveFt is the rounded whole-cell distance times the encounter gridScale, never a hardcoded 5 ft', () => {
    expect(dragMoveFt(2.4, 5)).toBe(10); // round(2.4) = 2 cells × 5 ft/cell
    expect(dragMoveFt(2.6, 5)).toBe(15); // round(2.6) = 3 cells × 5 ft/cell
    expect(dragMoveFt(2.4, 2)).toBe(4); // a non-5 ft scale still drives the result
  });

  test('a drop back on the origin cell declares zero feet', () => {
    expect(dragMoveFt(0.4, 5)).toBe(0);
  });
});

test.describe('isCurrentActorDrag (issue #1911) — gating matrix', () => {
  test('the current actor of a running encounter', () => {
    expect(isCurrentActorDrag('running', 7, 7)).toBe(true);
  });

  test('off-turn: dragged combatant is not the current actor', () => {
    expect(isCurrentActorDrag('running', 7, 9)).toBe(false);
  });

  test('no current combatant (e.g. lair phase)', () => {
    expect(isCurrentActorDrag('running', null, 7)).toBe(false);
    expect(isCurrentActorDrag('running', undefined, 7)).toBe(false);
  });

  test('encounter not running (prep or ended) never writes, even for a matching id', () => {
    expect(isCurrentActorDrag('prep', 7, 7)).toBe(false);
    expect(isCurrentActorDrag('ended', 7, 7)).toBe(false);
  });
});

test.describe('drag distance matches the Measure tool for the same two points (issue #1911)', () => {
  test('square grid, euclidean distance', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 })!; // 10% of map width per cell
    const calPx = calibrationToPx(cal, rect.width);
    const origin = { x: 10, y: 10 };
    const current = { x: 34, y: 10 }; // 24% across = 2.4 cells at a 10%-per-cell grid
    const cells = mapPercentGridDistance(origin, current, rect, calPx.cellWpx, 'square', cal, 'pointy', DEFAULT_GRID_DISTANCE_RULE);
    expect(cells).toBeCloseTo(2.4, 1);
    expect(dragMoveFt(cells, 5)).toBe(10);
    expect(rulerDistanceFeet(cells, 5)).toBeCloseTo(12, 1); // the Measure tool's OWN (unrounded) readout
  });

  test('square grid, alternating-diagonal (5e "flat" diagonal) distance', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 })!;
    const calPx = calibrationToPx(cal, rect.width);
    const rule: GridDistanceRule = { square: 'alternating-diagonal', hex: 'hex' };
    const origin = { x: 10, y: 10 };
    const current = { x: 30, y: 30 }; // 2 cells diagonally each axis
    const cells = mapPercentGridDistance(origin, current, rect, calPx.cellWpx, 'square', cal, 'pointy', rule);
    expect(cells).toBe(3); // orth(0) + diag(2) + floor(diag/2)(1) = 3, per the 5e alternating rule
    expect(dragMoveFt(cells, 5)).toBe(15);
  });

  test('hex grid, cube distance — one hex step east', () => {
    const rect = computeContainedRect(SURFACE, SQUARE)!;
    const cal = resolveGridCalibration({ gridSize: 10 })!;
    const calPx = calibrationToPx(cal, rect.width);
    const origin = { x: 50, y: 50 };
    const originCenter = mapPercentToLayerPx(snapMapPercentToHex(origin, cal, rect, 'pointy', true), rect);
    const neighbourPx = { x: originCenter.x + calPx.cellWpx, y: originCenter.y };
    const current = snapMapPercentToHex(
      { x: (neighbourPx.x / rect.width) * 100, y: (neighbourPx.y / rect.height) * 100 },
      cal,
      rect,
      'pointy',
      true,
    );
    const cells = mapPercentGridDistance(origin, current, rect, calPx.cellWpx, 'hex', cal, 'pointy', DEFAULT_GRID_DISTANCE_RULE);
    expect(cells).toBe(1); // adjacent hex centre — exactly one step
    expect(dragMoveFt(cells, 5)).toBe(5);
  });
});

test.describe('BattleMap wires the shared drag-distance helpers (issue #1911)', () => {
  test('imports the pure module instead of re-deriving budget/rounding inline', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toMatch(/from ['"]\.\.\/dragDistance['"]/);
    expect(source).toMatch(/dragBudget/);
    expect(source).toMatch(/dragMoveFt/);
    expect(source).toMatch(/isCurrentActorDrag/);
    // The live drag readout must render through the SAME formatter as the Measure tool.
    expect(source).toMatch(/formatRulerReadout/);
  });
});

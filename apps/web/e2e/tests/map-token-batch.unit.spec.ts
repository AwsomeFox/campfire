import { expect, test } from '@playwright/test';
import { isTrulyUnplaced, planCollisionFreePlacement, planFormationPlacement, resolveDesiredFormation, tokenRadiusPercent, tokensInLasso, tokensInRectangle, translateGroup } from '../../src/features/encounters/mapTokenBatch';

const token = (id: number, x: number | null, y: number | null, tokenSize = 'medium') => ({ id, name: `Token ${id}`, kind: id % 2 ? 'character' : 'monster', tokenX: x, tokenY: y, tokenSize });

test.describe('map token batch planner (issue #761)', () => {
  test('places 20 mixed-size unplaced tokens deterministically without collisions', () => {
    const sizes = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];
    const roster = Array.from({ length: 20 }, (_, i) => token(i + 1, null, null, sizes[i % sizes.length]));
    const first = planCollisionFreePlacement(roster, { x: 50, y: 50 });
    const again = planCollisionFreePlacement(roster, { x: 50, y: 50 });
    expect(first).toEqual(again);
    expect(first).toHaveLength(20);
    expect(new Set(first.map(p => `${p.x}:${p.y}`)).size).toBe(20);
  });

  test('uses a distinct deterministic hex lattice and keeps placements in bounds', () => {
    const roster = Array.from({ length: 20 }, (_, i) => token(i + 1, null, null, i % 3 === 0 ? 'large' : 'medium'));
    const square = planCollisionFreePlacement(roster, { x: 50, y: 50 }, 5, 'square');
    const hex = planCollisionFreePlacement(roster, { x: 50, y: 50 }, 5, 'hex');
    expect(hex).not.toEqual(square);
    for (const point of hex) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(100);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(100);
    }
  });

  test('formation plans keep mixed-size footprints separate and inside map edges', () => {
    const roster = [token(1, null, null, 'huge'), token(2, null, null, 'large'), token(3, 50, 50, 'medium')];
    const plan = planFormationPlacement(roster, new Set([1, 2]), 'line', { x: 5, y: 5 }, 5, 'hex');
    expect(plan).toHaveLength(2);
    for (const point of plan) {
      const source = roster.find(t => t.id === point.id)!;
      const radius = tokenRadiusPercent(source, 5);
      expect(point.x - radius).toBeGreaterThanOrEqual(0);
      expect(point.y - radius).toBeGreaterThanOrEqual(0);
      expect(point.x + radius).toBeLessThanOrEqual(100);
      expect(point.y + radius).toBeLessThanOrEqual(100);
    }
    const [a, b] = plan;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(tokenRadiusPercent(roster[0], 5) + tokenRadiusPercent(roster[1], 5) - .001);
  });

  test('saved desired offsets are resolved collision-free for mixed footprints', () => {
    const roster = [token(1, null, null, 'huge'), token(2, null, null, 'large')];
    const plan = resolveDesiredFormation(roster, [{ token: roster[0], desired: { x: 5, y: 5 } }, { token: roster[1], desired: { x: 5, y: 5 } }], 5, 'square');
    expect(Math.hypot(plan[0].x - plan[1].x, plan[0].y - plan[1].y)).toBeGreaterThanOrEqual(tokenRadiusPercent(roster[0], 5) + tokenRadiusPercent(roster[1], 5) - .001);
  });

  test('plans in rendered-map units when calibrated cells are rectangular', () => {
    const aspect = .5; // calibrated cell height / cell width
    const roster = [token(1, null, null, 'large'), token(2, null, null, 'large')];
    const plan = resolveDesiredFormation(roster, roster.map(source => ({ token: source, desired: { x: 50, y: 50 } })), 10, 'square', aspect);
    const [a, b] = plan;
    expect(Math.hypot(a.x - b.x, (a.y - b.y) * aspect)).toBeGreaterThanOrEqual(tokenRadiusPercent(roster[0], 10) + tokenRadiusPercent(roster[1], 10) - .001);
    for (const point of plan) expect(point.y - tokenRadiusPercent(roster.find(source => source.id === point.id)!, 10) / aspect).toBeGreaterThanOrEqual(0);
  });

  test('treats a partially persisted coordinate as unplaced', () => {
    expect(isTrulyUnplaced(token(1, null, 50))).toBe(true);
  });

  test('rectangle and lasso selections include only placed token centres', () => {
    const roster = [token(1, 10, 10), token(2, 30, 30), token(3, null, null)];
    expect([...tokensInRectangle(roster, { x: 5, y: 5 }, { x: 15, y: 15 })]).toEqual([1]);
    expect([...tokensInLasso(roster, [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 }])]).toEqual([2]);
  });

  test('group movement preserves relative offsets while clamping at the board edge', () => {
    const roster = [token(1, 80, 80), token(2, 90, 90)];
    expect(translateGroup(roster, new Set([1, 2]), 1, { x: 99, y: 99 })).toEqual([{ id: 1, x: 87.5, y: 87.5 }, { id: 2, x: 97.5, y: 97.5 }]);
  });
});

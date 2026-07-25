/**
 * AoE template hit-testing for apply-damage multi-target (issue #626).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AoeTemplate } from '@campfire/schema';
import {
  aoePolygonVertices,
  combatantsInAoe,
  DEFAULT_AOE_MAP_RECT,
  pointInPolygon,
  tokenInAoe,
  type AoeHitTestContext,
} from '../../src/features/encounters/aoeHitTest';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

const CTX: AoeHitTestContext = { gridSize: 10, gridScale: 5, mapRect: DEFAULT_AOE_MAP_RECT };

function aoe(partial: Partial<AoeTemplate> & Pick<AoeTemplate, 'shape'>): AoeTemplate {
  return {
    id: 'aoe-1',
    x: 50,
    y: 50,
    sizeFt: 10,
    angleDeg: 0,
    color: null,
    declaredByUserId: null,
    ...partial,
  };
}

test.describe('pointInPolygon', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  test('detects interior and exterior points', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(-1, 5, square)).toBe(false);
    expect(pointInPolygon(15, 5, square)).toBe(false);
  });
});

test.describe('tokenInAoe (issue #626)', () => {
  test('circle: token at center is inside; far token is outside', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    // radius = sizeFt/gridScale cells = 2 cells = 20% of map width at center
    expect(tokenInAoe({ x: 50, y: 50 }, template, CTX)).toBe(true);
    expect(tokenInAoe({ x: 50, y: 30 }, template, CTX)).toBe(true);
    expect(tokenInAoe({ x: 50, y: 10 }, template, CTX)).toBe(false);
  });

  test('cone aimed east: token ahead is inside, token behind is outside', () => {
    const template = aoe({ shape: 'cone', x: 50, y: 50, sizeFt: 15, angleDeg: 0 });
    expect(tokenInAoe({ x: 65, y: 50 }, template, CTX)).toBe(true);
    expect(tokenInAoe({ x: 35, y: 50 }, template, CTX)).toBe(false);
  });

  test('line aimed east: token on the ray is inside, token far north is outside', () => {
    const template = aoe({ shape: 'line', x: 20, y: 50, sizeFt: 30, angleDeg: 0 });
    expect(tokenInAoe({ x: 40, y: 50 }, template, CTX)).toBe(true);
    expect(tokenInAoe({ x: 40, y: 10 }, template, CTX)).toBe(false);
  });

  test('uses calibrated cellPx when provided', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    const defaultCell = { ...CTX };
    const calibrated = { ...CTX, cellPx: 150 };
    // Larger calibrated cells widen the hit radius.
    expect(tokenInAoe({ x: 50, y: 25 }, template, defaultCell)).toBe(false);
    expect(tokenInAoe({ x: 50, y: 25 }, template, calibrated)).toBe(true);
  });

  test('letterboxed mapRect affects Y-axis hit detection', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    const squareFallback = { ...CTX, mapRect: DEFAULT_AOE_MAP_RECT };
    const letterbox: AoeHitTestContext = {
      ...CTX,
      mapRect: { left: 0, top: 219, width: 1000, height: 562 },
    };
    // Square fallback exaggerates Y distance from center on letterboxed maps.
    expect(tokenInAoe({ x: 50, y: 25 }, template, squareFallback)).toBe(false);
    expect(tokenInAoe({ x: 50, y: 25 }, template, letterbox)).toBe(true);
  });

  test('returns false when grid context is invalid', () => {
    const template = aoe({ shape: 'circle' });
    expect(tokenInAoe({ x: 50, y: 50 }, template, { gridSize: 0, gridScale: 5 })).toBe(false);
    expect(tokenInAoe({ x: 50, y: 50 }, template, { gridSize: 10, gridScale: 0 })).toBe(false);
  });
});

test.describe('combatantsInAoe', () => {
  test('filters placed combatants inside a circle template', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    const combatants = [
      { id: 1, name: 'Near', tokenX: 50, tokenY: 50 },
      { id: 2, name: 'Edge', tokenX: 60, tokenY: 50 },
      { id: 3, name: 'Far', tokenX: 10, tokenY: 10 },
      { id: 4, name: 'Unplaced', tokenX: null, tokenY: null },
    ];
    const hits = combatantsInAoe(combatants, template, CTX);
    expect(hits.map((c) => c.id)).toEqual([1, 2]);
  });
});

test.describe('aoePolygonVertices parity with RunSessionPage', () => {
  test('cone vertices form a triangle with the origin as one vertex', () => {
    const verts = aoePolygonVertices('cone', 100, 200, 150, 0, 50);
    expect(verts).toHaveLength(3);
    expect(verts[0]).toEqual({ x: 100, y: 200 });
  });

  test('line vertices form a quadrilateral', () => {
    const verts = aoePolygonVertices('line', 0, 0, 200, Math.PI / 2, 40);
    expect(verts).toHaveLength(4);
    expect(pointInPolygon(0, 100, verts)).toBe(true);
    expect(pointInPolygon(100, 100, verts)).toBe(false);
  });
});

test.describe('RunSessionPage wiring (issue #626)', () => {
  test('ApplyDamageBar uses combatantsInAoe and exposes per-template AoE buttons', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/from ['"]\.\/aoeHitTest['"]/);
    expect(source).toMatch(/combatantsInAoe/);
    expect(source).toMatch(/apply-damage-aoe-/);
    expect(source).toMatch(/onApplyToAll/);
    expect(source).toMatch(/applyHpDeltaBulk/);
    expect(source).toMatch(/aoeTemplates=/);
    expect(source).toMatch(/onAoeHitLayoutChange/);
    expect(source).toMatch(/aoeHitLayout/);
  });
});

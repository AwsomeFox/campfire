/**
 * AoE template hit-testing for apply-damage multi-target (issue #626).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AoeTemplate, TokenSize } from '@campfire/schema';
import {
  aoePolygonVertices,
  combatantsInAoe,
  DEFAULT_AOE_MAP_RECT,
  pointInPolygon,
  tokenInAoe,
  type AoeHitTestContext,
} from '../../src/features/encounters/aoeHitTest';
import { resolveGridCalibration } from '../../src/features/encounters/mapRenderedBounds';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

const CTX: AoeHitTestContext = { gridSize: 10, gridScale: 5, mapRect: DEFAULT_AOE_MAP_RECT };

const HEX_CTX: AoeHitTestContext = {
  gridSize: 10,
  gridScale: 5,
  mapRect: DEFAULT_AOE_MAP_RECT,
  gridType: 'hex',
  calibration: resolveGridCalibration({ gridSize: 10 }),
  hexOrientation: 'pointy',
};

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

test.describe('tokenInAoe footprint (issue #1460)', () => {
  test('circle: Large+ token whose centre is outside the radius is included when its footprint overlaps', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    // A gargantuan token (4 cells) centred at 72% has its centre 220 px from a 200 px radius,
    // but its 200 px half-width brings the footprint inside.
    expect(tokenInAoe({ x: 72, y: 50 }, template, CTX, 'gargantuan')).toBe(true);
    // A medium token at 77.5% is 275 px out; even its 50 px half-width stays outside.
    expect(tokenInAoe({ x: 77.5, y: 50 }, template, CTX, 'medium')).toBe(false);
  });

  test('circle: a Tiny token is excluded when its footprint only touches the edge', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    // Tiny token at 72.5%: centre is 225 px out, half-width 25 px, so it just touches the 200 px radius.
    expect(tokenInAoe({ x: 72.5, y: 50 }, template, CTX, 'tiny')).toBe(false);
    // At 70% the centre is exactly on the radius, but the footprint still overlaps the interior.
    expect(tokenInAoe({ x: 70, y: 50 }, template, CTX, 'tiny')).toBe(true);
  });

  test('line: a Large token whose centre is outside the template is included when its footprint crosses it', () => {
    const template = aoe({ shape: 'line', x: 20, y: 50, sizeFt: 30, angleDeg: 0 });
    // Line is one cell wide (100 px) along y=500. Large token (2 cells) centred at 600 just
    // peeks into the line from the north; a medium token only touches the far edge.
    expect(tokenInAoe({ x: 20, y: 60 }, template, CTX, 'large')).toBe(true);
    expect(tokenInAoe({ x: 20, y: 60 }, template, CTX, 'medium')).toBe(false);
    // Far enough that even a Large token no longer overlaps.
    expect(tokenInAoe({ x: 20, y: 65 }, template, CTX, 'large')).toBe(false);
  });
});

test.describe('tokenInAoe hex grid (issue #1460)', () => {
  test('circle: Large+ token whose centre is outside the radius is included when its footprint overlaps', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    expect(tokenInAoe({ x: 80, y: 50 }, template, HEX_CTX, 'gargantuan')).toBe(true);
    expect(tokenInAoe({ x: 80, y: 50 }, template, HEX_CTX, 'medium')).toBe(false);
  });

  test('circle: a tiny token is excluded when its centre is outside the radius', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    expect(tokenInAoe({ x: 80, y: 50 }, template, HEX_CTX, 'tiny')).toBe(false);
    expect(tokenInAoe({ x: 70, y: 50 }, template, HEX_CTX, 'tiny')).toBe(true);
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

  test('threads tokenSize and includes a Large+ combatant whose footprint overlaps', () => {
    const template = aoe({ shape: 'circle', x: 50, y: 50, sizeFt: 10 });
    const combatants = [
      { id: 1, name: 'Gargantuan', tokenX: 72, tokenY: 50, tokenSize: 'gargantuan' as TokenSize },
      { id: 2, name: 'Tiny', tokenX: 72.5, tokenY: 50, tokenSize: 'tiny' as TokenSize },
      { id: 3, name: 'Large', tokenX: 60, tokenY: 50, tokenSize: 'large' as TokenSize },
      { id: 4, name: 'Medium', tokenX: 77.5, tokenY: 50, tokenSize: 'medium' as TokenSize },
    ];
    const hits = combatantsInAoe(combatants, template, CTX);
    expect(hits.map((c) => c.id)).toEqual([1, 3]);
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
    expect(source).toMatch(/aoe-save-outcome-/);
    expect(source).toMatch(/buildAoeDamageApplications/);
    expect(source).toMatch(/aoeTemplates=/);
    expect(source).toMatch(/onAoeHitLayoutChange/);
    expect(source).toMatch(/aoeHitLayout/);
  });
});

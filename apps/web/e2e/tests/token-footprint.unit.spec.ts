/**
 * VTT token footprint sizing (issue #468).
 *
 * Token diameters must scale with calibrated grid cells, not fixed pixels.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GRID_OFF_FALLBACK_CELL_PX,
  MIN_TOKEN_DIAMETER_PX,
  tokenDiameterPx,
  tokenFootprintCells,
  TOKEN_FOOTPRINT_CELLS,
} from '../../src/features/encounters/tokenFootprint';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');
const FOOTPRINT_MODULE = resolve(__dirname, '../../src/features/encounters/tokenFootprint.ts');

test.describe('tokenFootprintCells (issue #468)', () => {
  test('maps size categories to calibrated cell counts', () => {
    expect(TOKEN_FOOTPRINT_CELLS.medium).toBe(1);
    expect(TOKEN_FOOTPRINT_CELLS.large).toBe(2);
    expect(TOKEN_FOOTPRINT_CELLS.huge).toBe(3);
    expect(TOKEN_FOOTPRINT_CELLS.gargantuan).toBe(4);
    expect(tokenFootprintCells('tiny')).toBeLessThan(1);
    expect(tokenFootprintCells('small')).toBeLessThan(1);
  });
});

test.describe('tokenDiameterPx scales with grid (issue #468)', () => {
  const cellPx = 40;

  test('medium is one cell wide', () => {
    expect(tokenDiameterPx({ tokenSize: 'medium', cellPx })).toBe(40);
  });

  test('large/huge/gargantuan span multiple cells', () => {
    expect(tokenDiameterPx({ tokenSize: 'large', cellPx })).toBe(80);
    expect(tokenDiameterPx({ tokenSize: 'huge', cellPx })).toBe(120);
    expect(tokenDiameterPx({ tokenSize: 'gargantuan', cellPx })).toBe(160);
  });

  test('diameter tracks cell size across viewport/grid scales', () => {
    for (const px of [20, 32, 50, 100]) {
      expect(tokenDiameterPx({ tokenSize: 'large', cellPx: px })).toBe(px * 2);
      expect(tokenDiameterPx({ tokenSize: 'medium', cellPx: px })).toBe(px);
    }
  });

  test('hex grid uses the same cell-width unit as square', () => {
    const square = tokenDiameterPx({ tokenSize: 'huge', cellPx, gridType: 'square' });
    const hex = tokenDiameterPx({ tokenSize: 'huge', cellPx, gridType: 'hex' });
    expect(hex).toBe(square);
  });

  test('enforces minimum tappable diameter for tiny tokens on fine grids', () => {
    expect(tokenDiameterPx({ tokenSize: 'tiny', cellPx: 10 })).toBe(MIN_TOKEN_DIAMETER_PX);
  });

  test('preserves legacy fixed sizing when grid is off (cellPx = 0)', () => {
    expect(tokenDiameterPx({ tokenSize: 'medium', cellPx: 0 })).toBe(GRID_OFF_FALLBACK_CELL_PX);
    expect(tokenDiameterPx({ tokenSize: 'large', cellPx: 0 })).toBe(GRID_OFF_FALLBACK_CELL_PX * 2);
  });

  test('keeps sub-pixel diameters for fractional calibrated cells', () => {
    expect(tokenDiameterPx({ tokenSize: 'medium', cellPx: 33.3 })).toBeCloseTo(33.3, 5);
  });
});

test.describe('RunSessionPage wires tokenFootprint (issue #468)', () => {
  test('derives token size from grid cells, not fixed BASE_TOKEN_PX', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toMatch(/from ['"]\.\.\/tokenFootprint['"]/);
    expect(source).toMatch(/tokenDiameterPx/);
    expect(source).not.toMatch(/BASE_TOKEN_PX/);
    expect(source).not.toMatch(/TOKEN_SIZE_SCALE/);
    expect(readFileSync(FOOTPRINT_MODULE, 'utf8')).toMatch(/#468/);
  });
});

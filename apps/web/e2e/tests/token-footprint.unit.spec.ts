/**
 * VTT token footprint sizing (issue #468).
 *
 * Token diameters must scale with calibrated grid cells, not fixed pixels.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_FALLBACK_GRID_SIZE_PCT,
  MIN_TOKEN_DIAMETER_PX,
  tokenDiameterPx,
  tokenFootprintCells,
  TOKEN_FOOTPRINT_CELLS,
} from '../../src/features/encounters/tokenFootprint';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
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

  test('falls back to default grid % of map width when cellPx is 0', () => {
    const mapWidth = 500;
    const expected = Math.round((DEFAULT_FALLBACK_GRID_SIZE_PCT / 100) * mapWidth);
    expect(tokenDiameterPx({ tokenSize: 'medium', cellPx: 0, mapWidthPx: mapWidth })).toBe(expected);
    expect(tokenDiameterPx({ tokenSize: 'large', cellPx: 0, mapWidthPx: mapWidth })).toBe(expected * 2);
  });
});

test.describe('RunSessionPage wires tokenFootprint (issue #468)', () => {
  test('derives token size from grid cells, not fixed BASE_TOKEN_PX', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/from ['"]\.\/tokenFootprint['"]/);
    expect(source).toMatch(/tokenDiameterPx/);
    expect(source).not.toMatch(/BASE_TOKEN_PX/);
    expect(source).not.toMatch(/TOKEN_SIZE_SCALE/);
    expect(readFileSync(FOOTPRINT_MODULE, 'utf8')).toMatch(/#468/);
  });
});

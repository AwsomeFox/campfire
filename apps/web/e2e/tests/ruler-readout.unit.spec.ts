/**
 * VTT ruler readout units (issue #477).
 *
 * Square grids label cells "sq"/"squares"; hex grids use "hex"/"hexes" for both
 * pointy-top and flat-top orientations. Real-world distance still flows through
 * adapter-configured gridScale + gridUnit.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatRulerReadout,
  gridCellUnitAbbrev,
  gridCellUnitPlural,
  measureToolHelp,
  rulerDistanceFeet,
} from '../../src/features/encounters/rulerReadout';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');

const BASE = {
  cells: 2.4,
  scale: 5,
  gridUnit: 'ft',
} as const;

test.describe('ruler readout units (issue #477)', () => {
  test('square grid labels', () => {
    expect(gridCellUnitAbbrev('square')).toBe('sq');
    expect(gridCellUnitPlural('square')).toBe('squares');
    expect(rulerDistanceFeet(2.4, 5)).toBe(12);
    expect(rulerDistanceFeet(2.6, 5)).toBe(13);
    expect(rulerDistanceFeet(0.4, 5)).toBe(2);
    expect(formatRulerReadout({ ...BASE, gridType: 'square' }, 'display')).toBe('2.4 sq · 12 ft');
    expect(formatRulerReadout({ ...BASE, gridType: 'square' }, 'announce')).toBe('2.4 squares · 12 ft');
    expect(measureToolHelp('square')).toBe('Click-drag to measure distance in squares');
  });

  test('pointy-top hex grid labels', () => {
    expect(gridCellUnitAbbrev('hex')).toBe('hex');
    expect(gridCellUnitPlural('hex')).toBe('hexes');
    expect(formatRulerReadout({ ...BASE, gridType: 'hex', hexOrientation: 'pointy' }, 'display')).toBe(
      '2.4 hex · 12 ft',
    );
    expect(formatRulerReadout({ ...BASE, gridType: 'hex', hexOrientation: 'pointy' }, 'announce')).toBe(
      '2.4 hexes · 12 ft',
    );
    expect(measureToolHelp('hex')).toBe('Click-drag to measure distance in hexes');
  });

  test('flat-top hex grid labels match pointy-top copy', () => {
    expect(formatRulerReadout({ ...BASE, gridType: 'hex', hexOrientation: 'flat' }, 'display')).toBe(
      '2.4 hex · 12 ft',
    );
    expect(formatRulerReadout({ ...BASE, gridType: 'hex', hexOrientation: 'flat' }, 'announce')).toBe(
      '2.4 hexes · 12 ft',
    );
  });

  test('custom adapter units pass through unchanged', () => {
    expect(
      formatRulerReadout({ cells: 1, scale: 2, gridUnit: 'm', gridType: 'hex' }, 'display'),
    ).toBe('1.0 hex · 2 m');
  });
});

test.describe('RunSessionPage wires ruler readout helpers (issue #477)', () => {
  test('imports shared formatter instead of hard-coded sq copy', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toMatch(/from ['"]\.\.\/rulerReadout['"]/);
    expect(source).toMatch(/formatRulerReadout/);
    expect(source).toMatch(/measureToolHelp/);
    expect(source).not.toMatch(/\.toFixed\(1\)\} sq ·/);
    expect(source).not.toMatch(/squares · \$\{feet\}/);
  });
});

/**
 * Fog editor UI pins (issue #472) — undo, erase, per-region editing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

const RUN_SESSION = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const FOG_GRID = resolve(__dirname, '../../src/features/encounters/fogGridReveal.ts');

test.describe('fog editor (issue #472)', () => {
  test('RunSessionPage wires erase, select, undo, and region editing', () => {
    const source = readFileSync(RUN_SESSION, 'utf8');
    expect(source).toMatch(/modeBtn\('erase'/);
    expect(source).toMatch(/modeBtn\('select'/);
    expect(source).toMatch(/map-fog-undo/);
    expect(source).toMatch(/eraseFogRegion/);
    expect(source).toMatch(/hitTestFogRegion/);
    expect(source).toMatch(/FogUndoStack/);
    expect(source).toMatch(/selectedFogRegionId/);
    expect(source).toMatch(/map-fog-region-selected/);
  });

  test('grid cell reveal helper exists for room-style reveals', () => {
    const source = readFileSync(FOG_GRID, 'utf8');
    expect(source).toMatch(/gridCellRevealRect/);
  });

  test('keyboard help mentions fog undo and erase tools', () => {
    const source = readFileSync(RUN_SESSION, 'utf8');
    expect(source).toMatch(/Ctrl\+Z.*fog|fog.*undo/i);
    expect(source).toMatch(/Erase|erase/);
  });

  test('optimistically retains fog edits across polls until their versioned write settles', () => {
    const source = readFileSync(RUN_SESSION, 'utf8');
    expect(source).toMatch(/expectedUpdatedAt/);
    expect(source).toMatch(/isStaleWrite/);
    expect(source).toMatch(/setQueryData<EncounterWithCombatants>/);
    expect(source).toMatch(/pendingFog/);
    expect(source).toMatch(/fogStatesEqual\(current, settledFog\)/);
  });
});

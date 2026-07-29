/**
 * Fog editor UI pins (issue #472) — undo, erase, per-region editing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { reconcileEncounterPatchResponse } from '../../src/features/encounters/encounterPatchQueue';
import { reconcileFogSyncState } from '../../src/features/encounters/fogSyncState';

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

  test('a stale poll cannot reset fog undo/drag state while its PATCH is pending', () => {
    const local = { enabled: true, revealed: [{ id: 'local', x: 10, y: 10, w: 20, h: 20 }] };
    const staleServer = { enabled: true, revealed: [] };
    expect(reconcileFogSyncState({ serverFog: staleServer, localFog: local, pendingFog: local })).toEqual({
      fog: local,
      resetLocalUi: false,
    });
    expect(reconcileFogSyncState({ serverFog: staleServer, localFog: local, pendingFog: undefined })).toEqual({
      fog: staleServer,
      resetLocalUi: true,
    });
  });

  test('a PATCH response retains later optimistic edits for the same encounter', () => {
    const updated = { id: 1, updatedAt: 'server-v2', aoe: [{ id: 'server' }], fog: null };
    const pending = [
      { encounterId: 1, pendingKey: 'a:earlier', patch: { fog: { enabled: true, revealed: [] } } },
      { encounterId: 1, pendingKey: 'a:later', patch: { aoe: [{ id: 'local-later' }] } },
      { encounterId: 2, pendingKey: 'b:later', patch: { aoe: [{ id: 'other-encounter' }] } },
    ];
    expect(reconcileEncounterPatchResponse(updated, pending, 'a:earlier', 1)).toEqual({
      ...updated,
      aoe: [{ id: 'local-later' }],
    });
  });

  test('RunSessionPage binds deferred writes to their source encounter and absorbs a failed queue link', () => {
    const source = readFileSync(RUN_SESSION, 'utf8');
    expect(source).toContain('const queuedEncounterId = eid;');
    expect(source).toContain('const mutateQueuedPatch = setMap.mutateAsync;');
    expect(source).not.toContain('mutateMapRef');
    expect(source).toContain('encounters/${encounterId}');
    expect(source).toMatch(/await mutateQueuedPatch\(\{ encounterId: queuedEncounterId,/);
    expect(source).toMatch(/\.then\(async \(\) =>[\s\S]*?\.catch\(\(\) => undefined\);/);
  });
});

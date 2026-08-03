/**
 * ResourceTrackerPanel: rest engine wiring + awaited/invalidated/error-handled pip
 * writes (issue #1902). Pure unit suite via pw-unit (no server / browser) — exercises
 * the request-body shapes and the gating matrix the component wires into `useMutation`s.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  canEditCharacterResource,
  hasTrackedResources,
  resourcePatchBody,
  restRequestBody,
  spellSlotPatchBody,
} from '../../src/features/encounters/resourceTrackerLogic';

const PANEL = resolve(__dirname, '../../src/features/encounters/ResourceTrackerPanel.tsx');

test.describe('resourceTrackerLogic (issue #1902)', () => {
  test('restRequestBody posts { type } for short and long rest — the real RestPatch shape', () => {
    expect(restRequestBody('short')).toEqual({ type: 'short' });
    expect(restRequestBody('long')).toEqual({ type: 'long' });
  });

  test('resourcePatchBody sends the flat ResourcePatch shape, not { [key]: {...} }', () => {
    expect(resourcePatchBody('kiPoints', 3)).toEqual({ key: 'kiPoints', used: 3 });
  });

  test('spellSlotPatchBody sends { level, delta } relative to current used, not { [level]: {...} }', () => {
    // Spending one slot: used 1 -> 2 is delta +1.
    expect(spellSlotPatchBody(3, 1, 2)).toEqual({ level: 3, delta: 1 });
    // Restoring a slot: used 2 -> 0 is delta -2.
    expect(spellSlotPatchBody(3, 2, 0)).toEqual({ level: 3, delta: -2 });
  });

  test('gating matrix: DM edits any character; owning player edits only their own; others read-only', () => {
    const ownedCharacterIds = new Set([42]);

    // DM can edit any character, owned or not.
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: 42, ownedCharacterIds })).toBe(true);
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: 99, ownedCharacterIds })).toBe(true);

    // A player with write access can only edit their own character's combatant.
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: true, characterId: 42, ownedCharacterIds })).toBe(true);
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: true, characterId: 99, ownedCharacterIds })).toBe(false);

    // A viewer (no player write) never edits, even their "own" character id.
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: false, characterId: 42, ownedCharacterIds })).toBe(false);

    // A statblock-only combatant has no owner (characterId null) — only the DM may edit it.
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: true, characterId: null, ownedCharacterIds })).toBe(false);
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: null, ownedCharacterIds })).toBe(true);
  });

  test('hasTrackedResources: renders nothing for a combatant with no resources and no spell slots', () => {
    expect(hasTrackedResources({}, {})).toBe(false);
    expect(hasTrackedResources({ rage: { used: 0, max: 3 } }, {})).toBe(true);
    expect(hasTrackedResources({}, { '1': { used: 0, max: 4 } })).toBe(true);
  });

  test('ResourceTrackerPanel has no placeholder rest handler and no "Reset All" control', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).not.toMatch(/Placeholder/);
    expect(src).not.toMatch(/Reset All/);
  });

  test('ResourceTrackerPanel awaits every write mutation and surfaces errors via translateApiError', () => {
    const src = readFileSync(PANEL, 'utf8');
    // useMutation-based writes, not fire-and-forget api.post/api.patch calls.
    expect(src).toMatch(/useMutation/);
    expect(src).toMatch(/translateApiError/);
    // Every write invalidates the encounter + campaign-character reads (issue #1902's
    // "sheet and encounter panel agree" requirement) rather than relying on SSE alone.
    expect(src).toMatch(/invalidateEncounter/);
    expect(src).toMatch(/invalidateCampaignCharacters/);
  });

  test('ResourceTrackerPanel gates rest/pip controls on canEditCharacterResource, not canDmWrite alone', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/canEditCharacterResource/);
  });
});

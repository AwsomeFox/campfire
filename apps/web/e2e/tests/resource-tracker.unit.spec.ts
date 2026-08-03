/**
 * ResourceTrackerPanel: rest engine wiring + awaited/invalidated/error-handled pip
 * writes (issue #1902). Pure unit suite via pw-unit (no server / browser) — exercises
 * the request-body shapes and the gating matrix the component wires into `useMutation`s.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { ruleSystemAdapter, restOptionsForAdapter } from '@campfire/schema';
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

  // Rework finding B (codex P1): a Starfinder campaign's adapter declares stamina/night
  // rests, not short/long — restRequestBody must accept whatever restOptionsForAdapter
  // hands it, not just the generic 5e-shaped pair.
  test('restRequestBody accepts every type restOptionsForAdapter can hand it, generic and Starfinder alike', () => {
    const generic = restOptionsForAdapter(ruleSystemAdapter('dnd5e'));
    expect(generic.map((o) => o.type)).toEqual(['short', 'long']);
    for (const opt of generic) expect(restRequestBody(opt.type)).toEqual({ type: opt.type });

    const starfinder = restOptionsForAdapter(ruleSystemAdapter('starfinder-1e'));
    expect(starfinder.map((o) => o.type)).toEqual(['stamina', 'night']);
    for (const opt of starfinder) expect(restRequestBody(opt.type)).toEqual({ type: opt.type });
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
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: 42, ownedCharacterIds, encounterWritable: true })).toBe(true);
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: 99, ownedCharacterIds, encounterWritable: true })).toBe(true);

    // A player with write access can only edit their own character's combatant.
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: true, characterId: 42, ownedCharacterIds, encounterWritable: true })).toBe(true);
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: true, characterId: 99, ownedCharacterIds, encounterWritable: true })).toBe(false);

    // A viewer (no player write) never edits, even their "own" character id.
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: false, characterId: 42, ownedCharacterIds, encounterWritable: true })).toBe(false);

    // A statblock-only combatant has no owner (characterId null) — only the DM may edit it,
    // and only while the encounter is still writable.
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: true, characterId: null, ownedCharacterIds, encounterWritable: true })).toBe(false);
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: null, ownedCharacterIds, encounterWritable: true })).toBe(true);
  });

  // Second-round finding (devin, re-review): a statblock (monster) combatant's pips write
  // through the encounter's combatant PATCH, which the server rejects once the encounter
  // has ended — that must disable the control, even for the DM. A character-linked
  // combatant's pips write straight to the character SHEET instead, so an ended encounter
  // must NOT disable those (resting/spending a resource on your own sheet after the fight
  // is still meaningful).
  test('canEditCharacterResource disables a statblock combatant once the encounter has ended, but never a character-linked one', () => {
    const ownedCharacterIds = new Set([42]);

    // Statblock (characterId null): DM loses write once the encounter has ended.
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: null, ownedCharacterIds, encounterWritable: false })).toBe(false);
    // ...but keeps it while the encounter is still running/preparing.
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: null, ownedCharacterIds, encounterWritable: true })).toBe(true);

    // Character-linked (characterId set): the ended-encounter gate does not apply — the
    // DM and the owning player both keep write access to the SHEET regardless.
    expect(canEditCharacterResource({ canDmWrite: true, canPlayerWrite: false, characterId: 42, ownedCharacterIds, encounterWritable: false })).toBe(true);
    expect(canEditCharacterResource({ canDmWrite: false, canPlayerWrite: true, characterId: 42, ownedCharacterIds, encounterWritable: false })).toBe(true);
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

  // Rework finding B (codex P1): rest buttons must be driven by the campaign's adapter,
  // not a hardcoded short/long pair — mirrors CharacterPage's RestControls pattern.
  test('ResourceTrackerPanel resolves the campaign adapter and renders restOptionsForAdapter, not a hardcoded short/long pair', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/ruleSystemAdapter/);
    expect(src).toMatch(/restOptionsForAdapter/);
    expect(src).toMatch(/useCampaign/);
    // No more hardcoded `kind: 'short'` / `kind: 'long'` mutate() call sites.
    expect(src).not.toMatch(/kind: 'short'/);
    expect(src).not.toMatch(/kind: 'long'/);
  });

  // Rework finding C (codex P1 + devin, independently): a spell-slot pip sends a DELTA
  // relative to the rendered `used`. The fix reconciles the query cache from the
  // mutation's response instead of waiting on the fire-and-forget invalidate() refetch,
  // so a click right after settle computes its delta against server-fresh state.
  test('ResourceTrackerPanel reconciles spell-slot cache from the mutation response before invalidating', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/api\.post<Character>\(`\$\{API\}\/characters\/\$\{characterId\}\/spell-slots`/);
    expect(src).toMatch(/queryClient\.setQueryData<Character\[\]>\(queryKeys\.campaignCharacters/);
  });

  // Rework finding E (copilot): statblockMutation backs both resource and spell-slot
  // writes for statblock-only combatants; onError must not always blame "resource".
  test('ResourceTrackerPanel picks the slot vs resource error key by mutation kind, not a single hardcoded fallback', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/variables\.kind === 'slot'/);
    expect(src).toMatch(/kind: 'resource'/);
    expect(src).toMatch(/kind: 'slot'/);
  });

  // Rework finding F (copilot + devin, independently): the Party Rest shortcut must be an
  // in-app React Router navigation, not a raw anchor that full-reloads and drops live
  // encounter/SSE state (and breaks under a router basename).
  test('ResourceTrackerPanel\'s Party Rest control is a React Router Link, not a raw anchor', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/import \{ Link \} from 'react-router-dom'/);
    expect(src).toMatch(/<Link to=\{`\/c\/\$\{campaignId\}\/party`\}/);
    expect(src).not.toMatch(/<a href=\{`\/c\/\$\{campaignId\}\/party`\}/);
  });

  // Second-round finding (devin, re-review of the rework commit): a renamed combatant
  // must keep showing its OWN name here, not the linked character sheet's name — the
  // combatant list, initiative order, and combat log all key off the combatant's name.
  test('ResourceTrackerPanel rows use the combatant\'s own name, never the linked character sheet\'s name', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/const name = c\.name;/);
    expect(src).not.toMatch(/name = char\.name/);
  });

  // Second-round finding (codex P1, re-review): `useCampaign` can still be resolving
  // when this panel first mounts, and `ruleSystemAdapter(undefined)` falls back to 5e —
  // rest controls must wait for the real campaign before offering short/long as if that
  // were confirmed to be the ruleset.
  test('ResourceTrackerPanel gates rest controls on the campaign having actually resolved', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/campaignResolved/);
    expect(src).toMatch(/campaignId == null \|\| campaign != null/);
  });

  // Second-round finding (codex P2, re-review): a Stamina Rest button must not be offered
  // when the character has no RP to spend it — CharactersService.rest() rejects it, so an
  // enabled button here is a guaranteed-failing action. Mirrors CharacterPage's guard.
  test('ResourceTrackerPanel disables Stamina Rest when the character has no Resolve Points', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/opt\.type === 'stamina' && rpCurrent != null && rpCurrent < 1/);
  });

  // Third-round finding (codex P2, re-review of the round-2 push): restMutation must
  // reconcile the rest endpoint's response the same way slotMutation already does, or a
  // Stamina Rest / Night's Rest button can render enabled/disabled against the pre-rest
  // rpCurrent for the brief window between mutation settle and invalidate()'s refetch.
  test('ResourceTrackerPanel reconciles the rest response into the campaign-character cache before invalidating', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/api\.post<Character>\(`\$\{API\}\/characters\/\$\{characterId\}\/rest`/);
    // Both restMutation and slotMutation now reconcile from their response — two call sites.
    const setQueryDataCalls = src.match(/queryClient\.setQueryData<Character\[\]>\(queryKeys\.campaignCharacters/g) ?? [];
    expect(setQueryDataCalls.length).toBeGreaterThanOrEqual(2);
  });

  // Third-round finding (devin, re-review): a monster/statblock combatant's pips must be
  // disabled once the encounter has ended, or every click 409s with a visible error. The
  // panel threads an `encounterWritable` prop (encounter.status !== 'ended' at the call
  // site) into canEditCharacterResource — see the gating-matrix test above for the pure
  // logic, and the RunSessionPage call site for where it's derived.
  test('ResourceTrackerPanel accepts and threads an encounterWritable prop into canEditCharacterResource', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/encounterWritable: boolean/);
    expect(src).toMatch(/encounterWritable,\s*\n\s*\}\);/);

    const runSessionSrc = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(runSessionSrc).toMatch(/<ResourceTrackerPanel[^>]*encounterWritable=\{encounter\.status !== 'ended'\}/);
  });

  // Third-round finding (devin, re-review): `shortRest`/`longRest` i18n keys were dead —
  // rest button wording comes from the rule-system adapter's RestOptionDef (`opt.label`),
  // never from these keys. Removed from both en and ar catalogues.
  test('the dead shortRest/longRest i18n keys are gone from the resourceTracker namespace', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../src/i18n/locales/en/encounters.json'), 'utf8'));
    expect(en.encounters.resourceTracker.shortRest).toBeUndefined();
    expect(en.encounters.resourceTracker.longRest).toBeUndefined();
    // partyRest/confirmRest ARE still used (the Party Rest link, and the rest confirm
    // dialog wraps opt.label) — only the dead pair should be gone.
    expect(en.encounters.resourceTracker.partyRest).toBeDefined();
    expect(en.encounters.resourceTracker.confirmRest).toBeDefined();
  });
});

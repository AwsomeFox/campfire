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
  pendingTargetKey,
  addPendingKey,
  removePendingKey,
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

  test('spellSlotPatchBody sends { level, delta, expectedUpdatedAt } relative to current used, not { [level]: {...} }', () => {
    // Spending one slot: used 1 -> 2 is delta +1.
    expect(spellSlotPatchBody(3, 1, 2, '2026-01-01T00:00:00.000Z')).toEqual({ level: 3, delta: 1, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    // Restoring a slot: used 2 -> 0 is delta -2.
    expect(spellSlotPatchBody(3, 2, 0, '2026-01-01T00:00:00.000Z')).toEqual({ level: 3, delta: -2, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
  });

  // Third review pass on this exact defect (P1, codex): `delta` alone was still racy
  // against an EXTERNAL write between render and request — the round-1 cache-
  // reconciliation fix only protects THIS client's own successive clicks. This is a real
  // compare-and-set: the server rejects the write with 409 STALE_WRITE when
  // `expectedUpdatedAt` no longer matches the character's stored `updatedAt`.
  test('spellSlotPatchBody carries expectedUpdatedAt as a real compare-and-set token, not a client-side mitigation', () => {
    const body = spellSlotPatchBody(2, 0, 1, 'sheet-updated-at-token');
    expect(body.expectedUpdatedAt).toBe('sheet-updated-at-token');
  });

  // Seventh-round finding (kilo-code-bot, two independent threads on the call site and
  // the function signature): `expectedUpdatedAt` must be `string | undefined`, matching
  // the schema's own optional `ExpectedUpdatedAt` and the server's documented
  // unconditional-write fallback — not a bare `string` a caller has to lie to the type
  // checker about via `as string` when the linked character hasn't resolved yet.
  test('spellSlotPatchBody accepts undefined expectedUpdatedAt honestly, without a caller-side cast', () => {
    const body = spellSlotPatchBody(2, 0, 1, undefined);
    expect(body).toEqual({ level: 2, delta: 1, expectedUpdatedAt: undefined });
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
    expect(src).toMatch(/api\.post<Character>\(\s*\n\s*`\$\{API\}\/characters\/\$\{characterId\}\/spell-slots`/);
    expect(src).toMatch(/queryClient\.setQueryData<Character\[\]>\(queryKeys\.campaignCharacters/);
  });

  // Fifth-round finding (devin): resourceMutation was the ONE write path that did not
  // reconcile its response into the cache — every spell-slot write sends
  // `expectedUpdatedAt`, so a resource write leaving the cached `updatedAt` stale (until
  // invalidate()'s async refetch lands) made the very next spell-slot click on the SAME
  // character 409 as a false "someone else changed this" — a self-inflicted conflict on
  // the single most ordinary interaction in the panel (spend a feature, then spend a
  // slot). All three writers now share one `reconcileCharacter` helper.
  test('ResourceTrackerPanel reconciles resourceMutation\'s response too, so a resource-then-slot sequence never self-conflicts', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/api\.post<Character>\(`\$\{API\}\/characters\/\$\{characterId\}\/resources`/);
    expect(src).toMatch(/const reconcileCharacter = \(updated: Character\) => \{/);
    // All three character-sheet writers (rest, resource, slot) call the shared helper.
    const reconcileCalls = src.match(/reconcileCharacter\(updated\);/g) ?? [];
    expect(reconcileCalls.length).toBe(3);
  });

  // Sixth-round finding (devin): statblockMutation PATCHes the ENTIRE saved statblock
  // object, composed from `c.statblock` as it currently sits in the encounter query
  // cache. Without reconciling the response, a second click on the SAME monster (even
  // just after the first settled, before invalidate()'s async refetch lands) rebuilt
  // the statblock from pre-write data and silently reverted the first saved change.
  // `reconcileCombatant` is the statblock-side equivalent of `reconcileCharacter`.
  test('ResourceTrackerPanel reconciles statblockMutation\'s response into the encounter cache, so two clicks on the same monster never revert each other', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/api\.patch<Combatant>\(`\$\{API\}\/encounters\/\$\{encounterId\}\/combatants\/\$\{combatantId\}`/);
    expect(src).toMatch(/const reconcileCombatant = \(updated: Combatant\) => \{/);
    expect(src).toMatch(/queryClient\.setQueryData<EncounterWithCombatants>\(queryKeys\.encounter\(encounterId\)/);
    expect(src).toMatch(/reconcileCombatant\(updated\);/);
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
    // Fifth round consolidated the per-mutation setQueryData calls into one shared
    // `reconcileCharacter` helper (see the dedicated test for that) — restMutation calls
    // it, same as slotMutation and (as of round 5) resourceMutation.
    expect(src).toMatch(/reconcileCharacter\(updated\);/);
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

  // Fourth-round finding (devin, re-review of the round-3 push): a blanket `isPending`
  // (OR of all four mutation hooks) disabled every combatant's controls whenever ANY
  // single write anywhere in the panel was in flight — a slow save for one character
  // visibly locked out every other player's controls at the table.
  test('pendingTargetKey scopes pending state per character/combatant, immutably', () => {
    const empty: ReadonlySet<string> = new Set();

    // Alice's (characterId 1) write is added — Bob's (characterId 2) key must NOT be
    // present, but a DIFFERENT control on Alice's SAME character (round 6: any control,
    // not just the exact resource/slot) IS blocked too — see the dedicated round-6 test
    // below for why finer-than-target scoping (rounds 4/5) let two writes to the SAME
    // row race past each other.
    const withAlice = addPendingKey(empty, pendingTargetKey({ characterId: 1 }));
    expect(withAlice.has(pendingTargetKey({ characterId: 1 }))).toBe(true);
    expect(withAlice.has(pendingTargetKey({ characterId: 2 }))).toBe(false);

    // Immutable: the original set is untouched by add.
    expect(empty.size).toBe(0);

    // Removing a key that isn't present is a no-op (returns an equivalent, possibly the
    // SAME, set) rather than throwing.
    const stillWithAlice = removePendingKey(withAlice, pendingTargetKey({ characterId: 2 }));
    expect(stillWithAlice.has(pendingTargetKey({ characterId: 1 }))).toBe(true);

    const withoutAlice = removePendingKey(withAlice, pendingTargetKey({ characterId: 1 }));
    expect(withoutAlice.has(pendingTargetKey({ characterId: 1 }))).toBe(false);
    // Immutable the other direction too: removal didn't touch the set it was called on.
    expect(withAlice.has(pendingTargetKey({ characterId: 1 }))).toBe(true);
  });

  // Sixth-round finding (codex P2): rounds 4/5 keyed pending state per RESOURCE/SLOT, so
  // a rest/resource write and a spell-slot write on the SAME character could race past
  // each other — the second one's `expectedUpdatedAt` (captured before the first
  // committed) is stale by the time it lands, rejected with a self-inflicted "someone
  // else changed this". `pendingTargetKey` collapses ALL of a character's controls (or
  // ALL of a statblock combatant's pips) to ONE key, serializing them against each other,
  // while a DIFFERENT character/combatant stays fully independent.
  test('pendingTargetKey serializes every control on the SAME character, but keeps different characters independent', () => {
    // Same character (1): a rest write and a resource write share ONE key.
    expect(pendingTargetKey({ characterId: 1 })).toBe(pendingTargetKey({ characterId: 1 }));
    // Different characters never collide.
    expect(pendingTargetKey({ characterId: 1 })).not.toBe(pendingTargetKey({ characterId: 2 }));
    // A statblock combatant's resource pip and spell-slot pip also share ONE key now —
    // sixth-round finding (devin): a second click on the SAME monster while the first is
    // still in flight must be blocked, or it composes its whole-statblock PATCH from a
    // snapshot that doesn't yet include the first write, silently reverting it.
    expect(pendingTargetKey({ combatantId: 7 })).toBe(pendingTargetKey({ combatantId: 7 }));
    // A character-linked target and a statblock target never collide even with the same
    // numeric id, since the two scopes are namespaced separately.
    expect(pendingTargetKey({ characterId: 7 })).not.toBe(pendingTargetKey({ combatantId: 7 }));
  });

  // Fifth-round finding (devin): TWO CONCURRENT calls of the SAME mutation kind (rest
  // Alice, then rest Bob, before Alice's settles) must BOTH stay tracked as pending — a
  // single `useMutation` hook's own `isPending`/`variables` describe only the newest
  // call, which is exactly the bug this replaces. Simulating the onMutate/onSettled
  // sequence the component wires up: two `beginPending`s for different targets must
  // BOTH be visible at once, and each `endPending` must remove only its own target.
  test('add/removePendingKey support two concurrent same-kind mutations without losing track of either', () => {
    let keys: ReadonlySet<string> = new Set();
    // Alice's rest starts.
    keys = addPendingKey(keys, pendingTargetKey({ characterId: 1 }));
    // Bob's rest starts BEFORE Alice's settles — both must be tracked.
    keys = addPendingKey(keys, pendingTargetKey({ characterId: 2 }));
    expect(keys.has(pendingTargetKey({ characterId: 1 }))).toBe(true);
    expect(keys.has(pendingTargetKey({ characterId: 2 }))).toBe(true);

    // Bob's settles first — only Bob's key is removed, Alice's request is still pending.
    keys = removePendingKey(keys, pendingTargetKey({ characterId: 2 }));
    expect(keys.has(pendingTargetKey({ characterId: 1 }))).toBe(true);
    expect(keys.has(pendingTargetKey({ characterId: 2 }))).toBe(false);

    // Alice's settles — nothing left pending.
    keys = removePendingKey(keys, pendingTargetKey({ characterId: 1 }));
    expect(keys.size).toBe(0);
  });

  test('ResourceTrackerPanel tracks pending state itself via onMutate/onSettled, keyed per target (not per resource/slot)', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/useState<ReadonlySet<string>>\(new Set\(\)\)/);
    expect(src).toMatch(/onMutate: \(vars\) => beginPending\(pendingTargetKey\(/);
    expect(src).toMatch(/onSettled: \(_data, error, vars\) => endPendingAfterReconciling\(pendingTargetKey\(/);
    expect(src).toMatch(/pendingKeys\.has\(pendingTargetKey\(scope\)\)/);
    // The blanket boolean, the round-4 hook-snapshot derivation, AND the round-4/5
    // per-resource/per-slot key builders are all gone.
    expect(src).not.toMatch(/const isPending =/);
    expect(src).not.toMatch(/pendingResourceKeys\(/);
    expect(src).not.toMatch(/restPendingKey\(/);
    expect(src).not.toMatch(/resourcePendingKey\(/);
    expect(src).not.toMatch(/slotPendingKey\(/);
  });

  // Ninth-round finding (codex P2): an AMBIGUOUS mutation outcome (response lost to a
  // timeout/network drop) must not release the control the instant the promise settles —
  // for an irreplaceable resource (a Stamina Rest's RP, a spell slot, a hit die), a
  // "harmless" retry after a lost response can silently spend it twice. RunSessionPage's
  // own `isAmbiguousOutcome` reconciliation guard exists for exactly this failure class;
  // this panel now applies the same principle via its own pending-key mechanism instead
  // of releasing on every settle unconditionally.
  test('ResourceTrackerPanel keeps a control pending through a fresh read after an ambiguous (not a definite) mutation failure', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/import \{ .*isAmbiguousMutation.* \} from '\.\.\/\.\.\/lib\/api'/);
    // Round 23: a 4th param, `needsCharacters = true`, so a target that doesn't depend on
    // campaignCharacters (a monster statblock) isn't gated on it.
    expect(src).toMatch(
      /const endPendingAfterReconciling = async \(key: string, error: unknown, forceReconcile = false, needsCharacters = true\) => \{/,
    );
    expect(src).toMatch(/if \(forceReconcile \|\| \(error && \(isAmbiguousMutation\(error\) \|\| isStaleWrite\(error\)\)\)\)/);
    // All four mutations route their onSettled through the reconciling variant, not the
    // bare endPending (which would release the control before confirming true state).
    const endPendingAfterReconcilingCalls = src.match(/endPendingAfterReconciling\(pendingTargetKey/g) ?? [];
    expect(endPendingAfterReconcilingCalls.length).toBe(4);
  });

  // Fourteenth-round finding (codex P3, hardening the ambiguous/stale-write path): awaiting
  // `Promise.allSettled` around `invalidateQueries()` only proves a refetch was ATTEMPTED —
  // `invalidateQueries()`'s own promise settles regardless of whether the underlying refetch
  // succeeded or failed. If the same outage that made a mutation ambiguous also breaks the
  // refetch, releasing anyway lets a retry proceed against the identical stale snapshot the
  // wait exists to rule out. The control must stay pending (never release) unless the
  // relevant queries are confirmed NOT in an error state.
  test('ResourceTrackerPanel does not release a pending control if reconciliation itself could not confirm fresh state', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/const encounterOk = queryClient\.getQueryState\(queryKeys\.encounter\(encounterId\)\)\?\.status !== 'error';/);
    // Round 23: charactersOk is only demanded when this target actually needs it.
    expect(src).toMatch(
      /const charactersOk = !needsCharacters \|\| campaignId == null \|\| queryClient\.getQueryState\(queryKeys\.campaignCharacters\(campaignId\)\)\?\.status !== 'error';/,
    );
    // Round 22: the stuck-set stores whether the outcome was ambiguous; round 23 adds
    // whether this target needed campaignCharacters at all.
    expect(src).toMatch(
      /if \(!encounterOk \|\| !charactersOk\) \{\s*\n\s*stuckKeysRef\.current\.set\(key, \{ wasAmbiguous, needsCharacters \}\);\s*\n\s*return;\s*\n\s*\}/,
    );
  });

  // Sixteenth-round finding (codex P2 + devin, same root cause): staying pending on a failed
  // reconciliation (round 14) had NO escape hatch — nothing ever re-evaluated the query
  // states afterward, so a control could stay disabled for the rest of the page's life after
  // one transient refetch failure, even once the network/server recovered. Worse for
  // `statblockMutation` specifically, since it forces this path on every success too, not
  // just on an error. A query-cache subscription must release every stuck key the moment the
  // relevant queries actually recover, without a bounded retry loop or a new UI affordance.
  test('ResourceTrackerPanel automatically releases a stuck-pending control once the relevant queries actually recover', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/import \{ useEffect, useRef, useState \} from 'react';/);
    // Round 22/23: a Map keyed on wasAmbiguous + needsCharacters, not a bare Set, so the
    // release below can decide both whether to reclassify a failure banner AND whether this
    // key's release requires campaignCharacters to be healthy too.
    expect(src).toMatch(
      /const stuckKeysRef = useRef<Map<string, \{ wasAmbiguous: boolean; needsCharacters: boolean \}>>\(new Map\(\)\);/,
    );
    // Eighteenth-round finding (codex P2): a PASSIVE query-cache subscription (round 16)
    // is unsound — an UNRELATED character's mutation calling `setQueryData` on the SAME
    // `campaignCharacters` key flips its overall status to 'success' too, even though the
    // STUCK character's own row was never actually refetched from the server. Releasing
    // every stuck key off the back of someone else's optimistic write lets the original
    // action retry against genuinely still-stale data. An ACTIVE, interval-driven
    // `refetchQueries` call is unambiguous — always a real network round-trip, never a
    // local cache write — so only ITS OWN resolution may be trusted.
    expect(src).toMatch(/const interval = setInterval\(\(\) => \{/);
    expect(src).toMatch(/queryClient\.refetchQueries\(\{ queryKey: queryKeys\.encounter\(encounterId\) \}\)/);
    expect(src).toMatch(/campaignId != null \? queryClient\.refetchQueries\(\{ queryKey: queryKeys\.campaignCharacters\(campaignId\) \}\)/);
    expect(src).toMatch(/const encounterOk = queryClient\.getQueryState\(queryKeys\.encounter\(encounterId\)\)\?\.status !== 'error';/);
    expect(src).toMatch(/const charactersOk = campaignId == null \|\| queryClient\.getQueryState\(queryKeys\.campaignCharacters\(campaignId\)\)\?\.status !== 'error';/);
    // Round 23: release is decided PER KEY, not all-or-nothing — a stuck key whose own
    // `needsCharacters` is false only needs `encounterOk` to be released.
    expect(src).toMatch(
      /if \(encounterOk && \(!entry\.needsCharacters \|\| charactersOk\)\) releasing\.set\(key, entry\.wasAmbiguous\);\s*\n\s*else stillStuck\.set\(key, entry\);/,
    );
    // The interval actually releases the stuck keys from pendingKeys, not just clears its
    // own bookkeeping.
    expect(src).toMatch(/for \(const key of releasing\.keys\(\)\) next = removePendingKey\(next, key\);/);
    // Cleans up the interval on unmount.
    expect(src).toMatch(/return \(\) => clearInterval\(interval\);/);
  });

  /**
   * Issue #1902 rework, round 22 (codex P2, reviewer-caught) — an ambiguous mutation's
   * `onError` sets a definite-failure banner before the outcome is actually known; if
   * `endPendingAfterReconciling`'s reconciliation later confirms fresh state (whether
   * immediately, or after a stuck-key auto-release), the write may well have landed, so the
   * banner must be replaced with an outcome-unresolved message rather than left claiming a
   * failure that invites a wasted (and potentially double-spending) retry. A stale-write 409
   * is a genuine, confirmed rejection and is deliberately excluded — that banner stays as-is.
   */
  test('ResourceTrackerPanel reclassifies (does not just clear) a failure banner once an ambiguous mutation is confirmed reconciled', () => {
    const src = readFileSync(PANEL, 'utf8');
    // A dedicated setter, keyed the same defensive way as clearErrorFor/setErrorFor — only
    // replaces the banner if THIS key's failure is still the one showing.
    expect(src).toMatch(
      /const setAmbiguousResolvedFor = \(key: string\) =>\s*\n\s*setError\(\(prev\) => \(prev\?\.key === key \? \{ key, message: t\('encounters\.resourceTracker\.ambiguousResolved'\) \} : prev\)\);/,
    );
    // Computed once per reconciliation call, explicitly excluding stale-write (a genuine,
    // confirmed rejection, not an unknown outcome).
    expect(src).toMatch(
      /const wasAmbiguous = error != null && isAmbiguousMutation\(error\) && !isStaleWrite\(error\);/,
    );
    // Direct (non-stuck) reconciliation path: fires right before releasing the key.
    expect(src).toMatch(/if \(wasAmbiguous\) setAmbiguousResolvedFor\(key\);\s*\n\s*\}\s*\n\s*endPending\(key\);/);
    // Stuck-key auto-release path: fires for every released key whose stored flag is true.
    expect(src).toMatch(/for \(const \[key, wasAmbiguous\] of releasing\) if \(wasAmbiguous\) setAmbiguousResolvedFor\(key\);/);
  });

  // Fourteenth-round finding (codex P1 + devin, same root cause): `statblockMutation`'s CAS
  // token is the ENCOUNTER's `updatedAt`, which its own `Combatant` response cannot refresh
  // (`reconcileCombatant` only writes the combatant into the encounter cache, not the
  // encounter's own `updatedAt`). Releasing the control immediately on SUCCESS (the same as
  // every other mutation) meant a second click before the async `invalidate()` refetch landed
  // resent the now-stale encounter revision and got a self-inflicted 409 — reproducible by
  // just clicking a monster's pip twice in a row. `statblockMutation` must force the same
  // reconcile-before-release path the other three mutations only take on ambiguous/stale
  // errors.
  test('ResourceTrackerPanel forces statblockMutation to reconcile before releasing even on success, since its CAS token is not in its own response', () => {
    const src = readFileSync(PANEL, 'utf8');
    // Round 23: a 4th arg (`false`) now says this target doesn't need campaignCharacters.
    expect(src).toMatch(/endPendingAfterReconciling\(pendingTargetKey\(\{ combatantId: vars\.combatantId \}\), error, true, false\)/);
  });

  /**
   * Issue #1902 rework (round 23, codex P2, reviewer-caught) — `endPendingAfterReconciling`
   * demanded `charactersOk` unconditionally, but a monster/NPC statblock combatant's own CAS
   * token and rendered state depend ONLY on the `encounter` query — `campaignCharacters` is
   * irrelevant to it. A DM's successful monster pip could therefore get stuck in
   * `stuckKeysRef` (and keep retrying every 5s) purely because an unrelated character-list
   * fetch was failing, locking up controls that never depended on that query.
   */
  test('ResourceTrackerPanel does not gate a target that does not need campaignCharacters on that query being healthy', () => {
    const src = readFileSync(PANEL, 'utf8');
    // needsCharacters defaults to true (the three character-scoped mutations keep the old
    // behavior unchanged), and narrows both the invalidation and the release check.
    expect(src).toMatch(
      /const endPendingAfterReconciling = async \(key: string, error: unknown, forceReconcile = false, needsCharacters = true\) => \{/,
    );
    expect(src).toMatch(
      /const charactersOk = !needsCharacters \|\| campaignId == null \|\| queryClient\.getQueryState\(queryKeys\.campaignCharacters\(campaignId\)\)\?\.status !== 'error';/,
    );
    // The stuck-key map now stores needsCharacters alongside wasAmbiguous, keyed per target.
    expect(src).toMatch(/stuckKeysRef\.current\.set\(key, \{ wasAmbiguous, needsCharacters \}\);/);
    // The auto-release interval evaluates release eligibility PER KEY (not all-or-nothing),
    // so a stuck monster key only needs encounterOk, never charactersOk.
    expect(src).toMatch(
      /if \(encounterOk && \(!entry\.needsCharacters \|\| charactersOk\)\) releasing\.set\(key, entry\.wasAmbiguous\);/,
    );
  });

  // Twelfth-round finding (codex P2): a definite 409 STALE_WRITE is not ambiguous (the write
  // definitely did not apply), but releasing the control immediately re-enables it holding the
  // SAME stale `used`/token the rejected request already used — guaranteeing an identical,
  // immediately-repeated failure on retry. `endPendingAfterReconciling` must treat a stale-write
  // conflict as reconciliation-required too, not just a genuinely ambiguous outcome.
  test('ResourceTrackerPanel also reconciles (does not just release) on a definite 409 STALE_WRITE conflict, not only an ambiguous outcome', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/import \{ .*isStaleWrite.* \} from '\.\.\/\.\.\/lib\/api'/);
    expect(src).toMatch(/isAmbiguousMutation\(error\) \|\| isStaleWrite\(error\)/);
  });

  // Twelfth-round finding (codex P2): a global single `error` string meant one mutation's
  // SUCCESS could silently clear a DIFFERENT, still-unresolved target's failure the user has
  // not acted on yet — the panel deliberately keeps different targets' pending state
  // independent (`pendingTargetKey`), but errors were not. Errors are now keyed to the target
  // that raised them; a success only clears the banner when it belongs to the SAME target.
  test('ResourceTrackerPanel scopes its error banner to the target that raised it, so an unrelated success cannot silently clear it', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/useState<\{ key: string; message: string \} \| null>\(null\)/);
    expect(src).toMatch(/const clearErrorFor = \(key: string\) => setError\(\(prev\) => \(prev\?\.key === key \? null : prev\)\)/);
    expect(src).toMatch(/const setErrorFor = \(key: string, message: string\) => setError\(\{ key, message \}\)/);
    // Every onSuccess clears by target key, not unconditionally; every onError sets by target key.
    expect(src).toMatch(/clearErrorFor\(pendingTargetKey\(\{ characterId: vars\.characterId \}\)\)/);
    expect(src).toMatch(/clearErrorFor\(pendingTargetKey\(\{ combatantId: vars\.combatantId \}\)\)/);
    expect(src).toMatch(/setErrorFor\(pendingTargetKey\(\{ characterId: vars\.characterId \}\), translateApiError/);
    expect(src).toMatch(/setErrorFor\(pendingTargetKey\(\{ combatantId: variables\.combatantId \}\), translateApiError/);
    // The render reads .message off the scoped error object, not the (now-removed) bare string.
    expect(src).toMatch(/<ErrorNote message=\{error\.message\} onDismiss=\{\(\) => setError\(null\)\}/);
  });

  // Twelfth-round finding (P1, devin): a whole-statblock PATCH (spent on a monster's resource
  // or spell-slot pip) sent no CAS token at all, so a stale cached combatant snapshot could
  // silently clobber another client's concurrent edit to the SAME statblock. `updateCombatant`
  // already validates `expectedUpdatedAt` against the ENCOUNTER row (there is no per-combatant
  // revision field) — thread the encounter's own `updatedAt` through, matching every other
  // `expectedUpdatedAt`-bearing combatant PATCH in the app.
  test('ResourceTrackerPanel sends expectedUpdatedAt (the encounter revision) on every statblock pip write', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/encounterUpdatedAt: string \| undefined;/);
    expect(src).toMatch(/expectedUpdatedAt,\s*\n\s*\}: \{\s*\n\s*combatantId: number;/);
    expect(src).toMatch(/\{ statblock, expectedUpdatedAt \}/);
    // Both call sites (resource pip and spell-slot pip) actually pass it — advertising the
    // field on the mutation without every call site supplying it would silently degrade back
    // to the unconditional write for whichever site forgot.
    const statblockMutateCalls = src.match(/statblockMutation\.mutate\(\{[\s\S]*?\}\);/g) ?? [];
    expect(statblockMutateCalls.length).toBe(2);
    for (const call of statblockMutateCalls) {
      expect(call).toMatch(/expectedUpdatedAt: encounterUpdatedAt/);
    }
  });

  // Fourth-round finding (codex P1, THIRD review pass on this exact defect): a
  // disabled-while-pending guard never closed this — the stale window is between RENDER
  // and REQUEST, not between click and response, so it can't be fixed by anything that
  // only reacts after a mutation starts. Verifies the structural fix: the panel actually
  // sends `expectedUpdatedAt` on every spell-slot write, sourced from the character's own
  // `updatedAt` captured in the same row-builder pass that reads `spellSlots`.
  test('ResourceTrackerPanel sends expectedUpdatedAt on every character spell-slot write — the real CAS fix, not another pending guard', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/expectedUpdatedAt: updatedAt,/);
    expect(src).toMatch(/let updatedAt: string \| undefined;/);
    expect(src).toMatch(/updatedAt = char\.updatedAt;/);
  });

  // Seventh-round finding (kilo-code-bot, two threads: the call site and the function
  // signature): `updatedAt as string` silently lied to the type checker — `updatedAt` is
  // genuinely `string | undefined` (unset when the linked character hasn't resolved).
  // The cast is gone; `updatedAt` flows through as-is to `spellSlotPatchBody`, which now
  // accepts `string | undefined` honestly (see the dedicated pure test above).
  test('ResourceTrackerPanel no longer casts updatedAt to string when sending expectedUpdatedAt', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).not.toMatch(/updatedAt as string/);
  });

  // Fourth-round finding (codex P2): the first successful resource pip click discarded a
  // tracked resource's `source` metadata by reconstructing the entry from only
  // max/used/name/recharge. Server-side fix in CharactersService.adjustResource, verified
  // here at the layer that owns the invariant.
  test('CharactersService.adjustResource preserves existing resource metadata (source) instead of rebuilding the entry', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../../apps/server/src/modules/characters/characters.service.ts'),
      'utf8',
    );
    // Typed against the shared CharacterResource contract (which carries `source`), not a
    // narrower server-local record that structurally can't hold it.
    expect(src).toMatch(/fromJsonText<Record<string, CharacterResource>>\(fresh\.resources, \{\}\)/);
    // The new entry starts from `...current` so an unmentioned field (source above all)
    // survives a plain used-only write.
    expect(src).toMatch(/resources\[patch\.key\] = \{\s*\n\s*\.\.\.current,/);
  });

  // Sixth-round finding (codex P2) — the LOAD-BEARING fix this round: `patchSpellSlots`
  // stamped its write with `nowIso()`, which can produce the IDENTICAL ISO string for two
  // writes inside the same millisecond. A caller holding the pre-write `expectedUpdatedAt`
  // token would then pass the compare-and-set check against a row THIS SECOND write just
  // produced — the CAS guard the whole rework depends on would look like it protected the
  // write while actually rejecting nothing. `nextUpdatedAt` guarantees monotonic
  // advancement even inside one millisecond, matching every other CAS-protected write in
  // the codebase. The behavioral guarantee (two same-millisecond writes actually produce
  // two DIFFERENT tokens) is exercised directly against the real helper in
  // `apps/server/test/integration/spell-slot-concurrency.spec.ts` — this is the
  // source-grep confirming `patchSpellSlots` actually calls it.
  test('CharactersService.patchSpellSlots stamps its CAS-protected write with nextUpdatedAt, not nowIso, so same-millisecond writes still advance the token', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../../apps/server/src/modules/characters/characters.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/import \{ nextUpdatedAt \} from '\.\.\/\.\.\/common\/stale-write';/);
    expect(src).toMatch(/spellSlots: toJsonText\(outcome\.slots\), updatedAt: nextUpdatedAt\(fresh\.updatedAt\)/);
  });

  // Eleventh-round finding (devin): `.filter((row) => hasTrackedResources(...))` dropped
  // the WHOLE row — name, rest buttons, everything — for a combatant with an empty
  // resources/spellSlots map (a martial with no hit-dice entry seeded, or a character
  // never written to). That silently made this PR's headline feature (rest buttons)
  // unreachable for exactly that character, even though resting them is valid. The panel
  // as a whole should still render nothing when NO combatant anywhere has resources or
  // spell slots (the stated acceptance criterion), but a row that only qualifies via its
  // rest buttons must not itself keep an otherwise-empty panel visible — the panel gate
  // and the row filter are intentionally two separate checks.
  test('ResourceTrackerPanel keeps a row (and its rest buttons) for an editable, character-linked combatant even with no tracked resources', () => {
    const src = readFileSync(PANEL, 'utf8');
    // The panel-level "anything to track at all" gate is computed from the UNFILTERED
    // row list, not the (now looser) `rows` the JSX renders — so it isn't accidentally
    // satisfied by a rest-only row.
    expect(src).toMatch(/const rowsAll = combatants/);
    expect(src).toMatch(/if \(!rowsAll\.some\(\(row\) => hasTrackedResources\(row\.resources, row\.spellSlots\)\)\) return null;/);
    // The row filter itself ORs in the rest-eligibility condition rather than checking
    // hasTrackedResources alone.
    expect(src).toMatch(
      /const rows = rowsAll\.filter\(\s*\n\s*\(row\) => hasTrackedResources\(row\.resources, row\.spellSlots\) \|\| \(row\.combatant\.kind === 'character' && row\.combatant\.characterId != null && row\.canEdit && campaignResolved && restOptions\.length > 0\),/,
    );
  });
});

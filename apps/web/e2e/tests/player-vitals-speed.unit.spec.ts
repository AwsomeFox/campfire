import { expect, test } from '@playwright/test';
import type { Combatant } from '@campfire/schema';
import { vitalsSpeedFor } from '../../src/features/encounters/PlayerVitalsHeader';

/**
 * Issue #1910 — PlayerVitalsHeader's speed display used to guess at an untyped
 * `(stats as any).speed`, which never resolved against the real (typed) schema
 * field and always fell through to a hardcoded '30' string. `vitalsSpeedFor`
 * matches the server's getTurnWorkspace resolution EXACTLY (PR #1980 round 4
 * review): the combatant's add-time snapshot, or the caller-supplied adapter
 * default — full stop, no character-sheet fallback. An earlier version of this
 * function fell through to the character's live speed when the snapshot was
 * null (Devin/Codex round 1: fixed the precedence when the snapshot IS set —
 * combatant before character), but a live-character fallback for a NULL
 * snapshot reintroduces the identical class of bug: `combatant.speed === null`
 * is ambiguous between "predates the column" and "the character had no speed
 * set at add time" (the common case, since Character.speed itself defaults to
 * null), and the server never falls through to the live character for that
 * ambiguous case either (see encounters.service.ts's getTurnWorkspace) — so
 * this component must not either, or the header would show a different number
 * than the turn panel enforces for that same combatant.
 */

function combatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: 1,
    encounterId: 1,
    kind: 'character',
    characterId: 1,
    npcId: null,
    name: 'Ari',
    initiative: 12,
    initMod: 2,
    initiativeBreakdown: null,
    initiativeGroup: null,
    hpCurrent: 10,
    hpMax: 10,
    spCurrent: 0,
    spMax: 0,
    rpCurrent: 0,
    rpMax: 0,
    eac: null,
    kac: null,
    speed: null,
    hpTemp: 0,
    hpBand: null,
    deathState: 'none',
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    conditions: [],
    ruleEntryId: null,
    sortOrder: 0,
    manualOrder: null,
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    turnState: {
      used: {},
      movementUsedFt: 0,
      concentration: null,
      pendingConcentrationChecks: [],
      delaying: false,
      readied: null,
    },
    activeEffects: [],
    conditionInstances: [],
    legendaryActions: null,
    statblock: null,
    statblockRevealed: false,
    ...overrides,
  };
}

test.describe('vitalsSpeedFor (issue #1910)', () => {
  test('the combatant add-time snapshot wins when set (Devin B / Codex round 1)', () => {
    expect(vitalsSpeedFor(combatant({ speed: 25 }), 30)).toBe(25);
  });

  // Round 4 review (Devin): a null snapshot must resolve to the adapter default,
  // NEVER a live character lookup — there is no character parameter to fall
  // through to any more, which is itself the fix. This pins the null case
  // directly rather than only exercising the (already-fixed) non-null case.
  test('a null snapshot resolves to the adapter default, matching the server (no character fallback exists)', () => {
    expect(vitalsSpeedFor(combatant({ speed: null }), 30)).toBe(30);
    expect(vitalsSpeedFor(combatant({ speed: null }), 25)).toBe(25);
  });

  test('returns null (not a fabricated 0) when the adapter has no movement slot at all (Copilot finding)', () => {
    expect(vitalsSpeedFor(combatant({ speed: null }), undefined)).toBeNull();
  });

  test('speed 0 (e.g. a homebrew immobilized state) is a real value, not treated as unset', () => {
    expect(vitalsSpeedFor(combatant({ speed: 0 }), 30)).toBe(0);
  });
});

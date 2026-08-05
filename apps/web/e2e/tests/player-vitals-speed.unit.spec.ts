import { expect, test } from '@playwright/test';
import type { Character, Combatant } from '@campfire/schema';
import { vitalsSpeedFor } from '../../src/features/encounters/PlayerVitalsHeader';

/**
 * Issue #1910 — PlayerVitalsHeader's speed display used to guess at an untyped
 * `(stats as any).speed`, which never resolved against the real (typed) schema
 * field and always fell through to a hardcoded '30' string. `vitalsSpeedFor`
 * replaces that guess with the real character/combatant `speed` fields, in the
 * SAME precedence order the server's getTurnWorkspace resolution uses (PR #1980
 * review — Devin/Codex finding: the client and server previously disagreed, so a
 * mid-fight sheet edit showed one number in the header and a different one in the
 * turn panel): combatant snapshot first, then the character's live speed, then the
 * caller-supplied adapter default (no more hardcoded 30 — Copilot/Codex finding).
 */

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: 1,
    campaignId: 1,
    ownerUserId: null,
    name: 'Ari',
    species: '',
    className: '',
    level: 1,
    xp: 0,
    background: '',
    status: 'active',
    stats: {},
    ac: null,
    eac: null,
    kac: null,
    speed: null,
    hpCurrent: 10,
    hpMax: 10,
    spCurrent: 0,
    spMax: 0,
    rpCurrent: 0,
    rpMax: 0,
    hpTemp: 0,
    deathState: 'none',
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    conditions: [],
    conditionInstances: [],
    saveProficiencies: [],
    skills: {},
    actions: [],
    spellSlots: {},
    resources: {},
    portraitUrl: null,
    ddbId: null,
    notes: '',
    dmSecret: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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
    ...overrides,
  };
}

test.describe('vitalsSpeedFor (issue #1910)', () => {
  test('the combatant add-time snapshot wins over the character sheet, matching the server precedence exactly (Devin B / Codex)', () => {
    // A mid-fight sheet edit (character.speed 40) must NOT override the frozen
    // combatant snapshot (25) — this is the exact inversion Devin/Codex flagged:
    // the header used to show 40 here while the turn panel enforced 25.
    expect(vitalsSpeedFor(character({ speed: 40 }), combatant({ speed: 25 }), 30)).toBe(25);
  });

  test('the character live speed is the fallback when the combatant has no snapshot', () => {
    expect(vitalsSpeedFor(character({ speed: 35 }), combatant({ speed: null }), 30)).toBe(35);
  });

  test('falls back to the caller-supplied adapter default (not a hardcoded 30) when neither has a speed set', () => {
    expect(vitalsSpeedFor(character({ speed: null }), combatant({ speed: null }), 30)).toBe(30);
    expect(vitalsSpeedFor(undefined, combatant({ speed: null }), 25)).toBe(25);
  });

  test('returns null (not a fabricated 0) when the adapter has no movement slot at all (Copilot finding)', () => {
    expect(vitalsSpeedFor(character({ speed: null }), combatant({ speed: null }), undefined)).toBeNull();
  });

  test('speed 0 (e.g. a homebrew immobilized state) is a real value, not treated as unset', () => {
    expect(vitalsSpeedFor(character({ speed: 0 }), combatant({ speed: null }), 30)).toBe(0);
    expect(vitalsSpeedFor(character({ speed: 40 }), combatant({ speed: 0 }), 30)).toBe(0);
  });
});

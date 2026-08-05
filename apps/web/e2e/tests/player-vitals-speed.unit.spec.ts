import { expect, test } from '@playwright/test';
import type { Character, Combatant } from '@campfire/schema';
import { vitalsSpeedFor } from '../../src/features/encounters/PlayerVitalsHeader';

/**
 * Issue #1910 — PlayerVitalsHeader's speed display used to guess at an untyped
 * `(stats as any).speed`, which never resolved against the real (typed) schema
 * field and always fell through to a hardcoded '30' string. `vitalsSpeedFor`
 * replaces that guess with the real character/combatant `speed` fields.
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
  test('the character sheet speed wins when set (mirrors the AC lookup precedent in this file)', () => {
    expect(vitalsSpeedFor(character({ speed: 25 }), combatant({ speed: 40 }))).toBe(25);
  });

  test('a combatant add-time snapshot is the fallback when the character record has no speed', () => {
    expect(vitalsSpeedFor(character({ speed: null }), combatant({ speed: 35 }))).toBe(35);
  });

  test('falls back to the untouched 30 default when neither has a speed set', () => {
    expect(vitalsSpeedFor(character({ speed: null }), combatant({ speed: null }))).toBe(30);
    expect(vitalsSpeedFor(undefined, combatant({ speed: null }))).toBe(30);
  });

  test('speed 0 (e.g. a homebrew immobilized state) is a real value, not treated as unset', () => {
    expect(vitalsSpeedFor(character({ speed: 0 }), combatant({ speed: 40 }))).toBe(0);
  });
});

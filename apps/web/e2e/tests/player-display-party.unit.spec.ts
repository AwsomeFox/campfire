import { expect, test } from '@playwright/test';
import type { Character } from '@campfire/schema';
import { safeCharacter, safeParty } from '../../src/features/screen/playerSafe';

/**
 * Issue #824 — Player Display Party filters inactive/retired/dead PCs by default,
 * prefers participating combatants during a fight, and preserves status so alumni
 * can be labeled when the producer opts them back in.
 */

function pc(partial: Partial<Character> & Pick<Character, 'id' | 'name' | 'status'>): Character {
  return {
    campaignId: 1,
    ownerUserId: null,
    species: '',
    className: 'Fighter',
    level: 3,
    xp: 0,
    background: '',
    stats: {},
    ac: 15,
    hpCurrent: 20,
    hpMax: 20,
    hpTemp: 0,
    deathState: 'none',
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    conditions: [],
    saveProficiencies: [],
    skills: {},
    actions: [],
    spellSlots: {},
    portraitUrl: null,
    ddbId: null,
    notes: '',
    dmSecret: 'never leak',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const roster = [
  pc({ id: 1, name: 'Aria', status: 'active' }),
  pc({ id: 2, name: 'Borin', status: 'retired' }),
  pc({ id: 3, name: 'Cora', status: 'dead' }),
  pc({ id: 4, name: 'Dain', status: 'inactive' }),
  pc({ id: 5, name: 'Elspeth', status: 'active' }),
];

test.describe('safeParty — Player Display party filter (issue #824)', () => {
  test('defaults to active characters only on a mixed-status roster', () => {
    const party = safeParty(roster);
    expect(party.map((c) => c.name)).toEqual(['Aria', 'Elspeth']);
    expect(party.every((c) => c.status === 'active')).toBe(true);
  });

  test('preserves status on the player-safe projection (alumni labels need it)', () => {
    const projected = safeCharacter(roster[2]!);
    expect(projected.status).toBe('dead');
    expect(projected).not.toHaveProperty('dmSecret');
    expect(projected).not.toHaveProperty('notes');
  });

  test('includeAlumni returns the full undeleted roster with explicit statuses', () => {
    const party = safeParty(roster, { includeAlumni: true });
    expect(party.map((c) => [c.name, c.status])).toEqual([
      ['Aria', 'active'],
      ['Borin', 'retired'],
      ['Cora', 'dead'],
      ['Dain', 'inactive'],
      ['Elspeth', 'active'],
    ]);
  });

  test('during combat, prefers participating character combatants over the full active roster', () => {
    // Elspeth is active but sitting this fight out; Borin (retired) is somehow still
    // seated from earlier — prefer the combatant list while alumni are excluded.
    const party = safeParty(roster, { participatingCharacterIds: [1, 2] });
    expect(party.map((c) => c.name)).toEqual(['Aria', 'Borin']);
  });

  test('empty participating set falls back to active-only (monster-only fights)', () => {
    const party = safeParty(roster, { participatingCharacterIds: [] });
    expect(party.map((c) => c.name)).toEqual(['Aria', 'Elspeth']);
  });

  test('includeAlumni ignores the combatant preference and shows every PC', () => {
    const party = safeParty(roster, {
      includeAlumni: true,
      participatingCharacterIds: [1],
    });
    expect(party.map((c) => c.name)).toEqual(['Aria', 'Borin', 'Cora', 'Dain', 'Elspeth']);
  });

  test('accepts a ReadonlySet of participating ids', () => {
    const party = safeParty(roster, { participatingCharacterIds: new Set([5]) });
    expect(party.map((c) => c.name)).toEqual(['Elspeth']);
  });
});

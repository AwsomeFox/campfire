import { expect, test } from '@playwright/test';
import { parseMonsterStatblock } from '../../src/components/StatBlock';

/**
 * Issue #767 — PF2e creature ability MODIFIERS must render signed and must not be
 * re-converted through the score→modifier formula. Pure parser coverage (compendium /
 * encounter / generation preview all share parseMonsterStatblock).
 */
test.describe('PF2e creature ability modifiers (issue #767)', () => {
  test('renders zero, negative, positive, and double-digit modifiers as signed values', () => {
    const block = parseMonsterStatblock(
      {
        level: 1,
        ac: 16,
        hp: 20,
        perception: 4,
        abilityMods: {
          strength: 0,
          dexterity: 3,
          constitution: -1,
          intelligence: 1,
          wisdom: -2,
          charisma: 12,
        },
      },
      'pf2e-srd',
    );

    expect(block).not.toBeNull();
    expect(block?.abilities).toEqual([
      { label: 'STR', value: 0, mod: '+0', representation: 'modifier' },
      { label: 'DEX', value: 3, mod: '+3', representation: 'modifier' },
      { label: 'CON', value: -1, mod: '-1', representation: 'modifier' },
      { label: 'INT', value: 1, mod: '+1', representation: 'modifier' },
      { label: 'WIS', value: -2, mod: '-2', representation: 'modifier' },
      { label: 'CHA', value: 12, mod: '+12', representation: 'modifier' },
    ]);
    // Regression: DEX +3 must never become "3 (-4)" via a second score→mod conversion.
    expect(block?.abilities.find((a) => a.label === 'DEX')).toMatchObject({ mod: '+3' });
    expect(block?.abilities.find((a) => a.label === 'DEX')?.mod).not.toBe('-4');
  });

  test('5e ability scores still render as score + derived modifier (character/monster scores)', () => {
    const block = parseMonsterStatblock({
      abilityScores: { strength: 16, dexterity: 14, constitution: 10 },
    });
    expect(block?.abilities).toEqual([
      { label: 'STR', value: 16, mod: '+3', representation: 'score' },
      { label: 'DEX', value: 14, mod: '+2', representation: 'score' },
      { label: 'CON', value: 10, mod: '+0', representation: 'score' },
    ]);
  });
});

import { expect, test } from '@playwright/test';
import type { CustomMechanicsProfile } from '@campfire/schema';
import { ruleSystemAdapter } from '@campfire/schema';
import { ruleSystemAdapterForCampaign, ruleSystemAdapterLabel } from '../../src/lib/rules';
import { parseMonsterStatblock } from '../../src/components/StatBlock';
import { applyOptimisticHpDelta } from '../../src/features/encounters/optimisticHp';

const SAMPLE_HOMEBREW_PROFILE: CustomMechanicsProfile = {
  slug: 'sw-banded-homebrew',
  label: 'Shadowdark / Banded Homebrew',
  mechanicsSummary: 'Custom homebrew profile with Swords & Wizardry ability table',
  abilityTable: 'sw-banded',
  abilityCap: 3,
  saves: ['death', 'wand', 'paralysis', 'breath', 'spell'],
  acMode: 'ascending',
  acAnchor: 10,
  initiativeMode: 'group',
  initiativeDie: 6,
  initiativeUsesDexMod: false,
  tiebreak: 'dex-then-order',
  conditions: ['blinded', 'charmed', 'poisoned'],
};

test.describe('web ruleSystemAdapter custom mechanics profile resolution (#2003)', () => {
  test('ruleSystemAdapterForCampaign resolves custom mechanics profile when passed', () => {
    const campaign = {
      ruleSystem: 'sw-banded-homebrew',
      customMechanicsProfile: SAMPLE_HOMEBREW_PROFILE,
    };

    const adapter = ruleSystemAdapterForCampaign(campaign);
    expect(adapter.label).toBe('Shadowdark / Banded Homebrew');

    // STR 18 under sw-banded ability table returns +2 (whereas standard 5e returns +4)
    expect(adapter.abilityModifier(18)).toBe(2);
    // Standard 5e for comparison:
    expect(ruleSystemAdapter('sw-banded-homebrew').abilityModifier(18)).toBe(4);
  });

  test('ruleSystemAdapterLabel returns custom profile label when provided', () => {
    expect(ruleSystemAdapterLabel('sw-banded-homebrew', SAMPLE_HOMEBREW_PROFILE)).toBe('Shadowdark / Banded Homebrew');
    expect(ruleSystemAdapterLabel('sw-banded-homebrew', null)).toBe('D&D 5e');
  });

  test('parseMonsterStatblock uses custom mechanics profile for ability modifiers', () => {
    const data = {
      name: 'Banded Ogre',
      abilityScores: {
        str: 18,
        dex: 10,
        con: 14,
        int: 6,
        wis: 8,
        cha: 7,
      },
    };

    const customBlock = parseMonsterStatblock(data, 'sw-banded-homebrew', SAMPLE_HOMEBREW_PROFILE);
    expect(customBlock).not.toBeNull();

    const strAbility = customBlock?.abilities.find((a) => a.label === 'STR');
    expect(strAbility).toBeDefined();
    expect(strAbility?.value).toBe(18);
    // Under sw-banded: STR 18 has modifier +2
    expect(strAbility?.mod).toBe('+2');

    // Without profile (fallback to 5e): STR 18 has modifier +4
    const fallbackBlock = parseMonsterStatblock(data, 'sw-banded-homebrew', null);
    expect(fallbackBlock?.abilities.find((a) => a.label === 'STR')?.mod).toBe('+4');
  });

  test('applyOptimisticHpDelta accepts customMechanicsProfile without throwing', () => {
    const combatant = {
      id: 1,
      name: 'Hero',
      kind: 'character' as const,
      hpCurrent: 20,
      hpMax: 20,
      hpTemp: 0,
      initiative: 10,
      initiativeTiebreaker: 0,
      status: 'active' as const,
      defeated: false,
    };

    const updated = applyOptimisticHpDelta(combatant as any, -5, 'sw-banded-homebrew', SAMPLE_HOMEBREW_PROFILE);
    expect(updated.hpCurrent).toBe(15);
  });
});

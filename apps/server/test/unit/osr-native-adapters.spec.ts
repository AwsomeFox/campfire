import {
  BasicFantasyAdapter,
  LabyrinthLordAdapter,
  OSR_RULE_SYSTEM_SLUGS,
  OSR_VARIANT_PROFILES,
  OldSchoolEssentialsAdapter,
  OseAdapter,
  OsricAdapter,
  OsrAdapter,
  SwordsWizardryAdapter,
  descendingToAscendingAc,
  osrAdndAbilityModifier,
  osrBxAbilityModifier,
  osrMechanicsProfile,
  osrSwAbilityModifier,
  previewOsrMigration,
  ruleSystemAdapter,
  savingThrowSucceeds,
} from '@campfire/schema';

/**
 * Fixture vectors and native-profile tests for every OSR variant (issue #765).
 * Each variant owns its own ability table, saves, AC convention, and initiative mode.
 */
describe('OSR native adapters — per-variant profiles (issue #765)', () => {
  it.each([
    ['basic-fantasy', BasicFantasyAdapter, 'individual', true, 'bx-banded', 3, 'descending', 9],
    ['osric', OsricAdapter, 'individual', false, 'adnd-linear', 5, 'descending', 10],
    ['swords-wizardry', SwordsWizardryAdapter, 'group', false, 'sw-banded', 2, 'ascending', 10],
    ['labyrinth-lord', LabyrinthLordAdapter, 'group', false, 'bx-banded', 3, 'descending', 9],
    ['old-school-essentials', OldSchoolEssentialsAdapter, 'group', false, 'bx-banded', 3, 'ascending', 10],
    ['ose', OseAdapter, 'group', false, 'bx-banded', 3, 'ascending', 10],
  ] as const)(
    '%s resolves to its own native adapter with correct profile',
    (slug, adapter, initMode, usesDex, abilityTable, abilityCap, acMode, acAnchor) => {
      expect(ruleSystemAdapter(slug)).toBe(adapter);
      expect(adapter.id).toBe(slug === 'ose' ? 'ose' : slug);
      const profile = osrMechanicsProfile(slug);
      expect(profile.initiativeMode).toBe(initMode);
      expect(profile.initiativeUsesDexMod).toBe(usesDex);
      expect(profile.abilityTable).toBe(abilityTable);
      expect(profile.abilityCap).toBe(abilityCap);
      expect(profile.acMode).toBe(acMode);
      expect(profile.acAnchor).toBe(acAnchor);
      expect(adapter.initiativeModel?.mode).toBe(initMode);
      expect(adapter.initiativeModel?.usesDexModifier).toBe(usesDex);
    },
  );

  it('does NOT resolve every OSR slug to the same shared adapter', () => {
    const adapters = OSR_RULE_SYSTEM_SLUGS.map((slug) => ruleSystemAdapter(slug));
    const unique = new Set(adapters);
    // basic-fantasy, osric, swords-wizardry, labyrinth-lord, old-school-essentials, ose are distinct;
    // 'osr' generic aliases its own profile object.
    expect(unique.size).toBeGreaterThanOrEqual(5);
    expect(ruleSystemAdapter('basic-fantasy')).not.toBe(ruleSystemAdapter('swords-wizardry'));
    expect(ruleSystemAdapter('labyrinth-lord')).not.toBe(ruleSystemAdapter('old-school-essentials'));
  });
});

describe('OSR native adapters — ability modifier fixture vectors', () => {
  it('B/X banded table (Basic Fantasy, Labyrinth Lord, OSE)', () => {
    expect(osrBxAbilityModifier(3)).toBe(-3);
    expect(osrBxAbilityModifier(9)).toBe(0);
    expect(osrBxAbilityModifier(16)).toBe(2);
    expect(osrBxAbilityModifier(18)).toBe(3);
    expect(BasicFantasyAdapter.abilityModifier(18)).toBe(3);
    expect(LabyrinthLordAdapter.abilityModifier(18)).toBe(3);
  });

  it('S&W banded table (±2 cap)', () => {
    expect(osrSwAbilityModifier(4)).toBe(-2);
    expect(osrSwAbilityModifier(12)).toBe(0);
    expect(osrSwAbilityModifier(16)).toBe(2);
    expect(osrSwAbilityModifier(18)).toBe(2); // capped at +2, not +3
    expect(SwordsWizardryAdapter.abilityModifier(18)).toBe(2);
  });

  it('OSRIC AD&D linear table', () => {
    expect(osrAdndAbilityModifier(10)).toBe(0);
    expect(osrAdndAbilityModifier(16)).toBe(3);
    expect(osrAdndAbilityModifier(18)).toBe(4); // differs from B/X (+3)
    expect(OsricAdapter.abilityModifier(18)).toBe(4);
  });
});

describe('OSR native adapters — save categories', () => {
  it('B/X clones use five saves; OSE uses three', () => {
    expect(osrMechanicsProfile('basic-fantasy').saves).toHaveLength(5);
    expect(osrMechanicsProfile('osric').saves).toHaveLength(5);
    expect(osrMechanicsProfile('old-school-essentials').saves).toHaveLength(3);
    expect(osrMechanicsProfile('old-school-essentials').saves).toEqual(['DEX Save', 'WIS Save', 'CON Save']);
  });

  it('saving throw succeeds on meet-or-beat (all variants)', () => {
    expect(savingThrowSucceeds(12, 12)).toBe(true);
    expect(savingThrowSucceeds(11, 12)).toBe(false);
    expect(savingThrowSucceeds(20, 99)).toBe(true);
    expect(savingThrowSucceeds(1, 2)).toBe(false);
  });
});

describe('OSR native adapters — AC equivalence fixture vectors', () => {
  it('descending unarmored 9 ⇄ ascending 10 (B/X anchor)', () => {
    expect(descendingToAscendingAc(9)).toBe(10);
    const mapped = BasicFantasyAdapter.mapStatblock({ armorClass: 9 });
    expect(mapped.armorClass).toBe(9); // descending-native stores descending
  });

  it('ascending-native OSE stores ascending AC directly', () => {
    const mapped = OldSchoolEssentialsAdapter.mapStatblock({ armorClass: 10, armorClassAscending: 15 });
    expect(mapped.armorClass).toBe(15);
  });

  it('S&W ascending-native prefers explicit ascending AC', () => {
    const mapped = SwordsWizardryAdapter.mapStatblock({ armorClass: 13, armorClassAscending: 7 });
    expect(mapped.armorClass).toBe(7);
  });
});

describe('OSR native adapters — initiative fixture vectors', () => {
  it('individual + DEX mod (Basic Fantasy)', () => {
    expect(BasicFantasyAdapter.initiativeDie).toBe(6);
    expect(BasicFantasyAdapter.initiativeModifier({ DEX: 16 })).toBe(2);
    expect(BasicFantasyAdapter.initiativeModifier({ DEX: 9 })).toBe(0);
  });

  it('individual without DEX mod (OSRIC)', () => {
    expect(OsricAdapter.initiativeModifier({ DEX: 18 })).toBe(0);
  });

  it('group mode returns 0 initMod (Labyrinth Lord, S&W, OSE)', () => {
    expect(LabyrinthLordAdapter.initiativeModifier({ DEX: 18 })).toBe(0);
    expect(SwordsWizardryAdapter.initiativeModifier({ DEX: 18 })).toBe(0);
    expect(OldSchoolEssentialsAdapter.initiativeModifier({ DEX: 18 })).toBe(0);
  });
});

describe('OSR migration preview (issue #765)', () => {
  it('lists mechanics changes when migrating basic-fantasy → old-school-essentials', () => {
    const preview = previewOsrMigration('basic-fantasy', 'old-school-essentials');
    expect(preview.from.slug).toBe('basic-fantasy');
    expect(preview.to.slug).toBe('old-school-essentials');
    expect(preview.changes.length).toBeGreaterThan(0);
    expect(preview.changes.some((c: string) => c.includes('Save categories'))).toBe(true);
    expect(preview.changes.some((c: string) => c.includes('AC convention'))).toBe(true);
    expect(preview.changes.some((c: string) => c.includes('Initiative'))).toBe(true);
  });

  it('reports no changes for identical profiles', () => {
    const preview = previewOsrMigration('basic-fantasy', 'basic-fantasy');
    expect(preview.changes).toEqual(['No mechanics changes — profiles are identical.']);
  });
});

describe('OSR backward compatibility', () => {
  it('OsrAdapter aliases BasicFantasyAdapter', () => {
    expect(OsrAdapter).toBe(BasicFantasyAdapter);
  });

  it('every OSR slug has a profile in OSR_VARIANT_PROFILES', () => {
    for (const slug of OSR_RULE_SYSTEM_SLUGS) {
      expect(OSR_VARIANT_PROFILES[slug]).toBeDefined();
      expect(OSR_VARIANT_PROFILES[slug].mechanicsSummary).toBeTruthy();
    }
  });
});

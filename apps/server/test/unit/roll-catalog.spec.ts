import {
  Dnd5eAdapter,
  Pf2eAdapter,
  Sf2eAdapter,
  listRuleSystemAdapters,
  ruleSystemAdapter,
  checkCatalogForAdapter,
  findCheckInCatalog,
  neutralCheckCatalog,
  dnd5eProficiencyBonus,
  formatCheckBreakdown,
  checkRollExpr,
  filterCheckCatalog,
  hasInitiativeRollForAdapter,
  hasNeutralD20ChecksForAdapter,
  sortCheckCatalog,
  DND5E_SKILLS,
  type CheckCatalogCharacter,
  type RuleSystemAdapter,
} from '@campfire/schema';

/**
 * Roll catalog (issue #415). The adapter owns an encounter/sheet ROLL CATALOG so an ordinary
 * unproficient check rolls inline with the correct modifier, non-5e systems use their own
 * math, and the sheet + encounter share one authoritative source. These tests are the
 * per-ruleset fixtures the acceptance criteria call for, plus the transparent-breakdown and
 * unproficient-skill guarantees.
 */

// A representative 5e character fixture: DEX 16 (+3), STR 14 (+2), proficient in Athletics
// and Stealth (expertise), proficient in DEX + WIS saves, level 5 (proficiency bonus +3).
const FIVE_E_CHAR: CheckCatalogCharacter = {
  level: 5,
  stats: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 13, CHA: 8 },
  saveProficiencies: ['DEX', 'WIS'],
  skills: { Athletics: 'proficient', Stealth: 'expertise' },
};

describe('roll catalog — D&D 5e', () => {
  const catalog = checkCatalogForAdapter(Dnd5eAdapter, FIVE_E_CHAR);

  it('includes EVERY 5e skill, proficient and unproficient', () => {
    const skillIds = catalog.filter((c) => c.category === 'skill').map((c) => c.label).sort();
    expect(skillIds).toEqual(DND5E_SKILLS.map((s) => s.name).sort());
    expect(skillIds).toHaveLength(18);
  });

  it('rolls an UNPROFICIENT skill at the bare ability modifier', () => {
    // Acrobatics (DEX 16 -> +3), not proficient: modifier is +3, no proficiency term.
    const acro = findCheckInCatalog(Dnd5eAdapter, FIVE_E_CHAR, 'skill:Acrobatics')!;
    expect(acro.modifier).toBe(3);
    expect(acro.proficiency).toBeNull();
    expect(acro.favorite).toBe(false);
    expect(checkRollExpr(acro, 'normal')).toBe('1d20+3');
  });

  it('adds the fixed proficiency bonus to a proficient skill with a transparent breakdown', () => {
    // Athletics (STR 14 -> +2) proficient at level 5 (pb +3): +2 +3 = +5.
    const ath = findCheckInCatalog(Dnd5eAdapter, FIVE_E_CHAR, 'skill:Athletics')!;
    expect(ath.modifier).toBe(5);
    expect(ath.favorite).toBe(true);
    expect(formatCheckBreakdown(ath)).toBe('STR +2, proficient +3 = +5');
  });

  it('doubles proficiency for expertise', () => {
    // Stealth (DEX +3) expertise at level 5 (pb +3, doubled +6): +3 +6 = +9.
    const stealth = findCheckInCatalog(Dnd5eAdapter, FIVE_E_CHAR, 'skill:Stealth')!;
    expect(stealth.modifier).toBe(9);
    expect(formatCheckBreakdown(stealth)).toBe('DEX +3, expertise +6 = +9');
  });

  it('computes saves with and without proficiency', () => {
    const dexSave = findCheckInCatalog(Dnd5eAdapter, FIVE_E_CHAR, 'save:DEX')!;
    expect(dexSave.modifier).toBe(6); // +3 DEX + 3 proficient
    expect(dexSave.favorite).toBe(true);
    const strSave = findCheckInCatalog(Dnd5eAdapter, FIVE_E_CHAR, 'save:STR')!;
    expect(strSave.modifier).toBe(2); // +2 STR, no proficiency
    expect(strSave.favorite).toBe(false);
  });

  it('offers initiative and ability checks; supports advantage; no degrees', () => {
    const init = findCheckInCatalog(Dnd5eAdapter, FIVE_E_CHAR, 'initiative')!;
    expect(init.modifier).toBe(3); // DEX +3
    expect(checkRollExpr(init, 'advantage')).toBe('2d20kh1+3');
    expect(checkRollExpr(init, 'disadvantage')).toBe('2d20kl1+3');
    expect(catalog.every((c) => c.supportsDegrees === false)).toBe(true);
    expect(catalog.every((c) => c.supportsAdvantage === true)).toBe(true);
  });

  it('matches dnd5eProficiencyBonus scaling', () => {
    expect(dnd5eProficiencyBonus(1)).toBe(2);
    expect(dnd5eProficiencyBonus(5)).toBe(3);
    expect(dnd5eProficiencyBonus(17)).toBe(6);
  });
});

describe('roll catalog — PF2e (level + rank, degrees of success)', () => {
  // Level 5 PF2e char, DEX 16 (+3), trained in Acrobatics, WIS 14 (+2).
  const pf2eChar: CheckCatalogCharacter = {
    level: 5,
    stats: { STR: 10, DEX: 16, CON: 12, INT: 10, WIS: 14, CHA: 10 },
    saveProficiencies: ['DEX'],
    skills: { Acrobatics: 'proficient' },
  };
  const catalog = checkCatalogForAdapter(Pf2eAdapter, pf2eChar);

  it('adds LEVEL plus the rank bonus to a trained skill', () => {
    // Acrobatics: DEX +3, level 5, trained +2 => +10.
    const acro = findCheckInCatalog(Pf2eAdapter, pf2eChar, 'skill:Acrobatics')!;
    expect(acro.modifier).toBe(10);
    expect(formatCheckBreakdown(acro)).toBe('DEX +3, level +5, trained +2 = +10');
  });

  it('leaves an untrained skill at the bare ability modifier (no level)', () => {
    const athletics = findCheckInCatalog(Pf2eAdapter, pf2eChar, 'skill:Athletics')!;
    expect(athletics.modifier).toBe(0); // STR +0, untrained adds nothing
    expect(athletics.proficiency).toBeNull();
  });

  it('reports degrees of success and no generic advantage', () => {
    expect(catalog.every((c) => c.supportsDegrees === true)).toBe(true);
    expect(catalog.every((c) => c.supportsAdvantage === false)).toBe(true);
    const acro = findCheckInCatalog(Pf2eAdapter, pf2eChar, 'skill:Acrobatics')!;
    // Advantage requested but unsupported -> single die.
    expect(checkRollExpr(acro, 'advantage')).toBe('1d20+10');
  });

  it('SF2e inherits the PF2e catalog math', () => {
    const sf = checkCatalogForAdapter(Sf2eAdapter, pf2eChar);
    const acro = sf.find((c) => c.id === 'skill:Acrobatics')!;
    expect(acro.modifier).toBe(10);
  });
});

describe('roll catalog — fixtures for every supported ruleset', () => {
  const char: CheckCatalogCharacter = {
    level: 3,
    stats: { STR: 12, DEX: 14, CON: 12, INT: 10, WIS: 11, CHA: 13 },
    saveProficiencies: ['DEX'],
    skills: { Stealth: 'proficient' },
  };

  const everyAdapter = listRuleSystemAdapters();
  /**
   * Split, rather than one blanket assertion, because "every ruleset has ability checks and
   * saves" is only true of the d20 systems. Ironsworn: Starforged resolves moves on a d6
   * action die and Open Legend rolls an exploding attribute pool, so the neutral
   * `d20 + modifier` entries this used to require were 5e-shaped rolls those games never
   * make — and the server resolves the catalog, so offering them PERSISTED wrong numbers to
   * the shared dice log. They now declare `hasNeutralD20Checks: false` and contribute
   * nothing until they have an adapter-owned `buildCheckCatalog`; this file's own premise is
   * that non-5e systems use their own math, so an honest empty catalog is that premise
   * enforced, not relaxed.
   */
  const d20Adapters = everyAdapter.filter((a) => hasNeutralD20ChecksForAdapter(a));
  const nonD20Adapters = everyAdapter.filter((a) => !hasNeutralD20ChecksForAdapter(a));

  it('covers every registered adapter between the two groups', () => {
    expect(d20Adapters.length + nonD20Adapters.length).toBe(everyAdapter.length);
    expect(d20Adapters.length).toBeGreaterThan(0);
    expect(nonD20Adapters.length).toBeGreaterThan(0);
  });

  it.each(d20Adapters.map((adapter) => [adapter.label, adapter] as const))(
    '%s produces a non-empty catalog with initiative, ability checks, and saves',
    (_name, adapter) => {
      const catalog = checkCatalogForAdapter(adapter, char);
      expect(catalog.length).toBeGreaterThan(0);
      expect(catalog.some((c) => c.category === 'initiative')).toBe(hasInitiativeRollForAdapter(adapter));
      expect(catalog.some((c) => c.category === 'ability')).toBe(true);
      expect(catalog.some((c) => c.category === 'save')).toBe(true);
      // Every entry carries a transparent breakdown that sums to its modifier (unless flagged incomplete).
      for (const c of catalog) {
        if (c.incomplete) continue;
        const sum = c.breakdown.reduce((acc, b) => acc + b.value, 0);
        expect(sum).toBe(c.modifier);
      }
    },
  );

  it.each(nonD20Adapters.map((adapter) => [adapter.label, adapter] as const))(
    '%s offers no d20 ability checks or saves — its own roll is not a d20',
    (_name, adapter) => {
      const catalog = checkCatalogForAdapter(adapter, char);
      expect(catalog.some((c) => c.category === 'ability')).toBe(false);
      expect(catalog.some((c) => c.category === 'save')).toBe(false);
      expect(catalog.some((c) => c.category === 'skill')).toBe(false);
      // Initiative is governed separately: a system that HAS one keeps it (Open Legend is
      // Agility-monotonic), a system with none (Starforged) contributes nothing at all.
      expect(catalog.some((c) => c.category === 'initiative')).toBe(hasInitiativeRollForAdapter(adapter));
      for (const c of catalog) {
        if (c.incomplete) continue;
        const sum = c.breakdown.reduce((acc, b) => acc + b.value, 0);
        expect(sum).toBe(c.modifier);
      }
    },
  );
});

describe('roll catalog — characterizes synthetic adapters with no buildCheckCatalog', () => {
  const homebrew: RuleSystemAdapter = {
    id: 'homebrew',
    label: 'Homebrew',
    abilityModifier: (score) => Math.floor((score - 10) / 2),
    initiativeDie: 20,
    maxLevel: Infinity,
    initiativeModifier: () => 1,
    initiativeTiebreak: () => 0,
    conditions: [],
    mapStatblock: () => ({
      size: undefined,
      creatureType: undefined,
      challengeRating: undefined,
      armorClass: undefined,
      hitPoints: undefined,
      speed: undefined,
      abilityScores: undefined,
      abilityRepresentation: 'score',
      specialAbilities: undefined,
      actions: undefined,
    }),
    monsterHitPoints: () => null,
    // no buildCheckCatalog -> falls back to neutralCheckCatalog
  };

  const char: CheckCatalogCharacter = {
    level: 2,
    stats: { MIGHT: 14, GRACE: 12 },
    saveProficiencies: ['MIGHT'],
    skills: { Climbing: 'proficient' },
  };

  it('derives ability checks from the character\'s OWN attributes (not a fixed 5e list)', () => {
    const catalog = checkCatalogForAdapter(homebrew, char);
    const abilities = catalog.filter((c) => c.category === 'ability').map((c) => c.ability).sort();
    expect(abilities).toEqual(['GRACE', 'MIGHT']);
  });

  it('flags a homebrew skill as incomplete (no governing-ability math) but still rollable', () => {
    const catalog = neutralCheckCatalog(homebrew, char);
    const climb = catalog.find((c) => c.id === 'skill:Climbing')!;
    expect(climb.incomplete).toBe(true);
    expect(checkRollExpr(climb, 'normal')).toMatch(/^1d20/);
  });

  it('uses the adapter initiative modifier', () => {
    const init = neutralCheckCatalog(homebrew, char).find((c) => c.category === 'initiative')!;
    expect(init.modifier).toBe(1);
  });

  it('characterizes real unregistered/unknown slugs: ruleSystemAdapter("homebrew") resolves to Dnd5eAdapter and produces 5e catalog', () => {
    const adapter = ruleSystemAdapter('homebrew');
    expect(adapter.id).toBe('dnd5e');
    const catalog = checkCatalogForAdapter(adapter, char);
    const abilities = catalog.filter((c) => c.category === 'ability').map((c) => c.ability).sort();
    expect(abilities).toEqual(['CHA', 'CON', 'DEX', 'INT', 'STR', 'WIS']);
  });
});

describe('roll catalog — search + ordering helpers', () => {
  const catalog = checkCatalogForAdapter(Dnd5eAdapter, FIVE_E_CHAR);

  it('filters by label, ability, or category (favorites are not the only matches)', () => {
    const stealthy = filterCheckCatalog(catalog, 'stea');
    expect(stealthy.some((c) => c.label === 'Stealth')).toBe(true);
    // A DEX search returns unproficient DEX skills too (searchable, not proficient-only).
    const dex = filterCheckCatalog(catalog, 'DEX');
    expect(dex.some((c) => c.label === 'Acrobatics')).toBe(true);
  });

  it('orders favorites (trained/proficient) first', () => {
    const sorted = sortCheckCatalog(catalog);
    const firstSkillIdx = sorted.findIndex((c) => c.category === 'skill');
    // The first skill shown must be a favorite (Athletics/Stealth), never an unproficient one.
    expect(sorted[firstSkillIdx].favorite).toBe(true);
  });
});

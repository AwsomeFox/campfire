import { bestProficiencyRank, Dnd5eAdapter, normalizeProficiencyRank, Pf2eAdapter, PROFICIENCY_RANKS, SkillRank, weaponProficiencyRank } from '@campfire/schema';

/**
 * Issue #2144 — one proficiency ladder for every system, and how an equipped weapon finds its
 * rung on it.
 *
 * The two things worth pinning: a rank written before the ladder existed still reads correctly
 * (there is no migration, so every stored `'proficient'` depends on this), and the lookup
 * composes category training with by-name training instead of one shadowing the other.
 */
describe('the proficiency ladder (#2144)', () => {
  it('keeps the 5e spellings valid and folds them onto the ladder', () => {
    // Every `characters.skills` row written before the ladder holds one of these.
    expect(SkillRank.safeParse('proficient').success).toBe(true);
    expect(SkillRank.safeParse('expertise').success).toBe(true);
    expect(normalizeProficiencyRank('proficient')).toBe('trained');
    expect(normalizeProficiencyRank('expertise')).toBe('expert');
  });

  it('accepts the canonical rungs, including the two 5e never had', () => {
    for (const rank of PROFICIENCY_RANKS) {
      expect(SkillRank.safeParse(rank).success || rank === 'untrained').toBe(true);
      expect(normalizeProficiencyRank(rank)).toBe(rank);
    }
    expect(normalizeProficiencyRank('MASTER')).toBe('master');
    expect(normalizeProficiencyRank('  legendary ')).toBe('legendary');
  });

  it('reads anything it cannot place as untrained rather than throwing', () => {
    for (const junk of [null, undefined, '', '  ', 'wizardly', '5']) {
      expect(normalizeProficiencyRank(junk)).toBe('untrained');
    }
  });

  it('orders the ladder', () => {
    expect(bestProficiencyRank('trained', 'legendary')).toBe('legendary');
    expect(bestProficiencyRank('master', 'expert')).toBe('master');
    expect(bestProficiencyRank('untrained', 'trained')).toBe('trained');
  });
});

describe('weaponProficiencyRank (#2144)', () => {
  it('matches the weapon by name and by every category it belongs to', () => {
    const sheet = { martial: 'trained' };
    expect(weaponProficiencyRank(sheet, 'Longsword', ['martial', 'sword'])).toBe('trained');
    expect(weaponProficiencyRank(sheet, 'Longsword', ['simple'])).toBe('untrained');
    expect(weaponProficiencyRank({ Longsword: 'expert' }, 'longsword', [])).toBe('expert');
  });

  it('takes the BEST applicable rank, so the two kinds of entry compose', () => {
    // "I'm trained in martial weapons, and expert with the longsword" — a real sheet, and
    // neither entry may shadow the other.
    const sheet = { martial: 'trained', longsword: 'expert' };
    expect(weaponProficiencyRank(sheet, 'Longsword', ['martial'])).toBe('expert');
    expect(weaponProficiencyRank(sheet, 'Greatsword', ['martial'])).toBe('trained');
  });

  it('is case- and whitespace-insensitive on both sides', () => {
    // Keys arrive from a human typing, an importer copying a printed name, and compendium
    // data — three conventions for the same word.
    expect(weaponProficiencyRank({ '  MARTIAL ': 'trained' }, 'x', ['Martial'])).toBe('trained');
  });

  it('treats an explicit untrained entry as no entry', () => {
    expect(weaponProficiencyRank({ martial: 'untrained' }, 'Longsword', ['martial'])).toBe('untrained');
  });

  it('answers untrained for an empty or missing record', () => {
    expect(weaponProficiencyRank(null, 'Longsword', ['martial'])).toBe('untrained');
    expect(weaponProficiencyRank({}, 'Longsword', ['martial'])).toBe('untrained');
  });
});

describe('adapters price the ladder in their own currency (#2144)', () => {
  it('5e pays one fixed bonus for any training, and nothing for none', () => {
    // 5e's weapon proficiency is binary — Expertise doubles SKILL checks, never weapon
    // attacks, and the system prints no weapon rank above proficient at all.
    expect(Dnd5eAdapter.weaponProficiencyBonus!(5, 'untrained')).toBe(0);
    expect(Dnd5eAdapter.weaponProficiencyBonus!(5, 'trained')).toBe(3);
    expect(Dnd5eAdapter.weaponProficiencyBonus!(5, 'legendary')).toBe(3);
    expect(Dnd5eAdapter.weaponProficiencyBonus!(17, 'trained')).toBe(6);
  });

  it('PF2e adds the level plus a rank bonus, and nothing at all when untrained', () => {
    // The spread that made an assumed rank untenable, and why the sheet had to learn to
    // record one: +7 to +13 at the same level, for the same character.
    expect(Pf2eAdapter.weaponProficiencyBonus!(5, 'untrained')).toBe(0);
    expect(Pf2eAdapter.weaponProficiencyBonus!(5, 'trained')).toBe(7);
    expect(Pf2eAdapter.weaponProficiencyBonus!(5, 'expert')).toBe(9);
    expect(Pf2eAdapter.weaponProficiencyBonus!(5, 'master')).toBe(11);
    expect(Pf2eAdapter.weaponProficiencyBonus!(5, 'legendary')).toBe(13);
  });
});

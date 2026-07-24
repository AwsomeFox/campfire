import {
  ARCHMAGE_ADAPTER_ID,
  Archmage13aAdapter,
  Dnd5eAdapter,
  DND5E_PACK_SLUG,
  OPEN_LEGEND_PACK_SLUG,
  OpenLegendAdapter,
  OSR_RULE_SYSTEM_SLUGS,
  OsrAdapter,
  PF1E_PACK_SLUG,
  Pathfinder1eAdapter,
  Pf2eAdapter,
  PF2E_PACK_SLUG,
  STARFINDER_ADAPTER_ID,
  StarfinderAdapter,
  UNKNOWN_DIFFICULTY_LABEL,
  encounterDifficultySupported,
  estimateEncounterDifficultyForRuleSystem,
  unsupportedEncounterDifficulty,
} from '@campfire/schema';

/**
 * Issue #429 — adapter-owned encounter difficulty.
 *
 * Fixtures per supported ruleset: 5e owns XP-budget math/labels; every other
 * registered system returns an explicit unsupported result (never a fake
 * Trivial band for zero-data or non-5e campaigns).
 */

const PARTY = [5, 5, 5, 5];

describe('encounter difficulty adapters (issue #429)', () => {
  describe('Dnd5eAdapter (supported)', () => {
    it('opts in and scores a known CR fight', () => {
      expect(Dnd5eAdapter.supportsEncounterDifficulty).toBe(true);
      expect(typeof Dnd5eAdapter.estimateEncounterDifficulty).toBe('function');
      const d = Dnd5eAdapter.estimateEncounterDifficulty!({
        partyLevels: PARTY,
        monsterChallengeRatings: [10],
      });
      expect(d.status).toBe('ok');
      expect(d.band).toBe('deadly');
      expect(d.label).toBe('Deadly');
      expect(d.assumptions.length).toBeGreaterThan(0);
    });

    it('labels zero-data manual enemies Unknown—add XP/CR (not Trivial)', () => {
      const d = Dnd5eAdapter.estimateEncounterDifficulty!({
        partyLevels: PARTY,
        monsterChallengeRatings: [null],
      });
      expect(d.status).toBe('unknown');
      expect(d.band).toBeNull();
      expect(d.label).toBe(UNKNOWN_DIFFICULTY_LABEL);
      expect(d.label).not.toBe('Trivial');
    });

    it('is supported for the open5e pack slug and homebrew fallback', () => {
      expect(encounterDifficultySupported(DND5E_PACK_SLUG)).toBe(true);
      expect(encounterDifficultySupported('')).toBe(true);
      expect(encounterDifficultySupported(null)).toBe(true);
    });
  });

  describe.each([
    ['Pathfinder 2e', Pf2eAdapter, PF2E_PACK_SLUG],
    ['Pathfinder 1e', Pathfinder1eAdapter, PF1E_PACK_SLUG],
    ['Starfinder', StarfinderAdapter, STARFINDER_ADAPTER_ID],
    ['Open Legend', OpenLegendAdapter, OPEN_LEGEND_PACK_SLUG],
    ['13th Age', Archmage13aAdapter, ARCHMAGE_ADAPTER_ID],
    ['OSR', OsrAdapter, OSR_RULE_SYSTEM_SLUGS[0]],
  ] as const)('%s (unsupported)', (_name, adapter, slug) => {
    it('does not opt into encounter-difficulty math', () => {
      expect(adapter.supportsEncounterDifficulty).toBeFalsy();
      expect(adapter.estimateEncounterDifficulty).toBeUndefined();
      expect(encounterDifficultySupported(slug)).toBe(false);
    });

    it('estimateEncounterDifficultyForRuleSystem explains the limitation', () => {
      const d = estimateEncounterDifficultyForRuleSystem(slug, {
        partyLevels: PARTY,
        monsterChallengeRatings: [null, 5],
      });
      expect(d.status).toBe('unsupported');
      expect(d.band).toBeNull();
      expect(d.label).toMatch(/Not calculated/i);
      expect(d.label).not.toBe('Trivial');
      expect(d.warnings.some((w) => /no built-in encounter/i.test(w))).toBe(true);
    });
  });

  it('unsupportedEncounterDifficulty helper never invents a Trivial band', () => {
    const d = unsupportedEncounterDifficulty('Test System', {
      partyLevels: PARTY,
      monsterChallengeRatings: [null],
    });
    expect(d.status).toBe('unsupported');
    expect(d.band).toBeNull();
    expect(d.label).not.toBe('Trivial');
  });

  it('homebrew (empty slug) uses 5e math but still surfaces unknown for zero-data', () => {
    const d = estimateEncounterDifficultyForRuleSystem('', {
      partyLevels: PARTY,
      monsterChallengeRatings: [null, null],
    });
    expect(d.status).toBe('unknown');
    expect(d.label).toBe(UNKNOWN_DIFFICULTY_LABEL);
  });
});

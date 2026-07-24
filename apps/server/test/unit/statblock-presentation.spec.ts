import {
  Archmage13aAdapter,
  Dnd5eAdapter,
  NEUTRAL_STATBLOCK_PRESENTATION,
  OPEN_LEGEND_ADAPTER_ID,
  OpenLegendAdapter,
  OsrAdapter,
  Pathfinder1eAdapter,
  Pf2eAdapter,
  Sf2eAdapter,
  StarfinderAdapter,
  listRuleSystemAdapters,
  ruleSystemAdapter,
  statblockLabelText,
  statblockPresentation,
} from '@campfire/schema';

/**
 * Adapter-native statblock labels (issue #763). Mechanical fields stay generic
 * (`challengeRating` / `armorClass`); presentation metadata is what the UI says.
 */
describe('statblock presentation metadata (issue #763)', () => {
  it('every registered adapter exposes complete presentation metadata', () => {
    const adapters = listRuleSystemAdapters();
    expect(adapters.map((a) => a.id).sort()).toEqual(
      [
        'archmage',
        'dnd5e',
        'open-legend',
        'osr',
        'pathfinder-1e',
        'pf2e',
        'sf2e',
        'starfinder-1e',
        'starforged',
      ].sort(),
    );
    for (const adapter of adapters) {
      const p = adapter.presentation!;
      expect(p.rating.full).toBeTruthy();
      expect(p.defense.full).toBeTruthy();
      expect(p.hitPoints.full).toBeTruthy();
      expect(p.abilities.full).toBeTruthy();
      expect(p.actions.full).toBeTruthy();
      expect(p.creatureType.full).toBeTruthy();
    }
  });

  it('snapshots native labels for every adapter family', () => {
    const byId = Object.fromEntries(
      listRuleSystemAdapters().map((a) => [
        a.id,
        {
          rating: a.presentation!.rating,
          defense: a.presentation!.defense,
          hitPoints: a.presentation!.hitPoints,
          abilities: a.presentation!.abilities,
          actions: a.presentation!.actions,
          creatureType: a.presentation!.creatureType,
        },
      ]),
    );
    expect(byId).toMatchSnapshot();
  });

  it('uses native labels: Level / Hit Dice / Guard (not Challenge / Armor Class)', () => {
    expect(Pf2eAdapter.presentation!.rating.full).toBe('Level');
    expect(Sf2eAdapter.presentation!.rating.full).toBe('Level');
    expect(Archmage13aAdapter.presentation!.rating.full).toBe('Level');
    expect(OpenLegendAdapter.presentation!.rating.full).toBe('Level');
    expect(OpenLegendAdapter.presentation!.defense.full).toBe('Guard');
    expect(OsrAdapter.presentation!.rating.full).toBe('Hit Dice');
    expect(OsrAdapter.presentation!.rating.short).toBe('HD');
    expect(Dnd5eAdapter.presentation!.rating.full).toBe('Challenge');
    expect(Dnd5eAdapter.presentation!.defense.full).toBe('Armor Class');
    expect(Pathfinder1eAdapter.presentation!.rating.full).toBe('Challenge Rating');
    expect(StarfinderAdapter.presentation!.defense.full).toBe('Kinetic Armor Class');
  });

  it('returns neutral Rating/Defense for unknown and homebrew (empty) rule systems', () => {
    expect(statblockPresentation(null)).toBe(NEUTRAL_STATBLOCK_PRESENTATION);
    expect(statblockPresentation(undefined)).toBe(NEUTRAL_STATBLOCK_PRESENTATION);
    expect(statblockPresentation('')).toBe(NEUTRAL_STATBLOCK_PRESENTATION);
    expect(statblockPresentation('some-homebrew-pack')).toBe(NEUTRAL_STATBLOCK_PRESENTATION);
    expect(statblockPresentation('pathfinder-2e')).toBe(NEUTRAL_STATBLOCK_PRESENTATION);
    expect(statblockPresentation(null).rating.full).toBe('Rating');
    expect(statblockPresentation(null).defense.full).toBe('Defense');
    // Mechanical mapping still falls back to 5e; only the labels are neutralized.
    expect(ruleSystemAdapter(null)).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('some-homebrew-pack')).toBe(Dnd5eAdapter);
  });

  it('resolves registered pack slugs to native presentation (not the neutral fallback)', () => {
    expect(statblockPresentation('open5e-srd')).toBe(Dnd5eAdapter.presentation);
    expect(statblockPresentation('pf2e-srd')).toBe(Pf2eAdapter.presentation);
    expect(statblockPresentation('sf2e-srd')).toBe(Sf2eAdapter.presentation);
    expect(statblockPresentation(OPEN_LEGEND_ADAPTER_ID)).toBe(OpenLegendAdapter.presentation);
    expect(statblockPresentation('basic-fantasy')).toBe(OsrAdapter.presentation);
    expect(statblockPresentation('archmage-srd')).toBe(Archmage13aAdapter.presentation);
    expect(statblockPresentation('pathfinder-1e')).toBe(Pathfinder1eAdapter.presentation);
    expect(statblockPresentation('starfinder-1e')).toBe(StarfinderAdapter.presentation);
  });

  it('prefers full accessible terms; short abbreviations are optional', () => {
    expect(statblockLabelText(Dnd5eAdapter.presentation!.defense)).toBe('Armor Class');
    expect(statblockLabelText(Dnd5eAdapter.presentation!.defense, true)).toBe('AC');
    expect(statblockLabelText(OpenLegendAdapter.presentation!.defense, true)).toBe('Guard');
    expect(statblockLabelText(OsrAdapter.presentation!.rating, true)).toBe('HD');
    expect(statblockLabelText(NEUTRAL_STATBLOCK_PRESENTATION.rating, true)).toBe('Rating');
  });
});

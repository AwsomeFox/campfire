import {
  Dnd5eAdapter,
  OpenLegendAdapter,
  listRuleSystemAdapters,
  statStripForAdapter,
  resolveStatStrip,
  DND5E_STAT_STRIP,
  NEUTRAL_STAT_STRIP,
  checkCatalogForAdapter,
  dnd5eProficiencyBonus,
  DND5E_ADAPTER_ID,
  type CheckCatalogCharacter,
} from '@campfire/schema';

/**
 * The character sheet's stat strip is adapter-declared (issue #2159): the reference VTT's
 * PB / Speed / Initiative / AC row is 5e's, so each adapter declares its own tiles and the
 * values are sourced from `buildCheckCatalog` / the character's own fields — never a hardcoded
 * four-stat row, which would state a plausible wrong proficiency number on every non-5e sheet.
 */
describe('adapter-declared stat strip (issue #2159)', () => {
  describe('shape — statStripForAdapter', () => {
    it('5e declares the reference VTT PB / Speed / Initiative / AC row, in that order', () => {
      // The exact row a hardcoded strip used to be: PB first, then Speed, Initiative, AC.
      const kinds = statStripForAdapter(Dnd5eAdapter).map((c) => c.kind);
      expect(kinds).toEqual(['proficiencyBonus', 'speed', 'initiative', 'armorClass']);
      expect(statStripForAdapter(Dnd5eAdapter)).toBe(DND5E_STAT_STRIP);
    });

    it('every NON-5e adapter omits a proficiencyBonus tile (no hardcoded 5e row regresses them)', () => {
      // The eight non-5e-shaped rulesets must not inherit 5e's PB tile: a single
      // level-derived proficiency number is a 5e concept (PF2e's is level + rank; Starforged /
      // Open Legend have none), so a 5e row on their sheets would state a wrong number.
      const non5e = listRuleSystemAdapters().filter((a) => a.id !== DND5E_ADAPTER_ID);
      // Sanity: the eight non-5e families are all enumerated here.
      expect(non5e.length).toBeGreaterThanOrEqual(8);
      for (const adapter of non5e) {
        const cells = statStripForAdapter(adapter);
        expect(cells.some((c) => c.kind === 'proficiencyBonus')).toBe(false);
        expect(cells.length).toBeGreaterThan(0);
      }
    });

    it('a non-5e adapter without a declared strip falls back to the neutral AC/Initiative/Speed/Level block', () => {
      expect(statStripForAdapter(OpenLegendAdapter)).toBe(NEUTRAL_STAT_STRIP);
      expect(NEUTRAL_STAT_STRIP.map((c) => c.kind)).toEqual(['armorClass', 'initiative', 'speed', 'level']);
    });
  });

  describe('values — resolveStatStrip (sourced from the catalog and character fields)', () => {
    const catalogCharacter: CheckCatalogCharacter = {
      level: 5,
      stats: { DEX: 14 },
      saveProficiencies: [],
      skills: {},
    };

    it("5e sources PB from the adapter's proficiency curve, initiative from the catalog, AC/speed from the character", () => {
      const initiative = checkCatalogForAdapter(Dnd5eAdapter, catalogCharacter).find((c) => c.category === 'initiative') ?? null;
      // Initiative is a catalog check like any other (DEX +2 at DEX 14), not a hardcoded number.
      expect(initiative).not.toBeNull();
      expect(initiative!.modifier).toBe(2);

      const cells = resolveStatStrip(
        Dnd5eAdapter,
        { ac: 16, eac: null, kac: null, speed: 30, level: 5 },
        initiative,
      );
      const byKind = new Map(cells.map((c) => [c.kind, c]));
      // PB = dnd5eProficiencyBonus(5) = +3, from the adapter's own curve.
      expect(byKind.get('proficiencyBonus')!.value).toBe('+3');
      expect(byKind.get('proficiencyBonus')!.value).toBe(`+${dnd5eProficiencyBonus(5)}`);
      // Initiative value mirrors the catalog check's modifier, and carries the check to roll.
      expect(byKind.get('initiative')!.value).toBe('+2');
      expect(byKind.get('initiative')!.rollCheck).toBe(initiative);
      // AC and speed are plain character fields.
      expect(byKind.get('armorClass')!.value).toBe('16');
      expect(byKind.get('armorClass')!.label).toBe('AC');
      expect(byKind.get('speed')!.value).toBe('30');
    });

    it("the defense tile's label comes from the adapter's presentation, not a baked-in 5e 'AC'", () => {
      // Open Legend's defense is "Guard", not "Armor Class" — a hardcoded 5e row would overwrite it.
      const cells = resolveStatStrip(
        OpenLegendAdapter,
        { ac: 12, eac: null, kac: null, speed: 25, level: 3 },
        null,
      );
      const armor = cells.find((c) => c.kind === 'armorClass')!;
      expect(armor.label).toBe('Guard');
      // No proficiencyBonus tile for a non-5e system; level stands in instead.
      expect(cells.some((c) => c.kind === 'proficiencyBonus')).toBe(false);
      expect(cells.find((c) => c.kind === 'level')!.value).toBe('3');
      // Initiative with no catalog check shows an em dash, never a fabricated number.
      expect(cells.find((c) => c.kind === 'initiative')!.value).toBe('—');
    });

    it("splits the defense tile into Starfinder's EAC/KAC pair when those fields are set", () => {
      const cells = resolveStatStrip(
        Dnd5eAdapter,
        { ac: 16, eac: 14, kac: 18, speed: 30, level: 5 },
        null,
      );
      const armor = cells.filter((c) => c.kind === 'armorClass');
      expect(armor).toHaveLength(2);
      expect(armor.map((c) => c.label)).toEqual(['EAC', 'KAC']);
      expect(armor.map((c) => c.value)).toEqual(['14', '18']);
    });

    it('unset numeric fields render an em dash, not a misleading 0', () => {
      const cells = resolveStatStrip(
        Dnd5eAdapter,
        { ac: null, eac: null, kac: null, speed: null, level: 1 },
        null,
      );
      const byKind = new Map(cells.map((c) => [c.kind, c]));
      expect(byKind.get('armorClass')!.value).toBe('—');
      expect(byKind.get('speed')!.value).toBe('—');
      // PB at level 1 is still a real +2 (it is level-derived, not a character field).
      expect(byKind.get('proficiencyBonus')!.value).toBe('+2');
    });
  });
});

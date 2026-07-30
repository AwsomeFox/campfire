import {
  blankCharacterCreate,
  abilityKeysForAdapter,
  characterCompletionChecklist,
  characterCreateFromTemplate,
  findStarterTemplate,
  isCharacterSheetComplete,
  isMinimalCharacterCreate,
  listRuleSystemAdapters,
  resolveCharacterCreateStatus,
  starterTemplatesForAdapter,
  Dnd5eAdapter,
  OpenLegendAdapter,
  Pf2eAdapter,
} from '@campfire/schema';

describe('character-creation (issue #719)', () => {
  describe('isMinimalCharacterCreate', () => {
    it('treats name-only payloads as minimal', () => {
      expect(isMinimalCharacterCreate({ name: 'Aria' } as never)).toBe(true);
    });

    it('treats hp-only payloads as non-minimal', () => {
      expect(isMinimalCharacterCreate({ hpMax: 20, hpCurrent: 20 })).toBe(false);
    });
  });

  describe('resolveCharacterCreateStatus', () => {
    it('defaults minimal creates to draft', () => {
      expect(resolveCharacterCreateStatus({ name: 'Newbie' } as never, Dnd5eAdapter)).toBe('draft');
    });

    it('keeps non-minimal API creates active for backward compatibility', () => {
      expect(resolveCharacterCreateStatus({ name: 'Hero', hpMax: 20 } as never, Dnd5eAdapter)).toBe('active');
    });

    it('derives status as dead when deathState is dead and status is omitted', () => {
      expect(resolveCharacterCreateStatus({ name: 'Fallen', hpMax: 20, deathState: 'dead' } as never, Dnd5eAdapter)).toBe('dead');
      expect(resolveCharacterCreateStatus({ name: 'Fallen Minimal', deathState: 'dead' } as never, Dnd5eAdapter)).toBe('dead');
    });

    it('honors explicit status when deathState is dead', () => {
      expect(resolveCharacterCreateStatus({ name: 'Retired', hpMax: 20, deathState: 'dead', status: 'retired' } as never, Dnd5eAdapter)).toBe('retired');
      expect(resolveCharacterCreateStatus({ name: 'Active Corpse', hpMax: 20, deathState: 'dead', status: 'active' } as never, Dnd5eAdapter)).toBe('active');
    });
  });

  describe('starterTemplatesForAdapter', () => {
    it('offers 5e, PF2e, and Open Legend templates', () => {
      expect(starterTemplatesForAdapter(Dnd5eAdapter).length).toBeGreaterThanOrEqual(3);
      expect(starterTemplatesForAdapter(Pf2eAdapter).length).toBeGreaterThanOrEqual(2);
      expect(starterTemplatesForAdapter(OpenLegendAdapter).length).toBeGreaterThanOrEqual(2);
    });

    it('includes plain-language breakdown lines', () => {
      const fighter = findStarterTemplate(Dnd5eAdapter, '5e-fighter')!;
      expect(fighter.breakdown.length).toBeGreaterThan(0);
      expect(fighter.breakdown.some((line) => /AC|HP|proficiency/i.test(line))).toBe(true);
    });

    it('builds classless Open Legend templates with every native attribute', () => {
      const keys = abilityKeysForAdapter(OpenLegendAdapter);
      expect(keys).toHaveLength(18);
      expect(keys).toContain('AGILITY');
      expect(keys).toContain('ENERGY');
      for (const template of starterTemplatesForAdapter(OpenLegendAdapter)) {
        expect(template.className).toBe('');
        expect(Object.keys(template.stats).sort()).toEqual([...keys].sort());
      }
    });
  });

  describe('characterCreateFromTemplate', () => {
    it('builds a draft sheet with derived combat numbers', () => {
      const template = findStarterTemplate(Dnd5eAdapter, '5e-fighter')!;
      const payload = characterCreateFromTemplate(template, { name: 'Bryn', level: 3 });
      expect(payload.status).toBe('draft');
      expect(payload.hpMax).toBeGreaterThan(0);
      expect(payload.ac).toBe(18);
      expect(payload.actions.length).toBeGreaterThan(0);
    });
  });

  describe('blankCharacterCreate', () => {
    it('creates an intentionally incomplete draft', () => {
      const payload = blankCharacterCreate({ name: 'Sketch', level: 1 });
      expect(payload.status).toBe('draft');
      expect(payload.hpMax).toBe(0);
      expect(payload.ac).toBeNull();
      expect(Object.keys(payload.stats)).toHaveLength(0);
    });
  });

  describe('characterCompletionChecklist', () => {
    it('marks blank drafts incomplete', () => {
      const blank = blankCharacterCreate({ name: 'Sketch', level: 1 });
      const checklist = characterCompletionChecklist(blank as never, Dnd5eAdapter);
      expect(checklist.find((i) => i.id === 'hp')?.done).toBe(false);
      expect(checklist.find((i) => i.id === 'abilities')?.done).toBe(false);
    });

    it('uses adapter-native defense labels', () => {
      const blank = blankCharacterCreate({ name: 'Sketch', level: 1 });
      expect(characterCompletionChecklist(blank as never, Dnd5eAdapter).find((i) => i.id === 'defense')?.label).toBe(
        'Armor Class (AC)',
      );
      expect(characterCompletionChecklist(blank as never, OpenLegendAdapter).find((i) => i.id === 'defense')?.label).toBe(
        'Guard',
      );
    });

    it('does not require a class for classless Open Legend characters', () => {
      const template = findStarterTemplate(OpenLegendAdapter, 'ol-warrior')!;
      const sheet = characterCreateFromTemplate(template, { name: 'Kara', level: 1 });
      expect(sheet.className).toBe('');
      expect(isCharacterSheetComplete(sheet, OpenLegendAdapter)).toBe(true);
      expect(characterCompletionChecklist(sheet as never, OpenLegendAdapter).some((i) => i.id === 'class')).toBe(false);
    });

    it('marks template sheets complete when all essentials are set', () => {
      const template = findStarterTemplate(Dnd5eAdapter, '5e-fighter')!;
      const sheet = characterCreateFromTemplate(template, { name: 'Bryn', level: 1 });
      expect(isCharacterSheetComplete(sheet, Dnd5eAdapter)).toBe(true);
    });
  });

  describe('adapter-owned sheet topology', () => {
    it('is declared by every registered adapter', () => {
      for (const adapter of listRuleSystemAdapters()) {
        expect(adapter.characterSheet?.abilityFields.length).toBeGreaterThan(0);
        expect(adapter.characterSheet?.classField).toBeDefined();
      }
    });
  });
});

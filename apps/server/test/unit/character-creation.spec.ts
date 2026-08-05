import {
  blankCharacterCreate,
  abilityKeysForAdapter,
  characterCompletionChecklist,
  characterCreateFromTemplate,
  findStarterTemplate,
  isCharacterSheetComplete,
  isMinimalCharacterCreate,
  listRuleSystemAdapters,
  ruleSystemAdapter,
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

    // Issue #1910 review (Codex, PR #1980, round 5): speed is a combat statistic by the
    // same argument that put it next to ac/eac/kac in the schema — a { name, speed }
    // create must not be treated as identity-only the way a bare { name } create is.
    it('treats a speed-only payload as non-minimal, the same as ac/eac/kac (issue #1910)', () => {
      expect(isMinimalCharacterCreate({ speed: 30 })).toBe(false);
      expect(isMinimalCharacterCreate({ speed: 0 })).toBe(false); // a real value, not "unset"
    });
  });

  describe('resolveCharacterCreateStatus', () => {
    it('defaults minimal creates to draft', () => {
      expect(resolveCharacterCreateStatus({ name: 'Newbie' } as never, Dnd5eAdapter)).toBe('draft');
    });

    it('keeps non-minimal API creates active for backward compatibility', () => {
      expect(resolveCharacterCreateStatus({ name: 'Hero', hpMax: 20 } as never, Dnd5eAdapter)).toBe('active');
    });

    // Issue #1910 review (Codex, PR #1980, round 5): a { name, speed } create used to be
    // indistinguishable from a bare { name } create (draft, 0/0 HP, skipped by encounter
    // auto-add), unlike an otherwise-equivalent { name, ac } create (active, 10/10 HP).
    it('keeps a speed-only API create active, matching an ac-only create (issue #1910)', () => {
      expect(resolveCharacterCreateStatus({ name: 'Fleet', speed: 40 } as never, Dnd5eAdapter)).toBe('active');
    });

    it('derives dead lifecycle status when deathState is dead and status is omitted (issue #1757)', () => {
      expect(resolveCharacterCreateStatus({ name: 'Fallen', hpMax: 20, deathState: 'dead' } as never, Dnd5eAdapter)).toBe(
        'dead',
      );
      expect(resolveCharacterCreateStatus({ name: 'Ghost', deathState: 'dead' } as never, Dnd5eAdapter)).toBe('dead');
    });

    it('preserves explicit status even when deathState is dead (issue #1757)', () => {
      expect(
        resolveCharacterCreateStatus({ name: 'Fallen', hpMax: 20, deathState: 'dead', status: 'active' } as never, Dnd5eAdapter),
      ).toBe('active');
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
    it('characterizes sheet topology across all registered adapters and fallback for unregistered slugs', () => {
      for (const adapter of listRuleSystemAdapters()) {
        expect(adapter.characterSheet?.abilityFields.length).toBeGreaterThan(0);
        expect(adapter.characterSheet?.classField).toBeDefined();
      }
      const fallbackAdapter = ruleSystemAdapter('unregistered-slug');
      expect(fallbackAdapter.characterSheet?.abilityFields.map((f: { key: string }) => f.key)).toEqual(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']);
    });
  });
});

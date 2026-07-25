import {
  blankCharacterCreate,
  characterCompletionChecklist,
  characterCreateFromTemplate,
  findStarterTemplate,
  isCharacterSheetComplete,
  isMinimalCharacterCreate,
  resolveCharacterCreateStatus,
  starterTemplatesForAdapter,
} from '@campfire/schema';
import { Dnd5eAdapter, OpenLegendAdapter, Pf2eAdapter } from '@campfire/schema';

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

    it('marks template sheets complete when all essentials are set', () => {
      const template = findStarterTemplate(Dnd5eAdapter, '5e-fighter')!;
      const sheet = characterCreateFromTemplate(template, { name: 'Bryn', level: 1 });
      expect(isCharacterSheetComplete(sheet, Dnd5eAdapter)).toBe(true);
    });
  });
});

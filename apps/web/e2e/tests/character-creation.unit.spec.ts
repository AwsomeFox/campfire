import { expect, test } from '@playwright/test';
import { Dnd5eAdapter, Pf2eAdapter, OpenLegendAdapter, blankCharacterCreate, starterTemplatesForAdapter } from '@campfire/schema';

test.describe('character creation UI helpers (issue #719)', () => {
  test('offers starter templates for 5e, PF2e, and Open Legend', () => {
    expect(starterTemplatesForAdapter(Dnd5eAdapter).length).toBeGreaterThan(0);
    expect(starterTemplatesForAdapter(Pf2eAdapter).length).toBeGreaterThan(0);
    expect(starterTemplatesForAdapter(OpenLegendAdapter).length).toBeGreaterThan(0);
  });

  test('blank sheet payload is an intentional draft without placeholder stats', () => {
    const payload = blankCharacterCreate({ name: 'Aria', level: 1 });
    expect(payload.status).toBe('draft');
    expect(payload.hpMax).toBe(0);
    expect(Object.keys(payload.stats)).toHaveLength(0);
  });
});

import { expect, test } from '@playwright/test';
import { importExpectedUpdatedAt, ruleEntryIconEndpoint, serializeHomebrewEditor, shouldRenderCompendiumResults } from '../../src/features/compendium/homebrewEditor';

const base = { name: 'Spark', slug: 'spark', type: 'spell', summary: '', body: '', rightsStatus: 'private_original', license: '', attribution: '', sourceUrl: '', dataJson: '{}' };

test('serializes typed numeric and JSON fields and drops stale fields after type switch', () => {
  const spell = serializeHomebrewEditor(base, { level: '2', school: 'evocation', ac: '99' }, false);
  expect(spell.ok && spell.value.data).toEqual({ level: 2, school: 'evocation' });
  const monster = serializeHomebrewEditor({ ...base, type: 'monster' }, { level: '8', ac: '14', actions: '[{"name":"Bite"}]' }, false);
  expect(monster.ok && monster.value.data).toEqual({ ac: 14, actions: [{ name: 'Bite' }] });
});

test('validates raw objects and rights provenance', () => {
  expect(serializeHomebrewEditor({ ...base, dataJson: '[]' }, {}, true)).toEqual({ ok: false, error: 'Raw data must be a JSON object.' });
  expect(serializeHomebrewEditor({ ...base, rightsStatus: 'permission_granted' }, {}, false).ok).toBe(false);
  expect(serializeHomebrewEditor({ ...base, rightsStatus: 'open_licensed', license: 'CC-BY-4.0', attribution: 'Creator', sourceUrl: 'not-a-url' }, {}, false).ok).toBe(false);
});

test('builds replacement CAS versions and chooses campaign icon route', () => {
  expect(importExpectedUpdatedAt([{ slug: 'a', conflict: { updatedAt: 'v1' } }, { slug: 'b', conflict: null }])).toEqual({ a: 'v1' });
  expect(ruleEntryIconEndpoint('/api/v1', 7, { id: 3, campaignId: 7 })).toBe('/api/v1/campaigns/7/homebrew/3');
  expect(ruleEntryIconEndpoint('/api/v1', 7, { id: 3, campaignId: null })).toBe('/api/v1/rules/entries/3');
});

test('homebrew-only campaign renders results without a global pack', () => {
  expect(shouldRenderCompendiumResults({ campaignResolved: true, homebrewCount: 1, hasGlobalPack: false })).toBe(true);
  expect(shouldRenderCompendiumResults({ campaignResolved: true, homebrewCount: 0, hasGlobalPack: false })).toBe(false);
  expect(shouldRenderCompendiumResults({ campaignResolved: true, homebrewCount: 0, hasGlobalPack: true })).toBe(true);
});

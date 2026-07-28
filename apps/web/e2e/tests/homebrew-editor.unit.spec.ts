import { expect, test } from '@playwright/test';
import { serializeHomebrewEditor } from '../../src/features/compendium/homebrewEditor';

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

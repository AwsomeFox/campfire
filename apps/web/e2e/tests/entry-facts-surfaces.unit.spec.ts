import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Wiring guard for the non-creature stat view.
 *
 * `EntryFacts`'s own behaviour is covered by test/component/EntryFacts.spec.tsx. What that
 * test cannot see is whether the surfaces actually CALL it — and the defect being fixed was
 * exactly a wiring gap, not a rendering one: every surface gated its structured view behind
 * `hasMonsterStatblock`, which returns false for items, spells, feats and hazards, so their
 * `dataJson` stats were unreachable. The inventory card additionally printed the JSON
 * string into a `<pre>`. These assertions pin the wiring at each place a player meets an
 * item: the compendium reader, the encounter rules lookup, the inventory/character-sheet
 * row, and the acquire-from-compendium picker.
 */
const reader = readFileSync(resolve(__dirname, '../../src/features/compendium/ReaderPage.tsx'), 'utf8');
const rulesLookup = readFileSync(resolve(__dirname, '../../src/features/encounters/RulesLookupPanel.tsx'), 'utf8');
const inventoryShared = readFileSync(resolve(__dirname, '../../src/features/inventory/inventoryShared.tsx'), 'utf8');

const SURFACES: Array<[string, string]> = [
  ['compendium reader', reader],
  ['encounter rules lookup', rulesLookup],
  ['inventory row + compendium picker', inventoryShared],
];

test.describe('non-creature entry stats are rendered wherever an item is read', () => {
  for (const [name, source] of SURFACES) {
    test(`${name} renders EntryFacts from dataJson`, () => {
      expect(source).toContain("from '../../components/EntryFacts'");
      expect(source).toContain('hasEntryFacts(');
      expect(source).toContain('<EntryFacts');
    });
  }

  test('the reader and rules lookup no longer let the creature-only gate hide item stats', () => {
    // Facts render when the entry is NOT a creature statblock. Without the negated guard
    // the branch is dead for the very entries it exists to serve.
    expect(reader).toContain('const showsFacts = !showsStatblock && hasEntryFacts(');
    expect(rulesLookup).toMatch(/!hasMonsterStatblock\([\s\S]{0,120}?&&\s*hasEntryFacts\(/);
  });

  test('the reader shows "no details" only when there is genuinely nothing to show', () => {
    // The fallback used to fire for every item whose body was empty, while its stats sat
    // unread in dataJson.
    expect(reader).toContain('showsFacts ? null : (');
    expect(reader).toContain('No details available for this entry.');
  });

  test('the inventory row shows formatted stats instead of dumping raw JSON', () => {
    expect(inventoryShared).toContain("t('inventory.compendium.statsLabel')");
    expect(inventoryShared).not.toContain('compendiumSnapshot.dataJson}</pre>');
  });

  test('the compendium picker previews the highlighted entry stats before acquiring', () => {
    expect(inventoryShared).toContain('hasEntryFacts(selectedEntry.dataJson)');
  });
});

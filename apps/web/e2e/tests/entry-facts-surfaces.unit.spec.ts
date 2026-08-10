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

const combatantStatblock = readFileSync(
  resolve(__dirname, '../../src/features/encounters/combat/CombatantStatblock.tsx'),
  'utf8',
);

const SURFACES: Array<[string, string]> = [
  ['compendium reader', reader],
  ['encounter rules lookup', rulesLookup],
  ['inventory row + compendium picker', inventoryShared],
  ['in-combat statblock', combatantStatblock],
];

test.describe('non-creature entry stats are rendered wherever an item is read', () => {
  for (const [name, source] of SURFACES) {
    test(`${name} renders EntryFacts from dataJson`, () => {
      // Depth-agnostic: these files sit at different nesting levels under src/features.
      expect(source).toMatch(/from '(?:\.\.\/)+components\/EntryFacts'/);
      expect(source).toContain('hasEntryFacts(');
      expect(source).toContain('<EntryFacts');
    });
  }

  test('the reader and rules lookup no longer let the creature-only gate hide item stats', () => {
    // Facts render when the entry is NOT a creature statblock. Without the negated guard
    // the branch is dead for the very entries it exists to serve.
    expect(reader).toContain('const showsFacts = !showsStatblock && hasEntryFacts(');
    expect(rulesLookup).toMatch(/!entryRendersMonsterStatblock\([\s\S]{0,140}?&&\s*hasEntryFacts\(/);
  });

  test('every statblock gate is the entry-TYPE-aware one, never the bare data predicate', () => {
    // `hasMonsterStatblock` is data-only, and the PF2e adapter maps generic traits/level
    // onto creatureType/challengeRating — so on a pf2e or sf2e campaign it answers true for
    // every item, spell and feat. A surface that gates a creature-only view on it hides the
    // fact list from exactly the entries that need it. `entryRendersMonsterStatblock`
    // additionally requires `type === 'monster'`; these surfaces must use only that.
    for (const source of [reader, rulesLookup, combatantStatblock]) {
      expect(source).toContain('entryRendersMonsterStatblock(');
      // The bare predicate must not appear outside the entry-aware wrapper's own name.
      expect(source.replace(/entryRendersMonsterStatblock/g, '')).not.toContain('hasMonsterStatblock');
    }
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

  test('a hazard combatant still gets a structured view in encounters', () => {
    // AddCombatantPanel searches for and accepts `hazard` entries as well as `monster`, so
    // gating the in-combat panel on `type === 'monster'` alone would leave every hazard
    // showing "No statblock details for this entry."
    const addPanel = readFileSync(resolve(__dirname, '../../src/features/encounters/combat/AddCombatantPanel.tsx'), 'utf8');
    expect(addPanel).toContain("['monster', 'hazard']");
    expect(combatantStatblock).toMatch(/entry && hasEntryFacts\(entry\.dataJson\) \? \(/);
  });

  /**
   * This used to assert the OPPOSITE shape — a `max-h-[22vh]` cap on the stats preview
   * alone — and it passed while the bug it names was live. Capping only the preview left
   * the rest of the selected-entry block (owner, quantity, notes) unbounded and the
   * results list pinned to a `min-h-[200px]` floor it could not yield, so the footer was
   * still pushed past the card's `overflow-hidden` edge: on an 800px viewport the Add
   * button sat 105px below it and could not be clicked at all.
   *
   * The real invariant is structural, so that is what is asserted now: exactly the two
   * regions that may absorb pressure are `flex-1 min-h-0` scrollers, and the footer never
   * shrinks. `compendium-picker-reachable-add.spec.ts` covers the rendered geometry in a
   * browser, which is what actually proves the button is reachable.
   */
  test('the picker gives its scroll pressure to the two flexible regions, never the footer', () => {
    expect(inventoryShared).toContain('max-h-[85vh]');
    // The selected-entry block is a bounded scroller, not an unbounded stack.
    expect(inventoryShared).toMatch(/flex-1 min-h-0 overflow-y-auto pt-3 border-t/);
    // The results list keeps a browsing floor only while nothing is selected.
    expect(inventoryShared).toMatch(/selectedEntry \? 'min-h-0' : 'min-h-\[\d+px\]'/);
    // The footer carrying Cancel/Add must never be the thing that yields.
    expect(inventoryShared).toMatch(/shrink-0 flex items-center justify-between pt-2 border-t/);
    // …and the stats preview no longer carries a competing cap of its own.
    expect(inventoryShared).not.toMatch(/max-h-\[\d+vh\] overflow-y-auto[^>]*compendium-picker-stats/s);
  });
});

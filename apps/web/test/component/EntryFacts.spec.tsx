/**
 * Component-render coverage for EntryFacts — the structured stat view for NON-creature
 * compendium entries.
 *
 * The bug this guards: every rendering surface gated its structured view behind
 * `hasMonsterStatblock`, which is creature-only. An imported item therefore showed its
 * prose (or "No details available") and never its price, damage, or AC — even though the
 * importer had them in `dataJson` — and the inventory card printed the raw JSON string.
 * A source scan can confirm the component is imported; only mounting it proves the values
 * are actually parsed out of `dataJson`, labelled, ordered, and formatted.
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import { describe, test, expect, afterEach } from 'vitest';
import '../../src/i18n';
import { EntryFacts, hasEntryFacts, parseEntryFacts } from '../../src/components/EntryFacts';
import { entryRendersMonsterStatblock, hasMonsterStatblock } from '../../src/components/StatBlock';

afterEach(() => cleanup());

/** A real Starfinder 2e weapon as the fixed importer emits it. */
const AUTOTARGET_RIFLE = JSON.stringify({
  level: 0,
  price: '45 credits',
  bulk: '2',
  category: 'weapon',
  itemCategory: 'Weapons',
  rarity: 'Common',
  hands: '2',
  damage: '1d6 P',
  damageType: ['Piercing'],
  weaponCategory: 'Simple',
  weaponGroup: 'Projectile',
  weaponType: 'Ranged',
  range: '30 ft.',
  reload: '2',
  traits: ['Analog', 'Automatic'],
});

function factValue(label: string): string {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  return value?.textContent ?? '';
}

describe('EntryFacts', () => {
  test('renders an item’s stats out of the dataJson string', () => {
    render(<EntryFacts data={AUTOTARGET_RIFLE} />);
    expect(factValue('Price')).toBe('45 credits');
    expect(factValue('Damage')).toBe('1d6 P');
    expect(factValue('Damage Type')).toBe('Piercing');
    expect(factValue('Range')).toBe('30 ft.');
    expect(factValue('Reload')).toBe('2');
    expect(factValue('Bulk')).toBe('2');
    expect(factValue('Hands')).toBe('2');
    // `itemCategory` ('Weapons') is the printed shelf; the coarse `category` ('weapon') is
    // the same fact at lower resolution and must not double up under the same label.
    expect(factValue('Category')).toBe('Weapons');
    expect(screen.getAllByText('Category', { selector: 'dt' })).toHaveLength(1);
  });

  test('renders traits as their own chip row, not as a fact line', () => {
    render(<EntryFacts data={AUTOTARGET_RIFLE} />);
    const traits = screen.getByRole('list', { name: 'Traits' });
    expect(within(traits).getByText('Analog')).toBeTruthy();
    expect(within(traits).getByText('Automatic')).toBeTruthy();
    expect(screen.queryByText('Traits', { selector: 'dt' })).toBeNull();
  });

  test('keeps dt/dd as direct children of the dl so the term/definition semantics survive', () => {
    // They must be direct children to sit on the dl's two grid tracks. Doing that with a
    // per-pair wrapper + `display: contents` lays out the same but is known to drop the
    // wrapped elements from the accessibility tree in Safari/VoiceOver.
    const { container } = render(<EntryFacts data={AUTOTARGET_RIFLE} />);
    const list = container.querySelector('dl')!;
    for (const child of Array.from(list.children)) {
      expect(['DT', 'DD']).toContain(child.tagName);
      expect((child as HTMLElement).style.display).not.toBe('contents');
    }
    expect(list.querySelectorAll(':scope > dt').length).toBe(list.querySelectorAll(':scope > dd').length);
  });

  test('orders the stats a reader scans first ahead of the long tail', () => {
    render(<EntryFacts data={AUTOTARGET_RIFLE} />);
    const labels = screen.getAllByRole('term').map((el) => el.textContent);
    expect(labels.indexOf('Level')).toBeLessThan(labels.indexOf('Price'));
    expect(labels.indexOf('Price')).toBeLessThan(labels.indexOf('Damage'));
    expect(labels.indexOf('Damage')).toBeLessThan(labels.indexOf('Range'));
  });

  test('formats armor penalties with their printed sign', () => {
    render(<EntryFacts data={{ ac: 4, dexCap: 1, checkPenalty: -2, speedPenalty: -5, strength: 3 }} />);
    expect(factValue('AC')).toBe('4');
    expect(factValue('Dex Cap')).toBe('+1');
    expect(factValue('Check Penalty')).toBe('-2');
    expect(factValue('Speed Penalty')).toBe('-5');
    // `strength` is an armor requirement, not a modifier — it stays unsigned.
    expect(factValue('Strength')).toBe('3');
  });

  test('formats numeric maps, signing the ones that are modifiers', () => {
    render(<EntryFacts data={{ saves: { fortitude: 9, reflex: -1 }, resistances: { cold: 15 } }} />);
    expect(factValue('Saves')).toBe('fortitude +9, reflex -1');
    expect(factValue('Resistances')).toBe('cold 15');
  });

  test('drops the derived `max` key when printing a speed map', () => {
    render(<EntryFacts data={{ speed: { land: 20, fly: 40, max: 40 } }} />);
    expect(factValue('Speed')).toBe('land 20 ft., fly 40 ft.');
  });

  test('hides the importer’s internal keys and the creature-only statblock arrays', () => {
    render(<EntryFacts data={{ kind: 'background', skills: { religion: 1 }, actions: [{ name: 'Strike' }], abilityMods: { strength: 4 } }} />);
    expect(screen.queryByText('Kind', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Actions', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Ability Mods', { selector: 'dt' })).toBeNull();
    expect(factValue('Skills')).toBe('religion +1');
  });

  test('renders nothing at all when there is no data to show', () => {
    for (const empty of [null, undefined, '', '{}', 'not json', '[]', { traits: [] }]) {
      expect(hasEntryFacts(empty)).toBe(false);
      const { container } = render(<EntryFacts data={empty} />);
      expect(container.innerHTML).toBe('');
      cleanup();
    }
  });

  test('surfaces a field the importer adds later without a code change here', () => {
    // The whole point of the data-driven design: an unknown key still renders, just at the
    // end of the list, rather than being silently dropped the way a fixed layout would.
    const parsed = parseEntryFacts({ price: '1 gp', someBrandNewStat: 'wondrous' });
    expect(parsed?.facts.map((f) => f.label)).toEqual(['Price', 'Some Brand New Stat']);
  });
});

/**
 * The gate that decides which of the two structured views an entry gets.
 *
 * This is where the fix nearly failed silently. `hasMonsterStatblock` inspects data only,
 * and `Pf2eAdapter.mapStatblock` maps generic `traits` onto `creatureType` and `level` onto
 * `challengeRating` — so on a campaign whose ruleSystem selects that adapter, EVERY item,
 * spell and feat the importer produces satisfies it. Surfaces that gated a creature-only
 * view on the data predicate alone rendered `showsFacts === false` for exactly the entries
 * the facts view exists to serve, and only on exactly the campaigns that install these
 * packs. A default-ruleSystem test cannot see it, which is why these cases pass one.
 */
describe('creature-statblock gate vs. non-creature entries', () => {
  const ITEM = JSON.stringify({ level: 0, price: '1 gp', damage: '1d8 S', traits: ['Versatile'] });
  const SPELL = JSON.stringify({ rank: 3, traditions: ['Arcane'], range: '500 feet', traits: ['Fire'] });
  const CREATURE = JSON.stringify({ level: -1, ac: 16, hp: 6, abilityMods: { strength: 0 }, traits: ['Goblin'] });

  for (const ruleSystem of ['pf2e', 'sf2e-srd', 'pf2e-srd']) {
    test(`ruleSystem "${ruleSystem}": non-creature entries are NOT treated as statblocks`, () => {
      // The data predicate alone says yes — that is the trap, pinned here so the reason
      // the type gate exists stays visible.
      expect(hasMonsterStatblock(ITEM, ruleSystem)).toBe(true);
      expect(hasMonsterStatblock(SPELL, ruleSystem)).toBe(true);

      // The entry-aware gate says no, so these fall through to the fact list.
      expect(entryRendersMonsterStatblock('item', ITEM, ruleSystem)).toBe(false);
      expect(entryRendersMonsterStatblock('spell', SPELL, ruleSystem)).toBe(false);
      expect(entryRendersMonsterStatblock('feat', ITEM, ruleSystem)).toBe(false);
      expect(entryRendersMonsterStatblock('hazard', ITEM, ruleSystem)).toBe(false);

      // …and a real creature still gets its statblock.
      expect(entryRendersMonsterStatblock('monster', CREATURE, ruleSystem)).toBe(true);
    });
  }

  test('an entry type with nothing renderable still gets no statblock', () => {
    expect(entryRendersMonsterStatblock('monster', '{}', 'pf2e')).toBe(false);
    expect(entryRendersMonsterStatblock(null, CREATURE, 'pf2e')).toBe(false);
    expect(entryRendersMonsterStatblock(undefined, CREATURE, 'pf2e')).toBe(false);
  });

  test('the item that tripped it renders its price and damage as facts', () => {
    render(<EntryFacts data={ITEM} />);
    expect(factValue('Price')).toBe('1 gp');
    expect(factValue('Damage')).toBe('1d8 S');
  });
});

/**
 * Structured values the fact list cannot render as one line.
 *
 * A flattener that emits what it understands and returns '' for the rest looks correct on
 * the data it was written against while quietly discarding everything else — and this
 * component replaced the inventory card's raw-JSON disclosure, so a dropped value became
 * unreachable from every surface. Datasworn asset entries are the live case: `controls`
 * nests four levels (`integrity → controls → battered → …`).
 */
describe('EntryFacts — values too structured for a fact line', () => {
  // Trimmed from the real Starforged "Starship" asset as the importer stores it.
  const DATASWORN_ASSET = {
    category: 'Command Vehicle',
    shared: true,
    controls: {
      integrity: {
        label: 'integrity',
        field_type: 'condition_meter',
        min: 0,
        max: 5,
        controls: { battered: { label: 'battered', field_type: 'checkbox', value: false } },
      },
    },
  };

  test('keeps them reachable as raw data instead of dropping them', () => {
    render(<EntryFacts data={DATASWORN_ASSET} />);
    // The flat facts still render normally…
    expect(factValue('Category')).toBe('Command Vehicle');
    expect(factValue('Shared')).toBe('Yes');
    // …and the nested structure is present rather than silently gone.
    const raw = screen.getByTestId('entry-facts-raw');
    expect(raw.textContent).toContain('battered');
    expect(raw.textContent).toContain('condition_meter');
    expect(JSON.parse(raw.textContent!)).toEqual({ controls: DATASWORN_ASSET.controls });
  });

  test('reports them through parseEntryFacts rather than folding them into facts', () => {
    const parsed = parseEntryFacts(DATASWORN_ASSET)!;
    expect(parsed.facts.map((f) => f.key)).toEqual(['category', 'shared']);
    expect(Object.keys(parsed.complex)).toEqual(['controls']);
  });

  test('an entry whose ONLY content is structured still renders something', () => {
    // Previously this produced a null parse and the caller fell through to
    // "No details available" while the data sat in dataJson.
    expect(hasEntryFacts({ controls: DATASWORN_ASSET.controls })).toBe(true);
    render(<EntryFacts data={{ controls: DATASWORN_ASSET.controls }} />);
    expect(screen.getByTestId('entry-facts-raw')).toBeTruthy();
  });

  test('a list of objects is kept whole, not flattened to its scalar crumbs', () => {
    const parsed = parseEntryFacts({ price: '1 gp', stages: [{ stage: 1, effect: 'weakened' }] })!;
    expect(parsed.facts.map((f) => f.key)).toEqual(['price']);
    expect(parsed.complex).toEqual({ stages: [{ stage: 1, effect: 'weakened' }] });
  });

  test('one level of scalar nesting stays inline — it reads fine and needs no disclosure', () => {
    const parsed = parseEntryFacts({ saves: { fortitude: 9, reflex: -1 } })!;
    expect(parsed.complex).toEqual({});
    expect(parsed.facts[0].value).toBe('fortitude +9, reflex -1');
  });
});

describe('EntryFacts — label localization', () => {
  test('resolves known keys through the catalog, not the hardcoded English map', async () => {
    const i18n = (await import('../../src/i18n')).default;
    const previous = i18n.language;
    try {
      await i18n.changeLanguage('ar');
      render(<EntryFacts data={{ price: '1 gp', damage: '1d8 S', savingThrow: 'Reflex' }} />);
      // The section heading was already translated; before this, the terms under it were
      // not, so an Arabic reader saw an Arabic heading over an English list.
      expect(screen.getByText('السعر', { selector: 'dt' })).toBeTruthy();
      expect(screen.getByText('الضرر', { selector: 'dt' })).toBeTruthy();
      expect(screen.getByText('رمية الإنقاذ', { selector: 'dt' })).toBeTruthy();
      expect(screen.queryByText('Price', { selector: 'dt' })).toBeNull();
    } finally {
      await i18n.changeLanguage(previous);
    }
  });

  test('falls back to readable English for a key the catalog has never seen', async () => {
    const i18n = (await import('../../src/i18n')).default;
    const previous = i18n.language;
    try {
      await i18n.changeLanguage('ar');
      // Importers emit new fields faster than the catalog gains entries; an unknown key
      // must degrade to a readable term, never to a raw `camelCase` token or a blank.
      render(<EntryFacts data={{ someBrandNewStat: 'wondrous' }} />);
      expect(screen.getByText('Some Brand New Stat', { selector: 'dt' })).toBeTruthy();
    } finally {
      await i18n.changeLanguage(previous);
    }
  });
});

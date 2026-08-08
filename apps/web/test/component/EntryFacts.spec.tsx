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
import { EntryFacts, hasEntryFacts, parseEntryFacts } from '../../src/components/EntryFacts';

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

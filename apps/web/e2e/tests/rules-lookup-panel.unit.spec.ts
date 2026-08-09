import { expect, test } from '@playwright/test';
import type { RuleEntry } from '@campfire/schema';
import {
  buildSearchUrlParams,
  filterHomebrewEntries,
  getDisplayedResults,
  getInitialCollapsedState,
  mergeRulesAndHomebrew,
  resolvePackName,
  resolveStatblockSystem,
  updateRecentLookups,
} from '../../src/features/encounters/RulesLookupPanel';

test.describe('RulesLookupPanel unit logic (#1929)', () => {
  const dummyRule = (id: number, name: string, type: 'condition' | 'spell' | 'monster' = 'condition', packId = 1): RuleEntry => ({
    id,
    packId,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    type,
    summary: `${name} summary`,
    body: `Body of ${name}`,
    dataJson: null,
    source: 'SRD 5.1',
    license: 'OGL 1.0a',
    attribution: '',
    author: '',
    sourceUrl: '',
    iconSlug: '',
    rightsStatus: 'open_licensed',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  test('buildSearchUrlParams omits pack when ruleSystem is empty string or null', () => {
    const scoped = buildSearchUrlParams('grappled', 'open5e-srd');
    expect(scoped.get('q')).toBe('grappled');
    expect(scoped.get('pack')).toBe('open5e-srd');
    expect(scoped.get('limit')).toBe('8');

    const unscoped = buildSearchUrlParams('grappled', '');
    expect(unscoped.get('q')).toBe('grappled');
    expect(unscoped.has('pack')).toBe(false);
    expect(unscoped.get('limit')).toBe('8');

    const nullScoped = buildSearchUrlParams('grappled', null);
    expect(nullScoped.has('pack')).toBe(false);

    const emptyQuery = buildSearchUrlParams('', 'open5e-srd');
    expect(emptyQuery.has('q')).toBe(false);
    expect(emptyQuery.get('pack')).toBe('open5e-srd');

    const multiPack = buildSearchUrlParams('owl', 'open5e-srd', 8, ['shared-bestiary', 'open5e-srd']);
    expect(multiPack.getAll('pack')).toEqual(['open5e-srd', 'shared-bestiary']);
    expect(multiPack.has('packs')).toBe(false);

    const stableOrder = buildSearchUrlParams('owl', 'z-core', 8, ['middle-pack', 'a-supplement']);
    expect(stableOrder.getAll('pack')).toEqual(['a-supplement', 'middle-pack', 'z-core']);

    const commaSlug = buildSearchUrlParams('owl', 'core,rules', 8, ['shared,bestiary']);
    expect(commaSlug.getAll('pack')).toEqual(['core,rules', 'shared,bestiary']);
  });

  test('filterHomebrewEntries returns empty array when query is empty and filters homebrew when active', () => {
    const hb1 = dummyRule(101, 'Custom Grapple', 'condition');
    const hb2 = dummyRule(102, 'Super Poison', 'condition');
    hb2.summary = 'Inflicts customized toxicity';
    const hbList = [hb1, hb2];

    expect(filterHomebrewEntries(hbList, '')).toEqual([]);
    expect(filterHomebrewEntries(hbList, '   ')).toEqual([]);
    expect(filterHomebrewEntries(hbList, 'grapple')).toEqual([hb1]);
    expect(filterHomebrewEntries(hbList, 'toxicity')).toEqual([hb2]);
    expect(filterHomebrewEntries(hbList, 'nonexistent')).toEqual([]);
  });

  test('mergeRulesAndHomebrew merges homebrew (badged isHomebrew) and pack search items without duplicates', () => {
    const hb1 = dummyRule(101, 'Homebrew Curse', 'condition');
    const pack1 = dummyRule(1, 'Grappled', 'condition');
    const pack2 = dummyRule(101, 'Duplicate ID Entry', 'condition'); // duplicate ID with hb1

    const merged = mergeRulesAndHomebrew([pack1, pack2], [hb1], 'curse');
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ ...hb1, isHomebrew: true });
    expect(merged[1]).toEqual(pack1);
  });

  test('updateRecentLookups caps at 5 entries, deduping by ID with most recent first', () => {
    const r1 = dummyRule(1, 'Grappled');
    const r2 = dummyRule(2, 'Prone');
    const r3 = dummyRule(3, 'Poisoned');
    const r4 = dummyRule(4, 'Stunned');
    const r5 = dummyRule(5, 'Blinded');
    const r6 = dummyRule(6, 'Deafened');

    let recents: RuleEntry[] = [];
    recents = updateRecentLookups(recents, r1);
    recents = updateRecentLookups(recents, r2);
    recents = updateRecentLookups(recents, r3);
    recents = updateRecentLookups(recents, r4);
    recents = updateRecentLookups(recents, r5);

    expect(recents.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);

    // Adding 6th entry should drop the oldest (1)
    recents = updateRecentLookups(recents, r6);
    expect(recents.map((r) => r.id)).toEqual([6, 5, 4, 3, 2]);

    // Opening r3 again should move it to top without duplicating
    recents = updateRecentLookups(recents, r3);
    expect(recents.map((r) => r.id)).toEqual([3, 6, 5, 4, 2]);
  });

  test('getDisplayedResults prepends expanded recent entry if outside active search results', () => {
    const searchItem = dummyRule(1, 'Grappled');
    const recentItem = dummyRule(99, 'Fireball');
    const merged = [searchItem];
    const recents = [recentItem];

    expect(getDisplayedResults(merged, recents, null)).toEqual([searchItem]);

    const displayed = getDisplayedResults(merged, recents, 99);
    expect(displayed).toHaveLength(2);
    expect(displayed[0]).toEqual(recentItem);
    expect(displayed[1]).toEqual(searchItem);
  });

  test('collapse persistence reads sessionStorage values correctly', () => {
    expect(getInitialCollapsedState(null)).toBe(true);
    expect(getInitialCollapsedState('true')).toBe(true);
    expect(getInitialCollapsedState('false')).toBe(false);
  });

  test('resolves pack display names and statblock adapters without treating supplemental slugs as rule systems', () => {
    const packNameMap = new Map<number, string>([
      [1, '5e SRD'],
      [2, 'PF2e SRD'],
    ]);
    const packMap = new Map<number, { slug: string; extendsPackSlug: string | null }>([
      [1, { slug: 'open5e-srd', extendsPackSlug: null }],
      [2, { slug: 'pf2e-bestiary-extension', extendsPackSlug: 'pf2e-srd' }],
    ]);

    expect(resolvePackName(1, packNameMap)).toBe('5e SRD');
    expect(resolvePackName(99, packNameMap)).toBeNull();
    expect(resolvePackName(undefined, packNameMap)).toBeNull();

    expect(resolveStatblockSystem('pf2e-srd', 2, packMap)).toBe('pf2e-srd');
    expect(resolveStatblockSystem('', 2, packMap)).toBe('pf2e-srd');
    expect(resolveStatblockSystem('', 1, packMap)).toBe('open5e-srd');
    expect(resolveStatblockSystem('', 99, packMap)).toBe('');
  });
});

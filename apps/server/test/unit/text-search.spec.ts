import { compareSearchText, foldForSearch, foldedIncludes, foldedIndexOf, matchesSearchQuery, scheduledAtSearchText } from '../../src/common/text-search';

describe('foldForSearch (issue #624)', () => {
  it('NFKC-normalizes ligatures and compatibility forms', () => {
    expect(foldForSearch('ﬁsh')).toBe('fish');
    expect(foldedIncludes('ﬁsh', foldForSearch('FISH'))).toBe(true);
  });

  it('matches composed and decomposed accents', () => {
    const composed = 'café';
    const decomposed = 'cafe\u0301'; // e + combining acute
    expect(foldForSearch(composed)).toBe(foldForSearch(decomposed));
    expect(foldedIncludes('CAFÉ', foldForSearch('café'))).toBe(true);
    expect(foldedIncludes(decomposed, foldForSearch('CAFÉ'))).toBe(true);
  });

  it('folds Turkish İ/I to a form ASCII needles can match', () => {
    expect(foldForSearch('İstanbul')).toBe('istanbul');
    expect(foldForSearch('ISTANBUL')).toBe('istanbul');
    expect(foldedIncludes('İstanbul Guard', foldForSearch('istanbul'))).toBe(true);
    expect(foldedIncludes('Istanbul Guard', foldForSearch('İSTANBUL'))).toBe(true);
  });

  it('maps German ß to ss (Unicode full case folding)', () => {
    expect(foldForSearch('Straße')).toBe('strasse');
    expect(foldForSearch('STRASSE')).toBe('strasse');
    expect(foldedIncludes('Straße Guard', foldForSearch('strasse'))).toBe(true);
    expect(foldedIncludes('STRASSE Guard', foldForSearch('straße'))).toBe(true);
  });

  it('uses fixed en-US case folding (not the runtime default locale)', () => {
    // en-US lowercases dotted capital I to i+dot then we collapse to plain i.
    // A Turkish default locale would map undotted I → ı instead.
    expect(foldForSearch('I')).toBe('i');
    expect(foldForSearch('İ')).toBe('i');
  });

  it('keeps emoji stable under fold', () => {
    const withEmoji = 'Party at 🐉 Café 🎉';
    const folded = foldForSearch(withEmoji);
    expect(folded).toContain('🐉');
    expect(folded).toContain('🎉');
    expect(folded).toBe('party at 🐉 café 🎉');
    expect(foldedIncludes(withEmoji, foldForSearch('🐉'))).toBe(true);
  });

  it('does not mutate identity of already-folded ASCII', () => {
    expect(foldForSearch('hello world')).toBe('hello world');
  });
});

describe('foldedIndexOf / compareSearchText', () => {
  it('finds folded needle index for snippet windows', () => {
    expect(foldedIndexOf('Hello CAFÉ World', foldForSearch('café'))).toBeGreaterThanOrEqual(0);
    expect(foldedIndexOf('nope', foldForSearch('café'))).toBe(-1);
  });

  it('sorts deterministically with explicit en locale', () => {
    const titles = ['Örc', 'Apple', 'zebra', 'Äaron'];
    const sorted = [...titles].sort(compareSearchText);
    expect(sorted).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'variant', numeric: true })));
    // Stable relative order for ASCII regardless of host locale.
    expect(compareSearchText('Alpha', 'Beta')).toBeLessThan(0);
    expect(compareSearchText('Beta', 'Alpha')).toBeGreaterThan(0);
  });
});

describe('matchesSearchQuery (issue #1481 — FTS5-aligned prefix-token match)', () => {
  it('matches a token that starts with the whole query (prefix, not substring)', () => {
    expect(matchesSearchQuery('Vexley the Innkeeper', foldForSearch('vex'))).toBe(true);
    expect(matchesSearchQuery('Vex Hand', foldForSearch('vex'))).toBe(true);
    expect(matchesSearchQuery('Find the Vex Ledger', foldForSearch('vex'))).toBe(true);
  });

  it('does NOT match a query that is only a non-prefix substring (the reported defect)', () => {
    // "ex" is inside "Vexley" but no TOKEN starts with "ex" — the FTS5 index would
    // not match it either, so the LIKE/full-scan fallback must not either. Plain
    // substring (foldedIncludes) used to, returning a different set per deployment.
    expect(matchesSearchQuery('Vexley', foldForSearch('ex'))).toBe(false);
    expect(matchesSearchQuery('Campfire', foldForSearch('fire'))).toBe(false);
  });

  it('requires EVERY query token to prefix-match some token (FTS5 implicit AND)', () => {
    expect(matchesSearchQuery('Vexley the Innkeeper', foldForSearch('vex inn'))).toBe(true);
    expect(matchesSearchQuery('Vexley the Innkeeper', foldForSearch('vex zar'))).toBe(false);
  });

  it('matches a full token exactly', () => {
    expect(matchesSearchQuery('Foxglove', foldForSearch('foxglove'))).toBe(true);
    expect(matchesSearchQuery('Foxglove', foldForSearch('fox'))).toBe(true);
  });

  it('returns false for an empty needle or empty haystack', () => {
    expect(matchesSearchQuery('anything', foldForSearch(''))).toBe(false);
    expect(matchesSearchQuery('', foldForSearch('x'))).toBe(false);
    expect(matchesSearchQuery('   ', foldForSearch('x'))).toBe(false);
  });

  it('matches numeric/date tokens by prefix against a reformatted date composite', () => {
    // The raw ISO keeps "19" buried inside "20T19" (T is alphanumeric), so a plain
    // prefix-token match on the raw value misses "19:30" — the scheduling fallback
    // therefore matches scheduledAtSearchText(...), the composite the FTS5 aux
    // column stores (T/:/- → space).
    expect(matchesSearchQuery('2031-09-20T19:30:00.000Z', foldForSearch('19'))).toBe(false);
    expect(matchesSearchQuery('2031-09-20T19:30:00.000Z', foldForSearch('19:30'))).toBe(false);
    const composite = scheduledAtSearchText('2031-09-20T19:30:00.000Z');
    expect(composite).toBe('2031-09-20T19:30:00.000Z 2031 09 20 19 30 00.000Z');
    expect(matchesSearchQuery(composite, foldForSearch('19'))).toBe(true);
    expect(matchesSearchQuery(composite, foldForSearch('19:30'))).toBe(true);
    expect(matchesSearchQuery(composite, foldForSearch('2031-09-20'))).toBe(true);
  });
});

import { compareSearchText, foldForSearch, foldedIncludes, foldedIndexOf } from '../../src/common/text-search';

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

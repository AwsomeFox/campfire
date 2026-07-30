import { compareSearchText, firstTokenMatchIndex, foldForSearch, foldedIncludes, foldedIndexOf, matchesSearchQuery, scheduledAtSearchText } from '../../src/common/text-search';

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

  it('strips diacritics so accented and unaccented terms match symmetrically (issue #1493)', () => {
    expect(foldForSearch('Zoë')).toBe('zoe');
    expect(foldForSearch('Zoe')).toBe('zoe');
    expect(foldedIncludes('Zoë', foldForSearch('Zoe'))).toBe(true);
    expect(foldedIncludes('Zoe', foldForSearch('Zoë'))).toBe(true);

    expect(foldForSearch('Résumé')).toBe('resume');
    expect(foldForSearch('Resume')).toBe('resume');
    expect(foldedIncludes('Résumé', foldForSearch('Resume'))).toBe(true);
    expect(foldedIncludes('Resume', foldForSearch('Résumé'))).toBe(true);
  });

  it('keeps emoji stable under fold', () => {
    const withEmoji = 'Party at 🐉 Café 🎉';
    const folded = foldForSearch(withEmoji);
    expect(folded).toContain('🐉');
    expect(folded).toContain('🎉');
    expect(folded).toBe('party at 🐉 cafe 🎉');
    expect(foldedIncludes(withEmoji, foldForSearch('🐉'))).toBe(true);
  });

  it('preserves standalone ASCII punctuation diacritic characters like caret or backtick (issue #1493)', () => {
    expect(foldForSearch('^')).toBe('^');
    expect(foldForSearch('`')).toBe('`');
    expect(foldedIncludes('note with ^ caret', foldForSearch('^'))).toBe(true);
    expect(foldedIncludes('note with ` backtick', foldForSearch('`'))).toBe(true);
  });

  it('preserves Japanese voiced and semi-voiced kana distinctions (issue #1493)', () => {
    expect(foldForSearch('ガード')).toBe('ガード');
    expect(foldForSearch('カード')).toBe('カード');
    expect(foldForSearch('ガード')).not.toBe(foldForSearch('カード'));
  });

  it('folds ligatures æ -> ae and œ -> oe (issue #1493)', () => {
    expect(foldForSearch('Æther')).toBe('aether');
    expect(foldForSearch('Cœur')).toBe('coeur');
    expect(foldedIncludes('Æther Elemental', foldForSearch('aether'))).toBe(true);
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

describe('firstTokenMatchIndex (issue #1481 — snippet centering for non-contiguous matches)', () => {
  it('returns -1 when no query token prefix-matches any token', () => {
    expect(firstTokenMatchIndex('Vexley the Innkeeper', foldForSearch('dragon'))).toBe(-1);
    expect(firstTokenMatchIndex('a b c', foldForSearch(''))).toBe(-1);
  });

  it('locates the first matched token for a non-contiguous multi-token query', () => {
    // 'red dragon' is not contiguous in 'red ancient dragon', but 'red' and
    // 'dragon' are both token-prefix matches; the snippet must center on one of
    // them rather than the field opening. Folded, the matched token 'dragon'
    // starts after 'red ancient '.
    const text = 'The party faced a red ancient dragon at the gate.';
    const idx = firstTokenMatchIndex(text, foldForSearch('red dragon'));
    expect(idx).toBeGreaterThanOrEqual(0);
    // The window should land on 'red' (the earliest matched token) or 'dragon'.
    const window = text.slice(idx, idx + 40);
    expect(window).toMatch(/red|dragon/);
  });

  it('skips earlier non-matching prose to center on the matched term', () => {
    // >SNIPPET_PAD chars of padding before the matched term, so a naive opening
    // window would show none of it.
    const padding = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(4);
    const text = `${padding}Behold the crimson wyrm dragon awaits.`;
    const idx = firstTokenMatchIndex(text, foldForSearch('red dragon'));
    expect(idx).toBeGreaterThan(padding.length - 10);
    expect(text.slice(idx, idx + 40)).toMatch(/dragon|wyrm/);
  });

  it('uses token boundaries, not substring, to locate the match', () => {
    // 'red' is a substring of 'predators' (p-r-e-d) near the start, but
    // 'predators' does not START with 'red', so it is not a token-prefix match.
    // The index must be the standalone 'red' token, not the false-positive inside
    // 'predators' — otherwise the snippet would mis-center on the field opening.
    const text = 'predators attacked the red dragon';
    const idx = firstTokenMatchIndex(text, foldForSearch('red'));
    expect(idx).toBeGreaterThan(1);
    expect(text.slice(idx, idx + 3).toLowerCase()).toBe('red');
    const idx2 = firstTokenMatchIndex(text, foldForSearch('red dragon'));
    expect(text.slice(idx2, idx2 + 3).toLowerCase()).toBe('red');
  });
});

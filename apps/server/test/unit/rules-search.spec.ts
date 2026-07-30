import {
  clampRuleSearchLimit,
  decodeRuleSearchCursor,
  encodeRuleSearchCursor,
} from '../../src/modules/rules/rules-search';

describe('rules-search helpers (issue #613)', () => {
  it('clamps page size to default 50 and max 100', () => {
    expect(clampRuleSearchLimit(undefined)).toBe(50);
    expect(clampRuleSearchLimit(1)).toBe(1);
    expect(clampRuleSearchLimit(100)).toBe(100);
    expect(clampRuleSearchLimit(500)).toBe(100);
    expect(clampRuleSearchLimit(0)).toBe(50);
    expect(clampRuleSearchLimit(-3)).toBe(50);
  });

  it('round-trips browse/fts/like cursors and rejects mismatched modes', () => {
    const browse = encodeRuleSearchCursor({ v: 1, m: 'browse', n: 'alpha twin 00', i: 42 });
    expect(decodeRuleSearchCursor(browse, 'browse')).toEqual({
      v: 1,
      m: 'browse',
      n: 'alpha twin 00',
      i: 42,
    });
    expect(() => decodeRuleSearchCursor(browse, 'fts')).toThrow(/cursor/i);

    const fts = encodeRuleSearchCursor({ v: 1, m: 'fts', b: 0, r: -1.25, i: 7 });
    expect(decodeRuleSearchCursor(fts, 'fts')).toEqual({ v: 1, m: 'fts', b: 0, r: -1.25, i: 7 });

    const like = encodeRuleSearchCursor({ v: 1, m: 'like', b: 1, n: 'Poisoned', i: 9 });
    expect(decodeRuleSearchCursor(like, 'like')).toEqual({ v: 1, m: 'like', b: 1, n: 'Poisoned', i: 9 });

    expect(decodeRuleSearchCursor(undefined, 'browse')).toBeUndefined();
    expect(() => decodeRuleSearchCursor('%%%not-base64%%%', 'browse')).toThrow(/cursor/i);
  });

  it('round-trips non-ASCII names through cursor encode/decode unchanged (issue #1493)', () => {
    const nonAsciiName = 'Æther Elemental';
    const cursor = encodeRuleSearchCursor({ v: 1, m: 'browse', n: nonAsciiName, i: 101 });
    const decoded = decodeRuleSearchCursor(cursor, 'browse');
    expect(decoded).toEqual({ v: 1, m: 'browse', n: 'Æther Elemental', i: 101 });
  });
});

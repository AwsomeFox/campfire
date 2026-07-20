import { toJsonText, fromJsonText } from '../../src/common/json';
import { isProposed } from '../../src/common/proposed.util';

/**
 * Unit tests for the small serialisation / query-flag helpers (issue #79).
 * These wrap JSON (de)serialisation used for column round-tripping and the
 * `?proposed=` propose-instead-of-write flag.
 */
describe('json — toJsonText', () => {
  it('serialises a value', () => {
    expect(toJsonText({ a: 1 })).toBe('{"a":1}');
    expect(toJsonText([1, 2])).toBe('[1,2]');
  });

  it('maps null and undefined to the JSON literal null', () => {
    expect(toJsonText(null)).toBe('null');
    expect(toJsonText(undefined)).toBe('null');
  });
});

describe('json — fromJsonText', () => {
  it('parses valid JSON', () => {
    expect(fromJsonText<string[]>('["a","b"]', [])).toEqual(['a', 'b']);
  });

  it('returns the fallback for null/undefined/empty', () => {
    expect(fromJsonText(null, [])).toEqual([]);
    expect(fromJsonText(undefined, [])).toEqual([]);
    expect(fromJsonText('', 'fb')).toBe('fb');
  });

  it('returns the fallback (never throws) on malformed JSON', () => {
    expect(fromJsonText('{not json', { ok: true })).toEqual({ ok: true });
  });

  it('round-trips through toJsonText', () => {
    const value = { conditions: ['poisoned', 'prone'], n: 3 };
    expect(fromJsonText(toJsonText(value), null)).toEqual(value);
  });
});

describe('proposed — isProposed', () => {
  it.each(['true', '1'])('is true for %p', (v) => {
    expect(isProposed(v)).toBe(true);
  });

  it.each(['false', '0', '', 'yes', undefined])('is false for %p', (v) => {
    expect(isProposed(v as string | undefined)).toBe(false);
  });
});

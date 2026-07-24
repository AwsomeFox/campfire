import { describe, it, expect } from '@jest/globals';
import { normalizeMapTheme, GenerateMapParams } from '@campfire/schema';

/**
 * Free-form theme normalization (issue #410). The AI (or a chip) may propose any theme word;
 * the procedural renderer only knows a fixed palette enum, so an un-normalized theme used to
 * hard-fail GenerateMapParams.parse. normalizeMapTheme maps synonyms onto the palette and
 * drops the unknown so generation proceeds with the kind default instead of 400ing.
 */
describe('normalizeMapTheme (#410)', () => {
  it('passes valid enum themes through unchanged', () => {
    expect(normalizeMapTheme('stone')).toBe('stone');
    expect(normalizeMapTheme('cavern')).toBe('cavern');
    expect(normalizeMapTheme('forest')).toBe('forest');
    expect(normalizeMapTheme('crypt')).toBe('crypt');
  });

  it('maps common synonyms onto the nearest palette', () => {
    expect(normalizeMapTheme('volcanic')).toBe('cavern');
    expect(normalizeMapTheme('sylvan')).toBe('forest');
    expect(normalizeMapTheme('tomb')).toBe('crypt');
    expect(normalizeMapTheme('castle')).toBe('stone');
    expect(normalizeMapTheme('SWAMP')).toBe('forest');
  });

  it('returns undefined for an unmappable / empty / non-string theme', () => {
    expect(normalizeMapTheme('xyzzy-nonsense')).toBeUndefined();
    expect(normalizeMapTheme('')).toBeUndefined();
    expect(normalizeMapTheme(null)).toBeUndefined();
    expect(normalizeMapTheme(42)).toBeUndefined();
  });

  it('a free-form theme no longer fails the procedural enum once normalized', () => {
    // Raw free-form theme would throw:
    expect(() => GenerateMapParams.parse({ kind: 'dungeon', theme: 'volcanic' })).toThrow();
    // Normalized theme parses cleanly:
    const normalized = normalizeMapTheme('volcanic');
    expect(() => GenerateMapParams.parse({ kind: 'dungeon', theme: normalized })).not.toThrow();
    // And dropping an unknown theme also parses (kind default theme applies):
    expect(() => GenerateMapParams.parse({ kind: 'dungeon' })).not.toThrow();
  });
});

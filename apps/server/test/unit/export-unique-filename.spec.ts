import { slugify, uniqueFilename } from '../../src/modules/export/export.service';

/**
 * Unit tests for the uniqueFilename de-duping helper (issue #530).
 *
 * These exercise the pure helper directly — they exist only once the helper is
 * exported, so they cannot run against the pre-fix code (the export is absent).
 * The companion data-loss regression that DOES run against the unpatched code
 * lives in `export-markdown-zip.spec.ts`.
 */
describe('uniqueFilename (issue #530)', () => {
  it('returns the base unchanged on first use', () => {
    const seen = new Set<string>();
    expect(uniqueFilename(seen, 'bob')).toBe('bob');
    expect([...seen]).toEqual(['bob']);
  });

  it('appends -2 then -3 on repeats', () => {
    const seen = new Set<string>();
    expect(uniqueFilename(seen, 'bob')).toBe('bob');
    expect(uniqueFilename(seen, 'bob')).toBe('bob-2');
    expect(uniqueFilename(seen, 'bob')).toBe('bob-3');
    expect(seen.size).toBe(3);
  });

  it('tracks distinct bases independently', () => {
    const seen = new Set<string>();
    expect(uniqueFilename(seen, 'alice')).toBe('alice');
    expect(uniqueFilename(seen, 'bob')).toBe('bob');
    expect(uniqueFilename(seen, 'alice')).toBe('alice-2');
    expect(uniqueFilename(seen, 'bob')).toBe('bob-2');
  });

  it('does not collide when base already looks like base-2', () => {
    // If two distinct entities slug to "bob" and a third entity literally named
    // "bob 2" also slugs to "bob-2", the helper must keep allocating fresh
    // names rather than handing out a duplicate.
    const seen = new Set<string>();
    expect(uniqueFilename(seen, 'bob')).toBe('bob');
    expect(uniqueFilename(seen, 'bob')).toBe('bob-2');
    expect(uniqueFilename(seen, 'bob-2')).toBe('bob-2-2');
  });
});

describe('slugify + uniqueFilename composition', () => {
  it('produces stable, distinct filenames for case/whitespace variants', () => {
    const seen = new Set<string>();
    // "Bob", "bob", and "BOB" all slug to "bob" — three collisions.
    const names = ['Bob', 'bob', 'BOB'];
    const files = names.map((n) => uniqueFilename(seen, slugify(n)));
    expect(files).toEqual(['bob', 'bob-2', 'bob-3']);
  });
});

/**
 * Issue #740 — Compendium provenance: actionable, honest source URLs.
 *
 * Rule packs/entries store `sourceUrl`, but the reader previously showed
 * attribution as dead text. These helpers decide whether a stored value is a
 * safe http(s) link, whether it is entry-specific or only the pack/API
 * homepage, and when to say "Source unavailable" instead of implying
 * traceability.
 *
 * Pure helper coverage via `pw-unit.config.ts` (no browser / seeded server):
 *
 *   npx playwright test --config pw-unit.config.ts e2e/tests/compendium-provenance.unit.spec.ts
 */
import { expect, test } from '@playwright/test';
import {
  COMPENDIUM_SOURCE_ENTRY_LABEL,
  COMPENDIUM_SOURCE_PACK_LABEL,
  COMPENDIUM_SOURCE_UNAVAILABLE,
  classifySourceUrl,
  resolveCompendiumSource,
} from '../../src/features/compendium/compendiumProvenance';

test.describe('classifySourceUrl (issue #740)', () => {
  test('accepts valid absolute http and https URLs', () => {
    expect(classifySourceUrl('https://open5e.com/spells/fireball')).toEqual({
      ok: true,
      href: 'https://open5e.com/spells/fireball',
    });
    expect(classifySourceUrl('http://example.com/path?q=1')).toEqual({
      ok: true,
      href: 'http://example.com/path?q=1',
    });
    // Trim surrounding whitespace; normalize via URL.href.
    expect(classifySourceUrl('  https://example.com/a  ')).toEqual({
      ok: true,
      href: 'https://example.com/a',
    });
  });

  test('missing / blank values are not actionable', () => {
    expect(classifySourceUrl(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(classifySourceUrl(null)).toEqual({ ok: false, reason: 'missing' });
    expect(classifySourceUrl('')).toEqual({ ok: false, reason: 'missing' });
    expect(classifySourceUrl('   ')).toEqual({ ok: false, reason: 'missing' });
  });

  test('malformed values are not actionable', () => {
    expect(classifySourceUrl('not a url')).toEqual({ ok: false, reason: 'malformed' });
    expect(classifySourceUrl('/relative/path')).toEqual({ ok: false, reason: 'malformed' });
    expect(classifySourceUrl('https://')).toEqual({ ok: false, reason: 'malformed' });
    expect(classifySourceUrl('https://user:pass@example.com/secret')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  test('non-HTTP schemes are rejected (never rendered as links)', () => {
    expect(classifySourceUrl('javascript:alert(1)')).toEqual({ ok: false, reason: 'non-http' });
    expect(classifySourceUrl('data:text/html,hi')).toEqual({ ok: false, reason: 'non-http' });
    expect(classifySourceUrl('ftp://files.example.com/pack')).toEqual({ ok: false, reason: 'non-http' });
    expect(classifySourceUrl('mailto:dm@example.com')).toEqual({ ok: false, reason: 'non-http' });
  });
});

test.describe('resolveCompendiumSource (issue #740)', () => {
  test('entry-specific deep link when entry URL differs from pack homepage', () => {
    const resolved = resolveCompendiumSource({
      entrySourceUrl: 'https://open5e.com/spells/fireball',
      packSourceUrl: 'https://api.open5e.com',
    });
    expect(resolved).toEqual({
      kind: 'entry',
      href: 'https://open5e.com/spells/fireball',
      label: COMPENDIUM_SOURCE_ENTRY_LABEL,
      unavailable: false,
    });
  });

  test('pack/API homepage when entry inherits (or matches) the pack URL', () => {
    const same = resolveCompendiumSource({
      entrySourceUrl: 'https://api.open5e.com',
      packSourceUrl: 'https://api.open5e.com',
    });
    expect(same).toEqual({
      kind: 'pack',
      href: 'https://api.open5e.com/',
      label: COMPENDIUM_SOURCE_PACK_LABEL,
      unavailable: false,
    });

    const packOnly = resolveCompendiumSource({
      entrySourceUrl: '',
      packSourceUrl: 'https://api.open5e.com',
    });
    expect(packOnly).toEqual({
      kind: 'pack',
      href: 'https://api.open5e.com/',
      label: COMPENDIUM_SOURCE_PACK_LABEL,
      unavailable: false,
    });
  });

  test('shows source unavailable for missing provenance (no implied link)', () => {
    const resolved = resolveCompendiumSource({ entrySourceUrl: '', packSourceUrl: '' });
    expect(resolved).toEqual({
      kind: 'unavailable',
      reason: 'missing',
      unavailable: true,
      label: COMPENDIUM_SOURCE_UNAVAILABLE,
    });
    expect(resolved.label).toBe('Source unavailable');
  });

  test('shows source unavailable for malformed entry URL (no silent pack fallback)', () => {
    const resolved = resolveCompendiumSource({
      entrySourceUrl: 'not a url',
      packSourceUrl: 'https://api.open5e.com',
    });
    expect(resolved).toEqual({
      kind: 'unavailable',
      reason: 'malformed',
      unavailable: true,
      label: COMPENDIUM_SOURCE_UNAVAILABLE,
    });
  });

  test('shows source unavailable for non-HTTP entry URL', () => {
    const resolved = resolveCompendiumSource({
      entrySourceUrl: 'javascript:alert(1)',
      packSourceUrl: 'https://api.open5e.com',
    });
    expect(resolved).toEqual({
      kind: 'unavailable',
      reason: 'non-http',
      unavailable: true,
      label: COMPENDIUM_SOURCE_UNAVAILABLE,
    });
  });

  test('pack-only malformed / non-HTTP also surface as unavailable', () => {
    expect(
      resolveCompendiumSource({ entrySourceUrl: '', packSourceUrl: 'ftp://files.example.com' }),
    ).toMatchObject({ kind: 'unavailable', reason: 'non-http', label: COMPENDIUM_SOURCE_UNAVAILABLE });
    expect(
      resolveCompendiumSource({ entrySourceUrl: '', packSourceUrl: '::bad' }),
    ).toMatchObject({ kind: 'unavailable', reason: 'malformed', label: COMPENDIUM_SOURCE_UNAVAILABLE });
  });
});

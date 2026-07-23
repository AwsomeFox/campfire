import { expect, test } from '@playwright/test';
import {
  COMPENDIUM_CLEAR_FILTERS_LABEL,
  COMPENDIUM_SEARCH_ID,
  COMPENDIUM_SEARCH_LABEL,
  COMPENDIUM_TYPE_FILTER_LABEL,
  COMPENDIUM_URL_Q,
  COMPENDIUM_URL_TYPE,
  applyCompendiumSearchParams,
  compendiumResultsStatus,
  parseCompendiumTypeParam,
} from '../../src/features/compendium/compendiumA11y';

/**
 * Issue #647 — Compendium search + type-filter accessible vocabulary.
 *
 * The page wires these strings into a persistent label, a named radiogroup,
 * and an aria-live status region; this unit file pins the copy itself.
 */

test.describe('compendium a11y vocabulary (issue #647)', () => {
  test('exposes a stable search id and persistent label (not placeholder-only)', () => {
    expect(COMPENDIUM_SEARCH_ID).toBe('compendium-search');
    expect(COMPENDIUM_SEARCH_LABEL.length).toBeGreaterThan(0);
    expect(COMPENDIUM_SEARCH_LABEL.toLowerCase()).toContain('search');
  });

  test('names the type-filter group and clear-filters control', () => {
    expect(COMPENDIUM_TYPE_FILTER_LABEL.length).toBeGreaterThan(0);
    expect(COMPENDIUM_CLEAR_FILTERS_LABEL.toLowerCase()).toContain('clear');
  });
});

test.describe('compendium URL filter params (issue #647)', () => {
  test('parses type from the URL and rejects unknown values', () => {
    expect(parseCompendiumTypeParam(null)).toBe('all');
    expect(parseCompendiumTypeParam('all')).toBe('all');
    expect(parseCompendiumTypeParam('spell')).toBe('spell');
    expect(parseCompendiumTypeParam('monster')).toBe('monster');
    expect(parseCompendiumTypeParam('section')).toBe('all');
    expect(parseCompendiumTypeParam('nope')).toBe('all');
  });

  test('applies q/type to search params and omits defaults', () => {
    const withFilters = applyCompendiumSearchParams(new URLSearchParams('tab=keep'), {
      q: '  fire  ',
      type: 'spell',
    });
    expect(withFilters.get(COMPENDIUM_URL_Q)).toBe('fire');
    expect(withFilters.get(COMPENDIUM_URL_TYPE)).toBe('spell');
    expect(withFilters.get('tab')).toBe('keep');

    const cleared = applyCompendiumSearchParams(withFilters, { q: '', type: 'all' });
    expect(cleared.get(COMPENDIUM_URL_Q)).toBeNull();
    expect(cleared.get(COMPENDIUM_URL_TYPE)).toBeNull();
    expect(cleared.get('tab')).toBe('keep');
  });
});

test.describe('compendium results status (issue #647)', () => {
  test('announces loading before a settled count', () => {
    expect(
      compendiumResultsStatus({
        loading: true,
        resultCount: 3,
        query: 'fire',
        typeKey: 'spell',
        typeLabel: 'Spells',
      }),
    ).toMatch(/searching/i);
  });

  test('announces empty and non-empty counts with query/type context', () => {
    expect(
      compendiumResultsStatus({
        loading: false,
        resultCount: 0,
        query: 'xyzzy',
        typeKey: 'all',
        typeLabel: 'All',
      }),
    ).toMatch(/no results for “xyzzy”/i);

    expect(
      compendiumResultsStatus({
        loading: false,
        resultCount: 0,
        query: '',
        typeKey: 'monster',
        typeLabel: 'Monsters',
      }),
    ).toMatch(/no monsters/i);

    expect(
      compendiumResultsStatus({
        loading: false,
        resultCount: 1,
        query: 'fire',
        typeKey: 'spell',
        typeLabel: 'Spells',
      }),
    ).toBe('1 result for “fire” in Spells.');

    expect(
      compendiumResultsStatus({
        loading: false,
        resultCount: 12,
        query: '',
        typeKey: 'all',
        typeLabel: 'All',
      }),
    ).toBe('12 results.');
  });

  test('suppresses empty/count copy when the search request failed', () => {
    // ErrorNote (role="alert") owns the failure announcement — avoid "no results" chatter.
    expect(
      compendiumResultsStatus({
        loading: false,
        resultCount: 0,
        query: 'fire',
        typeKey: 'spell',
        typeLabel: 'Spells',
        failed: true,
      }),
    ).toBe('');

    expect(
      compendiumResultsStatus({
        loading: false,
        resultCount: 3,
        query: '',
        typeKey: 'all',
        typeLabel: 'All',
        failed: true,
      }),
    ).toBe('');
  });
});

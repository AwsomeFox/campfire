/**
 * Money rendering and pricing identity (issue #1065).
 *
 * Two invariants that are cheap to state and were each broken once:
 *
 *   1. A price is always readable as a price. `toPrecision(2)` silently switches to
 *      exponential notation below 1e-7, which turned a real sub-cent per-turn figure into
 *      "≈$1.5e-7" — a string no operator can compare to their provider's bill.
 *
 *   2. The pricing IDENTITY is one definition. The editor, the write-side validator and the
 *      resolver all key on `(providerType, model, baseUrl)`, and when each spelled that out
 *      separately they disagreed about case and about blank rows.
 */
import { expect, test } from '@playwright/test';
import { aiPricingDuplicateIndices, aiPricingIdentityKey, normalizePricingBaseUrl } from '@campfire/schema';
import { formatApproxUsd, formatUsdRangeValue } from '../../src/features/ai-dm/costEstimate';

test.describe('formatApproxUsd (#1065)', () => {
  test('never renders scientific notation, however small the figure', () => {
    // The regression: `(1.5e-7).toPrecision(2)` is the string "1.5e-7".
    expect(formatApproxUsd(1.5e-7)).toBe('≈$0.00000015');
    expect(formatApproxUsd(1e-9)).toBe('≈$0.000000001');
    for (const v of [1.5e-7, 1e-9, 3.2e-8, 0.0041, 0.009, 0.5, 7, 42, 12_345]) {
      expect(formatApproxUsd(v)).not.toContain('e');
      expect(formatApproxUsd(v)).not.toContain('E');
    }
  });

  test('keeps two significant figures where they are the whole message', () => {
    expect(formatApproxUsd(0.0041)).toBe('≈$0.0041');
    expect(formatApproxUsd(0.002)).toBe('≈$0.002');
  });

  test('widens its bands as the figure grows, and prefixes ≈ throughout', () => {
    expect(formatApproxUsd(0)).toBe('≈$0.00');
    expect(formatApproxUsd(0.25)).toBe('≈$0.25');
    expect(formatApproxUsd(3.14)).toBe('≈$3.1');
    expect(formatApproxUsd(42.7)).toBe('≈$43');
  });

  test('a range collapses to one figure only when both ends read the same', () => {
    expect(formatUsdRangeValue(null)).toBeNull();
    expect(formatUsdRangeValue({ low: 0.2, high: 0.2 })).toBe('≈$0.20');
    expect(formatUsdRangeValue({ low: 0.25, high: 1 })).toBe('≈$0.25–$1.0');
  });
});

test.describe('pricing identity (#1065)', () => {
  const row = (providerType: string, model: string, baseUrl = '') => ({ providerType, model, baseUrl });

  test('is case- and whitespace-insensitive across all three parts', () => {
    expect(aiPricingIdentityKey(row(' OpenAI ', 'GPT-4o'))).toBe(aiPricingIdentityKey(row('openai', 'gpt-4o')));
    expect(aiPricingIdentityKey(row('openai', 'gpt-4o', 'https://Proxy.example/v1 ')))
      .toBe(aiPricingIdentityKey(row('openai', 'gpt-4o', 'https://proxy.example/v1')));
  });

  test('treats the base URL as part of the key, never as decoration', () => {
    expect(aiPricingDuplicateIndices([row('openai', 'gpt-4o'), row('openai', 'gpt-4o', 'https://proxy/v1')])).toEqual([]);
  });

  test('case-folds a base URL only where a URL is case-insensitive', () => {
    // Scheme and host are case-insensitive; the parser also drops a redundant default port.
    expect(normalizePricingBaseUrl('HTTPS://API.Example.COM/v1')).toBe('https://api.example.com/v1');
    expect(normalizePricingBaseUrl('https://api.example.com:443/v1')).toBe('https://api.example.com/v1');
    expect(aiPricingIdentityKey(row('openai', 'gpt-4o', 'HTTPS://Proxy.Example/v1')))
      .toBe(aiPricingIdentityKey(row('openai', 'gpt-4o', 'https://proxy.example/v1')));
  });

  test('keeps two tenants on one host apart, path case and all', () => {
    // The regression: lowercasing the whole URL merged these, so an admin could not price
    // them separately and one tenant's negotiated rate could be applied to the other.
    expect(normalizePricingBaseUrl('https://gw.example/TenantA'))
      .not.toBe(normalizePricingBaseUrl('https://gw.example/tenanta'));
    expect(
      aiPricingDuplicateIndices([
        row('openai', 'gpt-4o', 'https://gw.example/TenantA'),
        row('openai', 'gpt-4o', 'https://gw.example/tenanta'),
      ]),
    ).toEqual([]);
    // Query case is preserved for the same reason.
    expect(normalizePricingBaseUrl('https://gw.example/v1?deployment=ProdEU'))
      .not.toBe(normalizePricingBaseUrl('https://gw.example/v1?deployment=prodeu'));
  });

  test('compares an unparseable base URL verbatim rather than guessing at its parts', () => {
    expect(normalizePricingBaseUrl('  not a url  ')).toBe('not a url');
    expect(normalizePricingBaseUrl('')).toBe('');
    expect(normalizePricingBaseUrl(null)).toBe('');
  });

  test('reports the LATER index of a duplicate, so the first entry stays valid', () => {
    expect(aiPricingDuplicateIndices([row('openai', 'gpt-4o'), row('OpenAI', ' gpt-4O ')])).toEqual([1]);
  });

  test('does not call two half-typed rows duplicates of each other', () => {
    // Pressing "Add model" twice produced two blank rows, whose keys both collapsed to the
    // empty identity — stacking a phantom duplicate error on top of the required-field
    // errors those rows were already reporting.
    expect(aiPricingDuplicateIndices([row('', ''), row('', '')])).toEqual([]);
    expect(aiPricingDuplicateIndices([row('openai', ''), row('openai', '')])).toEqual([]);
    expect(aiPricingDuplicateIndices([row('', 'gpt-4o'), row('', 'gpt-4o')])).toEqual([]);
  });
});

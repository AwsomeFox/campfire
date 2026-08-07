import {
  ARCHMAGE_ADAPTER_ID,
  DND5E_PACK_SLUG,
  isImporterOnlyRuleSystemSlug,
  isRegisteredRuleSystemSlug,
  PF2E_PACK_SLUG,
} from '@campfire/schema';

/**
 * Issue #2081: `cepheus` is a fully-registered importer (source `cepheus`, installed pack
 * slug `cepheus-srd`) with no entry in the `ADAPTERS` registry, so selecting it as a
 * campaign's `ruleSystem` silently ran the campaign as D&D 5e (d20 initiative, 5e ability
 * modifiers on 2D6 UPP scores, 5e conditions/action economy/death saves, `maxLevel: 20`, a
 * concrete 5e XP suggestion). `isImporterOnlyRuleSystemSlug` is the schema-owned predicate
 * CampaignsService.validateRuleSystem (shared by REST and MCP — both write paths call the
 * same service method) uses to reject that selection server-side.
 */
describe('isImporterOnlyRuleSystemSlug (issue #2081)', () => {
  it('flags an installed pack slug with no ADAPTERS entry — the Cepheus case', () => {
    expect(isRegisteredRuleSystemSlug('cepheus-srd')).toBe(false);
    expect(isImporterOnlyRuleSystemSlug('cepheus-srd', true)).toBe(true);
  });

  it('does NOT flag the same unregistered slug when it does not name an installed pack', () => {
    // An arbitrary/homebrew/dangling slug that is not actually installed is the
    // long-standing, deliberate "falls back to 5e" default — not this issue's bug.
    expect(isImporterOnlyRuleSystemSlug('cepheus-srd', false)).toBe(false);
    expect(isImporterOnlyRuleSystemSlug('some-homebrew-slug', false)).toBe(false);
  });

  it('does NOT flag an installed pack slug that DOES have a registered adapter', () => {
    for (const slug of [DND5E_PACK_SLUG, PF2E_PACK_SLUG, ARCHMAGE_ADAPTER_ID, 'osric', 'swords-wizardry']) {
      expect(isRegisteredRuleSystemSlug(slug)).toBe(true);
      expect(isImporterOnlyRuleSystemSlug(slug, true)).toBe(false);
    }
  });

  it('is registry-derived: a hypothetical future importer shipped without an adapter is caught the same way, with no edit to the guard', () => {
    // This slug is never mentioned anywhere near isImporterOnlyRuleSystemSlug's implementation.
    // It stands in for "the next importer added without an ADAPTERS entry" the issue calls
    // out — the predicate has to catch it purely because it isn't in ADAPTERS, not because
    // anyone taught the guard its name.
    const hypotheticalFutureImporterSlug = 'traveller-srd-2d6-hypothetical-future-importer';
    expect(isRegisteredRuleSystemSlug(hypotheticalFutureImporterSlug)).toBe(false);
    expect(isImporterOnlyRuleSystemSlug(hypotheticalFutureImporterSlug, true)).toBe(true);
  });

  it('empty string is never flagged, installed or not', () => {
    expect(isImporterOnlyRuleSystemSlug('', true)).toBe(false);
    expect(isImporterOnlyRuleSystemSlug('', false)).toBe(false);
  });
});

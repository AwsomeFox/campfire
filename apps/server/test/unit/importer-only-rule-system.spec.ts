import {
  ARCHMAGE_ADAPTER_ID,
  DND5E_PACK_SLUG,
  isImporterOnlyRuleSystemSlug,
  isRegisteredRuleSystemSlug,
  PF2E_PACK_SLUG,
  RULE_PACK_SOURCE_META,
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

  // The critical case: a v1 of this guard (`isInstalledPack && !isRegisteredRuleSystemSlug`,
  // this PR's original push) flagged this too, because it never checked WHICH installer put
  // the pack there — only "installed" and "no adapter", a set that also contains every
  // uploaded/homebrew pack. That broke `apps/web/e2e/global-setup.ts`'s `e2e-open5e-actions`
  // fixture and `ai-dm-stuck.e2e-spec.ts`'s uploaded `dnd-homebrew-srd` campaign in CI. This
  // is the test that would have caught it before it ever reached a PR.
  it('does NOT flag a homebrew / uploaded / test-installed pack — the case the original guard missed', () => {
    for (const slug of ['dnd-homebrew-srd', 'pf-homebrew-srd', 'e2e-open5e-actions', 'some-homebrew-slug']) {
      expect(isRegisteredRuleSystemSlug(slug)).toBe(false); // no built-in adapter, same as Cepheus
      expect(isImporterOnlyRuleSystemSlug(slug, true)).toBe(false); // but NOT importer-only — stays selectable
    }
  });

  it('is registry-derived, not a `cepheus-srd` special case: every pack slug a registered source declares is flagged exactly when it has no ADAPTERS entry', () => {
    // Walks RULE_PACK_SOURCE_META itself rather than naming any one source, so this proves
    // the predicate reads the registry rather than hardcoding Cepheus. Today only 'cepheus'
    // has no ADAPTERS entry; the assertion is symmetric, so a future source added to the
    // registry without one would also show up here as `true`, with no edit to this test.
    let sawAtLeastOneImporterOnlySlug = false;
    for (const meta of Object.values(RULE_PACK_SOURCE_META)) {
      const slugs = Array.isArray(meta.packSlug) ? meta.packSlug : meta.packSlug ? [meta.packSlug] : [];
      for (const slug of slugs) {
        const hasAdapter = isRegisteredRuleSystemSlug(slug);
        if (!hasAdapter) sawAtLeastOneImporterOnlySlug = true;
        expect(isImporterOnlyRuleSystemSlug(slug, true)).toBe(!hasAdapter);
      }
    }
    // Guards against a vacuous pass (e.g. every packSlug getting dropped in a future edit).
    expect(sawAtLeastOneImporterOnlySlug).toBe(true);
  });

  it('empty string is never flagged, installed or not', () => {
    expect(isImporterOnlyRuleSystemSlug('', true)).toBe(false);
    expect(isImporterOnlyRuleSystemSlug('', false)).toBe(false);
  });
});

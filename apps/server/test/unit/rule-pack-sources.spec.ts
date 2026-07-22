import {
  RulePackInstallSource,
  RULE_PACK_SOURCE_META,
  rulePackSourceMeta,
  listRulePackSources,
} from '@campfire/schema';

/**
 * Unit tests for the install-source honesty metadata (issue #346). These pin down the
 * outcome of the #346 research pass — which placeholder systems got a real wired source and
 * which are honestly manual-upload-only — so a future edit can't silently re-list a dead
 * source as installable.
 */
describe('rule-pack install-source honesty metadata (#346)', () => {
  it('describes every install source in the enum, with no extras', () => {
    const enumValues = [...RulePackInstallSource.options].sort();
    const metaKeys = Object.keys(RULE_PACK_SOURCE_META).sort();
    expect(metaKeys).toEqual(enumValues);
    // Each entry's own `source` field matches its key.
    for (const [key, meta] of Object.entries(RULE_PACK_SOURCE_META)) {
      expect(meta.source).toBe(key);
    }
  });

  it('listRulePackSources() returns one metadata row per source in enum order', () => {
    const list = listRulePackSources();
    expect(list.map((m) => m.source)).toEqual([...RulePackInstallSource.options]);
  });

  it('wires the systems with a real open source as `api`, installable without a url', () => {
    for (const source of ['open5e', 'pf2e', 'sf2e', 'open-legend', 'other'] as const) {
      const meta = rulePackSourceMeta(source);
      expect(meta.sourceKind).toBe('api');
      expect(meta.installableWithoutUrl).toBe(true);
      expect(meta.candidateSourceUrl).toBeTruthy(); // the base the importer pulls from
    }
  });

  it('honestly flags systems with no open source as `manual-upload`, url required', () => {
    for (const source of ['pf1e', 'starfinder', 'archmage', 'osr'] as const) {
      const meta = rulePackSourceMeta(source);
      expect(meta.sourceKind).toBe('manual-upload');
      expect(meta.installableWithoutUrl).toBe(false);
      expect(meta.license.length).toBeGreaterThan(0);
      expect(meta.note.length).toBeGreaterThan(0);
    }
  });

  it('records the validated live source for Open Legend (the #346 win)', () => {
    const meta = rulePackSourceMeta('open-legend');
    expect(meta.license).toBe('Open Legend Community License');
    expect(meta.candidateSourceUrl).toContain('github.com/openlegend/core-rules');
  });
});

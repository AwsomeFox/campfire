import { createHash } from 'node:crypto';
import {
  buildCompendiumRef,
  computeRuleEntryContentHash,
  parseCompendiumRef,
  resolveImportedCombatantRuleEntryId,
  ruleEntryContentPayload,
} from '../../src/modules/campaigns/compendium-import';
import { stableStringify } from '../../src/modules/proposals/proposal-snapshot';

describe('compendium-import (unit)', () => {
  const pack = {
    id: 1,
    slug: 'test-pack',
    name: 'Test Pack',
    version: '2.0',
    license: 'OGL',
    sourceUrl: 'https://example.com',
    kind: 'base',
    extendsPackSlug: null,
    installedAt: '2026-01-01T00:00:00.000Z',
    entryCount: 1,
    manifestHash: 'test-manifest-hash',
  };

  const goblin = {
    id: 5,
    packId: 1,
    slug: 'goblin',
    name: 'Goblin',
    type: 'monster',
    summary: 'CR 0.25',
    body: 'Small humanoid',
    dataJson: JSON.stringify({ cr: 0.25, hp: 7 }),
    source: '',
    license: '',
    attribution: '',
    author: '',
    sourceUrl: '',
    iconSlug: 'goblin-override',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('content hash is stable and excludes server-local ids and icon overrides', () => {
    const hash = computeRuleEntryContentHash(goblin);
    expect(hash).toHaveLength(64);
    const otherId = { ...goblin, id: 999, packId: 42, iconSlug: 'other', updatedAt: '2099-01-01' };
    expect(computeRuleEntryContentHash(otherId)).toBe(hash);
  });

  it('content hash changes when portable entry content changes', () => {
    const base = computeRuleEntryContentHash(goblin);
    const changed = computeRuleEntryContentHash({ ...goblin, name: 'Hobgoblin' });
    expect(changed).not.toBe(base);
  });

  it('buildCompendiumRef carries pack slug/version and entry slug/type/hash', () => {
    const ref = buildCompendiumRef(goblin, pack);
    expect(ref).toEqual({
      packSlug: 'test-pack',
      packVersion: '2.0',
      entrySlug: 'goblin',
      entryType: 'monster',
      contentHash: computeRuleEntryContentHash(goblin),
    });
  });

  it('resolveImportedCombatantRuleEntryId never aliases legacy numeric ids', () => {
    const ref = buildCompendiumRef(goblin, pack);
    const resolution = new Map<string, number | null>();
    const resolved = resolveImportedCombatantRuleEntryId({ ruleEntryId: 5, name: 'Wrong' }, resolution);
    expect(resolved.ruleEntryId).toBeNull();
    expect(resolved.ignoredLegacyId).toBe(true);

    resolution.set(`${ref.packSlug}/${ref.entryType}/${ref.entrySlug}`, 99);
    const fromRef = resolveImportedCombatantRuleEntryId(
      { compendiumRef: ref, ruleEntryId: 5, name: 'Goblin' },
      resolution,
    );
    expect(fromRef.ruleEntryId).toBe(99);
    expect(fromRef.ignoredLegacyId).toBe(true);
    expect(fromRef.detached).toBe(false);
  });

  it('detach mode maps unresolved refs to null without using numeric ids', () => {
    const ref = buildCompendiumRef(goblin, pack);
    const resolution = new Map<string, number | null>([[`${ref.packSlug}/${ref.entryType}/${ref.entrySlug}`, null]]);
    const detached = resolveImportedCombatantRuleEntryId({ compendiumRef: ref, name: 'Goblin' }, resolution);
    expect(detached.ruleEntryId).toBeNull();
    expect(detached.detached).toBe(true);
  });

  it('parseCompendiumRef rejects malformed refs', () => {
    expect(parseCompendiumRef(null)).toBeNull();
    expect(parseCompendiumRef({ packSlug: 'x' })).toBeNull();
    expect(parseCompendiumRef({ ...buildCompendiumRef(goblin, pack), contentHash: 'short' })).toBeNull();
  });

  it('ruleEntryContentPayload parses dataJson for stable hashing', () => {
    const payload = ruleEntryContentPayload(goblin);
    expect(payload.dataJson).toEqual({ cr: 0.25, hp: 7 });
    const expected = createHash('sha256').update(stableStringify(payload)).digest('hex');
    expect(computeRuleEntryContentHash(goblin)).toBe(expected);
  });
});

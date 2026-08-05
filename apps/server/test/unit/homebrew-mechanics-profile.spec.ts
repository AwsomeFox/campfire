import {
  Archmage13aAdapter,
  tryCreateHomebrewRuleSystemAdapter,
  Dnd5eAdapter,
  DND5E_ADAPTER_ID,
  HomebrewMechanicsProfile,
  OPEN_LEGEND_ADAPTER_ID,
  OpenLegendAdapter,
  OSR_CONDITIONS,
  Pf2eAdapter,
  PF2E_ADAPTER_ID,
  actionEconomyForAdapter,
  hpModelForAdapter,
  hasDeathSavesForAdapter,
  gridDistanceForAdapter,
  initiativeModelForAdapter,
  isRegisteredRuleSystemSlug,
  listRuleSystemAdapters,
  NEUTRAL_ACTION_ECONOMY,
  NEUTRAL_HP_MODEL,
  ruleSystemAdapter,
  type RuleSystemAdapter,
} from '@campfire/schema';

/**
 * Widened homebrew rule-system adapter factory (issue #1502). `createOsrVariantAdapter` in
 * osr-adapter.ts already builds a complete RuleSystemAdapter from 13 pure-data fields for the
 * six built-in OSR retroclones (issue #765); these tests cover the WIDENING: a runtime-validated
 * profile shape any caller (persisted campaign data, a future upload/authoring UI) can supply,
 * the `ruleSystemAdapter(ruleSystem, customMechanicsProfile)` resolution seam, and — the risk
 * area explicitly called out for this issue — that NONE of this changes behavior for an
 * existing built-in system.
 */


/**
 * Non-null wrapper for the tests that pass a known-good profile. Resolution's own entry point
 * returns null for a profile that fails validation (a malformed persisted row must not throw on
 * a hot read path), so every call site here that expects an adapter says so explicitly.
 */
function mustCreateHomebrewAdapter(profile: unknown): RuleSystemAdapter {
  const adapter = tryCreateHomebrewRuleSystemAdapter(profile);
  if (!adapter) throw new Error('expected a valid homebrew profile to build an adapter');
  return adapter;
}

const validHomebrewProfile: HomebrewMechanicsProfile = {
  slug: 'my-pirate-hack',
  label: 'Pirate Hack',
  mechanicsSummary: 'A homebrew 2d6 pirate hack riding the OSR ability/save/AC/initiative shape.',
  abilityTable: 'sw-banded',
  abilityCap: 2,
  saves: ['Grit', 'Sea Legs'],
  acMode: 'ascending',
  acAnchor: 10,
  initiativeMode: 'group',
  initiativeDie: 6,
  initiativeUsesDexMod: false,
  tiebreak: 'order-only',
  conditions: ['Soaked', 'Becalmed', 'Cursed'],
};

describe('HomebrewMechanicsProfile — runtime validation (issue #1502)', () => {
  it('accepts a well-formed profile', () => {
    expect(() => HomebrewMechanicsProfile.parse(validHomebrewProfile)).not.toThrow();
  });

  it('rejects an out-of-enum abilityTable', () => {
    expect(() => HomebrewMechanicsProfile.parse({ ...validHomebrewProfile, abilityTable: 'not-a-real-table' })).toThrow();
  });

  it('rejects an out-of-enum acMode', () => {
    expect(() => HomebrewMechanicsProfile.parse({ ...validHomebrewProfile, acMode: 'sideways' })).toThrow();
  });

  it('rejects an out-of-enum initiativeMode', () => {
    expect(() => HomebrewMechanicsProfile.parse({ ...validHomebrewProfile, initiativeMode: 'simultaneous' })).toThrow();
  });

  it('rejects an out-of-enum tiebreak', () => {
    expect(() => HomebrewMechanicsProfile.parse({ ...validHomebrewProfile, tiebreak: 'coin-flip' })).toThrow();
  });

  it('rejects a missing required field', () => {
    const { slug: _slug, ...withoutSlug } = validHomebrewProfile;
    expect(() => HomebrewMechanicsProfile.parse(withoutSlug)).toThrow();
  });

  it('rejects an unknown extra field (strict)', () => {
    expect(() => HomebrewMechanicsProfile.parse({ ...validHomebrewProfile, resolutionModel: 'd100-under' })).toThrow();
  });

  it('rejects a non-boolean initiativeUsesDexMod', () => {
    expect(() => HomebrewMechanicsProfile.parse({ ...validHomebrewProfile, initiativeUsesDexMod: 'yes' })).toThrow();
  });
});

describe('tryCreateHomebrewRuleSystemAdapter — the widened factory (issue #1502)', () => {
  it('builds a complete RuleSystemAdapter from a validated profile', () => {
    const adapter = mustCreateHomebrewAdapter(validHomebrewProfile);
    expect(adapter.id).toBe('my-pirate-hack');
    expect(adapter.label).toBe('Pirate Hack');
  });

  it('drives initiative from the profile (group mode, no DEX mod)', () => {
    const adapter = mustCreateHomebrewAdapter(validHomebrewProfile);
    expect(initiativeModelForAdapter(adapter)).toEqual({ mode: 'group', usesDexModifier: false });
    expect(adapter.initiativeModifier({ DEX: 18 })).toBe(0);
    expect(adapter.initiativeDie).toBe(6);
  });

  it('drives initiative from a DIFFERENT profile (individual mode + DEX mod) — not a hardcoded default', () => {
    const individualProfile: HomebrewMechanicsProfile = {
      ...validHomebrewProfile,
      slug: 'my-individual-hack',
      initiativeMode: 'individual',
      initiativeUsesDexMod: true,
      abilityTable: 'bx-banded',
      abilityCap: 3,
    };
    const adapter = mustCreateHomebrewAdapter(individualProfile);
    expect(initiativeModelForAdapter(adapter)).toEqual({ mode: 'individual', usesDexModifier: true });
    expect(adapter.initiativeModifier({ DEX: 16 })).toBe(2); // bx-banded: 16 -> +2
  });

  it('drives its OWN condition vocabulary when the profile declares one', () => {
    const adapter = mustCreateHomebrewAdapter(validHomebrewProfile);
    expect(adapter.conditions).toEqual(['Soaked', 'Becalmed', 'Cursed']);
    expect(adapter.conditions).not.toEqual(OSR_CONDITIONS);
  });

  it('falls back to the shared OSR_CONDITIONS list when the profile omits conditions', () => {
    const { conditions: _conditions, ...withoutConditions } = validHomebrewProfile;
    const adapter = mustCreateHomebrewAdapter(withoutConditions);
    expect(adapter.conditions).toEqual(OSR_CONDITIONS);
  });

  it('drives action economy toward the honest NEUTRAL default — never 5e or PF2e slots', () => {
    const adapter = mustCreateHomebrewAdapter(validHomebrewProfile);
    expect(actionEconomyForAdapter(adapter)).toEqual(NEUTRAL_ACTION_ECONOMY);
    expect(actionEconomyForAdapter(adapter).slots.map((s) => s.key)).toEqual(['action']);
  });

  it('never carries 5e death saves or massive-damage-instant-death for a homebrew system', () => {
    const adapter = mustCreateHomebrewAdapter(validHomebrewProfile);
    expect(hasDeathSavesForAdapter(adapter)).toBe(false);
    expect(hpModelForAdapter(adapter)).toEqual(NEUTRAL_HP_MODEL);
  });

  it('rejects an invalid raw profile rather than silently building a partial adapter', () => {
    expect(tryCreateHomebrewRuleSystemAdapter({ ...validHomebrewProfile, acMode: 'bogus' })).toBeNull();
  });
});

describe('ruleSystemAdapter(ruleSystem, customMechanicsProfile) — the resolution seam (issue #1502)', () => {
  it('resolves a persisted custom profile when the slug matches', () => {
    const adapter = ruleSystemAdapter('my-pirate-hack', validHomebrewProfile);
    expect(adapter.id).toBe('my-pirate-hack');
    expect(adapter.label).toBe('Pirate Hack');
  });

  it('ignores a customMechanicsProfile whose OWN slug does not match ruleSystem (stale data safety net)', () => {
    const adapter = ruleSystemAdapter('some-other-slug', validHomebrewProfile);
    expect(adapter).toBe(Dnd5eAdapter);
  });

  it('is byte-identical to the pre-#1502 single-argument call when no profile is supplied', () => {
    expect(ruleSystemAdapter('my-pirate-hack')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('my-pirate-hack', null)).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('my-pirate-hack', undefined)).toBe(Dnd5eAdapter);
  });

  // Issue #1502 review risk: a customMechanicsProfile must NEVER override a built-in
  // registered system's mechanics — every one of these matches ADAPTERS directly and must
  // resolve to the SAME built-in adapter whether or not a (mismatched, irrelevant) homebrew
  // profile happens to be passed alongside.
  it.each([
    ['dnd5e', DND5E_ADAPTER_ID, Dnd5eAdapter],
    ['pf2e', PF2E_ADAPTER_ID, Pf2eAdapter],
    ['13th Age (archmage)', 'archmage', Archmage13aAdapter],
    ['Open Legend', OPEN_LEGEND_ADAPTER_ID, OpenLegendAdapter],
  ] as const)('a customMechanicsProfile never overrides the built-in %s adapter', (_label, slug, expectedAdapter) => {
    const withoutProfile = ruleSystemAdapter(slug);
    const withUnrelatedProfile = ruleSystemAdapter(slug, { ...validHomebrewProfile, slug });
    expect(withoutProfile).toBe(expectedAdapter);
    expect(withUnrelatedProfile).toBe(expectedAdapter);
    expect(withUnrelatedProfile).toBe(withoutProfile);
  });
});

describe('isRegisteredRuleSystemSlug (issue #1502)', () => {
  it.each([DND5E_ADAPTER_ID, PF2E_ADAPTER_ID, 'archmage', OPEN_LEGEND_ADAPTER_ID, 'osric', 'swords-wizardry'])(
    '%s is a built-in registered slug',
    (slug) => {
      expect(isRegisteredRuleSystemSlug(slug)).toBe(true);
    },
  );

  it('an arbitrary homebrew slug is not registered', () => {
    expect(isRegisteredRuleSystemSlug('my-pirate-hack')).toBe(false);
    expect(isRegisteredRuleSystemSlug('')).toBe(false);
  });
});

describe('Parity — a factory-produced homebrew adapter behaves like every other registered adapter (issue #1502)', () => {
  it('satisfies the same death-save/grid-distance/initiative/action-economy expectations as listRuleSystemAdapters() members', () => {
    const homebrewAdapter = mustCreateHomebrewAdapter(validHomebrewProfile);
    const allAdapters = [...listRuleSystemAdapters(), homebrewAdapter];
    for (const adapter of allAdapters) {
      const hasDeathSaves = hasDeathSavesForAdapter(adapter);
      const gridDistance = gridDistanceForAdapter(adapter);
      const initiativeModel = initiativeModelForAdapter(adapter);
      const actionEconomy = actionEconomyForAdapter(adapter);
      // Every non-5e/PF2e-family registered adapter (and, by construction, a factory-produced
      // homebrew one) shares this "else" shape from rule-system-adapter.spec.ts's own parity test.
      if (adapter.id === homebrewAdapter.id) {
        expect(hasDeathSaves).toBe(false);
        expect(gridDistance.square).toBe('euclidean');
        expect(initiativeModel.mode).toBe('group'); // this profile's own choice
        expect(actionEconomy.slots.map((s) => s.key)).toEqual(['action']);
      }
    }
    // The homebrew adapter is genuinely IN that combined list, not silently skipped.
    expect(allAdapters).toContain(homebrewAdapter);
  });
});

describe('#1502 review — resolution and diff hardening', () => {
  it('does not resolve an Object.prototype member as a rule-system adapter', () => {
    // `ADAPTERS[ruleSystem]` truthiness walked the prototype chain, so a campaign whose
    // ruleSystem happened to be 'constructor' / 'toString' / 'valueOf' resolved a builtin
    // JS function as its combat adapter. Resolution now asks the same own-property predicate
    // the server's homebrew-override guard asks.
    for (const slug of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(isRegisteredRuleSystemSlug(slug)).toBe(false);
      expect(ruleSystemAdapter(slug)).toBe(Dnd5eAdapter);
    }
  });

  it('still resolves a homebrew profile whose slug collides with an Object.prototype key', () => {
    const profile: HomebrewMechanicsProfile = { ...validHomebrewProfile, slug: 'constructor' };
    const adapter = ruleSystemAdapter('constructor', profile);
    expect(adapter).not.toBe(Dnd5eAdapter);
    expect(initiativeModelForAdapter(adapter).mode).toBe('group');
  });

  it('treats a MALFORMED stored profile as no profile at all rather than applying it', () => {
    // The server reads this column with an unchecked JSON.parse, so a row from an older
    // version, a restored backup, a hand repair, or an untrusted export document reaches
    // resolution unvalidated. Building the adapter straight from it meant an out-of-enum
    // abilityTable silently degraded to bx-banded — wrong maths presented as the table's own.
    const malformed = { ...validHomebrewProfile, abilityTable: 'not-a-real-table' };
    expect(ruleSystemAdapter('my-pirate-hack', malformed as unknown as HomebrewMechanicsProfile)).toBe(Dnd5eAdapter);

    // Missing a required field, and an unknown extra field, are rejected the same way.
    const { acMode: _dropped, ...incomplete } = validHomebrewProfile;
    expect(ruleSystemAdapter('my-pirate-hack', incomplete as unknown as HomebrewMechanicsProfile)).toBe(Dnd5eAdapter);
    const extra = { ...validHomebrewProfile, rogueField: 'x' };
    expect(ruleSystemAdapter('my-pirate-hack', extra as unknown as HomebrewMechanicsProfile)).toBe(Dnd5eAdapter);
  });

  it('resolution never throws on a bad profile — it is called on hot read paths', () => {
    for (const bad of [null, undefined, 'a string', 42, {}, { slug: 'my-pirate-hack' }]) {
      expect(() => ruleSystemAdapter('my-pirate-hack', bad as unknown as HomebrewMechanicsProfile)).not.toThrow();
    }
  });

});

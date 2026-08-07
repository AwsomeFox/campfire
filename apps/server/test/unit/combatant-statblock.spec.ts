import {
  Dnd5eAdapter,
  defaultCombatantStatblock,
  effectiveActionUsesMax,
  expandRawStatblockAction,
  expandStatblockActions,
  isResolvableSpec,
} from '@campfire/schema';

describe('combatant statblock expansion (issue #425)', () => {
  it('seeds a playable default manual statblock', () => {
    const block = defaultCombatantStatblock();
    expect(block.actions.length).toBeGreaterThan(0);
    expect(isResolvableSpec(block.actions[0].spec)).toBe(true);
  });

  it('expands attack_bonus actions into resolver-ready specs', () => {
    const action = expandRawStatblockAction(
      { name: 'Bite', desc: 'Melee attack.', attack_bonus: 5, damage: [{ expression: '1d8+3', type: 'piercing' }] },
      'action',
      'dnd5e',
    );
    expect(action.toHit).toBe('+5');
    expect(action.damage).toContain('piercing');
    expect(action.notes).toContain('Melee');
    expect(isResolvableSpec(action.spec)).toBe(true);
  });

  it('keeps a NEGATIVE damage modifier in flat, not in the dice formula (#1053)', () => {
    // `DamagePart.flat` used to be `.min(0)`, so this expander folded a penalty back into the
    // formula as "1d8-1" — which a 5e crit then re-rolled, doubling the penalty. Now the split
    // survives, and the resolver applies the system's crit rule to the dice half only.
    const action = expandRawStatblockAction(
      { name: 'Weak Bite', desc: 'Melee attack.', attack_bonus: 2, damage: [{ expression: '1d8-1', type: 'piercing' }] },
      'action',
      'dnd5e',
    );
    const part = action.spec!.outcomes.hit!.damage[0];
    expect(part.formula).toBe('1d8');
    expect(part.flat).toBe(-1);
  });

  it('expands saving-throw actions while preserving prose', () => {
    const action = expandRawStatblockAction(
      {
        name: 'Static Burst',
        desc: 'Each creature must make a DC 16 Dexterity saving throw.',
        savingThrow: { dc: 16, ability: 'Dexterity' },
        damage: [{ expression: '4d6', type: 'lightning' }],
      },
      'action',
    );
    expect(action.spec?.mode).toBe('save');
    expect(action.notes).toContain('Dexterity');
    expect(isResolvableSpec(action.spec)).toBe(true);
  });

  it('leaves multiattack as prose-only when no attack numbers exist', () => {
    const action = expandRawStatblockAction(
      { name: 'Multiattack', desc: 'The creature makes two claw attacks.' },
      'action',
    );
    expect(isResolvableSpec(action.spec)).toBe(false);
    expect(action.notes).toContain('two claw');
  });

  // Regression for a PR #1950 review finding: a description containing a "DC N Ability"
  // phrase is a real, intentional fallback for callers with no structured save field at all
  // (e.g. compendium monster prose) — confirm it still resolves when nothing else opts out.
  it('infers a save purely from description text when no structured field is given', () => {
    const action = expandRawStatblockAction(
      { name: 'Prose-Only Save', desc: 'Each target must make a DC 14 Wisdom saving throw.' },
      'action',
    );
    expect(isResolvableSpec(action.spec)).toBe(true);
    expect(action.spec?.mode).toBe('save');
  });

  // Regression for the DDB importer's explicit opt-out signal (issue #1903 review, PR #1950
  // round 12 — replacing round 10's overloading of `savingThrow: null`): `noSaveInference`
  // suppresses ALL save inference, including the description-text fallback, even when the
  // description itself contains a matching "DC N Ability" phrase.
  it('noSaveInference:true suppresses the description-text fallback entirely', () => {
    const action = expandRawStatblockAction(
      { name: 'Deliberately Unresolvable', desc: 'Each target must make a DC 14 Wisdom saving throw.', noSaveInference: true },
      'action',
    );
    expect(isResolvableSpec(action.spec)).toBe(false);
  });

  // Regression for a PR #1950 round-12 review finding: round 10's original fix treated an
  // explicit `null` on EITHER `savingThrow` or `saving_throw` as "suppress all inference,"
  // which broke callers (open5e/pf2e importers) that spread raw statblock data verbatim and
  // may set one of those two keys to `null` as "no structured value here" while a DIFFERENT
  // fallback (a numeric `save_dc`, or the description text) still holds the real answer.
  // `noSaveInference` fixes this by using a dedicated field instead of overloading these two.
  it('an explicit null on saving_throw does not block a save_dc fallback on the same entry (round-12 fix)', () => {
    const action = expandRawStatblockAction(
      { name: 'Partial Statblock Save', desc: 'Failed prose parse.', saving_throw: null, save_dc: 14, save_ability: 'Wisdom' },
      'action',
    );
    expect(isResolvableSpec(action.spec)).toBe(true);
    expect(action.spec?.mode).toBe('save');
  });

  it('an explicit null on saving_throw does not block the description-text fallback on the same entry (round-12 fix)', () => {
    const action = expandRawStatblockAction(
      { name: 'Partial Statblock Save Prose', desc: 'Each target must make a DC 14 Wisdom saving throw.', saving_throw: null },
      'action',
    );
    expect(isResolvableSpec(action.spec)).toBe(true);
    expect(action.spec?.mode).toBe('save');
  });

  it('expands a full fixture statblock via the adapter', () => {
    const data = {
      actions: [
        { name: 'Arc Blade', attackBonus: 8, damage: [{ expression: '2d10 + 5', type: 'lightning' }], desc: 'Melee.' },
        { name: 'Static Burst', savingThrow: { dc: 16, ability: 'Dexterity' }, damage: [{ expression: '4d6', type: 'lightning' }], desc: 'AoE.' },
      ],
    };
    const actions = expandStatblockActions(data, Dnd5eAdapter, 'dnd5e');
    expect(actions).toHaveLength(2);
    expect(actions[0].name).toBe('Arc Blade');
    expect(isResolvableSpec(actions[0].spec)).toBe(true);
    expect(isResolvableSpec(actions[1].spec)).toBe(true);
  });

  // Issue #1921: "Recharge 5-6" and "1/Day" statblock actions both expand with populated `uses`.
  describe('limited-use / recharge parsing (issue #1921)', () => {
    it('a structured "Recharge 5-6" usage object populates uses.recharge, with a pool of 1', () => {
      const action = expandRawStatblockAction(
        { name: 'Breath Weapon', desc: 'Fire.', attack_bonus: 9, usage: { type: 'recharge', min: 5, max: 6, label: 'Recharge 5-6' } },
        'action',
      );
      expect(action.spec?.uses.recharge).toBe('recharge-5-6');
      expect(action.spec?.uses.max).toBe(0);
      expect(effectiveActionUsesMax(action.spec!.uses)).toBe(1);
    });

    // Devin review on PR #2062: `recharge` also carries REST cadences, and those have no
    // in-encounter refresh path — the turn-start tick filters through `parseRechargeRange`,
    // which rejects them, and nothing resets action_uses on a rest yet. Treating them as a
    // pool of one would permanently exhaust an ability that used to be at-will.
    it('a rest cadence is NOT an implied pool of one, because nothing can refresh it mid-encounter', () => {
      for (const recharge of ['short-rest', 'long-rest', 'dawn']) {
        expect(effectiveActionUsesMax({ max: 0, recharge, concentration: false, repeatSave: false, spellLevel: 0, resourceKey: '', resourceCost: 0 })).toBe(0);
      }
      // ...while an explicit X/day pool alongside a rest cadence is still tracked on its max.
      expect(effectiveActionUsesMax({ max: 2, recharge: 'long-rest', concentration: false, repeatSave: false, spellLevel: 0, resourceKey: '', resourceCost: 0 })).toBe(2);
    });

    it('a bare "Recharge 6" free-text label (no structured type) still parses via the regex fallback', () => {
      const action = expandRawStatblockAction(
        { name: 'Frost Ray', desc: 'Cold.', attack_bonus: 6, usage: { label: 'Recharge 6' } },
        'action',
      );
      expect(action.spec?.uses.recharge).toBe('recharge-6-6');
      expect(effectiveActionUsesMax(action.spec!.uses)).toBe(1);
    });

    it('a structured "1/Day" (PER_DAY) usage object populates uses.max, with no recharge condition', () => {
      const action = expandRawStatblockAction(
        { name: 'Charm Gaze', desc: 'A DC 14 Wisdom saving throw.', savingThrow: { dc: 14, ability: 'Wisdom' }, usage: { type: 'perDay', uses: 1, label: '1/Day' } },
        'action',
      );
      expect(action.spec?.uses.max).toBe(1);
      expect(action.spec?.uses.recharge).toBe('');
      expect(effectiveActionUsesMax(action.spec!.uses)).toBe(1);
    });

    it('a "3/Day" per-day pool of more than one use populates uses.max accordingly', () => {
      const action = expandRawStatblockAction(
        { name: 'Minor Illusion', desc: 'A trick.', attack_bonus: 4, usage: { type: 'perDay', uses: 3, label: '3/Day' } },
        'action',
      );
      expect(action.spec?.uses.max).toBe(3);
      expect(effectiveActionUsesMax(action.spec!.uses)).toBe(3);
    });

    it('a bare "N/Day" free-text label (no structured type) parses via the regex fallback', () => {
      const action = expandRawStatblockAction(
        { name: 'Ray of Frost', desc: 'Cold.', attack_bonus: 5, usage: { label: '2/Day' } },
        'action',
      );
      expect(action.spec?.uses.max).toBe(2);
    });

    it('an at-will action (no usage object at all) has an empty uses block — effectiveActionUsesMax is 0', () => {
      const action = expandRawStatblockAction(
        { name: 'Claw', desc: 'A basic attack.', attack_bonus: 5, damage: [{ expression: '1d6', type: 'slashing' }] },
        'action',
      );
      expect(action.spec?.uses.max).toBe(0);
      expect(action.spec?.uses.recharge).toBe('');
      expect(effectiveActionUsesMax(action.spec!.uses)).toBe(0);
    });
  });
});

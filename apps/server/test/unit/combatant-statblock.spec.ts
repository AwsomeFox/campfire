import {
  Dnd5eAdapter,
  defaultCombatantStatblock,
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
});

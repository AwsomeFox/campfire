import { Dnd5eAdapter } from '@campfire/schema';
import {
  expandRawStatblockAction,
  expandStatblockActions,
  defaultCombatantStatblock,
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

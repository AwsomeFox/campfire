import { describe, it, expect } from '@jest/globals';
import { isDriverToolAllowed } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1075: Verify that the driver can now create encounters during live play,
 * enabling the full exploration→combat flow without human intervention.
 */
describe('AI Driver encounter creation allow-list (#1075)', () => {
  const writeTool = (name: string) => ({ name, mutating: true, proposalCapable: false });

  it('create_encounter is allowed for the driver seat', () => {
    expect(isDriverToolAllowed(writeTool('create_encounter'))).toBe(true);
  });

  it('begin_encounter, add_combatant, and roll_initiative remain allowed', () => {
    expect(isDriverToolAllowed(writeTool('begin_encounter'))).toBe(true);
    expect(isDriverToolAllowed(writeTool('add_combatant'))).toBe(true);
    expect(isDriverToolAllowed(writeTool('roll_initiative'))).toBe(true);
  });

  it('delete_encounter remains forbidden (destructive write)', () => {
    expect(isDriverToolAllowed(writeTool('delete_encounter'))).toBe(false);
  });

  it('filters a simulated toolset catalog to include create_encounter and combat tools while excluding destructive tools', () => {
    const catalog = [
      { name: 'create_encounter', mutating: true, proposalCapable: false },
      { name: 'add_combatant', mutating: true, proposalCapable: false },
      { name: 'roll_initiative', mutating: true, proposalCapable: false },
      { name: 'begin_encounter', mutating: true, proposalCapable: false },
      { name: 'end_encounter', mutating: true, proposalCapable: false },
      { name: 'next_turn', mutating: true, proposalCapable: false },
      { name: 'delete_encounter', mutating: true, proposalCapable: false },
      { name: 'uninstall_rule_pack', mutating: true, proposalCapable: false },
    ];

    const allowed = catalog.filter((t) => isDriverToolAllowed(t)).map((t) => t.name);
    expect(allowed).toEqual([
      'create_encounter',
      'add_combatant',
      'roll_initiative',
      'begin_encounter',
      'end_encounter',
      'next_turn',
    ]);
    expect(allowed).not.toContain('delete_encounter');
    expect(allowed).not.toContain('uninstall_rule_pack');
  });

  it('the full exploration→combat path tools are all allowed in sequence', () => {
    const combatPath = ['create_encounter', 'add_combatant', 'roll_initiative', 'begin_encounter'];
    for (const name of combatPath) {
      expect(isDriverToolAllowed(writeTool(name))).toBe(true);
    }
  });
});

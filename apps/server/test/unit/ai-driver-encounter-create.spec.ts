import { describe, it, expect } from '@jest/globals';
import { isDriverToolAllowed } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1075: Verify that the driver can now create encounters during live play,
 * enabling the full exploration→combat flow without human intervention.
 */
describe('AI Driver encounter creation allow-list (#1075)', () => {
  it('create_encounter is allowed for the driver', () => {
    expect(isDriverToolAllowed({ name: 'create_encounter', mutating: true, proposalCapable: false })).toBe(true);
  });

  it('begin_encounter remains allowed', () => {
    expect(isDriverToolAllowed({ name: 'begin_encounter', mutating: true, proposalCapable: false })).toBe(true);
  });

  it('update_encounter is NOT allowed (prep-time only)', () => {
    expect(isDriverToolAllowed({ name: 'update_encounter', mutating: true, proposalCapable: false })).toBe(false);
  });

  it('generate_map is NOT allowed (expensive prep-time action)', () => {
    expect(isDriverToolAllowed({ name: 'generate_map', mutating: true, proposalCapable: false })).toBe(false);
  });

  it('the full exploration→combat path tools are all allowed', () => {
    const combatPath = ['create_encounter', 'add_combatant', 'roll_initiative', 'begin_encounter'];
    for (const name of combatPath) {
      expect(isDriverToolAllowed({ name, mutating: true, proposalCapable: false })).toBe(true);
    }
  });
});

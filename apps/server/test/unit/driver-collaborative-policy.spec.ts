import { describe, expect, it } from '@jest/globals';
import {
  DRIVER_COLLABORATIVE_CONFIRM_ATTEMPTS_PER_TURN,
  DRIVER_COLLABORATIVE_DEFER_TOOLS,
  DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN,
  DRIVER_UNDOABLE_TOOLS,
  checkDriverPolicyRateLimits,
  resolveDriverToolPolicy,
  type DriverSessionProfile,
} from '../../src/modules/ai-driver/driver-tool-policy';

/**
 * Issue #1051 — collaborative handoff, at the policy seam.
 *
 * `resolveDriverToolPolicy` is a pure function, so the rule "collaborative mode only ever
 * TIGHTENS" is provable here rather than inferred from an end-to-end run. That property is the
 * one worth proving: a mode that could accidentally loosen a policy would be a privilege
 * escalation dressed as a safety feature.
 */
describe('collaborative handoff tool policy (#1051)', () => {
  const livePlay = (name: string) => ({
    profile: 'live' as DriverSessionProfile,
    tool: { name, mutating: true, proposalCapable: false },
    onLivePlayAllowList: true,
  });

  it('promotes mechanical commits from auto to confirm', () => {
    const promoted: string[] = [];
    for (const name of DRIVER_COLLABORATIVE_DEFER_TOOLS) {
      const solo = resolveDriverToolPolicy(livePlay(name));
      const collab = resolveDriverToolPolicy({ ...livePlay(name), collaborative: true });
      expect(collab.policy).toBe('confirm');
      expect(collab.offer).toBe(true); // still offered — the AI keeps calling them
      if (solo.policy === 'auto') promoted.push(name);
    }
    // Some of the set is already `confirm` in the live profile (#474), so the loop above would
    // pass even if the flag did nothing. These are the ones the flag actually changes.
    expect(promoted).toEqual(
      expect.arrayContaining([
        'resolve_action',
        'apply_action',
        'update_character_hp',
        'set_character_conditions',
        'next_turn',
      ]),
    );
  });

  it('leaves dice, reads and undo automatic', () => {
    // A roll produces a NUMBER; nothing changes until something applies it. Gating dice would
    // make the mode unusable — one attack is a roll, a save and an apply — and would spend the
    // confirm budget on results nobody needs to approve.
    for (const name of ['roll_dice', 'roll_action_dice', 'roll_initiative', 'saving_throw']) {
      expect(resolveDriverToolPolicy({ ...livePlay(name), collaborative: true }).policy).toBe('auto');
    }
    expect(resolveDriverToolPolicy({ ...livePlay('roll_death_save'), collaborative: true }).policy).toBe('confirm');
    // Issue #1904: unlike the bulk roll_initiative above (which produces numbers nothing has
    // applied yet), rolling ONE combatant's initiative immediately writes the combatant row,
    // an encounter event, and a shared dice-log entry — classified with roll_death_save, not
    // with the ordinary dice rolls.
    expect(resolveDriverToolPolicy({ ...livePlay('roll_combatant_initiative'), collaborative: true }).policy).toBe('confirm');
    // Undo exists to reverse a mistake. A confirmation in front of the undo button leaves a
    // wrong outcome on the board until someone approves removing it.
    expect(resolveDriverToolPolicy({ ...livePlay('undo_action'), collaborative: true }).policy).toBe('auto');

    const read = {
      profile: 'live' as DriverSessionProfile,
      tool: { name: 'get_party', mutating: false, proposalCapable: false },
      onLivePlayAllowList: false,
    };
    expect(resolveDriverToolPolicy({ ...read, collaborative: true }).policy).toBe('auto');
  });

  it('only ever tightens — it can never turn a deny or a propose into something weaker', () => {
    const denied = {
      profile: 'live' as DriverSessionProfile,
      tool: { name: 'update_npc', mutating: true, proposalCapable: false },
      onLivePlayAllowList: false,
    };
    expect(resolveDriverToolPolicy({ ...denied, collaborative: true }).policy).toBe('deny');

    const canon = {
      profile: 'live' as DriverSessionProfile,
      tool: { name: 'create_npc', mutating: true, proposalCapable: true },
      onLivePlayAllowList: false,
    };
    expect(resolveDriverToolPolicy({ ...canon, collaborative: true }).policy).toBe('propose');

    const forbidden = {
      profile: 'live' as DriverSessionProfile,
      tool: { name: 'delete_npc', mutating: true, proposalCapable: false },
      onLivePlayAllowList: true,
    };
    expect(resolveDriverToolPolicy({ ...forbidden, collaborative: true }).policy).toBe('deny');

    // And an aftermath `deny` stays denied even though the tool is in the defer set.
    const aftermathRemove = {
      profile: 'aftermath' as DriverSessionProfile,
      tool: { name: 'remove_combatant', mutating: true, proposalCapable: false },
      onLivePlayAllowList: true,
    };
    expect(resolveDriverToolPolicy({ ...aftermathRemove, collaborative: true }).policy).toBe('deny');
  });

  it('changes nothing at all when the mode is off', () => {
    for (const name of [...DRIVER_COLLABORATIVE_DEFER_TOOLS, 'roll_dice', 'undo_action']) {
      const off = resolveDriverToolPolicy(livePlay(name));
      const undefinedFlag = resolveDriverToolPolicy({ ...livePlay(name), collaborative: undefined });
      expect(undefinedFlag).toEqual(off);
    }
  });

  it('every reversible mechanical commit is in the defer set', () => {
    // DRIVER_UNDOABLE_TOOLS is the set the action resolver can reverse — i.e. exactly the calls
    // that COMMIT an outcome. If one of them were ever missing here, collaborative mode would be
    // letting the AI change the board unsupervised in the mode whose entire purpose is that it
    // does not.
    for (const name of DRIVER_UNDOABLE_TOOLS) {
      expect(DRIVER_COLLABORATIVE_DEFER_TOOLS.has(name)).toBe(true);
    }
  });

  it('raises the per-turn confirm budget so the mode cannot trip its own rate limit', () => {
    // One ordinary combat turn is easily four confirmations (resolve, apply, condition, next
    // turn). At the solo cap of three, the mode would surface tool errors, feed the stuck
    // ladder, and march toward the emergency pause — breaking itself the moment it is used.
    expect(DRIVER_COLLABORATIVE_CONFIRM_ATTEMPTS_PER_TURN).toBeGreaterThan(DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN);

    const session = { confirmToolAttemptsThisTurn: DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN, policyViolationsThisTurn: 0 };
    expect(checkDriverPolicyRateLimits(session).ok).toBe(false);
    expect(checkDriverPolicyRateLimits(session, { collaborative: true }).ok).toBe(true);
  });

  it('does NOT raise the policy-violation ceiling that triggers the emergency pause', () => {
    // A model attempting denied tools is misbehaving in every mode. Collaborative handoff is a
    // statement about who decides mechanics, not a relaxation of what the seat may attempt.
    const session = { confirmToolAttemptsThisTurn: 0, policyViolationsThisTurn: 5 };
    const collab = checkDriverPolicyRateLimits(session, { collaborative: true });
    expect(collab.ok).toBe(false);
    if (!collab.ok) expect(collab.emergencyPause).toBe(true);
  });
});

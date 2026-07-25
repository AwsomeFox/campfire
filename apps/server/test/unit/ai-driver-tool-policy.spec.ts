import {
  checkDriverPolicyRateLimits,
  DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN,
  DRIVER_POLICY_VIOLATIONS_BEFORE_EMERGENCY_PAUSE,
  resolveDriverSessionProfile,
  resolveDriverToolPolicy,
} from '../../src/modules/ai-driver/driver-tool-policy';

const writeTool = (name: string, proposalCapable = false) => ({
  name,
  mutating: true,
  proposalCapable,
});

describe('driver-tool-policy (#474)', () => {
  it('resolves prep/live/aftermath profiles from encounter presence', () => {
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: true,
        hasPreparingEncounter: true,
        hasEndedEncounter: true,
      }),
    ).toBe('live');
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: false,
        hasPreparingEncounter: true,
        hasEndedEncounter: true,
      }),
    ).toBe('prep');
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: false,
        hasPreparingEncounter: false,
        hasEndedEncounter: true,
      }),
    ).toBe('aftermath');
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: false,
        hasPreparingEncounter: false,
        hasEndedEncounter: false,
      }),
    ).toBe('prep');
  });

  it('requires confirmation for destructive live-play tools during live play', () => {
    for (const name of ['remove_combatant', 'end_encounter', 'award_xp', 'level_up_character']) {
      const decision = resolveDriverToolPolicy({
        profile: 'live',
        tool: writeTool(name),
        onLivePlayAllowList: true,
      });
      expect(decision.policy).toBe('confirm');
      expect(decision.offer).toBe(true);
    }
  });

  it('denies remove_combatant and end_encounter in aftermath', () => {
    expect(
      resolveDriverToolPolicy({
        profile: 'aftermath',
        tool: writeTool('remove_combatant'),
        onLivePlayAllowList: true,
      }).policy,
    ).toBe('deny');
    expect(
      resolveDriverToolPolicy({
        profile: 'aftermath',
        tool: writeTool('end_encounter'),
        onLivePlayAllowList: true,
      }).policy,
    ).toBe('deny');
  });

  it('auto-allows award_xp in aftermath but still confirms level_up_character', () => {
    expect(
      resolveDriverToolPolicy({
        profile: 'aftermath',
        tool: writeTool('award_xp'),
        onLivePlayAllowList: true,
      }).policy,
    ).toBe('auto');
    expect(
      resolveDriverToolPolicy({
        profile: 'aftermath',
        tool: writeTool('level_up_character'),
        onLivePlayAllowList: true,
      }).policy,
    ).toBe('confirm');
  });

  it('routes proposal-capable canon tools to propose regardless of profile', () => {
    const decision = resolveDriverToolPolicy({
      profile: 'live',
      tool: writeTool('create_quest', true),
      onLivePlayAllowList: false,
    });
    expect(decision.policy).toBe('propose');
    expect(decision.offer).toBe(true);
  });

  it('enforces per-turn confirm and emergency-pause rate limits', () => {
    const session = { confirmToolAttemptsThisTurn: DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN };
    expect(checkDriverPolicyRateLimits(session).ok).toBe(false);

    const violations = { policyViolationsThisTurn: DRIVER_POLICY_VIOLATIONS_BEFORE_EMERGENCY_PAUSE };
    const blocked = checkDriverPolicyRateLimits(violations);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.emergencyPause).toBe(true);
  });
});

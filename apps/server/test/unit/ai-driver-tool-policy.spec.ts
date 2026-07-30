import {
  checkDriverPolicyRateLimits,
  DRIVER_AFTERMATH_WINDOW_MS,
  DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN,
  DRIVER_GENERATE_MAP_BUDGET_PER_TURN,
  DRIVER_POLICY_VIOLATIONS_BEFORE_EMERGENCY_PAUSE,
  isWithinAftermathWindow,
  resolveDriverSessionProfile,
  resolveDriverToolPolicy,
} from '../../src/modules/ai-driver/driver-tool-policy';
import {
  DRIVER_LIVE_PLAY_TOOL_NAMES,
  DRIVER_GUARDED_LIVE_PLAY_TOOLS,
  DRIVER_UNGUARDED_LIVE_PLAY_TOOLS,
  guardDriverLivePlayArgs,
} from '../../src/modules/ai-driver/ai-driver.service';

const writeTool = (name: string, proposalCapable = false) => ({
  name,
  mutating: true,
  proposalCapable,
});

describe('driver-tool-policy (#474)', () => {
  it('resolves prep/live/aftermath/downtime profiles from encounter presence', () => {
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: true,
        hasPreparingEncounter: true,
        hasRecentlyEndedEncounter: true,
      }),
    ).toBe('live');
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: false,
        hasPreparingEncounter: true,
        hasRecentlyEndedEncounter: true,
      }),
    ).toBe('prep');
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: false,
        hasPreparingEncounter: false,
        hasRecentlyEndedEncounter: true,
      }),
    ).toBe('aftermath');
    // #1495 — nothing running, preparing, or recently ended: neutral downtime, not prep.
    expect(
      resolveDriverSessionProfile({
        hasRunningEncounter: false,
        hasPreparingEncounter: false,
        hasRecentlyEndedEncounter: false,
      }),
    ).toBe('downtime');
  });

  describe('isWithinAftermathWindow (#1495)', () => {
    it('treats an encounter ended just now as within the window', () => {
      const now = Date.parse('2026-01-01T12:00:00.000Z');
      expect(isWithinAftermathWindow('2026-01-01T12:00:00.000Z', now)).toBe(true);
    });

    it('treats an encounter ended just under the window boundary as within the window', () => {
      const now = Date.parse('2026-01-01T12:00:00.000Z');
      const endedAt = new Date(now - (DRIVER_AFTERMATH_WINDOW_MS - 1)).toISOString();
      expect(isWithinAftermathWindow(endedAt, now)).toBe(true);
    });

    it('treats an encounter ended past the window as expired', () => {
      const now = Date.parse('2026-01-01T12:00:00.000Z');
      const endedAt = new Date(now - (DRIVER_AFTERMATH_WINDOW_MS + 1)).toISOString();
      expect(isWithinAftermathWindow(endedAt, now)).toBe(false);
    });

    it('treats an OLD ended encounter (e.g. from a prior campaign session) as expired', () => {
      const now = Date.parse('2026-01-01T12:00:00.000Z');
      // Ended a full week before "now" — this is the exact defect #1495 reported: an encounter
      // that ended long ago must never keep the driver permanently in `aftermath`.
      const endedAt = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      expect(isWithinAftermathWindow(endedAt, now)).toBe(false);
    });

    it('never treats null/undefined/unparseable endedAt as recent', () => {
      expect(isWithinAftermathWindow(null)).toBe(false);
      expect(isWithinAftermathWindow(undefined)).toBe(false);
      expect(isWithinAftermathWindow('not-a-date')).toBe(false);
    });

    it('fails closed on a future endedAt (clock skew / bad data)', () => {
      const now = Date.parse('2026-01-01T12:00:00.000Z');
      const endedAt = new Date(now + 60_000).toISOString();
      expect(isWithinAftermathWindow(endedAt, now)).toBe(false);
    });
  });

  it('#1495: a campaign with only an OLD ended encounter (nothing running/prepping) resolves to a non-aftermath profile', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const oldEndedAt = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const profile = resolveDriverSessionProfile({
      hasRunningEncounter: false,
      hasPreparingEncounter: false,
      hasRecentlyEndedEncounter: isWithinAftermathWindow(oldEndedAt, now),
    });
    expect(profile).not.toBe('aftermath');
    expect(profile).toBe('downtime');
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

  it('#1495: economy tools require DM confirmation in the neutral downtime profile, not auto', () => {
    for (const name of ['award_xp', 'adjust_treasury', 'add_inventory_item', 'update_inventory_item']) {
      const decision = resolveDriverToolPolicy({
        profile: 'downtime',
        tool: writeTool(name),
        onLivePlayAllowList: true,
      });
      expect(decision.policy).toBe('confirm');
    }
  });

  describe('#1495 policy-table coverage: every live-play tool has a guard branch or an explicit no-guard entry', () => {
    it('accounts for every DRIVER_LIVE_PLAY_TOOL_NAMES entry in exactly one registry', () => {
      // Deliberately no early return / no conditional wrapping an assertion (test-quality rule):
      // every iteration always executes both expectations below, so a single misclassified tool
      // fails the run instead of silently passing.
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES.length).toBeGreaterThan(0);
      for (const name of DRIVER_LIVE_PLAY_TOOL_NAMES) {
        const guarded = DRIVER_GUARDED_LIVE_PLAY_TOOLS.has(name);
        const unguarded = DRIVER_UNGUARDED_LIVE_PLAY_TOOLS.has(name);
        expect(guarded || unguarded).toBe(true);
        expect(guarded && unguarded).toBe(false);
      }
    });

    it('never lists a tool in either guard registry that is not actually on the live-play allow-list', () => {
      for (const name of DRIVER_GUARDED_LIVE_PLAY_TOOLS) {
        expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain(name);
      }
      for (const name of DRIVER_UNGUARDED_LIVE_PLAY_TOOLS) {
        expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain(name);
      }
    });

    it('mechanically proves every DRIVER_GUARDED_LIVE_PLAY_TOOLS entry has a REAL branch, not a fall-through (the exact #1495 bug)', () => {
      // For each tool claimed guarded, feed it a hostile arg shape that MUST be rejected (or, for
      // create_encounter, MUST be silently stripped) if the branch genuinely exists. A tool that
      // fell through to the bottom `return { ok: true, args: { ...args } }` passthrough — exactly
      // what happened to add_inventory_item before #1495 — would fail every one of these.
      const session = {
        driverGeneratedMapIds: [] as number[],
        generateMapCallsThisTurn: DRIVER_GENERATE_MAP_BUDGET_PER_TURN,
        driverAuthoredEncounterIds: [] as number[],
      };
      const hostileCases: Array<{ tool: string; args: Record<string, unknown>; assert: (r: ReturnType<typeof guardDriverLivePlayArgs>) => void }> = [
        { tool: 'generate_map', args: {}, assert: (r) => expect(r.ok).toBe(false) },
        { tool: 'generate_ai_map', args: {}, assert: (r) => expect(r.ok).toBe(false) },
        { tool: 'refine_ai_map', args: {}, assert: (r) => expect(r.ok).toBe(false) },
        {
          tool: 'create_encounter',
          args: { name: 'Ambush', hidden: false },
          assert: (r) => {
            expect(r.ok).toBe(true);
            if (r.ok) expect('hidden' in r.args).toBe(false);
          },
        },
        { tool: 'update_encounter', args: { encounterId: 1, hidden: true }, assert: (r) => expect(r.ok).toBe(false) },
        { tool: 'adjust_treasury', args: { delta: { gp: -1 } }, assert: (r) => expect(r.ok).toBe(false) },
        {
          tool: 'add_inventory_item',
          args: { name: 'Vorpal Sword', ownerType: 'character', characterId: 4, qty: 999_999 },
          assert: (r) => expect(r.ok).toBe(false),
        },
        { tool: 'update_inventory_item', args: { itemId: 1, characterId: 4 }, assert: (r) => expect(r.ok).toBe(false) },
      ];
      expect(hostileCases.map((c) => c.tool).sort()).toEqual([...DRIVER_GUARDED_LIVE_PLAY_TOOLS].sort());
      for (const { tool, args, assert } of hostileCases) {
        assert(guardDriverLivePlayArgs(tool, args, session));
      }
    });
  });
});

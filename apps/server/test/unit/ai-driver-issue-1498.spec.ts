import { describe, it, expect } from '@jest/globals';
import {
  DRIVER_LIVE_PLAY_TOOL_NAMES,
  DRIVER_PLAYER_SAFE_READ_TOOLS,
  classifyDriverRead,
  driverApprovableEntityArg,
  guardDriverLivePlayArgs,
  isDriverToolAllowed,
  type AiDmSessionState,
} from '../../src/modules/ai-driver/ai-driver.service';
import { DRIVER_COLLABORATIVE_DEFER_TOOLS } from '../../src/modules/ai-driver/driver-tool-policy';

describe('Issue #1498 AI DM Live Play Tool Surface & Turn Economy', () => {
  const writeTool = (name: string, proposalCapable = false) => ({
    name,
    mutating: true,
    proposalCapable,
  });

  const readTool = (name: string) => ({
    name,
    mutating: false,
    proposalCapable: false,
  });

  function session(partial: Partial<AiDmSessionState> = {}): AiDmSessionState {
    return {
      campaignId: 1,
      status: 'idle',
      state: 'running',
      scene: null,
      lastNarration: null,
      lastTurnAt: null,
      turnCount: 0,
      stuck: null,
      levers: [],
      actingDm: null,
      vote: null,
      takeoverRequestedBy: null,
      driverGeneratedMapIds: [],
      generateMapCallsThisTurn: 0,
      driverAuthoredEncounterIds: [],
      ...partial,
    } as AiDmSessionState;
  }

  describe('1. Skill checks catalog availability', () => {
    it('includes roll_check, request_check, and resolve_check_request on live play allow list', () => {
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('roll_check');
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('request_check');
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('resolve_check_request');

      expect(isDriverToolAllowed(writeTool('roll_check'))).toBe(true);
      expect(isDriverToolAllowed(writeTool('request_check'))).toBe(true);
      expect(isDriverToolAllowed(writeTool('resolve_check_request'))).toBe(true);
    });

    it('includes list_checks and list_check_requests in player safe read tools', () => {
      expect(DRIVER_PLAYER_SAFE_READ_TOOLS.has('list_checks')).toBe(true);
      expect(DRIVER_PLAYER_SAFE_READ_TOOLS.has('list_check_requests')).toBe(true);
      expect(classifyDriverRead('list_checks')).toBe('player_safe');
      expect(classifyDriverRead('list_check_requests')).toBe('player_safe');
    });

    it('allows creature rolls in live play but requires combatant-scoped approval to read their DM-only catalog', () => {
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('roll_creature_check');
      expect(isDriverToolAllowed(writeTool('roll_creature_check'))).toBe(true);
      expect(classifyDriverRead('list_creature_checks')).toBe('secret');
      expect(driverApprovableEntityArg('list_creature_checks')).toBe('combatantId');
    });
  });

  describe('2. Turn economy and structured state tools', () => {
    it('includes set_turn_state, end_turn, and undo_turn on live play allow list', () => {
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('set_turn_state');
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('end_turn');
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('undo_turn');

      expect(isDriverToolAllowed(writeTool('set_turn_state'))).toBe(true);
      expect(isDriverToolAllowed(writeTool('end_turn'))).toBe(true);
      expect(isDriverToolAllowed(writeTool('undo_turn'))).toBe(true);
    });

    it('defers turn advancement and turn state mutations under collaborative mode', () => {
      expect(DRIVER_COLLABORATIVE_DEFER_TOOLS.has('end_turn')).toBe(true);
      expect(DRIVER_COLLABORATIVE_DEFER_TOOLS.has('set_turn_state')).toBe(true);
    });
  });

  describe('3. Encounter creation visibility default', () => {
    it('drops hidden arg from create_encounter so private-by-default rule applies', () => {
      const s = session();
      const res = guardDriverLivePlayArgs(
        'create_encounter',
        { campaignId: 1, name: 'Goblin Patrol' },
        s,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.args.hidden).toBeUndefined();
      }
    });

    it('drops explicit hidden arg from create_encounter', () => {
      const s = session();
      const res = guardDriverLivePlayArgs(
        'create_encounter',
        { campaignId: 1, name: 'Hidden Ambush', hidden: true },
        s,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.args.hidden).toBeUndefined();
      }
    });
  });

  describe('4. Schema vs Execution parity for read tools', () => {
    it('every player-safe read tool is not blocked by classifyDriverRead', () => {
      const offeredReads = [
        'get_turn',
        'list_usable_actions',
        'preview_encounter',
        'list_encounter_events',
        'get_encounter_aftermath',
        'list_checks',
        'list_check_requests',
        'draft_session_recap',
      ];
      for (const name of offeredReads) {
        expect(isDriverToolAllowed(readTool(name))).toBe(true);
        expect(classifyDriverRead(name)).not.toBe('blocked');
      }
    });
  });

  describe('6. Session closing tool latitude', () => {
    it('includes add_session_recap on live play allow list', () => {
      expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toContain('add_session_recap');
      expect(isDriverToolAllowed(writeTool('add_session_recap', true))).toBe(true);
    });

    it('includes draft_session_recap and get_encounter_aftermath in safe reads', () => {
      expect(DRIVER_PLAYER_SAFE_READ_TOOLS.has('draft_session_recap')).toBe(true);
      expect(DRIVER_PLAYER_SAFE_READ_TOOLS.has('get_encounter_aftermath')).toBe(true);
    });
  });
});

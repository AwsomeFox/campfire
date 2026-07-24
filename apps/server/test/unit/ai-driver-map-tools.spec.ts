import { describe, it, expect } from '@jest/globals';
import {
  DRIVER_GENERATE_MAP_BUDGET_PER_TURN,
  guardDriverLivePlayArgs,
  isDriverToolAllowed,
  noteDriverGenerateMapCall,
  recordDriverGeneratedMap,
  resetDriverTurnCounters,
  type AiDmSessionState,
  toPublicAiDmSessionState,
} from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #488: The AI Driver seat could operate a fight (begin_encounter/next_turn/
 * add_combatant/update_combatant) but could not shape the battle map — every
 * map/VTT authoring tool defaulted to deny, so a driver-mode AI could not
 * spin up a random ambush and set up its own board.
 *
 * This suite pins the guarded live-play subset for map authoring plus the
 * execution-time guards that bound generate_map and restrict update_encounter
 * to VTT-only fields with session-generated map linkage.
 */
describe('AI Driver battle-map tools (#488)', () => {
  const writeTool = (name: string) => ({ name, mutating: true, proposalCapable: false });

  function _session(overrides: Partial<AiDmSessionState> = {}): AiDmSessionState {
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
      ...overrides,
    };
  }

  it('allows generate_map — the driver can originate a battlefield in the flow of play', () => {
    expect(isDriverToolAllowed(writeTool('generate_map'))).toBe(true);
  });

  it('allows update_encounter — carries fog/grid/AoE for live spatial play', () => {
    expect(isDriverToolAllowed(writeTool('update_encounter'))).toBe(true);
  });

  it('keeps reveal_map_region allowed — the incremental fog-lift path', () => {
    expect(isDriverToolAllowed(writeTool('reveal_map_region'))).toBe(true);
  });

  it('still blocks delete_encounter — encounter destruction is never live-play work', () => {
    expect(isDriverToolAllowed(writeTool('delete_encounter'))).toBe(false);
  });

  it('still blocks delete_attachment — hidden handouts and generated maps cannot be purged by the seat', () => {
    expect(isDriverToolAllowed({ name: 'delete_attachment', mutating: true, proposalCapable: true })).toBe(false);
  });

  it('still blocks update_attachment (attachment visibility) — revealing hidden handouts stays a DM decision', () => {
    expect(isDriverToolAllowed(writeTool('update_attachment'))).toBe(false);
  });

  it('keeps the generate -> update -> reveal -> begin tools all reachable on the live-play allow-list', () => {
    const path = ['generate_map', 'update_encounter', 'reveal_map_region', 'begin_encounter'];
    expect(path.every((name) => isDriverToolAllowed(writeTool(name)))).toBe(true);
  });
});

describe('guardDriverLivePlayArgs — battle-map execution guards (#488)', () => {
  function session(overrides: Partial<AiDmSessionState> = {}): AiDmSessionState {
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
      ...overrides,
    };
  }

  it('allows the first generate_map call each turn and blocks subsequent ones', () => {
    const s = session();
    resetDriverTurnCounters(s);
    expect(guardDriverLivePlayArgs('generate_map', { campaignId: 1, kind: 'cave' }, s).ok).toBe(true);
    noteDriverGenerateMapCall(s);
    const blocked = guardDriverLivePlayArgs('generate_map', { campaignId: 1, kind: 'dungeon' }, s);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('generate_map_budget_exhausted');
    expect(DRIVER_GENERATE_MAP_BUDGET_PER_TURN).toBe(1);
  });

  it('resets generate_map budget at turn start', () => {
    const s = session({ generateMapCallsThisTurn: 1 });
    resetDriverTurnCounters(s);
    expect(guardDriverLivePlayArgs('generate_map', { campaignId: 1, kind: 'cave' }, s).ok).toBe(true);
  });

  it('strips prep fields from update_encounter, keeping only VTT overlays', () => {
    const s = session({ driverGeneratedMapIds: [42] });
    const result = guardDriverLivePlayArgs(
      'update_encounter',
      {
        encounterId: 7,
        name: 'Renamed ambush',
        hidden: false,
        locationId: 99,
        fog: { enabled: true, revealed: [] },
        gridSize: 50,
        mapAttachmentId: 42,
      },
      s,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({
        encounterId: 7,
        fog: { enabled: true, revealed: [] },
        gridSize: 50,
        mapAttachmentId: 42,
      });
      expect(result.args).not.toHaveProperty('hidden');
      expect(result.args).not.toHaveProperty('name');
      expect(result.args).not.toHaveProperty('locationId');
    }
  });

  it('rejects linking mapAttachmentId to an attachment the seat did not generate', () => {
    const s = session({ driverGeneratedMapIds: [10] });
    const result = guardDriverLivePlayArgs(
      'update_encounter',
      { encounterId: 7, mapAttachmentId: 999 },
      s,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden_map_link');
  });

  it('allows mapAttachmentId:null as detach/undo', () => {
    const s = session();
    const result = guardDriverLivePlayArgs('update_encounter', { encounterId: 7, mapAttachmentId: null }, s);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.mapAttachmentId).toBeNull();
  });

  it('tracks generated map ids for later linkage', () => {
    const s = session();
    recordDriverGeneratedMap(s, 55);
    recordDriverGeneratedMap(s, 55);
    expect(s.driverGeneratedMapIds).toEqual([55]);
    const result = guardDriverLivePlayArgs('update_encounter', { encounterId: 1, mapAttachmentId: 55 }, s);
    expect(result.ok).toBe(true);
  });

  it('preserves generate_map args through execution-time clear+assign rewriting', () => {
    const s = session();
    const args: Record<string, unknown> = { campaignId: 1, kind: 'cave', style: 'ruins' };
    const liveGuard = guardDriverLivePlayArgs('generate_map', args, s);
    expect(liveGuard.ok).toBe(true);
    if (liveGuard.ok) {
      for (const key of Object.keys(args)) delete args[key];
      Object.assign(args, liveGuard.args);
      expect(args).toEqual({ campaignId: 1, kind: 'cave', style: 'ruins' });
    }
  });
});

describe('toPublicAiDmSessionState', () => {
  it('omits internal guard bookkeeping fields from member-visible session payloads', () => {
    const session: AiDmSessionState = {
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
      secretReadApprovals: { 'get_npc:1': { tool: 'get_npc', entityId: 1, grantedBy: 'dm', grantedAt: 'now', note: null, consumed: false } },
      driverGeneratedMapIds: [42],
      generateMapCallsThisTurn: 1,
      detached: true,
    };
    expect(toPublicAiDmSessionState(session)).toEqual({
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
    });
  });
});

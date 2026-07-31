import { describe, it, expect } from '@jest/globals';
import {
  guardDriverLivePlayArgs,
  isDriverToolAllowed,
  recordDriverAuthoredEncounter,
  toPublicAiDmSessionState,
  type AiDmSessionState,
} from '../../src/modules/ai-driver/ai-driver.service';

/**
 * Issue #1022 — the AI Driver can AUTHOR encounters, not merely operate ones a human built.
 *
 * #1075 already put `create_encounter` on the live-play allow-list; what #1022 adds is the
 * argument-level boundary that makes direct authoring safe to hand an autonomous seat, and the
 * "reshape" half that was still refused outright.
 *
 * THE DECISION UNDER TEST — allow-list rather than proposals
 * ---------------------------------------------------------
 * A proposal is a deferred draft: the encounter would not exist when the tool returns, so the
 * model's next call (add_combatant / begin_encounter) would have no id. Routing encounter
 * creation through the proposal queue does not slow authoring down, it makes it impossible.
 * So authoring is direct, and the containment lives in two guards instead:
 *
 *   1. VISIBILITY IS NOT THE SEAT'S TO CHOOSE. Every encounter the driver creates is DM-only
 *      prep, and `hidden` can never be written on an update. The seat takes instructions from
 *      untrusted player chat (#317), so a writable `hidden` would make "what are we about to
 *      fight?" a way to induce the AI into publishing the DM's roster and difficulty (#262).
 *   2. RESHAPE IS CONFINED TO ITS OWN CREATIONS. Renaming or re-linking an encounter the human
 *      DM prepared is overwriting their work with no diff to review; the server can tell the
 *      difference because it recorded which ids the seat actually created.
 */
describe('AI Driver encounter authoring (#1022)', () => {
  const writeTool = (name: string) => ({ name, mutating: true, proposalCapable: false });

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
      ...partial,
    } as AiDmSessionState;
  }

  // ---------------------------------------------------------------------------
  // Allow-list membership
  // ---------------------------------------------------------------------------

  it('allows create_encounter — the seat may originate a fight, not just run one', () => {
    expect(isDriverToolAllowed(writeTool('create_encounter'))).toBe(true);
  });

  it('allows update_encounter — the reshape half rides the same tool as the VTT half', () => {
    expect(isDriverToolAllowed(writeTool('update_encounter'))).toBe(true);
  });

  it('never allows delete_encounter — authoring is additive, destruction is not authoring', () => {
    expect(isDriverToolAllowed(writeTool('delete_encounter'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Creation: visibility is not the seat's to choose
  // ---------------------------------------------------------------------------

  it('defaults hidden:false on create so the encounter is visible to players (#1498)', () => {
    const s = session();
    const result = guardDriverLivePlayArgs(
      'create_encounter',
      { campaignId: 1, name: 'Wandering wolves', hidden: false },
      s,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.hidden).toBe(false);
      expect(result.args).toEqual({ campaignId: 1, name: 'Wandering wolves', hidden: false });
    }
  });

  it('preserves explicit hidden:true on create if passed (#1498)', () => {
    const result = guardDriverLivePlayArgs('create_encounter', { campaignId: 1, name: 'Ambush', hidden: true }, session());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.hidden).toBe(true);
  });

  it('leaves the rest of a create untouched — name and links are legitimate on a NEW row', () => {
    const result = guardDriverLivePlayArgs(
      'create_encounter',
      { campaignId: 1, name: 'Reed ambush', locationId: 4, questId: 9, sessionId: 2 },
      session(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ campaignId: 1, name: 'Reed ambush', locationId: 4, questId: 9, sessionId: 2, hidden: false });
    }
  });

  // ---------------------------------------------------------------------------
  // Reveal is never the seat's call
  // ---------------------------------------------------------------------------

  it('refuses hidden on update even for an encounter the seat itself created', () => {
    const s = session({ driverAuthoredEncounterIds: [7] });
    const result = guardDriverLivePlayArgs('update_encounter', { encounterId: 7, hidden: false }, s);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('forbidden_encounter_reveal');
      // Owning the encounter is irrelevant: the harm is disclosure to the TABLE, and that is
      // the same harm whoever prepared the fight.
      expect(result.message).toContain('roster');
    }
  });

  it('refuses a reveal smuggled in alongside legitimate VTT work', () => {
    const s = session({ driverAuthoredEncounterIds: [7], driverGeneratedMapIds: [42] });
    const result = guardDriverLivePlayArgs(
      'update_encounter',
      { encounterId: 7, fog: { enabled: true, revealed: [] }, mapAttachmentId: 42, hidden: false },
      s,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden_encounter_reveal');
  });

  // ---------------------------------------------------------------------------
  // Reshape: only what the seat made
  // ---------------------------------------------------------------------------

  it('allows renaming and re-linking an encounter the seat created this session', () => {
    const s = session({ driverAuthoredEncounterIds: [7] });
    const result = guardDriverLivePlayArgs(
      'update_encounter',
      { encounterId: 7, name: 'Reed ambush (reinforced)', locationId: 4, questId: 9, sessionId: 2 },
      s,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({
        encounterId: 7,
        name: 'Reed ambush (reinforced)',
        locationId: 4,
        questId: 9,
        sessionId: 2,
      });
    }
  });

  it("refuses renaming an encounter the human DM prepared", () => {
    const s = session({ driverAuthoredEncounterIds: [7] });
    const result = guardDriverLivePlayArgs('update_encounter', { encounterId: 99, name: 'Renamed by the AI' }, s);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('forbidden_encounter_reshape');
      expect(result.message).toContain('created this session');
    }
  });

  it('refuses reshaping when the seat has created nothing at all', () => {
    const result = guardDriverLivePlayArgs('update_encounter', { encounterId: 7, name: 'Nope' }, session());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden_encounter_reshape');
  });

  it('still allows VTT-only work on an encounter the seat did NOT create', () => {
    // The containment is specifically about AUTHORING fields. Fog and grid on the DM's own
    // prepped fight is the live spatial play #488 shipped and must keep working.
    const s = session({ driverGeneratedMapIds: [42] });
    const result = guardDriverLivePlayArgs(
      'update_encounter',
      { encounterId: 99, fog: { enabled: true, revealed: [] }, gridSize: 50, mapAttachmentId: 42 },
      s,
    );
    expect(result.ok).toBe(true);
  });

  it('does not let the model claim ownership through its own arguments', () => {
    // Ownership comes from the RESULT of a create the server observed, never from the call.
    // A model that invents `driverAuthoredEncounterIds`-shaped arguments changes nothing.
    const s = session();
    const result = guardDriverLivePlayArgs(
      'update_encounter',
      { encounterId: 7, name: 'Mine now', driverAuthoredEncounterIds: [7] } as Record<string, unknown>,
      s,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden_encounter_field');
  });

  // ---------------------------------------------------------------------------
  // Ownership bookkeeping
  // ---------------------------------------------------------------------------

  it('records created encounter ids once, and unlocks reshape for exactly those ids', () => {
    const s = session();
    recordDriverAuthoredEncounter(s, 7);
    recordDriverAuthoredEncounter(s, 7);
    recordDriverAuthoredEncounter(s, 8);
    expect(s.driverAuthoredEncounterIds).toEqual([7, 8]);
    expect(guardDriverLivePlayArgs('update_encounter', { encounterId: 8, name: 'Second fight' }, s).ok).toBe(true);
    expect(guardDriverLivePlayArgs('update_encounter', { encounterId: 9, name: 'Third fight' }, s).ok).toBe(false);
  });

  it('keeps the authored-id ledger out of the member-visible session projection', () => {
    // It is internal guard bookkeeping. Exposing it would tell every member which encounters
    // the AI made — and, by omission, which hidden ones the DM prepared.
    const s = session({ driverAuthoredEncounterIds: [7] });
    const publicState = toPublicAiDmSessionState(s) as Record<string, unknown>;
    expect('driverAuthoredEncounterIds' in publicState).toBe(false);
  });
});

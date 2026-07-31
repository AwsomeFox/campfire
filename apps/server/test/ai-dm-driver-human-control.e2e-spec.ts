import request from 'supertest';
import { createAiEvalHarness, dm, player, viewer, type AiEvalHarness } from './ai-eval-harness';

/**
 * Human control over the AI DM seat (issue #1501): the three safety-critical levers a human has
 * for stopping or correcting the AI.
 *
 * 1. Pause — the strict `{ paused: boolean }` DTO 400'd on the empty body the UI used to send.
 * 2. Undo  — the seat's last reversible action commit is exposed as a DM-only control driving the
 *    existing `undo_action` path; a human had no such lever.
 * 3. CAS   — the seat's direct writes carry the `updatedAt` it last read, so a concurrent human
 *    edit can win a compare-and-set instead of the AI silently overwriting it.
 */
describe('ai-dm driver — human-control levers (issue #1501, e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'human-control-model' });
    await h.enableExperimental();
  });
  beforeEach(() => {
    h.resetMock();
  });
  afterAll(async () => {
    await h.close();
  });

  const pause = (campaignId: number, body: object, headers = dm) =>
    request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(headers).send(body);
  const undo = (campaignId: number, headers = dm) =>
    request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/undo`).set(headers);

  async function startLiveEncounter(campaignId: number): Promise<number> {
    const enc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Fight' });
    expect(enc.status).toBe(201);
    const encounterId = enc.body.id as number;
    const added = await request(h.server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Goblin', hpMax: 30, initMod: 2 });
    expect(added.status).toBe(201);
    await request(h.server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    const start = await request(h.server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(start.status).toBe(201);
    return encounterId;
  }

  // ---- 1. Pause ---------------------------------------------------------------

  it('#1501 pause requires the strict { paused } body that the UI now sends (no body 400s)', async () => {
    const campaignId = await h.createCampaign('Pause Body');
    await h.configureSeat(campaignId, { mode: 'driver' });

    // The bug: an empty body fails the strict DTO (the UI used to POST with no body).
    const noBody = await pause(campaignId, {});
    expect(noBody.status).toBe(400);

    // The fix: { paused: true } is accepted and actually pauses.
    const on = await pause(campaignId, { paused: true });
    expect(on.status).toBe(201);
    expect(on.body.state).toBe('paused');

    // A wrong type is still rejected — the DTO is strict for a reason.
    const wrongType = await pause(campaignId, { paused: 'yes' });
    expect(wrongType.status).toBe(400);

    // Resume restores the seat (sent as { paused: false } from the toggle).
    const off = await pause(campaignId, { paused: false });
    expect(off.status).toBe(201);
    expect(off.body.state).not.toBe('paused');
  });

  it('#1501 pause is DM-only', async () => {
    const campaignId = await h.createCampaign('Pause Role');
    await h.configureSeat(campaignId, { mode: 'driver' });
    const denied = await pause(campaignId, { paused: true }, player);
    expect(denied.status).toBe(403);
  });

  // ---- 2. Undo ----------------------------------------------------------------

  async function armedEncounter(campaignId: number): Promise<{
    encounterId: number;
    targetCombatantId: number;
    chainId: string;
  }> {
    const action = {
      name: 'Practice Strike',
      kind: 'melee',
      toHit: '',
      damage: '1 bludgeoning',
      notes: '',
      spec: {
        mode: 'save',
        save: { ability: 'DEX', dc: { kind: 'fixed', dc: 1 } },
        cost: { slot: 'action', count: 1 },
        targets: { count: 1, allow: 'any' },
        outcomes: { failure: { damage: [{ flat: 5, type: 'bludgeoning' }] }, success: { halfDamage: true } },
      },
    };
    const actor = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Actor', stats: { DEX: 10 }, ac: 12, hpCurrent: 10, hpMax: 10, ownerUserId: 'ai-eval-player', actions: [action] });
    const target = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Target', stats: { DEX: 10 }, ac: 12, hpCurrent: 10, hpMax: 10, ownerUserId: 'other-player' });
    expect(actor.status).toBe(201);
    expect(target.status).toBe(201);
    const encounter = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Practice', hidden: false });
    expect(encounter.status).toBe(201);
    const encounterId = encounter.body.id as number;
    const actorCombatantId = encounter.body.combatants.find(
      (c: { characterId: number }) => c.characterId === actor.body.id,
    ).id;
    const targetCombatantId = encounter.body.combatants.find(
      (c: { characterId: number }) => c.characterId === target.body.id,
    ).id;
    await request(h.server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    await request(h.server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    const preview = await request(h.server)
      .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
      .set(dm)
      .send({ actorCombatantId, actionIndex: 0, targetIds: [targetCombatantId], commit: false });
    expect(preview.status).toBe(200);
    return { encounterId, targetCombatantId, chainId: preview.body.chainId as string };
  }

  const combatantHp = async (encounterId: number, combatantId: number): Promise<number> => {
    const enc = await request(h.server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    return enc.body.combatants.find((c: { id: number }) => c.id === combatantId).hpCurrent as number;
  };

  it('#1501 a DM can undo the AI seat\'s last committed action, and it is actually reversed', async () => {
    const campaignId = await h.createCampaign('Undo Last Action');
    await h.configureSeat(campaignId, { mode: 'driver' });
    const { encounterId, targetCombatantId, chainId } = await armedEncounter(campaignId);

    const beforeHp = await combatantHp(encounterId, targetCombatantId);

    // The seat commits the action (apply_action is auto in non-collaborative driver mode).
    h.script({
      text: 'The actor strikes the target.',
      toolCalls: [{ id: 'apply1', name: 'apply_action', arguments: { encounterId, chainId } }],
    });
    h.script({ text: 'Done.', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
    const turn = await h.sendMessage(campaignId, { input: 'apply the strike' });
    expect(turn.status).toBe(201);
    expect(turn.body.toolCalls[0]).toMatchObject({ name: 'apply_action', isError: false, proposed: false });

    // The damage landed, and the seat exposed the commit so a DM can reverse it.
    const appliedHp = await combatantHp(encounterId, targetCombatantId);
    expect(appliedHp).toBeLessThan(beforeHp);
    const session = await h.getDriverSession(campaignId);
    expect(session.body.lastUndoableCommit).toMatchObject({ encounterId, chainId, actionName: 'Practice Strike' });

    // The DM undo lever drives the existing undo path and reverses the action.
    const undone = await undo(campaignId);
    expect(undone.status).toBe(201);
    expect(undone.body).toMatchObject({ encounterId, chainId });
    expect(await combatantHp(encounterId, targetCombatantId)).toBe(beforeHp);

    // The lever is cleared once consumed.
    const sessionAfter = await h.getDriverSession(campaignId);
    expect(sessionAfter.body.lastUndoableCommit).toBeNull();

    const audit = await h.getAudit(campaignId);
    expect(audit.body.some((e: { action: string }) => e.action === 'ai-dm.driver.undo')).toBe(true);
  });

  it('#1501 there is nothing to undo when the seat has not committed a reversible action', async () => {
    const campaignId = await h.createCampaign('Undo Nothing');
    await h.configureSeat(campaignId, { mode: 'driver' });
    // A fresh seat has committed nothing reversible.
    const res = await undo(campaignId);
    expect(res.status).toBe(404);
  });

  it('#1501 undo is DM-only', async () => {
    const campaignId = await h.createCampaign('Undo Role');
    await h.configureSeat(campaignId, { mode: 'driver' });
    const denied = await undo(campaignId, viewer);
    expect(denied.status).toBe(403);
  });

  // ---- 3. Concurrent-edit CAS -------------------------------------------------
  //
  // The seat's direct write carries the `updatedAt` it last observed, so a concurrent human edit can
  // win a compare-and-set. The version is seeded by the seat's OWN prior write (a successful
  // update_encounter refreshes the tracked version from its result), then a human edit advances the
  // row past it. `gridSize` is a VTT-overlay field the seat may set on any encounter.

  it('#1501 a concurrent human edit can win against the seat (the AI no longer silently overwrites)', async () => {
    const campaignId = await h.createCampaign('Concurrent CAS');
    await h.configureSeat(campaignId, { mode: 'driver' });
    const encounterId = await startLiveEncounter(campaignId);

    // Turn 1: the seat's first write lands unconditionally (no prior read) and seeds the tracked
    // version from its own result.
    h.script({
      text: 'I set the grid.',
      toolCalls: [{ id: 'write1', name: 'update_encounter', arguments: { encounterId, gridSize: 5 } }],
    });
    h.script({ text: 'Set.' });
    const turn1 = await h.sendMessage(campaignId, { input: 'configure the grid' });
    expect(turn1.status).toBe(201);
    expect(turn1.body.toolCalls[0]).toMatchObject({ name: 'update_encounter', isError: false, proposed: false });

    // A human DM edits the same encounter, advancing its updatedAt past what the seat last wrote.
    const humanEdit = await request(h.server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ gridSize: 10 });
    expect(humanEdit.status).toBe(200);

    // The seat writes again carrying the now-stale updatedAt, so the CAS guard rejects it instead of
    // clobbering the human's edit. The human's value survives.
    h.script({
      text: 'I refine the grid.',
      toolCalls: [{ id: 'write2', name: 'update_encounter', arguments: { encounterId, gridSize: 7 } }],
    });
    h.script({ text: 'Set.' });
    const turn2 = await h.sendMessage(campaignId, { input: 'resize the grid' });
    expect(turn2.status).toBe(201);
    expect(turn2.body.toolCalls[0]).toMatchObject({ name: 'update_encounter', isError: true, proposed: false });

    const after = await request(h.server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(after.body.gridSize).toBe(10);
  });

  it('#1501 without a concurrent edit the seat\'s write still lands (no spurious CAS failure)', async () => {
    const campaignId = await h.createCampaign('CAS No Conflict');
    await h.configureSeat(campaignId, { mode: 'driver' });
    const encounterId = await startLiveEncounter(campaignId);

    h.script({
      text: 'I set the grid.',
      toolCalls: [{ id: 'write1', name: 'update_encounter', arguments: { encounterId, gridSize: 5 } }],
    });
    h.script({ text: 'Set.' });
    const turn1 = await h.sendMessage(campaignId, { input: 'configure the grid' });
    expect(turn1.status).toBe(201);
    expect(turn1.body.toolCalls[0]).toMatchObject({ name: 'update_encounter', isError: false, proposed: false });

    // No human edit in between: the tracked version still matches, so the second write lands.
    h.script({
      text: 'I refine the grid.',
      toolCalls: [{ id: 'write2', name: 'update_encounter', arguments: { encounterId, gridSize: 7 } }],
    });
    h.script({ text: 'Set.' });
    const turn2 = await h.sendMessage(campaignId, { input: 'resize the grid' });
    expect(turn2.status).toBe(201);
    expect(turn2.body.toolCalls[0]).toMatchObject({ name: 'update_encounter', isError: false, proposed: false });

    const after = await request(h.server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(after.body.gridSize).toBe(7);
  });
});

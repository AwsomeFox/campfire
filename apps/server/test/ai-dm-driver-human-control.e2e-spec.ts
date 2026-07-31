import request from 'supertest';
import { createAiEvalHarness, dm, player, viewer, type AiEvalHarness } from './ai-eval-harness';

/**
 * Human control over the AI DM seat (issue #1501): the three safety-critical levers a human has
 * for stopping or correcting the AI.
 *
 * 1. Pause — the strict `{ paused: boolean }` DTO 400'd on the empty body the UI used to send.
 * 2. Undo  — the seat's last reversible action commit is exposed as a DM-only control driving the
 *    existing `undo_action` path; a human had no such lever.
 * 3. Secrecy — the undo reference (`lastUndoableCommit`) can name a DM-only hidden fight, so it is
 *    projected only to the DM; non-DM members never receive it (#1501 review).
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

  // ---- 3. Secrecy: the undo reference is DM-only --------------------------------
  //
  // lastUndoableCommit carries an encounterId that could name a DM-only hidden fight, so it must
  // never reach a non-DM member (issue #1501 review: secrecy). The lever itself is DM-gated; this
  // pins the projection.

  it('#1501 the undo reference (lastUndoableCommit) is hidden from non-DM members', async () => {
    const campaignId = await h.createCampaign('Undo Secrecy');
    await h.configureSeat(campaignId, { mode: 'driver' });
    const { encounterId, chainId } = await armedEncounter(campaignId);

    h.script({
      text: 'The actor strikes the target.',
      toolCalls: [{ id: 'apply1', name: 'apply_action', arguments: { encounterId, chainId } }],
    });
    h.script({ text: 'Done.' });
    await h.sendMessage(campaignId, { input: 'apply the strike' });

    // The DM sees the lever; a player and a viewer do not.
    const dmSession = await h.getDriverSession(campaignId);
    expect(dmSession.body.lastUndoableCommit).toMatchObject({ encounterId, chainId });
    const playerSession = await request(h.server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/session`)
      .set(player);
    expect(playerSession.status).toBe(200);
    expect(playerSession.body.lastUndoableCommit).toBeUndefined();
    const viewerSession = await request(h.server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/session`)
      .set(viewer);
    expect(viewerSession.status).toBe(200);
    expect(viewerSession.body.lastUndoableCommit).toBeUndefined();
  });
});

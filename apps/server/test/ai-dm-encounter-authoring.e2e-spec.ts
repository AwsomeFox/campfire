import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';

/**
 * Issue #1022 — the AI Driver authors an encounter end to end.
 *
 * The capability gap this closes: the seat could `begin_encounter`/`next_turn` and manage
 * combatants on a fight a human had already built, but could not ORIGINATE one — so "roll a
 * wandering monster and start it" produced narration with no combat tracker behind it.
 *
 * Authoring is granted DIRECTLY (live-play allow-list) rather than through the proposal queue,
 * because a proposal does not exist until a DM approves it and the model's very next call would
 * have no encounter id to add monsters to. The safety therefore lives in two execution-time
 * guards, and this suite exercises both against a real server:
 *
 *   1. the seat cannot choose visibility — everything it creates is DM-only prep, and `hidden`
 *      is not writable on update at all;
 *   2. the seat may reshape only encounters IT created; the DM's own prep is untouchable.
 */
describe('ai-dm driver — encounter authoring (#1022, e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'authoring-model' });
    await h.enableExperimental();
  });
  beforeEach(() => {
    h.resetMock();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Approve every queued confirm-policy call (begin_encounter is confirm in every profile). */
  async function approveAllConfirmations(campaignId: number): Promise<number> {
    const pending = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm);
    expect(pending.status).toBe(200);
    for (const entry of pending.body as Array<{ id: string }>) {
      const approved = await request(h.server)
        .post(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmation`)
        .set(dm)
        .send({ action: 'approve', confirmationId: entry.id });
      expect(approved.status).toBe(201);
    }
    return (pending.body as unknown[]).length;
  }

  async function listEncounters(campaignId: number, as: Record<string, string>) {
    const res = await request(h.server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(as);
    expect(res.status).toBe(200);
    return res.body as Array<{ id: number; name: string; hidden: boolean; status: string }>;
  }

  it('creates a fight from nothing and then begins it — the whole point of #1022', async () => {
    const campaignId = await h.createCampaign('Authoring — full flow');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Turn 1: originate the encounter and staff it. The model asks for a PUBLIC encounter
    // (hidden:false) — the guard silently makes it DM-only prep instead, so the call still
    // succeeds and the fight exists.
    h.script({
      text: 'Reeds part — wolves.',
      toolCalls: [
        {
          id: 'c1',
          name: 'create_encounter',
          arguments: { campaignId, name: 'Reed ambush', hidden: false },
        },
      ],
    });
    const created = await h.sendMessage(campaignId, { input: 'roll a random ambush' });
    expect(created.status).toBe(201);
    expect(created.body.toolCalls).toEqual([expect.objectContaining({ name: 'create_encounter', isError: false })]);

    const dmView = await listEncounters(campaignId, dm);
    const encounter = dmView.find((e) => e.name === 'Reed ambush');
    expect(encounter).toBeDefined();
    // The model asked for hidden:false and did not get it. This is the #1022 disclosure
    // boundary: the seat takes instructions from untrusted player chat, so it must not be able
    // to publish a roster to the table on request.
    expect(encounter!.hidden).toBe(true);
    expect(encounter!.status).toBe('preparing');

    // A player sees nothing — the encounter is DM prep until the human reveals it (#262).
    const playerView = await listEncounters(campaignId, player);
    expect(playerView.some((e) => e.name === 'Reed ambush')).toBe(false);

    const encounterId = encounter!.id;

    // Turn 2. The driver loops after a tool round-trip and consumes the next queued response
    // for its follow-up narration, so the queue is reset before scripting a fresh turn.
    h.resetMock();
    h.script({
      text: 'Initiative.',
      toolCalls: [
        {
          id: 'c2',
          name: 'add_combatant',
          arguments: { encounterId, kind: 'monster', name: 'Dire wolf', hpMax: 22, initMod: 2 },
        },
        { id: 'c3', name: 'roll_initiative', arguments: { encounterId } },
        { id: 'c4', name: 'begin_encounter', arguments: { encounterId } },
      ],
    });
    const staffed = await h.sendMessage(campaignId, { input: 'start the fight' });
    expect(staffed.status).toBe(201);
    expect(staffed.body.toolCalls).toEqual([
      expect.objectContaining({ name: 'add_combatant', isError: false }),
      expect.objectContaining({ name: 'roll_initiative', isError: false }),
      expect.objectContaining({ name: 'begin_encounter', pendingConfirmation: true }),
    ]);

    expect(await approveAllConfirmations(campaignId)).toBe(1);

    const afterStart = await listEncounters(campaignId, dm);
    expect(afterStart.find((e) => e.id === encounterId)?.status).toBe('running');

    // Every authoring call is in the campaign audit trail under the seat actor, so a DM can
    // reconstruct what the AI built and when.
    const audit = await h.getAudit(campaignId);
    expect(audit.status).toBe(200);
    const detail = JSON.stringify(audit.body);
    expect(detail).toContain('create_encounter');
    expect(detail).toContain('ai-dm.driver.tool');
  });

  it('refuses to reveal an encounter — including one the seat created itself', async () => {
    const campaignId = await h.createCampaign('Authoring — reveal refused');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    h.script({
      text: 'A shape in the dark.',
      toolCalls: [{ id: 'r1', name: 'create_encounter', arguments: { campaignId, name: 'Cellar rats' } }],
    });
    expect((await h.sendMessage(campaignId, { input: 'prep something' })).status).toBe(201);
    const encounterId = (await listEncounters(campaignId, dm)).find((e) => e.name === 'Cellar rats')!.id;

    h.resetMock();
    h.script({
      text: 'Let them see it.',
      toolCalls: [{ id: 'r2', name: 'update_encounter', arguments: { encounterId, hidden: false } }],
    });
    const revealed = await h.sendMessage(campaignId, { input: 'show the party what is coming' });
    expect(revealed.status).toBe(201);
    expect(revealed.body.toolCalls).toEqual([expect.objectContaining({ name: 'update_encounter', isError: true })]);

    // Still prep, still invisible to players.
    expect((await listEncounters(campaignId, dm)).find((e) => e.id === encounterId)?.hidden).toBe(true);
    expect((await listEncounters(campaignId, player)).some((e) => e.id === encounterId)).toBe(false);

    const audit = await h.getAudit(campaignId);
    expect(JSON.stringify(audit.body)).toContain('forbidden_encounter_reveal');
  });

  it('reshapes its own creation but refuses to rewrite the DM’s prepared encounter', async () => {
    const campaignId = await h.createCampaign('Authoring — reshape containment');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // A fight the human DM prepared by hand.
    const dmBuilt = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'The DM boss fight' });
    expect(dmBuilt.status).toBe(201);
    const dmEncounterId = dmBuilt.body.id as number;

    h.script({
      text: 'Wolves gather.',
      toolCalls: [{ id: 'x1', name: 'create_encounter', arguments: { campaignId, name: 'Roadside scuffle' } }],
    });
    expect((await h.sendMessage(campaignId, { input: 'make a fight' })).status).toBe(201);
    const ownId = (await listEncounters(campaignId, dm)).find((e) => e.name === 'Roadside scuffle')!.id;

    h.resetMock();
    h.script({
      text: 'Renaming.',
      toolCalls: [
        { id: 'x2', name: 'update_encounter', arguments: { encounterId: ownId, name: 'Roadside scuffle (reinforced)' } },
        { id: 'x3', name: 'update_encounter', arguments: { encounterId: dmEncounterId, name: 'Renamed by the AI' } },
      ],
    });
    const reshaped = await h.sendMessage(campaignId, { input: 'tidy up the encounter names' });
    expect(reshaped.status).toBe(201);
    expect(reshaped.body.toolCalls).toEqual([
      expect.objectContaining({ name: 'update_encounter', isError: false }),
      expect.objectContaining({ name: 'update_encounter', isError: true }),
    ]);

    const after = await listEncounters(campaignId, dm);
    expect(after.find((e) => e.id === ownId)?.name).toBe('Roadside scuffle (reinforced)');
    // The DM's own prep is untouched — the AI has no authority to overwrite a human's work
    // with no diff for them to review.
    expect(after.find((e) => e.id === dmEncounterId)?.name).toBe('The DM boss fight');

    const audit = await h.getAudit(campaignId);
    expect(JSON.stringify(audit.body)).toContain('forbidden_encounter_reshape');
  });

  it('offers encounter authoring in the tool schema and advertises it in the system prompt', async () => {
    const campaignId = await h.createCampaign('Authoring — advertised');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    h.script({ text: 'Looking around.' });
    expect((await h.sendMessage(campaignId, { input: 'what do I see' })).status).toBe(201);

    const last = h.mock.received[h.mock.received.length - 1];
    const offered = (last.tools ?? []).map((t) => t.name);
    expect(offered).toContain('create_encounter');
    expect(offered).toContain('update_encounter');

    // The driver-specific update_encounter description must state both limits, or the model
    // burns turns discovering them by trial and error.
    const updateDesc = (last.tools ?? []).find((t) => t.name === 'update_encounter')?.description ?? '';
    expect(updateDesc).toContain('created this session');
    expect(updateDesc.toLowerCase()).toContain('hidden');

    // And the system prompt tells the model the capability exists at all (#1022 AC: "system
    // context advertises encounter authoring").
    expect(last.system).toContain('create_encounter');
    expect(last.system).toContain('DM-only prep');
  });
});

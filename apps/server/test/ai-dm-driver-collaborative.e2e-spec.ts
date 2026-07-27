import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';

/**
 * Issue #1051 — collaborative handoff: the AI narrates, a human decides the mechanics.
 *
 * The runtime half of this already existed. #474's confirm policy queues a tool call for DM
 * review, tells the model `pending_dm_confirmation`, and lets the turn CARRY ON — which is
 * precisely "narrates but defers mechanics". What was missing was a way to say "apply that to
 * this whole class of tools", so these tests are about the policy selection and the state that
 * carries it, not about re-proving the queue.
 */
describe('ai-dm driver — collaborative handoff (#1051)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'collab-model' });
    await h.enableExperimental();
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  const armed = async (name: string): Promise<number> => {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    return campaignId;
  };
  const setCollab = (campaignId: number, enabled: boolean, headers = dm) =>
    request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/collaborative`).set(headers).send({ enabled });
  const session = async (campaignId: number) => (await h.getDriverSession(campaignId)).body;
  const pending = async (campaignId: number) =>
    (await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/tool-confirmations`).set(dm)).body;

  it('is DM-only and off by default', async () => {
    const campaignId = await armed('Collab Gate');
    expect((await session(campaignId)).state).toBe('running');
    expect((await setCollab(campaignId, true, player)).status).toBe(403);

    const res = await setCollab(campaignId, true);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('collaborative');
    expect((await session(campaignId)).levers).toContain('end_collaborative');
  });

  it('defers a mechanical commit to the DM instead of executing it', async () => {
    const campaignId = await armed('Defer Damage');
    await setCollab(campaignId, true);

    h.script({
      text: 'She swings for the gap in its armour.',
      toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: { expression: '1d20' } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'The blade finds its mark.', usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 } });

    const res = await h.sendMessage(campaignId, { input: 'I attack the goblin' });
    expect(res.status).toBe(201);

    // The roll ran: it produces a number, and nothing changes until something applies it.
    const rolled = (res.body.toolCalls as Array<{ name: string; pendingConfirmation?: boolean }>)
      .find((c) => c.name === 'roll_dice');
    expect(rolled).toBeDefined();
    expect(rolled?.pendingConfirmation).toBeFalsy();
  });

  it('queues update_character_hp for confirmation, and the turn still finishes', async () => {
    const campaignId = await armed('Defer HP');
    await setCollab(campaignId, true);

    h.script({
      text: 'The goblin reels.',
      toolCalls: [{ id: 'c1', name: 'update_character_hp', arguments: { characterId: 1, hpDelta: -7 } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'It staggers back a step.', usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 } });

    const res = await h.sendMessage(campaignId, { input: 'I hit it' });
    expect(res.status).toBe(201);

    // THE SHAPE OF THE WHOLE FEATURE. The turn is NOT blocked — the model is told the call is
    // pending and keeps narrating. That is what makes "AI narrates, human decides mechanics"
    // work as one continuous scene rather than a stall at every swing.
    const hp = (res.body.toolCalls as Array<{ name: string; pendingConfirmation?: boolean }>)
      .find((c) => c.name === 'update_character_hp');
    expect(hp?.pendingConfirmation).toBe(true);
    expect(res.body.stopReason).toBe('complete');

    const queue = await pending(campaignId);
    expect(queue).toHaveLength(1);
    expect(queue[0].tool).toBe('update_character_hp');
    // The DM needs to see WHAT they are approving, not just that something is waiting.
    expect(queue[0].args).toMatchObject({ hpDelta: -7 });
  });

  it('executes the same tool automatically when the mode is off', async () => {
    const campaignId = await armed('Solo Executes');
    h.script({
      text: 'The goblin reels.',
      toolCalls: [{ id: 'c1', name: 'update_character_hp', arguments: { characterId: 1, hpDelta: -7 } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Done.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });

    const res = await h.sendMessage(campaignId, { input: 'I hit it' });
    const hp = (res.body.toolCalls as Array<{ name: string; pendingConfirmation?: boolean }>)
      .find((c) => c.name === 'update_character_hp');
    expect(hp?.pendingConfirmation).toBeFalsy();
    expect(await pending(campaignId)).toHaveLength(0);
  });

  it('tells the model to narrate a deferred action as attempted, not resolved', async () => {
    const campaignId = await armed('Honesty Clause');
    await setCollab(campaignId, true);
    h.script({ text: 'She swings.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await h.sendMessage(campaignId, { input: 'attack' });

    // Without this the model would say "nine damage" while the board never changed — a silent
    // divergence between what the table heard and what is true, which is a worse failure than
    // the autonomy the mode removes.
    const received = h.mock.received;
    const system = String(received[received.length - 1]?.system ?? '');
    expect(system).toContain('Collaborative handoff (ACTIVE)');
    expect(system).toContain('ATTEMPTED or IMMINENT');
  });

  it('survives a pause: resuming does not silently restore full autonomy', async () => {
    const campaignId = await armed('Pause Keeps Mode');
    await setCollab(campaignId, true);

    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: true });
    expect((await session(campaignId)).state).toBe('paused');

    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/resume`).set(dm);
    // A DM who paused for five minutes must not come back to a seat quietly applying damage on
    // its own again. Pause says nothing about autonomy, so it must not change it.
    expect((await session(campaignId)).state).toBe('collaborative');
  });

  it('keeps deferring while the seat is stuck, even though the ladder slot shows the stuck state', async () => {
    const campaignId = await armed('Stuck Keeps Mode');
    await setCollab(campaignId, true);

    h.script({ throwError: new Error('provider exploded'), text: '' });
    await h.sendMessage(campaignId, { input: 'attack' });
    const stuck = await session(campaignId);
    expect(stuck.state).toBe('awaiting_players'); // the urgent condition owns the display slot

    // ...but the MODE is still on underneath, so a recovery turn still defers its mechanics.
    h.script({
      text: 'The goblin reels.',
      toolCalls: [{ id: 'c1', name: 'apply_action', arguments: { encounterId: 1 } }],
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    h.script({ text: 'Recovered.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    const retried = await h.lever(campaignId, 'nudge', {}, player);
    expect(retried.status).toBe(201);
    const applied = (retried.body.toolCalls as Array<{ name: string; pendingConfirmation?: boolean }>)
      .find((c) => c.name === 'apply_action');
    expect(applied?.pendingConfirmation).toBe(true);
  });

  it('turning the mode off returns the seat to running and to automatic execution', async () => {
    const campaignId = await armed('Mode Off');
    await setCollab(campaignId, true);
    const off = await setCollab(campaignId, false);
    expect(off.status).toBe(200);
    expect(off.body.state).toBe('running');

    // Idempotent both ways.
    expect((await setCollab(campaignId, false)).status).toBe(200);
    expect((await session(campaignId)).state).toBe('running');
  });

  it('records the autonomy change in the durable table log', async () => {
    const campaignId = await armed('Collab Transcript');
    await setCollab(campaignId, true);
    const page = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/transcript`).set(dm);
    const controls = (page.body.items as Array<{ kind: string; payload: Record<string, unknown> }>)
      .filter((e) => e.kind === 'control')
      .map((e) => e.payload.control);
    // A player who joins late must be able to SEE that the AI stopped deciding mechanics, not
    // infer it from the fact that damage stopped landing.
    expect(controls).toContain('collaborative');
  });
});

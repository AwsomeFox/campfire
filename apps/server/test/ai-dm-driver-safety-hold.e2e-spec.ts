import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';
import type { CampaignEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';
import { TableSafetyService } from '../src/modules/safety/table-safety.service';
import {
  NARRATION_QUARANTINE_CHARS,
  setNarrationQuarantineCharsForTests,
} from '../src/modules/ai-driver/driver-safety';

/**
 * Issue #599 — a participant safety hold freezes the AI seat's input, its IN-FLIGHT output,
 * and its queued tool dispatch.
 *
 * Stopping new turns is the easy half and is covered by the first test here. The rest of this
 * file is the half with teeth: a turn that is already streaming, and a tool call the model has
 * already emitted but the server has not yet dispatched.
 */
describe('ai-dm driver — participant safety hold freezes the seat (#599)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'safety-hold-model' });
    await h.enableExperimental();
    // #598: the cases below raise the hold MID-STREAM by reacting to the first
    // `narration.delta`. The withheld-turn quarantine is a trailing delay line, so a scripted
    // reply shorter than the window emits no delta at all until the stream ends — the
    // subscriber would never fire, the hold would never be raised, and the stalled stream
    // would hang to the test timeout instead of asserting anything. Switching the window off
    // keeps this suite testing what it is about (#599 freezing an in-flight turn); the
    // window's own behaviour is covered by driver-safety.spec.ts and the #598 e2e suite. Same
    // convention, and the same reason, as ai-dm-driver-stop-controls.e2e-spec.ts.
    setNarrationQuarantineCharsForTests(0);
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    setNarrationQuarantineCharsForTests(NARRATION_QUARANTINE_CHARS);
    await h.close();
  });

  const hold = (campaignId: number, headers = player) =>
    request(h.server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(headers).send({});

  it('a hold raised by a PLAYER pauses the seat and blocks new input', async () => {
    const campaignId = await h.createCampaign('Safety Blocks Input');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const res = await hold(campaignId);
    expect(res.status).toBe(200);

    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.status).toBe('paused');
    expect(session.body.state).toBe('paused');

    h.script({ text: 'You press on into the dark.', usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 } });
    const blocked = await h.sendMessage(campaignId, { input: 'we keep going' });
    expect(blocked.status).toBe(503);
    // Not the generic seat-paused message: "resume it" is wrong advice here, because the
    // seat's own resume refuses while a hold stands.
    expect(String(blocked.body.message)).toContain('safety hold');
  });

  it('aborts an IN-FLIGHT stream mid-narration and stops the tail from reaching the table', async () => {
    const campaignId = await h.createCampaign('Safety Aborts Stream');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const safety = h.ctx.app.get(TableSafetyService);
    const events: CampaignEvent[] = [];
    let raised = false;
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => {
      events.push(e);
      // Raise the hold from INSIDE the stream, the way a participant would: the AI is
      // mid-sentence and someone at the table has heard enough.
      if (e.type === 'narration.delta' && !raised) {
        raised = true;
        void safety.activate(campaignId, null);
      }
    });

    const full = 'The captive screams as the blade comes down and the villagers watch in silence.';
    h.script({
      text: full,
      streamChunks: 10,
      stallAfterChunks: 2,
      usage: { promptTokens: 8, completionTokens: 6, totalTokens: 14 },
    });

    const res = await h.sendMessage(campaignId, { input: 'we watch' });
    sub.unsubscribe();

    expect(raised).toBe(true);
    expect(res.status).toBe(201);
    // `frozen`, not `complete`: the turn did not run to the end and then notice.
    expect(res.body.stopReason).toBe('frozen');
    expect(res.body.narration.length).toBeLessThan(full.length);
    expect(events.some((e) => e.type === 'turn.cancelled')).toBe(true);

    // Everything the table actually SAW is a prefix of the scripted narration, and it stops
    // short. The regression this guards is the grounding delta filter's tail flush (#577),
    // which used to fire in the stream step's `finally` regardless of why the stream ended and
    // would have pushed one last buffered fragment out AFTER the stop.
    const shown = events
      .filter((e): e is Extract<CampaignEvent, { type: 'narration.delta' }> => e.type === 'narration.delta')
      .map((e) => e.text)
      .join('');
    expect(full.startsWith(shown)).toBe(true);
    expect(shown.length).toBeLessThan(full.length);
  });

  it('blocks tool dispatch the model already asked for', async () => {
    const campaignId = await h.createCampaign('Safety Blocks Tools');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const safety = h.ctx.app.get(TableSafetyService);
    const toolEvents: CampaignEvent[] = [];
    let raised = false;
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => {
      if (e.type === 'tool') toolEvents.push(e);
      if (e.type === 'turn.start' && !raised) {
        raised = true;
        void safety.activate(campaignId, null);
      }
    });

    // Two tool calls in one turn. `executeToolCalls` re-checks generation authority before
    // EVERY call, so a hold that lands after the model emitted them dispatches neither.
    h.script({
      text: 'Rolling for the strike…',
      toolCalls: [
        { id: 'c1', name: 'roll_dice', arguments: { expression: '1d20' } },
        { id: 'c2', name: 'roll_dice', arguments: { expression: '2d6' } },
      ],
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });

    const res = await h.sendMessage(campaignId, { input: 'attack' });
    sub.unsubscribe();

    expect(raised).toBe(true);
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('frozen');
    expect(res.body.toolCalls).toHaveLength(0);
    expect(toolEvents).toHaveLength(0);
  });

  it('the seat cannot be resumed while the hold stands — only released, by a facilitator', async () => {
    const campaignId = await h.createCampaign('Safety Blocks Resume');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    await hold(campaignId);

    // The DM pause and the safety hold are the same session state with different provenance.
    // Without this guard the seat's own resume would be an unaudited back door around the
    // recovery the facilitator is supposed to make deliberately.
    const resume = await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/resume`).set(dm);
    expect(resume.status).toBe(409);
    expect(resume.body.code).toBe('TABLE_SAFETY_HOLD');

    const viaPause = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`)
      .set(dm)
      .send({ paused: false });
    expect(viaPause.status).toBe(409);

    const released = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/safety/release`)
      .set(dm)
      .send({ recovery: 'resume' });
    expect(released.status).toBe(200);

    // Release does NOT auto-resume: the seat stays paused until a human says go. Resuming on
    // release would mean the AI starts narrating at the instant the hold clears, before anyone
    // has asked "are we good?".
    const stillPaused = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(stillPaused.body.status).toBe('paused');

    const nowResumed = await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/resume`).set(dm);
    expect(nowResumed.status).toBe(201);
    expect(nowResumed.body.status).not.toBe('paused');
  });

  it("a recovery other than 'resume' leaves the seat paused for the facilitator to reset the scene", async () => {
    const campaignId = await h.createCampaign('Safety Scene Change');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    await hold(campaignId);
    await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/safety/release`)
      .set(dm)
      .send({ recovery: 'scene_change', note: 'cutting to the road north' });

    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.status).toBe('paused');
  });
});

import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import { AiDriverService } from '../src/modules/ai-driver/ai-driver.service';
import type { CampaignEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';
import { AiConsoleService } from '../src/modules/ai-console/ai-console.service';
import {
  NARRATION_QUARANTINE_CHARS,
  setNarrationQuarantineCharsForTests,
} from '../src/modules/ai-driver/driver-safety';

/**
 * Issue #558 — stop controls cancel in-flight generation and block pending tool calls.
 */

describe('ai-dm driver — stop controls cancel generation (#558)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'stop-ctrl-model' });
    await h.enableExperimental();
    // #598: every case below intervenes MID-STREAM by reacting to the first `narration.delta`.
    // The safety quarantine is a trailing delay line, so a short scripted reply emits no delta
    // at all until the stream ends, and these stop controls would have nothing to fire on.
    // Switching the window off keeps this suite testing what it is about (#558 cancellation);
    // the window's own behaviour is covered by driver-safety.spec.ts and the #598 e2e suite.
    setNarrationQuarantineCharsForTests(0);
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    setNarrationQuarantineCharsForTests(NARRATION_QUARANTINE_CHARS);
    await h.close();
  });

  it('pause during streaming aborts the provider, emits turn.cancelled, and preserves partial narration', async () => {
    const campaignId = await h.createCampaign('Stop Ctrl Pause');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const driver = h.ctx.app.get(AiDriverService);
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    let paused = false;
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => {
      events.push(e);
      if (e.type === 'narration.delta' && !paused) {
        paused = true;
        driver.setPaused(campaignId, true);
      }
    });

    h.script({
      text: 'The torches gutter as the door swings wide open.',
      streamChunks: 8,
      stallAfterChunks: 2,
      usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 },
    });

    const res = await h.sendMessage(campaignId, { input: 'we enter' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(paused).toBe(true);
    expect(res.body.stopReason).toBe('frozen');
    expect(res.body.narration.length).toBeGreaterThan(0);
    expect(res.body.narration.length).toBeLessThan('The torches gutter as the door swings wide open.'.length);

    const cancelled = events.find((e) => e.type === 'turn.cancelled');
    const ended = events.find((e) => e.type === 'turn.end');
    expect(cancelled).toBeDefined();
    expect(ended).toBeDefined();
    const cancelledIdx = events.findIndex((e) => e.type === 'turn.cancelled');
    const endIdx = events.findIndex((e) => e.type === 'turn.end');
    expect(cancelledIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(cancelledIdx);
    if (cancelled?.type === 'turn.cancelled') {
      expect(cancelled.narration).toBe(res.body.narration);
      expect(cancelled.stopReason).toBe('frozen');
    }

    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.status).toBe('paused');
    expect(session.body.state).toBe('paused');
  });

  it('kill switch during streaming cancels the generation with stopReason cancelled', async () => {
    const campaignId = await h.createCampaign('Stop Ctrl Kill');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const consoleSvc = h.ctx.app.get(AiConsoleService);
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const user = { id: 'dev:ai-eval-dm', name: 'ai-eval-dm', serverRole: 'user' as const, devRole: 'dm' as const };
    let killed = false;
    let killSwitchPromise: Promise<unknown> | undefined;
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => {
      events.push(e);
      if (e.type === 'narration.delta' && !killed) {
        killed = true;
        killSwitchPromise = consoleSvc.setKillSwitch(false, user);
      }
    });

    h.script({
      text: 'A long narration that should be cut short by the kill switch.',
      streamChunks: 10,
      stallAfterChunks: 1,
    });

    const res = await h.sendMessage(campaignId, { input: 'keep going' });
    sub.unsubscribe();
    await killSwitchPromise;

    expect(res.status).toBe(201);
    expect(killed).toBe(true);
    expect(res.body.stopReason).toBe('cancelled');
    expect(events.some((e) => e.type === 'turn.cancelled')).toBe(true);

    await request(h.server).patch('/api/v1/settings').set(dm).send({ experimentalAiDm: true });
  });

  it('pause before tool execution blocks the tool call', async () => {
    const campaignId = await h.createCampaign('Stop Ctrl Tool Block');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const driver = h.ctx.app.get(AiDriverService);
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    let paused = false;
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => {
      events.push(e);
      if (e.type === 'narration.message' && !paused) {
        paused = true;
        driver.setPaused(campaignId, true);
      }
    });

    h.script({
      text: 'I consult the records.',
      toolCalls: [{ id: 'tc1', name: 'get_campaign_summary', arguments: { campaignId } }],
    });

    const res = await h.sendMessage(campaignId, { input: 'what do we know?' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('frozen');
    expect(res.body.toolCalls).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool')).toBe(false);
  });
});

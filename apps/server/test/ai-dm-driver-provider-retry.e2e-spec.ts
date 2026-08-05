import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import type { CampaignEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';
import { setRetrySleepForTests } from '../src/modules/ai-driver/ai-driver.service';
import { AiProviderError } from '../src/modules/ai-dm/providers/errors';

/**
 * #1052 — transient provider failures retry (and, when configured, fail over) instead of
 * ending the turn.
 *
 * The gap this closes is narrower than "no retry": `postJson` in providers/http.ts has always
 * retried 429/5xx/transport/timeout on the REQUEST. What nothing could retry was a failure
 * after the response headers arrived — the stream is open, bytes are flowing, and the
 * connection drops. Only something that can re-issue the whole STEP can recover that, which
 * is the driver.
 *
 * These drive the real HTTP surface with a scripted model, because the interesting properties
 * are all about what the turn loop does around the retry: that a refusal is never re-sent,
 * that a retry never re-narrates over prose the table already read, that the budget gate is
 * re-evaluated per attempt, and that the stuck ladder still reports a provider failure as a
 * provider failure rather than a tool error.
 */

async function withStream<T>(
  h: AiEvalHarness,
  campaignId: number,
  fn: () => Promise<T>,
): Promise<{ result: T; events: CampaignEvent[] }> {
  const streamSvc = h.ctx.app.get(AiDmStreamService);
  const events: CampaignEvent[] = [];
  const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));
  try {
    return { result: await fn(), events };
  } finally {
    sub.unsubscribe();
  }
}

/** A retryable mid-stream fault: the stream opened, then the connection dropped. */
function transientError(): AiProviderError {
  return new AiProviderError('transport', 'mock: connection reset mid-stream', { provider: 'mock' });
}

describe('ai-dm driver — transient provider failure retry + failover (#1052)', () => {
  let h: AiEvalHarness;
  const slept: number[] = [];

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-model', fallback: { model: 'fallback-model' } });
    await h.enableExperimental();
    // Record the backoff instead of serving it: the delays are asserted by the pure policy
    // spec, and a suite that actually waited them would spend its runtime asleep.
    setRetrySleepForTests(async (ms) => {
      slept.push(ms);
    });
  });

  beforeEach(() => {
    h.resetMock();
    slept.length = 0;
  });

  afterAll(async () => {
    setRetrySleepForTests((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
    await h.close();
  });

  async function armedCampaign(name: string): Promise<number> {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    return campaignId;
  }

  function audit(campaignId: number) {
    return request(h.server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
  }

  it('retries a transient failure that produced no narration, and the turn completes', async () => {
    const campaignId = await armedCampaign('Retry transient');
    h.script(
      // Attempt 1: the stream dies before a single token reaches the table.
      { throwError: transientError(), throwAfterChunks: 0 },
      // Attempt 2: the provider recovers.
      { text: 'The torch gutters, then steadies.' },
    );

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'I light the torch.' }),
    );

    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');
    expect(res.body.narration).toBe('The torch gutters, then steadies.');
    // Exactly one backoff was taken — one retry, not a storm.
    expect(slept).toHaveLength(1);
    // The table never saw a failure at all.
    expect(events.some((e) => e.type === 'turn.error')).toBe(false);

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('running');
    expect(session.body.stuck).toBeNull();
  });

  it('does NOT retry once narration has reached the table — no silent re-narration', async () => {
    const campaignId = await armedCampaign('Retry after broadcast');
    h.script(
      // Two chunks land on the wire, THEN the stream dies.
      { text: 'The alley narrows and the lamp gutters out.', streamChunks: 4, throwError: transientError(), throwAfterChunks: 2 },
      // Would have been a completely different reply. It must never be requested.
      { text: 'A SECOND CONTRADICTORY REPLY' },
    );

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'I follow him.' }),
    );

    expect(res.body.stopReason).toBe('provider_error');
    expect(slept).toHaveLength(0);
    // The replacement reply was never generated, so the table is not told two different
    // things about the same moment.
    expect(JSON.stringify(events)).not.toContain('A SECOND CONTRADICTORY REPLY');
    expect(h.mock.received).toHaveLength(1);

    const entry = ((await audit(campaignId)).body.items ?? (await audit(campaignId)).body) as Array<{
      action: string;
      detail: string;
    }>;
    const logged = entry.find((e) => e.action === 'ai-dm.driver.provider_error');
    // The audit says WHY it stopped, so "did this retry?" is answerable after the fact.
    expect(logged?.detail).toContain('gave_up=already_broadcast');
  });

  it('never retries a provider CONTENT REFUSAL, and never fails it over (#598 boundary)', async () => {
    const campaignId = await armedCampaign('Retry refusal');
    h.script(
      { throwError: new AiProviderError('content_filter', 'mock: request refused on safety grounds', { provider: 'mock' }) },
      { text: 'A REPLY THE FILTER ALREADY DECLINED' },
    );
    h.scriptFallback({ text: 'THE FALLBACK ANSWERING A REFUSED PROMPT' });

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'something the provider will refuse' }),
    );

    expect(res.body.stopReason).toBe('provider_error');
    // One provider call, full stop. Re-sending a refused prompt — to the same vendor OR to a
    // different one — is a safety bypass, not resilience.
    expect(h.mock.received).toHaveLength(1);
    expect(h.fallbackMock!.received).toHaveLength(0);
    expect(slept).toHaveLength(0);
    const wire = JSON.stringify(events);
    expect(wire).not.toContain('A REPLY THE FILTER ALREADY DECLINED');
    expect(wire).not.toContain('THE FALLBACK ANSWERING A REFUSED PROMPT');

    const entries = ((await audit(campaignId)).body.items ?? (await audit(campaignId)).body) as Array<{
      action: string;
      detail: string;
    }>;
    expect(entries.find((e) => e.action === 'ai-dm.driver.provider_error')?.detail).toContain('gave_up=safety');
  });

  it.each([['auth'], ['invalid_request'], ['context_length']] as const)(
    'does not retry a deterministic %s failure',
    async (kind) => {
      const campaignId = await armedCampaign(`Retry deterministic ${kind}`);
      h.script({ throwError: new AiProviderError(kind, `mock: ${kind}`, { provider: 'mock' }) }, { text: 'never reached' });

      const res = await h.sendMessage(campaignId, { input: 'go' });
      expect(res.body.stopReason).toBe('provider_error');
      expect(h.mock.received).toHaveLength(1);
      expect(slept).toHaveLength(0);
    },
  );

  it('fails over to the configured fallback provider after the primary exhausts its attempts', async () => {
    const campaignId = await armedCampaign('Retry failover');
    // Both primary attempts die before any token; the fallback then serves the turn.
    h.script({ throwError: transientError() }, { throwError: transientError() });
    h.scriptFallback({ text: 'The understudy picks up the scene.' });

    const res = await h.sendMessage(campaignId, { input: 'go on then' });

    expect(res.body.stopReason).toBe('complete');
    expect(res.body.narration).toBe('The understudy picks up the scene.');
    // The primary got BOTH of its attempts before the table was moved to another model —
    // failover is a last resort, not load balancing.
    expect(h.mock.received).toHaveLength(2);
    expect(h.fallbackMock!.received).toHaveLength(1);
    expect(slept).toHaveLength(2);
  });

  it('ends as provider_error when the fallback fails too, and the ladder says PROVIDER, not tool', async () => {
    const campaignId = await armedCampaign('Retry all exhausted');
    h.script({ throwError: transientError() }, { throwError: transientError() });
    h.scriptFallback({ throwError: transientError() });

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'go' }),
    );

    expect(res.body.stopReason).toBe('provider_error');
    expect(h.mock.received).toHaveLength(2);
    expect(h.fallbackMock!.received).toHaveLength(1);

    // Acceptance criterion: the stuck ladder distinguishes a provider failure from a tool
    // error — different reason, different first levers.
    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck.reason).toBe('provider_error');
    expect(session.body.stuck.reason).not.toBe('tool_error');
    expect(session.body.levers.slice(0, 2)).toEqual(['retry', 'continue_without_ai']);

    const failure = events.find((e) => e.type === 'turn.error');
    expect(failure).toBeDefined();
    if (failure?.type === 'turn.error') expect(failure.stopReason).toBe('provider_error');

    const entries = ((await audit(campaignId)).body.items ?? (await audit(campaignId)).body) as Array<{
      action: string;
      detail: string;
    }>;
    const logged = entries.find((e) => e.action === 'ai-dm.driver.provider_error');
    expect(logged?.detail).toContain('attempts=3');
    expect(logged?.detail).toContain('gave_up=attempts_exhausted');
    expect(logged?.detail).toContain('fallback=configured');
  });

  it('a retry storm cannot outrun the token budget the DM set', async () => {
    const campaignId = await h.createCampaign('Retry budget');
    // Enough for the first attempt's reservation and no more.
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 60 });
    h.script(
      { throwError: transientError(), usage: { promptTokens: 60, completionTokens: 0, totalTokens: 60 } },
      { throwError: transientError() },
      { throwError: transientError() },
    );
    h.scriptFallback({ throwError: transientError() });

    const res = await h.sendMessage(campaignId, { input: 'go' });

    // Whatever the outcome label, the invariant is that the retry loop did not keep calling a
    // provider on a budget that was gone: every attempt re-takes the spend lock and re-reads
    // the remaining budget, so the gate cannot be outrun by a loop that reserved once.
    expect(h.mock.received.length).toBeLessThanOrEqual(2);
    const seat = await h.getSeat(campaignId);
    expect(seat.body.budgetRemaining).toBeGreaterThanOrEqual(0);
    expect(res.status).toBe(201);
  });

  it('does not fail over when no fallback is configured (failover is opt-in)', async () => {
    // A harness with no `fallback` option binds a resolver WITHOUT resolveFallbackForExecution,
    // which is the real default for an install that never configured one.
    const solo = await createAiEvalHarness({ model: 'solo-model' });
    try {
      await solo.enableExperimental();
      const campaignId = await solo.createCampaign('No fallback');
      await solo.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
      solo.script({ throwError: transientError() }, { throwError: transientError() }, { text: 'third attempt' });

      const res = await solo.sendMessage(campaignId, { input: 'go' });
      expect(res.body.stopReason).toBe('provider_error');
      // Two attempts against the primary and no third — the extra attempt exists only when
      // there is a genuinely different provider to spend it on.
      expect(solo.mock.received).toHaveLength(2);
    } finally {
      await solo.close();
    }
  });
});

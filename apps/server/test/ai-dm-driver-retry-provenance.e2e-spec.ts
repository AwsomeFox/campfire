import { createAiEvalHarness, type AiEvalHarness } from './ai-eval-harness';
import { AiDmStreamService, type AiDmStreamEvent } from '../src/modules/ai-driver/ai-driver-stream.service';
import { setRetrySleepForTests } from '../src/modules/ai-driver/ai-driver.service';
import { AiProviderError } from '../src/modules/ai-dm/providers/errors';

/**
 * #1052 review — provenance and usage precision after a failover.
 *
 * Both bugs here are the same shape: PER-TURN state updated from PER-STEP facts, under a
 * condition that was right for the case it was written for. `servedProviderName` needed the
 * no-text half; the usage flag needed the unknown half.
 */
const transient = () => new AiProviderError('transport', 'mock: connection reset mid-stream', { provider: 'mock' });

describe('ai-dm driver — failover provenance + usage precision (#1052 review)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'primary-model', fallback: { model: 'fallback-model' } });
    await h.enableExperimental();
    setRetrySleepForTests(async () => {});
  });

  beforeEach(() => h.resetMock());

  afterAll(async () => {
    setRetrySleepForTests((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
    await h.close();
  });

  const armed = async (name: string): Promise<number> => {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    return campaignId;
  };
  /**
   * Capture the turn's stream frames.
   *
   * Provenance is asserted on the `grounding` FRAME rather than the persisted claim rows: the
   * frame carries the served provider/model for every turn, while claim rows only exist when the
   * narration made citable assertions. The frame is the same `servedProviderName`/`Model` pair
   * `evaluateTurnGrounding` files the rows under, so it is the identity under test — just
   * observable on a turn whose prose happens to claim nothing.
   */
  async function withStream<T>(campaignId: number, fn: () => Promise<T>) {
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));
    try {
      return { result: await fn(), events };
    } finally {
      sub.unsubscribe();
    }
  }
  const turnEnd = (events: AiDmStreamEvent[]) =>
    events.find((e): e is Extract<AiDmStreamEvent, { type: 'turn.end' }> => e.type === 'turn.end');

  it('attributes terminal FALLBACK narration to the fallback, not the primary', async () => {
    const campaignId = await armed('Terminal Fallback Provenance');
    // Both primary attempts die before a token lands, so the step fails over. The fallback then
    // puts prose on the wire and throws — `already_broadcast` refuses a further retry, and that
    // partial text is what the table keeps.
    h.script({ throwError: transient(), throwAfterChunks: 0 }, { throwError: transient(), throwAfterChunks: 0 });
    h.scriptFallback?.({ throwError: transient(), throwAfterChunks: 2, text: 'The lantern swings wide and the corridor answers.' });

    const { result: res } = await withStream(campaignId, () =>
      h.sendMessage(campaignId, { input: 'I raise the lantern.' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.narration.length).toBeGreaterThan(0);

    // The identity update used to be skipped entirely for a terminal `provider_error`, so the
    // fallback's words were filed under the primary the DM configured.
    // `res.body.grounding` is the verdict `evaluateTurnGrounding` builds from
    // `servedProviderName`/`servedProviderModel` — the same pair it files claim rows under, and
    // present even on a turn whose prose claims nothing.
    expect(res.body.grounding).toMatchObject({ provider: 'mock-fallback', model: 'fallback-model' });
  });

  it('a later tool-only step does NOT steal provenance from the fallback that narrated', async () => {
    const campaignId = await armed('Tool Only Step Provenance');
    // Step 1: primary fails twice, fallback narrates AND asks for a tool.
    h.script({ throwError: transient(), throwAfterChunks: 0 }, { throwError: transient(), throwAfterChunks: 0 });
    h.scriptFallback?.({
      text: 'The lantern swings wide and the corridor answers.',
      // Must SUCCEED, or the turn stops at step 1 with `tool_error` and the second step — the
      // whole point of this test — never runs.
      toolCalls: [{ id: 'c1', name: 'get_campaign_summary', arguments: { campaignId } }],
    });
    // Step 2: the primary has recovered and completes with NO text at all.
    h.script({ text: '', streamTextDeltas: false });

    const { result: res } = await withStream(campaignId, () =>
      h.sendMessage(campaignId, { input: 'I raise the lantern.' }),
    );
    expect(res.status).toBe(201);
    // `finalNarration` still holds the fallback's prose — `setNarration` never ran for step 2.
    expect(res.body.narration).toContain('lantern');

    // ...so provenance must still name the fallback. The `kind === 'metered'` disjunct fired for
    // ANY successful step, including a tool-only one, flipping the identity back to a provider
    // that wrote none of the retained words.
    expect(res.body.steps).toBeGreaterThan(1); // the second step must actually have run
    expect(res.body.grounding).toMatchObject({ provider: 'mock-fallback' });
    expect(res.body.grounding.model).not.toBe('primary-model');
  });

  it('keeps a turn labelled unmeasured when an abandoned attempt could not report usage', async () => {
    const campaignId = await armed('Carried Usage Unknown');
    // Attempt 1 dies without ever reporting usage: its reservation is consumed with the amount
    // UNKNOWN. Attempt 2 succeeds and reports an exact count.
    h.script(
      { throwError: transient(), throwAfterChunks: 0 },
      { text: 'The torch steadies.', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
    );

    const { result: res, events } = await withStream(campaignId, () =>
      h.sendMessage(campaignId, { input: 'I light the torch.' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');

    // Carrying only `metered.tokensUsed` fixed the under-report and made this worse: the seat
    // still carried an unmeasured charge while the turn presented its number as exact. A wrong
    // number is a wrong number; a false claim of precision the DM cannot see is worse.
    // Asserted on `turn.end`, which is the frame the table and the durable `turn.ended`
    // transcript row are both built from — i.e. where the false claim of precision was visible.
    expect(turnEnd(events)?.tokensUsageUnknown).toBe(true);
  });
});

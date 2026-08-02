import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import type { CampaignEvent, AiDmTranscriptEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';
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
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));
    try {
      return { result: await fn(), events };
    } finally {
      sub.unsubscribe();
    }
  }
  const turnEnd = (events: CampaignEvent[]) =>
    events.find((e): e is Extract<CampaignEvent, { type: 'turn.end' }> => e.type === 'turn.end');
  /**
   * The durable half of the same claim. `turn.end` is the live frame; this row is what a DM
   * who reads the turn back tomorrow sees, and the two are written by the same call — so a
   * defect at the call site shows up in both, and a test that checks only one of them is
   * checking half the surface. `AiDmTurnRunResult` carries no usage-precision field at all,
   * so asserting on the returned body would test nothing.
   */
  async function endedRow(campaignId: number): Promise<AiDmTranscriptEvent | undefined> {
    const res = await request(h.server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/transcript`)
      .set(dm)
      .query({ limit: 200 });
    expect(res.status).toBe(200);
    return (res.body.items as AiDmTranscriptEvent[]).find((e) => e.kind === 'turn.ended');
  }

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

  it('keeps the unmeasured label when a LATER attempt fails with known usage', async () => {
    const campaignId = await armed('Carried Unknown Then Known Error');
    // Devin's reproduction, exactly. No fallback, two attempts:
    //  1. throws BEFORE its usage frame → reservation consumed with usage unknown, nothing
    //     broadcast, so a retry is allowed.
    //  2. reports PARTIAL usage and then fails non-retryably → terminal `provider_error` whose
    //     own `usageUnknown` is false.
    // The terminal branch reassigned the per-turn accumulator from that per-step fact and
    // clobbered the sticky true. Three of the four terminal branches combined correctly; this
    // was the one that did not, which is why the fix is a write-only-through-a-helper
    // accumulator rather than a patch at this exit.
    h.script(
      { throwError: transient(), throwAfterChunks: 0 },
      {
        throwError: new AiProviderError('auth', 'mock: key rejected', { provider: 'mock' }),
        throwAfterUsage: true,
        streamTextDeltas: false,
        usage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 },
      },
    );

    const { result: res, events } = await withStream(campaignId, () =>
      h.sendMessage(campaignId, { input: 'I light the torch.' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');

    // The seat was charged an unmeasured amount by attempt 1; the turn must not present its
    // total as exact.
    expect(turnEnd(events)?.tokensUsageUnknown).toBe(true);
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

  it('keeps the unmeasured label when a mode switch DETACHES the session during retry backoff', async () => {
    const campaignId = await armed('Detached During Backoff');
    // The reachable sequence, in order:
    //  1. Attempt 1 throws BEFORE its usage frame with nothing broadcast → its reservation is
    //     consumed via `markReservationUsageUnknown` (an unmeasured charge against the seat)
    //     and, because nothing reached the table, a retry is allowed.
    //  2. The DM switches the seat out of Driver DURING the backoff. `teardownSession` detaches
    //     this session object, so the post-sleep authority check terminates the retry as
    //     `stopped` and the turn leaves through the `session.detached` EARLY RETURN — a
    //     different exit from the one the accumulator's other consumers use.
    // Attempt 2 is scripted but must never run; if it does, the detach did not land in the
    // backoff window and this test is not exercising what it claims.
    h.script(
      { throwError: transient(), throwAfterChunks: 0 },
      { text: 'The torch steadies.', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
    );
    let switchedMode = false;
    setRetrySleepForTests(async () => {
      if (switchedMode) return;
      switchedMode = true;
      const off = await h.configureSeat(campaignId, { mode: 'off' });
      expect(off.status).toBe(200);
    });

    let res: Awaited<ReturnType<typeof h.sendMessage>>;
    let events: CampaignEvent[];
    try {
      ({ result: res, events } = await withStream(campaignId, () =>
        h.sendMessage(campaignId, { input: 'I light the torch.' }),
      ));
    } finally {
      setRetrySleepForTests(async () => {});
    }

    expect(switchedMode).toBe(true);
    expect(res.status).toBe(201);
    // Proves the turn really left by the detached early return rather than the normal exit.
    expect(res.body.stopReason).toBe('aborted');

    // The seat was charged an amount nobody could measure, and then the turn ended on a path
    // that reported no opinion about measurement at all. Silence is not neutral here: the
    // omitted argument took `emitTurnEnd`'s `= false` default, which is the positive claim
    // "this total is exact" — made by a call site that never considered the question.
    expect(turnEnd(events)?.tokensUsageUnknown).toBe(true);
    // Both surfaces, because both are written by the offending call and both are where a DM
    // would read the token total.
    const ended = await endedRow(campaignId);
    expect(ended).toBeDefined();
    expect(ended!.payload.tokensUsageUnknown).toBe(true);
  });
});

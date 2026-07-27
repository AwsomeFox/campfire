import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import { AiDriverService, setRetrySleepForTests } from '../src/modules/ai-driver/ai-driver.service';
import { AiProviderError } from '../src/modules/ai-dm/providers/errors';

/**
 * #1052 review findings — what a retry loop owes the rest of the system.
 *
 * The retry loop had stopped being wrong about WHETHER to retry and started being wrong about
 * what it then reported. All three of these are cases where the loop did the right thing and
 * then described it inaccurately to something downstream: the stuck ladder, the seat's budget,
 * and grounding's provenance.
 */
const transient = () => new AiProviderError('transport', 'mock: connection reset mid-stream', { provider: 'mock' });

describe('ai-dm driver — retry loop reports accurately (#1052 review)', () => {
  let h: AiEvalHarness;
  /** Fires during the retry backoff, standing in for a human pressing something. */
  let duringBackoff: (() => void) | null = null;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-model' });
    await h.enableExperimental();
    setRetrySleepForTests(async () => {
      duringBackoff?.();
    });
  });

  beforeEach(() => {
    h.resetMock();
    duringBackoff = null;
  });

  afterAll(async () => {
    setRetrySleepForTests((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
    await h.close();
  });

  const armed = async (name: string): Promise<number> => {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    return campaignId;
  };
  const auditRows = async (campaignId: number): Promise<Array<{ action: string; detail: string }>> =>
    (await request(h.server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm)).body.items ??
    (await request(h.server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm)).body;

  it('a KILL during the backoff ends the turn as cancelled, not as a provider error', async () => {
    const campaignId = await armed('Kill During Backoff');
    const driver = h.ctx.app.get(AiDriverService);
    // Attempt 1 dies before a token reaches the table — retryable, so the loop schedules a
    // backoff. The operator kills the generation while it waits.
    h.script({ throwError: transient(), throwAfterChunks: 0 }, { text: 'never reached' });
    duringBackoff = () => driver.cancelGeneration(campaignId);

    const res = await h.sendMessage(campaignId, { input: 'I light the torch.' });
    expect(res.status).toBe(201);

    // THE BUG. The loop already broke out on the authority re-check — it just left `spend`
    // holding the previous attempt's provider_error, so an operator kill was reported as a
    // provider failure all the way down.
    expect(res.body.stopReason).toBe('cancelled');
    expect(res.body.stopReason).not.toBe('provider_error');

    // ...which put the table on the wrong recovery ladder: a provider-error stuck state offers
    // retry / continue-without-AI, none of which is the answer to "someone stopped this".
    const session = (await h.getDriverSession(campaignId)).body;
    expect(session.stuck?.reason).not.toBe('provider_error');

    const rows = await auditRows(campaignId);
    // The audit said `gave_up=attempts_exhausted` when nothing was exhausted — untrue about who
    // ended the turn, and the opposite of what an operator reading it back needs.
    expect(rows.some((r) => r.action === 'ai-dm.driver.provider_error')).toBe(false);
    const abandoned = rows.find((r) => r.action === 'ai-dm.driver.retry_abandoned');
    expect(abandoned).toBeDefined();
    expect(abandoned!.detail).toContain('gave_up=stopped');
    expect(abandoned!.detail).not.toContain('attempts_exhausted');
  });

  /**
   * #599 × #1052 — a SAFETY HOLD must reach a turn sitting in a retry backoff.
   *
   * New seam on both sides: the X-Card freeze (#599) and this branch's retry/failover loop both
   * go through `checkGenerationAuthority`, and neither existed when the other was written. The
   * failure this guards is the retry OUTLIVING the freeze — a backoff that sleeps on, then
   * issues attempt 2 against a table that has just asked play to stop. That is the one thing an
   * X-Card may never do, and a retry backoff is exactly where a stop control can be slept
   * through.
   *
   * `frozen`, not `cancelled`: `applySafetyHold` sets `state = 'paused'`, so `isFrozen` is true
   * when the authority check turns the aborted signal into a reason, and the ladder must offer
   * the freeze recovery rather than a provider-error retry.
   */
  it('a SAFETY HOLD during the backoff freezes the turn instead of the retry outliving it', async () => {
    const campaignId = await armed('Safety Hold During Backoff');
    const driver = h.ctx.app.get(AiDriverService);
    // Attempt 2 must never run — were the hold to miss the backoff window, this text would
    // become the turn's narration and the assertions below would be testing nothing.
    h.script({ throwError: transient(), throwAfterChunks: 0 }, { text: 'ATTEMPT TWO RAN' });
    duringBackoff = () => driver.applySafetyHold(campaignId, true);

    const res = await h.sendMessage(campaignId, { input: 'onward' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('frozen');
    expect(res.body.stopReason).not.toBe('provider_error');
    // The retry did not outlive the hold.
    expect(res.body.narration ?? '').not.toContain('ATTEMPT TWO RAN');

    // ...and the seat is actually held, not merely reported as such.
    const session = (await h.getDriverSession(campaignId)).body;
    expect(session.state).toBe('paused');
  });

  it('a PAUSE during the backoff ends the turn as frozen', async () => {
    const campaignId = await armed('Pause During Backoff');
    const driver = h.ctx.app.get(AiDriverService);
    h.script({ throwError: transient(), throwAfterChunks: 0 }, { text: 'never reached' });
    duringBackoff = () => driver.setPaused(campaignId, true);

    const res = await h.sendMessage(campaignId, { input: 'onward' });
    expect(res.status).toBe(201);
    // `frozen`, not `cancelled`: a pause is a deliberate freeze and the ladder distinguishes them.
    expect(res.body.stopReason).toBe('frozen');
  });

  it('a kill during the backoff terminates the wait promptly instead of serving it out', async () => {
    const campaignId = await armed('Kill Interrupts Backoff');
    const driver = h.ctx.app.get(AiDriverService);
    h.script({ throwError: transient(), throwAfterChunks: 0 }, { text: 'never reached' });

    // A backoff far longer than the real 2s cap, killed the instant it starts. `cancelGeneration`
    // promises to stop active generation IMMEDIATELY; a plain `await sleepMs(...)` could not
    // observe the stop until the whole delay had elapsed, so for up to two seconds the API made
    // a promise it did not keep — to the DM hitting kill during a retry storm, who most needs it.
    setRetrySleepForTests((ms) => {
      driver.cancelGeneration(campaignId);
      return new Promise((r) => setTimeout(r, Math.max(ms, 5_000)));
    });

    const started = Date.now();
    const res = await h.sendMessage(campaignId, { input: 'onward' });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('cancelled');
    // Racing the delay, not serving it: well under the 5s the hook would otherwise have slept.
    expect(elapsed).toBeLessThan(3_000);

    setRetrySleepForTests(async () => {
      duringBackoff?.();
    });
  });

  it('counts tokens an abandoned attempt already metered', async () => {
    const campaignId = await armed('Retry Token Accounting');
    // Attempt 1 emits its USAGE frame and then fails, with no text on the wire — so it meters a
    // real spend (a DB write against the seat) and is still retryable. Attempt 2 succeeds.
    h.script(
      { throwError: transient(), throwAfterUsage: true, streamTextDeltas: false, usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } },
      { text: 'The torch steadies.', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
    );

    const res = await h.sendMessage(campaignId, { input: 'I light the torch.' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');

    // `spend` is reassigned per attempt and only the last was summed, so the first attempt's
    // metered tokens vanished from the result while still having been charged to the seat.
    // The seat row and the turn result must agree about what the table spent.
    const spent = res.body.tokenBudget - res.body.budgetRemaining;
    expect(res.body.tokensUsed).toBe(spent);
    expect(res.body.tokensUsed).toBeGreaterThanOrEqual(50 + 25);

    // And the seat itself agrees.
    const seat = (await h.getSeat(campaignId)).body;
    expect(seat.tokensUsed).toBe(res.body.tokensUsed);
  });
});

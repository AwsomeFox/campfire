import { describe, expect, it } from '@jest/globals';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';
import { raceRead, streamAbortError } from '../../src/modules/ai-dm/providers/http';
import { linkAbortSignals, GENERATION_STOP_ABORT } from '../../src/modules/ai-driver/ai-driver.service';
import { decideStepRetry } from '../../src/modules/ai-driver/driver-retry';

/**
 * Issue #1052 — how a driver-side idle stall is CLASSIFIED, pinned end to end and deliberately
 * without the mock provider anywhere near it.
 *
 * This exists because the mock lied. `hangUntilAbort` produced a retryable timeout while the real
 * transport produced `retryable: false` for the same trigger, so the retry suite was green about
 * a path production never took. A fake that disagrees with the transport is not a weak test, it
 * is an inverted one — so the property gets pinned here, against the real functions, where a
 * future drift in either the fake or the transport has to break something.
 */
describe('driver idle-stall classification (#1052)', () => {
  /** The composite signal the driver actually hands the provider. */
  const linkedFrom = (abort: (ac: AbortController) => void) => {
    const generation = new AbortController();
    const idle = new AbortController();
    const linked = linkAbortSignals(generation.signal, idle.signal);
    abort(idle);
    return { linked, generation, idle };
  };

  it('carries the abort REASON across the linked signal', () => {
    const reason = new AiProviderError('timeout', 'AI provider stream idle for 30000ms', { provider: 'p' });
    const { linked } = linkedFrom((ac) => ac.abort(reason));
    // The composite used to abort with no argument, replacing this with a bare AbortError and
    // leaving every downstream classifier to guess.
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(reason);
  });

  it("classifies the driver's idle watchdog as a RETRYABLE timeout", async () => {
    const reason = new AiProviderError('timeout', 'AI provider stream idle for 30000ms', { provider: 'p' });
    const { linked } = linkedFrom((ac) => ac.abort(reason));

    const err = await raceRead(new Promise<never>(() => {}), {
      signal: linked.signal,
      idleTimeoutMs: 0,
      provider: 'p',
      onIdle: () => {},
    }).catch((e: unknown) => e as AiProviderError);

    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.kind).toBe('timeout');
    // THE BUG THIS FILE EXISTS FOR. `retryable: false` here vetoes both the retry and the
    // failover, so the silent idle stall — the case step-level retry is FOR — terminated as a
    // plain provider error in production while the suite said otherwise.
    expect(err.retryable).toBe(true);

    const decision = decideStepRetry({ error: err, attempt: 1, maxAttempts: 2, broadcastChars: 0, budgetRemaining: 10_000 });
    expect(decision.retry).toBe(true);
  });

  it('still classifies a stop control as NOT retryable', async () => {
    // A pause / kill / teardown aborts with a string reason. Those must never be retried — the
    // whole point was to stop — and preserving the reason must not weaken that.
    const { linked } = linkedFrom((ac) => ac.abort(GENERATION_STOP_ABORT));
    const err = await raceRead(new Promise<never>(() => {}), {
      signal: linked.signal,
      idleTimeoutMs: 0,
      provider: 'p',
      onIdle: () => {},
    }).catch((e: unknown) => e as AiProviderError);

    expect(err.retryable).toBe(false);
    const decision = decideStepRetry({ error: err, attempt: 1, maxAttempts: 2, broadcastChars: 0, budgetRemaining: 10_000 });
    expect(decision.retry).toBe(false);
    if (!decision.retry) expect(decision.reason).toBe('not_retryable');
  });

  it('an abort with no reason at all stays NOT retryable', async () => {
    const { linked } = linkedFrom((ac) => ac.abort());
    const err = await raceRead(new Promise<never>(() => {}), {
      signal: linked.signal,
      idleTimeoutMs: 0,
      provider: 'p',
      onIdle: () => {},
    }).catch((e: unknown) => e as AiProviderError);
    expect(err.retryable).toBe(false);
  });

  it("the transport's OWN idle timer stays retryable, and agrees with the watchdog", async () => {
    // Both deadlines are the same value in production, so which fires first is a real race.
    // They have to give the same answer or the outcome is a coin flip.
    const err = await raceRead(new Promise<never>(() => {}), {
      idleTimeoutMs: 5,
      provider: 'p',
      onIdle: () => {},
    }).catch((e: unknown) => e as AiProviderError);
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('streamAbortError is the single classifier the fake and the transport share', () => {
    // The mock now calls this exact function, so it cannot drift from production again without
    // production changing too.
    const structured = new AiProviderError('rate_limit', 'slow down', { provider: 'p' });
    const ac = new AbortController();
    ac.abort(structured);
    expect(streamAbortError(ac.signal, 'mock')).toBe(structured);

    const plain = new AbortController();
    plain.abort('generation_stop');
    expect(streamAbortError(plain.signal, 'mock').retryable).toBe(false);
  });
});

import {
  decideStepRetry,
  DRIVER_STEP_PRIMARY_ATTEMPTS,
  DRIVER_STEP_RETRY,
  ERROR_KIND_RETRY,
  isSafetyErrorKind,
  maxStepAttempts,
  providerForAttempt,
} from '../../src/modules/ai-driver/driver-retry';
import { AiProviderError, type AiErrorKind } from '../../src/modules/ai-dm/providers/errors';

/**
 * #1052 — the pure half of transient-failure retry + provider failover.
 *
 * The substance here is the ORDER of the guards, not the individual booleans. Safety before
 * anything, then table-visible consequences, then affordability, then the mechanical attempt
 * count. Each of those is asserted against a context where every LATER guard would also have
 * refused, so a test can only pass for the stated reason.
 */

function err(kind: AiErrorKind, opts: { retryable?: boolean; retryAfterMs?: number } = {}): AiProviderError {
  return new AiProviderError(kind, `${kind} happened`, { provider: 'mock', ...opts });
}

function ctx(over: Partial<Parameters<typeof decideStepRetry>[0]> = {}) {
  return {
    error: err('server'),
    attempt: 1,
    maxAttempts: 2,
    broadcastChars: 0,
    budgetRemaining: 10_000,
    ...over,
  };
}

// Deterministic jitter so delays are exact.
const noJitter = () => 1;

describe('error-kind retry disposition (#1052)', () => {
  it('classifies every provider error kind exactly once', () => {
    // The map is `Record<AiErrorKind, …>`, so this list going stale is a compile error at the
    // map itself. Restating it here makes the intent legible.
    expect(Object.keys(ERROR_KIND_RETRY).sort()).toEqual(
      ['auth', 'content_filter', 'context_length', 'invalid_request', 'rate_limit', 'server', 'timeout', 'transport', 'unknown'].sort(),
    );
  });

  it('retries only the four transient kinds', () => {
    const retried = (Object.keys(ERROR_KIND_RETRY) as AiErrorKind[]).filter((k) => ERROR_KIND_RETRY[k] === 'retry');
    expect(retried.sort()).toEqual(['rate_limit', 'server', 'timeout', 'transport']);
  });

  it('fails closed on `unknown` — an error we cannot reason about is not re-issued', () => {
    expect(ERROR_KIND_RETRY.unknown).toBe('give_up');
    expect(decideStepRetry(ctx({ error: err('unknown') }), DRIVER_STEP_RETRY, noJitter)).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
  });
});

describe('a safety refusal is NEVER retried (#1052 × #598)', () => {
  it('refuses a content_filter error even when everything else says retry', () => {
    const decision = decideStepRetry(
      ctx({ error: err('content_filter'), attempt: 1, maxAttempts: 3, broadcastChars: 0, budgetRemaining: 1_000_000 }),
      DRIVER_STEP_RETRY,
      noJitter,
    );
    expect(decision).toEqual({ retry: false, reason: 'safety' });
  });

  it('refuses it even when the ERROR ITSELF claims to be retryable', () => {
    // `AiProviderError.retryable` is a constructor-overridable boolean, so an adapter can
    // hand us `content_filter` marked retryable — today, with no type error. A policy that
    // consulted that flag first would re-send a prompt the provider just declined, burning
    // the table's budget asking a safety system the same question until it relents.
    const decision = decideStepRetry(
      ctx({ error: err('content_filter', { retryable: true }) }),
      DRIVER_STEP_RETRY,
      noJitter,
    );
    expect(decision).toEqual({ retry: false, reason: 'safety' });
  });

  it('reports content_filter as a safety kind, and transient kinds as not', () => {
    expect(isSafetyErrorKind('content_filter')).toBe(true);
    for (const kind of ['server', 'rate_limit', 'timeout', 'transport', 'auth'] as AiErrorKind[]) {
      expect(isSafetyErrorKind(kind)).toBe(false);
    }
  });

  it('never fails over a refusal to a second provider either', () => {
    // Failover is reached only through a `retry: true` decision, so a refusal that can never
    // produce one can never reach the fallback. Pinned explicitly because "ask a different
    // vendor the same question" is the exact bypass this must not enable.
    for (let attempt = 1; attempt <= maxStepAttempts(true); attempt++) {
      expect(decideStepRetry(ctx({ error: err('content_filter'), attempt, maxAttempts: 3 }), DRIVER_STEP_RETRY, noJitter)).toEqual({
        retry: false,
        reason: 'safety',
      });
    }
  });
});

describe('deterministic failures are not re-issued (#1052)', () => {
  it.each<[AiErrorKind]>([['auth'], ['invalid_request'], ['context_length'], ['unknown']])(
    'gives up on %s',
    (kind) => {
      expect(decideStepRetry(ctx({ error: err(kind) }), DRIVER_STEP_RETRY, noJitter)).toEqual({
        retry: false,
        reason: 'not_retryable',
      });
    },
  );

  it('honours an adapter marking a normally-transient kind non-retryable', () => {
    // The Record is the authority for what MAY be retried; `error.retryable` is only ever a
    // narrowing veto on top of it. A stop-control abort arrives as a non-retryable `timeout`
    // and must not be mistaken for a stalled provider.
    expect(decideStepRetry(ctx({ error: err('timeout', { retryable: false }) }), DRIVER_STEP_RETRY, noJitter)).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
  });
});

describe('a retry must never re-narrate (#1052)', () => {
  it('gives up as soon as ANY narration has reached the table', () => {
    const decision = decideStepRetry(ctx({ broadcastChars: 1 }), DRIVER_STEP_RETRY, noJitter);
    expect(decision).toEqual({ retry: false, reason: 'already_broadcast' });
  });

  it('retries a transient failure that produced no visible output', () => {
    // The failures the HTTP layer structurally cannot cover — connect-then-die, an idle
    // timeout before the first token — land here, and they are exactly the ones with nothing
    // on the wire yet.
    const decision = decideStepRetry(ctx({ broadcastChars: 0 }), DRIVER_STEP_RETRY, noJitter);
    expect(decision).toMatchObject({ retry: true, attempt: 2 });
  });

  it('ranks the broadcast check ABOVE the attempt count', () => {
    // Both would refuse; the reason must be the one a human can act on.
    const decision = decideStepRetry(
      ctx({ broadcastChars: 50, attempt: 9, maxAttempts: 2 }),
      DRIVER_STEP_RETRY,
      noJitter,
    );
    expect(decision).toEqual({ retry: false, reason: 'already_broadcast' });
  });
});

describe('retries cost tokens, so the budget gate outranks the attempt count (#1052)', () => {
  it('refuses to spend a budget that is already gone', () => {
    const decision = decideStepRetry(ctx({ budgetRemaining: 0, attempt: 1, maxAttempts: 3 }), DRIVER_STEP_RETRY, noJitter);
    expect(decision).toEqual({ retry: false, reason: 'budget_exhausted' });
  });

  it('refuses on a negative remainder too (an over-spend already happened)', () => {
    expect(decideStepRetry(ctx({ budgetRemaining: -5 }), DRIVER_STEP_RETRY, noJitter)).toEqual({
      retry: false,
      reason: 'budget_exhausted',
    });
  });
});

describe('attempt budget and backoff (#1052)', () => {
  it('allows one retry against the primary, and one more only when a fallback exists', () => {
    expect(maxStepAttempts(false)).toBe(DRIVER_STEP_PRIMARY_ATTEMPTS);
    expect(maxStepAttempts(true)).toBe(DRIVER_STEP_PRIMARY_ATTEMPTS + 1);
  });

  it('stops after the final attempt', () => {
    expect(decideStepRetry(ctx({ attempt: 2, maxAttempts: 2 }), DRIVER_STEP_RETRY, noJitter)).toEqual({
      retry: false,
      reason: 'attempts_exhausted',
    });
  });

  it('exhausts the primary before touching the fallback', () => {
    // Failover is a last resort, not load balancing: a one-off blip must be absorbed by the
    // provider the DM actually chose rather than quietly moving the table to another model
    // mid-scene.
    expect(providerForAttempt(1, true)).toBe('primary');
    expect(providerForAttempt(DRIVER_STEP_PRIMARY_ATTEMPTS, true)).toBe('primary');
    expect(providerForAttempt(DRIVER_STEP_PRIMARY_ATTEMPTS + 1, true)).toBe('fallback');
  });

  it('never routes to a fallback that is not configured', () => {
    for (let attempt = 1; attempt <= 5; attempt++) expect(providerForAttempt(attempt, false)).toBe('primary');
  });

  it('backs off exponentially, bounded by maxDelayMs', () => {
    const first = decideStepRetry(ctx({ attempt: 1 }), DRIVER_STEP_RETRY, noJitter);
    const second = decideStepRetry(ctx({ attempt: 2, maxAttempts: 3 }), DRIVER_STEP_RETRY, noJitter);
    expect(first).toMatchObject({ retry: true, delayMs: DRIVER_STEP_RETRY.baseDelayMs });
    expect(second).toMatchObject({ retry: true, delayMs: DRIVER_STEP_RETRY.baseDelayMs * 2 });
    for (let attempt = 1; attempt < 20; attempt++) {
      const d = decideStepRetry(ctx({ attempt, maxAttempts: 100 }), DRIVER_STEP_RETRY, noJitter);
      expect(d.retry && d.delayMs).toBeLessThanOrEqual(DRIVER_STEP_RETRY.maxDelayMs);
    }
  });

  it('honours a provider Retry-After, capped so a hostile header cannot park the seat', () => {
    const polite = decideStepRetry(ctx({ error: err('rate_limit', { retryAfterMs: 900 }) }), DRIVER_STEP_RETRY, noJitter);
    expect(polite).toMatchObject({ retry: true, delayMs: 900 });

    const hostile = decideStepRetry(
      ctx({ error: err('rate_limit', { retryAfterMs: 60 * 60_000 }) }),
      DRIVER_STEP_RETRY,
      noJitter,
    );
    expect(hostile).toMatchObject({ retry: true, delayMs: DRIVER_STEP_RETRY.maxDelayMs });
  });

  it('keeps the driver backoff short, because it STACKS on the HTTP layer’s own retries', () => {
    // providers/http.ts already spends up to 2 backoffs of its own underneath every attempt,
    // and the driver's idle watchdog bounds each attempt on top. A long delay here turns a
    // blip into dead air in front of a player whose composer is locked.
    expect(DRIVER_STEP_RETRY.maxDelayMs).toBeLessThanOrEqual(2000);
    expect(DRIVER_STEP_RETRY.baseDelayMs).toBeLessThanOrEqual(500);
  });
});

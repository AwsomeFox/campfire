/**
 * Transient-failure retry + provider failover policy for the AI driver (issue #1052).
 *
 * ── What was actually missing ─────────────────────────────────────────────────────────
 * Not "retry" in general — `postJson` (providers/http.ts) has retried 429/5xx/transport/
 * timeout with exponential backoff, jitter, and `Retry-After` since #309. What it CANNOT
 * retry is the class of failure that happens after the response headers arrive: the POST
 * has returned, bytes are flowing, and the connection resets or goes silent. From that
 * point the only thing that can retry is something that knows how to re-issue the whole
 * STEP — which is the driver. There was also no second provider to fail over to, so a
 * primary that was simply down ended every turn as `provider_error`.
 *
 * ── The two hard boundaries ───────────────────────────────────────────────────────────
 *
 * 1. A SAFETY REFUSAL IS NEVER A TRANSIENT FAULT. Re-sending a prompt a provider just
 *    declined is not resilience: it is asking a safety system the same question until it
 *    gives a different answer, and it burns the table's token budget doing it.
 *    {@link ERROR_KIND_RETRY} is an EXHAUSTIVE `Record<AiErrorKind, …>` rather than a Set
 *    or an `includes`, because a subset check fails OPEN — a future error kind would
 *    silently inherit "retryable" and the first thing to slip through would be a refusal.
 *    The safety kinds are then checked BEFORE `AiProviderError.retryable`, because that
 *    flag is a constructor-overridable boolean (`new AiProviderError('content_filter', …,
 *    { retryable: true })` compiles today) and a policy that trusts it can be talked into
 *    retrying a refusal by any adapter.
 *
 * 2. A RETRY MUST NEVER RE-NARRATE. Narration streams to every player as it is generated.
 *    If a step dies after some prose has already reached the table, re-issuing it produces
 *    a SECOND, different reply — the table watches the DM say two different things about
 *    the same moment, with no indication which one counts. So the policy retries only
 *    while nothing has been broadcast. That is not as narrow as it sounds: the failures
 *    the HTTP layer cannot cover (connect-then-die, idle-timeout before first token,
 *    upstream reset during the preamble) overwhelmingly produce zero deltas. Once prose is
 *    out, the turn ends as `provider_error` and the HUMAN retry lever on the stuck ladder
 *    decides — a person choosing to replace what they saw is a different act from the
 *    server silently doing it behind them.
 *
 * ── Interaction with issue #598 (provider refusals as withheld turns) ─────────────────
 * These compose the right way round. #598 adds a trailing quarantine window on the delta
 * path, so a short reply has broadcast NOTHING when a mid-stream fault hits — which makes
 * strictly more failures safely retryable under boundary 2, not fewer. And #598's safety
 * terminal states arrive as a finish reason on a SUCCESSFUL stream, never as a thrown
 * `AiProviderError`, so they never reach this policy at all; the `content_filter` kind
 * here is the separate case of a provider rejecting the REQUEST on safety grounds. Both
 * are `give_up`, from opposite directions.
 */

import type { AiErrorKind, AiProviderError } from '../ai-dm/providers/errors';
import { backoffDelayMs, type RetryConfig } from '../ai-dm/providers/http';

/** Whether a failed step may be re-issued. */
export type RetryDisposition = 'retry' | 'give_up';

/**
 * The single decision table for "is this failure transient?".
 *
 * EXHAUSTIVE BY CONSTRUCTION — see the file header. Do not replace with a Set, an array
 * `.includes`, or a chain of `===`: all three accept a subset, and the failure mode of a
 * subset here is a retry loop that re-sends prompts a provider refused.
 */
export const ERROR_KIND_RETRY: Record<AiErrorKind, RetryDisposition> = {
  // Bad credentials need an operator, not another attempt — and retrying an expired key
  // against a rate-limited endpoint is how a 401 becomes a 429.
  auth: 'give_up',
  rate_limit: 'retry',
  // The prompt does not fit. Re-sending the same prompt cannot make it fit.
  context_length: 'give_up',
  // SAFETY. The provider rejected the REQUEST on content grounds. Never retried, never
  // failed over to a second provider — "ask a different vendor the same question until one
  // answers" is a safety bypass with extra steps.
  content_filter: 'give_up',
  transport: 'retry',
  timeout: 'retry',
  // A request the provider called malformed. Deterministic; it will be malformed again.
  invalid_request: 'give_up',
  server: 'retry',
  // Unclassified. Fail closed: an error we cannot reason about is not one we should
  // re-issue on the table's budget.
  unknown: 'give_up',
};

/**
 * Which error kinds represent a SAFETY decision rather than a fault. Checked ahead of
 * everything else, including `AiProviderError.retryable`.
 *
 * EXHAUSTIVE OVER `AiErrorKind` ON PURPOSE, and it has to be spelled this way to mean anything.
 * This was previously `Record<Extract<AiErrorKind, 'content_filter'>, true>` with a comment
 * claiming that adding a safety kind would be a compile error here. It would not have been:
 * `Extract` narrows the key set to exactly what is named, so a new member of `AiErrorKind`
 * changes that type not at all and the omission stays silent. In a file whose entire job is
 * load-bearing type boundaries, a comment claiming a guarantee that does not exist is worse
 * than no comment — it is the reason a reviewer stops checking.
 *
 * Keyed over the FULL union with a boolean, the guarantee is real: add a kind to `AiErrorKind`
 * and this object fails to compile until someone decides, explicitly, whether it is a safety
 * refusal. That is the same shape as {@link ERROR_KIND_RETRY} directly above, and the decision
 * is the one that must not be defaulted — a safety kind mistakenly classified as a fault gets
 * retried, and retrying a content refusal until a provider relents is a safety bypass.
 */
export const SAFETY_ERROR_KINDS: Record<AiErrorKind, boolean> = {
  auth: false,
  rate_limit: false,
  context_length: false,
  // The provider rejected the REQUEST on content grounds. Never retried, never failed over.
  content_filter: true,
  transport: false,
  timeout: false,
  invalid_request: false,
  server: false,
  unknown: false,
};

export function isSafetyErrorKind(kind: AiErrorKind): boolean {
  return SAFETY_ERROR_KINDS[kind] === true;
}

/**
 * Driver-level backoff. Deliberately SHORTER than {@link DEFAULT_RETRY} in providers/http.ts:
 * by the time a failure reaches this policy the HTTP layer has usually already spent its own
 * two backoffs, so these delays STACK on top of that. A player is sitting in front of a
 * composer that is locked while this happens, and the driver's own idle watchdog
 * (`DRIVER_STREAM_IDLE_TIMEOUT_MS`, 30s) bounds each attempt on top again. Long backoff here
 * would turn a blip into a minute of dead air, which is not better than an honest failure.
 */
export const DRIVER_STEP_RETRY: RetryConfig = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000 };

/**
 * Attempts per step against the PRIMARY provider (1 initial + 1 retry). A configured
 * fallback provider adds exactly one more attempt — see {@link maxStepAttempts}.
 *
 * Two is deliberate. Three attempts against a provider that has already failed twice buys
 * little (the HTTP layer's own retries are underneath each of these) and costs the table
 * both latency and tokens, since a provider that streamed anything before dying has already
 * billed for it.
 */
export const DRIVER_STEP_PRIMARY_ATTEMPTS = 2;

/** Total attempts for one step: primary attempts, plus one on the fallback when configured. */
export function maxStepAttempts(hasFallback: boolean): number {
  return DRIVER_STEP_PRIMARY_ATTEMPTS + (hasFallback ? 1 : 0);
}

/** Why a failed step was not re-issued — surfaced in audit so the choice is inspectable. */
export type RetryRefusalReason =
  /** A provider content refusal. Never retried. */
  | 'safety'
  /** The error kind is deterministic (auth / invalid_request / context_length / unknown). */
  | 'not_retryable'
  /** Attempts for this step are used up. */
  | 'attempts_exhausted'
  /** Prose already reached the table; a silent re-narration would contradict it. */
  | 'already_broadcast'
  /** No budget left to pay for another attempt. */
  | 'budget_exhausted'
  /**
   * #1052 — a stop control (pause, kill, takeover, mode-switch detach) landed during the backoff.
   *
   * NOT `attempts_exhausted`, which is what this used to be recorded as. Attempts were not
   * exhausted; a human stopped the table. Conflating them tells the audit trail something untrue
   * about who ended the turn, and the two call for opposite responses from whoever reads it.
   */
  | 'stopped';

export interface StepAttemptContext {
  error: AiProviderError;
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempts allowed for this step (see {@link maxStepAttempts}). */
  maxAttempts: number;
  /**
   * Characters of narration this step already put on the wire. NOT the characters the model
   * generated: with #598's quarantine window in play those differ, and it is what the TABLE
   * SAW that decides whether a silent retry would contradict something.
   */
  broadcastChars: number;
  /** Campaign token budget left after settling the failed attempt. */
  budgetRemaining: number;
}

export type StepRetryDecision =
  | { retry: false; reason: RetryRefusalReason }
  | { retry: true; delayMs: number; attempt: number };

/**
 * Decide whether a failed provider step may be re-issued, and after how long.
 *
 * Pure and deterministic given `rand`, so the ordering of the guards is directly testable —
 * and the ordering is the substance here. Safety first, then table-visible consequences,
 * then affordability, then the mechanical attempt count.
 */
export function decideStepRetry(
  ctx: StepAttemptContext,
  cfg: RetryConfig = DRIVER_STEP_RETRY,
  rand: () => number = Math.random,
): StepRetryDecision {
  // 1. SAFETY, ahead of `error.retryable` — see the file header for why that flag is not
  //    trusted as the authority.
  if (isSafetyErrorKind(ctx.error.kind)) return { retry: false, reason: 'safety' };

  // 2. Deterministic failures. The Record is the authority; `error.retryable` is only
  //    consulted as a NARROWING veto, so an adapter may mark something non-retryable that
  //    this table would otherwise retry, but never the reverse.
  if (ERROR_KIND_RETRY[ctx.error.kind] !== 'retry') return { retry: false, reason: 'not_retryable' };
  if (!ctx.error.retryable) return { retry: false, reason: 'not_retryable' };

  // 3. Never silently re-narrate over something the table already read.
  if (ctx.broadcastChars > 0) return { retry: false, reason: 'already_broadcast' };

  // 4. A retry costs tokens; a table with an exhausted budget does not get to spend more
  //    of it on the server's initiative.
  if (ctx.budgetRemaining <= 0) return { retry: false, reason: 'budget_exhausted' };

  if (ctx.attempt >= ctx.maxAttempts) return { retry: false, reason: 'attempts_exhausted' };

  return {
    retry: true,
    attempt: ctx.attempt + 1,
    // `retryAfterMs` is honoured when the provider sent one (a 429 with Retry-After), capped
    // by maxDelayMs so a hostile or confused header cannot park the seat for an hour.
    delayMs: backoffDelayMs(ctx.attempt - 1, cfg, ctx.error.retryAfterMs, rand),
  };
}

/**
 * Which provider serves a given attempt.
 *
 * The primary gets {@link DRIVER_STEP_PRIMARY_ATTEMPTS} attempts before the fallback is
 * tried at all, so a one-off blip is absorbed by the provider the DM actually chose rather
 * than quietly moving the table onto a different model mid-scene. Failover is a last resort,
 * not load balancing.
 */
export function providerForAttempt(attempt: number, hasFallback: boolean): 'primary' | 'fallback' {
  return hasFallback && attempt > DRIVER_STEP_PRIMARY_ATTEMPTS ? 'fallback' : 'primary';
}

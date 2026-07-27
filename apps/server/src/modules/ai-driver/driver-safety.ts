/**
 * Provider refusals / content filters as WITHHELD TURNS (issue #598).
 *
 * ── The defect ────────────────────────────────────────────────────────────────────────
 * Every adapter already normalized a provider's safety signal onto `AiFinishReason`, and the
 * driver threw it away. A response that carried `content_filter` and no tool calls took the
 * same exit as a clean one: `stopReason = 'complete'`, narration committed, transcript row
 * written, seat healthy. On a mixed-age table that is unreviewed, partially-generated prose
 * arriving as an ordinary DM turn.
 *
 * ── Why this file is a `Record`, not a set of `if`s ───────────────────────────────────
 * {@link FINISH_REASON_DELIVERY} is an EXHAUSTIVE `Record<AiFinishReason, AiTurnDelivery>`,
 * the same pattern the persisted-enum allowlists in ai-driver.service.ts use and for the same
 * reason: a `Set` or a chain of `===` comparisons accepts a subset silently, so a future
 * `AiFinishReason` member would default to "deliverable" and re-open this hole without a
 * single test failing. With a Record, adding a member is a compile error HERE, at the one
 * place that decides whether players see the text.
 *
 * ── The streaming boundary ───────────────────────────────────────────────────────────
 * The hard part is not the decision, it is that the decision arrives LAST. Narration streams
 * token-by-token to every player; the finish reason lands after the final delta. Three
 * mechanisms, layered, each doing a different job:
 *
 *   1. COMMIT GATING (free, total). Deltas are ephemeral; the durable artifacts of a turn —
 *      `narration.message`, the #572 transcript row, the assistant message fed back into the
 *      next step, and every tool dispatch — all happen AFTER the stream ends, when the finish
 *      reason is already known. Gating those costs nothing and is absolute: a withheld turn
 *      never becomes table canon, never re-enters the model's context, never runs a tool.
 *
 *   2. QUARANTINE WINDOW ({@link NarrationQuarantine}). A fixed-size trailing delay line on
 *      the delta path. Text is broadcast only once {@link NARRATION_QUARANTINE_CHARS} further
 *      characters have arrived behind it, so the most recently generated prose is always still
 *      in the server's hands when the terminal frame lands. This is sized to the ACTUAL gap in
 *      both wire protocols — OpenAI reports `finish_reason` on the choice immediately after
 *      the content stops, Anthropic reports `stop_reason` in the `message_delta` immediately
 *      after the last `content_block_delta` — i.e. the offending span and the signal are
 *      separated by a handful of frames, not by the whole reply. It is a bounded mitigation,
 *      not a proof: a filter that fires long after the offending text still leaks that text.
 *
 *   3. RETRACTION (`narration.withheld`). For whatever escaped the window, the server tells
 *      clients to drop the in-progress bubble. This is honestly the weakest of the three —
 *      you cannot un-read a sentence — and it is here as cleanup for the residual, never as
 *      the primary defense. It also fixes a concrete bug: the web reducer commits any trailing
 *      live deltas on `turn.end`, so without an explicit retraction the withheld prose would
 *      be promoted into the client's permanent transcript by the very event that ends the turn.
 *
 * ── What this does NOT cover ─────────────────────────────────────────────────────────
 * This mechanism RELAYS a provider's signal. It does not classify content itself. A local or
 * self-hosted model with no safety layer (Ollama, llama.cpp, LM Studio, a bare vLLM endpoint)
 * will report `stop` for everything it generates, and nothing here will fire. That is stated
 * plainly in the operator docs; a filter that silently protects nothing is worse than no
 * filter, because the table believes it is covered.
 */

import type { AiFinishReason } from '../ai-dm/providers/ai-provider';

/** Whether a finished generation may reach the table at all. */
export type AiTurnDelivery = 'deliver' | 'withhold';

/**
 * The single decision table for "may this turn be delivered?".
 *
 * EXHAUSTIVE BY CONSTRUCTION — see the file header. Do not replace this with a Set, an array
 * `.includes`, or inline comparisons: all three accept a subset, and the failure mode of a
 * subset here is that new provider safety states are silently broadcast to players.
 */
export const FINISH_REASON_DELIVERY: Record<AiFinishReason, AiTurnDelivery> = {
  stop: 'deliver',
  length: 'deliver',
  tool_calls: 'deliver',
  // A provider that reported nothing usable is a reliability problem, not a safety one. The
  // existing stuck ladder (no_narration / provider_error) already covers it, and treating it
  // as a safety incident would drown the real ones.
  unknown: 'deliver',
  // The vendor's policy layer stopped the generation.
  content_filter: 'withhold',
  // The model itself declined.
  refusal: 'withhold',
};

/** The finish reasons that mean "this turn is withheld" — derived, never hand-listed. */
export type WithheldFinishReason = 'content_filter' | 'refusal';

/**
 * Is this a safety terminal state?
 *
 * Takes `AiFinishReason | undefined` because a stream can end with no `done` event at all
 * (an aborted or truncated body). Absence is NOT a refusal: that path is already classified
 * as `provider_error` / `no_narration` by the turn loop, and treating "we never heard" as a
 * safety incident would file incidents for every network blip.
 */
export function isWithheldFinishReason(
  reason: AiFinishReason | undefined,
): reason is WithheldFinishReason {
  return reason !== undefined && FINISH_REASON_DELIVERY[reason] === 'withhold';
}

/**
 * How much narration the server holds back from the live delta stream.
 *
 * Sized in CHARACTERS rather than milliseconds on purpose. A time-based window releases text
 * on a timer — i.e. it releases precisely when the model is generating slowly and the terminal
 * frame has not arrived yet, which is exactly the case it was supposed to cover. A character
 * window self-scales instead: the amount of unreviewed text in flight is constant regardless
 * of how fast the provider streams.
 *
 * 240 characters is roughly two sentences. At typical streaming rates (200–400 chars/s) the
 * table sees narration ~0.6–1.2s behind the model, which reads as the DM composing rather than
 * as lag, and the bubble still animates continuously. Larger buys more coverage and starts to
 * feel like buffering; smaller stops covering the multi-frame gap it exists for.
 */
export const NARRATION_QUARANTINE_CHARS = 240;

/**
 * The window actually in force. Mutable ONLY so tests can shrink it, exactly like
 * {@link DRIVER_STREAM_IDLE_TIMEOUT_MS} in ai-driver.service.ts — several existing e2e specs
 * intervene mid-stream (pause, kill switch, mode-switch teardown) by reacting to the FIRST
 * `narration.delta`, and a delay line means a short scripted reply emits no delta at all until
 * the stream ends. Those specs are testing stop controls, not this window; they set it to 0 and
 * say so. The window's own behaviour is covered by driver-safety.spec.ts and the #598 e2e suite.
 */
export let DRIVER_NARRATION_QUARANTINE_CHARS: number = NARRATION_QUARANTINE_CHARS;

/** Test-only: override {@link DRIVER_NARRATION_QUARANTINE_CHARS}. */
export function setNarrationQuarantineCharsForTests(chars: number): void {
  DRIVER_NARRATION_QUARANTINE_CHARS = chars;
}

/**
 * A fixed-size trailing delay line for narration deltas (#598).
 *
 * Composes with — deliberately does not replace — the #577 {@link GroundingDeltaFilter}:
 * that one strips protocol framing out of the visible stream, this one delays what is left.
 * The driver pipes raw delta → grounding filter → quarantine → SSE, one interceptor chain,
 * so there is exactly one place where a byte becomes visible to the table.
 *
 * Stateful but pure-in/pure-out and dependency-free, so it is unit-testable on its own.
 */
export class NarrationQuarantine {
  private buffer = '';
  private readonly windowChars: number;

  /**
   * @param windowChars characters to hold back; defaults to the currently-in-force
   *   {@link DRIVER_NARRATION_QUARANTINE_CHARS}. `0` disables the delay line entirely
   *   (pass-through), leaving only the commit-gating and retraction layers.
   */
  constructor(windowChars: number = DRIVER_NARRATION_QUARANTINE_CHARS) {
    this.windowChars = windowChars;
  }

  /** Feed narration; returns the prefix that is now old enough to broadcast (may be ''). */
  push(text: string): string {
    if (this.windowChars <= 0) return text;
    if (!text) return '';
    this.buffer += text;
    if (this.buffer.length <= this.windowChars) return '';
    const cut = this.buffer.length - this.windowChars;
    const release = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return release;
  }

  /** Release everything still held — the stream ended and the turn is deliverable. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }

  /** Drop everything still held and report how much was dropped — the turn was withheld. */
  discard(): number {
    const dropped = this.buffer.length;
    this.buffer = '';
    return dropped;
  }

  /** Characters currently held back (diagnostics / tests). */
  get held(): number {
    return this.buffer.length;
  }
}

/**
 * What one withheld step is recorded as (#598).
 *
 * PRIVACY-MINIMIZED BY CONSTRUCTION — there is no field for the text, and that is the design,
 * not an omission. Copying the filtered prose into an audit table "so a DM can review it"
 * takes content the provider just refused to stand behind and gives it a longer-lived,
 * exportable home than the live stream it was kept off. Lengths answer the questions an
 * operator actually has (did any of it reach the table? how much? which provider/model/turn?
 * did it come packaged with tool calls?) without recreating the exposure. There is no hash of
 * the text either: a digest of a short passage is a guessable commitment, so it would be
 * storing the content with extra steps.
 */
export interface WithheldTurnIncident {
  campaignId: number;
  /**
   * Session turn counter for the withheld turn — the SAME value `session.stuck.turn` carries,
   * so a DM can line the incident trail up against the ladder.
   *
   * That correlation is only true because the incident is persisted after the turn loop's
   * `finally` has incremented the counter, exactly where the stuck record is written. Recording
   * it from inside the loop reads the counter one increment early and puts every pair off by
   * one; see the `withheldTurn` deferral in ai-driver.service.ts.
   */
  turn: number;
  /** Which tool-loop step of the turn was withheld (1-based). */
  step: number;
  finishReason: WithheldFinishReason;
  /** Provider NAME only — never a key, base URL, or header (same rule as #577's provenance). */
  provider: string;
  /** The model id that actually served the request. */
  model: string;
  /**
   * Characters still held by the quarantine delay line when the refusal landed, and therefore
   * never broadcast. Length only, never content.
   *
   * BOUNDED BY {@link NARRATION_QUARANTINE_CHARS}, which is what it actually measures: on a
   * refused reply longer than the window this is the tail the delay line caught at the cut-off,
   * NOT the size of the refusal. A small number here on a long refusal means most of the reply
   * had already aged out and been broadcast — which is what {@link releasedChars} says, and why
   * that is the field to read first.
   */
  withheldChars: number;
  /**
   * Characters that had already been broadcast when the terminal frame arrived — the residual
   * exposure the quarantine window did not cover. This is the number that says whether the
   * mitigation worked for this incident, so it is the one number worth keeping.
   */
  releasedChars: number;
  /** Tool calls the same response carried. None were dispatched; this is how many were stopped. */
  suppressedToolCalls: number;
  /**
   * The member whose action provoked the turn, or null for a proactive/system turn.
   *
   * Kept because "enough to act on it" means a DM can see that refusals cluster on one
   * player's inputs — which is a moderation signal at a mixed-age table. It is an id, not the
   * text they typed, and the same id is already in the audit log for every other driver event.
   */
  triggeredByUserId: string | null;
}

/**
 * The neutral, player-facing line for a withheld turn.
 *
 * Deliberately says nothing about WHAT was withheld. Describing the refused content — even
 * vaguely, even as a category — hands the table the information the withhold exists to keep
 * from them, and invites the "what did it say?" conversation in front of the whole table. It
 * names the mechanism, states plainly that nothing was posted, and points at the levers.
 */
export function describeWithheldTurn(reason: WithheldFinishReason): string {
  const cause =
    reason === 'content_filter'
      ? 'The AI provider’s safety filter stopped this reply'
      : 'The AI declined to answer this one';
  return `${cause}, so it was withheld before it reached the table — nothing was posted or saved. The table can retry, nudge with different framing, or continue without the AI.`;
}

import { expect, test } from '@playwright/test';
import type { AiDmTranscriptEvent } from '@campfire/schema';
import { parseAiDmStreamEvent } from './util';
import {
  dmEntryText,
  emptyTranscript,
  transcriptReducer,
  type DmEntry,
  type SystemEntry,
  type TranscriptState,
} from '../../src/features/ai-dm/transcript';

/**
 * Issue #598 — the client half of "a provider refusal is a withheld turn".
 *
 * The client-side bug this closes is concrete and easy to miss: the reducer commits any
 * trailing LIVE deltas into `committed` when `turn.end` arrives. So on a withheld turn, prose
 * that had already streamed would be promoted out of an ephemeral buffer and into this table's
 * permanent transcript by the very event that ends the turn — the server withholding it after
 * the fact would achieve nothing. `narration.withheld` must clear that buffer first.
 */

const at = '2026-07-26T10:00:00.000Z';
const UNSAFE = 'THIS_MUST_NOT_PERSIST';

function apply(state: TranscriptState, ...events: unknown[]): TranscriptState {
  return events.reduce<TranscriptState>((acc, raw) => {
    const event = parseAiDmStreamEvent(raw);
    if (!event) throw new Error(`frame rejected by the parser: ${JSON.stringify(raw)}`);
    return transcriptReducer(acc, { type: 'stream', event });
  }, state);
}

const turnStart = { type: 'turn.start', campaignId: 1, at };
const delta = (text: string) => ({ type: 'narration.delta', campaignId: 1, text, at });
const withheld = {
  type: 'narration.withheld',
  campaignId: 1,
  reason: 'content_filter',
  message: 'The AI provider’s safety filter stopped this reply, so it was withheld.',
  at,
};
const turnEnd = {
  type: 'turn.end',
  campaignId: 1,
  stopReason: 'content_withheld',
  steps: 1,
  tokensUsed: 12,
  budgetRemaining: 100,
  at,
};

test('narration.withheld drops live deltas so turn.end cannot commit them', () => {
  const state = apply(emptyTranscript, turnStart, delta(UNSAFE), withheld, turnEnd);
  const bubble = state.entries.find((e): e is DmEntry => e.kind === 'dm');
  expect(bubble).toBeTruthy();
  expect(dmEntryText(bubble!)).toBe('');
  expect(JSON.stringify(state)).not.toContain(UNSAFE);
  // The turn is still CLOSED — the bubble must not sit spinning forever.
  expect(bubble!.status).toBe('done');
  expect(bubble!.meta?.stopReason).toBe('content_withheld');
});

test('turn.end DOES commit trailing deltas normally (regression guard)', () => {
  // The control for every "nothing was committed" assertion above: proves the deltas really
  // were buffered and really would have landed, so those tests cannot start passing for the
  // wrong reason (e.g. deltas silently never reaching the bubble at all).
  //
  // Deliberately a NON-withheld stop reason. This used to reuse the withheld `turnEnd` and
  // relied on the retraction being the only thing standing between the buffer and the
  // transcript — which stopped being true once the commit itself learned to refuse a
  // `content_withheld` turn. Keeping the old framing would have made this a test of the
  // hole rather than of the buffering.
  const state = apply(emptyTranscript, turnStart, delta(UNSAFE), { ...turnEnd, stopReason: 'complete' });
  const bubble = state.entries.find((e): e is DmEntry => e.kind === 'dm');
  expect(dmEntryText(bubble!)).toContain(UNSAFE);
});

test('shows a neutral withheld line that never describes the withheld content', () => {
  const state = apply(emptyTranscript, turnStart, delta('some prose'), withheld);
  const line = state.entries.find((e): e is SystemEntry => e.kind === 'system');
  expect(line?.variant).toBe('withheld');
  expect(line?.text).toBe(withheld.message);
  expect(line?.data?.reason).toBe('content_filter');
});

test('on an authoritative surface the line comes from the durable row, but the buffer is STILL cleared', () => {
  // #572 surfaces render the persisted `control` row, so folding a client-side line too would
  // print it twice. The retraction itself is not optional there: only this frame can clear an
  // ephemeral delta buffer, which was never persisted anywhere to be corrected by a REST page.
  const authoritative = transcriptReducer(emptyTranscript, { type: 'authoritative' });
  const state = apply(authoritative, turnStart, delta(UNSAFE), withheld);
  expect(state.entries.some((e) => e.kind === 'system')).toBe(false);
  const bubble = state.entries.find((e): e is DmEntry => e.kind === 'dm');
  expect(dmEntryText(bubble!)).toBe('');
});

const stuckWithheld = {
  type: 'stuck',
  campaignId: 1,
  reason: 'content_withheld',
  detail: 'The AI provider’s safety filter stopped this reply, so it was withheld.',
  state: 'awaiting_players',
  levers: ['retry', 'nudge', 'continue_without_ai'],
  at,
};

test('a withheld turn prints ONE system line on a thin surface, not a second "got stuck" one', () => {
  // The server emits `narration.withheld` and then, moments later, a `stuck` frame with reason
  // `content_withheld` — a withheld turn joins the existing ladder rather than getting a
  // parallel one. Authoritative surfaces early-return on `stuck` and render the durable row, so
  // the table view was always right. The NON-authoritative surfaces (dashboard activity chip,
  // encounter driver dock, player display) fold both, and printed "The AI DM got stuck" under
  // the withheld line — blaming the table's AI for failing when it had actually declined.
  const state = apply(emptyTranscript, turnStart, delta(UNSAFE), withheld, stuckWithheld, turnEnd);
  const system = state.entries.filter((e): e is SystemEntry => e.kind === 'system');
  expect(system).toHaveLength(1);
  expect(system[0].variant).toBe('withheld');
  expect(state.entries.some((e) => e.kind === 'system' && e.variant === 'stuck')).toBe(false);
});

test('a client that joins between the two frames still gets the line, under the withheld variant', () => {
  // Suppressing the stuck frame outright would leave this client with no line at all. It is
  // folded under `withheld` instead, so the wording is right no matter which frame arrives.
  const state = apply(emptyTranscript, stuckWithheld);
  const system = state.entries.filter((e): e is SystemEntry => e.kind === 'system');
  expect(system).toHaveLength(1);
  expect(system[0].variant).toBe('withheld');
  expect(system[0].data?.reason).toBe('content_withheld');
});

test('every OTHER stuck reason still renders as stuck', () => {
  // The dedupe is scoped to the one reason that has its own retraction frame. A genuine
  // provider failure must keep saying so.
  const state = apply(emptyTranscript, { ...stuckWithheld, reason: 'provider_error' });
  const system = state.entries.filter((e): e is SystemEntry => e.kind === 'system');
  expect(system).toHaveLength(1);
  expect(system[0].variant).toBe('stuck');
});

test('two withheld turns in one session each get their own line', () => {
  // The dedupe checks the TAIL entry, not the whole transcript — a second refusal later in the
  // session must not be swallowed because an earlier one is still in the log.
  const once = apply(emptyTranscript, turnStart, withheld, stuckWithheld, turnEnd);
  const twice = apply(once, turnStart, withheld, stuckWithheld, turnEnd);
  const system = twice.entries.filter((e): e is SystemEntry => e.kind === 'system');
  expect(system).toHaveLength(2);
  expect(system.every((e) => e.variant === 'withheld')).toBe(true);
});

/**
 * The RECONNECT hole (#598).
 *
 * `narration.withheld` is an ephemeral SSE frame with no durable counterpart. A client that
 * received deltas and then dropped before it arrived reconnects into catch-up, which replays
 * only the PERSISTED rows — so the retraction is simply absent, and `turn.ended` used to
 * promote the refused prose into the permanent transcript. Everything else in this feature
 * guards the live path; the replay path was written to render history rather than to enforce
 * a safety decision.
 *
 * These replay the durable rows WITHOUT the retraction frame, because its absence is the
 * entire scenario — a test that included it would prove nothing.
 */
function serverEvent(seq: number, kind: string, payload: Record<string, unknown>): AiDmTranscriptEvent {
  return {
    eventId: `evt-${seq}`,
    seq,
    campaignId: 1,
    kind: kind as AiDmTranscriptEvent['kind'],
    actorUserId: null,
    actorName: null,
    clientRef: null,
    turnId: 'turn-1',
    payload,
    at,
  };
}

test('a reconnect that MISSED the retraction still commits nothing', () => {
  const authoritative = transcriptReducer(emptyTranscript, { type: 'authoritative' });
  // Live, before the drop: a bubble opened and deltas arrived. No retraction — that frame is
  // precisely what this client never received.
  const live = apply(authoritative, turnStart, delta(UNSAFE));

  // Catch-up: the durable rows for the same turn. The withhold reaches the replay only as an
  // ordinary `control` row plus the turn's `content_withheld` stop reason.
  const replayed = transcriptReducer(live, {
    type: 'serverEvents',
    events: [
      serverEvent(1, 'control', { control: 'stuck', reason: 'content_withheld', state: 'awaiting_players' }),
      serverEvent(2, 'turn.ended', { stopReason: 'content_withheld', steps: 1, tokensUsed: 12, budgetRemaining: 100 }),
    ],
  });

  const bubble = replayed.entries.find((e): e is DmEntry => e.kind === 'dm');
  expect(bubble).toBeTruthy();
  expect(dmEntryText(bubble!)).toBe('');
  expect(JSON.stringify(replayed)).not.toContain(UNSAFE);
  // Still a CLOSED turn — the bubble must not sit spinning forever.
  expect(bubble!.status).toBe('done');
  expect(bubble!.meta?.stopReason).toBe('content_withheld');
});

test('replay still commits trailing deltas for every NON-withheld stop reason', () => {
  // The guard is scoped to the safety terminal state. A turn that ended any other way still
  // owns its trailing prose, and dropping it would be a truncation bug.
  const authoritative = transcriptReducer(emptyTranscript, { type: 'authoritative' });
  const live = apply(authoritative, turnStart, delta('the lamp gutters'));
  const replayed = transcriptReducer(live, {
    type: 'serverEvents',
    events: [serverEvent(2, 'turn.ended', { stopReason: 'complete', steps: 1, tokensUsed: 12, budgetRemaining: 100 })],
  });
  const bubble = replayed.entries.find((e): e is DmEntry => e.kind === 'dm');
  expect(dmEntryText(bubble!)).toContain('the lamp gutters');
});

test('the LIVE commit point refuses a withheld stop reason too, without the retraction', () => {
  // Same rule, other commit point. The live path is normally covered by the retraction, but
  // the test lives where the commit happens so neither delivery mode depends on an earlier
  // branch having tidied up — including if the retraction frame is ever dropped live.
  const state = apply(emptyTranscript, turnStart, delta(UNSAFE), turnEnd);
  const bubble = state.entries.find((e): e is DmEntry => e.kind === 'dm');
  expect(dmEntryText(bubble!)).toBe('');
});

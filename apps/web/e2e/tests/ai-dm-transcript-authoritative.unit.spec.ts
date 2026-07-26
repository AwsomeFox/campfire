import { expect, test } from '@playwright/test';
import type { AiDmTranscriptEvent } from '@campfire/schema';
import { parseAiDmStreamEvent } from '../../src/lib/useAiDmStream';
import {
  dmEntryText,
  emptyTranscript,
  transcriptReducer,
  type DmEntry,
  type PlayerEntry,
  type TranscriptState,
} from '../../src/features/ai-dm/transcript';

/**
 * Issue #572 — the authoritative multi-player table transcript, client side.
 *
 * The bug: the server never broadcast the player action an AI answer was responding to, so
 * only the sending browser had it, and the transcript was rebuilt locally in each client —
 * a reload / late join / reconnect gave every player a different log.
 *
 * These pin the view-model contract that makes one shared transcript possible:
 *   - the sender's optimistic echo is REPLACED by the authoritative event via `clientRef`,
 *     and never by text equality (two players can type the same thing);
 *   - re-delivery of an event (live frame, then a REST page after reconnect) merges;
 *   - out-of-order arrival self-corrects on `seq`, not on wall-clock time.
 */

const at = '2026-07-26T10:00:00.000Z';

function serverEvent(partial: Partial<AiDmTranscriptEvent> & Pick<AiDmTranscriptEvent, 'kind' | 'seq' | 'eventId'>): AiDmTranscriptEvent {
  return {
    campaignId: 1,
    actorUserId: null,
    actorName: null,
    clientRef: null,
    turnId: null,
    payload: {},
    at,
    ...partial,
  } as AiDmTranscriptEvent;
}

function apply(state: TranscriptState, ...events: AiDmTranscriptEvent[]): TranscriptState {
  return transcriptReducer(state, { type: 'serverEvents', events });
}

function players(state: TranscriptState): PlayerEntry[] {
  return state.entries.filter((e): e is PlayerEntry => e.kind === 'player');
}

test('the sender’s optimistic echo is replaced by the authoritative event, not duplicated', () => {
  const echoed = transcriptReducer(emptyTranscript, {
    type: 'localPlayer',
    memberName: 'Runa',
    text: 'I shoulder the door.',
    clientRef: 'ref-1',
  });
  expect(players(echoed)).toHaveLength(1);
  expect(players(echoed)[0].seq).toBeUndefined();

  const merged = apply(echoed, serverEvent({
    kind: 'player.action',
    seq: 7,
    eventId: 'evt-a',
    actorName: 'Runa',
    clientRef: 'ref-1',
    payload: { text: 'I shoulder the door.' },
  }));

  // ONE line, now carrying the server's stable identity and authoritative order.
  expect(players(merged)).toHaveLength(1);
  expect(players(merged)[0].id).toBe('evt-a');
  expect(players(merged)[0].seq).toBe(7);
  expect(merged.lastSeq).toBe(7);
  expect(merged.authoritative).toBe(true);
});

test('two players typing the SAME words produce two lines — dedup keys on the token, not the text', () => {
  const mine = transcriptReducer(emptyTranscript, {
    type: 'localPlayer',
    memberName: 'Runa',
    text: 'I attack!',
    clientRef: 'ref-mine',
  });
  // The other player's identical action arrives from the server with a DIFFERENT token.
  const both = apply(mine, serverEvent({
    kind: 'player.action',
    seq: 1,
    eventId: 'evt-theirs',
    actorName: 'Bram',
    clientRef: 'ref-theirs',
    payload: { text: 'I attack!' },
  }));
  expect(players(both)).toHaveLength(2);
  expect(players(both).map((p) => p.memberName).sort()).toEqual(['Bram', 'Runa']);

  // A content-equality heuristic would have collapsed these two into one.
  const mineToo = apply(both, serverEvent({
    kind: 'player.action',
    seq: 2,
    eventId: 'evt-mine',
    actorName: 'Runa',
    clientRef: 'ref-mine',
    payload: { text: 'I attack!' },
  }));
  expect(players(mineToo)).toHaveLength(2);
  expect(players(mineToo).map((p) => p.id)).toEqual(['evt-theirs', 'evt-mine']);
});

test('an authoritative event that beats the POST response back is not duplicated by the echo', () => {
  // The SSE frame lands first…
  const early = apply(emptyTranscript, serverEvent({
    kind: 'player.action',
    seq: 3,
    eventId: 'evt-early',
    actorName: 'Runa',
    clientRef: 'ref-x',
    payload: { text: 'I listen at the door.' },
  }));
  // …then the POST resolves and the composer echoes.
  const after = transcriptReducer(early, {
    type: 'localPlayer',
    memberName: 'Runa',
    text: 'I listen at the door.',
    clientRef: 'ref-x',
  });
  expect(players(after)).toHaveLength(1);
  expect(players(after)[0].id).toBe('evt-early');
});

test('re-delivering the same events (live frame, then a REST page) merges instead of doubling', () => {
  const events = [
    serverEvent({ kind: 'player.action', seq: 1, eventId: 'p1', actorName: 'Runa', payload: { text: 'I knock.' } }),
    serverEvent({ kind: 'narration', seq: 2, eventId: 'n1', turnId: 't1', payload: { text: 'A bolt slides back.' } }),
    serverEvent({ kind: 'tool', seq: 3, eventId: 'tl1', turnId: 't1', payload: { name: 'roll_dice', isError: false, proposed: false } }),
    serverEvent({ kind: 'turn.ended', seq: 4, eventId: 'e1', turnId: 't1', payload: { stopReason: 'complete', steps: 1, tokensUsed: 12, budgetRemaining: 88 } }),
  ];
  const once = apply(emptyTranscript, ...events);
  const twice = apply(once, ...events);
  expect(twice.entries.map((e) => e.id)).toEqual(once.entries.map((e) => e.id));
  const bubble = twice.entries.find((e): e is DmEntry => e.kind === 'dm')!;
  // The narration is committed exactly once, not twice.
  expect(dmEntryText(bubble)).toBe('A bolt slides back.');
  expect(bubble.meta?.stopReason).toBe('complete');
});

test('narration steps of one turn fold into ONE bubble via turnId', () => {
  const state = apply(
    emptyTranscript,
    serverEvent({ kind: 'narration', seq: 1, eventId: 'n1', turnId: 't9', payload: { text: 'First beat.' } }),
    serverEvent({ kind: 'narration', seq: 2, eventId: 'n2', turnId: 't9', payload: { text: 'Second beat.' } }),
    serverEvent({ kind: 'turn.ended', seq: 3, eventId: 'e9', turnId: 't9', payload: { stopReason: 'complete', steps: 2, tokensUsed: 40, budgetRemaining: 60 } }),
  );
  const bubbles = state.entries.filter((e): e is DmEntry => e.kind === 'dm');
  expect(bubbles).toHaveLength(1);
  expect(dmEntryText(bubbles[0])).toBe('First beat.\n\nSecond beat.');
  expect(bubbles[0].status).toBe('done');
});

test('out-of-order arrival self-corrects on seq — wall-clock order would not', () => {
  // Same timestamp on every event: only `seq` can order them.
  const later = serverEvent({ kind: 'player.action', seq: 12, eventId: 'late', actorName: 'B', payload: { text: 'second' } });
  const earlier = serverEvent({ kind: 'player.action', seq: 11, eventId: 'early', actorName: 'A', payload: { text: 'first' } });
  const state = transcriptReducer(emptyTranscript, { type: 'serverEvents', events: [later, earlier] });
  expect(players(state).map((p) => p.text)).toEqual(['first', 'second']);
  expect(state.lastSeq).toBe(12);
});

test('the live token stream still types into the bubble the authoritative narration commits', () => {
  let state = transcriptReducer(emptyTranscript, { type: 'stream', event: { type: 'turn.start', campaignId: 1, at } });
  state = transcriptReducer(state, { type: 'stream', event: { type: 'narration.delta', campaignId: 1, text: 'A bolt ', at } });
  state = transcriptReducer(state, { type: 'stream', event: { type: 'narration.delta', campaignId: 1, text: 'slides…', at } });
  const typing = state.entries.filter((e): e is DmEntry => e.kind === 'dm');
  expect(typing).toHaveLength(1);
  expect(dmEntryText(typing[0])).toBe('A bolt slides…');

  // The authoritative step adopts that same bubble rather than stacking a second one.
  state = apply(state, serverEvent({ kind: 'narration', seq: 5, eventId: 'n5', turnId: 't5', payload: { text: 'A bolt slides back.' } }));
  const committed = state.entries.filter((e): e is DmEntry => e.kind === 'dm');
  expect(committed).toHaveLength(1);
  expect(committed[0].id).toBe('dm:t5');
  expect(dmEntryText(committed[0])).toBe('A bolt slides back.');
});

test('once authoritative, thin signal frames no longer double the transcript', () => {
  const authoritative = apply(emptyTranscript, serverEvent({
    kind: 'tool',
    seq: 1,
    eventId: 'tl',
    payload: { name: 'roll_dice', isError: false, proposed: false },
  }));
  expect(authoritative.entries.filter((e) => e.kind === 'tool')).toHaveLength(1);

  // The legacy `tool` signal frame for the SAME call must not add a second chip.
  const withSignal = transcriptReducer(authoritative, {
    type: 'stream',
    event: { type: 'tool', campaignId: 1, name: 'roll_dice', isError: false, proposed: false, at },
  });
  expect(withSignal.entries.filter((e) => e.kind === 'tool')).toHaveLength(1);

  // A surface that never reads the server transcript keeps the original behaviour.
  const legacyOnly = transcriptReducer(emptyTranscript, {
    type: 'stream',
    event: { type: 'tool', campaignId: 1, name: 'roll_dice', isError: false, proposed: false, at },
  });
  expect(legacyOnly.entries.filter((e) => e.kind === 'tool')).toHaveLength(1);
});

test('a DM purge clears the local copy — a stale watermark would strand the client', () => {
  const state = apply(emptyTranscript, serverEvent({ kind: 'player.action', seq: 400, eventId: 'p', payload: { text: 'hi' } }));
  expect(state.lastSeq).toBe(400);
  const reset = transcriptReducer(state, { type: 'stream', event: { type: 'transcript.reset', campaignId: 1, at } });
  expect(reset.entries).toEqual([]);
  expect(reset.lastSeq).toBeUndefined();
});

test('the stream parser accepts a transcript frame and rejects one without a usable identity', () => {
  const good = parseAiDmStreamEvent({
    type: 'transcript',
    campaignId: 1,
    at,
    event: { eventId: 'evt', seq: 4, kind: 'player.action', at, payload: { text: 'hi' } },
  });
  expect(good?.type).toBe('transcript');

  // `seq` and `eventId` are what the merge keys off — a frame missing either is unusable.
  expect(parseAiDmStreamEvent({ type: 'transcript', campaignId: 1, at, event: { eventId: 'evt', kind: 'narration', at } })).toBeNull();
  expect(parseAiDmStreamEvent({ type: 'transcript', campaignId: 1, at, event: { seq: 2, kind: 'narration', at } })).toBeNull();
  expect(parseAiDmStreamEvent({ type: 'transcript.reset', campaignId: 1, at })?.type).toBe('transcript.reset');
});


test('a surface that has NOT opted in ignores transcript frames and keeps the legacy behaviour', () => {
  // The dashboard activity chip and the encounter driver dock share this reducer but never
  // fetch the server transcript. They must keep folding the signal frames — and must NOT
  // also fold the durable `transcript` frame, or every narration step would render twice.
  const legacy = transcriptReducer(emptyTranscript, {
    type: 'stream',
    event: { type: 'narration.message', campaignId: 1, text: 'A bolt slides back.', at },
  });
  const withDurable = transcriptReducer(legacy, {
    type: 'stream',
    event: {
      type: 'transcript',
      campaignId: 1,
      at,
      event: serverEvent({ kind: 'narration', seq: 1, eventId: 'n1', turnId: 't1', payload: { text: 'A bolt slides back.' } }),
    },
  });
  const bubbles = withDurable.entries.filter((e): e is DmEntry => e.kind === 'dm');
  expect(bubbles).toHaveLength(1);
  expect(dmEntryText(bubbles[0])).toBe('A bolt slides back.');

  // Opting in makes the same frame authoritative.
  const optedIn = transcriptReducer(transcriptReducer(emptyTranscript, { type: 'authoritative' }), {
    type: 'stream',
    event: {
      type: 'transcript',
      campaignId: 1,
      at,
      event: serverEvent({ kind: 'narration', seq: 1, eventId: 'n1', turnId: 't1', payload: { text: 'A bolt slides back.' } }),
    },
  });
  expect(optedIn.lastSeq).toBe(1);
  expect(dmEntryText(optedIn.entries.filter((e): e is DmEntry => e.kind === 'dm')[0])).toBe('A bolt slides back.');
});

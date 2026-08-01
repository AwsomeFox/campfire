import { expect, test } from '@playwright/test';
import type { AiDmTranscriptEvent } from '@campfire/schema';
import {
  dmEntryText,
  emptyTranscript,
  transcriptStorageKey,
  transcriptReducer,
  type DmEntry,
  type PlayerEntry,
  type SystemEntry,
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


test('a turn’s tool chips sort BELOW the narration that caused them, not above it', () => {
  // The server records each narration step before the tools that step invoked, and
  // turn.ended last: narration@2, tool@3, turn.ended@4. The DM bubble absorbs the whole
  // turn, so if it adopted the LATEST folded seq it would become 4 and sort under tool@3 —
  // showing a player what the AI did before what it said, in the one feature whose point is
  // an ordered log. The bubble must stay anchored at its first event.
  const state = apply(
    emptyTranscript,
    serverEvent({ kind: 'player.action', seq: 1, eventId: 'p1', actorName: 'Runa', payload: { text: 'I pick the lock.' } }),
    serverEvent({ kind: 'narration', seq: 2, eventId: 'n1', turnId: 't1', payload: { text: 'You test your luck…' } }),
    serverEvent({ kind: 'tool', seq: 3, eventId: 'tl1', turnId: 't1', payload: { name: 'roll_dice', isError: false, proposed: false } }),
    serverEvent({ kind: 'turn.ended', seq: 4, eventId: 'e1', turnId: 't1', payload: { stopReason: 'complete', steps: 1, tokensUsed: 12, budgetRemaining: 88 } }),
  );

  const kinds = state.entries.map((e) => e.kind);
  expect(kinds).toEqual(['player', 'dm', 'tool']);

  const bubble = state.entries.find((e): e is DmEntry => e.kind === 'dm')!;
  const chip = state.entries.find((e) => e.kind === 'tool')!;
  expect(bubble.seq).toBe(2); // anchored at the narration, NOT bumped to turn.ended's 4
  expect(state.entries.indexOf(bubble)).toBeLessThan(state.entries.indexOf(chip));
  // The turn still closes properly — anchoring the order must not cost the meta row.
  expect(bubble.meta?.stopReason).toBe('complete');
  // …and the watermark still advances to the newest event, so reconnect is unaffected.
  expect(state.lastSeq).toBe(4);
});

test('the anchor survives a multi-step turn arriving out of order', () => {
  // Same turn, delivered newest-first (as a REST page reversal or a racing frame might).
  const state = apply(
    emptyTranscript,
    serverEvent({ kind: 'turn.ended', seq: 5, eventId: 'e2', turnId: 't2', payload: { stopReason: 'complete', steps: 2, tokensUsed: 30, budgetRemaining: 70 } }),
    serverEvent({ kind: 'tool', seq: 4, eventId: 'tl2', turnId: 't2', payload: { name: 'update_encounter', isError: false, proposed: false } }),
    serverEvent({ kind: 'narration', seq: 3, eventId: 'n2', turnId: 't2', payload: { text: 'The lock clicks open.' } }),
  );
  const bubble = state.entries.find((e): e is DmEntry => e.kind === 'dm')!;
  const chip = state.entries.find((e) => e.kind === 'tool')!;
  // The bubble was created by turn.ended (seq 5) before its narration arrived; once the
  // narration folds in, ordering must reflect the earliest event of the turn.
  expect(state.entries.indexOf(bubble)).toBeLessThan(state.entries.indexOf(chip));
  expect(dmEntryText(bubble)).toBe('The lock clicks open.');
});


test('a new turn never fuses into a previous turn’s still-open bubble', () => {
  // A REST replay carries narration before its turn.ended, and a cancelled turn may never
  // get one — so a bubble can legitimately still be `streaming` when the NEXT turn's
  // narration arrives. It must open its own bubble rather than merging into the old one,
  // which would fuse two turns' text and drag the ordering anchor back to the older turn.
  const state = apply(
    emptyTranscript,
    serverEvent({ kind: 'narration', seq: 1, eventId: 'n1', turnId: 't0', payload: { text: 'The corridor is quiet.' } }),
    serverEvent({ kind: 'player.action', seq: 2, eventId: 'p1', actorName: 'Bram', payload: { text: 'I sprint for the stair.' } }),
    serverEvent({ kind: 'narration', seq: 3, eventId: 'n2', turnId: 't2', payload: { text: 'Boots hammer the flagstones.' } }),
  );

  const bubbles = state.entries.filter((e): e is DmEntry => e.kind === 'dm');
  expect(bubbles).toHaveLength(2);
  expect(bubbles.map((b) => b.id)).toEqual(['dm:t0', 'dm:t2']);
  expect(dmEntryText(bubbles[0])).toBe('The corridor is quiet.');
  expect(dmEntryText(bubbles[1])).toBe('Boots hammer the flagstones.');

  // The player action stays between the two turns it actually fell between.
  expect(state.entries.map((e) => e.kind)).toEqual(['dm', 'player', 'dm']);
});


test('the authoritative page and the live-activity provider cache under separate keys', () => {
  // Both are mounted at once on the Table route: AiTablePage writes the authoritative
  // format (dm:<turnId> ids, every entry carrying a seq) while the Layout-level activity
  // provider writes the legacy format (random ids, no seq). Sharing one key made the last
  // writer before a reload win — and a legacy snapshot hydrated by the authoritative page
  // cannot be merged by eventId, so each narration line rendered twice.
  expect(transcriptStorageKey(1, 7, 'table')).toBe(transcriptStorageKey(1, 7));
  expect(transcriptStorageKey(1, 7, 'activity')).not.toBe(transcriptStorageKey(1, 7, 'table'));
  // Distinct per campaign as well, so two tables never share a cache either.
  expect(transcriptStorageKey(1, 7, 'activity')).not.toBe(transcriptStorageKey(1, 8, 'activity'));
});


test('joined-mid-session seed context stays ABOVE later server events', () => {
  // A brand-new driver session where the DM set a scene before the first turn: a client
  // that loads first seeds [divider, scene] from thin session state. Those entries have no
  // server row, so no seq — but they are pre-join HISTORY, not live activity. Sorting all
  // seq-less entries to the tail pinned the "joined mid-session" marker beneath every line
  // it is supposed to introduce, for the rest of the session.
  const seeded = transcriptReducer(transcriptReducer(emptyTranscript, { type: 'authoritative' }), {
    type: 'seed',
    scene: 'The bolted door',
    lastNarration: 'Rust flakes away under your thumb.',
    at,
  });
  expect(seeded.entries.map((e) => e.kind)).toEqual(['system', 'system', 'dm']);

  const live = apply(
    seeded,
    serverEvent({ kind: 'player.action', seq: 1, eventId: 'p1', actorName: 'Runa', payload: { text: 'I shoulder the door.' } }),
    serverEvent({ kind: 'narration', seq: 2, eventId: 'n1', turnId: 't1', payload: { text: 'It gives.' } }),
  );

  // Seed context first, in its own order, then the session's events by seq.
  expect(live.entries.map((e) => e.kind)).toEqual(['system', 'system', 'dm', 'player', 'dm']);
  const divider = live.entries[0] as SystemEntry;
  const scene = live.entries[1] as SystemEntry;
  expect(divider.variant).toBe('divider');
  expect(scene.variant).toBe('scene');
  expect(dmEntryText(live.entries[2] as DmEntry)).toBe('Rust flakes away under your thumb.');
  expect((live.entries[3] as PlayerEntry).text).toBe('I shoulder the door.');
});

test('the optimistic echo and the open streaming bubble stay at the TAIL', () => {
  // The other half of the seed fix: seq-less entries that are genuinely the newest thing
  // must not be dragged up with the historical ones.
  const withHistory = apply(
    transcriptReducer(emptyTranscript, { type: 'authoritative' }),
    serverEvent({ kind: 'player.action', seq: 1, eventId: 'p1', actorName: 'Bram', payload: { text: 'I wait.' } }),
    serverEvent({ kind: 'narration', seq: 2, eventId: 'n1', turnId: 't1', payload: { text: 'Nothing stirs.' } }),
  );

  // A local echo whose server event has not landed yet belongs last.
  const echoed = transcriptReducer(withHistory, {
    type: 'localPlayer',
    memberName: 'Runa',
    text: 'I shoulder the door.',
    clientRef: 'ref-tail',
  });
  expect(echoed.entries[echoed.entries.length - 1].kind).toBe('player');
  expect((echoed.entries[echoed.entries.length - 1] as PlayerEntry).text).toBe('I shoulder the door.');

  // …and so does the bubble the live token stream just opened.
  const streaming = transcriptReducer(echoed, { type: 'stream', event: { type: 'turn.start', campaignId: 1, at } });
  const tail = streaming.entries[streaming.entries.length - 1] as DmEntry;
  expect(tail.kind).toBe('dm');
  expect(tail.status).toBe('streaming');
  expect(tail.seq).toBeUndefined();
});

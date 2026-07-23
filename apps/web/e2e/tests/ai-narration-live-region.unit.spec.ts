import { expect, test } from '@playwright/test';
import {
  advanceNarrationLog,
  announceableEntryIds,
  beginNarrationLogLive,
  collectPreLiveAnnounceableIds,
  formatNarrationLogAddition,
  nextComposerStatusAnnouncement,
  NARRATION_LOG_LIVE_REGION,
  NARRATION_STATUS_LIVE_REGION,
  NARRATION_STREAM_DEBOUNCE_MS,
  NARRATION_VISUAL_TRANSCRIPT,
  pendingStreamingNarrationChunk,
  resolveComposerA11ySnapshot,
  silenceNarrationLogBaseline,
  type NarrationLogCursor,
} from '../../src/features/ai-dm/narrationAccessibility';
import {
  dmEntryText,
  emptyTranscript,
  transcriptReducer,
  type DmEntry,
  type TranscriptEntry,
} from '../../src/features/ai-dm/transcript';
import type { AiDmStreamEvent } from '../../src/lib/useAiDmStream';

/**
 * Issue #1077 — streaming AI narration must reach screen readers without
 * per-token spam. These specs pin the pure live-region contract and the
 * announce-on-boundary cursor (same shape as combat-log-accessibility.unit).
 */

function stream(event: AiDmStreamEvent): TranscriptEntry[] {
  return transcriptReducer(emptyTranscript, { type: 'stream', event }).entries;
}

function fold(...events: AiDmStreamEvent[]): TranscriptEntry[] {
  let state = emptyTranscript;
  for (const event of events) {
    state = transcriptReducer(state, { type: 'stream', event });
  }
  return state.entries;
}

const at = '2026-07-23T12:00:00.000Z';

test.describe('AI narration live-region attributes (#1077)', () => {
  test('log mirror exposes role=log, aria-live=polite, aria-relevant=additions', () => {
    expect(NARRATION_LOG_LIVE_REGION).toEqual({
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions',
    });
  });

  test('status region follows DraftWithAiButton / StuckLadder polite status pattern', () => {
    expect(NARRATION_STATUS_LIVE_REGION).toEqual({
      role: 'status',
      'aria-live': 'polite',
    });
  });

  test('visual transcript is a named log landmark with aria-live=off', () => {
    expect(NARRATION_VISUAL_TRANSCRIPT).toEqual({
      role: 'log',
      'aria-live': 'off',
    });
  });

  test('documents a debounce budget for optional mid-turn chunks (not per-token)', () => {
    expect(NARRATION_STREAM_DEBOUNCE_MS).toBeGreaterThanOrEqual(1_000);
  });
});

test.describe('AI narration announce-on-boundary behaviour (#1077)', () => {
  test('silences hydrated history and ignores streaming deltas until turn.end', () => {
    const history = fold(
      { type: 'turn.start', campaignId: 1, at },
      { type: 'narration.delta', campaignId: 1, text: 'Old tale. ', at },
      {
        type: 'turn.end',
        campaignId: 1,
        stopReason: 'end_turn',
        steps: 1,
        tokensUsed: 10,
        budgetRemaining: 90,
        at,
      },
    );

    const baseline = advanceNarrationLog(history, null);
    expect(baseline.additions).toEqual([]);

    // Mid-turn: tokens land in the open bubble but must not become log additions.
    let live = transcriptReducer(
      { entries: history },
      { type: 'stream', event: { type: 'turn.start', campaignId: 1, at } },
    );
    live = transcriptReducer(live, {
      type: 'stream',
      event: { type: 'narration.delta', campaignId: 1, text: 'The door ', at },
    });
    live = transcriptReducer(live, {
      type: 'stream',
      event: { type: 'narration.delta', campaignId: 1, text: 'creaks open.', at },
    });

    const duringStream = advanceNarrationLog(live.entries, baseline.cursor);
    expect(duringStream.additions).toEqual([]);
    const open = live.entries.find((e): e is DmEntry => e.kind === 'dm' && e.status === 'streaming');
    expect(open).toBeTruthy();
    expect(dmEntryText(open!)).toBe('The door creaks open.');

    // turn.end commits the bubble — one addition, full text, no per-token spam.
    const done = transcriptReducer(live, {
      type: 'stream',
      event: {
        type: 'turn.end',
        campaignId: 1,
        stopReason: 'end_turn',
        steps: 1,
        tokensUsed: 12,
        budgetRemaining: 78,
        at,
      },
    });
    const afterEnd = advanceNarrationLog(done.entries, duringStream.cursor);
    expect(afterEnd.additions).toHaveLength(1);
    expect(afterEnd.additions[0]).toMatchObject({ kind: 'dm', text: 'The door creaks open.' });
    expect(formatNarrationLogAddition(afterEnd.additions[0]!)).toBe('DM: The door creaks open.');

    // Refetch / re-reduce of the same done entries must not re-announce.
    const again = advanceNarrationLog(done.entries, afterEnd.cursor);
    expect(again.additions).toEqual([]);
  });

  test('announces player actions as log additions without waiting on the DM', () => {
    // Empty tables pin an empty baseline after seed/hydration settles (not via
    // advanceNarrationLog([], null), which must keep the cursor unset).
    const baseline = silenceNarrationLogBaseline([]);
    const withPlayer = transcriptReducer(emptyTranscript, {
      type: 'localPlayer',
      memberName: 'Runa',
      characterName: 'Aria',
      text: 'I peek through the keyhole.',
      id: 'p1',
      at,
    });
    const advanced = advanceNarrationLog(withPlayer.entries, baseline);
    expect(advanced.additions).toEqual([
      {
        id: 'p1',
        kind: 'player',
        memberName: 'Runa',
        characterName: 'Aria',
        text: 'I peek through the keyhole.',
      },
    ]);
    expect(formatNarrationLogAddition(advanced.additions[0]!)).toBe(
      'Aria, played by Runa: I peek through the keyhole.',
    );
  });

  test('empty start → session seed stays silent (no join-context re-read)', () => {
    // Page mount with empty localStorage: the log effect must not promote a
    // cursor yet. Promoting here is the Bugbot failure mode (seed then looks live).
    const premature = advanceNarrationLog([], null);
    expect(premature.cursor).toBeNull();
    expect(premature.additions).toEqual([]);

    const seeded = transcriptReducer(emptyTranscript, {
      type: 'seed',
      scene: 'Candlelit cellar',
      lastNarration: 'Rats skitter in the dark.',
      at,
    });
    expect(seeded.entries.length).toBeGreaterThanOrEqual(2);

    // After seed settles, pin baseline without mirroring (page: silenceNarrationLogBaseline).
    const baseline = silenceNarrationLogBaseline(seeded.entries);
    expect(advanceNarrationLog(seeded.entries, baseline).additions).toEqual([]);

    // Same seed snapshot with a still-null cursor also silences (null = baseline pass).
    const nullPass = advanceNarrationLog(seeded.entries, null);
    expect(nullPass.additions).toEqual([]);
    expect(nullPass.cursor).not.toBeNull();

    // Mirror stays empty through the empty→seed path; only a later live line announces.
    const mirror: ReturnType<typeof advanceNarrationLog>['additions'] = [];
    let cursor: NarrationLogCursor | null = premature.cursor;
    let live = false;

    // Mount: live log not enabled yet.
    if (live) {
      const step = advanceNarrationLog([], cursor);
      cursor = step.cursor;
      mirror.push(...step.additions);
    }

    // Seed arrives; enable live and silence baseline in one settled pass.
    live = true;
    if (cursor === null) {
      cursor = silenceNarrationLogBaseline(seeded.entries);
    } else {
      const step = advanceNarrationLog(seeded.entries, cursor);
      cursor = step.cursor;
      mirror.push(...step.additions);
    }
    expect(mirror).toEqual([]);

    const withPlayer = transcriptReducer(seeded, {
      type: 'localPlayer',
      memberName: 'Runa',
      text: 'I light a torch.',
      id: 'p-live',
      at,
    });
    const liveStep = advanceNarrationLog(withPlayer.entries, cursor);
    expect(liveStep.additions).toEqual([
      {
        id: 'p-live',
        kind: 'player',
        memberName: 'Runa',
        characterName: undefined,
        text: 'I light a torch.',
      },
    ]);
  });

  test('premature empty cursor would wrongly announce seed (failure mode)', () => {
    // Guard: if a caller pins `{ seenEntryIds: new Set() }` on [], seed looks live.
    const bogusCursor: NarrationLogCursor = { seenEntryIds: new Set() };
    const seeded = transcriptReducer(emptyTranscript, {
      type: 'seed',
      scene: 'The tavern',
      lastNarration: 'The bard sings.',
      at,
    });
    const leaked = advanceNarrationLog(seeded.entries, bogusCursor);
    expect(leaked.additions.length).toBeGreaterThan(0);
    expect(leaked.additions.some((a) => a.kind === 'system' && a.variant === 'divider')).toBe(true);
  });

  test('turn.start/end and composer lock/unlock produce distinct status messages', () => {
    const labels = {
      streaming: 'The DM is narrating…',
      ready: 'Composer unlocked. You can send an action.',
    };

    // Mount baseline: no announcement.
    const ready = resolveComposerA11ySnapshot(false, null);
    expect(nextComposerStatusAnnouncement(null, ready, labels)).toBeNull();

    // turn.start → streaming status.
    const streaming = resolveComposerA11ySnapshot(true, null);
    expect(nextComposerStatusAnnouncement(ready, streaming, labels)).toBe(labels.streaming);

    // turn.end → composer unlocked.
    expect(nextComposerStatusAnnouncement(streaming, ready, labels)).toBe(labels.ready);

    // Non-stream lock (paused) is SR-perceivable.
    const paused = resolveComposerA11ySnapshot(false, 'The AI DM is paused.');
    expect(nextComposerStatusAnnouncement(ready, paused, labels)).toBe('The AI DM is paused.');

    // Identical snapshot is silent.
    expect(nextComposerStatusAnnouncement(paused, paused, labels)).toBeNull();
  });

  test('viewers get a neutral ready label (not Composer unlocked)', () => {
    const composerLabels = {
      streaming: 'The DM is narrating…',
      ready: 'Composer unlocked. You can send an action.',
    };
    const viewerLabels = {
      streaming: 'The DM is narrating…',
      ready: 'The table is ready.',
    };

    const ready = resolveComposerA11ySnapshot(false, null);
    const streaming = resolveComposerA11ySnapshot(true, null);

    // canCompose=true path still uses the composer copy.
    expect(nextComposerStatusAnnouncement(streaming, ready, composerLabels)).toBe(
      composerLabels.ready,
    );
    // canCompose=false path must not mention the composer.
    expect(nextComposerStatusAnnouncement(streaming, ready, viewerLabels)).toBe(
      viewerLabels.ready,
    );
    expect(viewerLabels.ready.toLowerCase()).not.toContain('composer');
  });

  test('streamed turn.end before live is announced after go-live (not silenced away)', () => {
    // Race: empty mount → full SSE turn lands while narrationLogLive is still false
    // (seed/hydration not settled). Going live must announce that DM line.
    const mountBaselineIds = announceableEntryIds([]); // empty localStorage
    const pending = new Set<string>();
    let live = false;
    const mirror: ReturnType<typeof beginNarrationLogLive>['additions'] = [];
    let cursor: NarrationLogCursor | null = null;

    const earlyTurn = fold(
      { type: 'turn.start', campaignId: 1, at },
      { type: 'narration.delta', campaignId: 1, text: 'Torches flare along the wall.', at },
      {
        type: 'turn.end',
        campaignId: 1,
        stopReason: 'end_turn',
        steps: 1,
        tokensUsed: 8,
        budgetRemaining: 92,
        at,
      },
    );

    // Pre-live effect: collect finished ids that were not on the mount baseline.
    for (const id of collectPreLiveAnnounceableIds(earlyTurn, mountBaselineIds)) {
      pending.add(id);
    }
    expect(pending.size).toBe(1);

    // Seed effect flips live because transcript.entries.length > 0.
    live = true;
    if (live && cursor === null) {
      const started = beginNarrationLogLive(earlyTurn, pending);
      cursor = started.cursor;
      pending.clear();
      mirror.push(...started.additions);
    }

    expect(mirror).toHaveLength(1);
    expect(mirror[0]).toMatchObject({
      kind: 'dm',
      text: 'Torches flare along the wall.',
    });

    // Failure mode: silencing the whole transcript with no exceptIds drops the line.
    const silencedAway = silenceNarrationLogBaseline(earlyTurn);
    expect(advanceNarrationLog(earlyTurn, silencedAway).additions).toEqual([]);
  });

  test('go-live still silences hydrated history and batched session seed', () => {
    const hydrated = fold(
      { type: 'turn.start', campaignId: 1, at },
      { type: 'narration.delta', campaignId: 1, text: 'Old scrollback.', at },
      {
        type: 'turn.end',
        campaignId: 1,
        stopReason: 'end_turn',
        steps: 1,
        tokensUsed: 4,
        budgetRemaining: 96,
        at,
      },
    );
    const mountBaselineIds = announceableEntryIds(hydrated);
    const pending = collectPreLiveAnnounceableIds(hydrated, mountBaselineIds);
    expect(pending.size).toBe(0);
    const started = beginNarrationLogLive(hydrated, pending);
    expect(started.additions).toEqual([]);

    // Seed batched with live=true never enters the pre-live pending set.
    const seeded = transcriptReducer(emptyTranscript, {
      type: 'seed',
      scene: 'Candlelit cellar',
      lastNarration: 'Rats skitter in the dark.',
      at,
    });
    const seedStarted = beginNarrationLogLive(seeded.entries, new Set());
    expect(seedStarted.additions).toEqual([]);
  });

  test('formatNarrationLogAddition prefers localized formatSystem over English fallback', () => {
    const addition = {
      id: 's1',
      kind: 'system' as const,
      variant: 'divider' as const,
    };
    expect(formatNarrationLogAddition(addition)).toBe('Joined mid-session');
    expect(
      formatNarrationLogAddition(addition, {
        formatSystem: () => '— Beigetreten mitten in der Session —',
      }),
    ).toBe('— Beigetreten mitten in der Session —');
  });

  test('pendingStreamingNarrationChunk returns only the unannounced suffix', () => {
    const entries = stream({ type: 'turn.start', campaignId: 1, at });
    const withText = transcriptReducer(
      { entries },
      { type: 'stream', event: { type: 'narration.delta', campaignId: 1, text: 'Hello brave ', at } },
    );
    const more = transcriptReducer(withText, {
      type: 'stream',
      event: { type: 'narration.delta', campaignId: 1, text: 'adventurers.', at },
    });
    const bubble = more.entries.find((e): e is DmEntry => e.kind === 'dm')!;

    expect(pendingStreamingNarrationChunk(bubble, 0)).toEqual({
      text: 'Hello brave adventurers.',
      nextLength: 'Hello brave adventurers.'.length,
    });
    expect(pendingStreamingNarrationChunk(bubble, 'Hello brave '.length)).toEqual({
      text: 'adventurers.',
      nextLength: 'Hello brave adventurers.'.length,
    });
    expect(pendingStreamingNarrationChunk(bubble, bubble.live.length)).toBeNull();
  });
});

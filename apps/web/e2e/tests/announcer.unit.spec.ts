import { expect, test } from '@playwright/test';
import {
  ANNOUNCE_DEDUPE_MS,
  ANNOUNCE_DWELL_MS,
  ANNOUNCE_RECENT_KEYS_MAX,
  createAnnounceQueue,
  fingerprintDedupeParts,
  formatGroupedAnnouncement,
  formatGroupedCombatantAnnouncement,
  type AnnouncementChannel,
  type AnnouncerScheduler,
  type LiveRegionUpdater,
} from '../../src/components/announcerQueue';

/**
 * Issue #839 — encounter announcements must queue/coalesce without dropping.
 *
 * The bug: a shared RAF handle cancelled the prior callback on every announce,
 * so turn + HP (and rapid successive events) silently lost messages. These
 * specs pin the pure queue + grouping helpers without a browser.
 */

type Spoken = { channel: AnnouncementChannel; message: string };

function createHarness(opts?: { dwellMs?: number; dedupeMs?: number; recentKeysMax?: number }) {
  let now = 1_000;
  const frames: Array<() => void> = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  const spoken: Spoken[] = [];
  const current: Record<AnnouncementChannel, string> = { polite: '', assertive: '' };

  const updater: LiveRegionUpdater = {
    clear: (channel) => {
      current[channel] = '';
    },
    set: (channel, message) => {
      current[channel] = message;
      spoken.push({ channel, message });
    },
  };

  const scheduler: AnnouncerScheduler = {
    nextFrame: (fn) => {
      frames.push(fn);
      let cancelled = false;
      return () => {
        cancelled = true;
        const idx = frames.indexOf(fn);
        if (idx >= 0) frames.splice(idx, 1);
        void cancelled;
      };
    },
    after: (ms, fn) => {
      const entry = { at: now + ms, fn };
      timers.push(entry);
      return () => {
        const idx = timers.indexOf(entry);
        if (idx >= 0) timers.splice(idx, 1);
      };
    },
    now: () => now,
  };

  const queue = createAnnounceQueue({
    updater,
    scheduler,
    dwellMs: opts?.dwellMs ?? ANNOUNCE_DWELL_MS,
    dedupeMs: opts?.dedupeMs ?? ANNOUNCE_DEDUPE_MS,
    recentKeysMax: opts?.recentKeysMax ?? ANNOUNCE_RECENT_KEYS_MAX,
  });

  function flushFrames(): void {
    while (frames.length > 0) {
      const batch = frames.splice(0, frames.length);
      for (const fn of batch) fn();
    }
  }

  function advance(ms: number): void {
    now += ms;
    const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
    for (const t of due) {
      const idx = timers.indexOf(t);
      if (idx >= 0) timers.splice(idx, 1);
      t.fn();
    }
    flushFrames();
  }

  return {
    announce: queue.announce,
    clear: queue.clear,
    dispose: queue.dispose,
    spoken,
    current,
    flushFrames,
    advance,
    setNow: (n: number) => {
      now = n;
    },
  };
}

test.describe('grouped announcement helpers (issue #839)', () => {
  test('formatGroupedAnnouncement joins turn + HP without dropping either', () => {
    expect(
      formatGroupedAnnouncement([
        "Round 2 — Mira's turn",
        'Ash Hound: Bloodied',
        'Mira: 12 of 20 hit points',
      ]),
    ).toBe("Round 2 — Mira's turn. Ash Hound: Bloodied. Mira: 12 of 20 hit points.");
  });

  test('formatGroupedCombatantAnnouncement keeps a single update concise', () => {
    expect(formatGroupedCombatantAnnouncement(['Mira: 12 of 20 hit points'])).toBe(
      'Mira: 12 of 20 hit points.',
    );
  });

  test('formatGroupedCombatantAnnouncement prefixes a count for bulk HP/condition changes', () => {
    expect(
      formatGroupedCombatantAnnouncement([
        'Mira: 12 of 20 hit points',
        'Ash Hound: Bloodied',
        'Torvin: gained Prone',
      ]),
    ).toBe('3 combatant updates. Mira: 12 of 20 hit points. Ash Hound: Bloodied. Torvin: gained Prone.');
  });

  test('fingerprintDedupeParts is stable, compact, and order-sensitive', () => {
    const a = fingerprintDedupeParts(['Mira: 12 of 20', 'Ash Hound: Bloodied']);
    const b = fingerprintDedupeParts(['Mira: 12 of 20', 'Ash Hound: Bloodied']);
    const c = fingerprintDedupeParts(['Ash Hound: Bloodied', 'Mira: 12 of 20']);
    expect(a).toBe(b);
    expect(a).toHaveLength(8);
    expect(a).not.toBe(c);
  });
});

test.describe('announce queue — turn + HP (issue #839)', () => {
  test('coalesces a turn announcement with multiple HP changes in one flush', () => {
    const h = createHarness();
    h.announce("Round 2 — Mira's turn");
    h.announce('Ash Hound: Bloodied');
    h.announce('Mira: 12 of 20 hit points');
    h.flushFrames();

    expect(h.spoken).toEqual([
      {
        channel: 'polite',
        message: "Round 2 — Mira's turn. Ash Hound: Bloodied. Mira: 12 of 20 hit points.",
      },
    ]);
    expect(h.current.polite).toContain("Mira's turn");
    expect(h.current.polite).toContain('Ash Hound: Bloodied');
    expect(h.current.polite).toContain('12 of 20 hit points');
  });
});

test.describe('announce queue — multiple HP changes (issue #839)', () => {
  test('preserves every combatant update instead of keeping only the last', () => {
    const h = createHarness();
    h.announce('Mira: 18 of 20 hit points');
    h.announce('Ash Hound: Bloodied');
    h.announce('Torvin: 3 of 14 hit points');
    h.flushFrames();

    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]!.message).toBe(
      'Mira: 18 of 20 hit points. Ash Hound: Bloodied. Torvin: 3 of 14 hit points.',
    );
  });
});

test.describe('announce queue — rapid successive events (issue #839)', () => {
  test('queues a second burst that arrives during the dwell without dropping it', () => {
    const h = createHarness({ dwellMs: 100 });
    h.announce("Round 1 — Mira's turn");
    h.flushFrames();
    expect(h.spoken).toEqual([{ channel: 'polite', message: "Round 1 — Mira's turn." }]);

    // Arrive while the first utterance is still dwelling.
    h.announce('Mira: 10 of 20 hit points');
    h.announce('Ash Hound: Critical');
    expect(h.spoken).toHaveLength(1);

    h.advance(100);
    expect(h.spoken).toEqual([
      { channel: 'polite', message: "Round 1 — Mira's turn." },
      { channel: 'polite', message: 'Mira: 10 of 20 hit points. Ash Hound: Critical.' },
    ]);
  });

  test('re-announces identical consecutive messages when no dedupeKey is set', () => {
    const h = createHarness({ dwellMs: 50 });
    h.announce('1d20: 15');
    h.flushFrames();
    h.advance(50);
    h.announce('1d20: 15');
    h.flushFrames();

    expect(h.spoken.map((s) => s.message)).toEqual(['1d20: 15.', '1d20: 15.']);
  });
});

test.describe('announce queue — independent channels (issue #839)', () => {
  test('keeps polite and assertive flushes independent', () => {
    const h = createHarness({ dwellMs: 100 });
    h.announce('Turn advanced');
    h.announce('Save failed', { assertive: true });
    h.flushFrames();

    expect(h.spoken).toEqual([
      { channel: 'polite', message: 'Turn advanced.' },
      { channel: 'assertive', message: 'Save failed.' },
    ]);
    expect(h.current.polite).toBe('Turn advanced.');
    expect(h.current.assertive).toBe('Save failed.');

    // A polite follow-up must not clear or postpone the assertive region.
    h.announce('Mira: Bloodied');
    expect(h.current.assertive).toBe('Save failed.');
    h.advance(100);
    expect(h.current.assertive).toBe('Save failed.');
    expect(h.spoken.at(-1)).toEqual({ channel: 'polite', message: 'Mira: Bloodied.' });
  });
});

test.describe('announce queue — reconnect dedupe (issue #839)', () => {
  test('dedupeKey suppresses duplicate chatter within the dedupe window', () => {
    const h = createHarness({ dwellMs: 50, dedupeMs: 500 });
    h.announce("Round 2 — Mira's turn", { dedupeKey: 'turn:2:7' });
    h.flushFrames();
    h.advance(50);
    h.announce("Round 2 — Mira's turn", { dedupeKey: 'turn:2:7' });
    h.flushFrames();

    expect(h.spoken).toHaveLength(1);

    h.advance(500);
    h.announce("Round 2 — Mira's turn", { dedupeKey: 'turn:2:7' });
    h.flushFrames();
    expect(h.spoken).toHaveLength(2);
  });

  test('empty announce wipes the polite region and drops its pending buffer', () => {
    const h = createHarness({ dwellMs: 100 });
    h.announce('secret HP text');
    h.flushFrames();
    expect(h.current.polite).toBe('secret HP text.');

    h.announce('queued after speak starts');
    h.announce('');
    expect(h.current.polite).toBe('');
    h.advance(100);
    expect(h.spoken).toEqual([{ channel: 'polite', message: 'secret HP text.' }]);
  });

  test('empty announce clears never-spoken dedupeKeys so retries are not suppressed', () => {
    const h = createHarness({ dwellMs: 100, dedupeMs: 2_000 });
    h.announce("Round 2 — Mira's turn", { dedupeKey: 'screen:1:9:2:7' });
    // Wipe before the RAF flush speaks the pending text.
    h.announce('');
    expect(h.current.polite).toBe('');
    expect(h.spoken).toHaveLength(0);

    h.announce("Round 2 — Mira's turn", { dedupeKey: 'screen:1:9:2:7' });
    h.flushFrames();
    expect(h.spoken).toEqual([{ channel: 'polite', message: "Round 2 — Mira's turn." }]);
  });

  test('clear() blanks both channels, cancels timers, and drops pending', () => {
    const h = createHarness({ dwellMs: 100 });
    h.announce('polite pending');
    h.announce('assertive pending', { assertive: true });
    h.flushFrames();
    h.announce('more polite');
    h.announce('more assertive', { assertive: true });

    h.clear();
    expect(h.current.polite).toBe('');
    expect(h.current.assertive).toBe('');
    h.advance(100);
    expect(h.spoken).toEqual([
      { channel: 'polite', message: 'polite pending.' },
      { channel: 'assertive', message: 'assertive pending.' },
    ]);
  });

  test('recentKeys hard-caps under a burst of unique dedupeKeys', () => {
    const max = 8;
    const h = createHarness({ dwellMs: 10, dedupeMs: 60_000, recentKeysMax: max });
    for (let i = 0; i < max + 12; i++) {
      h.announce(`msg ${i}`, { dedupeKey: `burst:${i}` });
      h.flushFrames();
      h.advance(10);
    }
    // Oldest keys were evicted; re-announcing an early key must not be suppressed.
    h.announce('msg 0 again', { dedupeKey: 'burst:0' });
    h.flushFrames();
    expect(h.spoken.at(-1)).toEqual({ channel: 'polite', message: 'msg 0 again.' });

    // Newest key is still remembered inside the window.
    h.announce('msg newest dup', { dedupeKey: `burst:${max + 11}` });
    h.flushFrames();
    expect(h.spoken.at(-1)).toEqual({ channel: 'polite', message: 'msg 0 again.' });
  });
});

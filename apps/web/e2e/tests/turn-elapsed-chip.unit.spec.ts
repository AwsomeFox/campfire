/**
 * Turn timer elapsed chip (issue #1935) — pure-logic coverage for the math, role
 * visibility matrix, a11y attributes, and ticking-interval arm/disarm logic.
 *
 * Kept out of a rendered-component test on purpose, matching every other spec in this
 * directory: this repo's Playwright unit-test transform renders `.tsx` component JSX
 * through Playwright's OWN jsx runtime (meant for HTML test-report attachments, not
 * React), so a `.tsx` component can't be mounted or SSR'd from here — only its
 * JSX-free exported logic can. `TURN_ELAPSED_CHIP_ARIA_ATTRS` and `armTurnElapsedTicker`
 * are exactly the objects/functions the component spreads/calls, not a parallel
 * reimplementation, so they stay a real regression guard rather than a mirror that can
 * drift from what's actually rendered.
 */
import { expect, test } from '@playwright/test';
import {
  armTurnElapsedTicker,
  formatTurnElapsed,
  shouldRenderTurnElapsedChip,
  turnElapsedSeconds,
  turnTimerLevel,
  TURN_ELAPSED_CHIP_ARIA_ATTRS,
  type TurnTickerScheduler,
} from '../../src/features/encounters/TurnElapsedChip';

test.describe('turnElapsedSeconds (issue #1935)', () => {
  test('computes whole seconds since the server stamp', () => {
    const started = '2026-01-01T00:00:00.000Z';
    const now = Date.parse('2026-01-01T00:03:40.000Z');
    expect(turnElapsedSeconds(started, now)).toBe(220);
  });

  test('clamps clock skew so elapsed never reads negative (server stamp momentarily "in the future" for this client)', () => {
    const started = '2026-01-01T00:00:05.000Z';
    const now = Date.parse('2026-01-01T00:00:00.000Z'); // 5s "before" the stamp, per this client's clock
    expect(turnElapsedSeconds(started, now)).toBe(0);
  });

  test('an unparseable stamp reads as 0 rather than NaN', () => {
    expect(turnElapsedSeconds('not-a-date', Date.now())).toBe(0);
  });
});

test.describe('formatTurnElapsed (issue #1935)', () => {
  test('formats mm:ss with zero-padded seconds', () => {
    expect(formatTurnElapsed(0)).toBe('0:00');
    expect(formatTurnElapsed(5)).toBe('0:05');
    expect(formatTurnElapsed(65)).toBe('1:05');
    expect(formatTurnElapsed(220)).toBe('3:40');
  });

  test('minutes are unbounded past 99', () => {
    expect(formatTurnElapsed(6000)).toBe('100:00');
  });
});

test.describe('turnTimerLevel (issue #1935)', () => {
  test('no limit (0) is always ok, regardless of elapsed', () => {
    expect(turnTimerLevel(0, 0)).toBe('ok');
    expect(turnTimerLevel(999, 0)).toBe('ok');
  });

  test('a 90s limit: ok below ~67s, amber from 67s (75%), red at/past 90s', () => {
    expect(turnTimerLevel(66, 90)).toBe('ok');
    expect(turnTimerLevel(68, 90)).toBe('amber'); // 68/90 ≈ 0.756 >= 0.75
    expect(turnTimerLevel(89, 90)).toBe('amber');
    expect(turnTimerLevel(90, 90)).toBe('red');
    expect(turnTimerLevel(200, 90)).toBe('red');
  });

  test('exactly the 75% boundary is amber, not ok', () => {
    expect(turnTimerLevel(45, 60)).toBe('amber'); // 45/60 = 0.75 exactly
  });
});

test.describe('shouldRenderTurnElapsedChip — role visibility matrix (issue #1935)', () => {
  test('never renders when the encounter is not mid-turn (turnStartedAt null)', () => {
    expect(shouldRenderTurnElapsedChip(null, 0, 'dm')).toBe(false);
    expect(shouldRenderTurnElapsedChip(null, 90, 'dm')).toBe(false);
    expect(shouldRenderTurnElapsedChip(null, 90, 'player')).toBe(false);
  });

  const started = '2026-01-01T00:00:00.000Z';

  test('DM always sees the chip once a turn is running, limit or no limit', () => {
    expect(shouldRenderTurnElapsedChip(started, 0, 'dm')).toBe(true);
    expect(shouldRenderTurnElapsedChip(started, 90, 'dm')).toBe(true);
  });

  test('players/Player Display see the chip only once a limit is set', () => {
    expect(shouldRenderTurnElapsedChip(started, 0, 'player')).toBe(false);
    expect(shouldRenderTurnElapsedChip(started, 90, 'player')).toBe(true);
  });
});

test.describe('TURN_ELAPSED_CHIP_ARIA_ATTRS — no per-second ARIA announcement (issue #1935 review, finding 1)', () => {
  test('declares aria-live="off" — not "polite"/"assertive", and not omitted either', () => {
    // The exact object the component spreads onto its root <span>. A blind DM would
    // otherwise hear "0:01… 0:02… 0:03…" continuously for the whole fight if this were
    // a live region (e.g. via role="status", which implies aria-live="polite").
    expect(TURN_ELAPSED_CHIP_ARIA_ATTRS['aria-live']).toBe('off');
  });

  test('carries no role at all (in particular no role="status", an implicit live region)', () => {
    expect(Object.keys(TURN_ELAPSED_CHIP_ARIA_ATTRS)).not.toContain('role');
    expect((TURN_ELAPSED_CHIP_ARIA_ATTRS as Record<string, unknown>).role).toBeUndefined();
  });

  test('is the only a11y-relevant key — nothing here accidentally reintroduces a live region', () => {
    expect(Object.keys(TURN_ELAPSED_CHIP_ARIA_ATTRS)).toEqual(['aria-live']);
  });
});

/** Records every scheduler call so the test can assert on them without any DOM/timers. */
function fakeScheduler() {
  const armed: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  let nextId = 1;
  const scheduler: TurnTickerScheduler = {
    setInterval: ((fn: () => void, ms: number) => {
      armed.push({ fn, ms });
      return nextId++ as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: ((id: unknown) => {
      cleared.push(id);
    }) as typeof clearInterval,
  };
  return { scheduler, armed, cleared };
}

test.describe('armTurnElapsedTicker (issue #1935 review, finding 2 — interval arm/disarm)', () => {
  test('does NOT arm an interval when the chip would render nothing (player, no limit)', () => {
    const { scheduler, armed } = fakeScheduler();
    let ticks = 0;
    const cleanup = armTurnElapsedTicker('2026-01-01T00:00:00.000Z', 0, 'player', () => ticks++, scheduler);
    expect(armed.length).toBe(0);
    expect(cleanup).toBeUndefined();
    expect(ticks).toBe(0);
  });

  test('does NOT arm when the encounter is not mid-turn (turnStartedAt null), even for the DM', () => {
    const { scheduler, armed } = fakeScheduler();
    const cleanup = armTurnElapsedTicker(null, 90, 'dm', () => {}, scheduler);
    expect(armed.length).toBe(0);
    expect(cleanup).toBeUndefined();
  });

  test('arms exactly one 1000ms interval when the chip is visible (dm, no limit)', () => {
    const { scheduler, armed } = fakeScheduler();
    const cleanup = armTurnElapsedTicker('2026-01-01T00:00:00.000Z', 0, 'dm', () => {}, scheduler);
    expect(armed.length).toBe(1);
    expect(armed[0].ms).toBe(1000);
    expect(typeof cleanup).toBe('function');
  });

  test('arms for a player once a limit is set', () => {
    const { scheduler, armed } = fakeScheduler();
    armTurnElapsedTicker('2026-01-01T00:00:00.000Z', 90, 'player', () => {}, scheduler);
    expect(armed.length).toBe(1);
  });

  test('ticks once immediately (synchronously) before scheduling the interval — a fresh turn is not up to 1s late', () => {
    const { scheduler } = fakeScheduler();
    let ticks = 0;
    armTurnElapsedTicker('2026-01-01T00:00:00.000Z', 0, 'dm', () => ticks++, scheduler);
    expect(ticks).toBe(1); // before any interval has had a chance to fire
  });

  test('the returned cleanup clears exactly the armed interval id', () => {
    const { scheduler, cleared } = fakeScheduler();
    const cleanup = armTurnElapsedTicker('2026-01-01T00:00:00.000Z', 0, 'dm', () => {}, scheduler);
    cleanup?.();
    expect(cleared).toEqual([1]);
  });
});

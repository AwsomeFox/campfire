/**
 * Turn timer elapsed chip (issue #1935) — pure-logic coverage for the math and role
 * visibility matrix. `turnStartedAt` is server-stamped, so the client never computes
 * "when did the turn start" itself — only "how long ago was that instant", which is
 * exactly what these helpers do. Kept out of a rendered-component test on purpose: the
 * ticking interval lives in the component (issue #1917 — must never lift into
 * RunSessionPage), so this suite exercises the pure math it drives instead.
 */
import { expect, test } from '@playwright/test';
import {
  formatTurnElapsed,
  shouldRenderTurnElapsedChip,
  turnElapsedSeconds,
  turnTimerLevel,
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

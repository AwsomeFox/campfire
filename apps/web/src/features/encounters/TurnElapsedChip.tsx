import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

/**
 * Turn timer (issue #1935): a small mm:ss chip showing how long the CURRENT turn has
 * been running. `turnStartedAt` is server-stamped (never computed client-side), so two
 * clients showing this chip never disagree about when the turn began, and a client that
 * mounts mid-turn shows the true elapsed time immediately rather than 0:00.
 *
 * The 1-second tick lives ENTIRELY in this leaf component's own local state — never
 * lifted into RunSessionPage — so the ticking clock cannot turn into the encounter
 * cockpit re-render storm issue #1917 exists to prevent. Every render just re-derives
 * elapsed = now - turnStartedAt, so a fresh `turnStartedAt` prop (from an SSE-driven
 * refetch after next/end/undo turn) self-corrects the displayed time with no separate
 * resync step, and client clock skew never accumulates (it is re-measured every tick,
 * never carried forward).
 *
 * Purely a social pacing cue: no auto-advance, no sound, no flashing. Past the DM's
 * optional limit the chip only changes color and icon (colorblind-safe, and safe for
 * reduced-motion users, since nothing here ever animates).
 */

export type TurnElapsedChipAudience = 'dm' | 'player';

export interface TurnElapsedChipProps {
  /** Server-stamped turn start, or null when the encounter isn't actively mid-turn. */
  turnStartedAt: string | null;
  /** DM-set pacing limit in seconds; 0 = no limit. */
  turnTimerSeconds: number;
  /**
   * 'dm' always renders once a turn is running, even with no limit set (plain elapsed
   * is a DM pacing instrument). 'player' — used by PlayerVitalsHeader and the Player
   * Display, issue #1935's "same rules" for both — renders only once turnTimerSeconds
   * is greater than 0; players get no unadorned elapsed-time readout.
   */
  audience: TurnElapsedChipAudience;
  className?: string;
}

/** Exported for unit tests — clamped so clock skew (server/client drift) never reads negative. */
export function turnElapsedSeconds(turnStartedAt: string, nowMs: number): number {
  const startMs = new Date(turnStartedAt).getTime();
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

/** mm:ss, unbounded minutes (a turn can in principle run past 99:59). */
export function formatTurnElapsed(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type TurnTimerLevel = 'ok' | 'amber' | 'red';

/** Amber from 75% of the limit, red at/past it. No limit (0) is always 'ok'. */
export function turnTimerLevel(elapsedSecondsValue: number, turnTimerSeconds: number): TurnTimerLevel {
  if (turnTimerSeconds <= 0) return 'ok';
  const ratio = elapsedSecondsValue / turnTimerSeconds;
  if (ratio >= 1) return 'red';
  if (ratio >= 0.75) return 'amber';
  return 'ok';
}

const LEVEL_ICON: Record<TurnTimerLevel, string> = {
  ok: 'stopwatch',
  amber: 'alarm-clock',
  red: 'siren',
};

/**
 * The chip's a11y attributes, spread verbatim onto its root element below — the single
 * source of truth for both the render and this file's regression test, so the test can
 * assert on the EXACT object the DOM node receives without needing to render JSX (this
 * repo's Playwright unit-test transform can't render component .tsx files outside a real
 * browser — see the "no rendered-component tests" convention every other *.unit.spec.ts
 * file already follows).
 *
 * Issue #1935 review (Copilot, finding 1): this chip's text changes once a second, so
 * `role="status"` — an implicit ARIA live region — would have many screen readers
 * announce it EVERY second for the whole fight, which is worse than no chip at all.
 * Deliberately no `role` at all, plus an explicit `aria-live="off"` in case an ancestor
 * ever declares a live region over this subtree. The chip stays discoverable/readable on
 * demand via its accessible name (`aria-label`, set separately) and hover `title` — it is
 * just never auto-announced.
 */
export const TURN_ELAPSED_CHIP_ARIA_ATTRS = { 'aria-live': 'off' as const };

/**
 * Role visibility matrix (issue #1935), pulled out as a pure function so the unit
 * suite can cover every audience/limit/turnStartedAt combination without rendering
 * React. The DM sees the chip any time a turn is running, limit or no limit
 * (plain elapsed is a DM pacing instrument); players and the Player Display only
 * once the DM has opted the table into a limit.
 *
 * This is also the SAME condition that gates the ticking interval (see
 * `armTurnElapsedTicker` below) — the chip and its clock are never allowed to
 * disagree about whether they're "on".
 */
export function shouldRenderTurnElapsedChip(
  turnStartedAt: string | null,
  turnTimerSeconds: number,
  audience: TurnElapsedChipAudience,
): boolean {
  if (!turnStartedAt) return false;
  if (audience === 'player' && turnTimerSeconds <= 0) return false;
  return true;
}

/** The subset of the global timer API the ticker needs — narrow enough to fake in a test
 *  with no DOM/window at all (issue #1935 review: this used to be untestable). */
export type TurnTickerScheduler = {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

/**
 * Arms (or refuses to arm) the chip's 1s tick, driven by the exact same visibility
 * rule the chip renders with (issue #1935 review — Copilot: the interval used to run
 * every second even for a player with no limit set, where the chip renders nothing,
 * needlessly re-rendering on every tick). Returns the effect's cleanup, or `undefined`
 * when nothing should be armed at all.
 *
 * Ticks once SYNCHRONOUSLY before scheduling the interval, so a fresh `turnStartedAt`
 * (a new turn) is reflected immediately rather than up to 1s late waiting on the first
 * interval fire (issue #1935 review) — and the same immediate tick naturally happens
 * again whenever `turnTimerSeconds`/`audience` change the visibility decision, since
 * those are also effect dependencies.
 */
export function armTurnElapsedTicker(
  turnStartedAt: string | null,
  turnTimerSeconds: number,
  audience: TurnElapsedChipAudience,
  onTick: () => void,
  scheduler: TurnTickerScheduler = globalThis,
): (() => void) | undefined {
  if (!shouldRenderTurnElapsedChip(turnStartedAt, turnTimerSeconds, audience)) return undefined;
  onTick();
  const id = scheduler.setInterval(onTick, 1000);
  return () => scheduler.clearInterval(id);
}

export function TurnElapsedChip({ turnStartedAt, turnTimerSeconds, audience, className = '' }: TurnElapsedChipProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(
    () => armTurnElapsedTicker(turnStartedAt, turnTimerSeconds, audience, () => setNow(Date.now())),
    [turnStartedAt, turnTimerSeconds, audience],
  );

  if (!shouldRenderTurnElapsedChip(turnStartedAt, turnTimerSeconds, audience)) return null;
  const hasLimit = turnTimerSeconds > 0;

  const elapsed = turnElapsedSeconds(turnStartedAt as string, now);
  const level = turnTimerLevel(elapsed, turnTimerSeconds);
  const label = hasLimit
    ? t('encounters.turnTimer.elapsedOfLimit', { elapsed: formatTurnElapsed(elapsed), limit: formatTurnElapsed(turnTimerSeconds) })
    : t('encounters.turnTimer.elapsed', { elapsed: formatTurnElapsed(elapsed) });

  return (
    <span
      className={`cf-turn-timer-chip cf-turn-timer-chip--${level} ${className}`}
      data-testid="turn-elapsed-chip"
      {...TURN_ELAPSED_CHIP_ARIA_ATTRS}
      title={label}
      aria-label={label}
    >
      <GameIcon slug={LEVEL_ICON[level]} size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
      {formatTurnElapsed(elapsed)}
    </span>
  );
}

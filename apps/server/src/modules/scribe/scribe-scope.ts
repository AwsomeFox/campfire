import type { ScribeSourceStats } from '@campfire/schema';
import type { RecapDraftSource } from '../sessions/sessions.service';

/** Time window for one scheduled game night — post-session runs bind to exactly one. */
export type ScribeSessionScope = {
  scheduledSessionId: number;
  windowStart: string;
  windowEnd: string;
  windowStartMs: number;
  windowEndMs: number;
};

/** Cursor-based scope for cron / incremental on-demand runs. */
export type ScribeCursorScope = {
  sinceAt: string;
  sinceMs: number;
};

export type ScribeSourceScope = ScribeSessionScope | ScribeCursorScope;

export function isSessionScope(scope: ScribeSourceScope): scope is ScribeSessionScope {
  return 'scheduledSessionId' in scope;
}

/** Compute the [start, end] ISO window for a scheduled session row. */
export function scheduledSessionWindow(
  scheduledSessionId: number,
  scheduledAt: string,
  durationMinutes: number,
): ScribeSessionScope {
  const windowStartMs = Date.parse(scheduledAt);
  const windowEndMs = windowStartMs + Math.max(0, durationMinutes) * 60_000;
  return {
    scheduledSessionId,
    windowStart: scheduledAt,
    windowEnd: new Date(windowEndMs).toISOString(),
    windowStartMs,
    windowEndMs,
  };
}

/**
 * Post-session assembly window for one scheduled game night (#499).
 * Starts at `scheduledAt`; ends at the next scheduled session's start, or `now`
 * when this is the latest session — so material from later nights never leaks in.
 */
export function postSessionScope(
  scheduledSessionId: number,
  scheduledAt: string,
  durationMinutes: number,
  opts: { now?: Date; nextSessionStartAt?: string | null } = {},
): ScribeSessionScope {
  const base = scheduledSessionWindow(scheduledSessionId, scheduledAt, durationMinutes);
  const nowMs = (opts.now ?? new Date()).getTime();
  const nextStartMs = opts.nextSessionStartAt ? Date.parse(opts.nextSessionStartAt) : Number.NaN;
  const capMs = Number.isFinite(nextStartMs) ? Math.min(nowMs, nextStartMs) : nowMs;
  const windowEndMs = Math.max(base.windowStartMs, capMs);
  return {
    ...base,
    windowEnd: new Date(windowEndMs).toISOString(),
    windowEndMs,
  };
}

function inWindow(iso: string | null | undefined, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= startMs && t <= endMs;
}

function afterCursor(iso: string | null | undefined, sinceMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > sinceMs;
}

type ScopedEncounter = RecapDraftSource['encounters'][number] & {
  endedAt?: string | null;
  updatedAt?: string | null;
  sessionId?: number | null;
};

type ScopedNote = RecapDraftSource['resolvedInbox'][number] & { updatedAt?: string | null };

type ScopedRoll = NonNullable<RecapDraftSource['diceRolls']>[number];

/**
 * Filter assembled campaign material down to a session window or incremental cursor.
 * Pure + deterministic — covered by unit tests (issue #499).
 */
export function filterSourceByScope(
  source: RecapDraftSource,
  scope: ScribeSourceScope,
  sessionPlayedAtById: ReadonlyMap<number, string | null> = new Map(),
): RecapDraftSource {
  if (isSessionScope(scope)) {
    const { windowStartMs, windowEndMs } = scope;
    const resolvedInbox = (source.resolvedInbox as ScopedNote[]).filter((n) => inWindow(n.updatedAt, windowStartMs, windowEndMs));
    const encounters = (source.encounters as ScopedEncounter[]).filter((e) => {
      if (e.status !== 'running' && e.status !== 'ended') return false;
      if (inWindow(e.endedAt, windowStartMs, windowEndMs)) return true;
      if (inWindow(e.updatedAt, windowStartMs, windowEndMs)) return true;
      if (e.sessionId != null) {
        const playedAt = sessionPlayedAtById.get(e.sessionId);
        if (inWindow(playedAt, windowStartMs, windowEndMs)) return true;
      }
      return false;
    });
    const diceRolls = (source.diceRolls ?? []).filter((r) => inWindow((r as ScopedRoll).createdAt, windowStartMs, windowEndMs));
    return { resolvedInbox, encounters, diceRolls };
  }

  const { sinceMs } = scope;
  const resolvedInbox = (source.resolvedInbox as ScopedNote[]).filter((n) => afterCursor(n.updatedAt, sinceMs));
  const encounters = (source.encounters as ScopedEncounter[]).filter((e) => {
    if (e.status !== 'running' && e.status !== 'ended') return false;
    return afterCursor(e.endedAt ?? e.updatedAt, sinceMs);
  });
  const diceRolls = (source.diceRolls ?? []).filter((r) => afterCursor((r as ScopedRoll).createdAt, sinceMs));
  return { resolvedInbox, encounters, diceRolls };
}

export function sourceStatsFrom(
  source: RecapDraftSource,
  scope?: ScribeSourceScope,
): ScribeSourceStats {
  const fought = source.encounters.filter((e) => e.status === 'running' || e.status === 'ended');
  const stats: ScribeSourceStats = {
    resolvedInbox: source.resolvedInbox.length,
    encounters: fought.length,
    diceRolls: source.diceRolls?.length ?? 0,
    excludedInboxByConsent: 0,
    excludedInboxPrivate: 0,
  };
  if (scope && isSessionScope(scope)) {
    stats.scheduledSessionId = scope.scheduledSessionId;
    stats.windowStart = scope.windowStart;
    stats.windowEnd = scope.windowEnd;
  } else if (scope && !isSessionScope(scope)) {
    stats.sinceAt = scope.sinceAt;
  }
  return stats;
}

/** Rough prompt-size estimate for dry-run preview (chars / 4). */
export function estimatePromptTokens(draft: string): number {
  return Math.max(0, Math.ceil(draft.length / 4));
}

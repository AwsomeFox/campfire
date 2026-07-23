/**
 * AI-DM Table narration accessibility helpers (issue #1077).
 *
 * The visible transcript streams token-by-token via `narration.delta`. Putting
 * `aria-live` on that surface would flood screen readers. Instead we:
 *   1. Mirror completed transcript additions into a `role="log"` live region
 *      (`aria-live="polite"` + `aria-relevant="additions"`) — announce on
 *      turn boundaries (and other finished entries), never per token.
 *   2. Surface turn start/end + composer lock/unlock via a separate
 *      `role="status" aria-live="polite"` region (same pattern as
 *      DraftWithAiButton / StuckLadder).
 *
 * Pure helpers only — no React — so unit specs can pin the boundary/cursor
 * behaviour without a browser (mirrors `combatLogAccessibility.ts`).
 */
import { dmEntryText, type DmEntry, type SystemEntry, type TranscriptEntry } from './transcript';

/** Live-region props for the narration log mirror (acceptance criteria). */
export const NARRATION_LOG_LIVE_REGION = {
  role: 'log',
  'aria-live': 'polite',
  'aria-relevant': 'additions',
} as const;

/**
 * Visual transcript scroll surface: named log landmark without live announcements.
 * Token deltas stay visual-only; the sr-only mirror owns polite additions.
 */
export const NARRATION_VISUAL_TRANSCRIPT = {
  role: 'log',
  'aria-live': 'off',
} as const;

/** Live-region props for turn / composer status (DraftWithAiButton / StuckLadder pattern). */
export const NARRATION_STATUS_LIVE_REGION = {
  role: 'status',
  'aria-live': 'polite',
} as const;

/**
 * Optional mid-turn chunking interval. The Table page announces on `turn.end`
 * by default; callers that want incremental chunks without per-token spam can
 * debounce with this budget.
 */
export const NARRATION_STREAM_DEBOUNCE_MS = 1_500;

export interface NarrationLogCursor {
  /** Entry ids already committed to the log mirror (or silenced as baseline). */
  seenEntryIds: Set<string>;
}

/** One addition ready to append to the `role="log"` mirror. */
export type NarrationLogAddition =
  | { id: string; kind: 'dm'; text: string }
  | { id: string; kind: 'player'; memberName: string; characterName?: string; text: string }
  | {
      id: string;
      kind: 'system';
      variant: SystemEntry['variant'];
      text?: string;
      data?: Record<string, string>;
    };

export interface NarrationLogAdvance {
  /** Null only for an empty mount snapshot before seed/hydration settles. */
  cursor: NarrationLogCursor | null;
  additions: NarrationLogAddition[];
}

/** Entries that are finished and safe to announce (never an open streaming bubble). */
export function isAnnounceableEntry(entry: TranscriptEntry): boolean {
  if (entry.kind === 'dm') return entry.status === 'done' && dmEntryText(entry).trim().length > 0;
  if (entry.kind === 'player') return entry.text.trim().length > 0;
  if (entry.kind === 'system') return true;
  // Tool chips are visual activity; status/lock copy covers the turn itself.
  return false;
}

/** Ids of finished entries currently safe to announce. */
export function announceableEntryIds(entries: readonly TranscriptEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (isAnnounceableEntry(entry)) ids.add(entry.id);
  }
  return ids;
}

function toAddition(entry: TranscriptEntry): NarrationLogAddition | null {
  if (entry.kind === 'dm') {
    const text = dmEntryText(entry).trim();
    if (!text) return null;
    return { id: entry.id, kind: 'dm', text };
  }
  if (entry.kind === 'player') {
    const text = entry.text.trim();
    if (!text) return null;
    return {
      id: entry.id,
      kind: 'player',
      memberName: entry.memberName,
      characterName: entry.characterName,
      text,
    };
  }
  if (entry.kind === 'system') {
    return {
      id: entry.id,
      kind: 'system',
      variant: entry.variant,
      text: entry.text,
      data: entry.data,
    };
  }
  return null;
}

/**
 * Pins the cursor past every currently announceable entry without producing
 * live-region additions. Use once mount/seed/hydration has settled so join
 * context is never re-read aloud; afterward {@link advanceNarrationLog} treats
 * further ids as live.
 *
 * `exceptIds` leaves finished lines unseen so a later
 * {@link advanceNarrationLog} / {@link beginNarrationLogLive} can still announce
 * them (e.g. a turn.end that arrived while the log was held for seeding).
 */
export function silenceNarrationLogBaseline(
  entries: readonly TranscriptEntry[],
  exceptIds?: ReadonlySet<string>,
): NarrationLogCursor {
  const seenEntryIds = new Set<string>();
  for (const entry of entries) {
    if (!isAnnounceableEntry(entry)) continue;
    if (exceptIds?.has(entry.id)) continue;
    seenEntryIds.add(entry.id);
  }
  return { seenEntryIds };
}

/**
 * First live pass after seed/hydration settles: silence join context, but still
 * announce finished lines that arrived while `narrationLogLive` was false
 * (streamed turn.end before seeding finished).
 */
export function beginNarrationLogLive(
  entries: readonly TranscriptEntry[],
  preLiveAnnounceIds: ReadonlySet<string>,
): NarrationLogAdvance {
  const cursor = silenceNarrationLogBaseline(entries, preLiveAnnounceIds);
  return advanceNarrationLog(entries, cursor);
}

/**
 * Finished entry ids that appeared after mount while the live log was still
 * held — keep these pending so the go-live silence pass does not drop them.
 */
export function collectPreLiveAnnounceableIds(
  entries: readonly TranscriptEntry[],
  mountBaselineIds: ReadonlySet<string>,
): Set<string> {
  const pending = new Set<string>();
  for (const id of announceableEntryIds(entries)) {
    if (!mountBaselineIds.has(id)) pending.add(id);
  }
  return pending;
}

/**
 * Advances an id-based cursor without re-announcing hydrated/seeded history.
 * A null cursor establishes the baseline (open or reload never reads the past
 * aloud). An empty snapshot with a null cursor stays null so a later session
 * seed can still be silenced via {@link silenceNarrationLogBaseline} / a null
 * pass — promoting to an empty cursor here would treat seed lines as live.
 * Streaming DM bubbles are ignored until `status === 'done'` (turn.end).
 */
export function advanceNarrationLog(
  entries: readonly TranscriptEntry[],
  cursor: NarrationLogCursor | null,
): NarrationLogAdvance {
  // Keep the cursor unset on an empty mount snapshot. Callers that have finished
  // the seed/hydration phase should pin via silenceNarrationLogBaseline([]).
  if (cursor === null && entries.length === 0) {
    return { cursor: null, additions: [] };
  }

  const seenEntryIds = cursor?.seenEntryIds ?? new Set<string>();
  const additions: NarrationLogAddition[] = [];

  for (const entry of entries) {
    if (!isAnnounceableEntry(entry)) continue;
    if (cursor && !seenEntryIds.has(entry.id)) {
      const addition = toAddition(entry);
      if (addition) additions.push(addition);
    }
    seenEntryIds.add(entry.id);
  }

  return { cursor: cursor ?? { seenEntryIds }, additions };
}

/** Concise spoken form for a log addition (English fallback; UI may re-localize). */
export function formatNarrationLogAddition(addition: NarrationLogAddition): string {
  if (addition.kind === 'dm') return `DM: ${addition.text}`;
  if (addition.kind === 'player') {
    const who = addition.characterName
      ? `${addition.characterName}, played by ${addition.memberName}`
      : addition.memberName;
    return `${who}: ${addition.text}`;
  }
  // System lines stay short — the page also renders localized variants visually.
  switch (addition.variant) {
    case 'divider':
      return 'Joined mid-session';
    case 'scene':
      return addition.text ? `Scene: ${addition.text}` : 'Scene updated';
    case 'stuck':
      return addition.text ? `The AI DM got stuck. ${addition.text}` : 'The AI DM got stuck';
    case 'recovered':
      return 'The AI DM recovered';
    case 'paused':
      return 'The AI DM was paused';
    case 'resumed':
      return 'The AI DM resumed';
    case 'takeover':
      return 'A human took over the DM seat';
    case 'vote':
      return addition.data?.action ? `Table vote: ${addition.data.action}` : 'Table vote';
    case 'rules':
      return addition.text ? `Rules answer: ${addition.text}` : 'Rules answer';
    case 'info':
    default:
      return addition.data?.state ? `State: ${addition.data.state}` : 'Table updated';
  }
}

/** Coarse composer / turn phase for the status live region. */
export type ComposerA11yPhase = 'streaming' | 'locked' | 'ready';

export interface ComposerA11ySnapshot {
  phase: ComposerA11yPhase;
  /** Localized lock reason when phase is `locked`; ignored otherwise. */
  lockReason: string | null;
}

export function resolveComposerA11ySnapshot(
  streaming: boolean,
  lockReason: string | null,
): ComposerA11ySnapshot {
  if (streaming) return { phase: 'streaming', lockReason: null };
  if (lockReason) return { phase: 'locked', lockReason };
  return { phase: 'ready', lockReason: null };
}

/**
 * Returns the next status message when the composer/turn phase changes.
 * `previous === null` means "just mounted" — silence the baseline so opening
 * the Table does not announce "Composer unlocked" unprompted.
 */
export function nextComposerStatusAnnouncement(
  previous: ComposerA11ySnapshot | null,
  next: ComposerA11ySnapshot,
  labels: { streaming: string; ready: string },
): string | null {
  if (previous === null) return null;
  if (previous.phase === next.phase && previous.lockReason === next.lockReason) return null;
  if (next.phase === 'streaming') return labels.streaming;
  if (next.phase === 'locked') return next.lockReason;
  return labels.ready;
}

/**
 * Debounced mid-stream helper: given the open DM bubble and how much text was
 * already spoken, return the unannounced suffix when it is non-empty. The Table
 * page prefers turn.end; this exists so tests (and future callers) can chunk
 * without per-token spam.
 */
export function pendingStreamingNarrationChunk(
  entry: DmEntry | undefined,
  announcedLength: number,
): { text: string; nextLength: number } | null {
  if (!entry || entry.status !== 'streaming') return null;
  const full = dmEntryText(entry);
  if (full.length <= announcedLength) return null;
  const text = full.slice(announcedLength).trim();
  if (!text) return null;
  return { text, nextLength: full.length };
}

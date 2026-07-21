/**
 * Client-side AI-DM transcript store (#338 foundation).
 *
 * Server truth is thin: the backend keeps only lightweight session state (scene,
 * lastNarration, status…). The running transcript every player watches is assembled
 * HERE, from the SSE stream (see lib/useAiDmStream.ts) plus a local echo of this
 * client's own submissions, and persisted per campaign in localStorage (bounded, so a
 * long session can't grow the store without limit). A late joiner has no server
 * transcript API to page through — they seed from `scene` + `lastNarration` behind a
 * "joined mid-session" divider.
 *
 * This module is a PURE reducer plus small (de)serialization helpers — no React, no
 * network — so it is trivially unit-testable and reusable by the Table page (#339) and
 * every surface that renders the narration.
 */
import type { AiDmStreamEvent } from '../../lib/useAiDmStream';

/** Max entries retained per campaign; the oldest are dropped past this (design: ~200). */
export const MAX_TRANSCRIPT_ENTRIES = 200;

/** localStorage key for a campaign's persisted transcript. */
export function transcriptStorageKey(campaignId: number): string {
  return `cf.aiDm.transcript.${campaignId}`;
}

// ---- Entry shapes ---------------------------------------------------------

/** A player action, echoed locally on submit and rendered with speaker identity. */
export interface PlayerEntry {
  id: string;
  kind: 'player';
  /** The human at the table. */
  memberName: string;
  /** The character they play, when acting in-character (design point 3). */
  characterName?: string;
  text: string;
  at: string;
}

/** Metadata closing a DM bubble at `turn.end`. */
export interface DmTurnMeta {
  stopReason: string;
  steps: number;
  tokensUsed: number;
  budgetRemaining: number;
}

/**
 * A DM narration bubble. `committed` holds the aggregated text of completed steps (from
 * `narration.message`, which repairs any deltas missed on the wire); `live` holds the
 * in-progress current step's raw deltas. Rendered text is the two joined — use
 * {@link dmEntryText}.
 */
export interface DmEntry {
  id: string;
  kind: 'dm';
  committed: string[];
  live: string;
  status: 'streaming' | 'done';
  meta?: DmTurnMeta;
  at: string;
}

/** An inline activity chip for a tool the AI invoked (id-only; details come via REST). */
export interface ToolEntry {
  id: string;
  kind: 'tool';
  name: string;
  isError: boolean;
  proposed: boolean;
  at: string;
}

/**
 * A system/divider line: the "joined mid-session" divider, a seeded scene label, and the
 * stuck-ladder lifecycle signals (stuck/recovered/paused/takeover/vote). `variant` lets
 * pages localize + style the line; the reducer stays UI-copy-free.
 */
export interface SystemEntry {
  id: string;
  kind: 'system';
  variant: 'divider' | 'scene' | 'stuck' | 'recovered' | 'paused' | 'resumed' | 'takeover' | 'vote' | 'rules' | 'info';
  /** Optional raw text (e.g. a seeded scene label or a stuck detail) for the page to render. */
  text?: string;
  /** Optional structured payload (e.g. the stuck reason, vote outcome) for the page. */
  data?: Record<string, string>;
  at: string;
}

export type TranscriptEntry = PlayerEntry | DmEntry | ToolEntry | SystemEntry;

export interface TranscriptState {
  entries: TranscriptEntry[];
}

export const emptyTranscript: TranscriptState = { entries: [] };

/** The rendered narration for a DM bubble: committed steps + the live (in-progress) step. */
export function dmEntryText(entry: DmEntry): string {
  return [...entry.committed, entry.live].filter((s) => s.length > 0).join('\n\n');
}

// ---- Actions --------------------------------------------------------------

export type TranscriptAction =
  /** Fold one SSE event into the transcript. */
  | { type: 'stream'; event: AiDmStreamEvent }
  /** Echo this client's own submission immediately (before/independent of the stream). */
  | { type: 'localPlayer'; memberName: string; characterName?: string; text: string; id?: string; at?: string }
  /**
   * Drop a locally-originated system line into the transcript (e.g. a rules-lookup answer,
   * which is a retrieval result this client requested rather than a broadcast SSE signal).
   */
  | { type: 'localSystem'; variant: SystemEntry['variant']; text?: string; data?: Record<string, string>; id?: string; at?: string }
  /** Seed a fresh transcript for a late joiner from thin session state. */
  | { type: 'seed'; scene?: string | null; lastNarration?: string | null; at?: string }
  /** Replace the whole state (e.g. after hydrating from localStorage). */
  | { type: 'hydrate'; state: TranscriptState }
  /** Clear everything. */
  | { type: 'reset' };

let idCounter = 0;
/** Best-effort unique id; monotonic fallback keeps ordering stable when crypto is absent. */
function makeId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  idCounter += 1;
  return `e${Date.now().toString(36)}-${idCounter}`;
}

/** Index of the current open (streaming) DM bubble, or -1. */
function openBubbleIndex(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.kind === 'dm' && e.status === 'streaming') return i;
    // A player/tool/system entry after the bubble doesn't close it, but a *done* dm does.
    if (e.kind === 'dm' && e.status === 'done') return -1;
  }
  return -1;
}

/** Append an entry, enforcing the bounded cap by dropping the oldest. */
function push(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const next = [...entries, entry];
  return next.length > MAX_TRANSCRIPT_ENTRIES ? next.slice(next.length - MAX_TRANSCRIPT_ENTRIES) : next;
}

/**
 * Fold one SSE event into the transcript. See design point 4 (streaming render) and
 * point 5 (tool events → inline chips).
 */
function applyStream(state: TranscriptState, event: AiDmStreamEvent): TranscriptState {
  const { entries } = state;

  switch (event.type) {
    case 'turn.start':
      // Open a fresh bubble the deltas will fill.
      return {
        entries: push(entries, {
          id: makeId(),
          kind: 'dm',
          committed: [],
          live: '',
          status: 'streaming',
          at: event.at,
        }),
      };

    case 'narration.delta': {
      const idx = openBubbleIndex(entries);
      if (idx === -1) {
        // A delta with no open bubble (missed turn.start) — open one lazily.
        return {
          entries: push(entries, {
            id: makeId(),
            kind: 'dm',
            committed: [],
            live: event.text,
            status: 'streaming',
            at: event.at,
          }),
        };
      }
      const bubble = entries[idx] as DmEntry;
      const next = entries.slice();
      next[idx] = { ...bubble, live: bubble.live + event.text };
      return { entries: next };
    }

    case 'narration.message': {
      // Authoritative aggregate for the current step — commit it and drop the raw deltas.
      const idx = openBubbleIndex(entries);
      if (idx === -1) {
        return {
          entries: push(entries, {
            id: makeId(),
            kind: 'dm',
            committed: event.text ? [event.text] : [],
            live: '',
            status: 'streaming',
            at: event.at,
          }),
        };
      }
      const bubble = entries[idx] as DmEntry;
      const next = entries.slice();
      next[idx] = {
        ...bubble,
        committed: event.text ? [...bubble.committed, event.text] : bubble.committed,
        live: '',
      };
      return { entries: next };
    }

    case 'turn.end': {
      const idx = openBubbleIndex(entries);
      if (idx === -1) return state;
      const bubble = entries[idx] as DmEntry;
      const next = entries.slice();
      next[idx] = {
        ...bubble,
        // Commit any trailing live deltas that never got a repairing message.
        committed: bubble.live ? [...bubble.committed, bubble.live] : bubble.committed,
        live: '',
        status: 'done',
        meta: {
          stopReason: event.stopReason,
          steps: event.steps,
          tokensUsed: event.tokensUsed,
          budgetRemaining: event.budgetRemaining,
        },
      };
      return { entries: next };
    }

    case 'tool':
      return {
        entries: push(entries, {
          id: makeId(),
          kind: 'tool',
          name: event.name,
          isError: event.isError,
          proposed: event.proposed,
          at: event.at,
        }),
      };

    case 'stuck':
      return {
        entries: push(entries, {
          id: makeId(),
          kind: 'system',
          variant: 'stuck',
          text: event.detail,
          data: { reason: event.reason, state: event.state },
          at: event.at,
        }),
      };

    case 'recovered':
      return {
        entries: push(entries, {
          id: makeId(),
          kind: 'system',
          variant: 'recovered',
          data: { state: event.state },
          at: event.at,
        }),
      };

    case 'state': {
      // Map the coarse lifecycle transition onto a divider variant where meaningful.
      const variant: SystemEntry['variant'] =
        event.state === 'paused' ? 'paused' : event.state === 'running' ? 'resumed' : 'info';
      return {
        entries: push(entries, {
          id: makeId(),
          kind: 'system',
          variant,
          data: { state: event.state },
          at: event.at,
        }),
      };
    }

    case 'vote':
      return {
        entries: push(entries, {
          id: makeId(),
          kind: 'system',
          variant: 'vote',
          data: {
            action: event.action,
            kind: event.kind,
            ...(event.outcome ? { outcome: event.outcome } : {}),
          },
          at: event.at,
        }),
      };

    case 'takeover':
      return {
        entries: push(entries, {
          id: makeId(),
          kind: 'system',
          variant: 'takeover',
          data: { action: event.action, memberId: event.memberId },
          at: event.at,
        }),
      };

    default: {
      // Exhaustiveness guard — a new event kind must be handled explicitly.
      const _never: never = event;
      void _never;
      return state;
    }
  }
}

/** The pure transcript reducer. */
export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'stream':
      return applyStream(state, action.event);

    case 'localPlayer':
      return {
        entries: push(state.entries, {
          id: action.id ?? makeId(),
          kind: 'player',
          memberName: action.memberName,
          characterName: action.characterName,
          text: action.text,
          at: action.at ?? new Date().toISOString(),
        }),
      };

    case 'localSystem':
      return {
        entries: push(state.entries, {
          id: action.id ?? makeId(),
          kind: 'system',
          variant: action.variant,
          text: action.text,
          data: action.data,
          at: action.at ?? new Date().toISOString(),
        }),
      };

    case 'seed': {
      const at = action.at ?? new Date().toISOString();
      const entries: TranscriptEntry[] = [
        { id: makeId(), kind: 'system', variant: 'divider', at },
      ];
      if (action.scene) {
        entries.push({ id: makeId(), kind: 'system', variant: 'scene', text: action.scene, at });
      }
      if (action.lastNarration) {
        entries.push({
          id: makeId(),
          kind: 'dm',
          committed: [action.lastNarration],
          live: '',
          status: 'done',
          at,
        });
      }
      return { entries };
    }

    case 'hydrate':
      return action.state;

    case 'reset':
      return emptyTranscript;

    default: {
      const _never: never = action;
      void _never;
      return state;
    }
  }
}

/**
 * Build the speaker prefix the composer prepends to a submission so the model knows who
 * acts (design point 3): `[Aria, played by Runa]` in-character, or `[Runa]` out-of-character.
 * The server fences the raw input as untrusted (#317), so this is flavor for the model, not
 * authority. Exported for the Table composer (#339) to reuse.
 */
export function speakerPrefix(memberName: string, characterName?: string): string {
  return characterName ? `[${characterName}, played by ${memberName}]` : `[${memberName}]`;
}

// ---- Persistence ----------------------------------------------------------

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Load a campaign's persisted transcript, or the empty state on miss/parse error. */
export function loadTranscript(campaignId: number): TranscriptState {
  if (!hasStorage()) return emptyTranscript;
  try {
    const raw = window.localStorage.getItem(transcriptStorageKey(campaignId));
    if (!raw) return emptyTranscript;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TranscriptState).entries)) {
      const entries = (parsed as TranscriptState).entries;
      // Defensively re-bound in case an older/hand-edited store exceeded the cap.
      return { entries: entries.length > MAX_TRANSCRIPT_ENTRIES ? entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES) : entries };
    }
    return emptyTranscript;
  } catch {
    return emptyTranscript;
  }
}

/** Persist a campaign's transcript (best-effort; a full/blocked store is swallowed). */
export function saveTranscript(campaignId: number, state: TranscriptState): void {
  if (!hasStorage()) return;
  try {
    const bounded =
      state.entries.length > MAX_TRANSCRIPT_ENTRIES
        ? { entries: state.entries.slice(state.entries.length - MAX_TRANSCRIPT_ENTRIES) }
        : state;
    window.localStorage.setItem(transcriptStorageKey(campaignId), JSON.stringify(bounded));
  } catch {
    /* quota / privacy mode — transcript is best-effort, not authoritative */
  }
}

/** Remove a campaign's persisted transcript. */
export function clearTranscript(campaignId: number): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(transcriptStorageKey(campaignId));
  } catch {
    /* ignore */
  }
}

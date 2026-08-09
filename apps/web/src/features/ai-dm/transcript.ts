/**
 * AI-DM transcript view model (#338 foundation, made authoritative by #572).
 *
 * ORIGINALLY this store WAS the transcript: assembled in the browser from the SSE stream
 * plus a local echo of this one client's own submissions, and cached in localStorage. That
 * is the bug #572 fixes — the server never broadcast the player action an AI answer was
 * responding to, so only the sender ever saw it, and a reload / late join / reconnect
 * produced a materially different transcript in every browser at the table.
 *
 * NOW the server owns one ordered, durable transcript per campaign. This module is the
 * VIEW MODEL over it: it folds authoritative server events (`serverEvents`, and the live
 * `transcript` SSE frame) into renderable entries, keyed by the server's stable `eventId`
 * so the same event arriving twice — live frame plus a REST page after a reconnect —
 * merges instead of duplicating. `seq` gives every server-backed entry a total order, so
 * out-of-order arrival self-corrects.
 *
 * The ephemeral token stream still flows through the old `stream` path: `narration.delta`
 * is what makes the DM appear to type and is deliberately never persisted. Once ANY
 * authoritative data has been applied, {@link TranscriptState.authoritative} flips and the
 * reducer stops folding the thin signal frames (`narration.message`, `tool`, `vote`,
 * `state`, …) that now have durable transcript counterparts — otherwise every line would
 * render twice. Surfaces that never fetch the server transcript (e.g. the dashboard
 * activity chip) leave the flag false and keep the original behaviour exactly.
 *
 * Still a PURE reducer plus small (de)serialization helpers — no React, no network.
 */
import type { AiDmTranscriptEvent, CampaignEvent as AiDmStreamEvent } from '@campfire/schema';
import {
  isTranscriptRememberEnabled,
  transcriptCacheKey,
  type TranscriptViewerId,
} from './transcriptPrivacy';

/** Max entries retained per campaign; the oldest are dropped past this (design: ~200). */
export const MAX_TRANSCRIPT_ENTRIES = 200;

/**
 * Which surface owns a cached transcript (#572).
 *
 * Two surfaces are mounted at once on the Table route: the page and the Layout-level
 * live-activity provider. Both read the server's AUTHORITATIVE transcript (`dm:<turnId>`
 * bubble ids, every entry carrying a `seq`), but each mounts and reconciles independently.
 *
 * They therefore get separate keys. Namespacing prevents either surface's route transition
 * from overwriting the other's paint cache before its next server reconciliation.
 *
 * #573 composes a USER namespace over this one rather than replacing it: both axes are
 * real, and a key must separate them both (see {@link transcriptStorageKey}).
 */
export type TranscriptStorageScope = 'table' | 'activity';

/**
 * Effective campaign-role projection used by the activity transcript cache.
 *
 * The server can redact transcript rows differently for a DM, player, and viewer. The
 * Layout-level activity surface therefore records which projection produced a cache and
 * never rehydrates it for another role of the same signed-in user.
 */
export type TranscriptCacheProjection = 'dm' | 'player' | 'viewer';

/**
 * localStorage key for one VIEWER's cached transcript of a campaign, or `null` when
 * there is no established viewer (#573).
 *
 * Since #572 this is a PAINT CACHE, not the source of truth — the server transcript is
 * refetched on mount and reconciled over it.
 *
 * #573 added the user namespace and, with it, the null return. A transcript records who
 * said what at the table, so keying it by campaign alone let the next account to sign in
 * on a shared browser repaint the previous one's history. The null is the load-bearing
 * part: "never hydrate before identity is established" is enforced by there being NO KEY
 * to read until `/me` has resolved, rather than by every call site remembering to check.
 * See {@link transcriptCacheKey} for the generation and the accompanying purge.
 */
export function transcriptStorageKey(
  viewerId: TranscriptViewerId,
  campaignId: number,
  scope: TranscriptStorageScope = 'table',
): string | null {
  return transcriptCacheKey(viewerId, campaignId, scope);
}

// ---- Entry shapes ---------------------------------------------------------

/**
 * A player action. Optimistically echoed on submit, then REPLACED in place by the
 * authoritative server event that carries the same {@link PlayerEntry.clientRef} (#572).
 */
export interface PlayerEntry {
  id: string;
  kind: 'player';
  /** The human at the table. */
  memberName: string;
  /** The character they play, when acting in-character (design point 3). */
  characterName?: string;
  text: string;
  /** Authoritative per-campaign order, once the server event has landed (#572). */
  seq?: number;
  /**
   * Optimistic-echo correlation token this client minted for its own submission (#572).
   * The server echoes it back on the persisted event, and the sender swaps its local entry
   * for the authoritative one. A token, not content equality: two players typing "I attack"
   * in the same round must still produce two lines.
   */
  clientRef?: string;
  at: string;
}

/** Metadata closing a DM bubble at `turn.end` / `turn.error`. */
export interface DmTurnMeta {
  stopReason: string;
  steps: number;
  tokensUsed: number;
  budgetRemaining: number;
  /** Provider failure with no meterable usage (#560). */
  tokensUsageUnknown?: boolean;
  /** Player-readable provider failure detail when stopReason is provider_error (#560). */
  errorMessage?: string;
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
  /** Authoritative order of the newest server event folded into this bubble (#572). */
  seq?: number;
  /**
   * `eventId`s of the narration steps already committed here (#572). A bubble spans a whole
   * turn, so it absorbs several server events; this is what makes re-delivery (live frame
   * then a REST page after reconnect) idempotent rather than doubling the narration.
   */
  eventIds?: string[];
  at: string;
}

/** An inline activity chip for a tool the AI invoked (id-only; details come via REST). */
export interface ToolEntry {
  id: string;
  kind: 'tool';
  name: string;
  isError: boolean;
  proposed: boolean;
  /** Server-derived encounter identity when the tool mutated a fight (#825). Persisted with the transcript. */
  encounterId?: number;
  /** Authoritative per-campaign order (#572). */
  seq?: number;
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
  variant:
    | 'divider'
    | 'scene'
    | 'stuck'
    | 'recovered'
    | 'paused'
    | 'resumed'
    | 'takeover'
    | 'vote'
    | 'rules'
    /** #598 — a turn a provider content filter / refusal withheld. Neutral; carries no content. */
    | 'withheld'
    // #1043 — the durable session-lifecycle control rows.
    | 'phase'
    | 'phaseInterrupted'
    | 'info';
  /** Optional raw text (e.g. a seeded scene label or a stuck detail) for the page to render. */
  text?: string;
  /** Optional structured payload (e.g. the stuck reason, vote outcome) for the page. */
  data?: Record<string, string>;
  /** Authoritative per-campaign order (#572). */
  seq?: number;
  at: string;
}

export type TranscriptEntry = PlayerEntry | DmEntry | ToolEntry | SystemEntry;

export interface TranscriptState {
  entries: TranscriptEntry[];
  /**
   * OPT-IN (#572): this surface reads the server's authoritative transcript, so durable
   * events are the source of truth here. While true the reducer folds `transcript` frames
   * and IGNORES the thin signal frames that now have durable counterparts, so every line
   * renders exactly once. A surface that deliberately never fetches the transcript leaves it
   * false: it keeps folding thin signal frames and ignores `transcript` frames entirely.
   * Must be turned on explicitly — inferring it from the first server event would let a
   * non-authoritative surface fold both copies of that turn's narration.
   */
  authoritative?: boolean;
  /** Highest server `seq` folded in — the reconnect watermark ("give me the rest"). */
  lastSeq?: number;
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
  /**
   * Declare that this surface reads the server's authoritative transcript (#572). Must be
   * dispatched before `transcript` SSE frames will be folded — see
   * {@link TranscriptState.authoritative}.
   */
  | { type: 'authoritative' }
  /**
   * Fold authoritative server transcript events (#572) — from a REST page (initial load,
   * scroll-back, or reconnect gap-fill) or from a live `transcript` SSE frame. Idempotent:
   * events are merged by their stable `eventId`, so re-delivery never duplicates a line.
   */
  | { type: 'serverEvents'; events: AiDmTranscriptEvent[] }
  /** Echo this client's own submission immediately (before/independent of the stream). */
  | {
      type: 'localPlayer';
      memberName: string;
      characterName?: string;
      text: string;
      id?: string;
      /** Correlation token so the authoritative echo REPLACES this entry rather than duplicating it (#572). */
      clientRef?: string;
      at?: string;
    }
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

/**
 * Where an authoritative event for `turnId` should fold (#572), or -1 to open a new bubble.
 *
 * Prefers the bubble already keyed to this turn. Failing that it may adopt the bubble the
 * LIVE stream opened at `turn.start`, which has a generated id because the client does not
 * learn the turn id until the first durable event arrives.
 *
 * It must NOT adopt a bubble already claimed by a different turn. A `dm:<turnId>` id means
 * claimed, and a claimed bubble can still be `streaming` — a REST replay carries narration
 * before the matching `turn.ended`, and a cancelled turn may never get one at all. Without
 * this guard the next turn's narration merged into the previous turn's bubble, silently
 * fusing two turns into one and dragging its ordering anchor back to the older turn.
 */
function foldTargetIndex(entries: TranscriptEntry[], id: string): number {
  const keyed = indexOfId(entries, id);
  if (keyed !== -1) return keyed;
  const open = openBubbleIndex(entries);
  if (open === -1) return -1;
  return (entries[open] as DmEntry).id.startsWith('dm:') ? -1 : open;
}

/** Append an entry, enforcing the bounded cap by dropping the oldest. */
function push(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const next = [...entries, entry];
  return next.length > MAX_TRANSCRIPT_ENTRIES ? next.slice(next.length - MAX_TRANSCRIPT_ENTRIES) : next;
}

/**
 * Ordering sentinel for pre-join seed context (#572): the joined-mid-session divider, the
 * seeded scene label, and the `lastNarration` bubble.
 *
 * Those entries have no server row and therefore no real `seq`, but they are HISTORY, not
 * live activity — they must sit above everything the session goes on to record. Treating
 * them like the other seq-less entries sorted them to the tail, pinning the marker that
 * introduces the log underneath every line it introduces, permanently.
 *
 * 0 is safe as a sentinel rather than a value the server could collide with: the server
 * assigns `(MAX(seq) ?? 0) + 1`, so the first row of a campaign is seq 1, and the wire
 * schema declares `seq` as `z.number().int().positive()` — 0 is not representable on the
 * wire at all. Note that entries are partitioned on `=== undefined`, never truthiness, so
 * a 0 here sorts as a number instead of being mistaken for "no seq".
 */
export const SEED_SEQ = 0;

/**
 * Total order over merged entries (#572).
 *
 * Server-backed entries sort by `seq`, the authoritative per-campaign sequence — NOT by
 * timestamp, which cannot order two actions taken in the same millisecond. Pre-join seed
 * context carries {@link SEED_SEQ} so it leads the log.
 *
 * Entries with NO `seq` are the genuinely live ones — an optimistic echo whose server event
 * has not landed yet, and the still-open DM bubble — and stay at the tail in arrival order,
 * which is exactly where the newest activity belongs. Stable: entries that compare equal
 * keep their relative order, so the divider/scene/lastNarration triple holds its shape.
 */
function orderBySeq(entries: TranscriptEntry[]): TranscriptEntry[] {
  const sequenced: TranscriptEntry[] = [];
  const pending: TranscriptEntry[] = [];
  for (const entry of entries) (entry.seq === undefined ? pending : sequenced).push(entry);
  sequenced.sort((a, b) => (a.seq as number) - (b.seq as number));
  const merged = [...sequenced, ...pending];
  return merged.length > MAX_TRANSCRIPT_ENTRIES ? merged.slice(merged.length - MAX_TRANSCRIPT_ENTRIES) : merged;
}

/**
 * The ordering anchor when folding a server event into an existing DM bubble (#572).
 *
 * Normally the bubble keeps its FIRST event's seq so it cannot drift below its own turn's
 * tool chips. The one value it must not keep is {@link SEED_SEQ}: that marks pre-join
 * history, and a bubble carrying it would pin live narration above the entire log. The seed
 * bubble is created `done`, so `foldTargetIndex` cannot currently select it — this is
 * insurance against that becoming untrue, since the failure would be silent and baffling.
 */
function foldAnchorSeq(bubble: DmEntry, eventSeq: number): number {
  return bubble.seq === undefined || bubble.seq === SEED_SEQ ? eventSeq : bubble.seq;
}

/** Index of the entry with this id, or -1. */
function indexOfId(entries: TranscriptEntry[], id: string): number {
  return entries.findIndex((e) => e.id === id);
}

/**
 * May a turn ending this way promote its buffered live deltas into the permanent transcript?
 *
 * #598 — asked at BOTH commit points (the live `turn.end`/`turn.error` fold and the durable
 * `turn.ended` replay fold) rather than relying on an earlier branch having cleared the
 * buffer first. That ordering dependency is exactly what failed: `narration.withheld` is an
 * ephemeral frame with no durable counterpart, so a client that received deltas and then
 * dropped before it arrived replays the persisted rows WITHOUT ever seeing the retraction,
 * and the commit ran anyway. Everything else in this feature protects the live path; the
 * replay path was written to render history, not to enforce a safety decision.
 *
 * Putting the test where the commit happens means a third delivery mode added later inherits
 * it by construction instead of needing to remember to tidy up first.
 */
function commitsLiveText(stopReason: string | undefined): boolean {
  return stopReason !== 'content_withheld';
}

/**
 * Fold one SSE event into the transcript. See design point 4 (streaming render) and
 * point 5 (tool events → inline chips).
 */
function applyStream(state: TranscriptState, event: AiDmStreamEvent): TranscriptState {
  const { entries } = state;

  // #572: once the authoritative server transcript is in play, the durable event IS the
  // line. These thin signal frames each have a persisted counterpart that arrives as a
  // `transcript` frame (or in a REST page), so folding both would render everything twice.
  // Only the ephemeral turn/typing frames below stay client-side: `narration.delta` is the
  // token stream that makes the DM appear to type and is deliberately never persisted.
  if (
    state.authoritative
    && (event.type === 'narration.message'
      || event.type === 'tool'
      || event.type === 'stuck'
      || event.type === 'recovered'
      || event.type === 'state'
      || event.type === 'vote'
      || event.type === 'takeover')
  ) {
    return state;
  }

  switch (event.type) {
    case 'turn.start':
      // Open a fresh bubble the deltas will fill.
      return {
        ...state,
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
          ...state,
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
      return { ...state, entries: next };
    }

    case 'narration.message': {
      // Authoritative aggregate for the current step — commit it and drop the raw deltas.
      const idx = openBubbleIndex(entries);
      if (idx === -1) {
        return {
          ...state,
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
      return { ...state, entries: next };
    }

    // #598 — RETRACTION. The server withheld this turn after some deltas had already been
    // broadcast, so drop the open bubble's live buffer before `turn.end` can promote it into
    // `committed` (see the turn.end case below, which commits any trailing live text). That
    // promotion is the difference between "text a player glimpsed" and "text permanently in
    // this table's transcript", and it is the one part of the exposure a client can still undo.
    //
    // Deliberately handled ABOVE the authoritative-surface early-return at the top of this
    // function: the durable `control` row that #572 records covers the visible LINE, but only
    // this frame can clear an ephemeral delta buffer that was never persisted anywhere.
    case 'narration.withheld': {
      const idx = openBubbleIndex(entries);
      const cleared =
        idx === -1
          ? entries
          : (() => {
              const next = entries.slice();
              const bubble = entries[idx] as DmEntry;
              next[idx] = { ...bubble, live: '' };
              return next;
            })();
      // On an authoritative surface the persisted control row renders the line, exactly as it
      // does for `stuck`; folding both would print it twice.
      if (state.authoritative) return { ...state, entries: cleared };
      return {
        ...state,
        entries: push(cleared, {
          id: makeId(),
          kind: 'system',
          variant: 'withheld',
          text: event.message,
          data: { reason: event.reason },
          at: event.at,
        }),
      };
    }

    case 'turn.error':
    case 'turn.end': {
      const idx = openBubbleIndex(entries);
      if (idx === -1) return state;
      const bubble = entries[idx] as DmEntry;
      const next = entries.slice();
      const meta: DmTurnMeta = {
        stopReason: event.stopReason,
        steps: event.steps,
        tokensUsed: event.tokensUsed,
        budgetRemaining: event.budgetRemaining,
        ...(event.tokensUsageUnknown ? { tokensUsageUnknown: true } : {}),
        ...(event.type === 'turn.error' ? { errorMessage: event.message } : {}),
      };
      next[idx] = {
        ...bubble,
        // Commit any trailing live deltas that never got a repairing message — UNLESS the
        // turn was withheld, in which case there is nothing here that may be kept (#598).
        committed: commitsLiveText(meta.stopReason) && bubble.live ? [...bubble.committed, bubble.live] : bubble.committed,
        live: '',
        status: 'done',
        meta,
      };
      return { ...state, entries: next };
    }

    case 'tool':
      return {
        ...state,
        entries: push(entries, {
          id: makeId(),
          kind: 'tool',
          name: event.name,
          isError: event.isError,
          proposed: event.proposed,
          ...(event.encounterId !== undefined ? { encounterId: event.encounterId } : {}),
          at: event.at,
        }),
      };

    case 'stuck': {
      // #598 — a withheld turn joins the stuck ladder, so the server emits `narration.withheld`
      // and then, moments later on this same channel, a `stuck` frame with reason
      // `content_withheld`. Authoritative surfaces early-return on `stuck` above and render the
      // durable row, so an authoritative transcript shows one line. A non-authoritative surface
      // can fold both, printing the withheld line AND "The AI DM got stuck" and blaming the
      // table's AI for failing when it had actually declined. That framing is the thing #598
      // argues against.
      //
      // Fold it under the WITHHELD variant, and only when the retraction did not already put
      // that line up. Suppressing outright would leave a client that connected between the two
      // frames with no line at all; deduping on the tail entry keeps that client covered
      // (`stuck` arrives before `turn.end`, and neither the retraction nor anything between
      // them pushes another entry) without ever printing the event twice.
      if (event.reason === 'content_withheld') {
        const last = entries[entries.length - 1];
        if (last?.kind === 'system' && last.variant === 'withheld') return state;
        return {
          ...state,
          entries: push(entries, {
            id: makeId(),
            kind: 'system',
            variant: 'withheld',
            text: event.detail,
            data: { reason: event.reason, state: event.state },
            at: event.at,
          }),
        };
      }
      return {
        ...state,
        entries: push(entries, {
          id: makeId(),
          kind: 'system',
          variant: 'stuck',
          text: event.detail,
          data: { reason: event.reason, state: event.state },
          at: event.at,
        }),
      };
    }

    case 'recovered':
      return {
        ...state,
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
        ...state,
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
        ...state,
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
        ...state,
        entries: push(entries, {
          id: makeId(),
          kind: 'system',
          variant: 'takeover',
          data: { action: event.action, memberId: event.memberId },
          at: event.at,
        }),
      };

    case 'transcript':
      // A live authoritative event — same fold as a REST page, so the two are interchangeable.
      // Ignored on surfaces that have not opted in: they still fold the legacy signal frames,
      // and folding both would render this turn's narration twice.
      return state.authoritative ? applyServerEvent(state, event.event) : state;

    case 'transcript.reset':
      // The DM erased the transcript and `seq` restarted; a stale watermark would strand us.
      return state.authoritative ? { ...emptyTranscript, authoritative: true } : state;
    // #577: the grounding verdict is deliberately NOT folded into the transcript. The
    // transcript is the record of what was SAID; the GroundingPanel directly above it is the
    // record of what the server could VERIFY, and it reconciles off its own refetch on this
    // same signal. Splicing a verdict line between narration bubbles would also replay badly
    // against the persisted transcript, which does not carry the claim rows.
    case 'grounding':
      return state;
    // #1558: a tool confirmation is an ACTION THE DM OWES, not a thing that was said, so it does
    // not belong in the record of what was said. The ToolConfirmationsPanel owns it and
    // reconciles off its own refetch on this same signal — the same split as `grounding` above.
    // Folding it here would also read as narration in the scrollback long after it was resolved.
    case 'tool-confirmation':
      return state;
    // #1043: the lifecycle phase is TABLE STATE, not a thing that was said — the same split as
    // `grounding` and `tool-confirmation` above. It already has two homes: the dedicated phase
    // note on the AI Table, which reconciles off its own refetch on this same signal, and the
    // durable `control` row the server records, which reaches authoritative surfaces as a
    // `transcript` frame. Folding this frame too would double the line there, and would invent a
    // client-only system entry on the surfaces that have no durable copy. What this frame is FOR
    // is the invalidation its consumers now do.
    case 'phase':
      return state;

    default:
      return state;
  }
}

// ---- Authoritative server events (#572) -----------------------------------

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringMap(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

/**
 * Fold one authoritative server transcript event into the view model (#572).
 *
 * Every branch is IDEMPOTENT — the same event may arrive twice (a live `transcript` frame
 * and then a REST page after a reconnect) and must merge, not duplicate. Standalone kinds
 * key on the server `eventId`; narration and turn-end fold into the DM bubble for their
 * `turnId`, which is why the server stamps one, and that bubble tracks the `eventId`s it
 * has already absorbed.
 */
function applyServerEvent(state: TranscriptState, event: AiDmTranscriptEvent): TranscriptState {
  const base: TranscriptState = {
    ...state,
    authoritative: true,
    lastSeq: Math.max(state.lastSeq ?? 0, event.seq),
  };
  const entries = state.entries;
  const bubbleId = event.turnId ? `dm:${event.turnId}` : null;

  /** Replace an entry in place (id-keyed merge), or append when it is new. */
  const upsert = (entry: TranscriptEntry): TranscriptState => {
    const idx = indexOfId(entries, entry.id);
    if (idx === -1) return { ...base, entries: orderBySeq(push(entries, entry)) };
    const next = entries.slice();
    next[idx] = entry;
    return { ...base, entries: orderBySeq(next) };
  };

  switch (event.kind) {
    case 'player.action': {
      // Dedup the SENDER's optimistic echo: match on the correlation token this client
      // minted, never on text — two players typing the same words are two real lines.
      const localIdx = event.clientRef
        ? entries.findIndex((e) => e.kind === 'player' && e.clientRef === event.clientRef && e.id !== event.eventId)
        : -1;
      const entry: PlayerEntry = {
        id: event.eventId,
        kind: 'player',
        memberName: event.actorName ?? '',
        characterName: asText(event.payload.characterName) || undefined,
        text: asText(event.payload.text),
        seq: event.seq,
        ...(event.clientRef ? { clientRef: event.clientRef } : {}),
        at: event.at,
      };
      if (localIdx !== -1) {
        const next = entries.slice();
        next[localIdx] = entry;
        return { ...base, entries: orderBySeq(next) };
      }
      return upsert(entry);
    }

    case 'narration': {
      const text = asText(event.payload.text);
      if (!text) return base;
      const id = bubbleId ?? `dm:${event.eventId}`;
      // Adopt the bubble the live token stream already opened, so the typing effect and the
      // authoritative text are the same bubble rather than two stacked ones — but never a
      // bubble that already belongs to another turn (see foldTargetIndex).
      const idx = foldTargetIndex(entries, id);
      if (idx === -1) {
        return {
          ...base,
          entries: orderBySeq(
            push(entries, {
              id,
              kind: 'dm',
              committed: [text],
              live: '',
              status: 'streaming',
              seq: event.seq,
              eventIds: [event.eventId],
              at: event.at,
            }),
          ),
        };
      }
      const bubble = entries[idx] as DmEntry;
      if (bubble.eventIds?.includes(event.eventId)) return base; // already folded in
      const next = entries.slice();
      next[idx] = {
        ...bubble,
        id,
        committed: [...bubble.committed, text],
        live: '',
        // ANCHOR the bubble at its FIRST event, never the latest. A bubble spans a whole
        // turn, but the server records each narration step BEFORE the tools that step
        // invoked; advancing the bubble's seq on every fold would push it past its own
        // turn's tool chips and render "what the AI did" above "what the AI said" — in the
        // one feature whose point is an ordered log. Anchoring also matches the pre-#572
        // live behaviour, where the bubble opened at turn.start and chips appended below.
        seq: foldAnchorSeq(bubble, event.seq),
        eventIds: [...(bubble.eventIds ?? []), event.eventId],
      };
      return { ...base, entries: orderBySeq(next) };
    }

    case 'turn.ended': {
      const id = bubbleId ?? `dm:${event.eventId}`;
      const idx = foldTargetIndex(entries, id);
      const meta: DmTurnMeta = {
        stopReason: asText(event.payload.stopReason),
        steps: typeof event.payload.steps === 'number' ? event.payload.steps : 0,
        tokensUsed: typeof event.payload.tokensUsed === 'number' ? event.payload.tokensUsed : 0,
        budgetRemaining: typeof event.payload.budgetRemaining === 'number' ? event.payload.budgetRemaining : 0,
        ...(event.payload.tokensUsageUnknown === true ? { tokensUsageUnknown: true } : {}),
        ...(typeof event.payload.errorMessage === 'string' ? { errorMessage: event.payload.errorMessage } : {}),
      };
      if (idx === -1) {
        // A turn whose narration never landed here (late join mid-turn) still gets its
        // closing bubble, so the transcript records that a turn happened and how it ended.
        return {
          ...base,
          entries: orderBySeq(
            push(entries, { id, kind: 'dm', committed: [], live: '', status: 'done', meta, seq: event.seq, at: event.at }),
          ),
        };
      }
      const bubble = entries[idx] as DmEntry;
      const next = entries.slice();
      next[idx] = {
        ...bubble,
        id,
        // Commit any trailing live deltas the aggregated narration never repaired — UNLESS
        // the turn was withheld (#598). THIS is the reconnect hole: a client that received
        // deltas and then dropped before `narration.withheld` reconnects into catch-up, which
        // replays the durable rows only. The retraction is an EPHEMERAL frame with no durable
        // counterpart, so it is simply absent from the replay, and this line would promote the
        // refused prose into the permanent transcript — a connection blip at the wrong instant
        // defeating the entire feature.
        committed: commitsLiveText(meta.stopReason) && bubble.live ? [...bubble.committed, bubble.live] : bubble.committed,
        live: '',
        status: 'done',
        meta,
        // turn.ended is the LAST event of a turn; adopting its seq would sort the bubble
        // below every tool chip the turn produced. Keep the anchor (see the narration fold).
        seq: foldAnchorSeq(bubble, event.seq),
      };
      return { ...base, entries: orderBySeq(next) };
    }

    case 'turn.cancelled':
      return upsert({
        id: event.eventId,
        kind: 'system',
        variant: 'info',
        text: asText(event.payload.narration) || undefined,
        data: { stopReason: asText(event.payload.stopReason) },
        seq: event.seq,
        at: event.at,
      });

    case 'tool':
      return upsert({
        id: event.eventId,
        kind: 'tool',
        name: asText(event.payload.name),
        isError: event.payload.isError === true,
        proposed: event.payload.proposed === true,
        ...(typeof event.payload.encounterId === 'number' ? { encounterId: event.payload.encounterId } : {}),
        seq: event.seq,
        at: event.at,
      });

    case 'vote':
      return upsert({
        id: event.eventId,
        kind: 'system',
        variant: 'vote',
        data: asStringMap(event.payload),
        seq: event.seq,
        at: event.at,
      });

    case 'control': {
      const control = asText(event.payload.control);
      // #598: a withhold reaches the durable log as an ordinary `stuck` control row (the safety
      // terminal state is a rung on the existing ladder, not a parallel mechanism). Give it its
      // own variant anyway — "the AI DM got stuck" is the wrong sentence for a reply that was
      // generated and deliberately not shown.
      //
      // COUPLING WORTH KNOWING ABOUT: on a replayed transcript this is the ONLY thing telling a
      // withheld turn apart from a genuine stall, and it depends on `payload.reason` surviving
      // the server's role projection. It does today. If that projection ever begins redacting
      // `reason` for some role, every withheld turn silently reverts to reading as "the AI DM
      // got stuck" for that role — a wording regression with no test failure and no error,
      // because the fallback is itself a valid variant. The turn's `turn.ended` stop reason
      // carries the same signal if a second source is ever wanted.
      const withheld = control === 'stuck' && asText(event.payload.reason) === 'content_withheld';
      const variant: SystemEntry['variant'] =
        withheld
          ? 'withheld'
          : control === 'paused'
            ? 'paused'
            : control === 'resumed'
              ? 'resumed'
              : control === 'takeover'
                ? 'takeover'
                : control === 'stuck'
                  ? 'stuck'
                  : control === 'recovered'
                    ? 'recovered'
                    // #1043 — the two lifecycle controls the server records. Without these they
                    // fell through to `info`, whose copy is `State: {{state}}`, and the phase rows
                    // carry `phase`/`interrupted` rather than `state` — so every successful
                    // greeting and wrap-up wrote two blank `State:` lines into the durable
                    // transcript. `phase_interrupted` is kept distinct because it reports a
                    // transition that DIED, which is not the same news as one that landed.
                    : control === 'phase'
                      ? 'phase'
                      : control === 'phase_interrupted'
                        ? 'phaseInterrupted'
                        : 'info';
      return upsert({
        id: event.eventId,
        kind: 'system',
        variant,
        text: asText(event.payload.detail) || undefined,
        data: asStringMap(event.payload),
        seq: event.seq,
        at: event.at,
      });
    }

    default:
      // Forward-compatible: an unknown future kind is ignored rather than breaking the feed,
      // but its `seq` is still absorbed so the reconnect watermark cannot stall on it.
      return base;
  }
}

/** The pure transcript reducer. */
export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'stream':
      return applyStream(state, action.event);

    case 'authoritative':
      return state.authoritative ? state : { ...state, authoritative: true };

    case 'serverEvents': {
      // Apply in ascending seq so a batch (a REST page, or events replayed after a
      // reconnect) lands in the authoritative order regardless of how it was delivered.
      const ordered = [...action.events].sort((a, b) => a.seq - b.seq);
      return ordered.reduce(applyServerEvent, state);
    }

    case 'localPlayer': {
      // Dedup the OTHER direction (#572): the authoritative event can beat the POST's own
      // HTTP response back over SSE, in which case the line is already on screen and this
      // optimistic echo must not append a second copy.
      if (action.clientRef && state.entries.some((e) => e.kind === 'player' && e.clientRef === action.clientRef)) {
        return state;
      }
      return {
        ...state,
        entries: push(state.entries, {
          id: action.id ?? makeId(),
          kind: 'player',
          memberName: action.memberName,
          characterName: action.characterName,
          text: action.text,
          ...(action.clientRef ? { clientRef: action.clientRef } : {}),
          at: action.at ?? new Date().toISOString(),
        }),
      };
    }

    case 'localSystem':
      return {
        ...state,
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
      // SEED_SEQ marks these as pre-join history so they lead the log rather than sinking
      // below the session's own events (see the constant for why 0 cannot collide).
      const entries: TranscriptEntry[] = [
        { id: makeId(), kind: 'system', variant: 'divider', seq: SEED_SEQ, at },
      ];
      if (action.scene) {
        entries.push({ id: makeId(), kind: 'system', variant: 'scene', text: action.scene, seq: SEED_SEQ, at });
      }
      if (action.lastNarration) {
        entries.push({
          id: makeId(),
          kind: 'dm',
          committed: [action.lastNarration],
          live: '',
          status: 'done',
          seq: SEED_SEQ,
          at,
        });
      }
      return { ...state, entries };
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
 * Mint an optimistic-echo correlation token for a submission (#572).
 *
 * The composer sends this with the action; the server echoes it back verbatim on the
 * persisted `player.action` event so the SENDER replaces its local entry rather than
 * rendering the action twice, while every other player simply gets a new line. A token,
 * not a content hash: two players typing "I attack" in the same round are two real lines
 * and any content-equality heuristic would wrongly collapse them.
 */
export function newClientRef(): string {
  return makeId();
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

/**
 * Load this VIEWER's persisted transcript for a campaign, or the empty state on miss /
 * parse error / no established identity / no device grant (#573).
 *
 * Returning `emptyTranscript` for "identity not established yet" is what makes a slow
 * `/me` safe: a surface that renders before auth resolves paints nothing rather than
 * painting whatever the last account left behind.
 */
export function loadTranscript(
  viewerId: TranscriptViewerId,
  campaignId: number,
  scope: TranscriptStorageScope = 'table',
  projection?: TranscriptCacheProjection,
): TranscriptState {
  if (!hasStorage()) return emptyTranscript;
  const key = transcriptStorageKey(viewerId, campaignId, scope);
  if (key === null) return emptyTranscript;
  // Withdrawing the grant purges, so this is belt-and-braces — but a cache written under
  // a grant that has since been withdrawn must never repaint.
  if (!isTranscriptRememberEnabled(viewerId)) return emptyTranscript;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return emptyTranscript;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TranscriptState).entries)) {
      // The activity provider's transcript is server-authoritative but role-projected. A
      // cache made while this viewer was a DM must not repaint before the player/viewer
      // fetch settles after a demotion. Older activity caches have no projection marker,
      // so they are treated as untrusted and discarded once rather than guessed at.
      if (projection !== undefined && (parsed as { projection?: unknown }).projection !== projection) {
        window.localStorage.removeItem(key);
        return emptyTranscript;
      }
      const entries = (parsed as TranscriptState).entries;
      // Defensively re-bound in case an older/hand-edited store exceeded the cap.
      return { entries: entries.length > MAX_TRANSCRIPT_ENTRIES ? entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES) : entries };
    }
    return emptyTranscript;
  } catch {
    return emptyTranscript;
  }
}

/**
 * Persist this viewer's transcript cache (best-effort; a full/blocked store is swallowed).
 *
 * #573: WRITES NOTHING unless the viewer is established AND has explicitly opted into
 * remembering transcripts on this device. That check comes first, before the JSON
 * serialization, so the private default is also the cheap default — this effect fires on
 * every narration delta.
 *
 * An EMPTY state is NEVER written (#572, tightened by #573). Several surfaces share this
 * key, and a component that has not hydrated yet — or that re-hydrates on a driver-mode
 * flip — transiently holds zero entries; letting that write through erased the scrollback
 * another surface was about to load. #573 widened it from "never overwrites a non-empty
 * cache" to "never written at all", so that a key EXISTING means it holds real table
 * content: an empty placeholder key is worth nothing to read back, and it made a purge
 * look incomplete (a `reset` after a revoked-access 403 promptly recreated the key it had
 * just deleted). Clearing stays an explicit operation ({@link clearTranscript}).
 */
export function saveTranscript(
  viewerId: TranscriptViewerId,
  campaignId: number,
  state: TranscriptState,
  scope: TranscriptStorageScope = 'table',
  projection?: TranscriptCacheProjection,
): void {
  if (!hasStorage()) return;
  if (state.entries.length === 0) return;
  const key = transcriptStorageKey(viewerId, campaignId, scope);
  if (key === null || !isTranscriptRememberEnabled(viewerId)) return;
  try {
    const bounded =
      state.entries.length > MAX_TRANSCRIPT_ENTRIES
        ? { entries: state.entries.slice(state.entries.length - MAX_TRANSCRIPT_ENTRIES) }
        : state;
    window.localStorage.setItem(key, JSON.stringify({
      ...bounded,
      ...(projection === undefined ? {} : { projection }),
    }));
  } catch {
    /* quota / privacy mode — transcript is best-effort, not authoritative */
  }
}

/** Remove this viewer's persisted transcript for one campaign + scope. */
export function clearTranscript(
  viewerId: TranscriptViewerId,
  campaignId: number,
  scope: TranscriptStorageScope = 'table',
): void {
  if (!hasStorage()) return;
  const key = transcriptStorageKey(viewerId, campaignId, scope);
  if (key === null) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

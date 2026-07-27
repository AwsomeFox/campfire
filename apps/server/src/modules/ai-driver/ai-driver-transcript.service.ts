import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, lt, max } from 'drizzle-orm';
import {
  AI_DM_TRANSCRIPT_LIST_DEFAULT_LIMIT,
  AI_DM_TRANSCRIPT_LIST_MAX_LIMIT,
  AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS,
  type AiDmTranscriptEvent,
  type AiDmTranscriptEventKind,
  type AiDmTranscriptExport,
  type AiDmTranscriptPage,
  type AiDmTranscriptVisibility,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmTranscriptEvents } from '../../db/schema';
import { nowIso } from '../../common/time';
import { buildCursorListPage, clampListLimit, decodeCursorRaw, encodeCursor } from '../../common/cursor-pagination';
import { AiDmStreamService } from './ai-driver-stream.service';

/**
 * The authoritative multi-player AI-DM table transcript (issue #572).
 *
 * WHAT WAS BROKEN. The driver broadcast AI lifecycle/narration/tool events but never the
 * player action that PROVOKED them — only the sending browser inserted a local optimistic
 * entry. Everyone else at the table watched the AI answer a question they never saw. The
 * transcript itself lived in one browser's localStorage, so a reload, a late join, or a
 * dropped connection produced a materially different transcript per player, with no way to
 * recover the missing middle.
 *
 * THE THREE DESIGN DECISIONS THIS SERVICE ENCODES
 *
 * 1. ORDERING — `seq`, a per-campaign monotonic counter, assigned INSIDE the same
 *    synchronous better-sqlite3 transaction as the insert. Wall-clock `createdAt` is not
 *    a total order (two players can act in the same millisecond, and the AI's narration
 *    can be written in the same tick as the action it answers). The global autoincrement
 *    row id IS totally ordered, but it interleaves across campaigns, so a per-campaign
 *    cursor built on it would leak server-wide write volume and produce a jagged sequence
 *    no client can reason about. `seq` is the ordering key, the pagination cursor, and the
 *    reconnect watermark all at once: "I have through seq N" has exactly one answer, and
 *    it is gap-free WITHIN THE RETAINED WINDOW (see RETENTION below — a client offline
 *    long enough for its watermark to fall behind the pruned edge cannot be served events
 *    that no longer exist). UNIQUE (campaign_id, seq) turns any double-assignment into a
 *    loud failure instead of silent transcript corruption.
 *
 *    SINGLE-PROCESS ASSUMPTION. Assigning `seq` as MAX(seq)+1 is collision-free because
 *    better-sqlite3 runs the transaction synchronously to completion with no JS yield, so
 *    two record() calls cannot interleave inside one Node process — the same single-
 *    instance assumption the driver's in-memory session map and SSE Subject already make.
 *    Under a hypothetical multi-process deployment sharing one database file, two writers
 *    could read the same MAX(seq); the UNIQUE index would then reject the loser, and the
 *    best-effort catch below would log and drop that one transcript row rather than
 *    corrupt the sequence. Loud and lossy beats silent and wrong, but a multi-instance
 *    deployment would need a real allocator here.
 *
 * 2. DEDUP — `clientRef`, a token the SENDING client mints and POSTs with its action,
 *    echoed back verbatim on the persisted event. The sender replaces its optimistic entry
 *    in place; every other client just renders a new line. A content-equality heuristic
 *    would collapse two players who type "I attack" in the same round into one line, which
 *    is precisely the multi-player bug this issue is about.
 *
 * 3. REDACTION — enforced HERE, at the read/broadcast boundary, never in the client.
 *    `visibility` gives row-level withholding ('dm' rows are dropped for players and
 *    viewers before they reach the wire), and {@link projectAiDmToolEventForRole}'s
 *    existing rule is reused for field-level redaction of a hidden encounter id inside a
 *    tool payload. A player must not merely fail to RENDER a DM-only event they were
 *    already handed over the socket.
 *
 * RETENTION. A campaign keeps at most AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS rows; the
 * oldest are pruned in the same transaction as each insert, so the table is self-bounding
 * with no sweeper job. Rows cascade-delete with the campaign, and a DM can purge on demand
 * (DELETE /campaigns/:id/ai-dm/transcript) or export first (GET .../transcript/export).
 *
 * This bounds the recovery guarantee: a client whose watermark falls below the pruned edge
 * (offline across more than the cap's worth of events in one campaign) will be served the
 * retained window and silently skip the pruned middle, because those events are genuinely
 * deleted. Detecting that case would need a server-side signal — a client cannot infer it
 * from seq continuity, since role redaction legitimately removes seqs from a player's view.
 */

/** Backward-scrollback cursor: "older than this seq", newest-first keyset paging. */
export type AiDmTranscriptCursor = { v: 1; b: number };

export function encodeAiDmTranscriptCursor(cursor: AiDmTranscriptCursor): string {
  return encodeCursor(cursor);
}

export function decodeAiDmTranscriptCursor(raw: string | undefined): AiDmTranscriptCursor | undefined {
  const parsed = decodeCursorRaw(raw);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== 'object') throw new BadRequestException('`cursor` is invalid');
  const c = parsed as Record<string, unknown>;
  if (c.v !== 1 || typeof c.b !== 'number' || !Number.isInteger(c.b) || c.b <= 0) {
    throw new BadRequestException('`cursor` is invalid or does not match this list');
  }
  return { v: 1, b: c.b };
}

export function clampAiDmTranscriptLimit(limit?: number): number {
  return clampListLimit(limit, AI_DM_TRANSCRIPT_LIST_DEFAULT_LIMIT, AI_DM_TRANSCRIPT_LIST_MAX_LIMIT);
}

/** What a caller hands {@link AiDmTranscriptService.record}; `seq`/`eventId`/`at` are the server's. */
export interface RecordTranscriptInput {
  campaignId: number;
  kind: AiDmTranscriptEventKind;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  actorName?: string | null;
  clientRef?: string | null;
  turnId?: string | null;
  /** Row-level redaction. Defaults to 'all' — every table event is table-visible unless stated. */
  visibility?: AiDmTranscriptVisibility;
}

type TranscriptRow = typeof aiDmTranscriptEvents.$inferSelect;

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toDomain(row: TranscriptRow): AiDmTranscriptEvent {
  return {
    eventId: row.eventId,
    seq: row.seq,
    campaignId: row.campaignId,
    kind: row.kind as AiDmTranscriptEventKind,
    actorUserId: row.actorUserId ?? null,
    actorName: row.actorName ?? null,
    clientRef: row.clientRef ?? null,
    turnId: row.turnId ?? null,
    payload: parsePayload(row.payload),
    at: row.createdAt,
  };
}

/**
 * The SINGLE role-redaction boundary for transcript events (#572 / #825 / #262).
 *
 * Returns `null` when the whole event must be withheld from this role, or a projected copy
 * with DM-only FIELDS removed. Both the paged/export reads and the SSE broadcast funnel
 * through this, so there is exactly one place to get redaction right — and no path where a
 * player receives a DM-only event and is merely trusted not to draw it.
 */
export function projectTranscriptEventForRole(
  event: AiDmTranscriptEvent,
  visibility: AiDmTranscriptVisibility,
  role: Role,
): AiDmTranscriptEvent | null {
  const isDm = role === 'dm';
  if (visibility === 'dm' && !isDm) return null;

  // Field-level: a `tool` event carries the encounter it mutated plus an INTERNAL
  // `encounterHidden` hint. Non-DMs never learn a DM-prep encounter's id, and the hint
  // itself never leaves the server for anyone.
  const { encounterHidden, encounterId, ...restPayload } = event.payload as {
    encounterHidden?: unknown;
    encounterId?: unknown;
  } & Record<string, unknown>;
  if (encounterHidden === undefined && encounterId === undefined) return event;

  const reveal = encounterId !== undefined && (isDm || encounterHidden !== true);
  return { ...event, payload: reveal ? { ...restPayload, encounterId } : restPayload };
}

/**
 * The kinds that carry NARRATIVE continuity — what was said at the table (#1038).
 *
 * Everything else the transcript records is operational rather than story: `tool` rows are
 * thin "the AI called X" signals whose actual effect is already re-read fresh into the
 * world-state prompt sections every turn, `turn.ended` is token/stop-reason bookkeeping,
 * and `control`/`vote` are seat administration. Replaying those would spend the history
 * budget on text that cannot help the model narrate coherently, and would teach it to
 * imitate bookkeeping lines in its prose.
 */
export const AI_DM_PROMPT_HISTORY_KINDS: readonly AiDmTranscriptEventKind[] = ['player.action', 'narration'];

/**
 * The history projection used to PROMPT THE MODEL (#1038) — deliberately NOT the projection
 * served to a player, and narrower than both of the role projections above.
 *
 * WHY IT IS ITS OWN PROJECTION. {@link projectTranscriptEventForRole} answers "what may this
 * HUMAN see". This answers "what may the MODEL be told", and the two are different questions
 * with different failure modes: too little and the AI is amnesiac (the bug #1038 reports),
 * too much and DM-only material enters a context whose entire output streams to every player
 * and viewer at the table.
 *
 * It resolves that by taking the PLAYER-VISIBLE slice, not the DM one — `visibility: 'dm'`
 * rows are excluded even though the seat runs with DM authority. That follows the rule #387
 * already established for the rest of this prompt: the system prompt is assembled through a
 * player-scoped toolset precisely so "the narration that streams to every player and viewer
 * therefore cannot contain a secret the model was never handed". History is prompt context
 * like any other, so it obeys the same rule.
 *
 * Nothing narrative is lost by that choice. Today the ONLY `visibility: 'dm'` rows are
 * secret-read approval control lines, which name a hidden entity and record access-control
 * bookkeeping — they are not story, and {@link AI_DM_PROMPT_HISTORY_KINDS} would drop them
 * anyway. The visibility filter is belt-and-braces so that a future DM-only NARRATION row
 * cannot silently start leaking into player-visible prose.
 */
export function isPromptHistoryEvent(kind: string, visibility: AiDmTranscriptVisibility): boolean {
  return visibility === 'all' && (AI_DM_PROMPT_HISTORY_KINDS as readonly string[]).includes(kind);
}

@Injectable()
export class AiDmTranscriptService {
  private readonly logger = new Logger(AiDmTranscriptService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly stream: AiDmStreamService,
  ) {}

  /**
   * Persist ONE transcript event and broadcast it, in that order.
   *
   * The seq assignment, the insert, and the retention prune run in a single SYNCHRONOUS
   * better-sqlite3 transaction — nothing can interleave between reading MAX(seq) and
   * claiming it, so two concurrent player actions can never share a sequence number.
   * The SSE frame is emitted only AFTER the row commits, so a client that reconnects and
   * asks for "everything after seq N" can never be told about an event that was never
   * durably written, nor miss one another client already rendered.
   *
   * Best-effort by design: a transcript write must never take down a live turn. A failure
   * is logged and the driver keeps narrating — the table degrades to the pre-#572 behaviour
   * for that one event rather than dropping the player's turn on the floor.
   */
  record(input: RecordTranscriptInput): AiDmTranscriptEvent | null {
    const visibility: AiDmTranscriptVisibility = input.visibility ?? 'all';
    const eventId = randomUUID();
    const at = nowIso();

    let row: AiDmTranscriptEvent;
    try {
      row = this.db.transaction((tx) => {
        // Single-row read: SELECT MAX(...) always yields exactly one row (`value` NULL when
        // the campaign has no events yet), so `.get()` states the intent and matches the
        // repo convention for scalar reads inside a transaction. The `?.` still guards the
        // no-row case rather than assuming SQLite's shape.
        const highest = tx
          .select({ value: max(aiDmTranscriptEvents.seq) })
          .from(aiDmTranscriptEvents)
          .where(eq(aiDmTranscriptEvents.campaignId, input.campaignId))
          .get();
        const seq = (highest?.value ?? 0) + 1;

        tx.insert(aiDmTranscriptEvents)
          .values({
            campaignId: input.campaignId,
            seq,
            eventId,
            kind: input.kind,
            actorUserId: input.actorUserId ?? null,
            actorName: input.actorName ?? null,
            clientRef: input.clientRef ?? null,
            turnId: input.turnId ?? null,
            payload: JSON.stringify(input.payload ?? {}),
            visibility,
            createdAt: at,
          })
          .run();

        // Retention, in the same transaction: keep the newest N (including the row just
        // written), drop everything older. Cheap — it is the same (campaign_id, seq)
        // keyset the reads use, so no sweeper job is needed.
        const oldestKept = seq - AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS + 1;
        if (oldestKept > 1) {
          tx.delete(aiDmTranscriptEvents)
            .where(
              and(
                eq(aiDmTranscriptEvents.campaignId, input.campaignId),
                lt(aiDmTranscriptEvents.seq, oldestKept),
              ),
            )
            .run();
        }

        return {
          eventId,
          seq,
          campaignId: input.campaignId,
          kind: input.kind,
          actorUserId: input.actorUserId ?? null,
          actorName: input.actorName ?? null,
          clientRef: input.clientRef ?? null,
          turnId: input.turnId ?? null,
          payload: input.payload ?? {},
          at,
        } satisfies AiDmTranscriptEvent;
      });
    } catch (err) {
      // Never let transcript bookkeeping abort a live turn (see doc comment).
      this.logger.warn(
        `AI-DM transcript write failed for campaign ${input.campaignId} (${input.kind}): ${String(err)}`,
      );
      return null;
    }

    this.stream.emit({ type: 'transcript', campaignId: input.campaignId, event: row, visibility });
    return row;
  }

  /**
   * Read a role-projected page of the transcript.
   *
   * Two access patterns, both keyed on `seq`:
   *   - LATE JOIN / SCROLLBACK — no `after`: returns the NEWEST `limit` events (ascending,
   *     so the caller can render them directly) with `nextCursor` paging further BACK.
   *   - RECONNECT / GAP-FILL — `after: N`: returns events with seq > N ascending, so a
   *     client that dropped off replays exactly what it missed and nothing else.
   *
   * ROW-level redaction is applied IN SQL, before the page is cut, so a player's page is
   * never silently short and `hasMore`/`nextCursor` always describe the sequence that
   * player can actually see. FIELD-level redaction (a hidden encounter id inside a tool
   * payload) is then applied per row, which cannot drop a row.
   */
  /**
   * The newest narrative history for a campaign, oldest-first, for PROMPTING (#1038).
   *
   * Synchronous by design: it runs inside `runTurn`'s hot path right before the provider
   * call, and better-sqlite3 reads are synchronous anyway — making it async would only add
   * a scheduling hop between "reserve the turn" and "send the prompt".
   *
   * `beforeSeq` excludes the action being answered THIS turn, which is already persisted by
   * the time the prompt is assembled (#572 records an accepted action before the AI replies).
   * Without it the live message would also appear as the last line of its own history.
   *
   * Selection happens in SQL — the visibility and kind filters are a WHERE clause, not a
   * post-filter — so a row this projection excludes is never even loaded, and `limit` counts
   * only rows that could actually be used.
   */
  listForPrompt(campaignId: number, opts: { limit: number; beforeSeq?: number } = { limit: 0 }): AiDmTranscriptEvent[] {
    if (opts.limit <= 0) return [];
    const conds = [
      eq(aiDmTranscriptEvents.campaignId, campaignId),
      eq(aiDmTranscriptEvents.visibility, 'all'),
      inArray(aiDmTranscriptEvents.kind, [...AI_DM_PROMPT_HISTORY_KINDS]),
    ];
    if (opts.beforeSeq !== undefined) conds.push(lt(aiDmTranscriptEvents.seq, opts.beforeSeq));
    // Newest-first with a LIMIT is what makes this cheap on a long campaign; reversed here
    // so the caller always receives chronological order.
    const rows = this.db
      .select()
      .from(aiDmTranscriptEvents)
      .where(and(...conds))
      .orderBy(desc(aiDmTranscriptEvents.seq))
      .limit(opts.limit)
      .all();
    return rows.reverse().map(toDomain);
  }

  /** How many events {@link listForPrompt} could draw on — the session's `historyLength` (#1038). */
  promptHistoryDepth(campaignId: number): number {
    const row = this.db
      .select({ value: count() })
      .from(aiDmTranscriptEvents)
      .where(
        and(
          eq(aiDmTranscriptEvents.campaignId, campaignId),
          eq(aiDmTranscriptEvents.visibility, 'all'),
          inArray(aiDmTranscriptEvents.kind, [...AI_DM_PROMPT_HISTORY_KINDS]),
        ),
      )
      .get();
    return row?.value ?? 0;
  }

  async list(
    campaignId: number,
    role: Role,
    opts: { limit?: number; cursor?: string; after?: number } = {},
  ): Promise<AiDmTranscriptPage> {
    const limit = clampAiDmTranscriptLimit(opts.limit);
    const forward = opts.after !== undefined;
    const cursor = decodeAiDmTranscriptCursor(opts.cursor);

    const scope = [eq(aiDmTranscriptEvents.campaignId, campaignId)];
    if (role !== 'dm') scope.push(eq(aiDmTranscriptEvents.visibility, 'all'));

    const pageConds = [...scope];
    if (forward) pageConds.push(gt(aiDmTranscriptEvents.seq, opts.after!));
    else if (cursor) pageConds.push(lt(aiDmTranscriptEvents.seq, cursor.b));

    const [countRows, fetched] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(aiDmTranscriptEvents)
        .where(and(...scope)),
      this.db
        .select()
        .from(aiDmTranscriptEvents)
        // Forward gap-fill reads oldest-first; scrollback reads newest-first and is
        // reversed below, so BOTH shapes hand the caller ascending seq order.
        .where(and(...pageConds))
        .orderBy(forward ? asc(aiDmTranscriptEvents.seq) : desc(aiDmTranscriptEvents.seq))
        .limit(limit + 1),
    ]);

    const total = countRows[0]?.value ?? 0;
    // Build the envelope from the rows (already row-redacted in SQL) so the cursor always
    // points at a row this reader is allowed to continue from.
    const page = buildCursorListPage(fetched, limit, total, (last) => ({ v: 1, b: last.seq }));
    const ordered = forward ? page.items : [...page.items].reverse();
    const items = ordered
      .map((row) => projectTranscriptEventForRole(toDomain(row), row.visibility as AiDmTranscriptVisibility, role))
      .filter((e): e is AiDmTranscriptEvent => e !== null);

    return {
      items,
      total,
      // Forward gap-fill continues by re-asking with the last seq, not with an opaque
      // cursor — a reconnecting client already knows its watermark.
      hasMore: page.hasMore,
      nextCursor: forward ? null : page.nextCursor,
      limit,
    };
  }

  /**
   * Everything the campaign still retains, role-projected exactly like a paged read.
   * An export is a copy of what you may already see — never a redaction back door.
   */
  async exportAll(campaignId: number, role: Role): Promise<AiDmTranscriptExport> {
    const scope = [eq(aiDmTranscriptEvents.campaignId, campaignId)];
    if (role !== 'dm') scope.push(eq(aiDmTranscriptEvents.visibility, 'all'));
    const rows = await this.db
      .select()
      .from(aiDmTranscriptEvents)
      .where(and(...scope))
      .orderBy(asc(aiDmTranscriptEvents.seq));
    return {
      campaignId,
      exportedAt: nowIso(),
      retentionMaxEvents: AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS,
      events: rows
        .map((row) => projectTranscriptEventForRole(toDomain(row), row.visibility as AiDmTranscriptVisibility, role))
        .filter((e): e is AiDmTranscriptEvent => e !== null),
    };
  }

  /**
   * Erase a campaign's transcript (the DM's deletion lever).
   *
   * Wiping every row also resets the per-campaign `seq` to 1, which would strand any
   * connected client still holding a watermark from the old sequence — it would ask for
   * "everything after 400" forever and be told, correctly, that there is nothing. So the
   * purge broadcasts a `transcript.reset` frame: every open table drops its transcript and
   * refetches from scratch, which is also the honest UI for "the DM erased the log".
   */
  async purge(campaignId: number): Promise<number> {
    const result = await this.db
      .delete(aiDmTranscriptEvents)
      .where(eq(aiDmTranscriptEvents.campaignId, campaignId));
    const deleted = (result as unknown as { changes?: number }).changes ?? 0;
    this.stream.emit({ type: 'transcript.reset', campaignId });
    return deleted;
  }
}

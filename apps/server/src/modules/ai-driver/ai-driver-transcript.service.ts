import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, lt, max } from 'drizzle-orm';
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
 *    reconnect watermark all at once: "I have through seq N" has exactly one gap-free
 *    answer. UNIQUE (campaign_id, seq) turns any double-assignment into a loud failure
 *    instead of silent transcript corruption.
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

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, count, ne } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ScheduledSessionCreate,
  ScheduledSessionCancel,
  ScheduledSessionDuplicate,
  ScheduledSessionUpdate,
  RsvpSet,
  diffScheduleNotificationFields,
  shouldNotifyScheduleUpdate,
  scheduleNotificationChangeType,
  scheduleNotificationFallbackTitle,
  scheduleNotificationFallbackBody,
  scheduleNotificationLabel,
  isValidIanaTimeZone,
  utcToLocalDateTime,
  type ScheduleNotificationData,
} from '@campfire/schema';
import type { ScheduledSession, ScheduledSessionRestored, ScheduledSessionWithRsvps, ScheduledSessionListPage, SessionRsvp, CalendarFeed, Role, PageParams } from '@campfire/schema';
import { SCHEDULE_PAST_DEFAULT_LIMIT, SCHEDULE_PAST_MAX_LIMIT } from '@campfire/schema';
import { applyPage } from '../../common/pagination';
import { DB, type DrizzleDb } from '../../db/db.module';
import { scheduledSessions, sessionRsvps, campaigns, sessions, notificationReminders, seriesExceptions, sessionSeries } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { generateIcsFeedToken, looksLikeIcsFeedToken } from '../../common/crypto';
import { resolveIcsFeedTokenTtlDays } from '../../common/throttle.constants';
import { foldForSearch, foldedIncludes } from '../../common/text-search';
import { nextUpdatedAt, staleWrite } from '../../common/stale-write';
import { AuditService } from '../audit/audit.service';
import { RevisionsService } from '../revisions/revisions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RoleResolver } from '../membership/role-resolver.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { buildCampaignIcs, legacyIcsUid } from './ics.util';
import {
  scheduleInProgressSql,
  scheduleLiveSql,
  scheduleNotEndedSql,
  schedulePastSql,
  scheduleUpcomingOnlySql,
} from './scheduling-queries';
// #588: restoring a cancelled night re-acquires the room/DM the cancellation
// released, so it runs the same booking probe as the organized-play endpoints.
import {
  SeriesConflictSignal,
  endInstant,
  findConflictRows,
  holdsBookableResource,
  lookupConflictNames,
  redactConflicts,
  type RawConflict,
} from './schedule-conflicts';

const PAST_LIST_MAX = SCHEDULE_PAST_MAX_LIMIT;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Absolute expiry ISO for a feed token minted right now (issue #554). */
function icsFeedTokenExpiryFromNow(): string {
  return new Date(Date.now() + resolveIcsFeedTokenTtlDays() * DAY_MS).toISOString();
}

/** True iff `expiresAt` (ISO UTC) is in the past. Null = never expires (legacy rows). */
function icsTokenIsExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

/**
 * The RFC 5545 RECURRENCE-ID analogue for one occurrence: the local date it was
 * ORIGINALLY materialized on — never the date it currently sits on (#588).
 *
 * `local_start` is the MOVED wall clock once an occurrence has been rescheduled,
 * so deriving the recurrence id from it gave one logical occurrence a different
 * id in every ledger entry written after its first move. Lining those entries up
 * is the entire job of the ledger, so the id has to come from an anchor that does
 * not move: `original_scheduled_at` is stamped once at materialization and
 * preserved across every later reschedule. For an occurrence that has never
 * moved the two agree exactly, so entries written before this change still line
 * up with entries written after it.
 *
 * The ZONE has to be pinned for exactly the same reason the instant does, and
 * `seriesTimezone` is what pins it. `rescheduleOccurrence` accepts and persists
 * `input.timezone`, so the occurrence's own `timezone` column is as mutable as
 * its wall clock: move a late-night Los Angeles occurrence and re-label it
 * Pacific/Kiritimati (+21h) and the very next ledger entry re-reads the SAME
 * anchor instant in the new zone and lands on the following local date — one
 * logical occurrence, two recurrence ids again, just reached by a different
 * route than the one `original_scheduled_at` closed. A series' zone, by
 * contrast, is immutable: `updateSeries` never writes `timezone`, because the
 * recurrence rule is immutable after creation. So the series is the anchor for
 * both halves of the id. Falls back to the row's own zone for a one-off or a
 * legacy row that belongs to no series, where nothing can drift anyway.
 */
export function recurrenceLocalDateFor(
  row: {
    originalScheduledAt: string | null;
    scheduledAt: string;
    timezone: string;
    localStart: string;
  },
  seriesTimezone?: string,
): string {
  const anchor = row.originalScheduledAt ?? row.scheduledAt;
  const zone = seriesTimezone || row.timezone;
  if (zone) return utcToLocalDateTime(anchor, zone).slice(0, 10);
  // No explicit zone (a legacy row adopted into a series): fall back to the
  // stored wall clock, then to the UTC date, so the column is never blank when
  // a date is derivable at all.
  return row.localStart.slice(0, 10) || anchor.slice(0, 10);
}

/**
 * The immutable zone of the series an occurrence belongs to, read inside the
 * caller's transaction. `''` when the series has vanished — {@link
 * recurrenceLocalDateFor} then falls back to the row's own zone.
 */
export function seriesTimezoneInTx(tx: SyncDb, seriesId: number): string {
  const [row] = tx.select({ timezone: sessionSeries.timezone }).from(sessionSeries).where(eq(sessionSeries.id, seriesId)).limit(1).all();
  return row?.timezone ?? '';
}

/** ScheduledSessionCreate's duration bounds — a NEW live night is at least 15 minutes. */
const CREATE_MIN_DURATION_MINUTES = 15;
const CREATE_MAX_DURATION_MINUTES = 24 * 60;

/** Clamp a copied duration into the create-time window (see duplicate()). */
function clampToCreateDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) return CREATE_MIN_DURATION_MINUTES;
  return Math.min(CREATE_MAX_DURATION_MINUTES, Math.max(CREATE_MIN_DURATION_MINUTES, Math.floor(minutes)));
}

type ScheduledSessionCreateInput = z.infer<typeof ScheduledSessionCreate>;
type ScheduledSessionUpdateInput = z.infer<typeof ScheduledSessionUpdate>;
type ScheduledSessionCancelInput = z.infer<typeof ScheduledSessionCancel>;
type ScheduledSessionDuplicateInput = z.infer<typeof ScheduledSessionDuplicate>;
type RsvpSetInput = z.infer<typeof RsvpSet>;
export type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** Result of the row-level half of a schedule↔session link (#504). */
export type LinkSessionOutcome = { campaignId: number; linked: boolean; wasPreviouslyCompleted: boolean };

/** Result of the row-level half of a schedule↔session unlink (#504). */
export type UnlinkSessionOutcome = { campaignId: number; scheduleIds: number[] };

/**
 * Row -> API shape. Exported (issue #588) so the organized-play layer projects
 * occurrences through exactly the same mapper the Schedule tab uses — a second
 * hand-written mapper is how two views of one row start disagreeing.
 */
export function scheduledSessionToDomain(row: typeof scheduledSessions.$inferSelect): ScheduledSession {
  return {
    id: row.id,
    campaignId: row.campaignId,
    scheduledAt: row.scheduledAt,
    durationMinutes: row.durationMinutes,
    title: row.title,
    location: row.location,
    notes: row.notes,
    status: row.status as ScheduledSession['status'],
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    sessionId: row.sessionId,
    // Organized-play decoration (#588) — empty/absent on every row that never
    // opted in, which is what keeps this feature invisible to existing tables.
    seriesId: row.seriesId,
    occurrenceIndex: row.occurrenceIndex,
    timezone: row.timezone,
    localStart: row.localStart,
    venueId: row.venueId,
    roomId: row.roomId,
    assignedDmUserId: row.assignedDmUserId,
    capacity: row.capacity,
    eventId: row.eventId,
    seasonId: row.seasonId,
    icsUid: row.icsUid,
    icsSequence: row.icsSequence,
    originalScheduledAt: row.originalScheduledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const toDomain = scheduledSessionToDomain;

/**
 * Which of these rows' linked recaps are still readable (not trashed)?
 * One batched query; skipped entirely when nothing is linked.
 *
 * Exported (issue #1601) so the organized-play layer's set reads reconcile the
 * schedule↔recap link through the SAME query the Schedule tab uses — a second
 * hand-written "is this recap live?" check is how series detail started
 * disagreeing with the calendar and the Schedule tab.
 */
export async function liveLinkedSessionIds(
  db: DrizzleDb,
  rows: Array<typeof scheduledSessions.$inferSelect>,
): Promise<Set<number>> {
  const linkedIds = [...new Set(rows.map((r) => r.sessionId).filter((id): id is number => id != null))];
  if (linkedIds.length === 0) return new Set();
  const live = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(inArray(sessions.id, linkedIds), notDeleted(sessions.deletedAt)));
  return new Set(live.map((r) => r.id));
}

/**
 * Read-time reconciliation of the schedule↔recap link (#504) — the single
 * definition of "effective status" and "effective sessionId" for one row.
 *
 * Exported (issue #1601) so every surface that answers "what is this night?"
 * can share it. See projectLinkOnService() below for the full reasoning; this
 * module-level copy is what set-based reads (getSeries, occurrence write
 * results) must project through, exactly as attachRsvps already does.
 */
export function projectLink(
  row: typeof scheduledSessions.$inferSelect,
  liveLinkedIds: Set<number>,
): ScheduledSession {
  const domain = toDomain(row);
  // A cancelled night is not a played night, so it must not render a "Recap" link.
  //
  // Reachable since remove() started using the EFFECTIVE status (#504): a future
  // `completed` row whose recap is trashed reads as `scheduled`, so the DM can cancel
  // it — and cancel deliberately leaves `session_id` alone. Untrash the recap later
  // and the raw row is `cancelled` WITH a live link, which the Schedule tab would
  // render as a "Cancelled" tag beside a working "Recap" link.
  //
  // Fixed at READ time rather than by clearing the link on cancel. Clearing it would
  // have to clear the recap's reciprocal `scheduled_session_id` too (otherwise it is
  // the one-directional dangling link this file works hard to avoid), which means
  // cancelling a night would silently and permanently destroy a recap↔night
  // association nobody asked to remove — trading a cosmetic contradiction for real
  // data loss, and breaking the invariant the whole fix rests on: the stored link
  // survives so untrashing heals the row with no repair write. Restoring the
  // SCHEDULE brings the link straight back, because nothing was thrown away.
  if (domain.status === 'cancelled') return { ...domain, sessionId: null };
  if (domain.sessionId == null || liveLinkedIds.has(domain.sessionId)) return domain;
  return {
    ...domain,
    sessionId: null,
    status: domain.status === 'completed' ? 'scheduled' : domain.status,
  };
}

/**
 * Reconcile a set of scheduled rows to their API shapes in ONE batched query
 * (issue #1601). getSeries and the occurrence write-result paths used to copy
 * the RAW `status` column, so a completed night whose recap was trashed showed
 * `completed` in series detail while the coordinator calendar
 * (scheduleEffectiveStatusSql) and the Schedule tab (projectLink) both showed
 * `scheduled`. This is the set read's way onto the same projection those two
 * already share: the live-linked recap ids are fetched once, then each row is
 * projected through projectLink — status AND sessionId reconciled — so series
 * detail can no longer be the one surface that disagrees.
 */
export async function reconcileScheduledSessions(
  db: DrizzleDb,
  rows: Array<typeof scheduledSessions.$inferSelect>,
): Promise<ScheduledSession[]> {
  if (rows.length === 0) return [];
  const liveLinks = await liveLinkedSessionIds(db, rows);
  return rows.map((row) => projectLink(row, liveLinks));
}

function rsvpToDomain(row: typeof sessionRsvps.$inferSelect): SessionRsvp {
  return {
    id: row.id,
    scheduledSessionId: row.scheduledSessionId,
    userId: row.userId,
    userName: row.userName,
    status: row.status as SessionRsvp['status'],
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Relative feed path for a token — the web app prefixes window.location.origin. */
export function icsFeedUrl(token: string): string {
  return `/api/v1/calendar/${token}.ics`;
}

/**
 * Session scheduling (issue #13): planned game nights with per-member
 * availability (RSVPs), plus the per-campaign ICS calendar feed. Lives beside
 * SessionsService — schedules are the *future* half of the sessions feature
 * (SessionsService owns the past: play logs/recaps).
 */
@Injectable()
export class SchedulingService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    // #588: restore() reports what forcing it overrode, and the list is redacted
    // per caller — which needs the caller's campaign scope.
    private readonly roles: RoleResolver,
    private readonly events: CampaignEventsService,
    private readonly revisions: RevisionsService,
  ) {}

  /** Push one permission-safe invalidation signal for every schedule projection change. */
  private emitScheduleUpdated(campaignId: number, scheduleId: number): void {
    this.events.emit({ type: 'schedule.updated', campaignId, scheduleId });
  }

  /** Human label for a scheduled game night — its title, or a date fallback. */
  private scheduleLabel(row: { title?: string | null }): string {
    return scheduleNotificationLabel(row.title);
  }

  /** Build structured schedule lifecycle notification payload (issue #820). */
  private scheduleNotificationData(input: {
    scheduleId: number;
    scheduledAt: string;
    durationMinutes: number;
    title: string;
    changeType: ScheduleNotificationData['changeType'];
    changedFields?: ScheduleNotificationData['changedFields'];
  }): ScheduleNotificationData {
    return {
      kind: 'schedule',
      scheduleId: input.scheduleId,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      changeType: input.changeType,
      changedFields: input.changedFields ?? [],
      label: (input.title ?? '').trim(),
    };
  }

  private async notifyScheduleLifecycle(
    campaignId: number,
    user: RequestUser,
    data: ScheduleNotificationData,
  ): Promise<void> {
    await this.notifications.notifyCampaign(campaignId, user, {
      type: 'session_scheduled',
      title: scheduleNotificationFallbackTitle(data),
      body: scheduleNotificationFallbackBody(data),
      // entityId alone (no EntityType for scheduled_session) — the bell routes
      // session_scheduled to the Schedule tab and focuses this card (#446), or a
      // cancelled-event detail when changeType is cancelled (#820).
      entityId: data.scheduleId,
      actorName: user.name,
      data,
    });
  }

  // ----- scheduled sessions -----

  private groupRsvps(rows: Array<typeof sessionRsvps.$inferSelect>): Map<number, SessionRsvp[]> {
    const map = new Map<number, SessionRsvp[]>();
    for (const row of rows) {
      const list = map.get(row.scheduledSessionId) ?? [];
      list.push(rsvpToDomain(row));
      map.set(row.scheduledSessionId, list);
    }
    return map;
  }

  private async attachRsvps(
    rows: Array<typeof scheduledSessions.$inferSelect>,
    reconcileLinks = true,
  ): Promise<ScheduledSessionWithRsvps[]> {
    if (rows.length === 0) return [];
    const [rsvpRows, liveLinks] = await Promise.all([
      this.db
        .select()
        .from(sessionRsvps)
        .where(inArray(sessionRsvps.scheduledSessionId, rows.map((r) => r.id))),
      reconcileLinks ? this.liveLinkedSessionIds(rows) : Promise.resolve(new Set<number>()),
    ]);
    const grouped = this.groupRsvps(rsvpRows);
    return rows.map((row) => ({
      ...(reconcileLinks ? this.projectLink(row, liveLinks) : toDomain(row)),
      rsvps: grouped.get(row.id) ?? [],
    }));
  }

  /**
   * Which of these rows' linked recaps are still readable (not trashed)?
   * One batched query; skipped entirely when nothing is linked.
   *
   * Delegates to the exported twin (issue #1601) so the set-based organized-play
   * reads share one query and cannot drift from the Schedule tab's notion of
   * "is this recap live?".
   */
  private async liveLinkedSessionIds(rows: Array<typeof scheduledSessions.$inferSelect>): Promise<Set<number>> {
    return liveLinkedSessionIds(this.db, rows);
  }

  /**
   * Read-time reconciliation of the schedule↔recap link (#504) — the service's
   * thin delegate to the exported twin (issue #1601). See projectLink()'s
   * docblock for the full reasoning; this exists only so this class's private
   * call sites keep a `this.` shape, with no second copy of the rules.
   */
  private projectLink(row: typeof scheduledSessions.$inferSelect, liveLinkedIds: Set<number>): ScheduledSession {
    return projectLink(row, liveLinkedIds);
  }

  /**
   * The lifecycle status a WRITE guard must reason about (#504).
   *
   * Reads reconcile a `completed` row whose recap is trashed back to `scheduled`
   * (projectLink), and scheduleLiveSql() deliberately keeps such a row in the
   * live/Upcoming projection, so the web renders it as an ordinary upcoming game
   * night with full RSVP + Cancel controls. A guard that consults the RAW `status`
   * column therefore rejects the exact actions the UI is offering — the player's
   * RSVP and the DM's Cancel both 400 on a card that looks completely normal.
   *
   * There is one definition of "effective status" and it is projectLink()'s; this
   * helper only applies it to a single row, so reads and writes cannot drift apart.
   */
  private async effectiveStatusOf(
    row: typeof scheduledSessions.$inferSelect,
  ): Promise<ScheduledSession['status']> {
    const liveLinks = await this.liveLinkedSessionIds([row]);
    return this.projectLink(row, liveLinks).status;
  }

  /** Point read for a write path: the raw row (for its stored fields) + its effective status. */
  private async getRowWithEffectiveStatus(id: number): Promise<{
    row: typeof scheduledSessions.$inferSelect;
    status: ScheduledSession['status'];
  }> {
    const row = await this.getRowOrThrow(id);
    return { row, status: await this.effectiveStatusOf(row) };
  }

  /** Full schedule list — kept for export/MCP backward compatibility. Prefer upcoming/past splits (#612). */
  async listForCampaign(campaignId: number): Promise<ScheduledSessionWithRsvps[]> {
    const rows = await this.db
      .select()
      .from(scheduledSessions)
      .where(eq(scheduledSessions.campaignId, campaignId))
      .orderBy(asc(scheduledSessions.scheduledAt));
    return this.attachRsvps(rows);
  }

  /**
   * Archive read for campaign export: the RAW stored rows, deliberately NOT
   * link-reconciled (#504).
   *
   * Every other read reconciles a `completed` row whose recap is trashed back to
   * `scheduled`, because that is the honest thing to SHOW. An archive is not a view: it
   * must record what the database actually holds. Reconciling here would let a recap
   * that merely happened to be in the trash at export time permanently downgrade a
   * completed night to `scheduled` in the portable copy — the trash is reversible, but
   * the export would not be.
   */
  async listForExport(campaignId: number): Promise<ScheduledSessionWithRsvps[]> {
    const rows = await this.db
      .select()
      .from(scheduledSessions)
      .where(eq(scheduledSessions.campaignId, campaignId))
      .orderBy(asc(scheduledSessions.scheduledAt));
    return this.attachRsvps(rows, false);
  }

  /**
   * Live schedule projection: in-progress + upcoming nights, soonest-first (#612).
   * Queries only not-yet-ended rows instead of loading full history.
   */
  async listUpcomingForCampaign(campaignId: number, nowMs: number = Date.now()): Promise<ScheduledSessionWithRsvps[]> {
    const nowIso = new Date(nowMs).toISOString();
    const rows = await this.db
      .select()
      .from(scheduledSessions)
      .where(and(eq(scheduledSessions.campaignId, campaignId), scheduleLiveSql(), scheduleNotEndedSql(nowIso)))
      .orderBy(asc(scheduledSessions.scheduledAt));
    return this.attachRsvps(rows);
  }

  /**
   * Ended scheduled nights, most-recent first, paginated (#612).
   */
  async listPastForCampaign(
    campaignId: number,
    page?: PageParams,
    nowMs: number = Date.now(),
  ): Promise<ScheduledSessionListPage> {
    const limit =
      page?.limit !== undefined
        ? Math.min(Math.max(1, Math.floor(page.limit)), PAST_LIST_MAX)
        : SCHEDULE_PAST_DEFAULT_LIMIT;
    const offset = page?.offset !== undefined ? Math.max(0, Math.floor(page.offset)) : 0;
    const nowIso = new Date(nowMs).toISOString();
    const where = and(eq(scheduledSessions.campaignId, campaignId), schedulePastSql(nowIso));

    const [{ value: total }] = await this.db.select({ value: count() }).from(scheduledSessions).where(where);

    let q = this.db
      .select()
      .from(scheduledSessions)
      .where(where)
      .orderBy(desc(scheduledSessions.scheduledAt))
      .$dynamic();
    q = applyPage(q, { limit, offset });
    const rows = await q;
    const items = await this.attachRsvps(rows);
    return {
      items,
      total,
      hasMore: offset + items.length < total,
      limit,
      offset,
    };
  }

  /**
   * Bounded campaign-search read. Scheduled-session title, canonical ISO date/time,
   * and party-visible notes are searchable; RSVP rows are deliberately excluded so
   * search cannot grow with party size or expose availability snippets.
   */
  async searchForCampaign(campaignId: number, needle: string, limit: number): Promise<ScheduledSession[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    // SearchService passes an already-folded needle; fold again for idempotent callers (#624).
    const folded = foldForSearch(needle.trim());
    if (!folded) return [];
    // Fold-match in JS — SQLite lower()/instr is ASCII-only (#624).
    const rows = await this.db
      .select()
      .from(scheduledSessions)
      .where(eq(scheduledSessions.campaignId, campaignId))
      .orderBy(asc(scheduledSessions.scheduledAt), asc(scheduledSessions.id));
    const matches = rows.filter(
      (r) =>
        foldedIncludes(r.title, folded)
        || foldedIncludes(r.scheduledAt, folded)
        || foldedIncludes(r.notes, folded),
    );
    // Same read-time link reconciliation as every other projection: search must not
    // hand back a sessionId pointing at a trashed recap either.
    const liveLinks = await this.liveLinkedSessionIds(matches);
    return (
      matches
        .map((row) => this.projectLink(row, liveLinks))
        // Cancelled nights are excluded (#504). Before this issue, cancelling HARD-
        // DELETED the row, so search never returned one; retaining the row for the
        // Schedule tab's Past list must not silently turn campaign search into a
        // graveyard of called-off nights. SearchResult carries no status/badge field
        // (type/title/snippet/matchedField only), so a cancelled hit would be
        // indistinguishable from a live game night in the results list — the same
        // "UI shows it as normal, it isn't" trap this file already fixes elsewhere.
        // Cancelled nights stay discoverable where they can be labelled: the Schedule
        // tab's Past list badges them "Cancelled" and offers Restore.
        .filter((s) => s.status !== 'cancelled')
        .slice(0, boundedLimit)
    );
  }

  /**
   * The campaign's active schedule card: earliest in-progress game night, else the
   * soonest not-yet-started one. A session stays "current" from scheduledAt through
   * scheduledAt+durationMinutes (issue #818) so /schedule/next does not go blank at
   * the start of play.
   */
  async nextForCampaign(campaignId: number): Promise<ScheduledSessionWithRsvps | null> {
    const { inProgressSession, nextSession } = await this.currentAndNextForCampaign(campaignId);
    return inProgressSession ?? nextSession;
  }

  /**
   * Split the live schedule projection into the in-progress game (if any) and the
   * next not-yet-started night. Overlapping in-progress rows prefer the earliest
   * start; list order from listForCampaign is soonest-first.
   */
  async currentAndNextForCampaign(campaignId: number, nowMs: number = Date.now()): Promise<{
    inProgressSession: ScheduledSessionWithRsvps | null;
    nextSession: ScheduledSessionWithRsvps | null;
  }> {
    const nowIso = new Date(nowMs).toISOString();
    const [inProgressRows, upcomingRows] = await Promise.all([
      this.db
        .select()
        .from(scheduledSessions)
        .where(and(eq(scheduledSessions.campaignId, campaignId), scheduleLiveSql(), scheduleInProgressSql(nowIso)))
        .orderBy(asc(scheduledSessions.scheduledAt))
        .limit(1),
      this.db
        .select()
        .from(scheduledSessions)
        .where(and(eq(scheduledSessions.campaignId, campaignId), scheduleLiveSql(), scheduleUpcomingOnlySql(nowIso)))
        .orderBy(asc(scheduledSessions.scheduledAt))
        .limit(1),
    ]);
    const [inProgressAttached, nextAttached] = await Promise.all([
      this.attachRsvps(inProgressRows),
      this.attachRsvps(upcomingRows),
    ]);
    return {
      inProgressSession: inProgressAttached[0] ?? null,
      nextSession: nextAttached[0] ?? null,
    };
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(scheduledSessions).where(eq(scheduledSessions.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Scheduled session ${id} not found`);
    return row;
  }

  private getRowOrThrowTx(tx: SyncDb, id: number) {
    const [row] = tx.select().from(scheduledSessions).where(eq(scheduledSessions.id, id)).limit(1).all();
    if (!row) throw new NotFoundException(`Scheduled session ${id} not found`);
    return row;
  }

  async getWithRsvps(id: number): Promise<ScheduledSessionWithRsvps> {
    const row = await this.getRowOrThrow(id);
    const [rsvpRows, liveLinks] = await Promise.all([
      this.db.select().from(sessionRsvps).where(eq(sessionRsvps.scheduledSessionId, id)),
      this.liveLinkedSessionIds([row]),
    ]);
    return { ...this.projectLink(row, liveLinks), rsvps: rsvpRows.map(rsvpToDomain) };
  }

  /** Client-supplied ISO date-time -> canonical ISO UTC (validated by the Zod schema already). */
  private normalizeScheduledAt(iso: string): string {
    return new Date(iso).toISOString();
  }

  async create(campaignId: number, input: ScheduledSessionCreateInput, user: RequestUser, role: Role): Promise<ScheduledSessionWithRsvps> {
    const ts = nowIso();
    const scheduledAt = this.normalizeScheduledAt(input.scheduledAt);
    // Issue #588: an explicit IANA zone is optional metadata on a ONE-OFF night —
    // the instant stays authoritative and `localStart` is derived from it, so the
    // two can never contradict each other. Recurring series are the opposite way
    // round (wall clock authoritative, instant derived) because only a wall clock
    // survives a DST transition; see OrganizedPlayService.
    //
    // An explicit zone that is not a real IANA zone is REJECTED, not dropped.
    // `organizedPlayScheduleFields.timezone` is a plain bounded string — the
    // validating `IanaTimeZone` schema guards the series endpoints, not this one,
    // and `timezone` is absent from ORGANIZED_PLAY_OMIT — so silently storing ''
    // accepted a body that OrganizedPlayService.assertTimezone and the series
    // schemas both reject, and gave the client no way to detect that its zone had
    // been ignored. '' still means "no explicit zone"; legacy rows depend on it.
    if (input.timezone && !isValidIanaTimeZone(input.timezone)) {
      throw new BadRequestException(`Unknown IANA time zone: ${input.timezone}`);
    }
    const timezone = input.timezone ?? '';
    const localStart = timezone ? utcToLocalDateTime(scheduledAt, timezone) : '';
    // The UID must exist before the row is readable, and it needs the row id, so
    // insert + stamp commit together. The string is byte-identical to the UID the
    // ICS feed emitted before #588, so subscribers see an update, never a new event.
    const row = this.db.transaction((tx) => {
      const [inserted] = tx
        .insert(scheduledSessions)
        .values({
          campaignId,
          scheduledAt,
          durationMinutes: input.durationMinutes ?? 240,
          title: input.title ?? '',
          location: input.location ?? '',
          notes: input.notes ?? '',
          timezone,
          localStart,
          originalScheduledAt: scheduledAt,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const icsUid = legacyIcsUid(campaignId, inserted.id);
      tx.update(scheduledSessions).set({ icsUid }).where(eq(scheduledSessions.id, inserted.id)).run();
      return { ...inserted, icsUid };
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.create',
      entityType: 'session',
      entityId: row.id,
      campaignId,
    });
    this.emitScheduleUpdated(campaignId, row.id);
    // Tell the party a game night was put on the calendar (issues #263/#820).
    // Structured `data` carries the UTC instant; clients localize for the viewer.
    await this.notifyScheduleLifecycle(
      campaignId,
      user,
      this.scheduleNotificationData({
        scheduleId: row.id,
        scheduledAt: row.scheduledAt,
        durationMinutes: row.durationMinutes,
        title: row.title,
        changeType: 'created',
      }),
    );
    return { ...toDomain(row), rsvps: [] };
  }

  async update(
    id: number,
    input: ScheduledSessionUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<ScheduledSessionWithRsvps> {
    const { row: existing, status: effectiveStatus } = await this.getRowWithEffectiveStatus(id);
    // A cancelled night is not editable: this write commits a notes revision, an audit
    // entry, and — for time/duration/venue/notes — a "rescheduled" push to the whole
    // party for a game that is not happening. Rejecting is preferred over silently
    // suppressing the notification: the DM's edit would otherwise appear to succeed
    // while the party is never told, and the schedule they are looking at is stale
    // either way. `restore` is the documented way back to an editable night, and the
    // Schedule tab only offers Restore/Duplicate on a cancelled card, so nothing in
    // the UI is broken by this. `completed` stays editable — a played night's notes
    // are legitimate history to correct. Effective, not raw (see effectiveStatusOf).
    if (effectiveStatus === 'cancelled') {
      throw new BadRequestException('Cancelled scheduled sessions cannot be edited — restore it first');
    }
    const patch = { ...input };
    if (patch.scheduledAt !== undefined) patch.scheduledAt = this.normalizeScheduledAt(patch.scheduledAt);
    // Issue #588: this is the LEGACY one-off editor and it knows nothing about
    // rooms, DMs or the exception ledger. Sliding a row's window through it while
    // that row still holds its room and its assigned DM — with no
    // findConflictRows probe and no ledger entry — is precisely the double-booking
    // the organized-play endpoints exist to prevent. Room and DM cannot be
    // reached from this body at all (ORGANIZED_PLAY_OMIT), so the WINDOW is the
    // whole hazard. Reject the moves and name the endpoint that does them safely,
    // rather than re-implementing the conflict check here — which would then need
    // its own `force` override and 409 shape, i.e. the reschedule endpoint again.
    //
    // TWO INDEPENDENT REASONS to refuse, and the guard tests for both, because
    // testing `seriesId != null` alone was a PROXY for the first one and missed
    // rows that satisfy it without belonging to a series:
    //
    //   - the row HOLDS A BOOKABLE RESOURCE, so moving it can collide with
    //     another campaign. `reassignOccurrence` seats ANY occurrence — it
    //     rejects only cancelled rows — so a plain one-off can be given a room,
    //     which puts it in the conflict pool (`scheduleOrganizedPlaySql` matches
    //     `room_id IS NOT NULL`), and `seriesId` is null the whole time. That row
    //     was movable here with no probe at all. `holdsBookableResource` is
    //     defined next to `findConflictRows` so it cannot drift from what the
    //     probe actually collides on.
    //   - the row BELONGS TO A SERIES, so moving it must be recorded in the
    //     append-only exception ledger as lineage. True even for a series
    //     occurrence holding no room and no DM, where there is nothing to
    //     double-book but still something to record.
    //
    // Exactly two changes can introduce an overlap: moving the start instant, and
    // GROWING the duration. Shrinking it cannot — the window strictly contracts,
    // so every collision that would exist afterwards already existed before — and
    // shrinking is how mid-session "End session" works (#818), which is reachable
    // on an occurrence because occurrences are ordinary rows in the Schedule tab.
    // Rejecting a shrink would break a running game to prevent nothing.
    //
    // Comparison is against the STORED value, not mere presence of the key, so a
    // full-object PATCH from the edit form that re-sends the unchanged instant is
    // a no-op and passes. Title/location/notes hold no shared resource and stay
    // editable here.
    const widensWindow =
      (patch.scheduledAt !== undefined && patch.scheduledAt !== existing.scheduledAt)
      || (patch.durationMinutes !== undefined && patch.durationMinutes > existing.durationMinutes);
    if (widensWindow && (existing.seriesId != null || holdsBookableResource(existing))) {
      throw new BadRequestException(
        'A scheduled session that belongs to a series, or that holds a room or an assigned DM, cannot be moved or '
          + 'lengthened here — use POST /organized-play/occurrences/:id/reschedule, which runs the booking conflict '
          + 'check and records the move in the exception ledger',
      );
    }
    const next = {
      scheduledAt: patch.scheduledAt ?? existing.scheduledAt,
      durationMinutes: patch.durationMinutes ?? existing.durationMinutes,
      title: patch.title ?? existing.title,
      location: patch.location ?? existing.location,
      notes: patch.notes ?? existing.notes,
    };
    // Issue #588: bump the RFC 5545 SEQUENCE whenever a field a calendar client
    // renders actually changed, and keep the local wall clock in step with the
    // instant when the row carries an explicit zone. Only on a real change — a
    // no-op PATCH must not push a fresh SEQUENCE at every subscriber.
    //
    // `notes` is in this list because it is emitted as DESCRIPTION (ics.util.ts),
    // and the rule here is "anything that renders into the feed bumps SEQUENCE" —
    // title→SUMMARY and location→LOCATION are already here for exactly that
    // reason. LAST-MODIFIED does still advance on a notes-only edit, so a lenient
    // client picked the new description up regardless; a client that gates
    // revisions on SEQUENCE, as RFC 5545 §3.8.7.4 allows, kept the stale one.
    const calendarFieldChanged =
      next.scheduledAt !== existing.scheduledAt
      || next.durationMinutes !== existing.durationMinutes
      || next.title !== existing.title
      || next.location !== existing.location
      || next.notes !== existing.notes;
    const localStartPatch =
      next.scheduledAt !== existing.scheduledAt && existing.timezone
        ? { localStart: utcToLocalDateTime(next.scheduledAt, existing.timezone) }
        : {};
    // Issue #588: which of this row's prose fields this PATCH actually changes.
    // The window fields are absent by construction — a series occurrence cannot
    // reach the write below with a moved instant or a grown duration, the guard
    // above rejects that and names the endpoint that records it properly. So the
    // ledger entry this produces is a PROSE entry and says so.
    //
    // Field NAMES only, never the prose itself: the exception ledger is readable
    // by organized-play coordinators who need not be members of the campaign,
    // and the note bodies are versioned in the revisions table where campaign
    // membership is enforced. Naming the field is what makes the lineage useful;
    // quoting it would leak.
    const editedProseFields = (['title', 'location', 'notes'] as const).filter((f) => next[f] !== existing[f]);
    let updated: Array<typeof scheduledSessions.$inferSelect> = [];
    // One transaction so the row write and its ledger entry cannot separate. A
    // committed prose edit with no `edit` entry is exactly the invisible
    // per-occurrence divergence this ledger exists to surface, and the reverse —
    // an entry for a write that lost a stale-write race — would claim an edit
    // that never happened.
    this.db.transaction((tx) => {
      updated = tx
        .update(scheduledSessions)
        .set({
          ...patch,
          ...localStartPatch,
          ...(calendarFieldChanged ? { icsSequence: existing.icsSequence + 1 } : {}),
          updatedAt: nextUpdatedAt(existing.updatedAt),
        })
        .where(
          opts?.expectedUpdatedAt
            ? and(eq(scheduledSessions.id, id), eq(scheduledSessions.updatedAt, opts.expectedUpdatedAt))
            : eq(scheduledSessions.id, id),
        )
        .returning()
        .all();
      // Nothing was written — leave the rollback to the stale-write throw below,
      // which needs an async read this synchronous callback cannot make.
      if (!updated[0]) return;
      // #588: the legacy editor is still the ordinary way a DM retitles or
      // re-notes ONE night of a series from the Schedule tab, and until now it
      // left no trace at all: the lineage could not show that this occurrence had
      // diverged from its series, even though `updateSeries` would later flatten
      // the divergence away. `edit` is NOT in METADATA_OVERRIDE_KINDS, so
      // appending it does not detach the night from future series edits — that is
      // the whole distinction between recording a prose edit and honouring a
      // booking decision (reschedule / reassign).
      if (existing.seriesId != null && editedProseFields.length > 0) {
        tx.insert(seriesExceptions)
          .values({
            seriesId: existing.seriesId,
            occurrenceId: id,
            recurrenceLocalDate: recurrenceLocalDateFor(existing, seriesTimezoneInTx(tx, existing.seriesId)),
            kind: 'edit',
            // A prose edit moves no instant and no assignment, so from == to
            // throughout, recorded rather than defaulted for the same reason
            // `cancel` records them: the entry states the seating in force when
            // the edit happened.
            fromScheduledAt: existing.scheduledAt,
            toScheduledAt: existing.scheduledAt,
            toLocalStart: existing.localStart,
            fromRoomId: existing.roomId,
            toRoomId: existing.roomId,
            fromAssignedDmUserId: existing.assignedDmUserId,
            toAssignedDmUserId: existing.assignedDmUserId,
            fromCapacity: existing.capacity,
            toCapacity: existing.capacity,
            reason: `edited ${editedProseFields.join(', ')}`,
            actorUserId: user.id,
            createdAt: nowIso(),
          })
          .run();
      }
    });
    if (!updated[0]) {
      const current = await this.getRowOrThrow(id);
      throw staleWrite(opts?.expectedUpdatedAt, current.updatedAt);
    }
    if (patch.notes !== undefined && patch.notes !== existing.notes) {
      await this.revisions.commitProseVersion({
        entityType: 'scheduled_session',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.notes,
        nextProse: patch.notes,
        user,
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.update',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
    this.emitScheduleUpdated(existing.campaignId, id);
    // Issue #820: one coalesced ping per update for time/duration/venue/notes —
    // never drop those lifecycle changes, but skip title-only edits (spam).
    const changedFields = diffScheduleNotificationFields(existing, next);
    if (shouldNotifyScheduleUpdate(changedFields)) {
      const changeType = scheduleNotificationChangeType(changedFields);
      await this.notifyScheduleLifecycle(
        existing.campaignId,
        user,
        this.scheduleNotificationData({
          scheduleId: id,
          scheduledAt: next.scheduledAt,
          durationMinutes: next.durationMinutes,
          title: next.title,
          changeType,
          changedFields,
        }),
      );
    }
    return this.getWithRsvps(id);
  }

  async remove(id: number, user: RequestUser, role: Role, input: ScheduledSessionCancelInput = {}): Promise<ScheduledSessionWithRsvps> {
    // Effective, not raw: a future night whose recap is in the Trash is shown in
    // Upcoming with the DM's Cancel button, so Cancel has to actually work on it.
    const { row: existing, status: effectiveStatus } = await this.getRowWithEffectiveStatus(id);
    if (effectiveStatus === 'cancelled') return this.getWithRsvps(id);
    if (effectiveStatus === 'completed') {
      throw new BadRequestException('Completed scheduled sessions cannot be cancelled');
    }
    const ts = nowIso();
    const reason = (input.reason ?? '').trim();
    // Cancelling the row and appending its ledger entry are one change, so they
    // commit or roll back together — restore() already pairs its un-cancel with a
    // `restore` entry the same way.
    this.db.transaction((tx) => {
      tx.update(scheduledSessions)
        .set({
          status: 'cancelled',
          cancelledAt: ts,
          cancelledBy: user.id,
          cancellationReason: reason,
          // #588: a cancellation is published as STATUS:CANCELLED under the SAME
          // UID, so it needs a higher SEQUENCE or subscribers keep the live copy.
          icsSequence: existing.icsSequence + 1,
          updatedAt: ts,
        })
        .where(eq(scheduledSessions.id, id))
        .run();
      // #588: `DELETE /schedule/:id` is the ONLY exposed way to cancel a single
      // occurrence of a series — cancelSeries cancels the whole tail — so this is
      // where an occurrence's `cancel` has to be appended. Without it the
      // append-only ledger could hold a `restore` with no preceding `cancel`
      // (restore() writes one unconditionally), and a night the coordinator
      // skipped carried no recorded reason at all.
      if (existing.seriesId != null) {
        tx.insert(seriesExceptions)
          .values({
            seriesId: existing.seriesId,
            occurrenceId: id,
            recurrenceLocalDate: recurrenceLocalDateFor(existing, seriesTimezoneInTx(tx, existing.seriesId)),
            kind: 'cancel',
            fromScheduledAt: existing.scheduledAt,
            toScheduledAt: null,
            toLocalStart: '',
            // A lifecycle entry changes no assignment, so from == to. Recorded
            // rather than left at defaults so the ledger states the seating that
            // was in force when the night was cancelled.
            fromRoomId: existing.roomId,
            toRoomId: existing.roomId,
            fromAssignedDmUserId: existing.assignedDmUserId,
            toAssignedDmUserId: existing.assignedDmUserId,
            fromCapacity: existing.capacity,
            toCapacity: existing.capacity,
            reason,
            actorUserId: user.id,
            createdAt: ts,
          })
          .run();
      }
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.cancel',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: reason,
    });
    this.emitScheduleUpdated(existing.campaignId, id);
    // Cancellation is a lifecycle event: keep the row/RSVPs, but notify with a
    // snapshot so members and calendar clients can update their copies.
    await this.notifyScheduleLifecycle(
      existing.campaignId,
      user,
      this.scheduleNotificationData({
        scheduleId: existing.id,
        scheduledAt: existing.scheduledAt,
        durationMinutes: existing.durationMinutes,
        title: existing.title,
        changeType: 'cancelled',
      }),
    );
    return this.getWithRsvps(id);
  }

  async restore(id: number, user: RequestUser, role: Role, force = false, reason = ''): Promise<ScheduledSessionRestored> {
    // Effective status here too, so every write guard in this file reads the same
    // projection the API returns. ('cancelled' is never link-derived, so this one is
    // equivalent to the raw column today — it is written this way so the next guard
    // added here copies the correct pattern.)
    const { row: existing, status: effectiveStatus } = await this.getRowWithEffectiveStatus(id);
    if (effectiveStatus !== 'cancelled') throw new NotFoundException(`Scheduled session ${id} is not cancelled`);
    const ts = nowIso();
    // Un-cancelling and re-arming the reminders are one change, so they commit or roll
    // back together — a half-applied restore would put the night back on the calendar
    // with its reminders permanently suppressed, and nothing would ever report it.
    //
    // The `notification_reminders` ledger is the sweep's dedup guard: a surviving
    // (schedule, user, kind) row makes emitOnce()'s claim lose, silently. The sweep only
    // purges the ledger for nights that have already STARTED, so a night cancelled and
    // restored while still inside the 24h lead window kept its rows and never reminded
    // anyone again. Before #504 this sequence did not exist — cancel hard-deleted the
    // row (and cascaded the ledger with it) — so restore is where the fix belongs.
    //
    // Purging on restore rather than on cancel is deliberate: while a night is
    // cancelled the ledger is a useful record of what the party was already told, and
    // restore is the exact moment the night becomes eligible to remind again. Restore
    // starts a new incarnation of the night, so it starts with a clean ledger.
    let forced: RawConflict[] = [];
    // The row this restore actually re-books, re-read inside the transaction.
    // Everything after it — audit, notification, the returned payload — describes
    // what was written, so it must describe THIS row, not the snapshot above.
    let booked: typeof scheduledSessions.$inferSelect = existing;
    this.db.transaction((tx) => {
      // Re-read INSIDE the transaction, because every value below is derived from
      // this row and the read above is separated from this write by an await.
      //
      // The probe already ran in here; its INPUTS did not, and that was the gap.
      // A series PATCH may legitimately move a cancelled occurrence's room —
      // cancelled rows sit outside `scheduleLiveSql()`, so the fan-out skips the
      // booking check for them by design — and it can commit in that gap. This
      // restore would then probe the room the row USED to hold, find it free, and
      // flip a row now pointing at a different, possibly occupied, room to
      // `scheduled`: a live double-booking created by the one path whose probe
      // exists to prevent exactly that. The SEQUENCE and the ledger entry came
      // off the same stale snapshot, so both would have described the wrong room.
      booked = this.getRowOrThrowTx(tx, id);
      // Re-validated in here too: if a concurrent restore already won, this one
      // must not re-probe and re-announce a night that is no longer cancelled.
      if (booked.status !== 'cancelled') {
        throw new NotFoundException(`Scheduled session ${id} is not cancelled`);
      }
      // #588: a restore is a BOOKING, not merely a status flip.
      //
      // Cancelling RELEASES the resource — a cancelled row keeps its `room_id`
      // and `assigned_dm_user_id`, but `scheduleResourceHeldSql()` excludes it
      // from conflict detection (issue #1555: cancellation is the ONLY status
      // that releases), so while it is cancelled another campaign can
      // legitimately take that room or that DM and the server correctly tells
      // them it is free. Flipping the row back to `scheduled` with no probe
      // silently recreates exactly the double-booking this feature exists to
      // prevent, and tells neither party. It is the mirror image of the cancel
      // side: whatever cancelling gives up, restoring has to ask for again.
      //
      // Probed inside the write transaction like every other booking path, so the
      // answer still holds at the moment the row reclaims the resource.
      const conflicts = findConflictRows(tx, {
        startsAt: booked.scheduledAt,
        endsAt: endInstant(booked.scheduledAt, booked.durationMinutes),
        roomId: booked.roomId,
        assignedDmUserId: booked.assignedDmUserId,
        memberUserIds: [],
        // Cancelled rows are already outside the live filter so this row cannot
        // match its own probe; excluded explicitly anyway so the guarantee does
        // not depend on that filter never changing.
        excludeScheduleId: id,
      });
      if (conflicts.length > 0 && !force) throw new SeriesConflictSignal(conflicts);
      // What forcing this restore overrode. Reported rather than discarded: the
      // rule this feature states is that an override the caller cannot tell they
      // took is not an override, and restore was the one force-taking path still
      // returning a payload with nowhere to say so.
      forced = conflicts;
      const restoresLiveRecap =
        booked.sessionId == null
          ? false
          : tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.id, booked.sessionId), notDeleted(sessions.deletedAt)))
            .limit(1)
            .all().length > 0;
      tx.update(scheduledSessions)
        .set({
          status: restoresLiveRecap ? 'completed' : 'scheduled',
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: '',
          // #588: un-cancelling is another update a subscriber must apply on top
          // of the STATUS:CANCELLED copy it already holds, so SEQUENCE advances.
          icsSequence: booked.icsSequence + 1,
          updatedAt: ts,
        })
        .where(eq(scheduledSessions.id, id))
        .run();
      tx.delete(notificationReminders)
        .where(eq(notificationReminders.scheduledSessionId, id))
        .run();
      // #588: an occurrence's exception ledger is append-only, so an un-cancel is
      // recorded rather than expressed by deleting the earlier `cancel` entry.
      // Without this a restored night would read, forever, as still cancelled in
      // the lineage the coordinator audits from.
      if (booked.seriesId != null) {
        tx.insert(seriesExceptions)
          .values({
            seriesId: booked.seriesId,
            occurrenceId: id,
            recurrenceLocalDate: recurrenceLocalDateFor(booked, seriesTimezoneInTx(tx, booked.seriesId)),
            kind: 'restore',
            fromScheduledAt: booked.scheduledAt,
            toScheduledAt: booked.scheduledAt,
            toLocalStart: booked.localStart,
            // from == to: a restore re-acquires what the row already names.
            fromRoomId: booked.roomId,
            toRoomId: booked.roomId,
            fromAssignedDmUserId: booked.assignedDmUserId,
            toAssignedDmUserId: booked.assignedDmUserId,
            fromCapacity: booked.capacity,
            toCapacity: booked.capacity,
            reason,
            actorUserId: user.id,
            createdAt: ts,
          })
          .run();
      }
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.restore',
      entityType: 'session',
      entityId: id,
      campaignId: booked.campaignId,
    });
    this.emitScheduleUpdated(booked.campaignId, id);
    await this.notifyScheduleLifecycle(
      booked.campaignId,
      user,
      this.scheduleNotificationData({
        scheduleId: booked.id,
        scheduledAt: booked.scheduledAt,
        durationMinutes: booked.durationMinutes,
        title: booked.title,
        changeType: 'updated',
      }),
    );
    // Redacted per caller through the same leaf-module helpers OrganizedPlayService
    // uses, so a forced restore cannot reveal more about another campaign's
    // booking than the conflict probe would.
    const scope = await this.roles.accessibleCampaignIds(user);
    const names = await lookupConflictNames(
      this.db,
      forced.map((r) => r.campaignId),
      forced.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    return { ...(await this.getWithRsvps(id)), conflicts: redactConflicts(forced, scope, names) };
  }

  async duplicate(
    id: number,
    input: ScheduledSessionDuplicateInput,
    user: RequestUser,
    role: Role,
  ): Promise<ScheduledSessionWithRsvps> {
    const existing = await this.getRowOrThrow(id);
    const created = await this.create(
      existing.campaignId,
      {
        scheduledAt: input.scheduledAt ?? existing.scheduledAt,
        // A duplicate is a brand-new LIVE night, so it must satisfy the create-time
        // floor that ScheduledSessionCreate enforces (min 15). The source row can sit
        // below it — mid-session "End session" (#818) shrinks durationMinutes to 0 —
        // and create() takes an already-typed input without re-parsing, so copying the
        // raw value would mint a live schedule the create DTO would have rejected.
        durationMinutes: input.durationMinutes ?? clampToCreateDuration(existing.durationMinutes),
        title: input.title ?? existing.title,
        location: input.location ?? existing.location,
        notes: input.notes ?? existing.notes,
        // #588: carry the zone across. `duplicate()` predates this branch, but
        // `timezone` does not — so a method that copies "everything" silently
        // stopped doing so the moment the column was added, and the copy stored
        // '' with an empty `localStart`. Nothing could repair it afterwards:
        // ScheduledSessionUpdate deliberately carries no `timezone`. Adding a
        // column means auditing whoever claims to copy the row.
        timezone: existing.timezone,
      },
      user,
      role,
    );
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.duplicate',
      entityType: 'session',
      entityId: created.id,
      campaignId: existing.campaignId,
      detail: `from=${id}`,
    });
    return created;
  }

  /** Read-only schedule fetch inside a caller's transaction (#504). */
  getScheduleRowInTx(tx: SyncDb, id: number) {
    return this.getRowOrThrowTx(tx, id);
  }

  /**
   * Every precondition a link must satisfy, evaluated read-only against `db`.
   *
   * Single source of truth for the guards: `linkSessionInTx` runs it inside its write
   * transaction (for correctness under concurrency), and callers that persist other
   * changes alongside a link run it up front via `assertCanLinkSession` so a link that
   * cannot succeed is rejected before anything is written.
   *
   * Returns `alreadyLinked` for the idempotent case (this exact pair is already linked)
   * so callers can tell a no-op apart from a rejection.
   *
   * Deliberately the only write guard in this file that reasons about the RAW status
   * rather than the effective one (see effectiveStatusOf). The other guards ask "what
   * lifecycle state is the user looking at?"; this one asks "does a stored link already
   * occupy this row?", and the stored link is real even while its recap sits in the
   * Trash. Reconciling it away here would let a second recap overwrite `session_id`
   * while the trashed recap kept its `scheduled_session_id` back-pointer — a
   * one-directional dangling link, and it would break the invariant this whole fix
   * rests on: untrashing a recap heals the row with no repair write. So the stale-link
   * case is still rejected, but the message names the remedy instead of describing a
   * link the caller cannot see. ('cancelled' is never link-derived, so for that branch
   * raw and effective are the same value.)
   */
  private checkLinkable(db: SyncDb, scheduleId: number, sessionId: number): {
    schedule: typeof scheduledSessions.$inferSelect;
    alreadyLinked: boolean;
  } {
    const schedule = this.getRowOrThrowTx(db, scheduleId);
    if (schedule.status === 'cancelled') throw new BadRequestException('Cancelled scheduled sessions cannot be completed');
    if (schedule.status === 'completed' && schedule.sessionId !== sessionId) {
      const linkedId = schedule.sessionId;
      const [linkedRecap] = linkedId == null
        ? []
        : db.select({ deletedAt: sessions.deletedAt }).from(sessions).where(eq(sessions.id, linkedId)).limit(1).all();
      throw new BadRequestException(
        linkedRecap?.deletedAt != null
          ? 'Scheduled session is linked to a session in the Trash — restore that session before linking a different one'
          : 'Scheduled session is already linked to a different session',
      );
    }
    const [session] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
    if (!session || session.deletedAt != null) throw new NotFoundException(`Session ${sessionId} not found`);
    if (session.campaignId !== schedule.campaignId) {
      throw new BadRequestException('Session must belong to the same campaign as the scheduled session');
    }
    if (schedule.status === 'completed' && schedule.sessionId === sessionId) {
      return { schedule, alreadyLinked: true };
    }
    if (session.scheduledSessionId != null && session.scheduledSessionId !== scheduleId) {
      throw new BadRequestException('Session is already linked to a different scheduled session');
    }
    const [otherSchedule] = db
      .select({ id: scheduledSessions.id })
      .from(scheduledSessions)
      .where(and(eq(scheduledSessions.sessionId, sessionId), ne(scheduledSessions.id, scheduleId)))
      .limit(1)
      .all();
    if (otherSchedule) {
      throw new BadRequestException('Session is already linked to a different scheduled session');
    }
    return { schedule, alreadyLinked: false };
  }

  /**
   * Read-only pre-flight for callers that write other changes before linking (#504).
   * Throws exactly what the link itself would, so a rejected edit can fail before it
   * has persisted anything — otherwise the caller commits its field changes and then
   * returns a 400 that does not match what was actually saved.
   */
  assertCanLinkSession(scheduleId: number, sessionId: number): void {
    this.checkLinkable(this.db, scheduleId, sessionId);
  }

  /**
   * Row-writes half of a link, for callers that link inside their own transaction so
   * the link commits (or rolls back) together with their other writes. Pair with
   * `recordSessionLink` after the transaction commits for audit + SSE.
   */
  linkSessionInTx(tx: SyncDb, scheduleId: number, sessionId: number): LinkSessionOutcome {
    const { schedule, alreadyLinked } = this.checkLinkable(tx, scheduleId, sessionId);
    if (alreadyLinked) {
      return { campaignId: schedule.campaignId, linked: false, wasPreviouslyCompleted: true };
    }
    const ts = nowIso();
    tx.update(scheduledSessions)
      .set({ status: 'completed', sessionId, updatedAt: ts })
      .where(eq(scheduledSessions.id, scheduleId))
      .run();
    tx.update(sessions)
      .set({ scheduledSessionId: scheduleId, updatedAt: ts })
      .where(eq(sessions.id, sessionId))
      .run();
    return { campaignId: schedule.campaignId, linked: true, wasPreviouslyCompleted: schedule.status === 'completed' };
  }

  /** Audit + SSE half of a link — run after the owning transaction has committed. */
  async recordSessionLink(
    outcome: LinkSessionOutcome,
    scheduleId: number,
    sessionId: number,
    user: RequestUser,
    role: Role,
  ): Promise<void> {
    if (!outcome.linked) return;
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.link',
      entityType: 'session',
      entityId: scheduleId,
      campaignId: outcome.campaignId,
      detail: `session=${sessionId}`,
    });
    if (!outcome.wasPreviouslyCompleted) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'schedule.complete',
        entityType: 'session',
        entityId: scheduleId,
        campaignId: outcome.campaignId,
        detail: `session=${sessionId}`,
      });
    }
    this.emitScheduleUpdated(outcome.campaignId, scheduleId);
  }

  async linkSession(scheduleId: number, sessionId: number, user: RequestUser, role: Role): Promise<ScheduledSessionWithRsvps> {
    const outcome = this.db.transaction((tx) => this.linkSessionInTx(tx, scheduleId, sessionId));
    await this.recordSessionLink(outcome, scheduleId, sessionId, user, role);
    return this.getWithRsvps(scheduleId);
  }

  /**
   * Tear down a schedule↔session link from the SESSION side, both directions at once.
   *
   * `SessionUpdate.scheduledSessionId` is nullable, so REST/MCP `update_session` can
   * send an explicit `null`. Clearing only `sessions.scheduled_session_id` would strand
   * the schedule as `status='completed'` with `session_id` still pointing back — a
   * one-directional dangling link that renders a dead "Recap" link in the Schedule tab
   * and that no later linkSession() can repair (the reciprocal-row guard would keep
   * rejecting it). Both sides are cleared in one better-sqlite3 transaction, and a
   * schedule that was only `completed` BECAUSE of this link returns to `scheduled`.
   *
   * Any schedule row pointing at this session is swept, so pre-existing half-links from
   * older data heal on the next unlink instead of persisting forever.
   */
  /**
   * Row-writes half of an unlink, for callers unlinking inside their own transaction.
   * Clears BOTH sides, so a caller must not also write `scheduledSessionId` itself.
   * Pair with `recordSessionUnlink` after the transaction commits.
   */
  unlinkSessionInTx(tx: SyncDb, sessionId: number): UnlinkSessionOutcome {
    const [session] = tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const linked = tx
      .select()
      .from(scheduledSessions)
      .where(eq(scheduledSessions.sessionId, sessionId))
      .all();
    const ts = nowIso();
    tx.update(sessions).set({ scheduledSessionId: null, updatedAt: ts }).where(eq(sessions.id, sessionId)).run();
    for (const schedule of linked) {
      tx.update(scheduledSessions)
        // Only 'completed' is an artefact of the link; a cancelled row keeps its
        // cancellation lifecycle state (and its cancellation metadata) untouched.
        .set({ status: schedule.status === 'completed' ? 'scheduled' : schedule.status, sessionId: null, updatedAt: ts })
        .where(eq(scheduledSessions.id, schedule.id))
        .run();
    }
    return { campaignId: session.campaignId, scheduleIds: linked.map((s) => s.id) };
  }

  /** Audit + SSE half of an unlink — run after the owning transaction has committed. */
  async recordSessionUnlink(
    outcome: UnlinkSessionOutcome,
    sessionId: number,
    user: RequestUser,
    role: Role,
  ): Promise<void> {
    for (const scheduleId of outcome.scheduleIds) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'schedule.unlink',
        entityType: 'session',
        entityId: scheduleId,
        campaignId: outcome.campaignId,
        detail: `session=${sessionId}`,
      });
      this.emitScheduleUpdated(outcome.campaignId, scheduleId);
    }
  }

  async unlinkSession(sessionId: number, user: RequestUser, role: Role): Promise<void> {
    const outcome = this.db.transaction((tx) => this.unlinkSessionInTx(tx, sessionId));
    await this.recordSessionUnlink(outcome, sessionId, user, role);
  }

  // ----- RSVPs (availability) -----

  /** Upsert the calling member's own availability for a scheduled session. */
  async setRsvp(scheduleId: number, input: RsvpSetInput, user: RequestUser, role: Role): Promise<ScheduledSessionWithRsvps> {
    // Effective, not raw: a future night whose recap is in the Trash reads back as
    // 'scheduled' and is rendered with live RSVP controls, so it must accept them.
    const { row: schedule, status: effectiveStatus } = await this.getRowWithEffectiveStatus(scheduleId);
    if (effectiveStatus !== 'scheduled') {
      throw new BadRequestException('RSVPs can only be changed for scheduled sessions');
    }
    const ts = nowIso();
    const [existing] = await this.db
      .select()
      .from(sessionRsvps)
      .where(and(eq(sessionRsvps.scheduledSessionId, scheduleId), eq(sessionRsvps.userId, user.id)))
      .limit(1);

    const persistedNote =
      input.note !== undefined ? input.note.trim() : (existing?.note ?? '');
    const nextStatus = input.status ?? existing?.status;
    if (!nextStatus) {
      throw new BadRequestException('status is required for the first RSVP submission');
    }

    const statusChanged = input.status !== undefined && (!existing || existing.status !== input.status);
    const noteChanged =
      input.note !== undefined && persistedNote !== (existing?.note ?? '').trim();

    if (existing) {
      const update: {
        status?: SessionRsvp['status'];
        userName: string;
        updatedAt: string;
        note?: string;
      } = { userName: user.name, updatedAt: ts };
      if (input.status !== undefined) {
        update.status = input.status;
      }
      if (input.note !== undefined) {
        update.note = input.note.trim();
      }
      await this.db
        .update(sessionRsvps)
        .set(update)
        .where(eq(sessionRsvps.id, existing.id));
    } else {
      await this.db.insert(sessionRsvps).values({
        scheduledSessionId: scheduleId,
        userId: user.id,
        userName: user.name,
        status: nextStatus,
        note: persistedNote,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.rsvp',
      entityType: 'session',
      entityId: scheduleId,
      campaignId: schedule.campaignId,
      detail: nextStatus,
    });
    this.emitScheduleUpdated(schedule.campaignId, scheduleId);
    // Let the DM(s) know availability changed (issue #263) — they own scheduling, so
    // an RSVP is theirs to see. Fan out to every dm-role member except the actor (a DM
    // marking their own availability shouldn't ping themselves). Best-effort.
    const roles = await this.notifications.memberRoles(schedule.campaignId);
    if (statusChanged || noteChanged) {
      for (const [memberId, memberRole] of roles) {
        if (memberRole !== 'dm' || String(memberId) === user.id) continue;
        const title =
          noteChanged && !statusChanged
            ? `${user.name || 'A player'} updated their RSVP note for ${this.scheduleLabel(schedule)}`
            : noteChanged && statusChanged
              ? `${user.name || 'A player'} RSVP'd ${nextStatus} and updated their note for ${this.scheduleLabel(schedule)}`
              : `${user.name || 'A player'} RSVP'd ${nextStatus} for ${this.scheduleLabel(schedule)}`;
        await this.notifications.notifyUser(memberId, schedule.campaignId, user, {
          type: 'session_rsvp',
          title,
          entityId: scheduleId,
          actorName: user.name,
        });
      }
    }
    return this.getWithRsvps(scheduleId);
  }

  // ----- ICS calendar feed -----

  private async getCampaignRowOrThrow(campaignId: number) {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!row) throw new NotFoundException(`Campaign ${campaignId} not found`);
    return row;
  }

  async getFeed(campaignId: number): Promise<CalendarFeed> {
    const campaign = await this.getCampaignRowOrThrow(campaignId);
    return {
      token: campaign.icsToken,
      url: campaign.icsToken ? icsFeedUrl(campaign.icsToken) : null,
      expiresAt: campaign.icsToken ? campaign.icsTokenExpiresAt : null,
    };
  }

  /**
   * Enable the feed, or rotate its token (invalidating the old URL) if already
   * enabled. Issue #554: each (re)issue stamps a fresh `icsTokenExpiresAt` so a
   * leaked URL self-destructs after the configured window; rotating before or
   * after expiry mints a brand-new token + expiry, leaving the old URL dead.
   */
  async rotateFeed(campaignId: number, user: RequestUser, role: Role): Promise<CalendarFeed> {
    await this.getCampaignRowOrThrow(campaignId);
    const token = generateIcsFeedToken();
    const expiresAt = icsFeedTokenExpiryFromNow();
    await this.db
      .update(campaigns)
      .set({ icsToken: token, icsTokenExpiresAt: expiresAt, updatedAt: nowIso() })
      .where(eq(campaigns.id, campaignId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.feed_rotate',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: `expires=${expiresAt}`,
    });
    return { token, url: icsFeedUrl(token), expiresAt };
  }

  async disableFeed(campaignId: number, user: RequestUser, role: Role): Promise<CalendarFeed> {
    await this.getCampaignRowOrThrow(campaignId);
    await this.db
      .update(campaigns)
      .set({ icsToken: null, icsTokenExpiresAt: null, updatedAt: nowIso() })
      .where(eq(campaigns.id, campaignId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.feed_disable',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
    });
    return { token: null, url: null, expiresAt: null };
  }

  /**
   * Resolve a public feed token to its ICS document, or throw 404. The token
   * IS the authorization (unguessable capability secret) — no user identity
   * involved, and nothing DM-only (dmSecret etc) is anywhere near this data.
   *
   * Issue #554: an expired token (ics_token_expires_at in the past) is rejected
   * with the same 404 as an unknown/rotated/disabled one — calendar apps see a
   * dead URL and stop fetching, while a probing caller learns nothing about
   * WHY. Null expiry (legacy rows written before #554) keeps the original
   * "valid until rotated" behavior so existing subscribers aren't broken.
   */
  async buildFeedByToken(token: string): Promise<string> {
    // Shape check first: skips a DB roundtrip for junk and guarantees the
    // lookup below never matches on an empty/whitespace token.
    if (!looksLikeIcsFeedToken(token)) throw new NotFoundException('Unknown calendar feed');
    const [campaign] = await this.db.select().from(campaigns).where(eq(campaigns.icsToken, token)).limit(1);
    if (!campaign) throw new NotFoundException('Unknown calendar feed');
    if (icsTokenIsExpired(campaign.icsTokenExpiresAt)) throw new NotFoundException('Unknown calendar feed');
    // Issue #867: a trashed campaign's public calendar feed must look identical to
    // an unknown/rotated token — no schedule disclosure after Trash.
    if (campaign.deletedAt != null) throw new NotFoundException('Unknown calendar feed');
    // ICS feeds include past + future so previously-synced events don't vanish (see buildCampaignIcs).
    const schedules = await this.listForCampaign(campaign.id);
    return buildCampaignIcs({ id: campaign.id, name: campaign.name }, schedules);
  }
}

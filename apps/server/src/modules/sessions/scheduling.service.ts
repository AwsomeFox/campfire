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
  type ScheduleNotificationData,
} from '@campfire/schema';
import type { ScheduledSession, ScheduledSessionWithRsvps, ScheduledSessionListPage, SessionRsvp, CalendarFeed, Role, PageParams } from '@campfire/schema';
import { SCHEDULE_PAST_DEFAULT_LIMIT, SCHEDULE_PAST_MAX_LIMIT } from '@campfire/schema';
import { applyPage } from '../../common/pagination';
import { DB, type DrizzleDb } from '../../db/db.module';
import { scheduledSessions, sessionRsvps, campaigns, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { generateIcsFeedToken, looksLikeIcsFeedToken } from '../../common/crypto';
import { resolveIcsFeedTokenTtlDays } from '../../common/throttle.constants';
import { foldForSearch, foldedIncludes } from '../../common/text-search';
import { nextUpdatedAt, staleWrite } from '../../common/stale-write';
import { AuditService } from '../audit/audit.service';
import { RevisionsService } from '../revisions/revisions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { buildCampaignIcs } from './ics.util';
import {
  scheduleInProgressSql,
  scheduleLiveSql,
  scheduleNotEndedSql,
  schedulePastSql,
  scheduleUpcomingOnlySql,
} from './scheduling-queries';

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

function toDomain(row: typeof scheduledSessions.$inferSelect): ScheduledSession {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
   */
  private async liveLinkedSessionIds(rows: Array<typeof scheduledSessions.$inferSelect>): Promise<Set<number>> {
    const linkedIds = [...new Set(rows.map((r) => r.sessionId).filter((id): id is number => id != null))];
    if (linkedIds.length === 0) return new Set();
    const live = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(inArray(sessions.id, linkedIds), notDeleted(sessions.deletedAt)));
    return new Set(live.map((r) => r.id));
  }

  /**
   * Read-time reconciliation of the schedule↔recap link (#504).
   *
   * A recap is soft-deleted (trashed), never hard-deleted, so `ON DELETE SET NULL`
   * never fires and the stored link survives — deliberately. Tearing the link down on
   * trash would mean restoring the session silently fails to restore the link, trading
   * a visible bug for silent data loss. But a trashed recap is invisible to every
   * session read, so surfacing `sessionId` renders a "Recap" link that 404s, and
   * reporting `completed` claims a night was played by a recap nobody can open.
   *
   * So both are hidden at READ time only. SQLite still holds `status='completed'` and
   * `session_id`, so restoring the session reconciles the row with no write at all.
   * `cancelled` is never link-derived, so it is passed through untouched.
   */
  private projectLink(row: typeof scheduledSessions.$inferSelect, liveLinkedIds: Set<number>): ScheduledSession {
    const domain = toDomain(row);
    if (domain.sessionId == null || liveLinkedIds.has(domain.sessionId)) return domain;
    return {
      ...domain,
      sessionId: null,
      status: domain.status === 'completed' ? 'scheduled' : domain.status,
    };
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
    const [row] = await this.db
      .insert(scheduledSessions)
      .values({
        campaignId,
        scheduledAt: this.normalizeScheduledAt(input.scheduledAt),
        durationMinutes: input.durationMinutes ?? 240,
        title: input.title ?? '',
        location: input.location ?? '',
        notes: input.notes ?? '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

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
    const next = {
      scheduledAt: patch.scheduledAt ?? existing.scheduledAt,
      durationMinutes: patch.durationMinutes ?? existing.durationMinutes,
      title: patch.title ?? existing.title,
      location: patch.location ?? existing.location,
      notes: patch.notes ?? existing.notes,
    };
    const updated = await this.db
      .update(scheduledSessions)
      .set({ ...patch, updatedAt: nextUpdatedAt(existing.updatedAt) })
      .where(
        opts?.expectedUpdatedAt
          ? and(eq(scheduledSessions.id, id), eq(scheduledSessions.updatedAt, opts.expectedUpdatedAt))
          : eq(scheduledSessions.id, id),
      )
      .returning();
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
    await this.db
      .update(scheduledSessions)
      .set({
        status: 'cancelled',
        cancelledAt: ts,
        cancelledBy: user.id,
        cancellationReason: reason,
        updatedAt: ts,
      })
      .where(eq(scheduledSessions.id, id));
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

  async restore(id: number, user: RequestUser, role: Role): Promise<ScheduledSessionWithRsvps> {
    // Effective status here too, so every write guard in this file reads the same
    // projection the API returns. ('cancelled' is never link-derived, so this one is
    // equivalent to the raw column today — it is written this way so the next guard
    // added here copies the correct pattern.)
    const { row: existing, status: effectiveStatus } = await this.getRowWithEffectiveStatus(id);
    if (effectiveStatus !== 'cancelled') throw new NotFoundException(`Scheduled session ${id} is not cancelled`);
    const ts = nowIso();
    await this.db
      .update(scheduledSessions)
      .set({
        status: 'scheduled',
        cancelledAt: null,
        cancelledBy: null,
        cancellationReason: '',
        updatedAt: ts,
      })
      .where(eq(scheduledSessions.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.restore',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
    this.emitScheduleUpdated(existing.campaignId, id);
    await this.notifyScheduleLifecycle(
      existing.campaignId,
      user,
      this.scheduleNotificationData({
        scheduleId: existing.id,
        scheduledAt: existing.scheduledAt,
        durationMinutes: existing.durationMinutes,
        title: existing.title,
        changeType: 'updated',
      }),
    );
    return this.getWithRsvps(id);
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

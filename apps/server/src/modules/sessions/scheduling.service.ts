import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ScheduledSessionCreate,
  ScheduledSessionUpdate,
  RsvpSet,
  partitionSchedules,
  diffScheduleNotificationFields,
  shouldNotifyScheduleUpdate,
  scheduleNotificationChangeType,
  scheduleNotificationFallbackTitle,
  scheduleNotificationFallbackBody,
  scheduleNotificationLabel,
  type ScheduleNotificationData,
} from '@campfire/schema';
import type { ScheduledSession, ScheduledSessionWithRsvps, SessionRsvp, CalendarFeed, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { scheduledSessions, sessionRsvps, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { generateIcsFeedToken, looksLikeIcsFeedToken } from '../../common/crypto';
import { resolveIcsFeedTokenTtlDays } from '../../common/throttle.constants';
import { foldForSearch, foldedIncludes } from '../../common/text-search';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { buildCampaignIcs } from './ics.util';

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

type ScheduledSessionCreateInput = z.infer<typeof ScheduledSessionCreate>;
type ScheduledSessionUpdateInput = z.infer<typeof ScheduledSessionUpdate>;
type RsvpSetInput = z.infer<typeof RsvpSet>;

function toDomain(row: typeof scheduledSessions.$inferSelect): ScheduledSession {
  return {
    id: row.id,
    campaignId: row.campaignId,
    scheduledAt: row.scheduledAt,
    durationMinutes: row.durationMinutes,
    title: row.title,
    location: row.location,
    notes: row.notes,
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

  async listForCampaign(campaignId: number): Promise<ScheduledSessionWithRsvps[]> {
    const rows = await this.db
      .select()
      .from(scheduledSessions)
      .where(eq(scheduledSessions.campaignId, campaignId))
      .orderBy(asc(scheduledSessions.scheduledAt));
    if (rows.length === 0) return [];

    const rsvpRows = await this.db
      .select()
      .from(sessionRsvps)
      .where(inArray(sessionRsvps.scheduledSessionId, rows.map((r) => r.id)));

    return rows.map((row) => ({
      ...toDomain(row),
      rsvps: rsvpRows.filter((r) => r.scheduledSessionId === row.id).map(rsvpToDomain),
    }));
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
    return rows
      .filter(
        (r) =>
          foldedIncludes(r.title, folded)
          || foldedIncludes(r.scheduledAt, folded)
          || foldedIncludes(r.notes, folded),
      )
      .slice(0, boundedLimit)
      .map(toDomain);
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
  async currentAndNextForCampaign(campaignId: number): Promise<{
    inProgressSession: ScheduledSessionWithRsvps | null;
    nextSession: ScheduledSessionWithRsvps | null;
  }> {
    const all = await this.listForCampaign(campaignId);
    const now = Date.now();
    const { inProgress, upcoming } = partitionSchedules(all, now);
    return {
      inProgressSession: inProgress[0] ?? null,
      nextSession: upcoming[0] ?? null,
    };
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(scheduledSessions).where(eq(scheduledSessions.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Scheduled session ${id} not found`);
    return row;
  }

  async getWithRsvps(id: number): Promise<ScheduledSessionWithRsvps> {
    const row = await this.getRowOrThrow(id);
    const rsvpRows = await this.db.select().from(sessionRsvps).where(eq(sessionRsvps.scheduledSessionId, id));
    return { ...toDomain(row), rsvps: rsvpRows.map(rsvpToDomain) };
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

  async update(id: number, input: ScheduledSessionUpdateInput, user: RequestUser, role: Role): Promise<ScheduledSessionWithRsvps> {
    const existing = await this.getRowOrThrow(id);
    const patch = { ...input };
    if (patch.scheduledAt !== undefined) patch.scheduledAt = this.normalizeScheduledAt(patch.scheduledAt);
    const next = {
      scheduledAt: patch.scheduledAt ?? existing.scheduledAt,
      durationMinutes: patch.durationMinutes ?? existing.durationMinutes,
      title: patch.title ?? existing.title,
      location: patch.location ?? existing.location,
      notes: patch.notes ?? existing.notes,
    };
    await this.db
      .update(scheduledSessions)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(scheduledSessions.id, id));

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

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    await this.db.delete(sessionRsvps).where(eq(sessionRsvps.scheduledSessionId, id));
    await this.db.delete(scheduledSessions).where(eq(scheduledSessions.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.delete',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
    this.emitScheduleUpdated(existing.campaignId, id);
    // Issue #820: cancellation is a lifecycle event — notify with a snapshot of
    // the removed night so the bell can still show a localized cancelled detail.
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
  }

  // ----- RSVPs (availability) -----

  /** Upsert the calling member's own availability for a scheduled session. */
  async setRsvp(scheduleId: number, input: RsvpSetInput, user: RequestUser, role: Role): Promise<ScheduledSessionWithRsvps> {
    const schedule = await this.getRowOrThrow(scheduleId);
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
    const schedules = await this.listForCampaign(campaign.id);
    return buildCampaignIcs({ id: campaign.id, name: campaign.name }, schedules);
  }
}

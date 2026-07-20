import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { ScheduledSessionCreate, ScheduledSessionUpdate, RsvpSet } from '@campfire/schema';
import type { ScheduledSession, ScheduledSessionWithRsvps, SessionRsvp, CalendarFeed, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { scheduledSessions, sessionRsvps, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { generateIcsFeedToken, looksLikeIcsFeedToken } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { buildCampaignIcs } from './ics.util';

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
  ) {}

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

  /** The campaign's "next session": earliest schedule not yet in the past, or null. */
  async nextForCampaign(campaignId: number): Promise<ScheduledSessionWithRsvps | null> {
    const all = await this.listForCampaign(campaignId);
    const now = Date.now();
    // scheduledAt is normalized ISO UTC (see normalizeScheduledAt), but compare
    // via Date.parse rather than string order to be robust to legacy rows.
    return all.find((s) => Date.parse(s.scheduledAt) >= now) ?? null;
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
    return { ...toDomain(row), rsvps: [] };
  }

  async update(id: number, input: ScheduledSessionUpdateInput, user: RequestUser, role: Role): Promise<ScheduledSessionWithRsvps> {
    const existing = await this.getRowOrThrow(id);
    const patch = { ...input };
    if (patch.scheduledAt !== undefined) patch.scheduledAt = this.normalizeScheduledAt(patch.scheduledAt);
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

    if (existing) {
      await this.db
        .update(sessionRsvps)
        .set({ status: input.status, note: input.note ?? existing.note, userName: user.name, updatedAt: ts })
        .where(eq(sessionRsvps.id, existing.id));
    } else {
      await this.db.insert(sessionRsvps).values({
        scheduledSessionId: scheduleId,
        userId: user.id,
        userName: user.name,
        status: input.status,
        note: input.note ?? '',
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
      detail: input.status,
    });
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
    };
  }

  /** Enable the feed, or rotate its token (invalidating the old URL) if already enabled. */
  async rotateFeed(campaignId: number, user: RequestUser, role: Role): Promise<CalendarFeed> {
    await this.getCampaignRowOrThrow(campaignId);
    const token = generateIcsFeedToken();
    await this.db.update(campaigns).set({ icsToken: token, updatedAt: nowIso() }).where(eq(campaigns.id, campaignId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.feed_rotate',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
    });
    return { token, url: icsFeedUrl(token) };
  }

  async disableFeed(campaignId: number, user: RequestUser, role: Role): Promise<CalendarFeed> {
    await this.getCampaignRowOrThrow(campaignId);
    await this.db.update(campaigns).set({ icsToken: null, updatedAt: nowIso() }).where(eq(campaigns.id, campaignId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'schedule.feed_disable',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
    });
    return { token: null, url: null };
  }

  /**
   * Resolve a public feed token to its ICS document, or throw 404. The token
   * IS the authorization (unguessable capability secret) — no user identity
   * involved, and nothing DM-only (dmSecret etc) is anywhere near this data.
   */
  async buildFeedByToken(token: string): Promise<string> {
    // Shape check first: skips a DB roundtrip for junk and guarantees the
    // lookup below never matches on an empty/whitespace token.
    if (!looksLikeIcsFeedToken(token)) throw new NotFoundException('Unknown calendar feed');
    const [campaign] = await this.db.select().from(campaigns).where(eq(campaigns.icsToken, token)).limit(1);
    if (!campaign) throw new NotFoundException('Unknown calendar feed');
    const schedules = await this.listForCampaign(campaign.id);
    return buildCampaignIcs({ id: campaign.id, name: campaign.name }, schedules);
  }
}

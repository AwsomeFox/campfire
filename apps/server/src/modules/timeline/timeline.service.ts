import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { TimelineEventCreate, TimelineEventUpdate, TimelineCalendarUpdate } from '@campfire/schema';
import type { TimelineEvent, TimelineCalendar, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { timelineEvents, timelineCalendars } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets, filterHidden, isVisibleTo, resolveCreateHidden } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type EventCreateInput = z.infer<typeof TimelineEventCreate>;
type EventUpdateInput = z.infer<typeof TimelineEventUpdate>;
type CalendarUpdateInput = z.infer<typeof TimelineCalendarUpdate>;

export function toEventDomain(row: typeof timelineEvents.$inferSelect): TimelineEvent {
  return {
    id: row.id,
    campaignId: row.campaignId,
    title: row.title,
    inWorldDate: row.inWorldDate,
    body: row.body,
    era: row.era,
    sortIndex: row.sortIndex,
    dmSecret: row.dmSecret,
    hidden: row.hidden,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCalendarDomain(row: typeof timelineCalendars.$inferSelect): TimelineCalendar {
  return {
    campaignId: row.campaignId,
    currentDate: row.currentDate,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class TimelineService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  // ---------- events ----------

  async listEvents(campaignId: number, role: Role): Promise<TimelineEvent[]> {
    // Order along the narrative by DM-controlled sortIndex (free-text in-world dates
    // aren't sortable), id as a stable tiebreaker. Drop hidden events wholesale for
    // non-DM BEFORE redacting dmSecret (issue #42 convention).
    const rows = await this.db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.campaignId, campaignId))
      .orderBy(asc(timelineEvents.sortIndex), asc(timelineEvents.id));
    return redactSecrets(filterHidden(rows.map(toEventDomain), role), role);
  }

  async getEventRowOrThrow(id: number) {
    const [row] = await this.db.select().from(timelineEvents).where(eq(timelineEvents.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Timeline event ${id} not found`);
    return row;
  }

  async getEventOrThrow(id: number, role: Role): Promise<TimelineEvent> {
    const event = toEventDomain(await this.getEventRowOrThrow(id));
    // A hidden event must be indistinguishable from a nonexistent one for non-DM —
    // 404 (not 403), so its very existence isn't leaked (issue #42 convention).
    if (!isVisibleTo(event, role)) throw new NotFoundException(`Timeline event ${id} not found`);
    return redactSecret(event, role);
  }

  async createEvent(campaignId: number, input: EventCreateInput, user: RequestUser, role: Role): Promise<TimelineEvent> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(timelineEvents)
      .values({
        campaignId,
        title: input.title,
        inWorldDate: input.inWorldDate ?? '',
        body: input.body ?? '',
        era: input.era ?? '',
        sortIndex: input.sortIndex ?? 0,
        dmSecret: input.dmSecret ?? '',
        // Private-by-default prep (#754): omit → DM-only; pass false to reveal at create.
        hidden: resolveCreateHidden(input.hidden),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'timeline.event.create',
      entityType: 'timeline_event',
      entityId: row.id,
      campaignId,
    });
    return redactSecret(toEventDomain(row), role);
  }

  async updateEvent(id: number, input: EventUpdateInput, user: RequestUser, role: Role): Promise<TimelineEvent> {
    const existing = await this.getEventRowOrThrow(id);
    const [row] = await this.db
      .update(timelineEvents)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(timelineEvents.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'timeline.event.update',
      entityType: 'timeline_event',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return redactSecret(toEventDomain(row), role);
  }

  async removeEvent(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getEventRowOrThrow(id);
    await this.db.delete(timelineEvents).where(eq(timelineEvents.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'timeline.event.delete',
      entityType: 'timeline_event',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }

  // ---------- calendar (one "current in-world date" per campaign) ----------

  /**
   * The calendar row is member-readable and carries no dmSecret, so no redaction.
   * A campaign that has never set a date reads as an empty default rather than 404 —
   * the timeline view always has a header to render.
   */
  async getCalendar(campaignId: number): Promise<TimelineCalendar> {
    const [row] = await this.db
      .select()
      .from(timelineCalendars)
      .where(eq(timelineCalendars.campaignId, campaignId))
      .limit(1);
    if (!row) {
      const ts = nowIso();
      return { campaignId, currentDate: '', note: '', createdAt: ts, updatedAt: ts };
    }
    return toCalendarDomain(row);
  }

  /**
   * The existence probe used by `setCalendar`'s lazy-create. Split into its own
   * method so the concurrency regression in db-concurrency.e2e-spec.ts can park
   * both racers between the read and the insert — better-sqlite3 is synchronous,
   * so without that coordination the two HTTP requests never actually race at
   * the SQL layer. Mirrors the `getRowOrThrow` seam used by #653's HP race test
   * and the treasury's `readLazyRow` in InventoryService (#658).
   */
  async readLazyRow(campaignId: number): Promise<typeof timelineCalendars.$inferSelect | undefined> {
    const [row] = await this.db
      .select()
      .from(timelineCalendars)
      .where(eq(timelineCalendars.campaignId, campaignId))
      .limit(1);
    return row;
  }

  async setCalendar(campaignId: number, input: CalendarUpdateInput, user: RequestUser, role: Role): Promise<TimelineCalendar> {
    const ts = nowIso();
    const existing = await this.readLazyRow(campaignId);

    // Issue #658: the read-then-insert races on concurrent first-access — two
    // callers each see `!existing`, both INSERT, and the second loses the
    // `campaignId` PRIMARY KEY constraint (an unhandled 500). The INSERT carries
    // `onConflictDoNothing({ target: campaignId })` so the loser's conflict is
    // ignored; a losing racer observes an empty RETURNING and falls through to
    // the UPDATE branch below, which applies its patch onto the winner's row.
    let row: typeof timelineCalendars.$inferSelect | undefined;
    if (!existing) {
      [row] = await this.db
        .insert(timelineCalendars)
        .values({
          campaignId,
          currentDate: input.currentDate ?? '',
          note: input.note ?? '',
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoNothing({ target: timelineCalendars.campaignId })
        .returning();
    }

    if (!row) {
      // Either `existing` was already present, or a concurrent first-access beat
      // us to the INSERT and our onConflictDoNothing yielded nothing. Either way
      // the row now exists, so apply the requested patch via UPDATE.
      const patch: Partial<typeof timelineCalendars.$inferInsert> = { updatedAt: ts };
      if (input.currentDate !== undefined) patch.currentDate = input.currentDate;
      if (input.note !== undefined) patch.note = input.note;
      [row] = await this.db
        .update(timelineCalendars)
        .set(patch)
        .where(eq(timelineCalendars.campaignId, campaignId))
        .returning();
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'timeline.calendar.set',
      entityType: 'timeline_calendar',
      entityId: campaignId,
      campaignId,
    });
    return toCalendarDomain(row);
  }
}

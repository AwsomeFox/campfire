import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, gt, or } from 'drizzle-orm';
import type { z } from 'zod';
import { TimelineEventCreate, TimelineEventUpdate, TimelineCalendarUpdate } from '@campfire/schema';
import type { TimelineEvent, TimelineCalendar, Role, TimelineListPage } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { timelineEvents, timelineCalendars } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets, filterHidden, isVisibleTo, resolveCreateHidden } from '../../common/redact';
import { buildCursorListPage } from '../../common/cursor-pagination';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { MISSING_REVISION, nextUpdatedAt, staleWrite } from '../../common/stale-write';
import { RevisionsService } from '../revisions/revisions.service';
import { clampTimelineListLimit, decodeTimelineCursor } from './timeline-pagination';

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
    private readonly revisions: RevisionsService,
  ) {}

  // ---------- events ----------

  /**
   * Returns a bounded narrative-order page (`items` / `total` / `hasMore` / `nextCursor`)
   * — never an unbounded array. Default page size is 50; pass `cursor` from a previous
   * `nextCursor` to continue. Hidden events are excluded in SQL for non-DM before paging.
   */
  async listEventsPage(
    campaignId: number,
    role: Role,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<TimelineListPage> {
    const limit = clampTimelineListLimit(opts.limit);
    const cursor = decodeTimelineCursor(opts.cursor);

    const visibilityConds = [eq(timelineEvents.campaignId, campaignId)];
    if (role !== 'dm') visibilityConds.push(eq(timelineEvents.hidden, false));

    const pageConds = [...visibilityConds];
    if (cursor) {
      pageConds.push(
        or(
          gt(timelineEvents.sortIndex, cursor.s),
          and(eq(timelineEvents.sortIndex, cursor.s), gt(timelineEvents.id, cursor.i)),
        )!,
      );
    }

    const [countRows, fetched] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(timelineEvents)
        .where(and(...visibilityConds)),
      this.db
        .select()
        .from(timelineEvents)
        .where(and(...pageConds))
        .orderBy(asc(timelineEvents.sortIndex), asc(timelineEvents.id))
        .limit(limit + 1),
    ]);

    const total = countRows[0]?.value ?? 0;
    const items = redactSecrets(filterHidden(fetched.map(toEventDomain), role), role);
    return buildCursorListPage(items, limit, total, (last) => ({
      v: 1,
      m: 'sort',
      s: last.sortIndex,
      i: last.id,
    }));
  }

  /** Full timeline for internal consumers (search, export, campaign summaries). */
  async listEvents(campaignId: number, role: Role): Promise<TimelineEvent[]> {
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

  async updateEvent(
    id: number,
    input: EventUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<TimelineEvent> {
    const existing = await this.getEventRowOrThrow(id);
    const updated = await this.db
      .update(timelineEvents)
      .set({ ...input, updatedAt: nextUpdatedAt(existing.updatedAt) })
      .where(
        opts?.expectedUpdatedAt
          ? and(eq(timelineEvents.id, id), eq(timelineEvents.updatedAt, opts.expectedUpdatedAt))
          : eq(timelineEvents.id, id),
      )
      .returning();
    if (!updated[0]) {
      const current = await this.getEventRowOrThrow(id);
      throw staleWrite(opts?.expectedUpdatedAt, current.updatedAt);
    }
    const row = updated[0];
    if (input.body !== undefined && input.body !== existing.body) {
      await this.revisions.commitProseVersion({
        entityType: 'timeline_event',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.body,
        nextProse: input.body,
        user,
      });
    }
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
    await this.revisions.removeForEntity('timeline_event', id);
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
   * Test seam for the calendar lazy-create race (#658). Exposed as a public
   * method so the concurrency regression in db-concurrency.e2e-spec.ts can park
   * both racers between the read and the insert — better-sqlite3 is synchronous,
   * so without that coordination the two HTTP requests never actually race at
   * the SQL layer. Mirrors the treasury's `readLazyRow` in InventoryService.
   */
  async readLazyRow(campaignId: number): Promise<typeof timelineCalendars.$inferSelect | undefined> {
    const [row] = await this.db
      .select()
      .from(timelineCalendars)
      .where(eq(timelineCalendars.campaignId, campaignId))
      .limit(1);
    return row;
  }

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
      return { campaignId, currentDate: '', note: '', createdAt: MISSING_REVISION, updatedAt: MISSING_REVISION };
    }
    return toCalendarDomain(row);
  }

  async setCalendar(
    campaignId: number,
    input: CalendarUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<TimelineCalendar> {
    const existing = await this.readLazyRow(campaignId);

    let row: typeof timelineCalendars.$inferSelect | undefined;
    if (!existing) {
      if (opts?.expectedUpdatedAt && opts.expectedUpdatedAt !== MISSING_REVISION) {
        throw staleWrite(opts.expectedUpdatedAt, MISSING_REVISION);
      }
      const ts = nowIso();
      const inserted = await this.db
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
      row = inserted[0];
    }

    if (!row) {
      const prior = existing ?? (await this.readLazyRow(campaignId));
      if (!prior) {
        const current = await this.getCalendar(campaignId);
        throw staleWrite(opts?.expectedUpdatedAt, current.updatedAt);
      }
      const patch: Partial<typeof timelineCalendars.$inferInsert> = { updatedAt: nextUpdatedAt(prior.updatedAt) };
      if (input.currentDate !== undefined) patch.currentDate = input.currentDate;
      if (input.note !== undefined) patch.note = input.note;
      const updated = await this.db
        .update(timelineCalendars)
        .set(patch)
        .where(
          opts?.expectedUpdatedAt
            ? and(eq(timelineCalendars.campaignId, campaignId), eq(timelineCalendars.updatedAt, opts.expectedUpdatedAt))
            : eq(timelineCalendars.campaignId, campaignId),
        )
        .returning();
      if (!updated[0]) {
        const current = await this.getCalendar(campaignId);
        throw staleWrite(opts?.expectedUpdatedAt, current.updatedAt);
      }
      row = updated[0];
      if (input.note !== undefined && input.note !== prior.note) {
        await this.revisions.commitProseVersion({
          entityType: 'timeline_calendar',
          entityId: campaignId,
          campaignId,
          priorProse: prior.note,
          nextProse: input.note,
          user,
        });
      }
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

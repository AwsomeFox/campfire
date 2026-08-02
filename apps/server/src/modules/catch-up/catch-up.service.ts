import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  catchUpChangeKind,
  type CampaignCatchUp,
  type CatchUpQuestItem,
  type CatchUpScheduleItem,
  type CatchUpSessionItem,
  type CatchUpTimelineItem,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignCatchUpCursors } from '../../db/schema';
import { nowIso } from '../../common/time';
import type { RequestUser } from '../../common/user.types';
import { QuestsService } from '../quests/quests.service';
import { SessionsService } from '../sessions/sessions.service';
import { TimelineService } from '../timeline/timeline.service';
import { SchedulingService } from '../sessions/scheduling.service';

/** Cap per group so long absences stay bounded (#549 acceptance). */
const MAX_PER_GROUP = 30;

function numericUserId(id: string | number): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cap<T>(items: T[]): { items: T[]; truncated: boolean } {
  if (items.length <= MAX_PER_GROUP) return { items, truncated: false };
  return { items: items.slice(0, MAX_PER_GROUP), truncated: true };
}

@Injectable()
export class CatchUpService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly quests: QuestsService,
    private readonly sessions: SessionsService,
    private readonly timeline: TimelineService,
    private readonly scheduling: SchedulingService,
  ) {}

  async getCursor(userId: number, campaignId: number): Promise<string | null> {
    const [row] = await this.db
      .select({ lastCaughtUpAt: campaignCatchUpCursors.lastCaughtUpAt })
      .from(campaignCatchUpCursors)
      .where(and(eq(campaignCatchUpCursors.userId, userId), eq(campaignCatchUpCursors.campaignId, campaignId)))
      .limit(1);
    return row?.lastCaughtUpAt ?? null;
  }

  async markCaughtUp(userId: number, campaignId: number, at?: string): Promise<{ lastCaughtUpAt: string }> {
    const stamp = at?.trim() || nowIso();
    const now = nowIso();
    await this.db
      .insert(campaignCatchUpCursors)
      .values({
        userId,
        campaignId,
        lastCaughtUpAt: stamp,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [campaignCatchUpCursors.userId, campaignCatchUpCursors.campaignId],
        set: { lastCaughtUpAt: stamp, updatedAt: now },
      });
    return { lastCaughtUpAt: stamp };
  }

  /**
   * Role-safe cross-module diff since the member's catch-up cursor (#549).
   * `sinceParam` overrides the reference instant (reopen an earlier period).
   * When no cursor is stored yet, falls back to the latest session date — same
   * anchor as GET /quests/changes. Hidden entities and dmSecret never appear.
   */
  async getCatchUp(
    campaignId: number,
    user: RequestUser,
    role: Role,
    sinceParam?: string,
  ): Promise<CampaignCatchUp> {
    const userId = numericUserId(user.id);
    const lastCaughtUpAt = userId != null ? await this.getCursor(userId, campaignId) : null;

    let since: string | null;
    if (sinceParam && sinceParam.trim() !== '') {
      since = sinceParam.trim();
    } else if (lastCaughtUpAt) {
      since = lastCaughtUpAt;
    } else {
      since = await this.quests.referenceSessionDate(campaignId);
    }

    const empty: CampaignCatchUp = {
      since,
      lastCaughtUpAt,
      quests: [],
      sessions: [],
      timeline: [],
      schedules: [],
      totalCount: 0,
      truncated: false,
    };
    if (since == null) return empty;

    const [questChanges, sessionRows, timelineRows, scheduleRows] = await Promise.all([
      this.quests.changesSince(campaignId, since, role),
      this.sessions.listForCampaign(campaignId, role),
      this.timeline.listEvents(campaignId, role),
      this.scheduling.listForCampaign(campaignId, role),
    ]);

    const quests: CatchUpQuestItem[] = questChanges.quests.map((quest) => {
      const resolved =
        (quest.status === 'completed' || quest.status === 'failed') && quest.updatedAt >= since!;
      return {
        kind: catchUpChangeKind(quest.createdAt, quest.updatedAt, since!, resolved),
        quest,
      };
    });

    const sessions: CatchUpSessionItem[] = sessionRows
      .filter((s) => s.updatedAt >= since! || s.createdAt >= since!)
      .map((session) => ({
        kind: catchUpChangeKind(session.createdAt, session.updatedAt, since!),
        session,
      }));

    const timeline: CatchUpTimelineItem[] = timelineRows
      .filter((e) => e.updatedAt >= since!)
      .map((event) => ({
        kind: catchUpChangeKind(event.createdAt, event.updatedAt, since!),
        event,
      }));

    const schedules: CatchUpScheduleItem[] = scheduleRows
      .filter((s) => s.updatedAt >= since! || s.createdAt >= since!)
      .map((schedule) => ({
        kind: catchUpChangeKind(schedule.createdAt, schedule.updatedAt, since!),
        schedule,
      }));

    const questCap = cap(quests);
    const sessionCap = cap(sessions);
    const timelineCap = cap(timeline);
    const scheduleCap = cap(schedules);
    const truncated =
      questCap.truncated || sessionCap.truncated || timelineCap.truncated || scheduleCap.truncated;
    const totalCount = quests.length + sessions.length + timeline.length + schedules.length;

    return {
      since,
      lastCaughtUpAt,
      quests: questCap.items,
      sessions: sessionCap.items,
      timeline: timelineCap.items,
      schedules: scheduleCap.items,
      totalCount,
      truncated,
    };
  }
}

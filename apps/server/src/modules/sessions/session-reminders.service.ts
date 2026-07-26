import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { scheduleNotificationLabel } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignMembers,
  notificationReminders,
  scheduledSessions,
  sessionRsvps,
} from '../../db/schema';
import { NotificationsService } from '../notifications/notifications.service';
import { scheduleLiveSql } from './scheduling-queries';

/** Send the pre-session reminder once a game night is within this window of now. */
const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
/** Send the unanswered-RSVP nudge inside the same lead window. */
const NUDGE_LEAD_MS = 24 * 60 * 60 * 1000;
/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Issue #789 — deduplicated session reminders + optional unanswered-RSVP nudges.
 *
 * A periodic sweep finds game nights starting within the lead window and, for
 * every campaign member, emits exactly one reminder (and, for members who have
 * not RSVP'd, one nudge). The `notification_reminders` unique ledger
 * (schedule, user, kind) is the dedup guard: an INSERT that hits the unique
 * index is a no-op, so a rescheduled night or a retried/overlapping sweep never
 * double-sends. The emitted notifications flow through the normal fan-out, so
 * they honor the recipient's `schedule`-category preference and quiet hours.
 *
 * `runReminderSweep(nowMs)` is deterministic given `nowMs` (all timestamps derive
 * from it), so unit/e2e tests drive it directly instead of waiting on the interval.
 */
@Injectable()
export class SessionRemindersService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly notifications: NotificationsService,
  ) {}

  /** Start the background sweep on an `.unref()`d interval (mirrors the audit/rolls sweeps). */
  onApplicationBootstrap(): void {
    const timer = setInterval(() => {
      void this.runReminderSweep().catch(() => {
        /* best-effort background sweep */
      });
    }, SWEEP_INTERVAL_MS);
    timer.unref();
  }

  /**
   * Emit reminders/nudges for every upcoming game night in the lead window.
   * Returns counters for tests. Best-effort per notification; a single failure
   * does not abort the sweep.
   */
  async runReminderSweep(nowMs: number = Date.now()): Promise<{ reminders: number; nudges: number }> {
    const nowStr = new Date(nowMs).toISOString();
    const horizonMs = nowMs + Math.max(REMINDER_LEAD_MS, NUDGE_LEAD_MS);
    const horizonStr = new Date(horizonMs).toISOString();

    // Drop ledger rows for sessions that have already started.
    const pastSessions = await this.db
      .select({ id: scheduledSessions.id })
      .from(scheduledSessions)
      .where(lte(scheduledSessions.scheduledAt, nowStr));
    const pastIds = pastSessions.map((s) => s.id);
    if (pastIds.length > 0) {
      await this.db.delete(notificationReminders).where(inArray(notificationReminders.scheduledSessionId, pastIds));
    }

    // scheduleLiveSql(), not the raw status column (#504). This is a projection of
    // "live upcoming game nights", so it has to be THE live projection — the same one
    // Upcoming/Next render and the same one the RSVP/cancel write guards consult via
    // effectiveStatusOf. A `completed` row whose recap is trashed is effectively
    // `scheduled` again: it shows on the calendar as an ordinary night and accepts
    // RSVPs, so it must also remind. Filtering on the raw column left exactly one thing
    // broken on an otherwise-working card — the part that happens with nobody present.
    const upcoming = await this.db
      .select()
      .from(scheduledSessions)
      .where(and(
        scheduleLiveSql(),
        gt(scheduledSessions.scheduledAt, nowStr),
        lte(scheduledSessions.scheduledAt, horizonStr),
      ));

    if (upcoming.length === 0) return { reminders: 0, nudges: 0 };

    const campaignIds = [...new Set(upcoming.map((s) => s.campaignId))];
    const sessionIds = upcoming.map((s) => s.id);

    const memberRows = await this.db
      .select({ campaignId: campaignMembers.campaignId, userId: campaignMembers.userId })
      .from(campaignMembers)
      .where(inArray(campaignMembers.campaignId, campaignIds));
    const membersByCampaign = new Map<number, number[]>();
    for (const { campaignId, userId } of memberRows) {
      const list = membersByCampaign.get(campaignId);
      if (list) list.push(userId);
      else membersByCampaign.set(campaignId, [userId]);
    }

    const rsvpRows = await this.db
      .select({ scheduledSessionId: sessionRsvps.scheduledSessionId, userId: sessionRsvps.userId })
      .from(sessionRsvps)
      .where(inArray(sessionRsvps.scheduledSessionId, sessionIds));
    const rsvpedBySession = new Map<number, Set<number>>();
    for (const { scheduledSessionId, userId } of rsvpRows) {
      const n = Number(userId);
      if (!Number.isInteger(n) || n <= 0) continue;
      const set = rsvpedBySession.get(scheduledSessionId);
      if (set) set.add(n);
      else rsvpedBySession.set(scheduledSessionId, new Set([n]));
    }

    let reminders = 0;
    let nudges = 0;
    for (const session of upcoming) {
      const startsInMs = new Date(session.scheduledAt).getTime() - nowMs;
      const members = membersByCampaign.get(session.campaignId) ?? [];
      if (members.length === 0) continue;

      const rsvped = rsvpedBySession.get(session.id) ?? new Set<number>();
      const label = scheduleNotificationLabel(session.title);

      for (const userId of members) {
        if (startsInMs <= REMINDER_LEAD_MS) {
          const sent = await this.emitOnce(session.id, userId, 'session_reminder', nowMs, () =>
            this.notifications.notifyUserStrict(userId, session.campaignId, null, {
              type: 'session_reminder',
              title: `Reminder: ${label} is coming up`,
              entityId: session.id,
            }),
          );
          if (sent) reminders += 1;
        }
        const hasRsvp = rsvped.has(userId);
        if (!hasRsvp && startsInMs <= NUDGE_LEAD_MS) {
          const sent = await this.emitOnce(session.id, userId, 'rsvp_nudge', nowMs, () =>
            this.notifications.notifyUserStrict(userId, session.campaignId, null, {
              type: 'rsvp_nudge',
              title: `Can you make ${label}? Let the party know.`,
              entityId: session.id,
            }),
          );
          if (sent) nudges += 1;
        }
      }
    }
    return { reminders, nudges };
  }

  /**
   * Claim the dedup ledger, emit the notification, and roll back the claim when
   * delivery fails so a transient error can be retried on the next sweep.
   */
  private async emitOnce(
    scheduledSessionId: number,
    userId: number,
    kind: 'session_reminder' | 'rsvp_nudge',
    nowMs: number,
    emit: () => Promise<void>,
  ): Promise<boolean> {
    if (!(await this.claim(scheduledSessionId, userId, kind, nowMs))) return false;
    try {
      await emit();
      return true;
    } catch {
      await this.releaseClaim(scheduledSessionId, userId, kind);
      return false;
    }
  }

  /**
   * Atomically claim a (schedule, user, kind) marker. Returns true only when THIS
   * call inserted the row — a conflict (already claimed) returns false, which is
   * the dedup guarantee against reschedule/retry double-sends.
   */
  private async claim(
    scheduledSessionId: number,
    userId: number,
    kind: 'session_reminder' | 'rsvp_nudge',
    nowMs: number,
  ): Promise<boolean> {
    const createdAt = new Date(nowMs).toISOString();
    const inserted = await this.db
      .insert(notificationReminders)
      .values({ scheduledSessionId, userId, kind, createdAt })
      .onConflictDoNothing()
      .returning({ id: notificationReminders.id });
    return inserted.length > 0;
  }

  private async releaseClaim(
    scheduledSessionId: number,
    userId: number,
    kind: 'session_reminder' | 'rsvp_nudge',
  ): Promise<void> {
    await this.db
      .delete(notificationReminders)
      .where(
        and(
          eq(notificationReminders.scheduledSessionId, scheduledSessionId),
          eq(notificationReminders.userId, userId),
          eq(notificationReminders.kind, kind),
        ),
      );
  }
}

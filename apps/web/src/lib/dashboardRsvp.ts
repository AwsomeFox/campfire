/**
 * Dashboard next-session RSVP cue (issue #785).
 *
 * SessionLog already receives `nextSession.rsvps` but historically always showed
 * "RSVP →". These helpers derive the viewer's saved response (matching both
 * real `String(users.id)` rows and DEV_AUTH `dev:<username>` rows) and the
 * copy/priority for the dashboard card.
 */
import type { RsvpStatus, SessionRsvp } from '@campfire/schema';

export type DashboardRsvpCue = {
  /** Primary status line: You're in / Maybe / You're out / RSVP needed. */
  statusLabel: string;
  /**
   * True only when the viewer has not answered. Unanswered is the only state
   * that keeps the urgent RSVP affordance; after a response the card shows the
   * saved status plus a quieter "Change RSVP" link.
   */
  unanswered: boolean;
  /** Present after a response so the viewer can revise without losing status. */
  changeLabel: string | null;
};

const STATUS_LABELS: Record<RsvpStatus, string> = {
  yes: "You're in",
  maybe: 'Maybe',
  no: "You're out",
};

/** Ids that may appear on `session_rsvps.user_id` for the signed-in viewer. */
export function viewerRsvpIds(user: { id: number; username: string } | null | undefined): Set<string> {
  if (!user) return new Set();
  return new Set([String(user.id), `dev:${user.username}`]);
}

export function findViewerRsvp(
  rsvps: readonly SessionRsvp[],
  myIds: ReadonlySet<string>,
): SessionRsvp | undefined {
  return rsvps.find((r) => myIds.has(r.userId));
}

/** Derive the dashboard RSVP cue from the viewer's saved status (or lack of one). */
export function dashboardRsvpCue(status: RsvpStatus | null | undefined): DashboardRsvpCue {
  if (!status) {
    return { statusLabel: 'RSVP needed', unanswered: true, changeLabel: null };
  }
  return {
    statusLabel: STATUS_LABELS[status],
    unanswered: false,
    changeLabel: 'Change RSVP',
  };
}

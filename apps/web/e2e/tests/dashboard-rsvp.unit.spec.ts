import { expect, test } from '@playwright/test';
import type { SessionRsvp } from '@campfire/schema';
import {
  dashboardRsvpCue,
  findViewerRsvp,
  viewerRsvpIds,
} from '../../src/lib/dashboardRsvp';

/**
 * Issue #785 — dashboard next-session RSVP cue.
 *
 * Pins the pure matching/copy contract so SessionLog can show the viewer's
 * saved response (real + DEV_AUTH ids) without always prompting "RSVP →".
 */

function rsvp(partial: Partial<SessionRsvp> & Pick<SessionRsvp, 'userId' | 'status'>): SessionRsvp {
  return {
    id: 1,
    scheduledSessionId: 10,
    userName: 'Player',
    note: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...partial,
  };
}

test.describe('dashboard RSVP cue (issue #785)', () => {
  test.describe('viewerRsvpIds — real and DEV_AUTH identities', () => {
    test('real cookie users match String(users.id) and the legacy dev: alias', () => {
      expect([...viewerRsvpIds({ id: 42, username: 'player' })].sort()).toEqual([
        '42',
        'dev:player',
      ]);
    });

    test('DEV_AUTH /me synthesis (id 0 + username) still matches the stored dev: row', () => {
      // auth.controller synthesizes id: 0 for header-based users; RSVP rows keep
      // the RequestUser.id form `dev:<name>`. Matching both keeps the cue honest.
      expect(viewerRsvpIds({ id: 0, username: 'player' }).has('dev:player')).toBe(true);
      expect(viewerRsvpIds({ id: 0, username: 'player' }).has('0')).toBe(true);
    });

    test('signed-out / loading yields an empty set', () => {
      expect(viewerRsvpIds(null).size).toBe(0);
      expect(viewerRsvpIds(undefined).size).toBe(0);
    });
  });

  test.describe('findViewerRsvp', () => {
    const rows = [
      rsvp({ userId: '7', status: 'no', userName: 'Other' }),
      rsvp({ id: 2, userId: '42', status: 'yes', userName: 'Player' }),
    ];

    test('matches a real numeric user id on the RSVP row', () => {
      const mine = findViewerRsvp(rows, viewerRsvpIds({ id: 42, username: 'player' }));
      expect(mine?.status).toBe('yes');
      expect(mine?.userId).toBe('42');
    });

    test('matches a DEV_AUTH `dev:<username>` RSVP row', () => {
      const devRows = [rsvp({ userId: 'dev:player', status: 'maybe' })];
      const mine = findViewerRsvp(devRows, viewerRsvpIds({ id: 0, username: 'player' }));
      expect(mine?.status).toBe('maybe');
    });

    test('returns undefined when the viewer has not answered', () => {
      expect(findViewerRsvp(rows, viewerRsvpIds({ id: 99, username: 'ghost' }))).toBeUndefined();
    });
  });

  test.describe('dashboardRsvpCue — copy and unanswered priority', () => {
    test('unanswered is the only urgent cue', () => {
      expect(dashboardRsvpCue(null)).toEqual({
        statusLabel: 'RSVP needed',
        unanswered: true,
        changeLabel: null,
      });
      expect(dashboardRsvpCue(undefined).unanswered).toBe(true);
    });

    test('yes / maybe / no show saved status and keep Change RSVP', () => {
      expect(dashboardRsvpCue('yes')).toEqual({
        statusLabel: "You're in",
        unanswered: false,
        changeLabel: 'Change RSVP',
      });
      expect(dashboardRsvpCue('maybe')).toEqual({
        statusLabel: 'Maybe',
        unanswered: false,
        changeLabel: 'Change RSVP',
      });
      expect(dashboardRsvpCue('no')).toEqual({
        statusLabel: "You're out",
        unanswered: false,
        changeLabel: 'Change RSVP',
      });
    });
  });
});

import { expect, test } from '@playwright/test';
import { nextMembershipSignalState, type MembershipSignalState } from '../../src/features/notifications/NotificationsBell';

/**
 * Issue #1590 — the account-wide `/me` refresh trigger, pulled out of
 * `NotificationsProvider` into a pure function so this decision (and only this) can be
 * pinned without rendering React or mocking `fetch`/AuthProvider.
 *
 * `NotificationsProvider` already polls `GET /notifications/unread-count` on an interval
 * that runs regardless of which campaign (or none) is open — it is mounted once, inside
 * `Layout`, which wraps every authenticated route including `/`, `/admin/*`, and
 * `/preferences`, not just `/c/:campaignId/*`. The only thing missing was something to
 * discriminate "ordinary unread count went up" from "your role changed, cached /me is
 * stale" (`membershipChanged`, added to the response) and something to act on it. This
 * function is the "act on it" half.
 *
 * A plain `false -> true` boolean edge trigger was the FIRST version of this function, and
 * it is wrong — caught by an end-to-end browser test (see `membership-account-wide-refresh
 * .spec.ts`), not by inspection. A fresh account already carries an unread
 * `added_to_campaign` notification from the original "you were added to this campaign"
 * event, so `membershipChanged` reads true from the very first poll, before any role
 * change ever happens. Every LATER role change is then a `true -> true` observation — no
 * edge — and a pure boolean trigger never refreshes again for that account, for as long as
 * ANY membership-shaped notification stays unread (indefinitely; reading it is a manual
 * action the user has no reason to take). Tracking `count` alongside the flag, and
 * refreshing when the flag is on AND the count has moved, is what the tests below pin.
 */
test.describe('nextMembershipSignalState (#1590)', () => {
  test('first observation with the flag on refreshes (previous state unknown)', () => {
    const result = nextMembershipSignalState(null, { membershipChanged: true, count: 1 });
    expect(result).toEqual({ next: { membershipChanged: true, count: 1 }, shouldRefresh: true });
  });

  test('the SAME still-unread notification on the next poll (count unchanged) does not refresh again', () => {
    const previous: MembershipSignalState = { membershipChanged: true, count: 1 };
    const result = nextMembershipSignalState(previous, { membershipChanged: true, count: 1 });
    expect(result).toEqual({ next: { membershipChanged: true, count: 1 }, shouldRefresh: false });
  });

  test('a SECOND membership-shaped notification (count moved) refreshes again, even though the flag was already on', () => {
    // This is the exact bug a plain boolean edge trigger had: an account that already had
    // one unread `added_to_campaign` row (from being added to the campaign) gets a role
    // change later, which is a second, distinct `added_to_campaign` row. The flag was
    // already true both times; only the count moved.
    const previous: MembershipSignalState = { membershipChanged: true, count: 1 };
    const result = nextMembershipSignalState(previous, { membershipChanged: true, count: 2 });
    expect(result).toEqual({ next: { membershipChanged: true, count: 2 }, shouldRefresh: true });
  });

  test('the flag clearing (read, or superseded) never refreshes and resets what is remembered', () => {
    const previous: MembershipSignalState = { membershipChanged: true, count: 2 };
    const result = nextMembershipSignalState(previous, { membershipChanged: false, count: 1 });
    expect(result).toEqual({ next: { membershipChanged: false, count: 1 }, shouldRefresh: false });
  });

  test('the flag staying off is a no-op regardless of count churn from ordinary notifications', () => {
    const previous: MembershipSignalState = { membershipChanged: false, count: 3 };
    const result = nextMembershipSignalState(previous, { membershipChanged: false, count: 7 });
    expect(result).toEqual({ next: { membershipChanged: false, count: 7 }, shouldRefresh: false });
  });

  test('a realistic poll sequence refreshes once per DISTINCT membership signal, not once per poll', () => {
    // quiet -> added to a campaign (count 1, refresh) -> polled again unchanged (no refresh)
    // -> role changed while still unread (count 2, refresh) -> user reads everything (count
    // 0, no refresh, re-arms) -> a LATER, separate role change (count 1 again — same NUMBER
    // as the very first signal, which is exactly why re-arming on `!previous.membershipChanged`
    // rather than only on count differing matters).
    const observations = [
      { membershipChanged: false, count: 0 },
      { membershipChanged: true, count: 1 },
      { membershipChanged: true, count: 1 },
      { membershipChanged: true, count: 2 },
      { membershipChanged: false, count: 0 },
      { membershipChanged: true, count: 1 },
    ];
    let state: MembershipSignalState = null;
    const refreshes: boolean[] = [];
    for (const observed of observations) {
      const result = nextMembershipSignalState(state, observed);
      state = result.next;
      refreshes.push(result.shouldRefresh);
    }
    expect(refreshes).toEqual([false, true, false, true, false, true]);
  });
});

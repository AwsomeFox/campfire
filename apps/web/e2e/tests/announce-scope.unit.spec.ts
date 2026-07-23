import { expect, test } from '@playwright/test';
import { announceScopeChanged, type AnnounceScope } from '../../src/components/announceScope';

/**
 * Issue #434 — the app-root Announcer must wipe when auth identity or campaign
 * scope changes so prior encounter text cannot leak into /login or another
 * user's session. The React hook is a thin useLayoutEffect around this predicate.
 *
 * Cross-identity store review (same class of bug = app-root React UI state that
 * outlives the authed tree):
 *   - AnnounceProvider: fixed here (lives above the router).
 *   - NotificationsProvider: Layout-scoped + keyed by userId; remounts/resets.
 *   - CampaignProvider / MentionsProvider / AiDmLiveActivity: authed/campaign
 *     scoped and remount with their trees.
 *   - React Query + SW API cache: already wiped on logout/identity change
 *     (AuthProvider / #268 / #579).
 *   - localStorage dice presets / AI transcript: campaign-keyed preferences, not
 *     in-DOM live-region leaks into /login.
 */
function scope(partial: Partial<AnnounceScope>): AnnounceScope {
  return { userId: null, campaignId: undefined, ...partial };
}

test.describe('announce scope changes (issue #434)', () => {
  test('stable scope does not clear', () => {
    expect(announceScopeChanged(scope({ userId: 1, campaignId: 2 }), scope({ userId: 1, campaignId: 2 }))).toBe(false);
  });

  test('logout (userId → null) clears', () => {
    expect(announceScopeChanged(scope({ userId: 1, campaignId: 2 }), scope({ userId: null, campaignId: 2 }))).toBe(true);
  });

  test('account switch clears', () => {
    expect(announceScopeChanged(scope({ userId: 1, campaignId: 2 }), scope({ userId: 99, campaignId: 2 }))).toBe(true);
  });

  test('campaign switch clears', () => {
    expect(announceScopeChanged(scope({ userId: 1, campaignId: 2 }), scope({ userId: 1, campaignId: 9 }))).toBe(true);
  });

  test('leaving campaign scope (→ home) clears', () => {
    expect(
      announceScopeChanged(scope({ userId: 1, campaignId: 2 }), scope({ userId: 1, campaignId: undefined })),
    ).toBe(true);
  });

  test('sign-in from logged-out clears (public → authed)', () => {
    expect(announceScopeChanged(scope({ userId: null }), scope({ userId: 1, campaignId: 2 }))).toBe(true);
  });
});

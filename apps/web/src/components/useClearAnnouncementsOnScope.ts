/**
 * Clears the app-root Announcer when the auth/campaign scope changes, and again
 * on unmount (issue #434).
 *
 * AnnounceProvider lives above the router, so encounter text ("Round 1 — …'s
 * turn") otherwise survives into /login and the next user's session. useLayoutEffect
 * runs before paint so public layouts never briefly contain the prior message.
 *
 * First mount also clears: LoginPage may leave an assertive "Signed out"
 * confirmation in the app-root announcer, and a freshly mounted AuthedLayout
 * would otherwise skip the scope-change path (prev is null) and keep that alert
 * into the next authenticated session.
 *
 * Scope-change and unmount clears are split into separate effects so a dependency
 * change does not clear twice (cleanup-before-rerun + body clear).
 */
import { useLayoutEffect, useRef } from 'react';
import { announceScopeChanged, type AnnounceScope } from './announceScope';
import { useClearAnnouncements } from './Announcer';

export function useClearAnnouncementsOnScope(
  userId: number | null,
  campaignId: number | undefined = undefined,
): void {
  const clear = useClearAnnouncements();
  const prevRef = useRef<AnnounceScope | null>(null);

  // Clear on first mount and whenever identity / campaign scope changes.
  useLayoutEffect(() => {
    const next: AnnounceScope = { userId, campaignId };
    const prev = prevRef.current;
    if (prev == null || announceScopeChanged(prev, next)) {
      clear();
    }
    prevRef.current = next;
  }, [userId, campaignId, clear]);

  // Clear only when the calling tree unmounts (sign-out → /login, cast-to-TV
  // routes outside Layout, leaving campaign chrome). Independent of the
  // scope-change effect so dep updates do not double-clear.
  useLayoutEffect(() => {
    return () => {
      clear();
    };
  }, [clear]);
}

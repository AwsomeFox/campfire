/**
 * Clears the app-root Announcer when the auth/campaign scope changes, and again
 * on unmount (issue #434).
 *
 * AnnounceProvider lives above the router, so encounter text ("Round 1 — …'s
 * turn") otherwise survives into /login and the next user's session. useLayoutEffect
 * runs before paint so public layouts never briefly contain the prior message.
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

  useLayoutEffect(() => {
    const next: AnnounceScope = { userId, campaignId };
    const prev = prevRef.current;
    if (prev && announceScopeChanged(prev, next)) {
      clear();
    }
    prevRef.current = next;
    return () => {
      // Layout / authed-tree unmount (sign-out → /login, leaving campaign chrome).
      clear();
    };
  }, [userId, campaignId, clear]);
}

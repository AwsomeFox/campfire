/**
 * Shared handling for campaign-scoped 403s ("Not a member" / access revoked).
 *
 * `me.memberships` is fetched once at login, so it goes stale the moment a DM
 * removes or promotes someone mid-session: a removed player keeps their nav/tiles
 * and just retry-loops 403s forever; a promoted player never gains DM nav until
 * they happen to reload. This hook gives campaign-scoped pages a single place to
 * report "the server just told me I don't belong here" — it refreshes both the
 * auth membership list and the campaign list exactly once (guarded so it can't
 * loop) and flips a flag so the page can swap its error UI for a friendly
 * "you no longer have access" message instead of retrying the failed request.
 */
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { useAuth } from './auth';
import { useCampaigns } from './CampaignContext';

const ACCESS_MESSAGE_HINTS = ['not a member', 'access', 'forbidden'];

function looksLikeAccessError(err: unknown): err is ApiError {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  const msg = err.message.toLowerCase();
  return ACCESS_MESSAGE_HINTS.some((hint) => msg.includes(hint));
}

export function useCampaignAccessError() {
  const { refresh: refreshAuth } = useAuth();
  const { refresh: refreshCampaigns } = useCampaigns();
  const [lostAccess, setLostAccess] = useState(false);
  const handledOnce = useRef(false);

  /**
   * Feed a caught error in here. Returns true if it was an access error (and was
   * handled), so callers can skip their normal error-message path.
   */
  const handle = useCallback(
    (err: unknown): boolean => {
      if (!looksLikeAccessError(err)) return false;
      setLostAccess(true);
      if (!handledOnce.current) {
        handledOnce.current = true;
        void refreshAuth();
        void refreshCampaigns();
      }
      return true;
    },
    [refreshAuth, refreshCampaigns],
  );

  return { lostAccess, handle };
}

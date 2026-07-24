/**
 * Shared campaign access context (issue #704): role + writability for the active
 * `/c/:campaignId` subtree. Layout provides this around the outlet; feature pages
 * read `useCampaignAccess()` instead of re-deriving role/status checks.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from './auth';
import { useCampaign } from './CampaignContext';
import { deriveCampaignAccess, type CampaignAccessFlags } from './campaignAccess';

const CampaignAccessContext = createContext<CampaignAccessFlags | null>(null);

export function CampaignAccessProvider({
  campaignId,
  children,
}: {
  campaignId: number;
  children: ReactNode;
}) {
  const { roleIn } = useAuth();
  const campaign = useCampaign(campaignId);
  const value = useMemo(
    () => deriveCampaignAccess(roleIn(campaignId), campaign),
    [roleIn, campaignId, campaign],
  );
  return <CampaignAccessContext.Provider value={value}>{children}</CampaignAccessContext.Provider>;
}

/** Access flags for the campaign scoped by Layout's provider. */
export function useCampaignAccess(): CampaignAccessFlags {
  const ctx = useContext(CampaignAccessContext);
  if (!ctx) return deriveCampaignAccess(null, null);
  return ctx;
}

/** When a component owns its own campaign id (or sits outside Layout's provider). */
export function useCampaignAccessFor(campaignId: number | undefined): CampaignAccessFlags {
  const { roleIn } = useAuth();
  const campaign = useCampaign(campaignId);
  return useMemo(
    () => deriveCampaignAccess(campaignId !== undefined ? roleIn(campaignId) : null, campaign),
    [roleIn, campaignId, campaign],
  );
}

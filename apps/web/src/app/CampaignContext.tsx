/**
 * Lightweight campaign-scoped context: resolves the active campaign's display
 * name (and full record) for the current /c/:campaignId subtree so Layout and
 * feature pages don't each re-fetch the campaign list.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Campaign } from '@campfire/schema';
import { api, API } from '../lib/api';

interface CampaignContextValue {
  campaigns: Campaign[];
  loading: boolean;
  /** True when the last refresh() failed — lets consumers tell "API down" apart from "no campaigns yet". */
  error: boolean;
  refresh(): Promise<void>;
}

const CampaignContext = createContext<CampaignContextValue>({
  campaigns: [],
  loading: true,
  error: false,
  refresh: async () => {},
});

export function CampaignProvider({ children }: { children: ReactNode }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = async () => {
    try {
      const list = await api.get<Campaign[]>(`${API}/campaigns`);
      setCampaigns(list);
      setError(false);
    } catch {
      // Without this catch, an API outage left `campaigns` at its initial [] and
      // HomePage rendered the "No campaigns yet" empty state — indistinguishable
      // from a real new user. Surface it as an error instead.
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <CampaignContext.Provider value={{ campaigns, loading, error, refresh }}>
      {children}
    </CampaignContext.Provider>
  );
}

export function useCampaigns() {
  return useContext(CampaignContext);
}

export function useCampaign(campaignId: number | undefined): Campaign | undefined {
  const { campaigns } = useCampaigns();
  if (campaignId === undefined) return undefined;
  return campaigns.find((c) => c.id === campaignId);
}

/**
 * Campaign @-mention link targets (issue #64). Fetched once per campaign and
 * shared so the Markdown renderer can auto-link known entity names, and the
 * search box / pickers can offer them. Best-effort: a failed fetch just means
 * no auto-linking (never a page error).
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MentionTarget } from '@campfire/schema';
import { api, API } from '../lib/api';

type MentionsValue = {
  campaignId: number | undefined;
  targets: MentionTarget[];
};

const MentionsContext = createContext<MentionsValue>({ campaignId: undefined, targets: [] });

/** Route sub-path for each linkable entity type (mirrors the app router). */
export const mentionRoute: Record<MentionTarget['type'], string> = {
  quest: 'quests',
  npc: 'npcs',
  faction: 'factions',
  location: 'locations',
  character: 'characters',
  session: 'sessions',
  // List-only pages (no per-id route): a mention links to the list, matching the
  // existing session behaviour.
  timeline: 'timeline',
  arc: 'storylines',
  beat: 'storylines',
};

export function MentionsProvider({ campaignId, children }: { campaignId: number | undefined; children: ReactNode }) {
  const [targets, setTargets] = useState<MentionTarget[]>([]);

  useEffect(() => {
    if (campaignId === undefined) {
      setTargets([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.get<MentionTarget[]>(`${API}/campaigns/${campaignId}/mentions`);
        if (!cancelled) setTargets(rows);
      } catch {
        if (!cancelled) setTargets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const value = useMemo(() => ({ campaignId, targets }), [campaignId, targets]);
  return <MentionsContext.Provider value={value}>{children}</MentionsContext.Provider>;
}

export function useMentions(): MentionsValue {
  return useContext(MentionsContext);
}

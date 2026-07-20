/**
 * Campaign-wide search (issue #64). Reads the `?q=` query param, calls
 * GET /campaigns/:id/search, and lists hits grouped by type with deep links to
 * each entity's page. Role visibility is enforced server-side — a player never
 * sees hidden entities or dmSecret text here.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { SearchResponse, SearchResult } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, EmptyState, ErrorNote, Skeleton, TextInput } from '../../components/ui';

const typeLabel: Record<SearchResult['type'], string> = {
  quest: 'Quests',
  npc: 'NPCs',
  location: 'Locations',
  character: 'Characters',
  session: 'Sessions',
  note: 'Notes',
};

const typeIcon: Record<SearchResult['type'], string> = {
  quest: '📜',
  npc: '🧑',
  location: '🗺️',
  character: '🛡️',
  session: '📖',
  note: '📝',
};

const typeRoute: Record<SearchResult['type'], string> = {
  quest: 'quests',
  npc: 'npcs',
  location: 'locations',
  character: 'characters',
  session: 'sessions',
  note: 'notes',
};

/** Where a result links to. Notes anchored to an entity link to that entity. */
function resultHref(campaignId: number, r: SearchResult): string {
  if (r.type === 'note') {
    if (r.entityType && r.entityType !== 'campaign' && r.entityId != null) {
      const sub = r.entityType === 'session' ? 'sessions' : `${r.entityType}s`;
      return `/c/${campaignId}/${sub}/${r.entityId}`;
    }
    return `/c/${campaignId}/notes`;
  }
  if (r.type === 'session') return `/c/${campaignId}/sessions`;
  return `/c/${campaignId}/${typeRoute[r.type]}/${r.id}`;
}

export default function SearchPage() {
  const { campaignId: campaignIdParam } = useParams<{ campaignId: string }>();
  const campaignId = Number(campaignIdParam);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const q = searchParams.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(q);
  }, [q]);

  useEffect(() => {
    if (!q.trim()) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await api.get<SearchResponse>(`${API}/campaigns/${campaignId}/search?q=${encodeURIComponent(q)}`);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Search failed.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q, campaignId]);

  const grouped = useMemo(() => {
    const groups = new Map<SearchResult['type'], SearchResult[]>();
    for (const r of data?.results ?? []) {
      const list = groups.get(r.type) ?? [];
      list.push(r);
      groups.set(r.type, list);
    }
    return groups;
  }, [data]);

  const order: SearchResult['type'][] = ['quest', 'npc', 'location', 'character', 'session', 'note'];

  return (
    <div className="max-w-3xl mx-auto px-4 mt-6 space-y-4">
      <h1 className="text-xl font-semibold text-white">Search</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const next = input.trim();
          setSearchParams(next ? { q: next } : {});
        }}
      >
        <TextInput
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search quests, NPCs, locations, sessions, notes…"
          aria-label="Search this campaign"
        />
      </form>

      {loading && <Skeleton lines={5} />}
      {error && <ErrorNote message={error} />}

      {!loading && !error && q.trim() && data && data.results.length === 0 && (
        <EmptyState icon="🔍" title={`No results for “${q}”`} hint="Try a different word or a name." />
      )}

      {!loading && !error && data && data.results.length > 0 && (
        <div className="space-y-5">
          <p className="text-xs text-muted">
            {data.results.length} result{data.results.length === 1 ? '' : 's'} for “{q}”
          </p>
          {order
            .filter((t) => grouped.has(t))
            .map((t) => (
              <div key={t} className="space-y-2">
                <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                  <span>{typeIcon[t]}</span>
                  {typeLabel[t]}
                  <span className="text-muted font-normal">({grouped.get(t)!.length})</span>
                </h2>
                <div className="space-y-2">
                  {grouped.get(t)!.map((r) => (
                    <Link key={`${r.type}-${r.id}`} to={resultHref(campaignId, r)} className="block">
                      <Card className="hover:border-slate-600 transition-colors">
                        <div className="text-sm font-medium text-white">{r.title}</div>
                        {r.snippet && (
                          <div className="text-xs text-slate-400 mt-0.5">
                            {r.matchedField && r.matchedField !== 'name' && r.matchedField !== 'title' && (
                              <span className="text-muted">{r.matchedField}: </span>
                            )}
                            {r.snippet}
                          </div>
                        )}
                      </Card>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      {!q.trim() && !loading && (
        <p className="text-sm text-muted">
          Type a query above to search across this campaign. Tip: press <kbd>Enter</kbd> to search.
        </p>
      )}

      <button className="text-xs text-muted underline" onClick={() => navigate(`/c/${campaignId}`)}>
        Back to dashboard
      </button>
    </div>
  );
}

/**
 * Campaign-wide search (issue #64). Reads the `?q=` query param, calls
 * GET /campaigns/:id/search, and lists hits grouped by type with deep links to
 * each entity's page. Role visibility is enforced server-side — a player never
 * sees hidden entities or dmSecret text here.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { SearchResponse, SearchResult } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, EmptyState, ErrorNote, Skeleton, TextInput } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { ENTITY_ICON } from '../../lib/uiIcons';
import { searchResultHref } from '../../lib/entityLinks';

const typeLabel: Record<SearchResult['type'], string> = {
  quest: 'Quests',
  npc: 'NPCs',
  faction: 'Factions',
  location: 'Locations',
  character: 'Characters',
  session: 'Sessions',
  encounter: 'Encounters',
  scheduled_session: 'Scheduled sessions',
  note: 'Notes',
  timeline: 'Timeline',
  item: 'Inventory',
  comment: 'Comments',
  arc: 'Story Arcs',
  beat: 'Story Beats',
};

const typeIcon: Record<SearchResult['type'], string> = {
  quest: ENTITY_ICON.quest,
  npc: ENTITY_ICON.npc,
  faction: ENTITY_ICON.faction,
  location: ENTITY_ICON.location,
  character: ENTITY_ICON.character,
  session: ENTITY_ICON.session,
  encounter: ENTITY_ICON.encounter,
  scheduled_session: ENTITY_ICON.scheduled_session,
  note: ENTITY_ICON.note,
  timeline: ENTITY_ICON.timeline,
  item: ENTITY_ICON.item,
  comment: ENTITY_ICON.comment,
  arc: ENTITY_ICON.arc,
  beat: ENTITY_ICON.beat,
};

const typeOrder: SearchResult['type'][] = [
  'quest',
  'npc',
  'faction',
  'location',
  'character',
  'encounter',
  'session',
  'scheduled_session',
  'timeline',
  'arc',
  'beat',
  'item',
  'comment',
  'note',
];

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
  const resultRefs = useRef<Array<HTMLAnchorElement | null>>([]);

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

  const orderedResults = useMemo(
    () => typeOrder.flatMap((type) => grouped.get(type) ?? []),
    [grouped],
  );
  const resultIndex = useMemo(
    () => new Map(orderedResults.map((result, index) => [`${result.type}-${result.id}`, index])),
    [orderedResults],
  );

  function moveResultFocus(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || orderedResults.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? orderedResults.length - 1
        : event.key === 'ArrowDown'
          ? (index + 1) % orderedResults.length
          : (index - 1 + orderedResults.length) % orderedResults.length;
    resultRefs.current[nextIndex]?.focus();
  }

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
          placeholder="Search encounters, scheduled sessions, quests, NPCs, notes…"
          aria-label="Search this campaign"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && orderedResults.length > 0) {
              event.preventDefault();
              resultRefs.current[0]?.focus();
            }
          }}
        />
      </form>

      {loading && <Skeleton lines={5} />}
      {error && <ErrorNote message={error} />}

      {!loading && !error && q.trim() && data && data.results.length === 0 && (
        <EmptyState
          icon="magnifying-glass"
          title={`No results for “${q}”`}
          hint="Try an encounter name, scheduled-session date or time, or another campaign keyword."
        />
      )}

      {!loading && !error && data && data.results.length > 0 && (
        <div className="space-y-5" data-search-results aria-label="Search results" role="region">
          <p className="text-xs text-muted">
            {data.results.length} result{data.results.length === 1 ? '' : 's'} for “{q}”
          </p>
          {typeOrder
            .filter((t) => grouped.has(t))
            .map((t) => (
              <div key={t} className="space-y-2">
                <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                  <span className="inline-flex text-[var(--color-accent)]"><GameIcon slug={typeIcon[t]} size={16} /></span>
                  {typeLabel[t]}
                  <span className="text-muted font-normal">({grouped.get(t)!.length})</span>
                </h2>
                <div className="space-y-2">
                  {grouped.get(t)!.map((r) => (
                    <Link
                      key={`${r.type}-${r.id}`}
                      to={searchResultHref(campaignId, r)}
                      className="block"
                      ref={(element) => {
                        resultRefs.current[resultIndex.get(`${r.type}-${r.id}`)!] = element;
                      }}
                      onKeyDown={(event) => moveResultFocus(event, resultIndex.get(`${r.type}-${r.id}`)!)}
                    >
                      <Card className="cf-card-hover">
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
          Search quests, encounters, scheduled sessions, people, places, recaps, notes, and more. Press <kbd>Enter</kbd> to search.
        </p>
      )}

      <button className="text-xs text-muted underline" onClick={() => navigate(`/c/${campaignId}`)}>
        Back to dashboard
      </button>
    </div>
  );
}

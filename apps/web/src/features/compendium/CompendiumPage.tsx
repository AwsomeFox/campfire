/**
 * Compendium — /c/:campaignId/compendium.
 * Mirrors design/claude-design/Campfire.dc.html "Compendium" (~1276-1337):
 * search bar, type filter chips, result rows -> Reader. The design's "Ask"
 * bar (AI rules lookup) and inline homebrew authoring are out of scope for
 * this pass (no backing endpoint per the BUILD spec) — search + browse only.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import type { RuleEntry, RuleEntryType, RulePack } from '@campfire/schema';
import { Card, ErrorNote, Skeleton } from '../../components/ui';

const TYPE_CHIPS: { key: RuleEntryType | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'spell', label: 'Spells' },
  { key: 'monster', label: 'Monsters' },
  { key: 'item', label: 'Items' },
  { key: 'condition', label: 'Conditions' },
];

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

export default function CompendiumPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [type, setType] = useState<RuleEntryType | 'all'>('all');

  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [results, setResults] = useState<RuleEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [packsLoading, setPacksLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPacksLoading(true);
      try {
        const list = await api.get<RulePack[]>(`${API}/rules/packs`);
        if (!cancelled) setPacks(list);
      } catch {
        if (!cancelled) setPacks([]);
      } finally {
        if (!cancelled) setPacksLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const noPacksInstalled = packs !== null && packs.length === 0;

  useEffect(() => {
    if (noPacksInstalled) {
      setResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
        if (type !== 'all') params.set('type', type);
        const list = await api.get<RuleEntry[]>(`${API}/rules/search?${params.toString()}`);
        if (!cancelled) setResults(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Couldn't search the compendium.");
          setResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, type, noPacksInstalled]);

  const chips = useMemo(() => TYPE_CHIPS, []);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-12 flex flex-col gap-3.5" style={{ maxWidth: 760 }}>
      <div className="flex items-start gap-2.5 flex-wrap">
        <div style={{ flex: 1, minWidth: 200 }}>
          <h3 style={{ margin: '4px 0 0' }}>Compendium</h3>
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
            Everything from your installed rule systems — searchable, and one tap from play.
          </p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Search monsters, spells, items…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {chips.map((chip) => (
          <button
            key={chip.key}
            onClick={() => setType(chip.key)}
            className={chip.key === type ? 'tag tag-accent' : 'tag tag-neutral'}
            style={{ cursor: 'pointer', border: 0, font: 'inherit', fontSize: 11, minHeight: 30 }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {packsLoading ? (
          <Card>
            <Skeleton lines={4} />
          </Card>
        ) : noPacksInstalled ? (
          <div className="card items-center text-center" style={{ padding: 24 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-neutral-200)' }}>
              No rule system installed for this campaign yet.
            </p>
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
              A server admin can install one from Server admin → Rule systems, then pick it in Campaign settings.
            </p>
          </div>
        ) : (
          <>
            {error && <ErrorNote message={error} />}
            {loading && !results ? (
              <Card>
                <Skeleton lines={5} />
              </Card>
            ) : results && results.length === 0 ? (
              <div className="card items-center text-center" style={{ padding: 24 }}>
                <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
                  Nothing matches. Try another word.
                </p>
              </div>
            ) : (
              (results ?? []).map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => navigate(`/c/${id}/compendium/${entry.id}`)}
                  className="card elev-sm text-left"
                  style={{ gap: 8, padding: '12px 16px', display: 'flex', alignItems: 'center', flexDirection: 'row', cursor: 'pointer', border: 0, font: 'inherit', color: 'var(--color-text)' }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
                      {entry.name}
                    </span>
                    <span className="text-muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
                      {entry.summary}
                    </span>
                  </span>
                  <span className="tag tag-neutral" style={{ fontSize: 9.5, flex: 'none' }}>
                    {entry.type}
                  </span>
                  <span className="text-muted" style={{ flex: 'none', fontSize: 12 }}>
                    ›
                  </span>
                </button>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

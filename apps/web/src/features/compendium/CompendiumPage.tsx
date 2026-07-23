/**
 * Compendium — /c/:campaignId/compendium.
 * Mirrors design/claude-design/Campfire.dc.html "Compendium" (~1276-1337):
 * search bar, type filter chips, result rows -> Reader. The design's "Ask"
 * bar (AI rules lookup) and inline homebrew authoring are out of scope for
 * this pass (no backing endpoint per the BUILD spec) — search + browse only.
 *
 * Pagination (issue #613): GET /rules/search returns `{ items, total, hasMore,
 * nextCursor? }`. The page load-mores (append), keeps prior results visible while
 * a filter refetch is in flight (stale), and surfaces error + retry.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import type { RuleEntry, RulePack, RuleSearchPage } from '@campfire/schema';
import { Card, ErrorNote, Skeleton } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';
import { useCampaign, useCampaigns } from '../../app/CampaignContext';
import {
  COMPENDIUM_CLEAR_FILTERS_LABEL,
  COMPENDIUM_LOAD_MORE_LABEL,
  COMPENDIUM_SEARCH_ID,
  COMPENDIUM_SEARCH_LABEL,
  COMPENDIUM_TYPE_FILTER_LABEL,
  COMPENDIUM_URL_CURSOR,
  COMPENDIUM_URL_Q,
  COMPENDIUM_URL_TYPE,
  applyCompendiumSearchParams,
  compendiumResultsStatus,
  effectiveCompendiumSearchQuery,
  parseCompendiumTypeParam,
  type CompendiumUrlType,
} from './compendiumA11y';

const TYPE_CHIPS: { key: CompendiumUrlType; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'spell', label: 'Spells' },
  { key: 'monster', label: 'Monsters' },
  { key: 'item', label: 'Items' },
  { key: 'condition', label: 'Conditions' },
  { key: 'class', label: 'Classes' },
  { key: 'race', label: 'Races' },
  { key: 'feat', label: 'Feats' },
];

const TYPE_CHIP_KEYS = TYPE_CHIPS.map((c) => c.key);

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
  const [searchParams, setSearchParams] = useSearchParams();
  const campaign = useCampaign(Number.isFinite(id) ? id : undefined);
  const { loading: campaignsLoading, error: campaignsError, refresh: refreshCampaigns } = useCampaigns();
  const campaignPack = campaign?.ruleSystem || '';
  // The campaign record comes from the shared campaigns list; if that list failed
  // to load we'd otherwise sit blank forever (the search effect waits for the
  // campaign to resolve). Distinguish "still loading" from "couldn't load".
  const campaignUnresolved = campaign === undefined && (campaignsLoading || campaignsError);

  // URL is authoritative for filters (issue #647): `type` is read directly;
  // `q` is mirrored into local draft state so keystrokes stay responsive while
  // we debounce writes back with replace (no history spam). External URL
  // changes (history / Link / clearFilters) snap the draft + search query
  // immediately — debounce applies only to typing. `cursor` (issue #613) is
  // the start keyset for the first page when deep-linking mid-list.
  const type = parseCompendiumTypeParam(searchParams.get(COMPENDIUM_URL_TYPE));
  const committedQuery = searchParams.get(COMPENDIUM_URL_Q) ?? '';
  const urlCursor = searchParams.get(COMPENDIUM_URL_CURSOR) ?? '';
  const [query, setQuery] = useState(committedQuery);
  const debouncedQuery = useDebounced(query, 300);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCommittedQueryRef = useRef(committedQuery);
  const urlQueryChanged = committedQuery !== prevCommittedQueryRef.current;

  // Snap draft input to URL `q` after external navigation / clearFilters.
  // Keep this in an effect — setState during render can warn or loop.
  useEffect(() => {
    if (!urlQueryChanged) return;
    prevCommittedQueryRef.current = committedQuery;
    setQuery((current) => (current !== committedQuery ? committedQuery : current));
  }, [committedQuery, urlQueryChanged]);

  const searchQuery = effectiveCompendiumSearchQuery({
    draftQuery: query,
    committedQuery,
    debouncedQuery,
    urlQueryChanged,
  });

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    // Normalize both sides so padded URL `q` values don't cause rewrite loops.
    if (trimmed === committedQuery.trim()) return;
    // Skip stale debounce ticks (e.g. Clear filters) so we don't rewrite `q`.
    if (trimmed !== query.trim()) return;
    setSearchParams(
      (prev) => applyCompendiumSearchParams(prev, { q: trimmed, type, cursor: null }),
      { replace: true },
    );
  }, [debouncedQuery, committedQuery, query, type, setSearchParams]);

  function setType(next: CompendiumUrlType) {
    setSearchParams(
      (prev) => applyCompendiumSearchParams(prev, { q: committedQuery, type: next, cursor: null }),
      { replace: true },
    );
  }

  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [results, setResults] = useState<RuleEntry[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [packsLoading, setPacksLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const fetchGeneration = useRef(0);

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

  // The campaign's chosen rule system, not just "some pack is installed server-wide",
  // decides whether the compendium has anything to show for THIS campaign.
  const noRuleSystemChosen = campaign !== undefined && !campaignPack;
  const noPacksInstalled = packs !== null && packs.length === 0;

  useEffect(() => {
    // Wait for the campaign record to resolve from context before searching —
    // otherwise campaignPack is transiently '' and we'd fire an UNSCOPED search
    // that flashes entries from outside this campaign's rule system.
    if (campaign === undefined) return;
    if (noRuleSystemChosen || noPacksInstalled) {
      setResults([]);
      setTotal(0);
      setHasMore(false);
      setNextCursor(undefined);
      return;
    }
    let cancelled = false;
    const gen = ++fetchGeneration.current;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (searchQuery.trim()) params.set('q', searchQuery.trim());
        if (type !== 'all') params.set('type', type);
        if (campaignPack) params.set('pack', campaignPack);
        if (urlCursor) params.set('cursor', urlCursor);
        const page = await api.get<RuleSearchPage>(`${API}/rules/search?${params.toString()}`);
        if (cancelled || gen !== fetchGeneration.current) return;
        setResults(page.items);
        setTotal(page.total);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (cancelled || gen !== fetchGeneration.current) return;
        setError(err instanceof ApiError ? err.message : "Couldn't search the compendium.");
        // Keep prior results visible when a refetch fails (stale + recovery).
        setResults((prev) => prev ?? []);
      } finally {
        if (!cancelled && gen === fetchGeneration.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    searchQuery,
    type,
    noPacksInstalled,
    noRuleSystemChosen,
    campaignPack,
    campaign,
    urlCursor,
    reloadToken,
  ]);

  async function loadMore() {
    if (!nextCursor || loadingMore || loading) return;
    const gen = fetchGeneration.current;
    setLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      if (type !== 'all') params.set('type', type);
      if (campaignPack) params.set('pack', campaignPack);
      params.set('cursor', nextCursor);
      const page = await api.get<RuleSearchPage>(`${API}/rules/search?${params.toString()}`);
      // A filter change started a fresh primary fetch — discard this stale page.
      if (gen !== fetchGeneration.current) return;
      // Append in memory only — writing `cursor` to the URL would re-fire the
      // primary fetch and replace the accumulated list with a single page.
      setResults((prev) => [...(prev ?? []), ...page.items]);
      setTotal(page.total);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (gen !== fetchGeneration.current) return;
      setError(err instanceof ApiError ? err.message : "Couldn't load more results.");
    } finally {
      setLoadingMore(false);
    }
  }

  const chips = useMemo(() => TYPE_CHIPS, []);
  // Empty results have two very different causes: a search that found nothing vs.
  // a type filter (e.g. "Monsters") the installed pack has no entries for. The
  // copy should say which (issue #242).
  const activeTypeLabel = TYPE_CHIPS.find((c) => c.key === type)?.label ?? '';
  const filtersActive = type !== 'all' || query.trim().length > 0 || Boolean(urlCursor);
  const chipRefs = useRef<Partial<Record<CompendiumUrlType, HTMLButtonElement | null>>>({});

  const canAnnounceResults =
    campaign !== undefined &&
    !campaignUnresolved &&
    !packsLoading &&
    !noRuleSystemChosen &&
    !noPacksInstalled;

  const statusMessage = canAnnounceResults
    ? compendiumResultsStatus({
        loading,
        resultCount: results ? results.length : null,
        query: searchQuery,
        typeKey: type,
        typeLabel: activeTypeLabel,
        failed: Boolean(error),
        totalCount: total,
        hasMore,
      })
    : '';

  function clearFilters() {
    // Clear local input immediately; URL params drop both filters (replace).
    setQuery('');
    setSearchParams(
      (prev) => applyCompendiumSearchParams(prev, { q: '', type: 'all', cursor: null }),
      { replace: true },
    );
    // Button unmounts when filtersActive becomes false. Defer past the unmount
    // and React Router's navigation focus reset so search keeps keyboard focus.
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }

  function focusChip(key: CompendiumUrlType) {
    chipRefs.current[key]?.focus();
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, key: CompendiumUrlType) {
    // Roving tabindex for the type-filter radiogroup: arrows move AND select
    // (WAI-ARIA single-select pattern), wrapping at the ends.
    const idx = TYPE_CHIP_KEYS.indexOf(key);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % TYPE_CHIP_KEYS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + TYPE_CHIP_KEYS.length) % TYPE_CHIP_KEYS.length;
    } else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = TYPE_CHIP_KEYS.length - 1;
    if (nextIdx == null) return;
    e.preventDefault();
    const next = TYPE_CHIP_KEYS[nextIdx]!;
    setType(next);
    focusChip(next);
  }

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  const showStale = loading && results !== null && results.length > 0;

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

      <div className="flex flex-col gap-1.5">
        <label htmlFor={COMPENDIUM_SEARCH_ID} style={{ fontSize: 12, fontWeight: 600 }}>
          {COMPENDIUM_SEARCH_LABEL}
        </label>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            ref={searchInputRef}
            id={COMPENDIUM_SEARCH_ID}
            className="input"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="Search monsters, spells, items…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="search"
            autoComplete="off"
          />
          {filtersActive && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12, minHeight: 40 }}
              onClick={clearFilters}
            >
              {COMPENDIUM_CLEAR_FILTERS_LABEL}
            </button>
          )}
        </div>
      </div>

      <div
        className="flex gap-1.5 flex-wrap"
        role="radiogroup"
        aria-label={COMPENDIUM_TYPE_FILTER_LABEL}
      >
        {chips.map((chip) => {
          const checked = chip.key === type;
          return (
            <button
              key={chip.key}
              ref={(el) => {
                chipRefs.current[chip.key] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => setType(chip.key)}
              onKeyDown={(e) => onChipKeyDown(e, chip.key)}
              className={checked ? 'tag tag-accent' : 'tag tag-neutral'}
              style={{ cursor: 'pointer', border: 0, font: 'inherit', fontSize: 11, minHeight: 30 }}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Polite live region for search/filter result counts (issue #647). */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusMessage}
      </div>

      <div className="flex flex-col gap-2">
        {campaignUnresolved ? (
          campaignsError ? (
            <ErrorNote message="Couldn't load this campaign. Check your connection and retry." onRetry={refreshCampaigns} />
          ) : (
            <Card>
              <Skeleton lines={4} />
            </Card>
          )
        ) : packsLoading ? (
          <Card>
            <Skeleton lines={4} />
          </Card>
        ) : noRuleSystemChosen ? (
          <div className="card items-center text-center" style={{ padding: 24 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-neutral-200)' }}>
              No rule system chosen for this campaign.
            </p>
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
              Pick one in Settings, or ask an admin to install a pack.
            </p>
          </div>
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
            {error && (
              <ErrorNote
                message={error}
                onRetry={() => {
                  setError(null);
                  setReloadToken((n) => n + 1);
                }}
              />
            )}
            {showStale && (
              <p className="text-muted" style={{ margin: 0, fontSize: 12 }} aria-live="polite">
                Updating results…
              </p>
            )}
            {loading && !results ? (
              <Card>
                <Skeleton lines={5} />
              </Card>
            ) : !error && results && results.length === 0 && !loading ? (
              <div className="card items-center text-center" style={{ padding: 24 }}>
                {searchQuery.trim() ? (
                  <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
                    Nothing matches “{searchQuery.trim()}”
                    {type !== 'all' ? ` in ${activeTypeLabel}` : ''}. Try another word
                    {type !== 'all' ? ', or switch to All' : ''}.
                  </p>
                ) : type !== 'all' ? (
                  <>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--color-neutral-200)' }}>
                      No {activeTypeLabel.toLowerCase()} in this rule system.
                    </p>
                    <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                      This campaign’s installed pack has no {activeTypeLabel.toLowerCase()} — try another type, or switch to All.
                    </p>
                  </>
                ) : (
                  <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
                    This rule system has no entries yet.
                  </p>
                )}
              </div>
            ) : results && results.length > 0 ? (
              <>
                {total != null && (
                  <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                    {hasMore || total > results.length
                      ? `Showing ${results.length} of ${total}`
                      : `${total} ${total === 1 ? 'result' : 'results'}`}
                  </p>
                )}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    opacity: showStale ? 0.72 : 1,
                    transition: 'opacity 160ms ease',
                  }}
                >
                  {results.map((entry) => (
                    <Link
                      key={entry.id}
                      to={`/c/${id}/compendium/${entry.id}`}
                      className="card elev-sm text-left"
                      style={{ gap: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', flexDirection: 'row', cursor: 'pointer', border: 0, font: 'inherit', color: 'var(--color-text)', textDecoration: 'none' }}
                    >
                      {/* Type/school/monster glyph (issue #305): the DM's override if set,
                          else derived from the entry's type + dataJson. Decorative — the
                          name beside it carries the label. */}
                      <span
                        aria-hidden="true"
                        style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, color: 'var(--color-accent)' }}
                      >
                        <GameIcon slug={ruleEntryIconSlug(entry)} size={22} />
                      </span>
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
                    </Link>
                  ))}
                </div>
                {hasMore && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ alignSelf: 'center', minHeight: 40, fontSize: 13 }}
                    onClick={() => void loadMore()}
                    disabled={loadingMore || loading}
                  >
                    {loadingMore ? 'Loading…' : COMPENDIUM_LOAD_MORE_LABEL}
                  </button>
                )}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

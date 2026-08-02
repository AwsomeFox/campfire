import { useTranslation } from 'react-i18next';
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
import { api, API, translateApiError } from '../../lib/api';
import type { RuleEntry, RulePack, RuleSearchFacet, RuleSearchPage, HomebrewRuleEntryInput, CampaignLibraryMonster } from '@campfire/schema';
import { CampaignLibraryCard } from './CampaignLibraryCard';
import { Card, ErrorNote, Skeleton } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';
import { useCampaign, useCampaigns } from '../../app/CampaignContext';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { PageTitle } from '../../components/PageTitle';
import { TermHelp } from '../../components/TermHelp';
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
import { importExpectedUpdatedAt, serializeHomebrewEditor, shouldRenderCompendiumResults } from './homebrewEditor';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

type TypeChip = { key: CompendiumUrlType; label: string; count?: number };

const FALLBACK_TYPE_LABELS: Record<CompendiumUrlType, string> = {
  all: 'All',
  spell: 'Spells',
  monster: 'Monsters',
  hazard: 'Hazards',
  item: 'Items',
  condition: 'Conditions',
  class: 'Classes',
  race: 'Races',
  feat: 'Feats',
  section: 'Rules',
  other: 'Reference',
};

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

export default function CompendiumPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const campaign = useCampaign(Number.isFinite(id) ? id : undefined);
  const { isDm, canDmWrite } = useCampaignAccess();
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
  const [libraryMonsters, setLibraryMonsters] = useState<CampaignLibraryMonster[]>([]);
  const [results, setResults] = useState<RuleEntry[] | null>(null);
  const [facets, setFacets] = useState<RuleSearchFacet[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [homebrewCount, setHomebrewCount] = useState(0);
  const [authoring, setAuthoring] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [draft, setDraft] = useState({ name: '', slug: '', type: 'spell', summary: '', body: '', rightsStatus: 'private_original', license: '', attribution: '', sourceUrl: '', dataJson: '{}' });
  const [authorError, setAuthorError] = useState<string | null>(null);
  const [structuredData, setStructuredData] = useState<Record<string, string>>({ level: '', school: '', castingTime: '', range: '', duration: '', ac: '', hp: '', cr: '', abilities: '', actions: '', category: '', rarity: '', weight: '', value: '' });
  type ImportPreviewRow = { index: number; slug: string; valid: boolean; conflict: { id: number; updatedAt: string } | null; entry: HomebrewRuleEntryInput };
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[] | null>(null);
  const [importEntries, setImportEntries] = useState<unknown[] | null>(null);
  const [importStrategy, setImportStrategy] = useState<'skip' | 'replace' | 'duplicate'>('skip');
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [packsLoading, setPacksLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const fetchGeneration = useRef(0);
  /** Filtered homebrew rows prepended into results — kept so loadMore can keep Showing X of Y stable. */
  const listedHomebrewCount = useRef(0);

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
        const [page, homebrew, libMonsters] = await Promise.all([
          campaignPack ? api.get<RuleSearchPage>(`${API}/rules/search?${params.toString()}`) : Promise.resolve<RuleSearchPage>({ items: [], total: 0, hasMore: false, limit: 50, facets: [] }),
          api.get<RuleEntry[]>(`${API}/campaigns/${id}/homebrew`).catch(() => []),
          api.get<CampaignLibraryMonster[]>(`${API}/campaigns/${id}/library/monsters`).catch(() => []),
        ]);
        const needle = searchQuery.trim().toLowerCase();
        const campaignEntries = homebrew.filter((entry) =>
          (type === 'all' || entry.type === type) && (!needle || `${entry.name} ${entry.summary} ${entry.body}`.toLowerCase().includes(needle)),
        );
        const filteredLibMonsters = (type === 'all' || type === 'monster')
          ? libMonsters.filter((m) => !needle || m.name.toLowerCase().includes(needle))
          : [];
        setLibraryMonsters(filteredLibMonsters);
        setHomebrewCount(homebrew.length + libMonsters.length);
        if (cancelled || gen !== fetchGeneration.current) return;
        listedHomebrewCount.current = campaignEntries.length + filteredLibMonsters.length;
        setResults([...campaignEntries, ...page.items]);
        setFacets(page.facets ?? []);
        setTotal(page.total + campaignEntries.length + filteredLibMonsters.length);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (cancelled || gen !== fetchGeneration.current) return;
        setError(translateApiError(err, t, { fallbackKey: 'compendium.errors.search' }));
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
    t,
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
      setFacets(page.facets ?? []);
      // page.total is pack-only; keep the homebrew rows that the primary fetch prepended.
      setTotal(page.total + listedHomebrewCount.current);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (gen !== fetchGeneration.current) return;
      setError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadMore' }));
    } finally {
      setLoadingMore(false);
    }
  }

  const chips = useMemo<TypeChip[]>(() => {
    const live = facets.map((facet) => ({
      key: facet.type as CompendiumUrlType,
      label: facet.label || FALLBACK_TYPE_LABELS[facet.type as CompendiumUrlType],
      count: facet.count,
    }));
    const liveHasActiveType = type === 'all' || live.some((chip) => chip.key === type);
    if (!liveHasActiveType) {
      live.push({ key: type, label: FALLBACK_TYPE_LABELS[type], count: 0 });
    }
    const allCount = facets.reduce((sum, facet) => sum + facet.count, 0);
    return [{ key: 'all', label: FALLBACK_TYPE_LABELS.all, count: allCount }, ...live];
  }, [facets, type]);
  // Empty results have two very different causes: a search that found nothing vs.
  // a type filter (e.g. "Monsters") the installed pack has no entries for. The
  // copy should say which (issue #242).
  const activeTypeLabel = chips.find((c) => c.key === type)?.label ?? FALLBACK_TYPE_LABELS[type];
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
    const chipKeys = chips.map((chip) => chip.key);
    const idx = chipKeys.indexOf(key);
    if (idx < 0 || chipKeys.length === 0) return;
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % chipKeys.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + chipKeys.length) % chipKeys.length;
    } else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = chipKeys.length - 1;
    if (nextIdx == null) return;
    e.preventDefault();
    const next = chipKeys[nextIdx]!;
    setType(next);
    focusChip(next);
  }

  async function saveHomebrew() {
    setAuthorError(null);
    const serialized = serializeHomebrewEditor(draft, structuredData, rawMode); if (!serialized.ok) { setAuthorError(serialized.error); return; }
    const payload = serialized.value;
    try {
      const proposed = !isDm;
      await api.post(`${API}/campaigns/${id}/homebrew${proposed ? '?proposed=true' : ''}`, payload);
      setAuthoring(false); setDraft({ name: '', slug: '', type: 'spell', summary: '', body: '', rightsStatus: 'private_original', license: '', attribution: '', sourceUrl: '', dataJson: '{}' });
      setReloadToken((n) => n + 1);
    } catch (err) { setAuthorError(translateApiError(err, t, { fallbackKey: 'compendium.errors.search' })); }
  }

  async function chooseImport(file: File | undefined) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const entries = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown[] }).entries;
      if (!Array.isArray(entries)) throw new Error('Expected a JSON array or { entries: [...] }');
      const preview = await api.post<{ entries: ImportPreviewRow[] }>(`${API}/campaigns/${id}/homebrew/import/preview`, { entries });
      setImportEntries(entries); setImportPreview(preview.entries);
    } catch (err) { setAuthorError(err instanceof Error ? err.message : 'Could not read import file'); }
  }
  async function applyImport() {
    if (!importEntries) return;
    const expectedUpdatedAt = importExpectedUpdatedAt(importPreview ?? []);
    try { await api.post(`${API}/campaigns/${id}/homebrew/import/apply`, { entries: importEntries, strategy: importStrategy, expectedUpdatedAt: importStrategy === 'replace' ? expectedUpdatedAt : undefined }); setImportEntries(null); setImportPreview(null); setReloadToken((n) => n + 1); }
    catch (err) { setAuthorError(translateApiError(err, t, { fallbackKey: 'compendium.errors.search' })); }
  }

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={t('common.noCampaign')} />
      </div>
    );
  }

  const showStale = loading && results !== null && results.length > 0;

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-12 flex flex-col gap-3.5" style={{ maxWidth: 760 }}>
      <div className="flex items-start gap-2.5 flex-wrap">
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="flex items-center gap-2 flex-wrap">
            <PageTitle>{t('compendium.title')}</PageTitle>
            <TermHelp termId="compendium" />
          </div>
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
            Everything from your installed rule systems — searchable, and one tap from play.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-ghost" type="button" onClick={() => setAuthoring((v) => !v)}>{isDm && canDmWrite ? 'Add homebrew' : 'Propose homebrew'}</button>
          {isDm && canDmWrite && <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>Import JSON<input aria-label="Import homebrew JSON" type="file" accept="application/json,.json" hidden onChange={(e) => chooseImport(e.target.files?.[0])} /></label>}
        </div>
        {authoring && (
          <Card>
            <h2 style={{ margin: 0, fontSize: 15 }}>{isDm && canDmWrite ? 'Campaign homebrew' : 'Homebrew proposal'}</h2>
            <div className="flex gap-2 flex-wrap">
              <input className="input" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, slug: draft.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') })} />
              <input className="input" placeholder="stable-slug" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
              <select className="input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}><option value="spell">Spell</option><option value="monster">Monster</option><option value="item">Item</option><option value="other">Other</option></select>
            </div>
            <input className="input" placeholder="Summary" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
            <textarea className="input" placeholder="Markdown details" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            <label><input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} /> Raw JSON data</label>
            {!rawMode && <div className="flex gap-2 flex-wrap" aria-label="Structured homebrew fields">
              {(draft.type === 'spell' ? [['level', 'Level'], ['school', 'School'], ['castingTime', 'Casting time'], ['range', 'Range'], ['duration', 'Duration']] : draft.type === 'monster' ? [['ac', 'AC'], ['hp', 'HP'], ['cr', 'CR'], ['abilities', 'Abilities'], ['actions', 'Actions (JSON array)']] : draft.type === 'item' ? [['category', 'Category'], ['rarity', 'Rarity'], ['weight', 'Weight'], ['value', 'Value']] : []).map(([key, label]) => <input key={key} className="input" aria-label={label} placeholder={label} value={structuredData[key] ?? ''} onChange={(e) => setStructuredData({ ...structuredData, [key]: e.target.value })} />)}
            </div>}
            {rawMode && <textarea className="input" aria-label="Homebrew JSON object" value={draft.dataJson} onChange={(e) => setDraft({ ...draft, dataJson: e.target.value })} />}
            <select className="input" value={draft.rightsStatus} onChange={(e) => setDraft({ ...draft, rightsStatus: e.target.value })}><option value="private_original">Private original — no license required</option><option value="permission_granted">Permission granted</option><option value="open_licensed">Open licensed</option></select>
            {draft.rightsStatus !== 'private_original' && <><input className="input" placeholder="License" value={draft.license} onChange={(e) => setDraft({ ...draft, license: e.target.value })} /><input className="input" placeholder="Attribution" value={draft.attribution} onChange={(e) => setDraft({ ...draft, attribution: e.target.value })} /><input className="input" placeholder="https:// source URL" value={draft.sourceUrl} onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })} /></>}
            {authorError && <ErrorNote message={authorError} />}
            <button className="btn btn-primary" type="button" onClick={saveHomebrew}>{isDm && canDmWrite ? 'Save homebrew' : 'Submit proposal'}</button>
          </Card>
        )}
        {importPreview && <Card><h2 style={{ margin: 0, fontSize: 15 }}>Import preview</h2><div>{importPreview.map((row) => <p key={`${row.index}-${row.slug}`} className="text-muted" style={{ margin: 0 }}>{row.slug}: {row.conflict ? `conflict with #${row.conflict.id} — ${importStrategy}` : 'new entry'}</p>)}</div><select className="input" value={importStrategy} onChange={(e) => setImportStrategy(e.target.value as typeof importStrategy)}><option value="skip">Skip conflicts</option><option value="replace">Replace conflicts</option><option value="duplicate">Duplicate conflicts</option></select><button className="btn btn-primary" type="button" onClick={applyImport}>Apply import</button></Card>}
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
              {typeof chip.count === 'number' && (
                // Leading space keeps the accessible name "Spells (12)", not "Spells(12)".
                <span style={{ marginLeft: 2, color: 'inherit' }}> ({chip.count})</span>
              )}
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
            <ErrorNote message={t('compendium.errors.loadCampaign')} onRetry={refreshCampaigns} />
          ) : (
            <Card>
              <Skeleton lines={4} />
            </Card>
          )
        ) : packsLoading ? (
          <Card>
            <Skeleton lines={4} />
          </Card>
        ) : !shouldRenderCompendiumResults({ campaignResolved: campaign !== undefined, homebrewCount, hasGlobalPack: Boolean(campaignPack && !noPacksInstalled) }) ? (
          <Card density="compact" className="items-center text-center" style={{ padding: 24 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-neutral-200)' }}>No rule system or campaign homebrew yet.</p>
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12 }}>Create homebrew above, or select an installed rule system in Campaign settings.</p>
          </Card>
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
              <Card density="compact" className="items-center text-center" style={{ padding: 24 }}>
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
              </Card>
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
                  {libraryMonsters.map((monster) => (
                    <CampaignLibraryCard
                      key={`lib-${monster.id}`}
                      monster={monster}
                      campaignId={id}
                      isDm={isDm}
                      canDmWrite={canDmWrite}
                      ruleSystem={campaignPack}
                      onUpdated={() => setReloadToken((n) => n + 1)}
                    />
                  ))}
                  {results.map((entry) => (
                    <Card
                      key={entry.id}
                      to={`/c/${id}/compendium/${entry.id}`}
                      draggable={entry.type === 'monster' || entry.type === 'hazard'}
                      onDragStart={(event: React.DragEvent) => {
                        if (entry.type !== 'monster' && entry.type !== 'hazard') return;
                        event.dataTransfer.effectAllowed = 'copy';
                        event.dataTransfer.setData(
                          'application/x-campfire-rule-entry',
                          JSON.stringify({ id: entry.id, name: entry.name, type: entry.type }),
                        );
                      }}
                      title={entry.type === 'monster' || entry.type === 'hazard' ? 'Drag into an open encounter to add' : undefined}
                      density="compact" elev="sm" as={Link} className="text-left"
                      style={{ gap: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', flexDirection: 'row', cursor: 'pointer', border: 0, font: 'inherit', color: 'var(--color-text)', textDecoration: 'none' }}
                    >
                      {/* Type/school/monster glyph (issue #305): the DM's override if set,
                          else derived from the entry's type + dataJson. Decorative — the
                          name beside it carries the label. */}
                      <span
                        aria-hidden="true"
                        style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, color: 'var(--color-accent)' }}
                      >
                        <GameIcon slug={ruleEntryIconSlug(entry)} size={UI_ICON_SIZE.lg} />
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
                    </Card>
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

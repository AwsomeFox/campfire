import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RuleEntry, RulePack, RuleSearchPage, CustomMechanicsProfile } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Card, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { StatBlock, entryRendersMonsterStatblock } from '../../components/StatBlock';
import { EntryFacts, hasEntryFacts } from '../../components/EntryFacts';
import { useTranslation } from 'react-i18next';

export interface RulesLookupPanelProps {
  campaignId: number;
  ruleSystem?: string | null;
  enabledPackSlugs?: string[];
  customMechanicsProfile?: CustomMechanicsProfile | null;
}

/** Filter homebrew entries by search query (name, summary, body). Returns empty array when query is blank. */
export function filterHomebrewEntries(homebrewList: RuleEntry[], query: string): RuleEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return homebrewList.filter((entry) => `${entry.name} ${entry.summary} ${entry.body}`.toLowerCase().includes(needle));
}

/** Merge homebrew entries (with isHomebrew badge flag) and pack search items, deduping by id. */
export function mergeRulesAndHomebrew(
  searchItems: RuleEntry[] = [],
  homebrewList: RuleEntry[] = [],
  query: string = '',
): Array<RuleEntry & { isHomebrew?: boolean }> {
  const filteredHb = filterHomebrewEntries(homebrewList, query);
  const items: Array<RuleEntry & { isHomebrew?: boolean }> = [];
  const seenIds = new Set<number>();

  for (const hb of filteredHb) {
    items.push({ ...hb, isHomebrew: true });
    seenIds.add(hb.id);
  }

  for (const item of searchItems) {
    if (!seenIds.has(item.id)) {
      items.push(item);
      seenIds.add(item.id);
    }
  }

  return items;
}

/** Combine merged search/homebrew results with the actively expanded recent entry if outside search results. */
export function getDisplayedResults(
  mergedResults: Array<RuleEntry & { isHomebrew?: boolean }>,
  recentLookups: RuleEntry[],
  expandedEntryId: number | null,
): Array<RuleEntry & { isHomebrew?: boolean }> {
  const items = [...mergedResults];
  if (expandedEntryId !== null) {
    const expandedEntry = recentLookups.find((r) => r.id === expandedEntryId);
    if (expandedEntry && !items.some((i) => i.id === expandedEntryId)) {
      items.unshift(expandedEntry);
    }
  }
  return items;
}

/** Prepend a newly opened lookup entry, capping at 5 and deduping by id. */
export function updateRecentLookups(prev: RuleEntry[], entry: RuleEntry): RuleEntry[] {
  const next = prev.filter((item) => item.id !== entry.id);
  return [entry, ...next].slice(0, 5);
}

/** Build search query params for /rules/search endpoint. Omits `pack` when ruleSystem is empty. */
export function buildSearchUrlParams(query: string, ruleSystem?: string | null, limit = 8, enabledPackSlugs: string[] = []): URLSearchParams {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed) params.set('q', trimmed);
  const packSlugs = [...new Set([ruleSystem ?? '', ...enabledPackSlugs].filter(Boolean))].sort();
  for (const slug of packSlugs) params.append('pack', slug);
  params.set('limit', String(limit));
  return params;
}

/** Determine whether panel should start collapsed based on stored sessionStorage value. */
export function getInitialCollapsedState(storedValue: string | null): boolean {
  return storedValue !== 'false';
}

/** Resolve pack name by packId when ruleSystem is empty string. */
export function resolvePackName(packId: number | undefined, packMap: Map<number, string>): string | null {
  if (!packId) return null;
  return packMap.get(packId) ?? null;
}

/** Supplemental content uses the campaign adapter; without one, fall back to its declared base or owning base pack. */
export function resolveStatblockSystem(
  ruleSystem: string | null | undefined,
  packId: number | undefined,
  packMap: ReadonlyMap<number, Pick<RulePack, 'slug' | 'extendsPackSlug'>>,
): string | null | undefined {
  if (ruleSystem || !packId) return ruleSystem;
  const pack = packMap.get(packId);
  return pack?.extendsPackSlug || pack?.slug || ruleSystem;
}

export function RulesLookupPanel({ campaignId, ruleSystem, enabledPackSlugs = [], customMechanicsProfile }: RulesLookupPanelProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return getInitialCollapsedState(sessionStorage.getItem('rules_lookup_panel_collapsed'));
    } catch {
      return true;
    }
  });

  const [inputQuery, setInputQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [expandedEntryId, setExpandedEntryId] = useState<number | null>(null);
  const [recentLookups, setRecentLookups] = useState<RuleEntry[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(inputQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [inputQuery]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem('rules_lookup_panel_collapsed', String(next));
      } catch {
        /* ignore sessionStorage availability errors */
      }
      return next;
    });
  }, []);

  const { data: installedPacks = [] } = useQuery<RulePack[]>({
    queryKey: ['rules', 'packs'],
    queryFn: () => api.get<RulePack[]>(`${API}/rules/packs`),
    staleTime: 5 * 60 * 1000,
    enabled: !collapsed,
  });

  const packNameMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of installedPacks) {
      map.set(p.id, p.name);
    }
    return map;
  }, [installedPacks]);

  const packMap = useMemo(() => {
    const map = new Map<number, RulePack>();
    for (const p of installedPacks) {
      map.set(p.id, p);
    }
    return map;
  }, [installedPacks]);

  const effectivePack = ruleSystem || '';
  const effectivePacksKey = JSON.stringify([...new Set([effectivePack, ...enabledPackSlugs].filter(Boolean))].sort());
  const searchParams = buildSearchUrlParams(debouncedQuery, effectivePack, 8, enabledPackSlugs);
  const isQueryActive = Boolean(debouncedQuery.trim());

  const { data: searchPage, isLoading: searchLoading, isError: searchError, error: searchErrorObj } = useQuery<RuleSearchPage>({
    queryKey: ['rules', 'search', debouncedQuery.trim(), effectivePacksKey],
    queryFn: () => api.get<RuleSearchPage>(`${API}/rules/search?${searchParams.toString()}`),
    staleTime: 60 * 1000,
    enabled: !collapsed && isQueryActive,
  });

  const { data: homebrewList = [] } = useQuery<RuleEntry[]>({
    queryKey: ['campaign', campaignId, 'homebrew'],
    queryFn: () => api.get<RuleEntry[]>(`${API}/campaigns/${campaignId}/homebrew`).catch(() => []),
    staleTime: 60 * 1000,
    enabled: !collapsed && Boolean(campaignId),
  });

  const mergedResults = useMemo(() => {
    if (!isQueryActive) return [];
    return mergeRulesAndHomebrew(searchPage?.items ?? [], homebrewList, debouncedQuery);
  }, [homebrewList, searchPage?.items, debouncedQuery, isQueryActive]);

  const displayedResults = useMemo(() => {
    return getDisplayedResults(mergedResults, recentLookups, expandedEntryId);
  }, [mergedResults, recentLookups, expandedEntryId]);

  const toggleExpandEntry = useCallback((entry: RuleEntry) => {
    setExpandedEntryId((prev) => (prev === entry.id ? null : entry.id));
    setRecentLookups((prev) => updateRecentLookups(prev, entry));
  }, []);

  return (
    <Card className="space-y-3 min-w-0" id="rules-lookup-panel">
      <div className="flex items-center justify-between min-w-0">
        <h2 id="rules-lookup-heading" className="card-kicker" style={{ margin: 0 }}>
          {t('encounters.rulesLookup.heading', 'Rules quick lookup')}
        </h2>
        <button
          type="button"
          className="link-button text-xs"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="rules-lookup-content"
          aria-label={collapsed ? t('encounters.rulesLookup.toggleExpand', 'Expand rules quick lookup') : t('encounters.rulesLookup.toggleCollapse', 'Collapse rules quick lookup')}
        >
          {collapsed ? t('encounters.rulesLookup.show', 'Show') : t('encounters.rulesLookup.hide', 'Hide')}
        </button>
      </div>

      {!collapsed && (
        <div id="rules-lookup-content" className="space-y-3 min-w-0">
          <input
            type="search"
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder={t('encounters.rulesLookup.placeholder', 'Search rules & homebrew…')}
            aria-label={t('encounters.rulesLookup.searchLabel', 'Search rules and homebrew')}
            className="input w-full text-xs"
          />

          {recentLookups.length > 0 && (
            <div className="space-y-1">
              <span className="text-muted" style={{ fontSize: 11 }}>
                {t('encounters.rulesLookup.recentLookups', 'Recent lookups')}
              </span>
              <div className="flex flex-wrap gap-1">
                {recentLookups.map((rec) => (
                  <button
                    key={rec.id}
                    type="button"
                    className={`tag ${expandedEntryId === rec.id ? 'tag-primary' : 'tag-neutral'} cursor-pointer text-xs`}
                    onClick={() => toggleExpandEntry(rec)}
                    title={rec.name}
                  >
                    {rec.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!isQueryActive && recentLookups.length === 0 && (
            <p className="text-muted text-xs" style={{ margin: 0 }}>
              {t('encounters.rulesLookup.typeToSearch', 'Start typing to search rules & homebrew…')}
            </p>
          )}

          {searchLoading && (
            <p className="text-muted text-xs" style={{ margin: 0 }}>
              {t('encounters.rulesLookup.loading', 'Searching…')}
            </p>
          )}

          {searchError && (
            <ErrorNote message={translateApiError(searchErrorObj, t, { fallbackKey: 'encounters.rulesLookup.searchError' })} />
          )}

          {!searchLoading && !searchError && isQueryActive && mergedResults.length === 0 && (
            <p className="text-muted text-xs" style={{ margin: 0 }}>
              {t('encounters.rulesLookup.noResults', 'No matching rules found.')}
            </p>
          )}

          {displayedResults.length > 0 && (
            <ul className="space-y-1.5 min-w-0" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {displayedResults.map((entry) => {
                const isExpanded = expandedEntryId === entry.id;
                const packName = !entry.isHomebrew && entry.packId ? resolvePackName(entry.packId, packNameMap) : null;
                const statblockSystem = entry.isHomebrew
                  ? ruleSystem
                  : resolveStatblockSystem(ruleSystem, entry.packId, packMap);
                return (
                  <li key={entry.id} className="border border-subtle rounded p-2 text-xs space-y-2 min-w-0">
                    <div
                      className="flex items-center justify-between gap-2 cursor-pointer min-w-0"
                      onClick={() => toggleExpandEntry(entry)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleExpandEntry(entry);
                        }
                      }}
                      aria-expanded={isExpanded}
                    >
                      <span className="font-medium truncate min-w-0 flex-1">{entry.name}</span>
                      <div className="flex items-center gap-1 flex-none">
                        {entry.isHomebrew ? (
                          <span className="tag tag-accent text-3xs">{t('encounters.rulesLookup.homebrewBadge', 'Homebrew')}</span>
                        ) : (
                          <>
                            <span className="tag tag-neutral text-3xs">{entry.type}</span>
                            {packName && <span className="tag tag-secondary text-3xs">{packName}</span>}
                          </>
                        )}
                        <span className="text-muted" style={{ fontSize: 10 }}>{isExpanded ? '▲' : '▼'}</span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="pt-2 border-t border-subtle reading-supporting overflow-x-auto text-xs space-y-2">
                        {/* Non-creature entries keep their mechanics in `dataJson`; the
                            statblock branch below is creature-only, so a looked-up item or
                            spell would otherwise show prose with no stats at all. */}
                        {!entryRendersMonsterStatblock(entry.type, entry.dataJson, statblockSystem, customMechanicsProfile) && hasEntryFacts(entry.dataJson) && (
                          <EntryFacts data={entry.dataJson} compact />
                        )}
                        {entry.body && entry.body.trim() ? (
                          <Markdown>{entry.body.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t')}</Markdown>
                        ) : entryRendersMonsterStatblock(entry.type, entry.dataJson, statblockSystem, customMechanicsProfile) ? (
                          <StatBlock data={entry.dataJson} ruleSystem={statblockSystem} customMechanicsProfile={customMechanicsProfile} headingLevel={3} />
                        ) : hasEntryFacts(entry.dataJson) ? null : entry.summary ? (
                          <p className="text-muted" style={{ margin: 0 }}>{entry.summary}</p>
                        ) : (
                          <p className="text-muted" style={{ margin: 0 }}>
                            {t('encounters.rulesLookup.noDetails', 'No details available for this entry.')}
                          </p>
                        )}

                        {(entry.source || entry.author || entry.license || entry.attribution || packName) && (
                          <div className="text-muted border-t border-subtle pt-1.5" style={{ fontSize: 10 }}>
                            {entry.source || packName || ''}
                            {entry.author ? ` · by ${entry.author}` : ''}
                            {entry.license ? ` · ${entry.license}` : ''}
                            {entry.attribution ? `. ${entry.attribution}` : ''}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

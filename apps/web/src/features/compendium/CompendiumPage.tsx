/**
 * Compendium — /c/:campaignId/compendium.
 * Mirrors design/claude-design/Campfire.dc.html "Compendium" (~1276-1337):
 * search bar, type filter chips, result rows -> Reader. The design's "Ask"
 * bar (AI rules lookup) and inline homebrew authoring are out of scope for
 * this pass (no backing endpoint per the BUILD spec) — search + browse only.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import type { RuleEntry, RuleEntryType, RulePack } from '@campfire/schema';
import { Card, ErrorNote, Skeleton } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';
import { useCampaign, useCampaigns } from '../../app/CampaignContext';
import {
  COMPENDIUM_CLEAR_FILTERS_LABEL,
  COMPENDIUM_SEARCH_ID,
  COMPENDIUM_SEARCH_LABEL,
  COMPENDIUM_TYPE_FILTER_LABEL,
  compendiumResultsStatus,
} from './compendiumA11y';

const TYPE_CHIPS: { key: RuleEntryType | 'all'; label: string }[] = [
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
  const campaign = useCampaign(Number.isFinite(id) ? id : undefined);
  const { loading: campaignsLoading, error: campaignsError, refresh: refreshCampaigns } = useCampaigns();
  const campaignPack = campaign?.ruleSystem || '';
  // The campaign record comes from the shared campaigns list; if that list failed
  // to load we'd otherwise sit blank forever (the search effect waits for the
  // campaign to resolve). Distinguish "still loading" from "couldn't load".
  const campaignUnresolved = campaign === undefined && (campaignsLoading || campaignsError);

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
        if (campaignPack) params.set('pack', campaignPack);
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
  }, [debouncedQuery, type, noPacksInstalled, noRuleSystemChosen, campaignPack, campaign]);

  const chips = useMemo(() => TYPE_CHIPS, []);
  // Empty results have two very different causes: a search that found nothing vs.
  // a type filter (e.g. "Monsters") the installed pack has no entries for. The
  // copy should say which (issue #242).
  const activeTypeLabel = TYPE_CHIPS.find((c) => c.key === type)?.label ?? '';
  const filtersActive = type !== 'all' || query.trim().length > 0;
  const chipRefs = useRef<Partial<Record<RuleEntryType | 'all', HTMLButtonElement | null>>>({});

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
        query: debouncedQuery,
        typeKey: type,
        typeLabel: activeTypeLabel,
      })
    : '';

  function clearFilters() {
    setQuery('');
    setType('all');
  }

  function focusChip(key: RuleEntryType | 'all') {
    chipRefs.current[key]?.focus();
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, key: RuleEntryType | 'all') {
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
            {error && <ErrorNote message={error} />}
            {loading && !results ? (
              <Card>
                <Skeleton lines={5} />
              </Card>
            ) : results && results.length === 0 ? (
              <div className="card items-center text-center" style={{ padding: 24 }}>
                {debouncedQuery.trim() ? (
                  <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
                    Nothing matches “{debouncedQuery.trim()}”
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
            ) : (
              (results ?? []).map((entry) => (
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
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

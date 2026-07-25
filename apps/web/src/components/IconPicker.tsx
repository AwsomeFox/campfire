/**
 * IconPicker (issue #302; full-set search issue #349; partial-library disclosure
 * issue #847; picker UX issue #648) — a searchable modal for choosing a bundled
 * game-icons.net entity icon. Built on the app's `.dialog` primitives + the
 * shared useDialog hook (Escape/focus-trap/focus-restore), mirroring
 * ConfirmDialog. Reusable by any entity that stores an icon slug (NPCs,
 * compendium/#305, inventory/#307).
 *
 * The curated ~180-icon set searches synchronously and renders instantly, no
 * different from before. On open, the picker also kicks off a dynamic import
 * of the full ~4,130-icon metadata index (no svg bodies — see
 * lib/icons/index.ts#loadFullIconIndex); once that lands, search results are
 * the curated matches followed by full-set matches (deduped), so typing a
 * query broadens the result set as the index becomes available. Each
 * rendered result tile resolves (and caches) its own svg body lazily via
 * <GameIcon>, fetching only the shard(s) actually needed for what's on
 * screen.
 *
 * If the index fails to load — e.g. offline and uncached — the picker keeps
 * offering the curated set, but discloses curated-only mode with a visible
 * Retry that preserves the current search query (issue #847). Surface states
 * (loading / partial / empty / complete) live in iconPickerState.ts.
 *
 * Issue #648: named category radiogroup, decorative child SVGs (no duplicate
 * accessible names), pinned current selection with Replace/Auto/Clear, polite
 * result counts, recent/context suggestions, and stable focus when filters change.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Btn, ErrorNote, TextInput } from './ui';
import { useDialog } from './useDialog';
import { GameIcon } from './GameIcon';
import {
  searchIcons,
  searchFullIconIndex,
  loadFullIconIndex,
  ICON_CATEGORIES,
  TOTAL_ICON_COUNT,
  ICON_SOURCE_NAME,
  ICON_LICENSE,
  getCachedIcon,
  type FullIconIndexEntry,
} from '../lib/icons';
import {
  FULL_LIBRARY_FAILED_MESSAGE,
  FULL_LIBRARY_LOADING_MESSAGE,
  iconPickerGridEmptyMessage,
  iconPickerSurfaceState,
  showFullLibraryLoadingBanner,
  showPartialLibraryBanner,
} from './iconPickerState';
import {
  ICON_PICKER_AUTO_LABEL,
  ICON_PICKER_CATEGORY_FILTER_LABEL,
  ICON_PICKER_CLEAR_LABEL,
  ICON_PICKER_CURRENT_LABEL,
  ICON_PICKER_RECENT_LABEL,
  ICON_PICKER_REPLACE_LABEL,
  ICON_PICKER_RESULT_LIMIT,
  ICON_PICKER_SUGGESTED_LABEL,
  iconPickerCategoryChipLabel,
  iconPickerCategoryKeys,
  iconPickerCategoryValue,
  iconPickerGridResults,
  iconPickerNextCategoryKey,
  iconPickerPinnedIsAuto,
  iconPickerPinnedSlug,
  iconPickerResultsStatus,
  iconPickerSuggestionSlugs,
  iconPickerTotalMatchCount,
  readRecentIconPickerSlugs,
  recordRecentIconPickerSlug,
  shouldShowIconPickerAutoAction,
  shouldShowIconPickerClearAction,
  shouldShowIconPickerNoneTile,
} from './iconPickerA11y';

function iconDisplayName(slug: string): string {
  return getCachedIcon(slug)?.name ?? slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function IconPicker({
  value = '',
  onSelect,
  onClose,
  /** Inventory-style auto icon from item name; shown pinned when `value` is ''. */
  autoSlug,
  /** Extra slugs to surface when the search field is empty (contextual hints). */
  suggestionSlugs,
}: {
  /** Currently-selected slug, or '' when none / auto. */
  value?: string;
  /** Called with the chosen slug ('' to clear / revert to auto). */
  onSelect: (slug: string) => void;
  onClose: () => void;
  autoSlug?: string;
  suggestionSlugs?: readonly string[];
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const titleId = useRef(`icon-picker-title-${Math.random().toString(36).slice(2)}`).current;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialog<HTMLDivElement>({ onClose });
  const chipRefs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});

  const categoryKeys = useMemo(() => iconPickerCategoryKeys(ICON_CATEGORIES), []);
  const activeCategoryKey = category ? category : 'all';

  // Full-set index: undefined while loading, null on failure, the array once loaded.
  // `loadAttempt` re-runs the effect on Retry without clearing the search query.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [fullIndex, setFullIndex] = useState<readonly FullIconIndexEntry[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setFullIndex(undefined);
    loadFullIconIndex().then(
      (entries) => live && setFullIndex(entries),
      () => live && setFullIndex(null),
    );
    return () => {
      live = false;
    };
  }, [loadAttempt]);

  const curatedResults = useMemo(() => searchIcons(query, category), [query, category]);
  const curatedSlugs = useMemo(() => new Set(curatedResults.map((e) => e.slug)), [curatedResults]);
  const fullResults = useMemo(() => {
    if (!fullIndex) return [];
    const remaining = Math.max(0, ICON_PICKER_RESULT_LIMIT - curatedResults.length);
    if (remaining === 0) return [];
    return searchFullIconIndex(fullIndex, query, category, remaining + curatedSlugs.size).filter(
      (e) => !curatedSlugs.has(e.slug),
    ).slice(0, remaining);
  }, [fullIndex, query, category, curatedResults, curatedSlugs]);

  const results: Array<{ slug: string; name: string; artist: string }> = useMemo(
    () => [...curatedResults, ...fullResults],
    [curatedResults, fullResults],
  );

  const totalMatchCount = useMemo(
    () =>
      iconPickerTotalMatchCount({
        curatedCount: curatedResults.length,
        curatedSlugs,
        fullIndex,
        query,
        category,
      }),
    [curatedResults.length, curatedSlugs, fullIndex, query, category],
  );

  const truncated = totalMatchCount != null && totalMatchCount > results.length;
  const pinnedSlug = iconPickerPinnedSlug(value, autoSlug);
  const pinnedIsAuto = iconPickerPinnedIsAuto(value, autoSlug);
  const gridResults = useMemo(() => iconPickerGridResults(results, pinnedSlug), [results, pinnedSlug]);

  const recentSlugs = useMemo(() => readRecentIconPickerSlugs(), []);
  const contextualSlugs = useMemo(() => {
    if (query.trim()) return [];
    const merged = iconPickerSuggestionSlugs(recentSlugs, suggestionSlugs);
    return pinnedSlug ? merged.filter((s) => s !== pinnedSlug) : merged;
  }, [query, recentSlugs, suggestionSlugs, pinnedSlug]);

  const surface = iconPickerSurfaceState(fullIndex, results.length);
  const gridEmptyMessage =
    results.length === 0 ? iconPickerGridEmptyMessage(surface, query) : null;
  const resultsStatus = iconPickerResultsStatus({
    surface,
    shownCount: results.length,
    totalMatchCount,
    truncated,
    query,
    categoryKey: activeCategoryKey,
  });
  const retryFullLibrary = () => setLoadAttempt((n) => n + 1);

  function selectSlug(slug: string) {
    if (slug) recordRecentIconPickerSlug(slug);
    onSelect(slug);
  }

  function focusSearch() {
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  function focusChip(key: string) {
    chipRefs.current[key]?.focus();
  }

  function onCategoryKeyDown(e: KeyboardEvent<HTMLButtonElement>, key: string) {
    let direction: 'next' | 'prev' | 'home' | 'end' | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') direction = 'next';
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') direction = 'prev';
    else if (e.key === 'Home') direction = 'home';
    else if (e.key === 'End') direction = 'end';
    if (!direction) return;
    e.preventDefault();
    const nextKey = iconPickerNextCategoryKey(categoryKeys, key, direction);
    setCategory(iconPickerCategoryValue(nextKey));
    focusChip(nextKey);
  }

  // When filters shrink the grid, restore focus to search if the active tile vanished.
  useEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active.dataset.iconPickerTile !== 'true') return;
    const slug = active.dataset.iconSlug;
    if (!slug) return;
    const stillVisible =
      gridResults.some((r) => r.slug === slug) ||
      slug === pinnedSlug ||
      contextualSlugs.includes(slug);
    if (!stillVisible) focusSearch();
  }, [gridResults, pinnedSlug, contextualSlugs]);

  function renderIconTile(
    icon: { slug: string; name: string; artist?: string },
    opts?: { selected?: boolean; compact?: boolean },
  ) {
    const selected = opts?.selected ?? value === icon.slug;
    const label = icon.name || iconDisplayName(icon.slug);
    return (
      <button
        key={icon.slug}
        type="button"
        data-icon-picker-tile="true"
        data-icon-slug={icon.slug}
        onClick={() => selectSlug(icon.slug)}
        title={`${label}${icon.artist ? ` — by ${icon.artist} (game-icons.net)` : ''}`}
        aria-pressed={selected}
        aria-label={label}
        className={`cf-inset flex items-center justify-center !p-2 aspect-square hover:border-[var(--color-accent-700)] hover:text-white ${
          opts?.compact ? '!p-1.5' : ''
        } ${
          selected
            ? '!border-[var(--color-accent)] text-[var(--color-accent)]'
            : 'text-[var(--color-neutral-300)]'
        }`}
      >
        <GameIcon slug={icon.slug} size={opts?.compact ? 26 : 30} />
      </button>
    );
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, width: '100%' }}
      >
        <p className="dialog-title" id={titleId}>
          Choose an icon
        </p>
        <div className="dialog-body space-y-3">
          <TextInput
            ref={searchInputRef}
            autoFocus
            placeholder={`Search ${TOTAL_ICON_COUNT} icons — sword, potion, dragon…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search icons"
          />

          <div
            className="flex flex-wrap gap-1.5"
            role="radiogroup"
            aria-label={ICON_PICKER_CATEGORY_FILTER_LABEL}
          >
            {categoryKeys.map((key) => {
              const checked = key === activeCategoryKey;
              return (
                <button
                  key={key}
                  ref={(el) => {
                    chipRefs.current[key] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  className={`cf-chip ${checked ? 'cf-chip-active' : 'cf-chip-available'}`}
                  onClick={() => setCategory(iconPickerCategoryValue(key))}
                  onKeyDown={(e) => onCategoryKeyDown(e, key)}
                >
                  {iconPickerCategoryChipLabel(key)}
                </button>
              );
            })}
          </div>

          {showFullLibraryLoadingBanner(fullIndex) && (
            <p role="status" aria-live="polite" className="text-xs text-[var(--color-neutral-500)] m-0">
              {FULL_LIBRARY_LOADING_MESSAGE}
            </p>
          )}
          {showPartialLibraryBanner(fullIndex) && (
            <ErrorNote message={FULL_LIBRARY_FAILED_MESSAGE} onRetry={retryFullLibrary} />
          )}

          {resultsStatus && (
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {resultsStatus}
            </div>
          )}

          {pinnedSlug && (
            <div
              className="cf-inset flex flex-wrap items-center gap-3 !p-3"
              aria-label={ICON_PICKER_CURRENT_LABEL}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="shrink-0 text-[var(--color-accent)]" aria-hidden="true">
                  <GameIcon slug={pinnedSlug} size={36} />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--color-neutral-500)] m-0 font-bold">
                    {ICON_PICKER_CURRENT_LABEL}
                  </p>
                  <p className="text-sm text-white m-0 truncate">
                    {pinnedIsAuto ? `Auto — ${iconDisplayName(pinnedSlug)}` : iconDisplayName(pinnedSlug)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 ml-auto">
                <Btn ghost className="!min-h-0 !py-1 !px-2 text-xs" type="button" onClick={focusSearch}>
                  {ICON_PICKER_REPLACE_LABEL}
                </Btn>
                {shouldShowIconPickerAutoAction(value, autoSlug) && (
                  <Btn ghost className="!min-h-0 !py-1 !px-2 text-xs" type="button" onClick={() => selectSlug('')}>
                    {ICON_PICKER_AUTO_LABEL}
                  </Btn>
                )}
                {shouldShowIconPickerClearAction(value, autoSlug) && (
                  <Btn ghost className="!min-h-0 !py-1 !px-2 text-xs" type="button" onClick={() => selectSlug('')}>
                    {ICON_PICKER_CLEAR_LABEL}
                  </Btn>
                )}
              </div>
            </div>
          )}

          {contextualSlugs.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wide text-[var(--color-neutral-500)] m-0 font-bold">
                {suggestionSlugs?.length ? ICON_PICKER_SUGGESTED_LABEL : ICON_PICKER_RECENT_LABEL}
              </p>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(48px, 1fr))' }}
              >
                {contextualSlugs.map((slug) =>
                  renderIconTile(
                    {
                      slug,
                      name: iconDisplayName(slug),
                      artist: getCachedIcon(slug)?.artist ?? '',
                    },
                    { selected: value === slug, compact: true },
                  ),
                )}
              </div>
            </div>
          )}

          <div
            className="grid gap-1.5 overflow-y-auto"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))', maxHeight: 320 }}
            data-icon-picker-surface={surface}
          >
            {/* Clear affordance — sets the slug back to '' (no icon). Hidden in auto mode. */}
            {shouldShowIconPickerNoneTile(autoSlug) && (
              <button
                type="button"
                data-icon-picker-tile="true"
                data-icon-slug=""
                onClick={() => selectSlug('')}
                title="No icon"
                aria-pressed={!value.trim()}
                aria-label="No icon"
                className={`cf-inset flex flex-col items-center justify-center gap-1 !p-2 aspect-square hover:border-[var(--color-accent-700)] ${
                  !value.trim() ? '!border-[var(--color-accent)] text-[var(--color-accent)]' : 'text-[var(--color-neutral-500)]'
                }`}
              >
                <span className="text-lg leading-none" aria-hidden="true">
                  ⊘
                </span>
                <span className="text-[9px] leading-tight">None</span>
              </button>
            )}

            {gridResults.map((icon) => renderIconTile(icon))}

            {gridEmptyMessage && (
              <p className="text-sm text-[var(--color-neutral-500)] col-span-full py-6 text-center">
                {gridEmptyMessage}
              </p>
            )}
          </div>

          <p className="text-[11px] text-[var(--color-neutral-600)] leading-snug">
            Icons from {ICON_SOURCE_NAME}, {ICON_LICENSE}. See{' '}
            <a href="/credits" className="hover:underline" style={{ color: 'var(--color-accent)' }}>
              Credits
            </a>{' '}
            for artist attribution.
          </p>
        </div>
        <div className="dialog-actions">
          <Btn ghost onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
    </div>
  );
}

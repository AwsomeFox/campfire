/**
 * IconPicker (issue #302; full-set search issue #349; partial-library disclosure
 * issue #847) — a searchable modal for choosing a bundled game-icons.net entity
 * icon. Built on the app's `.dialog` primitives + the shared useDialog hook
 * (Escape/focus-trap/focus-restore), mirroring ConfirmDialog. Reusable by any
 * entity that stores an icon slug (NPCs, compendium/#305, inventory/#307).
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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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

/** Total tiles shown at once (curated + full-set), so a broad query can't mount thousands. */
const RESULT_LIMIT = 240;

function categoryLabel(cat: string): string {
  return cat
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function IconPicker({
  value,
  onSelect,
  onClose,
}: {
  /** Currently-selected slug, or '' when none. */
  value?: string;
  /** Called with the chosen slug ('' to clear). */
  onSelect: (slug: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const titleId = useRef(`icon-picker-title-${Math.random().toString(36).slice(2)}`).current;
  const dialogRef = useDialog<HTMLDivElement>({ onClose });

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
  const fullResults = useMemo(() => {
    if (!fullIndex) return [];
    const curatedSlugs = new Set(curatedResults.map((e) => e.slug));
    const remaining = Math.max(0, RESULT_LIMIT - curatedResults.length);
    if (remaining === 0) return [];
    return searchFullIconIndex(fullIndex, query, category, remaining + curatedSlugs.size).filter(
      (e) => !curatedSlugs.has(e.slug),
    ).slice(0, remaining);
  }, [fullIndex, query, category, curatedResults]);

  // curatedResults already carry svg bodies (instant); fullResults are metadata
  // only — GameIcon resolves each tile's body lazily/on-demand once mounted.
  const results: Array<{ slug: string; name: string; artist: string }> = useMemo(
    () => [...curatedResults, ...fullResults],
    [curatedResults, fullResults],
  );

  const surface = iconPickerSurfaceState(fullIndex, results.length);
  const gridEmptyMessage =
    results.length === 0 ? iconPickerGridEmptyMessage(surface, query) : null;
  const retryFullLibrary = () => setLoadAttempt((n) => n + 1);

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
            autoFocus
            placeholder={`Search ${TOTAL_ICON_COUNT} icons — sword, potion, dragon…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search icons"
          />

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={`cf-chip ${category === '' ? 'cf-chip-active' : 'cf-chip-available'}`}
              onClick={() => setCategory('')}
            >
              All
            </button>
            {ICON_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`cf-chip ${category === c ? 'cf-chip-active' : 'cf-chip-available'}`}
                onClick={() => setCategory((prev) => (prev === c ? '' : c))}
              >
                {categoryLabel(c)}
              </button>
            ))}
          </div>

          {showFullLibraryLoadingBanner(fullIndex) && (
            <p role="status" aria-live="polite" className="text-xs text-[var(--color-neutral-500)] m-0">
              {FULL_LIBRARY_LOADING_MESSAGE}
            </p>
          )}
          {showPartialLibraryBanner(fullIndex) && (
            <ErrorNote message={FULL_LIBRARY_FAILED_MESSAGE} onRetry={retryFullLibrary} />
          )}

          <div
            className="grid gap-1.5 overflow-y-auto"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))', maxHeight: 320 }}
            data-icon-picker-surface={surface}
          >
            {/* Clear affordance — sets the slug back to '' (no icon). */}
            <button
              type="button"
              onClick={() => onSelect('')}
              title="No icon"
              aria-pressed={!value}
              className={`cf-inset flex flex-col items-center justify-center gap-1 !p-2 aspect-square hover:border-[var(--color-accent-700)] ${
                !value ? '!border-[var(--color-accent)] text-[var(--color-accent)]' : 'text-[var(--color-neutral-500)]'
              }`}
            >
              <span className="text-lg leading-none">⊘</span>
              <span className="text-[9px] leading-tight">None</span>
            </button>

            {results.map((icon) => (
              <button
                key={icon.slug}
                type="button"
                onClick={() => onSelect(icon.slug)}
                title={`${icon.name} — by ${icon.artist} (game-icons.net)`}
                aria-pressed={value === icon.slug}
                aria-label={icon.name}
                className={`cf-inset flex items-center justify-center !p-2 aspect-square hover:border-[var(--color-accent-700)] hover:text-white ${
                  value === icon.slug
                    ? '!border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'text-[var(--color-neutral-300)]'
                }`}
              >
                <GameIcon slug={icon.slug} size={30} title={icon.name} />
              </button>
            ))}

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

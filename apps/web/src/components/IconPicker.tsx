/**
 * IconPicker (issue #302; full-set search issue #349) — a searchable modal
 * for choosing a bundled game-icons.net entity icon. Built on the app's
 * `.dialog` primitives + the shared useDialog hook (Escape/focus-trap/
 * focus-restore), mirroring ConfirmDialog. Reusable by any entity that
 * stores an icon slug (NPCs, compendium/#305, inventory/#307).
 *
 * The curated ~180-icon set searches synchronously and renders instantly, no
 * different from before. On open, the picker also kicks off a dynamic import
 * of the full ~4,130-icon metadata index (no svg bodies — see
 * lib/icons/index.ts#loadFullIconIndex); once that lands, search results are
 * the curated matches followed by full-set matches (deduped), so typing a
 * query broadens the result set as the index becomes available. Each
 * rendered result tile resolves (and caches) its own svg body lazily via
 * <GameIcon>, fetching only the shard(s) actually needed for what's on
 * screen. If the index (or a shard) fails to load — e.g. offline and
 * uncached — the picker just keeps working over the curated set.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Btn, TextInput } from './ui';
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
  const [fullIndex, setFullIndex] = useState<readonly FullIconIndexEntry[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadFullIconIndex().then(
      (entries) => live && setFullIndex(entries),
      () => live && setFullIndex(null),
    );
    return () => {
      live = false;
    };
  }, []);

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

          <div
            className="grid gap-1.5 overflow-y-auto"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))', maxHeight: 320 }}
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

            {results.length === 0 && fullIndex === undefined && (
              <p className="text-sm text-[var(--color-neutral-500)] col-span-full py-6 text-center">
                Searching the full icon library…
              </p>
            )}
            {results.length === 0 && fullIndex !== undefined && (
              <p className="text-sm text-[var(--color-neutral-500)] col-span-full py-6 text-center">
                No icons match “{query}”.
              </p>
            )}
          </div>

          <p className="text-[11px] text-[var(--color-neutral-600)] leading-snug">
            Icons from {ICON_SOURCE_NAME}, {ICON_LICENSE}. See{' '}
            <a href="/credits" className="hover:underline" style={{ color: 'var(--color-accent)' }}>
              Credits
            </a>{' '}
            for artist attribution.
            {fullIndex === null && ' Couldn’t load the full icon library — showing the curated set only.'}
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

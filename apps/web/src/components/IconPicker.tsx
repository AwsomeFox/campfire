/**
 * IconPicker (issue #302) — a searchable modal for choosing a bundled
 * game-icons.net entity icon. Built on the app's `.dialog` primitives + the
 * shared useDialog hook (Escape/focus-trap/focus-restore), mirroring
 * ConfirmDialog. Reusable by any entity that stores an icon slug (NPCs today;
 * compendium/#305 and inventory/#307 next).
 *
 * Selecting an icon calls onSelect(slug) and closes; "No icon" clears it (''),
 * so the same control both sets and removes an icon. The catalog is small and
 * fully client-side, so search filters synchronously on each keystroke.
 */
import { useMemo, useRef, useState } from 'react';
import { Btn, TextInput } from './ui';
import { useDialog } from './useDialog';
import { GameIcon } from './GameIcon';
import { searchIcons, ICON_CATEGORIES, ICON_COUNT, ICON_SOURCE_NAME, ICON_LICENSE } from '../lib/icons';

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

  const results = useMemo(() => searchIcons(query, category), [query, category]);

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
            placeholder={`Search ${ICON_COUNT} icons — sword, potion, dragon…`}
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

            {results.length === 0 && (
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

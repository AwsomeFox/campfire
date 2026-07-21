/**
 * Credits / attributions (issue #302; full-set counts issue #349).
 *
 * Surfaces the CC-BY attribution for the game-icons.net entity-icon library.
 * CC BY 3.0 requires crediting each icon's author ("Icons made by {author}"), so
 * this page lists every contributor whose work is reachable — not just the ~180
 * bundled inline for instant rendering, but the full ~4,130-icon set the picker
 * can search and any entity can use (issue #349) — with a link to the source and
 * the license. This is the canonical home for open-content attributions; future
 * open-licensed asset imports can add sections here alongside the existing
 * per-pack license text shown in the compendium.
 *
 * Per-artist counts come from `ICON_ARTIST_TOTAL_COUNTS`, a small generated
 * table covering the full set — NOT from importing the full icon index itself,
 * which stays a lazy chunk this page never has to load.
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import {
  ICON_ARTISTS,
  ICON_ARTIST_TOTAL_COUNTS,
  ICON_COUNT,
  TOTAL_ICON_COUNT,
  ICON_LICENSE,
  ICON_SOURCE_NAME,
  ICON_SOURCE_URL,
} from '../../lib/icons';

// A few representative slugs to show the set at a glance (fall back silently if
// any are ever renamed — GameIcon renders nothing for an unknown slug).
const SAMPLE_SLUGS = [
  'broadsword', 'round-potion', 'scroll-unfurled', 'crystal-wand', 'ring',
  'coins', 'fire', 'dragon-head', 'wizard-face', 'castle', 'crown', 'd4',
];

export default function CreditsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div>
        <Link to="/" className="text-xs text-[var(--color-neutral-500)] hover:underline">
          ← Home
        </Link>
        <h1 className="text-2xl font-extrabold text-white leading-tight mt-2">Credits &amp; attributions</h1>
        <p className="text-sm text-[var(--color-neutral-400)] mt-1">
          Open-licensed content bundled with Campfire, and the artists to thank for it.
        </p>
      </div>

      <Card className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-bold text-white text-base m-0">Entity icons</h2>
          <span className="cf-chip cf-chip-available">{TOTAL_ICON_COUNT} icons</span>
          <span className="cf-chip cf-chip-available">{ICON_LICENSE}</span>
        </div>

        <div className="flex flex-wrap gap-2 text-[var(--color-neutral-300)]">
          {SAMPLE_SLUGS.map((slug) => (
            <span key={slug} className="cf-inset !p-2 inline-flex">
              <GameIcon slug={slug} size={26} />
            </span>
          ))}
        </div>

        <p className="text-sm text-[var(--color-neutral-400)] leading-relaxed">
          Campfire makes the full {TOTAL_ICON_COUNT}-icon library from{' '}
          <a href={ICON_SOURCE_URL} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--color-accent)' }}>
            {ICON_SOURCE_NAME}
          </a>{' '}
          searchable from any icon picker — a curated set of {ICON_COUNT} loads instantly, the rest load on
          demand as you search or open an entity that uses one. All are licensed under{' '}
          <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--color-accent)' }}>
            Creative Commons Attribution 3.0
          </a>{' '}
          (a few contributors release their work as CC0). The icons are recoloured
          to match the theme but are otherwise unmodified. Icons made by:
        </p>

        <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 list-none p-0 m-0">
          {ICON_ARTISTS.map((artist) => {
            const count = ICON_ARTIST_TOTAL_COUNTS[artist.key] ?? 0;
            return (
              <li key={artist.key} className="text-sm text-[var(--color-neutral-300)] flex items-baseline justify-between gap-2">
                <span>
                  {artist.url ? (
                    <a href={artist.url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--color-accent)' }}>
                      {artist.name}
                    </a>
                  ) : (
                    artist.name
                  )}
                  {artist.cc0 && <span className="text-[10px] text-[var(--color-neutral-600)] ml-1">(CC0)</span>}
                </span>
                <span className="text-[var(--color-neutral-600)] text-xs shrink-0">{count}</span>
              </li>
            );
          })}
        </ul>

        <p className="text-[11px] text-[var(--color-neutral-600)] leading-snug">
          Campfire is self-hosted and works offline: every icon above ships with the app (no runtime requests to{' '}
          {ICON_SOURCE_NAME}). The {ICON_COUNT}-icon curated set is in the main app bundle; the rest load from a
          static, cached-once-viewed bundle the first time they're searched or used.
        </p>
      </Card>
    </div>
  );
}

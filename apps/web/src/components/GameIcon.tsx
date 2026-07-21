/**
 * GameIcon (issue #302; full-set lazy resolution issue #349) — renders a
 * bundled game-icons.net entity icon by slug.
 *
 * The icon body is trusted, either build-time-generated SVG markup shipped in
 * the app bundle (curated set) or fetched from a static, build-generated json
 * shard (full set, see apps/web/src/lib/icons/index.ts#resolveIcon) — never
 * user input — so injecting it via dangerouslySetInnerHTML is safe either way.
 * The icon inherits the current text colour (`fill: currentColor`), so callers
 * colour it by setting `color` on a wrapper.
 *
 * Curated slugs (the common case) render synchronously on first paint, same as
 * before. A slug outside the curated ~180 kicks off `resolveIcon` — which
 * lazily loads the full-set index + the relevant body shard — and renders
 * `fallback` until it resolves (or forever, for a genuinely unknown/removed
 * slug). `fallback` defaults to nothing, matching the old "unknown slug
 * renders nothing" behaviour for callers that don't pass one.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { getCachedIcon, resolveIcon, ICON_VIEWBOX, type GameIconEntry } from '../lib/icons';

export function GameIcon({
  slug,
  size = 24,
  className = '',
  title,
  fallback,
  reserveSpace = false,
}: {
  slug: string | null | undefined;
  /** Pixel size of the square icon. */
  size?: number;
  className?: string;
  /** Accessible label; when omitted the icon is treated as decorative. */
  title?: string;
  /** Rendered while a non-curated slug resolves, and permanently for an unknown slug. */
  fallback?: ReactNode;
  /**
   * When true, reserve a `size`×`size` box while a non-curated slug resolves
   * (instead of rendering nothing), so the surrounding layout doesn't shift when
   * the async icon lands. Ignored when an explicit `fallback` is given. Use on
   * frequently-shown chrome (empty states, the DM panel) where the icon is
   * usually non-curated; leave off where "unknown slug → nothing" is desired.
   */
  reserveSpace?: boolean;
}) {
  // Seed from everything already in memory (curated OR a prior resolve's cache), so a
  // previously-seen non-curated slug paints on the first render instead of flickering
  // "no icon" for a tick on every remount (nav/tab bar/chips).
  const [icon, setIcon] = useState<GameIconEntry | undefined>(() => getCachedIcon(slug));
  // Whether an async resolveIcon() is genuinely in flight — true from mount for a
  // non-curated, not-yet-cached slug, false once it settles (resolved OR undefined).
  // reserveSpace only holds a box while this is true, so a slug that resolves to
  // `undefined` (unknown / offline shard fetch) collapses to nothing rather than a
  // permanent blank square.
  const [resolving, setResolving] = useState<boolean>(() => !!slug && !getCachedIcon(slug));

  useEffect(() => {
    const cached = getCachedIcon(slug);
    if (cached) {
      setIcon(cached);
      setResolving(false);
      return;
    }
    setIcon(undefined);
    if (!slug) {
      setResolving(false);
      return;
    }
    let live = true;
    setResolving(true);
    resolveIcon(slug).then((entry) => {
      if (live) {
        setIcon(entry);
        setResolving(false);
      }
    });
    return () => {
      live = false;
    };
  }, [slug]);

  if (!icon) {
    if (fallback !== undefined) return <>{fallback}</>;
    if (reserveSpace && resolving) {
      return <span aria-hidden="true" style={{ display: 'inline-block', width: size, height: size }} />;
    }
    return null;
  }
  return (
    <svg
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

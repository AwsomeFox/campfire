/**
 * GameIcon (issue #302) — renders a bundled game-icons.net entity icon by slug.
 *
 * The icon body is trusted, build-time-generated SVG markup shipped in the app
 * bundle (see apps/web/src/lib/icons) — never user input — so injecting it via
 * dangerouslySetInnerHTML is safe. The icon inherits the current text colour
 * (`fill: currentColor`), so callers colour it by setting `color` on a wrapper.
 *
 * Renders nothing when the slug isn't in the bundled set, so an unknown/removed
 * slug degrades gracefully to whatever fallback the caller shows alongside it.
 */
import { getIcon, ICON_VIEWBOX } from '../lib/icons';

export function GameIcon({
  slug,
  size = 24,
  className = '',
  title,
}: {
  slug: string | null | undefined;
  /** Pixel size of the square icon. */
  size?: number;
  className?: string;
  /** Accessible label; when omitted the icon is treated as decorative. */
  title?: string;
}) {
  const icon = getIcon(slug);
  if (!icon) return null;
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

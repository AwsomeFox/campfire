import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Route-level page heading (issue #649).
 *
 * Exactly one per top-level screen so skip/route-focus (#591) can target a real
 * h1. Sized to match the prior bare `<h3>` page titles (nocturne h3) so the
 * visual language stays put while the semantics become correct.
 *
 * `size="compact"` (issue #1711) is a documented, reusable alternative to
 * hand-overriding `fontSize` inline — the exact anti-pattern #1711 found
 * (`StatusHeader.tsx` wearing this component's CSS class on a bare `<h3>` with
 * its own one-off `fontSize: '1.35rem'`). Use it for a title that shares its
 * row with chips/badges (session count, danger level, status) rather than
 * standing alone atop the page — the Dashboard's campaign-name header and a
 * quest's detail-page title are both this shape. Does not touch typeface or
 * weight (`.cf-page-title` owns those); only `font-size` differs. See
 * `.cf-page-title--compact` in index.css.
 */
export function PageTitle({
  children,
  className,
  style,
  size = 'default',
  ...rest
}: {
  children: ReactNode;
  size?: 'default' | 'compact';
} & HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={['cf-page-title', size === 'compact' && 'cf-page-title--compact', className]
        .filter(Boolean)
        .join(' ')}
      style={style}
      {...rest}
    >
      {children}
    </h1>
  );
}

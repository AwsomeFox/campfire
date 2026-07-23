import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Route-level page heading (issue #649).
 *
 * Exactly one per top-level screen so skip/route-focus (#591) can target a real
 * h1. Sized to match the prior bare `<h3>` page titles (nocturne h3) so the
 * visual language stays put while the semantics become correct.
 */
export function PageTitle({
  children,
  className,
  style,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={['cf-page-title', className].filter(Boolean).join(' ')}
      style={style}
      {...rest}
    >
      {children}
    </h1>
  );
}

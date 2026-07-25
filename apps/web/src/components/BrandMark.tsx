/**
 * Campfire brand mark — shared flame SVG used in auth screens and app chrome.
 * `full` includes the ember strokes under the flame (login/setup aesthetic);
 * `mark` is the flame alone for compact nav headers.
 */
import type { CSSProperties } from 'react';

export function BrandMark({
  size = 44,
  variant = 'full',
  className,
  style,
}: {
  size?: number;
  variant?: 'full' | 'mark';
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      aria-hidden
    >
      <path
        d="M12 3c1.8 2.6 4.6 4.2 4.6 8a4.6 4.6 0 0 1-9.2 0c0-1.5.5-2.7 1.3-3.9.3 1 .9 1.7 1.7 2.2C10.2 7 10.7 4.9 12 3z"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {variant === 'full' && (
        <path
          d="M5 21l14-3M19 21L5 18"
          stroke="var(--color-neutral-600)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

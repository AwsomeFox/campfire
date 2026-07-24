/**
 * Whether the user has asked the OS/browser to minimize non-essential motion
 * (issue #594). Use for JS-driven animations and smooth scrolling; CSS also
 * enforces a global `@media (prefers-reduced-motion: reduce)` policy.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `scrollIntoView` behavior that respects the reduced-motion preference. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

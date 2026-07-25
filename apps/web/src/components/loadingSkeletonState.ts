/**
 * Loading skeleton contracts (issue #677).
 *
 * Pure helpers so route/card/inline/conditional-region gates can be pinned in
 * unit specs without a browser. Visual geometry lives in `ui.tsx`; these types
 * describe when each surface should render a placeholder vs real content.
 */

export type ConditionalRegionPhase = 'loading' | 'ready-hidden' | 'ready-visible';

/** Gate for regions that mount only after an async precondition (AI seat, attendance). */
export function conditionalRegionPhase(loading: boolean, visible: boolean | undefined): ConditionalRegionPhase {
  if (loading) return 'loading';
  if (!visible) return 'ready-hidden';
  return 'ready-visible';
}

export type SkeletonVariant = 'route' | 'card' | 'inline' | 'conditional-region';

export const SKELETON_TEST_IDS: Record<SkeletonVariant, string> = {
  route: 'skeleton-route',
  card: 'skeleton-card',
  inline: 'skeleton',
  'conditional-region': 'skeleton-conditional-region',
};

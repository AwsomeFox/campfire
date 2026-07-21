/**
 * `ToolChip.icon` (#338's `toolActivity.ts`) names a lucide-react icon so a future
 * lucide-based renderer can resolve it — but `lucide-react` isn't a dependency of
 * this app (nothing else here uses it; the rest of the UI is emoji/inline-SVG, see
 * `NotificationsBell`'s `typeIcon`). Rather than pull in a new package for one small
 * relay surface (#344), this maps the same icon-name vocabulary to the app's existing
 * emoji convention. Keep in sync with `RESOURCE_ICON` in `toolActivity.ts`.
 */
import type { ToolChipVariant } from './toolActivity';

const EMOJI_BY_ICON: Record<string, string> = {
  dices: '🎲',
  swords: '⚔️',
  users: '🛡️',
  map: '🗺️',
  'file-plus-2': '📝',
  'book-open': '📖',
  sparkles: '✨',
  'alert-triangle': '⚠️',
};

/** Best-effort emoji for a chip's lucide icon name; falls back to a generic spark. */
export function chipEmoji(icon: string): string {
  return EMOJI_BY_ICON[icon] ?? '✨';
}

/** Text color per chip variant, matching the app's existing rose/green/neutral palette. */
export function chipVariantColor(variant: ToolChipVariant): string | undefined {
  if (variant === 'error') return '#f87171';
  if (variant === 'proposal') return 'var(--color-accent-200)';
  return undefined;
}

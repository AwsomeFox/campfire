/**
 * `ToolChip.icon` (#338's `toolActivity.ts`) names a lucide-react icon so a future
 * lucide-based renderer can resolve it — but `lucide-react` isn't a dependency of
 * this app. Rather than pull in a new package for one small relay surface (#344),
 * this maps the same icon-name vocabulary to the app's game-icons pack (rendered via
 * <GameIcon>), matching the rest of the UI. Keep in sync with `RESOURCE_ICON` in
 * `toolActivity.ts`.
 */
import type { ToolChipVariant } from './toolActivity';

const SLUG_BY_ICON: Record<string, string> = {
  dices: 'rolling-dices',
  swords: 'crossed-swords',
  users: 'meeple',
  map: 'treasure-map',
  'file-plus-2': 'quill-ink',
  'book-open': 'open-book',
  sparkles: 'sparkles',
  'alert-triangle': 'hazard-sign',
};

/** Best-effort game-icons slug for a chip's lucide icon name; falls back to a generic spark. */
export function chipIconSlug(icon: string): string {
  return SLUG_BY_ICON[icon] ?? 'sparkles';
}

/** Text color per chip variant, matching the app's existing rose/green/neutral palette. */
export function chipVariantColor(variant: ToolChipVariant): string | undefined {
  if (variant === 'error') return '#f87171';
  if (variant === 'proposal') return 'var(--color-accent-200)';
  return undefined;
}

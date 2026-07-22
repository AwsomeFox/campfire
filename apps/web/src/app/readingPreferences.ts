import type { TextSize } from '@campfire/schema';

/** HTML attribute consumed by the semantic reading tokens in index.css. */
export const READING_MODE_ATTRIBUTE = 'data-reading-mode';

/**
 * Apply one account's reading mode to this document only. Default removes the
 * attribute so signed-out/account-switch transitions cannot inherit another
 * user's setting. This deliberately does not alter the root font size or zoom.
 */
export function applyReadingPreference(root: HTMLElement, mode: TextSize): void {
  if (mode === 'default') {
    root.removeAttribute(READING_MODE_ATTRIBUTE);
    return;
  }
  root.setAttribute(READING_MODE_ATTRIBUTE, mode);
}

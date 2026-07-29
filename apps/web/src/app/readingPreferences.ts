import type { TextSize } from '@campfire/schema';

/** HTML attribute consumed by the semantic reading tokens in index.css. */
export const READING_MODE_ATTRIBUTE = 'data-reading-mode';

/**
 * HTML attribute consumed by the body-zoom rule in index.css. Only 'large' has
 * a rule today (`:root[data-text-size='large'] body { zoom: 1.15; }`); the
 * attribute is still set for every non-default mode so a future 'comfortable'
 * rule can match without another integration change.
 */
export const TEXT_SIZE_ATTRIBUTE = 'data-text-size';

/**
 * Apply one account's reading mode to this document only. Default removes the
 * attributes so signed-out/account-switch transitions cannot inherit another
 * user's setting.
 *
 * Two attributes are driven from the same TextSize preference:
 *  - `data-reading-mode` selects the semantic reading tokens (type scale, leading).
 *  - `data-text-size` is what the body-zoom rule in index.css matches for the
 *    "Large" preference. It used to be written only by the comment, never by
 *    code, so the Large preference silently did nothing (issue #1534).
 *
 * This deliberately does not alter the root font size beyond those two
 * attribute-driven mechanisms.
 */
export function applyReadingPreference(root: HTMLElement, mode: TextSize): void {
  if (mode === 'default') {
    root.removeAttribute(READING_MODE_ATTRIBUTE);
    root.removeAttribute(TEXT_SIZE_ATTRIBUTE);
    return;
  }
  root.setAttribute(READING_MODE_ATTRIBUTE, mode);
  root.setAttribute(TEXT_SIZE_ATTRIBUTE, mode);
}

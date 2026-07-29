import type { TextSize } from '@campfire/schema';

/** HTML attribute consumed by the semantic reading tokens in index.css. */
export const READING_MODE_ATTRIBUTE = 'data-reading-mode';

/**
 * Apply one account's reading mode to this document only. Default removes the
 * attribute so signed-out/account-switch transitions cannot inherit another
 * user's setting.
 *
 * `TextSize` tunes prose and other reading surfaces ONLY — never controls,
 * maps, or VTT geometry (see the contract in packages/schema/src/index.ts).
 * The preference drives a single attribute, `data-reading-mode`, which the
 * `.reading-surface` token rules in index.css consume (`--type-reading`,
 * `--leading-reading`, ...). It deliberately does not alter root/body scale or
 * CSS zoom: an earlier `data-text-size` body-zoom rule contradicted that
 * contract and has been removed (issue #1534 part 2).
 */
export function applyReadingPreference(root: HTMLElement, mode: TextSize): void {
  if (mode === 'default') {
    root.removeAttribute(READING_MODE_ATTRIBUTE);
    return;
  }
  root.setAttribute(READING_MODE_ATTRIBUTE, mode);
}

/**
 * Undo snackbar chrome offset (issue #794).
 *
 * The bar used to sit at `bottom: 24` / `z-index: 1000`, which overlapped the
 * mobile `.cf-tabbar` and ignored the device safe-area inset. Bottom clearance
 * is now: measured tab-bar content height + safe-area + keyboard inset + gap.
 *
 * Pure helpers live here so the arithmetic is unit-tested without a browser;
 * `UndoSnackbar` owns the ResizeObserver / visualViewport side effects that
 * feed these numbers into CSS variables.
 */

/** Gap between the snackbar and the chrome it must clear. */
export const DEFAULT_SNACKBAR_GAP_PX = 12;

/** WCAG 2.5.5 / platform minimum for Undo and Dismiss. */
export const UNDO_HIT_TARGET_PX = 44;

export type UndoSnackbarBottomInput = {
  /** `.cf-tabbar` height with its safe-area padding already subtracted. */
  tabBarContentHeightPx: number;
  /** `env(safe-area-inset-bottom)` in CSS pixels. */
  safeAreaBottomPx: number;
  /** On-screen keyboard occlusion derived from `visualViewport`. */
  keyboardInsetPx: number;
  gapPx?: number;
};

/**
 * CSS `bottom` for a fixed undo snackbar: tab-bar content + safe-area +
 * keyboard + gap. Summing (not maxing) matches the acceptance criterion
 * "measured tab bar plus safe-area inset"; callers must pass the tab-bar
 * content height from {@link tabBarContentHeightPx} so safe-area is not
 * double-counted when the bar's own padding already includes it.
 */
export function computeUndoSnackbarBottomPx(input: UndoSnackbarBottomInput): number {
  const gap = input.gapPx ?? DEFAULT_SNACKBAR_GAP_PX;
  return (
    Math.max(0, input.tabBarContentHeightPx) +
    Math.max(0, input.safeAreaBottomPx) +
    Math.max(0, input.keyboardInsetPx) +
    gap
  );
}

/**
 * Convert a measured `.cf-tabbar` border-box height into the content height
 * that can be re-added to `env(safe-area-inset-bottom)` without double-counting.
 * Hidden / absent tab bars measure as 0 and stay 0.
 */
export function tabBarContentHeightPx(
  measuredHeightPx: number,
  safeAreaBottomPx: number,
): number {
  if (measuredHeightPx <= 0) return 0;
  return Math.max(0, measuredHeightPx - Math.max(0, safeAreaBottomPx));
}

/**
 * Pixels of the layout viewport covered by the on-screen keyboard (or other
 * visualViewport shrinkage). `offsetTop` accounts for iOS URL-bar / pinch
 * scroll so a shrunk-but-scrolled viewport does not under-clear.
 */
export function keyboardInsetFromVisualViewport(input: {
  layoutViewportHeightPx: number;
  visualViewportHeightPx: number;
  visualViewportOffsetTopPx: number;
}): number {
  return Math.max(
    0,
    input.layoutViewportHeightPx -
      input.visualViewportHeightPx -
      input.visualViewportOffsetTopPx,
  );
}

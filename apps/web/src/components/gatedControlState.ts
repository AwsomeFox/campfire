/**
 * Pure logic for {@link GatedControl} (issue #1933) — kept apart from the React wrapper so
 * the visibility rules and attribute-merging can be pinned in a `.unit.spec.ts` without a
 * browser.
 */

/** How long a coarse-pointer tap keeps the inline reason hint showing. */
export const GATED_HINT_MS = 2_000;

/** Everything that can make the reason bubble visible right now. */
export type GatedHintState = {
  hovered: boolean;
  focused: boolean;
  tapHintActive: boolean;
};

export const GATED_HINT_STATE_IDLE: GatedHintState = {
  hovered: false,
  focused: false,
  tapHintActive: false,
};

/** Desktop hover or keyboard focus shows the reason immediately; a coarse-pointer tap
 * also shows it for {@link GATED_HINT_MS} even after focus/hover end (see `GatedControl`'s
 * pointerup handler, which starts a timer rather than relying on blur/mouseleave). */
export function gatedTooltipVisible(state: GatedHintState): boolean {
  return state.hovered || state.focused || state.tapHintActive;
}

/** Whether the tap-to-reveal affordance applies on this pointer (coarse, no hover — issue
 * #1933's mobile case). `mql` is the `MediaQueryList`-shaped result of matching
 * `(hover: none) and (pointer: coarse)`, injected so this stays testable without `window`. */
export function isCoarsePointerQuery(mql: { matches: boolean } | null | undefined): boolean {
  return mql?.matches === true;
}

/** Merge this control's own reason-node id into whatever `aria-describedby` the wrapped
 * element already carried, rather than clobbering it. */
export function mergeDescribedBy(existing: string | undefined, ownId: string): string {
  return [existing, ownId].filter(Boolean).join(' ');
}

/** Merge the gated-disabled visual class onto whatever `className` the wrapped element
 * already carried. */
export function mergeGatedClassName(existing: string | undefined, gatedClassName: string): string {
  return [existing, gatedClassName].filter(Boolean).join(' ').trim();
}

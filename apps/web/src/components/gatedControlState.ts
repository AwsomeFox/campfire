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

/**
 * Hover/focus events GatedControl wires up. `tapStart` is the coarse-pointer branch
 * (`onPointerUp` in the component) — distinct from `mouseEnter`/`focus` because a tap can
 * legitimately arrive alongside them (see {@link applyGatedHintEvent}'s doc comment).
 */
export type GatedHintEvent = 'mouseEnter' | 'mouseLeave' | 'focus' | 'blur' | 'tapStart';

/**
 * Reduce one DOM event into the next hint-visibility state (issue #1933 review finding).
 *
 * A tap on real touch hardware ALSO fires compatibility `mouseenter`/`mouseover` and moves
 * focus to the element — there is no corresponding `mouseleave`/`blur` afterward on such a
 * device (nothing "unhovers" a finger that already lifted). If `mouseEnter`/`focus` were
 * allowed to latch `hovered`/`focused: true` on a coarse pointer, the reason bubble would
 * stay visible forever instead of hiding again after {@link GATED_HINT_MS} — the bubble
 * would never look at `isCoarsePointer` again once shown. The fix: `isCoarsePointer` gates
 * `mouseEnter`/`mouseLeave`/`focus`/`blur` to no-ops (hover/focus are not meaningful signals
 * on a device with no hover at all — that is the entire premise of `(hover: none)`), and
 * `tapStart` only ever applies while coarse. Only the tap timer
 * ({@link GatedControl}'s `setTimeout(GATED_HINT_MS)`, which calls this reducer with no
 * corresponding event — it just flips `tapHintActive` back off directly) can end the
 * bubble's visibility on such a device.
 */
export function applyGatedHintEvent(
  state: GatedHintState,
  event: GatedHintEvent,
  isCoarsePointer: boolean,
): GatedHintState {
  switch (event) {
    case 'mouseEnter':
      return isCoarsePointer ? state : { ...state, hovered: true };
    case 'mouseLeave':
      return isCoarsePointer ? state : { ...state, hovered: false };
    case 'focus':
      return isCoarsePointer ? state : { ...state, focused: true };
    case 'blur':
      return isCoarsePointer ? state : { ...state, focused: false };
    case 'tapStart':
      return isCoarsePointer ? { ...state, tapHintActive: true } : state;
  }
}

/** What the tap timer sets on expiry — independent of any DOM event. */
export function clearTapHint(state: GatedHintState): GatedHintState {
  return { ...state, tapHintActive: false };
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

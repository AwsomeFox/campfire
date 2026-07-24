/**
 * Pure drag-active model for ImageUpload's dropzone (issue #845).
 *
 * Native dragenter/dragleave fire when the pointer crosses *any* element
 * boundary — including from the dropzone into its own children. Toggling
 * drag-active off on every leave makes the highlight flicker even though the
 * file is still over a valid drop target.
 *
 * Instead of a depth counter (which drifts when leave-into-child is skipped
 * via containment but bubbled enter still increments), this reducer tracks a
 * boolean: enter always activates; leave clears only when relatedTarget is
 * outside the dropzone. Reset covers drop, cancel, and window blur.
 */

export type DropzoneDragSnapshot = {
  /** True while the pointer is over the dropzone (including children). */
  active: boolean;
};

export type DropzoneDragEvent =
  | { type: 'enter' }
  /** `stillInside` is true when relatedTarget is a descendant of the dropzone. */
  | { type: 'leave'; stillInside: boolean }
  | { type: 'reset' };

export const initialDropzoneDrag: DropzoneDragSnapshot = { active: false };

export function isDropzoneDragActive(state: DropzoneDragSnapshot): boolean {
  return state.active;
}

/**
 * Whether a dragleave's relatedTarget is still within the dropzone.
 * Used by the component; exported so tests can pin the containment contract.
 */
export function isRelatedTargetInside(
  currentTarget: EventTarget | null,
  relatedTarget: EventTarget | null,
): boolean {
  if (!(currentTarget instanceof Node) || !(relatedTarget instanceof Node)) {
    return false;
  }
  return currentTarget.contains(relatedTarget);
}

export function reduceDropzoneDrag(
  state: DropzoneDragSnapshot,
  event: DropzoneDragEvent,
): DropzoneDragSnapshot {
  switch (event.type) {
    case 'enter':
      return { active: true };
    case 'leave':
      // Crossing into a child: leave fires but we are still inside — keep active.
      if (event.stillInside) return state;
      // Leaving the dropzone entirely: clear regardless of prior nested enters.
      return { active: false };
    case 'reset':
      return initialDropzoneDrag;
    default: {
      // Exhaustiveness guard — if DropzoneDragEvent grows, this compile error flags it.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

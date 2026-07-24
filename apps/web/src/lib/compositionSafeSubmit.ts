/**
 * Composition-safe submit helpers (issue #854).
 *
 * Enter-to-create handlers that ignore IME composition create records with
 * partial Japanese/Chinese/Korean (and other IME / assistive) text: the Enter
 * that confirms a composition candidate also fires the submit shortcut.
 *
 * Prefer semantic `<form onSubmit>` over ad-hoc `onKeyDown` Enter handlers.
 * Guard both paths with a {@link CompositionSubmitGate} so:
 *   - submit shortcuts are ignored while composition is active;
 *   - the Enter some engines emit immediately after `compositionend` does not
 *     double-submit;
 *   - Escape does not dismiss an editor while composition owns that key.
 */

export type CompositionKeyEvent = {
  key?: string;
  keyCode?: number;
  which?: number;
  isComposing?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
  preventDefault?: () => void;
};

/** keyCode 229 — "IME processing" — used by older engines that omit `isComposing`. */
export const IME_PROCESSING_KEY_CODE = 229;

type ClearScheduler = (fn: () => void) => void;

let clearScheduler: ClearScheduler = (fn) => {
  setTimeout(fn, 0);
};

/** @internal Visible for tests. Restore with `null`. */
export function setCompositionClearSchedulerForTest(scheduler: ClearScheduler | null): void {
  clearScheduler = scheduler ?? ((fn) => {
    setTimeout(fn, 0);
  });
}

/** True while an IME / assistive composition session owns the keystroke. */
export function isImeComposing(event: CompositionKeyEvent): boolean {
  if (event.isComposing === true) return true;
  if (event.nativeEvent?.isComposing === true) return true;
  const code =
    event.keyCode ?? event.which ?? event.nativeEvent?.keyCode ?? event.nativeEvent?.which;
  return code === IME_PROCESSING_KEY_CODE;
}

export type CompositionSubmitGate = {
  /** Whether a composition session is currently active. */
  isComposing: () => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  /**
   * True when a submit shortcut / form submit should be ignored (composition
   * active, IME keyCode, or the one-shot Enter that follows `compositionend`).
   */
  shouldIgnoreSubmit: (event?: CompositionKeyEvent) => boolean;
  /** True when Escape must not dismiss/cancel the surrounding editor. */
  shouldIgnoreEscape: (event?: CompositionKeyEvent) => boolean;
  /** Spread onto the composed `<input>` / `<textarea>`. */
  inputProps: {
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  clear: () => void;
};

export type CompositionSubmitGateOptions = {
  /** Override the post-`compositionend` clear scheduler (defaults to `setTimeout(0)`). */
  scheduleClear?: ClearScheduler;
};

/**
 * Mutable gate that tracks composition and suppresses the Enter/submit some
 * engines emit immediately after `compositionend` (confirm ≠ create).
 */
export function createCompositionSubmitGate(
  options: CompositionSubmitGateOptions = {},
): CompositionSubmitGate {
  let composing = false;
  let suppressNextSubmit = false;
  const schedule = options.scheduleClear ?? ((fn: () => void) => clearScheduler(fn));

  const onCompositionStart = () => {
    composing = true;
    suppressNextSubmit = false;
  };

  const onCompositionEnd = () => {
    composing = false;
    // Confirming a candidate with Enter often delivers a follow-up keydown/submit
    // with `isComposing: false` in the same turn. Suppress that one shot.
    suppressNextSubmit = true;
    schedule(() => {
      suppressNextSubmit = false;
    });
  };

  const shouldIgnoreSubmit = (event?: CompositionKeyEvent) => {
    if (composing) return true;
    if (event && isImeComposing(event)) return true;
    if (suppressNextSubmit) {
      suppressNextSubmit = false;
      return true;
    }
    return false;
  };

  const shouldIgnoreEscape = (event?: CompositionKeyEvent) => {
    if (composing) return true;
    if (event && isImeComposing(event)) return true;
    return false;
  };

  return {
    isComposing: () => composing,
    onCompositionStart,
    onCompositionEnd,
    shouldIgnoreSubmit,
    shouldIgnoreEscape,
    inputProps: {
      onCompositionStart,
      onCompositionEnd,
    },
    clear: () => {
      composing = false;
      suppressNextSubmit = false;
    },
  };
}

/**
 * Form `onSubmit` wrapper: always `preventDefault`, then skip the action when
 * the gate says this submit was composition confirmation.
 */
export function compositionSafeFormSubmit(
  gate: CompositionSubmitGate,
  action: () => void,
): (event: { preventDefault: () => void }) => void {
  return (event) => {
    event.preventDefault();
    if (gate.shouldIgnoreSubmit()) return;
    action();
  };
}

/**
 * Keyboard Enter/Escape handler for surfaces that cannot use a semantic form.
 * Prefer {@link compositionSafeFormSubmit} + `<form>` when possible.
 */
export function compositionSafeKeySubmit(
  gate: CompositionSubmitGate,
  action: () => void,
  options?: { onEscape?: () => void },
): (event: CompositionKeyEvent) => void {
  return (event) => {
    if (event.key === 'Escape') {
      if (options?.onEscape && !gate.shouldIgnoreEscape(event)) {
        options.onEscape();
      }
      return;
    }
    if (event.key !== 'Enter') return;
    if (gate.shouldIgnoreSubmit(event)) return;
    event.preventDefault?.();
    action();
  };
}

/**
 * Escape-only handler for semantic forms: dismiss the editor without stealing
 * Enter from the form submit path, and without cancelling active composition.
 */
export function compositionSafeEscapeHandler(
  gate: CompositionSubmitGate,
  onEscape: () => void,
): (event: CompositionKeyEvent) => void {
  return (event) => {
    if (event.key !== 'Escape') return;
    if (gate.shouldIgnoreEscape(event)) return;
    onEscape();
  };
}

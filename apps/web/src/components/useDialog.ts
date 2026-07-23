/**
 * useDialog — shared focus/keyboard scaffolding for overlays (issue #92).
 *
 * Extracted from ConfirmDialog so the Change-password modal, the mobile More
 * sheet, and the user menu all get the same accessible behaviour:
 *  - Escape closes (unless `disabled`, e.g. a save is in flight)
 *  - focus trap: Tab / Shift+Tab cycle within the overlay while open (opt-out
 *    via `trapFocus: false` for popup menus, where Tab should fall through)
 *  - focus restore: focus returns to whatever was focused when the overlay
 *    opened (the trigger button) once it unmounts
 *  - initial focus moves into the overlay (first focusable, or the container)
 *
 * Returns a ref to attach to the overlay's root element. The caller still owns
 * the markup (role="dialog"/aria-modal, aria-labelledby, backdrop click, …) —
 * this hook only handles focus and the keyboard.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useDialog<T extends HTMLElement = HTMLDivElement>({
  onClose,
  disabled = false,
  trapFocus = true,
  autoFocus = true,
  initialFocusRef,
  inertBackground = false,
}: {
  onClose: () => void;
  /** When true, Escape is ignored (e.g. a destructive/save action is running). */
  disabled?: boolean;
  /** Cycle Tab within the overlay. Disable for non-modal popup menus. */
  trapFocus?: boolean;
  /** Move focus into the overlay on open. */
  autoFocus?: boolean;
  /** Prefer this element over the first focusable element when focus enters. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Make every branch outside the overlay inert until it unmounts. */
  inertBackground?: boolean;
}) {
  const ref = useRef<T>(null);
  // Latest callbacks/flags without re-subscribing the key handler each render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Initial focus + restore-on-close. Runs once per mount.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const inerted: Array<{ element: HTMLElement; hadAttribute: boolean; value: string | null }> = [];
    const root = ref.current;
    const addedFallbackTabIndex = Boolean(
      root && (autoFocus || trapFocus) && !root.hasAttribute('tabindex'),
    );

    // The container is the last-resort focus target when a dialog opens with no
    // enabled controls, or when every control becomes disabled while work is in
    // flight. HTMLElement.focus() is otherwise a no-op for a plain <div>.
    if (addedFallbackTabIndex) root?.setAttribute('tabindex', '-1');

    if (inertBackground) {
      // Overlays may render near their trigger or via a body-level portal
      // (ConfirmDialog, issue #791). Inert each sibling branch on the path to
      // <body>, which leaves the overlay usable while removing all obscured UI
      // from focus and the accessibility tree. Preserve pre-existing inert
      // state so nested overlays restore correctly when the top one closes.
      let current: HTMLElement | null = ref.current;
      while (current?.parentElement) {
        const parent: HTMLElement = current.parentElement;
        for (const sibling of Array.from(parent.children)) {
          if (sibling === current || !(sibling instanceof HTMLElement)) continue;
          inerted.push({
            element: sibling,
            hadAttribute: sibling.hasAttribute('inert'),
            value: sibling.getAttribute('inert'),
          });
          sibling.setAttribute('inert', '');
        }
        current = parent;
        if (current === document.body) break;
      }
    }

    if (autoFocus) {
      const first = root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (initialFocusRef?.current ?? first ?? root)?.focus();
    }
    return () => {
      // The trigger is part of the inert background, so restore the background
      // before returning focus to it.
      for (const { element, hadAttribute, value } of inerted.reverse()) {
        if (hadAttribute) element.setAttribute('inert', value ?? '');
        else element.removeAttribute('inert');
      }
      // Do not erase a tab index that the caller deliberately changed while
      // the overlay was mounted.
      if (addedFallbackTabIndex && root?.getAttribute('tabindex') === '-1') {
        root.removeAttribute('tabindex');
      }
      // Return focus to the trigger so keyboard users aren't dumped at the top.
      previouslyFocused?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (disabledRef.current) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && trapFocus) {
        const root = ref.current;
        if (!root) return;
        const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
        );
        if (focusable.length === 0) {
          e.preventDefault();
          if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
          root.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !focusable.includes(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [trapFocus]);

  return ref;
}

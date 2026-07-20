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
import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useDialog<T extends HTMLElement = HTMLDivElement>({
  onClose,
  disabled = false,
  trapFocus = true,
  autoFocus = true,
}: {
  onClose: () => void;
  /** When true, Escape is ignored (e.g. a destructive/save action is running). */
  disabled?: boolean;
  /** Cycle Tab within the overlay. Disable for non-modal popup menus. */
  trapFocus?: boolean;
  /** Move focus into the overlay on open. */
  autoFocus?: boolean;
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
    if (autoFocus) {
      const root = ref.current;
      const first = root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? root)?.focus();
    }
    return () => {
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
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
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

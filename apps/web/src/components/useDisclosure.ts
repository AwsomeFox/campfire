/**
 * useDisclosure — shared a11y scaffolding for show/hide panels (issue #884).
 *
 * Standardizes the disclosure widget pattern (ARIA APG) across the app so every
 * "click a button to toggle a region" surface agrees on:
 *   - `aria-expanded` on the trigger, kept in sync with open state
 *   - `aria-controls` on the trigger pointing at a stable region id
 *   - the controlled region carrying `role="region"` + optional `aria-label`
 *   - collapsed regions removed from the focus and accessibility tree (the
 *     region is unmounted when closed, which is stronger than `inert` and
 *     keeps lazy fetchers like ScribePanel/RevisionHistoryPanel working)
 *   - optional focus management: focus the first focusable control when the
 *     region opens, and restore focus to the trigger when it closes — so
 *     keyboard/SR users always have a deliberate place to be. Opt out with
 *     `focusManagement: false` to keep focus on the trigger (the textbook
 *     disclosure behaviour, appropriate for inline toggles where moving focus
 *     would be jarring).
 *
 * The hook does NOT render anything — callers spread `buttonProps` onto their
 * trigger and `regionProps` onto the region wrapper. That keeps styling
 * per-surface (these triggers range from `cf-btn` to `cf-chip` to plain
 * `<button>`) while the semantics stay centralized here.
 *
 * Collapsed regions are intentionally NOT kept mounted with `inert`: a couple
 * of these panels (RevisionHistoryPanel, ScribePanel, CombatantStatblock) do
 * real work in effects keyed on `open`, so the unmount-on-close contract is
 * load-bearing. Removing the region from the DOM also removes it from the
 * accessibility tree entirely, which is the acceptance criterion.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type RefObject,
} from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DisclosureButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: RefObject<HTMLButtonElement>;
};

export type DisclosureRegionProps = HTMLAttributes<HTMLDivElement> & {
  ref?: RefObject<HTMLDivElement>;
};

export function useDisclosure({
  id: controlledId,
  initialOpen = false,
  focusManagement = true,
  regionLabel,
}: {
  /** Override the generated region id (rare; tests/screenshots only). */
  id?: string;
  /** Open on first render. */
  initialOpen?: boolean;
  /**
   * Move focus into the region on open and back to the trigger on close.
   * Defaults to true; pass false for inline toggles where focus should stay
   * put (e.g. the encounter "Grid & fog" chip, which toggles a toolbar row).
   */
  focusManagement?: boolean;
  /**
   * Accessible name for the region. When provided the region is tagged
   * `role="region"` + `aria-label`; when omitted, the caller is expected to
   * label the region itself (e.g. via `aria-labelledby`).
   */
  regionLabel?: string;
} = {}) {
  const generatedRegionId = useId();
  const regionId = controlledId ?? generatedRegionId;
  const [open, setOpenState] = useState(initialOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  // Latest callbacks/flags read inside closures without re-subscribing.
  const openRef = useRef(open);
  openRef.current = open;
  const focusManagementRef = useRef(focusManagement);
  focusManagementRef.current = focusManagement;
  // The element that held focus before we moved it into the region — always
  // the trigger in practice, but captured defensively in case focus was
  // elsewhere (e.g. a screen-reader virtual cursor). Mutable so the open
  // handler can record it; never spread onto the DOM.
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const setOpen = useCallback((next: boolean) => {
    setOpenState((current) => {
      if (current === next) return current;
      if (next && focusManagementRef.current) {
        previousFocusRef.current =
          (document.activeElement as HTMLElement | null) ?? triggerRef.current;
      }
      return next;
    });
  }, []);

  const toggle = useCallback(() => {
    setOpen(!openRef.current);
  }, [setOpen]);

  // Focus in on open, restore on close. Runs whenever `open` flips to true;
  // the cleanup restores focus when it flips back (or the region unmounts).
  useEffect(() => {
    if (!open || !focusManagement) return;
    const region = regionRef.current;
    if (!region) return;
    // Defer one frame so caller-rendered children (lazy fetched forms, the
    // revision list, etc.) are present before we pick a focus target.
    const handle = window.requestAnimationFrame(() => {
      const first = region.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (first) {
        first.focus();
      } else {
        // No focusable child — make the region itself focusable so SR users
        // land on the newly-revealed content rather than skipping past it.
        if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '-1');
        region.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(handle);
      const restore = previousFocusRef.current ?? triggerRef.current;
      restore?.focus?.();
    };
  }, [open, focusManagement]);

  const buttonProps: DisclosureButtonProps = {
    ref: triggerRef,
    'aria-expanded': open,
    'aria-controls': open ? regionId : undefined,
    onClick: toggle,
  };

  const regionProps: DisclosureRegionProps = {
    id: regionId,
    ref: regionRef,
    ...(regionLabel ? { role: 'region' as const, 'aria-label': regionLabel } : {}),
  };

  return {
    open,
    setOpen,
    toggle,
    regionId,
    buttonProps,
    regionProps,
    triggerRef,
    regionRef,
  };
}

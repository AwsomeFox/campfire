/**
 * TermHelp — first-use explanation for Campfire jargon (issue #518).
 *
 * A textbook disclosure: a real `?` button (aria-expanded/aria-controls) that
 * reveals a labelled region with the short definition, who can see the surface,
 * and whether it touches canon. Deliberately NOT hover-only — it is operable by
 * click, tap, and keyboard, and the panel content is in the accessibility tree
 * rather than a `title` tooltip.
 *
 * Positioning: the panel is `position: fixed` and placed from the trigger's
 * bounding rect rather than `position: absolute`. Several hosts (the desktop
 * sidebar `<aside>`, which is `w-[230px] overflow-x-hidden`) are narrower than
 * the panel and clip absolutely-positioned descendants; fixed positioning has
 * the viewport as its containing block, so the panel escapes those clips. The
 * panel stays in the DOM where it is rendered (no portal) so it remains inside
 * the More sheet's `aria-modal` dialog and its focus trap.
 */
import { Card } from './ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDisclosure } from './useDisclosure';
import { fitTermHelpPanel, type TermHelpPanelPosition } from './termHelpPosition';
import {
  GLOSSARY_TERMS,
  glossaryTermHref,
  termHelpStorageKey,
  type GlossaryTermId,
} from '../features/glossary/glossaryTerms';

/**
 * Cross-instance dismissal signal (issue #518).
 *
 * A term's help marker can be mounted more than once at the same time — the desktop
 * sidebar nav item and the page header both render one for `scribe`/`proposals`, and
 * the sidebar is part of the app chrome, so it survives route changes. Each instance
 * seeds its `dismissed` flag from localStorage at mount, so dismissing one would leave
 * its siblings on screen until a full reload. This tiny registry lets a dismissal reach
 * every mounted marker for the same term immediately.
 *
 * Module-level rather than context: TermHelp is dropped into unrelated trees (nav,
 * headers, the More sheet) and threading a provider through all of them buys nothing.
 */
const termHelpDismissListeners = new Map<GlossaryTermId, Set<() => void>>();

function subscribeTermHelpDismissed(termId: GlossaryTermId, listener: () => void): () => void {
  const listeners = termHelpDismissListeners.get(termId) ?? new Set<() => void>();
  listeners.add(listener);
  termHelpDismissListeners.set(termId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) termHelpDismissListeners.delete(termId);
  };
}

function notifyTermHelpDismissed(termId: GlossaryTermId): void {
  for (const listener of termHelpDismissListeners.get(termId) ?? []) listener();
}

export function TermHelp({
  termId,
  className = '',
  align = 'start',
  onNavigate,
}: {
  termId: GlossaryTermId;
  className?: string;
  align?: 'start' | 'end';
  /**
   * Called when the panel's "Open glossary" link navigates. Overlay hosts (the
   * mobile More sheet) pass their close handler so the sheet does not stay
   * mounted over the glossary page.
   */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const term = GLOSSARY_TERMS[termId];
  const label = t(term.labelKey);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(termHelpStorageKey(termId)) === '1';
    } catch {
      return false;
    }
  });
  const { open, setOpen, buttonProps, regionProps } = useDisclosure({
    focusManagement: false,
    regionLabel: t('glossary.termHelpRegion', { term: label }),
  });
  const { ref: regionRef, ...regionAttrs } = regionProps;
  const { ref: triggerRef, ...buttonAttrs } = buttonProps;
  const panelRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<TermHelpPanelPosition | null>(null);

  const setPanelRef = useCallback(
    (node: HTMLSpanElement | null) => {
      panelRef.current = node;
      // Keep the disclosure hook's region ref wired even though focus
      // management is off, so the hook stays usable without further surgery.
      (regionRef as unknown as { current: HTMLElement | null }).current = node;
    },
    [regionRef],
  );

  const updatePosition = useCallback(() => {
    const trigger = triggerRef?.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    setPosition(
      fitTermHelpPanel(trigger.getBoundingClientRect(), panel.getBoundingClientRect(), align, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [align, triggerRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (triggerRef?.current) observer.observe(triggerRef.current);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', updatePosition);
    // Capture: the sidebar and the More sheet are their own scroll containers.
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, triggerRef, updatePosition]);

  useEffect(() => {
    if (dismissed) return;
    const hide = () => setDismissed(true);
    const unsubscribe = subscribeTermHelpDismissed(termId, hide);
    // Another tab dismissing the same term writes localStorage but cannot reach this
    // tab's registry, so mirror it through the storage event.
    function onStorage(event: StorageEvent) {
      if (event.key === termHelpStorageKey(termId) && event.newValue === '1') hide();
    }
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, [dismissed, termId]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Capture + stopPropagation so Escape closes only this panel and not
        // the More sheet / dialog it may be rendered inside.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        // Return focus to the trigger. `focusManagement: false` means useDisclosure
        // deliberately does not do this, which is right for the common case where
        // focus never left the trigger — but the panel's own "Open glossary" and
        // "Dismiss" controls are the next tab stops, so a keyboard user can be
        // INSIDE the panel when they press Escape. The panel then unmounts and focus
        // would fall to document.body, dropping them at the top of the page
        // (Devin review on #1431). The trigger itself stays mounted, so this is safe.
        triggerRef?.current?.focus();
      }
    }
    function dismissOutside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef?.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', dismissOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', dismissOutside);
    };
  }, [open, setOpen, triggerRef]);

  if (dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(termHelpStorageKey(termId), '1');
    } catch {
      /* localStorage can be unavailable in private modes; the visible dismiss still works. */
    }
    setOpen(false);
    setDismissed(true);
    // Hide every OTHER mounted marker for this term too. Several terms render in two
    // persistent places at once — the always-mounted desktop sidebar nav item and the
    // page header — and each instance seeds `dismissed` from localStorage only at mount.
    // Without this the sidebar copy survives every route change and only disappears on a
    // full reload, so "Dismiss" visibly fails to dismiss (Devin review on #1431).
    notifyTermHelpDismissed(termId);
  }

  return (
    <span className={`cf-term-help cf-term-help--${align} ${className}`.trim()}>
      <button
        {...buttonAttrs}
        ref={triggerRef}
        type="button"
        className="cf-term-help__trigger"
        aria-label={t('glossary.termHelpAria', { term: label })}
        data-testid={`term-help-trigger-${termId}`}
      >
        ?
      </button>
      {open && (
        <Card
          {...(regionAttrs as HTMLAttributes<HTMLSpanElement>)}
          ref={setPanelRef}
          density="compact" elev="md" as="span" className="cf-term-help__panel"
          data-testid={`term-help-panel-${termId}`}
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            maxHeight: position?.maxHeight,
            // Hidden for the single measuring frame so the panel never flashes
            // at the top-left corner before it is anchored.
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          <span className="cf-term-help__title">{label}</span>
          <span className="cf-term-help__body">{t(term.shortKey)}</span>
          <span className="cf-term-help__meta">
            <span>{t('glossary.metaAudience')}: {t(term.audienceKey)}</span>
            <span>{t('glossary.metaVisibility')}: {t(term.visibilityKey)}</span>
          </span>
          <span className="cf-term-help__actions">
            <Link
              to={glossaryTermHref(termId)}
              className="cf-term-help__link"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
            >
              {t('glossary.openGlossary')}
            </Link>
            <button type="button" className="cf-term-help__dismiss" onClick={dismiss}>
              {t('glossary.dismiss')}
            </button>
          </span>
        </Card>
      )}
    </span>
  );
}

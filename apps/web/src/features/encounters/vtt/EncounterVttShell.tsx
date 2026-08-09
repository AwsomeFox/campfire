/**
 * Encounter VTT shell — the full-viewport combat screen chrome.
 *
 * Imported from the approved design template
 * `templates/encounter-vtt/EncounterVtt.dc.html` in the Campfire design-system
 * project. The template is a no-scroll cockpit: a 54px header, a map canvas that
 * owns the remaining space (the map's own tool rail sits along its left edge),
 * and a 356px tabbed side panel. Everything that used to be a stacked card on the
 * run page now lives in one of the panel's tabs.
 *
 * This component is presentational on purpose. It owns layout, the panel's
 * open/closed state contract and tab semantics; it owns no encounter state, so
 * RunSessionPage keeps every permission, secrecy and sync decision it already had.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { scrollBehavior } from '../../../lib/prefersReducedMotion';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { ENTITY_DEEP_LINK_WINDOW_MS } from '../../../app/EntityDeepLinkFocus';
import { useImmersiveChromeInset } from './useImmersiveChromeInset';
import { REVEAL_COCKPIT_PANEL_EVENT, type RevealCockpitPanelDetail } from './revealCockpitPanel';

export type VttTab = {
  id: string;
  label: string;
  /** Optional count/dot rendered after the label (e.g. unread log entries). */
  badge?: ReactNode;
};

type Props = {
  /** Return link (design: "← Encounters"). Rendered as-is at the header's left edge. */
  backSlot: ReactNode;
  title: ReactNode;
  /** Difficulty / status tags rendered beside the title. */
  titleBadges?: ReactNode;
  /** Round + elapsed pill. */
  metaSlot?: ReactNode;
  /** Live / sync chips. */
  statusSlot?: ReactNode;
  /** Turn controls (Back · Next turn · End). Pushed to the header's right edge. */
  actionsSlot?: ReactNode;
  /**
   * Errors, sync banners and other must-see rows. The design has no banner
   * region; they get their own grid row under the header rather than being
   * hidden inside a tab, because several of them gate combat writes.
   */
  bannerSlot?: ReactNode;
  /** The battle map (or its empty state), stretched to fill the canvas. */
  mapSlot: ReactNode;
  /** Absolutely-positioned map furniture — the initiative strip, hint pills. */
  mapOverlaySlot?: ReactNode;
  /** Floating roll button + its tray. */
  fabSlot?: ReactNode;
  tabs: readonly VttTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  panelSlot: ReactNode;
  /**
   * Identifies a prompt that is waiting on the viewer. When it becomes non-null the panel
   * reopens, because such a prompt arrives unprompted (a co-DM's damage, an MCP action)
   * and would otherwise sit unseen inside a collapsed panel. `null` while nothing waits.
   */
  attentionKey?: string | null;
  /** Dialogs, snackbars and other portaled-in-place overlays. */
  children?: ReactNode;
  /**
   * The canvas is showing setup (no map attached) rather than a board. The turn bar then
   * stacks under it instead of floating over it — an overlay on top of the upload and
   * generate controls makes the ones near the bottom unclickable however far you scroll.
   */
  mapStacked?: boolean;
  /** Extra classes for the root (print hooks live here). */
  className?: string;
  /** Spread onto the root — RunSessionPage passes its entity-target props. */
  rootProps?: Record<string, unknown>;
};

/**
 * Select whichever panel owns the element the URL hash points at.
 *
 * The target may not exist yet — a comment thread is fetched — so this retries over a
 * short window rather than giving up on the first frame, and stops as soon as it
 * resolves. A hash pointing at something outside the panel (or at nothing) is left
 * alone, as is a tab the viewer has since chosen for themselves.
 */
/**
 * Reveal the panel owning an element: select its tab AND open the panel, since either
 * one alone still leaves the target invisible.
 */
function usePanelRevealer(
  tabs: readonly VttTab[],
  activeTabId: string,
  onSelectTab: (id: string) => void,
  panelOpen: boolean,
  onPanelOpenChange: (open: boolean) => void,
) {
  const state = useRef({ tabs, activeTabId, onSelectTab, panelOpen, onPanelOpenChange });
  state.current = { tabs, activeTabId, onSelectTab, panelOpen, onPanelOpenChange };

  return useRef((elementId: string): boolean => {
    const target = document.getElementById(elementId);
    const section = target?.closest<HTMLElement>('.cf-vtt-panel-section');
    const owner = section?.id?.replace('cf-vtt-tabpanel-', '');
    const current = state.current;
    if (!owner || !current.tabs.some((tab) => tab.id === owner)) return false;
    if (owner !== current.activeTabId) current.onSelectTab(owner);
    if (!current.panelOpen) current.onPanelOpenChange(true);
    return true;
  }).current;
}

function useDeepLinkedPanel(
  reveal: (elementId: string) => boolean,
  activeTabId: string,
): void {
  // Keyed on the router location, not just the tab list: this shell is reused across
  // encounter navigations, so following a second notification while the cockpit is
  // already mounted changes the pathname and hash but nothing else — an effect that
  // depended only on the (constant) tab ids would never run again for the new target.
  const location = useLocation();
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const activeTabRef = useRef(activeTabId);
  activeTabRef.current = activeTabId;

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let frame = 0;
    // Whatever tab was showing when this navigation began. If the viewer picks a different
    // one while we are still waiting for the target to load, they have answered the
    // question themselves — abandon the resolve rather than yanking them back later.
    const tabAtNavigation = activeTabRef.current;

    const resolve = () => {
      if (cancelled) return true;
      const hash = window.location.hash.slice(1);
      if (!hash) return true;
      if (!document.getElementById(hash)) return false;
      if (!revealRef.current(hash)) return true;
      // Redo the focus and scroll ourselves. `EntityDeepLinkFocus` gets exactly one
      // attempt: its MutationObserver fires the moment the target MOUNTS and then
      // disconnects — and for a comment that arrives inside a hidden panel that is
      // strictly before this poller reveals it, so its attempt ran against an element
      // with a `hidden` ancestor, where `focus()` is refused and `scrollIntoView()` has
      // nothing to scroll. Nothing retries it, so the notification target was left
      // unfocused and often below the panel viewport.
      // Across several frames, not one. The reveal is a React state change and the panel
      // it uncovers may still be laying out — on a cold first load `focus()` one frame
      // later can land while the element is still inside a `hidden` ancestor, where it is
      // silently refused. Keep trying until it takes, then stop.
      let attemptsLeft = 30;
      const settle = () => {
        frame = 0;
        if (cancelled) return;
        const target = document.getElementById(hash);
        if (!target) return;
        target.focus({ preventScroll: true });
        if (document.activeElement === target) {
          target.scrollIntoView({ block: 'center', inline: 'nearest' });
          return;
        }
        if (attemptsLeft-- > 0) frame = requestAnimationFrame(settle);
      };
      frame = requestAnimationFrame(settle);
      return true;
    };

    if (resolve()) return undefined;
    // Retried at 250ms for exactly as long as `EntityDeepLinkFocus` keeps observing.
    // The two windows MUST match: that observer fires its single focus attempt the moment
    // the target mounts, so a comment list that takes longer than this poller was willing
    // to wait got that one attempt against an element still inside a hidden panel — the
    // notification then opened on the right encounter with its target neither revealed
    // nor focused. Giving up early cannot fight a viewer who picks another tab either,
    // since the tab check below abandons the resolve outright.
    const maxAttempts = Math.ceil(ENTITY_DEEP_LINK_WINDOW_MS / 250);
    const timer = window.setInterval(() => {
      attempts += 1;
      if (activeTabRef.current !== tabAtNavigation) {
        cancelled = true;
        window.clearInterval(timer);
        return;
      }
      if (resolve() || attempts > maxAttempts) window.clearInterval(timer);
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [location.key, location.pathname, location.hash]);
}

export function EncounterVttShell({
  backSlot,
  title,
  titleBadges,
  metaSlot,
  statusSlot,
  actionsSlot,
  bannerSlot,
  mapSlot,
  mapOverlaySlot,
  fabSlot,
  tabs,
  activeTabId,
  onSelectTab,
  panelOpen,
  onPanelOpenChange,
  panelSlot,
  attentionKey = null,
  children,
  mapStacked = false,
  className,
  rootProps,
}: Props) {
  const { t } = useTranslation();
  const panelLabel = t('encounters.vtt.panelLabel');
  const { pathname } = useLocation();

  // Collapsing the panel hides the control that was just activated, so without this the
  // keyboard user's focus falls to the document and getting back to the reopen tab means
  // traversing the whole cockpit. Hand focus to the control that replaces it, and back
  // again on reopen. Only on a real toggle — `panelOpen` also changes when something else
  // reopens the panel, and stealing focus then would be worse than leaving it alone.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reopenButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<'closed' | 'opened' | null>(null);
  // Reopen for a prompt that needs an answer — but only as it appears, so a viewer who
  // collapses the panel again while it is still up is not fought by this effect.
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const onPanelOpenChangeRef = useRef(onPanelOpenChange);
  onPanelOpenChangeRef.current = onPanelOpenChange;
  // The prompts render ABOVE the tab sections inside one shared scroller, so on an
  // already-open panel that the viewer had scrolled down (a long roster, the setup table)
  // a new prompt is prepended out of sight and the panel does not move — reopening alone
  // only covers the collapsed case. Scroll the shared body back to the prompts too.
  const panelBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!attentionKey) return;
    if (!panelOpenRef.current) onPanelOpenChangeRef.current(true);
    // Next frame: a panel that was just reopened has not been laid out yet, and
    // scrollTo on a `hidden` element does nothing.
    const frame = requestAnimationFrame(() => {
      panelBodyRef.current?.scrollTo({ top: 0, behavior: scrollBehavior() });
    });
    return () => cancelAnimationFrame(frame);
  }, [attentionKey]);

  // One scroller serves all four sections, so its `scrollTop` used to carry straight
  // across a tab change: after reading to the bottom of a long Table, selecting Turn
  // landed on whatever happened to be at that offset — or, when the new section was
  // shorter, on the browser's clamp of it — with the vitals and controls at the top of
  // the panel off screen. Remember where each tab was left and restore it on the way
  // back, which for a tab nobody has scrolled is simply the top.
  const panelScrollRef = useRef(new Map<string, number>());
  const renderedTabRef = useRef(activeTabId);
  renderedTabRef.current = activeTabId;
  const restoredTabRef = useRef<string | null>(null);

  // Those offsets belong to ONE encounter. This shell is reused across encounter
  // navigations without an unmount, so without this, leaving one fight scrolled deep in
  // Party and opening another that also lands on Party changed no tab at all — the effect
  // below never ran and the new roster inherited the old offset. Keyed on the pathname,
  // which is exactly "which encounter is on screen"; declared before the restore so a
  // navigation clears first and the restore then finds nothing, i.e. the top.
  const panelPathRef = useRef(pathname);
  useLayoutEffect(() => {
    if (panelPathRef.current === pathname) return;
    panelPathRef.current = pathname;
    panelScrollRef.current.clear();
    restoredTabRef.current = null;
    // The live offset has to go too, not only the remembered ones: when both encounters
    // open on the same tab `activeTabId` never changes, so the restore below does not run
    // and the scroller simply kept the previous fight's position.
    if (panelBodyRef.current) panelBodyRef.current.scrollTop = 0;
  }, [pathname]);

  useLayoutEffect(() => {
    const body = panelBodyRef.current;
    if (!body) return;
    if (restoredTabRef.current === activeTabId) return;
    restoredTabRef.current = activeTabId;
    body.scrollTop = panelScrollRef.current.get(activeTabId) ?? 0;
  }, [activeTabId]);

  // Recorded from the scroll event rather than saved when the tab changes: by the time a
  // layout effect for the new tab runs, the browser has already clamped `scrollTop` to
  // the newly visible content, so the outgoing tab's real offset is gone.
  const onPanelBodyScroll = useCallback(() => {
    const body = panelBodyRef.current;
    if (body) panelScrollRef.current.set(renderedTabRef.current, body.scrollTop);
  }, []);

  useEffect(() => {
    const move = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (move === 'closed') reopenButtonRef.current?.focus();
    else if (move === 'opened') closeButtonRef.current?.focus();
  }, [panelOpen]);

  // Layout mounts the safety hold and check-request prompts outside the routed page so
  // they reach every campaign route. This shell would paint over both, so it publishes
  // how far down they reach and insets its own top by it — see the hook's doc.
  useImmersiveChromeInset();

  // Reveal the panel a deep link points into. Comment-reply notifications land on
  // `#entity-comment-…`, and `EntityDeepLinkFocus` focuses and scrolls the target — but
  // neither reveals a hidden ancestor, so a link into a panel that is not the selected
  // tab used to arrive with its target invisible. Resolving the hash to its owning
  // section and selecting that tab fixes every such link, not just comments.
  const revealPanelFor = usePanelRevealer(tabs, activeTabId, onSelectTab, panelOpen, onPanelOpenChange);
  useDeepLinkedPanel(revealPanelFor, activeTabId);

  // Anything outside the panel that jumps to an element inside it (a map token's
  // condition badge) asks for the reveal first — see `revealCockpitPanel`.
  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<RevealCockpitPanelDetail>).detail;
      if (detail?.elementId) revealPanelFor(detail.elementId);
    };
    window.addEventListener(REVEAL_COCKPIT_PANEL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_COCKPIT_PANEL_EVENT, onReveal);
  }, [revealPanelFor]);

  // The shell is `position: fixed` and owns the viewport, so a scrollable body
  // behind it only produces rubber-banding on touch. Restored on unmount so
  // navigating away from the encounter leaves the rest of the app scrollable.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('cf-vtt-locked');
    return () => root.classList.remove('cf-vtt-locked');
  }, []);

  return (
    <div
      className={`cf-vtt${mapStacked ? ' cf-vtt--stacked-map' : ''}${className ? ` ${className}` : ''}`}
      {...rootProps}
    >
      <header className="cf-vtt-header" data-testid="encounter-vtt-header">
        {backSlot}
        <div className="cf-vtt-title">
          <h1 className="cf-vtt-title-text">{title}</h1>
          {titleBadges}
        </div>
        {metaSlot}
        {statusSlot}
        <div className="cf-vtt-header-spacer" />
        {actionsSlot}
      </header>

      {/* Always mounted so the grid row exists; `:empty` collapses it when every
          banner inside is currently false, which is the common case. */}
      <div className="cf-vtt-banners" data-testid="encounter-vtt-banners">
        {bannerSlot}
      </div>

      <div className="cf-vtt-body">
        {/* A plain div, not <main>: this shell renders inside Layout's own
            `<main id={MAIN_CONTENT_ID}>`, so a second one would nest and duplicate the
            document's main landmark on every encounter route. */}
        <div className="cf-vtt-main" data-testid="encounter-vtt-canvas">
          {mapSlot}
          {mapOverlaySlot}
          {fabSlot}
          {!panelOpen && (
            <button
              type="button"
              ref={reopenButtonRef}
              className="cf-vtt-panel-reopen"
              data-testid="encounter-vtt-panel-open"
              aria-label={t('encounters.vtt.showPanel')}
              aria-expanded={false}
              title={t('encounters.vtt.showPanel')}
              onClick={() => {
                pendingFocusRef.current = 'opened';
                onPanelOpenChange(true);
              }}
            >
              <span aria-hidden>‹</span>
            </button>
          )}
        </div>

        {/* Hidden, never unmounted — collapsing the panel is a viewing choice, and it must
            not throw away an in-flight write's reconciliation guard or a half-typed edit
            any more than switching tabs does. */}
        <aside
          className="cf-vtt-panel"
          aria-label={panelLabel}
          data-testid="encounter-vtt-panel"
          hidden={!panelOpen}
        >
            <div className="cf-vtt-panel-tabs" role="tablist" aria-label={panelLabel}>
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`cf-vtt-tab-${tab.id}`}
                  className="cf-vtt-tab"
                  data-testid={`encounter-vtt-tab-${tab.id}`}
                  aria-selected={tab.id === activeTabId}
                  // Every panel is in the document (see `VttPanelSection`), so every tab
                  // can point at a real element.
                  aria-controls={`cf-vtt-tabpanel-${tab.id}`}
                  tabIndex={tab.id === activeTabId ? 0 : -1}
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                    event.preventDefault();
                    const index = tabs.findIndex((candidate) => candidate.id === activeTabId);
                    // Arrow keys are DIRECTIONAL, not positional: this tablist is a flex row,
                    // so in an RTL locale (the app ships Arabic) the tabs paint right-to-left
                    // and a fixed `+1` for ArrowRight would walk focus visually leftwards.
                    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
                    const forward = event.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
                    const next = forward ? index + 1 : index - 1;
                    const target = tabs[(next + tabs.length) % tabs.length];
                    if (target) {
                      onSelectTab(target.id);
                      document.getElementById(`cf-vtt-tab-${target.id}`)?.focus();
                    }
                  }}
                >
                  {tab.label}
                  {tab.badge != null && <span className="cf-vtt-tab-badge">{tab.badge}</span>}
                </button>
              ))}
              <div className="cf-vtt-header-spacer" />
              <button
                type="button"
                ref={closeButtonRef}
                className="cf-vtt-panel-close"
                data-testid="encounter-vtt-panel-close"
                aria-label={t('encounters.vtt.hidePanel')}
                aria-expanded
                title={t('encounters.vtt.hidePanel')}
                onClick={() => {
                  pendingFocusRef.current = 'closed';
                  onPanelOpenChange(false);
                }}
              >
                <span aria-hidden>›</span>
              </button>
          </div>
          {/* Scroll container only — each `VttPanelSection` inside is its own tabpanel. */}
          <div className="cf-vtt-panel-body" ref={panelBodyRef} onScroll={onPanelBodyScroll}>
            {panelSlot}
          </div>
        </aside>
      </div>

      {children}
    </div>
  );
}

/**
 * One tab's panel. Always mounted; hidden when it is not the selected tab.
 *
 * Unmounting on a tab change looked like the tidy thing to do and was wrong three
 * separate times, because a panel is not just a view — it is wherever some component
 * happens to keep state that has to outlive a click:
 *
 *  - `ResourceTrackerPanel` (Table) holds the issue #1902 ambiguous-write guard —
 *    `pendingKeys`, `stuckKeysRef` and a 5s recovery interval whose whole job is to
 *    stop a resource being spent twice when a write's response was lost. Losing it
 *    mid-flight re-enables the control against unreconciled state.
 *  - `CombatantRow` (Party) holds `editingIdentity`, `nameDraft` and `conditionDraft`,
 *    which are committed only by an explicit action. Remounting silently discards a
 *    DM's half-typed rename.
 *  - `SharedDiceLog` (behind the Roll tray) holds the app's only live roll-event
 *    subscriber.
 *
 * The old page kept all of this mounted at once, so staying mounted costs what it
 * always cost. The rule is simply: layout does not get to decide what is still alive.
 *
 * The cost is in tests, not in the app: a hidden panel still matches `getByText`, so a
 * spec reaching for content that exists in more than one tab has to scope to the
 * visible one (`getByTestId('encounter-vtt-tabpanel-<id>')`) instead of `.first()`.
 */
export function VttPanelSection({
  id,
  activeTabId,
  children,
}: {
  id: string;
  activeTabId: string;
  children: ReactNode;
}) {
  const active = id === activeTabId;
  return (
    <div
      className="cf-vtt-panel-section"
      role="tabpanel"
      id={`cf-vtt-tabpanel-${id}`}
      aria-labelledby={`cf-vtt-tab-${id}`}
      data-testid={`encounter-vtt-tabpanel-${id}`}
      hidden={!active}
      tabIndex={active ? 0 : -1}
    >
      {children}
    </div>
  );
}

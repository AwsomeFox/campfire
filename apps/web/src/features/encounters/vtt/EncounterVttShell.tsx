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
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useImmersiveChromeInset } from './useImmersiveChromeInset';

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
function useDeepLinkedPanel(
  tabs: readonly VttTab[],
  activeTabId: string,
  onSelectTab: (id: string) => void,
): void {
  // Keyed on the router location, not just the tab list: this shell is reused across
  // encounter navigations, so following a second notification while the cockpit is
  // already mounted changes the pathname and hash but nothing else — an effect that
  // depended only on the (constant) tab ids would never run again for the new target.
  const location = useLocation();
  const onSelectRef = useRef(onSelectTab);
  onSelectRef.current = onSelectTab;
  const activeRef = useRef(activeTabId);
  activeRef.current = activeTabId;
  const tabIds = tabs.map((tab) => tab.id).join(',');

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    const resolve = () => {
      if (cancelled) return true;
      const hash = window.location.hash.slice(1);
      if (!hash) return true;
      const target = document.getElementById(hash);
      if (!target) return false;
      const section = target.closest<HTMLElement>('.cf-vtt-panel-section');
      const owner = section?.id?.replace('cf-vtt-tabpanel-', '');
      if (owner && owner !== activeRef.current && tabIds.split(',').includes(owner)) {
        onSelectRef.current(owner);
      }
      return true;
    };

    if (resolve()) return undefined;
    // ~5s of retries at 250ms: long enough for a comment list to arrive, short enough
    // that it cannot fight a tab the viewer picks in the meantime.
    const timer = window.setInterval(() => {
      attempts += 1;
      if (resolve() || attempts > 20) window.clearInterval(timer);
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tabIds, location.key, location.pathname, location.hash]);
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
  useEffect(() => {
    if (attentionKey && !panelOpenRef.current) onPanelOpenChangeRef.current(true);
  }, [attentionKey]);

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
  useDeepLinkedPanel(tabs, activeTabId, onSelectTab);

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
      <header className="cf-vtt-header">
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
                    const next = event.key === 'ArrowRight' ? index + 1 : index - 1;
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
          <div className="cf-vtt-panel-body">{panelSlot}</div>
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

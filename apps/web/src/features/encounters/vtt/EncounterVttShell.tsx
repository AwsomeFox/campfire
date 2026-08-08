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
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useImmersiveChromeInset } from './useImmersiveChromeInset';

export type VttTab = {
  id: string;
  label: string;
  /** Optional count/dot rendered after the label (e.g. unread log entries). */
  badge?: ReactNode;
  /**
   * This tab's panel stays in the document while another tab is showing (hidden, not
   * unmounted) because something inside it owns state that must outlive a tab click.
   * Mirrors `VttPanelSection`'s own `keepMounted` — the shell needs it here so a tab
   * only advertises `aria-controls` for a panel that is actually present.
   */
  keepMounted?: boolean;
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
  /** Dialogs, snackbars and other portaled-in-place overlays. */
  children?: ReactNode;
  /** Extra classes for the root (print hooks live here). */
  className?: string;
  /** Spread onto the root — RunSessionPage passes its entity-target props. */
  rootProps?: Record<string, unknown>;
};

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
  children,
  className,
  rootProps,
}: Props) {
  const { t } = useTranslation();
  const panelLabel = t('encounters.vtt.panelLabel');

  // Layout mounts the safety hold and check-request prompts outside the routed page so
  // they reach every campaign route. This shell would paint over both, so it publishes
  // how far down they reach and insets its own top by it — see the hook's doc.
  useImmersiveChromeInset();

  // The shell is `position: fixed` and owns the viewport, so a scrollable body
  // behind it only produces rubber-banding on touch. Restored on unmount so
  // navigating away from the encounter leaves the rest of the app scrollable.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('cf-vtt-locked');
    return () => root.classList.remove('cf-vtt-locked');
  }, []);

  return (
    <div className={`cf-vtt${className ? ` ${className}` : ''}`} {...rootProps}>
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
              className="cf-vtt-panel-reopen"
              data-testid="encounter-vtt-panel-open"
              aria-label={t('encounters.vtt.showPanel')}
              aria-expanded={false}
              title={t('encounters.vtt.showPanel')}
              onClick={() => onPanelOpenChange(true)}
            >
              <span aria-hidden>‹</span>
            </button>
          )}
        </div>

        {panelOpen && (
          <aside className="cf-vtt-panel" aria-label={panelLabel} data-testid="encounter-vtt-panel">
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
                  // Only advertise a panel that is really in the document: a reference to
                  // a missing id is worse for assistive tech than none at all. Panels are
                  // present when selected, and `keepMounted` ones are present always.
                  aria-controls={
                    tab.id === activeTabId || tab.keepMounted ? `cf-vtt-tabpanel-${tab.id}` : undefined
                  }
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
                className="cf-vtt-panel-close"
                data-testid="encounter-vtt-panel-close"
                aria-label={t('encounters.vtt.hidePanel')}
                aria-expanded
                title={t('encounters.vtt.hidePanel')}
                onClick={() => onPanelOpenChange(false)}
              >
                <span aria-hidden>›</span>
              </button>
            </div>
            {/* Scroll container only — each `VttPanelSection` inside is its own tabpanel. */}
            <div className="cf-vtt-panel-body">{panelSlot}</div>
          </aside>
        )}
      </div>

      {children}
    </div>
  );
}

/**
 * One tab's panel.
 *
 * `keepMounted` is the important knob. A panel that only renders things is fine to
 * unmount when you switch away — and unmounting keeps the DOM honest, since a hidden
 * copy of the roster still matches a `getByText(...)` and still costs its queries.
 *
 * But a panel whose contents own state that must OUTLIVE a tab click has to stay. The
 * Table tab is the case in point: `ResourceTrackerPanel` carries the ambiguous-write
 * guard from issue #1902 — `pendingKeys`, `stuckKeysRef` and a 5s recovery interval
 * whose whole job is to stop a resource being spent twice when a write's response was
 * lost. Unmounting it mid-flight dropped the guard and came back with empty state and
 * the control re-enabled, i.e. a double spend. Same reasoning keeps the shared dice log
 * mounted behind the Roll tray: it owns the app's only live roll-event subscriber.
 *
 * So: add `keepMounted` when you put something with in-flight or reconciliation state
 * into a tab. It is not a performance dial.
 */
export function VttPanelSection({
  id,
  activeTabId,
  keepMounted = false,
  children,
}: {
  id: string;
  activeTabId: string;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const active = id === activeTabId;
  if (!active && !keepMounted) return null;
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

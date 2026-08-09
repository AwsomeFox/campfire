/**
 * Ask the encounter cockpit to reveal whatever panel owns an element.
 *
 * The cockpit keeps every panel mounted and merely hides the ones that are not the
 * selected tab, and the whole side panel can also be collapsed. So an element can be in
 * the document, focusable by id, and still invisible for two independent reasons —
 * `scrollIntoView()` and `focus()` reveal neither. Anything that jumps to a panel-owned
 * element (a map token's condition badge, a comment deep link) has to say "show this"
 * first.
 *
 * A DOM event rather than a context: the callers are scattered (BattleMap is deep in the
 * map tree, the deep-link resolver is in the shell itself) and none of them otherwise
 * needs to know the cockpit exists. Outside the cockpit nothing listens and this is a
 * no-op, which is exactly right for the same components on the cast projection.
 */
export const REVEAL_COCKPIT_PANEL_EVENT = 'cf:cockpit-reveal-panel';

export type RevealCockpitPanelDetail = { elementId: string };

/**
 * Reveal the panel owning `elementId`, then run `then` on the next frame — by which
 * point React has committed the tab change, so focus and scrolling land on something
 * actually visible.
 */
export function revealCockpitPanel(elementId: string, then?: () => void): void {
  window.dispatchEvent(
    new CustomEvent<RevealCockpitPanelDetail>(REVEAL_COCKPIT_PANEL_EVENT, {
      detail: { elementId },
    }),
  );
  if (then) requestAnimationFrame(then);
}

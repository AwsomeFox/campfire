/**
 * Viewport-anchored placement for the TermHelp panel (issue #518).
 *
 * Kept out of TermHelp.tsx so it is unit-testable without a DOM: the panel is
 * `position: fixed` (see index.css) because several hosts clip absolutely
 * positioned children — most importantly the desktop sidebar `<aside>`, which
 * is `w-[230px]` and `overflow-x-hidden` and used to cut a 280px panel in half.
 * Fixed boxes are laid out against the viewport, so all this module has to do
 * is anchor to the trigger and clamp the result back inside it.
 */

export const TERM_HELP_PANEL_GAP = 6;
export const TERM_HELP_VIEWPORT_MARGIN = 12;

/** The subset of DOMRect this module needs, so tests can pass plain objects. */
export type Rect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type Viewport = { width: number; height: number };

export type TermHelpPanelPosition = {
  top: number;
  left: number;
  maxHeight: number;
};

export function fitTermHelpPanel(
  trigger: Rect,
  panel: Rect,
  align: 'start' | 'end',
  viewport: Viewport,
): TermHelpPanelPosition {
  const margin = TERM_HELP_VIEWPORT_MARGIN;
  const gap = TERM_HELP_PANEL_GAP;

  const preferredLeft = align === 'end' ? trigger.right - panel.width : trigger.left;
  const maxLeft = Math.max(margin, viewport.width - margin - panel.width);
  const left = Math.min(Math.max(preferredLeft, margin), maxLeft);

  const spaceBelow = viewport.height - trigger.bottom - gap - margin;
  const spaceAbove = trigger.top - gap - margin;
  // Prefer below; flip above only when the panel does not fit below AND there
  // is genuinely more room above.
  const below = panel.height <= spaceBelow || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(0, below ? spaceBelow : spaceAbove);
  const renderedHeight = Math.min(panel.height, maxHeight);
  const top = below
    ? Math.max(margin, trigger.bottom + gap)
    : Math.max(margin, trigger.top - gap - renderedHeight);

  return { top, left, maxHeight };
}

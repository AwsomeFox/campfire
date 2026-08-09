/**
 * Keep Layout's campaign-wide interrupts on screen above an immersive surface.
 *
 * `Layout.tsx` mounts the participant safety hold (`SafetyHoldBar`, issue #599) and
 * the player check-request prompts (issue #415) once, outside the routed page, so
 * they are present on EVERY campaign route rather than only where an author
 * remembered them. The encounter cockpit is `position: fixed; inset: 0` with an
 * opaque background, so without this it painted straight over both: an active hold
 * was invisible, and neither the "pause the table" control nor a delivered check
 * prompt could be clicked while combat was on screen.
 *
 * Rather than re-mounting those components inside the cockpit (two live queries, two
 * `role="status"` regions, and a safety control that disappears if the page below it
 * throws), this measures how far down the viewport that chrome reaches and publishes
 * it as `--cf-immersive-chrome-inset`. The cockpit's `top` consumes it, so the chrome
 * keeps its single mount, its normal flow, and its own hit-testing.
 *
 * Same shape as `useUndoSnackbarChrome`: measured in a layout effect so the first
 * painted frame is already inset, observers coalesced onto one rAF tick, and the
 * variable removed on unmount so every other route is untouched.
 */
import { useLayoutEffect } from 'react';
import { MAIN_CONTENT_ID } from '../../../app/routeFocus';

const INSET_VAR = '--cf-immersive-chrome-inset';

/**
 * Campaign-wide chrome the cockpit must not cover. Both are optional: the safety bar
 * is absent outside a campaign, and the prompts element unmounts whenever the viewer
 * has no pending request.
 */
const CHROME_SELECTORS = ['[data-testid="safety-bar"]', '[data-testid="check-request-prompts"]'];

function visibleBottomPx(element: Element): number {
  if (!(element instanceof HTMLElement)) return 0;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return 0;
  const rect = element.getBoundingClientRect();
  if (rect.height === 0) return 0;
  return rect.bottom;
}

/**
 * How far down the viewport Layout's chrome reaches. Deliberately the BOTTOM edge, not
 * a sum of heights: anything Layout stacks above these (the sticky mobile header) is
 * then accounted for without this hook having to know about it.
 */
export function measureImmersiveChromeInsetPx(): number {
  let bottom = 0;
  for (const selector of CHROME_SELECTORS) {
    const element = document.querySelector(selector);
    if (element) bottom = Math.max(bottom, visibleBottomPx(element));
  }
  return Math.max(0, Math.ceil(bottom));
}

export function useImmersiveChromeInset(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;

    // Land at the top before anything is measured or locked. SPA navigation preserves
    // `window.scrollY` and route focus restores focus with `preventScroll`, so arriving
    // from a scrolled page could leave Layout's chrome entirely ABOVE the viewport — its
    // `rect.bottom` negative, the measured inset therefore 0, and the safety hold
    // unreachable behind a cockpit that has stopped the page scrolling. Nothing is lost
    // by resetting: this surface owns the viewport and does not scroll.
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);

    let frame = 0;
    let published = -1;

    const publish = () => {
      frame = 0;
      const inset = measureImmersiveChromeInsetPx();
      if (inset === published) return;
      published = inset;
      root.style.setProperty(INSET_VAR, `${inset}px`);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(publish);
    };

    publish();

    // Two different changes have to re-publish, and they need different observers.
    //
    // SIZE: the safety bar grows when a hold is raised (an idle row becomes a banner).
    // PRESENCE: the check-request prompts element mounts and unmounts with the viewer's
    // queue. A ResizeObserver on `<main>` does not see that — Layout gives it `flex-1`,
    // so its height is set by the flex column, not by its content, and never moves when a
    // child appears. So presence is watched with a childList MutationObserver on the two
    // parents Layout mounts this chrome into: the prompts inside `<main>`, the safety bar
    // as its sibling just above.
    const observer = new ResizeObserver(schedule);
    const syncObservedTargets = () => {
      observer.disconnect();
      for (const selector of CHROME_SELECTORS) {
        const element = document.querySelector(selector);
        if (element) observer.observe(element);
      }
    };
    syncObservedTargets();

    const mutations = new MutationObserver(() => {
      syncObservedTargets();
      schedule();
    });
    const main = document.getElementById(MAIN_CONTENT_ID);
    if (main) mutations.observe(main, { childList: true });
    if (main?.parentElement) mutations.observe(main.parentElement, { childList: true });
    window.addEventListener('resize', schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      root.style.removeProperty(INSET_VAR);
    };
  }, []);
}

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
 * How much height the two scrolling chrome regions may share, in px.
 *
 * Sized from what is actually left rather than from assumed vh: whatever Layout stacks
 * ABOVE this chrome (its sticky mobile header is ~51px) eats into the same space, and a
 * fixed `18vh + 22vh` pair ignored it — at 667x320 landscape those caps plus that header
 * reach ~179px against a 160px clamp, so the cockpit covered the bottom of the prompt
 * scroller. Measuring the chrome's own distance from the top of the viewport accounts for
 * everything above it without this hook having to know what that is.
 */
const CAP_VAR = '--cf-immersive-chrome-cap';
/**
 * Set on `<html>` when Layout's chrome above the cockpit wants more room than the cockpit
 * can cede. Beyond that line the fixed, scroll-locked cockpit would simply cover whatever
 * did not fit, with no way to reach it — so the surface stops being fixed and the page
 * scrolls instead. A deliberately rare escape hatch: it takes a viewport short enough
 * (~320px) that Layout's header and banners alone fill the whole budget.
 */
const OVERFLOW_CLASS = 'cf-vtt-chrome-overflow';
/**
 * The cockpit keeps at least this much of the viewport for itself; everything above it may
 * have the rest. Matches `.cf-vtt`'s own clamp, and the two must stay in step — the cockpit
 * applies that clamp to its `top` regardless of what this hook publishes, so a cap derived
 * from a different budget is a cap it will not honour.
 *
 * A floor on the cockpit rather than a share of the viewport, because a share is the wrong
 * shape on a tall screen: half of a 900px viewport needlessly refuses chrome that would
 * fit comfortably. Taken as whichever of the two is MORE generous, so the short-viewport
 * case does not regress — at 400px tall the old half-viewport rule is still the kinder
 * one, and Layout's own header and banners (which no cap of ours reaches) get the benefit.
 */
const MIN_COCKPIT_HEIGHT_PX = 240;
const CHROME_BUDGET_RATIO = 0.5;

/**
 * Campaign-wide chrome the cockpit must not cover. Both are optional: the safety bar
 * is absent outside a campaign, and the prompts element unmounts whenever the viewer
 * has no pending request.
 */
const CHROME_SELECTORS = ['[data-testid="safety-bar"]', '[data-testid="check-request-prompts"]'];

/**
 * Document-relative, not viewport-relative.
 *
 * While the escape hatch is up the page scrolls, and a viewer who scrolls down to the
 * cockpit would otherwise make this chrome measure as shifted upward — or off-screen
 * entirely, i.e. negative — so the next resize or mutation would conclude the chrome had
 * shrunk, drop the hatch, and re-lock the page at a nonzero offset with that chrome
 * stranded above an opaque fixed surface. While the hatch is DOWN the page is locked at
 * the top, so `scrollY` is 0 and this is identical to the viewport-relative reading.
 */
function documentTopPx(rect: DOMRect): number {
  return rect.top + window.scrollY;
}

function visibleBottomPx(element: Element): number {
  if (!(element instanceof HTMLElement)) return 0;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return 0;
  const rect = element.getBoundingClientRect();
  if (rect.height === 0) return 0;
  return rect.bottom + window.scrollY;
}

/**
 * How far down the viewport Layout's chrome reaches. Deliberately the BOTTOM edge, not
 * a sum of heights: anything Layout stacks above these (the sticky mobile header) is
 * then accounted for without this hook having to know about it.
 */
export function measureImmersiveChromeInsetPx(): number {
  // Baseline: the top of Layout's `<main>`, which is exactly "everything Layout renders
  // above the routed page" — its sticky mobile header, the offline/stale/archived banners,
  // all of it. Both chrome selectors above are OPTIONAL (`SafetyHoldBar` renders nothing
  // while its read is unresolved or failed, and the prompts are absent with an empty
  // queue), so anchoring only on them measured 0 in a state an offline cached encounter
  // can sit in indefinitely — and the cockpit then started at the viewport top and covered
  // that chrome with the page scroll-locked.
  const main = document.getElementById(MAIN_CONTENT_ID);
  let bottom = main instanceof HTMLElement ? Math.max(0, documentTopPx(main.getBoundingClientRect())) : 0;
  for (const selector of CHROME_SELECTORS) {
    const element = document.querySelector(selector);
    if (element) bottom = Math.max(bottom, visibleBottomPx(element));
  }
  return Math.max(0, Math.ceil(bottom));
}

/**
 * The height the chrome regions may share, given whatever Layout has already placed above
 * them. Derived from the topmost chrome element's own offset, so a sticky mobile header —
 * or anything else added there later — is accounted for without naming it.
 */
export function measureImmersiveChromeCapPx(): number {
  const main = document.getElementById(MAIN_CONTENT_ID);
  // Same anchor as the inset: `<main>`'s top is what Layout has already used up, whether
  // or not either optional chrome element happens to be mounted right now.
  let top = main instanceof HTMLElement ? documentTopPx(main.getBoundingClientRect()) : Number.POSITIVE_INFINITY;
  for (const selector of CHROME_SELECTORS) {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    top = Math.min(top, documentTopPx(element.getBoundingClientRect()));
  }
  const above = Number.isFinite(top) ? Math.max(0, top) : 0;
  const budget = Math.max(window.innerHeight * CHROME_BUDGET_RATIO, window.innerHeight - MIN_COCKPIT_HEIGHT_PX);
  // Exactly what is left under the cockpit's own clamp, which `.cf-vtt` applies to
  // its `top` regardless of what this returns — so any floor added here is a floor the
  // cockpit will not honour. There used to be a 72px one, on the reasoning that a
  // scroller too short to show a row helps nobody; but once Layout's own header and
  // wrapped banners push `above` within 72px of the budget, that floor let a pending
  // check prompt extend PAST the clamp, where the scroll-locked cockpit covered its
  // lower controls — the precise failure this hook exists to prevent. Unreachable is
  // worse than short, so the honest answer is however little remains.
  return Math.max(0, Math.floor(budget - above));
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

    let publishedCap = -1;
    const publish = () => {
      frame = 0;
      const cap = measureImmersiveChromeCapPx();
      if (cap !== publishedCap) {
        publishedCap = cap;
        root.style.setProperty(CAP_VAR, `${cap}px`);
      }
      const inset = measureImmersiveChromeInsetPx();
      // The clamp `.cf-vtt` applies to its own `top`, in the same terms — when the chrome
      // wants more than this, something has to give, and covering it is the one answer
      // that leaves it unreachable on a locked page.
      const ceded = Math.max(
        window.innerHeight * CHROME_BUDGET_RATIO,
        window.innerHeight - MIN_COCKPIT_HEIGHT_PX,
      );
      root.classList.toggle(OVERFLOW_CLASS, inset > ceded);
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
      // ...and everything Layout stacks ABOVE `<main>`, by position rather than by name.
      // The inset is measured from `<main>`'s top, so anything up there that grows PUSHES
      // that baseline down — and it can grow without either named element resizing. The
      // archived banner is the live case: `ArchivedProvenance` fills its text in
      // asynchronously, and on a narrow viewport that wraps to a second line. Nothing
      // else reports that, so the published inset stayed at its first-paint value and the
      // scroll-locked cockpit covered the bottom of the banner.
      const main = document.getElementById(MAIN_CONTENT_ID);
      let sibling = main?.previousElementSibling ?? null;
      while (sibling) {
        observer.observe(sibling);
        sibling = sibling.previousElementSibling;
      }
    };
    syncObservedTargets();

    const mutations = new MutationObserver(() => {
      // Re-sync as well as re-measure: a banner that has only just mounted is a NEW
      // element to watch, not merely a new measurement.
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
      root.style.removeProperty(CAP_VAR);
      root.classList.remove(OVERFLOW_CLASS);
    };
  }, []);
}

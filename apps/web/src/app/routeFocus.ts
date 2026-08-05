/**
 * Skip-link target + route-change focus helpers (issue #591).
 *
 * Pure functions are unit-tested so e2e can stay thin; components call the
 * imperative helpers after navigation.
 */

import { API_READ_BUDGET } from '../lib/apiTimeouts';
import { SKELETON_TEST_IDS } from '../components/loadingSkeletonState';

/**
 * Marks `router.tsx`'s `lazyPage()` Suspense fallback (`SkeletonRoute` in ui.tsx) — the
 * one reliable, existing signal that a code-split route's own component has not yet
 * mounted. Used to anchor the recovery window to actual route readiness rather than a
 * flat multiple of navigation time (see `focusMainDestination`'s route-readiness check).
 */
const ROUTE_SKELETON_SELECTOR = `[data-testid="${SKELETON_TEST_IDS.route}"]`;

export const MAIN_CONTENT_ID = 'main-content';
export const SKIP_TO_MAIN_ID = 'skip-to-main';

export const APP_DOCUMENT_TITLE = 'Campfire';

let documentTitlePrefix: string | null = null;

function withoutDocumentTitlePrefix(title: string): string {
  return documentTitlePrefix && title.startsWith(documentTitlePrefix)
    ? title.slice(documentTitlePrefix.length)
    : title;
}

/**
 * Coordinates a transient document-title prefix with RouteChangeFocus. The
 * formatter below reapplies it whenever a route writes a fresh base title.
 */
export function setDocumentTitlePrefix(prefix: string | null): void {
  const current = typeof document === 'undefined' ? '' : withoutDocumentTitlePrefix(document.title);
  documentTitlePrefix = prefix;
  if (typeof document !== 'undefined') {
    document.title = prefix ? `${prefix}${current}` : current;
  }
}

/** Matches EntityDeepLinkFocus — deep-linked entity rows expose this hash. */
export const ENTITY_DEEP_LINK_HASH = /^#entity-[a-z_-]+-\d+$/;

export function isEntityDeepLinkHash(hash: string): boolean {
  return ENTITY_DEEP_LINK_HASH.test(hash);
}

/**
 * Whether RouteChangeFocus should move focus after navigation.
 * Compares pathnames and treats entity deep-link hashes as non-route changes.
 * Query-only updates are handled by RouteChangeFocus (effect deps omit `search`).
 */
export function shouldMoveFocusOnNavigation(
  previousPathname: string | null,
  nextPathname: string,
  nextHash: string,
): boolean {
  if (previousPathname === nextPathname) return false;
  if (isEntityDeepLinkHash(nextHash)) return false;
  return true;
}

export function isModalDialogOpen(doc: Document): boolean {
  return Boolean(doc.querySelector('[role="dialog"][aria-modal="true"]'));
}

const NATURALLY_FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

export function isNaturallyFocusable(el: HTMLElement): boolean {
  if (el.tagName === 'A') return el.hasAttribute('href') || el.tabIndex >= 0;
  if (NATURALLY_FOCUSABLE.has(el.tagName)) return true;
  return el.tabIndex >= 0;
}

/**
 * When a destination page already placed focus on a control inside `<main>` (e.g.
 * SearchPage autoFocus), route-change focus should not steal it. Body/main alone
 * still get the usual h1/main move.
 */
export function shouldPreserveFocusInsideMain(main: HTMLElement, doc: Document): boolean {
  const active = doc.activeElement;
  if (active == null || typeof active !== 'object') return false;
  if (typeof HTMLElement !== 'undefined' && !(active instanceof HTMLElement)) return false;
  const el = active as HTMLElement;
  if (el === doc.body || el === main) return false;
  return main.contains(el);
}

/** Prefer the page h1; fall back to the stable main landmark. */
export function mainFocusTarget(main: HTMLElement): HTMLElement {
  const h1 = main.querySelector('h1');
  if (h1 instanceof HTMLElement) return h1;
  return main;
}

export function normalizePageTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function pageTitleFromMain(main: HTMLElement): string | null {
  const h1 = main.querySelector('h1');
  if (!(h1 instanceof HTMLElement)) return null;
  const title = normalizePageTitle(h1.textContent ?? '');
  return title || null;
}

const PATH_SEGMENT_TITLES: Record<string, string> = {
  quests: 'Quests',
  locations: 'World',
  npcs: 'NPCs',
  factions: 'Factions',
  party: 'Party',
  inventory: 'Inventory',
  sessions: 'Sessions',
  timeline: 'Timeline',
  'session-zero': 'Session Zero',
  encounters: 'Encounters',
  table: 'Table',
  compendium: 'Compendium',
  notes: 'My Notes',
  proposals: 'Proposals',
  storylines: 'Storylines',
  settings: 'Settings',
  inbox: 'Scribe inbox',
  trash: 'Trash',
  members: 'Members',
  audit: 'Audit log',
  search: 'Search',
  preferences: 'Preferences',
  tokens: 'API tokens',
  credits: 'Credits & attributions',
  admin: 'Server admin',
  users: 'Users',
  rules: 'Rule packs',
  ai: 'AI console',
  auth: 'Auth',
  storage: 'Storage',
  new: 'New',
};

/** Title fallback when the route has not painted an h1 yet (or never will). */
export function fallbackPageTitle(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/') return 'Campaigns';

  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] === 'c' && parts.length === 2) return 'Dashboard';
  if (parts[0] === 'admin' && parts.length === 1) return 'Server admin';

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i];
    if (/^\d+$/.test(segment)) continue;
    const mapped = PATH_SEGMENT_TITLES[segment];
    if (mapped) return mapped;
  }

  return APP_DOCUMENT_TITLE;
}

/**
 * Issue #1711: `page` here is usually a section label ("Party", "Quests") distinct
 * from the campaign name, so `formatDocumentTitle` used to always append
 * `campaignName` as its own segment. The Dashboard is the one route where that
 * assumption breaks — its real h1 (`StatusHeader`) IS the campaign name, since
 * `pageTitleFromMain` reads it verbatim once the Dashboard got a real h1 to fix
 * #1711's a11y gap. Without this dedupe, `pageTitle === campaignName` there
 * produced a doubled title ("Cinderhaven · Cinderhaven · Campfire"). Dropping the
 * redundant segment when they match reads correctly for the Dashboard AND leaves
 * every other route's title byte-for-byte unchanged (their page label never equals
 * the campaign name).
 */
export function formatDocumentTitle(opts: { page: string; campaignName?: string | null }): string {
  const page = normalizePageTitle(opts.page) || APP_DOCUMENT_TITLE;
  const parts = [page];
  const campaignName = opts.campaignName ? normalizePageTitle(opts.campaignName) : null;
  if (campaignName && campaignName !== page) parts.push(campaignName);
  if (page !== APP_DOCUMENT_TITLE) parts.push(APP_DOCUMENT_TITLE);
  const title = parts.join(' · ');
  return documentTitlePrefix ? `${documentTitlePrefix}${title}` : title;
}

export function focusProgrammatically(el: HTMLElement): void {
  if (!isNaturallyFocusable(el)) {
    el.tabIndex = -1;
  }
  el.focus({ preventScroll: true });
}

/** Skip link href targets #main-content — focus that landmark, not the page h1. */
export function focusSkipDestination(main: HTMLElement): void {
  focusProgrammatically(main);
}

export type FocusMainOptions = {
  /** Called when a page title is resolved (from h1 or fallback). */
  onPageTitle?: (pageTitle: string) => void;
  fallbackPageTitle?: string;
  /** Skip when a modal dialog owns focus management. */
  skipWhenModalOpen?: boolean;
  /**
   * When false, only resolve/publish the page title (MutationObserver for async h1)
   * without moving keyboard focus. Used for entity deep-links where EntityDeepLinkFocus
   * owns focus (issue #591 / Copilot).
   */
  moveFocus?: boolean;
  /**
   * Overrides `FALLBACK_UPGRADE_GRACE_MS` for this call (the recovery window arms for
   * double this — see its arm site in `settleOnTarget`). Test-only: `RouteChangeFocus`
   * threads this from a gated e2e bridge so `route-focus-slow-heading.spec.ts` can
   * exercise the recovery-window boundary in milliseconds. A flat multi-second
   * production constant that can only be exercised by actually waiting it out is
   * effectively untested in CI, which is how the boundary would silently rot later
   * (review finding: coordinator).
   */
  graceMs?: number;
};

/**
 * How long a late h1 may still claim focus after the fallback settles on `<main>`.
 *
 * This is not an arbitrary guess: it is `API_READ_BUDGET.overallMs` (apiTimeouts.ts),
 * the app's own cap on how long a *successful* GET is allowed to take end-to-end. A
 * route's heading depends on a read (e.g. the Dashboard's `/campaigns/:id/summary`)
 * that starts at roughly the same moment the fallback settles, so any read that is
 * going to succeed at all must resolve within this same budget — a heading arriving
 * at 25s on a slow-but-supported connection is exactly the case this fix exists for,
 * not an edge case to exclude (review finding: P2 codex on routeFocus.ts). Deriving
 * from the read budget instead of a separate constant also means the two cannot drift
 * apart if the app's read timeouts ever change.
 *
 * A window this long is only safe because of the user-takeover tracking below: the
 * observer never moves focus once the user has interacted (a focus change, a click,
 * a scroll, or a non-focus-moving key), so an extended window only ever acts on a page
 * the user has genuinely not touched yet — which is exactly when moving focus to the
 * heading is correct. The hard teardown at the end of the window is unconditional
 * either way, so a route that never renders an h1 still stops observing once the
 * window closes (review findings: Devin, Copilot on routeFocus.ts).
 */
export const FALLBACK_UPGRADE_GRACE_MS = API_READ_BUDGET.overallMs;

/**
 * Focus the main destination (h1 or main) without scrolling the viewport.
 * Waits briefly for async h1 text via MutationObserver, mirroring EntityDeepLinkFocus.
 */
export function focusMainDestination(main: HTMLElement, opts: FocusMainOptions = {}): () => void {
  const modalBlocksFocus =
    opts.skipWhenModalOpen !== false && isModalDialogOpen(document);
  const moveFocus = !modalBlocksFocus && opts.moveFocus !== false;
  // `opts.graceMs` overrides the base window (see below); production default is
  // `FALLBACK_UPGRADE_GRACE_MS`.
  const graceMs = opts.graceMs ?? FALLBACK_UPGRADE_GRACE_MS;
  // The recovery window is armed for double this, not `graceMs` itself — see
  // `fallbackGraceTimeout`'s arm site in `settleOnTarget` for why.
  const graceWindowMs = graceMs * 2;
  let observer: MutationObserver | null = null;
  const frames = new Set<number>();
  let timeout = 0;
  let settled = false;
  // True only when `settled` was reached via the "give up on the h1" fallback (focusing
  // `main` itself), never when a real h1 was found. A slow async page (e.g. the Dashboard,
  // which renders nothing — no h1 — until its campaign summary fetch resolves) can lose the
  // ~2-animation-frame race below on a loaded/slow runner even though its real h1 arrives
  // only a little later: the observer used to stop mattering the instant it settled on the
  // fallback, so focus stayed on `main` forever even after the real h1 showed up (issue #591
  // regression — the h1 element itself was present and stable, just never focused). This
  // flag keeps the fallback recoverable, but only within a bounded window (below) and only
  // while the fallback focus has not itself been overtaken by the user.
  let settledOnMainFallback = false;
  let fallbackGraceTimeout = 0;
  // Guards the fallback-recovery `focusin` listener against the focus calls this closure
  // makes on its own behalf, so only genuine user-driven focus changes are treated as
  // "the user took over" (review finding: P2 codex on routeFocus.ts — a skip-link
  // reactivation onto the same `<main>` landmark must not be mistaken for the untouched
  // fallback and then overridden by a later h1).
  let expectingOwnFocus = false;
  let fallbackListenersInstalled = false;
  // Set between scheduling the deferred upgrade and that frame running, so a second
  // observer fire in the gap cannot queue a duplicate focus move.
  let upgradeScheduled = false;
  // Whether `main` currently contains the route-level Suspense fallback — see
  // `checkRouteReadiness`.
  let routeSkeletonPresent = false;

  const cancelFrames = () => {
    for (const id of frames) window.cancelAnimationFrame(id);
    frames.clear();
  };

  const focusOwned = (el: HTMLElement) => {
    expectingOwnFocus = true;
    focusProgrammatically(el);
    expectingOwnFocus = false;
  };

  // Any focus change or pointer interaction that this closure did not itself cause means
  // the user has moved on from the untouched fallback — a skip-link activation, a click, or
  // a tab all land here. Once that happens the late h1 must never steal focus back.
  const handleUserTookOver = () => {
    if (expectingOwnFocus) return;
    teardownFallbackWatch();
  };

  // Keys that a keyboard user presses to interact with the current landmark without ever
  // moving DOM focus off it (scrolling, paging, activating a non-link control) — none of
  // these reach `handleUserTookOver` via `focusin`, so `document.activeElement` would still
  // read as `main` when the late h1 arrives (review finding: P2 codex). `Tab`/`Shift+Tab`
  // are deliberately excluded: they DO move focus and are already covered by the `focusin`
  // listener above, so treating them here too would be redundant, not incorrect.
  const FALLBACK_TAKEOVER_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    ' ',
  ]);

  const handleUserKeydown = (event: KeyboardEvent) => {
    if (!FALLBACK_TAKEOVER_KEYS.has(event.key)) return;
    teardownFallbackWatch();
  };

  const installFallbackWatchListeners = () => {
    if (fallbackListenersInstalled) return;
    fallbackListenersInstalled = true;
    document.addEventListener('focusin', handleUserTookOver, true);
    document.addEventListener('pointerdown', handleUserTookOver, true);
    document.addEventListener('keydown', handleUserKeydown, true);
    // Mouse-wheel/trackpad scrolling moves neither DOM focus nor the pointer down, and
    // fires no listed key — but it is just as much the user interacting with the page as a
    // click or an arrow key (review finding: P2 codex). `passive: true` since this listener
    // never calls preventDefault and must not block the scroll it is observing.
    document.addEventListener('wheel', handleUserTookOver, { capture: true, passive: true });
  };

  const removeFallbackWatchListeners = () => {
    if (!fallbackListenersInstalled) return;
    fallbackListenersInstalled = false;
    document.removeEventListener('focusin', handleUserTookOver, true);
    document.removeEventListener('pointerdown', handleUserTookOver, true);
    document.removeEventListener('keydown', handleUserKeydown, true);
    document.removeEventListener('wheel', handleUserTookOver, true);
  };

  // Ends the late-h1 focus-recovery window: stops treating the fallback as recoverable and
  // stops listening for user interaction. Idempotent — called from whichever of "user took
  // over", "grace window elapsed", or "h1 arrived and was focused" happens first.
  //
  // Deliberately does NOT disconnect `observer`. The observer has a second job beyond focus
  // recovery — `publishTitle()` keeps `document.title` in sync with a late-arriving h1 (see
  // RouteChangeFocus.tsx's `onPageTitle`) — and that must keep working for the rest of the
  // route's lifetime even after focus recovery ends, whether because the user took over or
  // the window closed. Only genuine unmount/route-change (this function's own returned
  // cleanup) disconnects it (review finding: Devin — a user who so much as scrolls or clicks
  // before a slow heading renders would otherwise leave the tab title stuck on the path
  // fallback for the rest of the visit).
  const teardownFallbackWatch = () => {
    settledOnMainFallback = false;
    if (fallbackGraceTimeout) {
      window.clearTimeout(fallbackGraceTimeout);
      fallbackGraceTimeout = 0;
    }
    removeFallbackWatchListeners();
  };

  // Anchors the recovery window to actual route readiness rather than a flat multiple of
  // navigation time: `graceWindowMs` (double the read budget) covers the general case, but
  // a code-split route's chunk load is independently timed (`lazyPage` in router.tsx) and
  // not itself bounded by anything, so a slow-but-real chunk load ahead of the read can
  // still compound past a fixed multiple (review finding: P2 codex — e.g. a 35s chunk load
  // plus a 26s read outlives a flat 60s window). Rather than guessing a bigger fixed number,
  // detect the one reliable existing signal that the component actually mounted: the
  // route-level Suspense fallback (`SkeletonRoute`) leaving `<main>`. On that transition the
  // window re-arms for a fresh `graceMs` — the read budget itself — from *now*, since that
  // is genuinely when a request the component issues could have started. This can only
  // extend recovery while the flat `graceWindowMs` ceiling has not already elapsed (the
  // observer is disconnect-free but `settledOnMainFallback` already false stops any of this
  // from mattering past that point), so a route that never uses `SkeletonRoute` — or whose
  // chunk load itself somehow exceeds `graceWindowMs` — still falls back to the flat bound,
  // and a genuinely headless route keeps its hard teardown either way.
  const checkRouteReadiness = () => {
    const skeletonNow = Boolean(main.querySelector(ROUTE_SKELETON_SELECTOR));
    if (routeSkeletonPresent && !skeletonNow) {
      if (fallbackGraceTimeout) window.clearTimeout(fallbackGraceTimeout);
      fallbackGraceTimeout = window.setTimeout(teardownFallbackWatch, graceMs);
    }
    routeSkeletonPresent = skeletonNow;
  };

  const scheduleFrame = (cb: () => void) => {
    const id = window.requestAnimationFrame(() => {
      frames.delete(id);
      cb();
    });
    frames.add(id);
  };

  const publishTitle = () => {
    const fromDom = pageTitleFromMain(main);
    const page = fromDom ?? opts.fallbackPageTitle ?? fallbackPageTitle(window.location.pathname);
    opts.onPageTitle?.(page);
  };

  const settleOnTarget = (target: HTMLElement, isFallback = false) => {
    if (settled) {
      publishTitle();
      return;
    }
    settled = true;
    settledOnMainFallback = isFallback;
    publishTitle();
    if (moveFocus) {
      scheduleFrame(() => {
        if (shouldPreserveFocusInsideMain(main, document)) return;
        focusOwned(target);
      });
    }
    if (timeout) {
      window.clearTimeout(timeout);
      timeout = 0;
    }
    if (!isFallback) {
      observer?.disconnect();
      return;
    }
    // A fallback settle keeps the observer alive so a real h1 that arrives shortly afterward
    // can still take over focus — but only until the user acts on the page themselves (see
    // `handleUserTookOver`), or until the window elapses, whichever happens first.
    //
    // Armed for double `graceMs` up front, not `graceMs` itself: a route's component can be
    // code-split (`lazyPage` in router.tsx), so on a cold navigation the chunk download has to
    // finish before the component mounts and issues its own request at all — no mutation
    // happens inside `<main>` until then, so there is nothing to react to and extend a
    // shorter timer with. Arming for the full, still budget-derived `graceWindowMs` from the
    // start covers a slow chunk load ahead of the read without needing to observe any activity
    // first (review finding: P2 codex — a flat window armed only for the base grace period
    // cannot help here, since resetting on continued activity never gets a chance to fire).
    // `checkRouteReadiness` can extend this further, anchored to when the component actually
    // mounts, for the case where even double the base budget is not enough.
    installFallbackWatchListeners();
    routeSkeletonPresent = Boolean(main.querySelector(ROUTE_SKELETON_SELECTOR));
    fallbackGraceTimeout = window.setTimeout(teardownFallbackWatch, graceWindowMs);
  };

  const tryFocusHeading = (): boolean => {
    const h1 = main.querySelector('h1');
    if (!(h1 instanceof HTMLElement)) return false;
    settleOnTarget(h1);
    return true;
  };

  // If the fallback already settled on `main`, upgrade to the real h1 the instant one
  // appears — but only while the fallback focus is still untouched (bounded by the grace
  // window above, and never once the user has acted — see `handleUserTookOver`). That
  // guards the case `shouldPreserveFocusInsideMain` cannot: a skip-link activation lands
  // focus back on this exact same `<main>` element, so comparing `activeElement` alone
  // cannot distinguish it from the fallback state (review finding: P2 codex).
  const upgradeFromFallback = (): boolean => {
    if (!settledOnMainFallback) return false;
    // A dialog opening moves focus itself — it is not a user "takeover" under
    // `handleUserTookOver`'s predicate, but it is just as much a reason to stop: a heading
    // arriving after a dialog has already taken over the page is no longer a case worth
    // acting on, and the app-owned focus destination inside that dialog must never be
    // preempted (review finding: coordinator, following on P2 codex's grace-window widening —
    // a longer window makes this reachable in practice, not just in theory).
    if (isModalDialogOpen(document)) {
      teardownFallbackWatch();
      return true;
    }
    const h1 = main.querySelector('h1');
    if (!(h1 instanceof HTMLElement)) {
      checkRouteReadiness();
      return false;
    }
    if (!moveFocus) {
      teardownFallbackWatch();
      return true;
    }
    if (upgradeScheduled) return true;
    upgradeScheduled = true;
    // The takeover listeners stay installed across this frame on purpose. The focus
    // transfer is deferred, and a repeat ArrowDown/PageDown landing in the gap must
    // still cancel it — tearing down here would remove the listeners first and let the
    // scheduled callback steal focus from a keyboard user who is mid-scroll, since
    // `document.activeElement` is still `main` while they scroll (review finding: P2
    // codex). A takeover clears `settledOnMainFallback`, which the callback rechecks.
    scheduleFrame(() => {
      upgradeScheduled = false;
      if (!settledOnMainFallback) return;
      // Re-queried here rather than reusing the `h1` captured above: if the page swaps
      // the heading out in the gap between that capture and this frame running (an
      // unkeyed remount, a Suspense boundary resolving, a list re-render), the captured
      // node is now detached and `.focus()` on it is a silent no-op — focus would stay on
      // `main` with no further attempt ever made, since `teardownFallbackWatch()` below
      // has already cleared `settledOnMainFallback` by the time the replacement heading's
      // own mutation arrives (review finding: Devin).
      const target = main.querySelector('h1');
      if (!(target instanceof HTMLElement) || !target.isConnected) return;
      teardownFallbackWatch();
      if (document.activeElement !== main) return;
      if (shouldPreserveFocusInsideMain(main, document)) return;
      // Re-checked here, not only at entry: a dialog can open in the gap between this
      // frame being scheduled and it actually running, and that must cancel the transfer
      // just as reliably as a dialog that was already open when the mutation fired.
      if (isModalDialogOpen(document)) return;
      focusOwned(target);
    });
    return true;
  };

  // Always observe: an immediate empty h1 may gain text after async data loads.
  observer = new MutationObserver(() => {
    publishTitle();
    if (!settled) {
      void tryFocusHeading();
    } else {
      upgradeFromFallback();
    }
  });
  observer.observe(main, { childList: true, subtree: true, characterData: true });

  if (!tryFocusHeading()) {
    const focusMainIfStillHeadless = () => {
      if (settled || main.querySelector('h1')) return;
      if (moveFocus) {
        scheduleFrame(() => {
          if (shouldPreserveFocusInsideMain(main, document)) return;
          if (!main.querySelector('h1')) settleOnTarget(main, true);
        });
        return;
      }
      publishTitle();
    };

    // Many list screens have no h1 — do not leave focus on nav chrome for seconds.
    scheduleFrame(() => {
      scheduleFrame(focusMainIfStillHeadless);
    });

    timeout = window.setTimeout(() => {
      if (settled) return;
      if (main.querySelector('h1')) {
        tryFocusHeading();
        return;
      }
      settleOnTarget(main, true);
    }, 10_000);
  }

  return () => {
    observer?.disconnect();
    if (timeout) window.clearTimeout(timeout);
    if (fallbackGraceTimeout) window.clearTimeout(fallbackGraceTimeout);
    removeFallbackWatchListeners();
    cancelFrames();
  };
}

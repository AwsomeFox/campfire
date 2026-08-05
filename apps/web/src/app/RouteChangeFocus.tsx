import { useEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import {
  fallbackPageTitle,
  focusMainDestination,
  formatDocumentTitle,
  pageTitleFromMain,
  shouldMoveFocusOnNavigation,
} from './routeFocus';

type Props = {
  mainRef: RefObject<HTMLElement | null>;
  campaignName?: string | null;
};

/**
 * Playwright / automation bridge for `focusMainDestination`'s recovery-window
 * override (issue #591 / PR #1957 review). Namespaced under the same
 * `__CAMPFIRE_E2E__` symbol Announcer.tsx uses (issue #434) and attached only
 * under the same `navigator.webdriver` gate — never read in normal production
 * browsing. `route-focus-slow-heading.spec.ts` seeds `routeFocusGraceMs` via
 * `page.addInitScript` before navigating so it can exercise the recovery-window
 * boundary in milliseconds instead of waiting out the real multi-second budget.
 */
type CampfireE2EWindow = Window & {
  __CAMPFIRE_E2E__?: { routeFocusGraceMs?: number } | true;
};

function readRouteFocusGraceMsOverride(): number | undefined {
  const w = window as CampfireE2EWindow;
  if (!w.navigator?.webdriver) return undefined;
  const hooks = w.__CAMPFIRE_E2E__;
  if (typeof hooks !== 'object' || hooks == null) return undefined;
  return typeof hooks.routeFocusGraceMs === 'number' ? hooks.routeFocusGraceMs : undefined;
}

/**
 * Moves keyboard focus to the new page's h1 (or main) on pathname changes and
 * keeps document.title in sync. Query/hash-only updates are left to the page
 * (tabs, filters, EntityDeepLinkFocus, dialogs).
 */
export function RouteChangeFocus({ mainRef, campaignName = null }: Props) {
  const location = useLocation();
  const previousPathnameRef = useRef<string | null>(null);
  const campaignRef = useRef(campaignName);
  campaignRef.current = campaignName;

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;

    const previousPathname = previousPathnameRef.current;
    previousPathnameRef.current = location.pathname;

    // Pathname unchanged (query/hash-only) — leave title/focus to the page.
    if (previousPathname === location.pathname) return;

    const pathFallback = fallbackPageTitle(location.pathname);
    const onPageTitle = (pageTitle: string) => {
      document.title = formatDocumentTitle({
        page: pageTitle,
        campaignName: campaignRef.current,
      });
    };

    // Entity deep-links: EntityDeepLinkFocus owns keyboard focus, but we still
    // observe async h1 text so document.title does not stick on the path fallback.
    return focusMainDestination(main, {
      fallbackPageTitle: pathFallback,
      onPageTitle,
      moveFocus: shouldMoveFocusOnNavigation(
        previousPathname,
        location.pathname,
        location.hash,
      ),
      graceMs: readRouteFocusGraceMsOverride(),
    });
  }, [location.pathname, location.hash, mainRef]);

  // Campaign names resolve asynchronously from context; refresh the title once
  // the name is known without stealing focus from the page we just landed on.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const page =
      pageTitleFromMain(main) ?? fallbackPageTitle(location.pathname);
    document.title = formatDocumentTitle({
      page,
      campaignName: campaignRef.current,
    });
  }, [campaignName, location.pathname, mainRef]);

  return null;
}

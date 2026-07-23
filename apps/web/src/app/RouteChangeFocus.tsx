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

    if (!shouldMoveFocusOnNavigation(previousPathname, location.pathname, location.hash)) {
      return;
    }

    const pathFallback = fallbackPageTitle(location.pathname);
    return focusMainDestination(main, {
      fallbackPageTitle: pathFallback,
      onPageTitle: (pageTitle) => {
        document.title = formatDocumentTitle({
          page: pageTitle,
          campaignName: campaignRef.current,
        });
      },
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

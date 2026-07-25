import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { readListOriginScroll } from '../lib/detailListOrigin';
import { scrollBehavior } from '../lib/prefersReducedMotion';

/**
 * When a detail page returns via the in-app link, restore the list scroll offset that
 * was captured at navigation time. Browser Back uses history's own scroll restoration.
 */
export function useRestoreListOriginScroll() {
  const location = useLocation();
  const restored = useRef(false);

  useEffect(() => {
    restored.current = false;
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (restored.current) return;
    const scrollY = readListOriginScroll(location.state);
    if (scrollY == null) return;
    restored.current = true;
    const behavior = scrollBehavior();
    requestAnimationFrame(() => {
      window.scrollTo({ top: scrollY, behavior });
    });
  }, [location.state]);
}

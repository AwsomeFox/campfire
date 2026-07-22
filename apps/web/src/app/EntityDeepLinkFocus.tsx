import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const ENTITY_HASH = /^#entity-[a-z_-]+-\d+$/;

/**
 * Focus a deep-linked record after its async page data renders.
 *
 * Native hash scrolling runs before most feature queries finish. Observing the
 * app root makes direct loads, client navigation, and browser back/forward all
 * converge on the same keyboard-visible target without feature-specific timers.
 */
export function EntityDeepLinkFocus() {
  const location = useLocation();

  useEffect(() => {
    if (!ENTITY_HASH.test(location.hash)) return;
    const id = decodeURIComponent(location.hash.slice(1));
    let observer: MutationObserver | null = null;
    let frame = 0;
    let timeout = 0;

    const focus = () => {
      const target = document.getElementById(id);
      if (!target) return false;
      frame = window.requestAnimationFrame(() => {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
      observer?.disconnect();
      if (timeout) window.clearTimeout(timeout);
      return true;
    };

    if (!focus()) {
      observer = new MutationObserver(() => void focus());
      observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true });
      // Deleted/hidden records never render. Do not retain an app-wide observer
      // for the rest of the session when a stale external link is opened.
      timeout = window.setTimeout(() => observer?.disconnect(), 10_000);
    }

    return () => {
      observer?.disconnect();
      if (timeout) window.clearTimeout(timeout);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [location.key, location.pathname, location.search, location.hash]);

  return null;
}

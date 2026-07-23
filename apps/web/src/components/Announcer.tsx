/**
 * Announcer — a single app-root ARIA live region so dynamic changes reach
 * screen readers (issue #93). Nothing dynamic was announced before: dice
 * results, turn/round changes, and HP mutations were visual-only.
 *
 * Two visually-hidden live regions are mounted once at the app root:
 *  - polite   (aria-live="polite")   — roll results, turn changes, HP changes
 *  - assertive(role="alert")         — failures the user must notice now
 *
 * `useAnnounce()` returns `announce(message, { assertive })`. Consecutive
 * identical messages are re-announced (we blank the node for a frame first),
 * so e.g. two "1d20: 15" rolls in a row are both spoken.
 *
 * Because the provider outlives the router, announcement text can otherwise
 * linger into /login and the next account's session (issue #434). Callers that
 * tear down an identity or campaign scope use `useClearAnnouncements()`.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type AnnounceOptions = { assertive?: boolean };
type AnnounceFn = (message: string, options?: AnnounceOptions) => void;
type ClearFn = () => void;

const AnnounceContext = createContext<AnnounceFn>(() => {});
// Issue #506: sign-out on a shared device must not leave a stale live-region
// message (an HP change, a roll result, an unread count…) sitting in the DOM
// for the next person at the keyboard to stumble onto in browse mode. Exposed
// separately from `announce` so callers that only need "wipe it" (logout)
// don't have to reach for a message string.
const ClearContext = createContext<ClearFn>(() => {});

// Module-level clear for callers outside AnnounceProvider's React tree
// (AuthProvider.handleMultiTabSignOut sits ABOVE AnnounceProvider in App.tsx).
let clearLiveRegionImpl: ClearFn = () => {};

/** Wipe polite/assertive live-region text. Safe no-op before provider mount. */
export function clearLiveAnnouncements(): void {
  clearLiveRegionImpl();
}

/**
 * Playwright / automation bridge (issue #434). Namespaced under one symbol and
 * attached only when automation is detected (`navigator.webdriver`) or an
 * explicit `__CAMPFIRE_E2E__` flag/object is already present — never in normal
 * production browsing. Specs seed React announcer state via
 * `window.__CAMPFIRE_E2E__.announce` without mutating shared fixtures.
 */
type CampfireE2EHooks = {
  announce?: AnnounceFn;
  clearAnnouncements?: ClearFn;
};

type CampfireE2EWindow = Window & {
  __CAMPFIRE_E2E__?: CampfireE2EHooks | true;
};

function shouldAttachE2EBridge(w: CampfireE2EWindow): boolean {
  if (typeof navigator !== 'undefined' && Boolean(navigator.webdriver)) return true;
  return w.__CAMPFIRE_E2E__ != null;
}

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  // Separate frames per region — a single shared raf would let an assertive
  // announce cancel a polite one scheduled in the same tick (and vice versa).
  const politeRafRef = useRef<number | null>(null);
  const assertiveRafRef = useRef<number | null>(null);

  const announce = useCallback<AnnounceFn>((message, options) => {
    const assertive = Boolean(options?.assertive);
    const setter = assertive ? setAssertive : setPolite;
    const rafRef = assertive ? assertiveRafRef : politeRafRef;
    // Clear first so an identical consecutive message still triggers the SR.
    setter('');
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setter(message);
    });
  }, []);

  const clear = useCallback<ClearFn>(() => {
    // Cancel any in-flight re-announce frame so a just-scheduled message cannot
    // repopulate the live region after logout / campaign teardown.
    if (politeRafRef.current != null) {
      cancelAnimationFrame(politeRafRef.current);
      politeRafRef.current = null;
    }
    if (assertiveRafRef.current != null) {
      cancelAnimationFrame(assertiveRafRef.current);
      assertiveRafRef.current = null;
    }
    setPolite('');
    setAssertive('');
  }, []);

  // Keep the module-level entrypoint pointed at the mounted provider's clear.
  clearLiveRegionImpl = clear;

  // Attach the e2e bridge only under automation. Cancel pending announce() frames
  // on cleanup — otherwise a rAF scheduled just before unmount (hot reload /
  // test teardown) can still call setState after unmount. Also drop our hooks
  // so a remount cannot leave stale callbacks behind.
  useEffect(() => {
    const w = window as CampfireE2EWindow;
    if (!shouldAttachE2EBridge(w)) return;

    const hooks: CampfireE2EHooks =
      typeof w.__CAMPFIRE_E2E__ === 'object' && w.__CAMPFIRE_E2E__ != null ? w.__CAMPFIRE_E2E__ : {};
    hooks.announce = announce;
    hooks.clearAnnouncements = clear;
    w.__CAMPFIRE_E2E__ = hooks;

    return () => {
      if (politeRafRef.current != null) {
        cancelAnimationFrame(politeRafRef.current);
        politeRafRef.current = null;
      }
      if (assertiveRafRef.current != null) {
        cancelAnimationFrame(assertiveRafRef.current);
        assertiveRafRef.current = null;
      }
      if (w.__CAMPFIRE_E2E__ === hooks) {
        delete hooks.announce;
        delete hooks.clearAnnouncements;
        delete w.__CAMPFIRE_E2E__;
      } else if (typeof w.__CAMPFIRE_E2E__ === 'object' && w.__CAMPFIRE_E2E__ != null) {
        if (w.__CAMPFIRE_E2E__.announce === announce) delete w.__CAMPFIRE_E2E__.announce;
        if (w.__CAMPFIRE_E2E__.clearAnnouncements === clear) delete w.__CAMPFIRE_E2E__.clearAnnouncements;
      }
    };
  }, [announce, clear]);

  return (
    <AnnounceContext.Provider value={announce}>
      <ClearContext.Provider value={clear}>
        {children}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {polite}
        </div>
        <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
          {assertive}
        </div>
      </ClearContext.Provider>
    </AnnounceContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAnnounce(): AnnounceFn {
  return useContext(AnnounceContext);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useClearAnnouncements(): ClearFn {
  return useContext(ClearContext);
}

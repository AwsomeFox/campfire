/**
 * Announcer — a single app-root ARIA live region so dynamic changes reach
 * screen readers (issue #93). Nothing dynamic was announced before: dice
 * results, turn/round changes, and HP mutations were visual-only.
 *
 * Two visually-hidden live regions are mounted once at the app root:
 *  - polite   (aria-live="polite")   — roll results, turn changes, HP changes
 *  - assertive(role="alert")         — failures the user must notice now
 *
 * `useAnnounce()` returns `announce(message, { assertive, dedupeKey })`.
 * Rapid messages on the same channel are queued and flushed without dropping
 * content (issue #839); polite and assertive stay independent. Consecutive
 * identical messages without a `dedupeKey` are still re-announced (we blank
 * the node for a frame first), so e.g. two "1d20: 15" rolls in a row are both
 * spoken. Pass `dedupeKey` to suppress reconnect/refetch chatter.
 *
 * Because the provider outlives the router, announcement text can otherwise
 * linger into /login and the next account's session (issue #434). Callers that
 * tear down an identity or campaign scope use `useClearAnnouncements()`.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  createAnnounceQueue,
  createBrowserAnnouncerScheduler,
  type AnnounceFn,
  type AnnounceQueue,
  type AnnouncementChannel,
} from './announcerQueue';

// Re-export grouping helpers + types so call sites can import from Announcer.
// eslint-disable-next-line react-refresh/only-export-components
export {
  formatGroupedAnnouncement,
  formatGroupedCombatantAnnouncement,
  fingerprintDedupeParts,
  ANNOUNCE_DEDUPE_MS,
  ANNOUNCE_DWELL_MS,
  type AnnounceFn,
  type AnnounceOptions,
} from './announcerQueue';

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
 * attached only when the same window reports `navigator.webdriver` — never in
 * normal production browsing (a bare `__CAMPFIRE_E2E__` object is not enough).
 * Specs seed React announcer state via `window.__CAMPFIRE_E2E__.announce`.
 */
type CampfireE2EHooks = {
  announce?: AnnounceFn;
  clearAnnouncements?: ClearFn;
};

type CampfireE2EWindow = Window & {
  __CAMPFIRE_E2E__?: CampfireE2EHooks | true;
};

function shouldAttachE2EBridge(w: CampfireE2EWindow): boolean {
  // Require an automation signal from the same window. A bare
  // `__CAMPFIRE_E2E__` object without webdriver must not expose announcer hooks
  // to ordinary browsing (injected scripts).
  const nav = (w as Window & { navigator?: Navigator }).navigator;
  return Boolean(nav?.webdriver);
}

function createProviderQueue(
  setPolite: (value: string) => void,
  setAssertive: (value: string) => void,
): AnnounceQueue {
  const setter = (channel: AnnouncementChannel, message: string) => {
    if (channel === 'assertive') setAssertive(message);
    else setPolite(message);
  };
  return createAnnounceQueue({
    updater: {
      clear: (channel) => setter(channel, ''),
      set: setter,
    },
    scheduler: createBrowserAnnouncerScheduler(),
  });
}

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  // Created in effects / event handlers — never mutated during render.
  const queueRef = useRef<AnnounceQueue | null>(null);

  const ensureQueue = useCallback((): AnnounceQueue => {
    if (queueRef.current == null) {
      queueRef.current = createProviderQueue(setPolite, setAssertive);
    }
    return queueRef.current;
  }, []);

  useEffect(() => {
    const queue = ensureQueue();
    clearLiveRegionImpl = () => queue.clear();
    return () => {
      queue.dispose();
      queueRef.current = null;
      clearLiveRegionImpl = () => {};
    };
  }, [ensureQueue]);

  const announce = useCallback<AnnounceFn>((message, options) => {
    ensureQueue().announce(message, options);
  }, [ensureQueue]);

  const clear = useCallback<ClearFn>(() => {
    ensureQueue().clear();
  }, [ensureQueue]);

  // Keep the module-level entrypoint pointed at the mounted provider's clear
  // (same render-time publish as #506 — multi-tab sign-out can race effects).
  clearLiveRegionImpl = clear;

  // Attach the e2e bridge only under automation. Drop only the properties we
  // added on cleanup; delete the whole bridge object only when we created it.
  useEffect(() => {
    const w = window as CampfireE2EWindow;
    if (!shouldAttachE2EBridge(w)) return;

    const reusedExisting =
      typeof w.__CAMPFIRE_E2E__ === 'object' && w.__CAMPFIRE_E2E__ != null;
    const hooks: CampfireE2EHooks = reusedExisting ? w.__CAMPFIRE_E2E__ : {};
    hooks.announce = announce;
    hooks.clearAnnouncements = clear;
    w.__CAMPFIRE_E2E__ = hooks;

    return () => {
      if (typeof w.__CAMPFIRE_E2E__ === 'object' && w.__CAMPFIRE_E2E__ != null) {
        if (w.__CAMPFIRE_E2E__.announce === announce) delete w.__CAMPFIRE_E2E__.announce;
        if (w.__CAMPFIRE_E2E__.clearAnnouncements === clear) {
          delete w.__CAMPFIRE_E2E__.clearAnnouncements;
        }
      }
      if (!reusedExisting && w.__CAMPFIRE_E2E__ === hooks) {
        delete w.__CAMPFIRE_E2E__;
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

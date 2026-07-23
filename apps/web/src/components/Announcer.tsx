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
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
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
  // Stable lazy init — avoid mutating a ref during render (concurrent/StrictMode).
  const [queue] = useState(() => createProviderQueue(setPolite, setAssertive));

  useEffect(() => {
    return () => {
      queue.dispose();
    };
  }, [queue]);

  const announce = queue.announce;

  const clear = useCallback<ClearFn>(() => {
    queue.clear();
  }, [queue]);

  // Keep the module-level entrypoint pointed at the mounted provider's clear.
  clearLiveRegionImpl = clear;

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

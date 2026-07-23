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
// Separate from `announce` so logout / scope teardown can wipe without inventing
// a dummy message string (and without re-triggering a screen-reader utterance).
const ClearContext = createContext<ClearFn>(() => {});

/** E2E bridge so specs can seed React announcer state without mutating shared fixtures. */
type AnnouncerTestWindow = Window & {
  __campfireAnnounce?: AnnounceFn;
  __campfireClearAnnouncements?: ClearFn;
};

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

  // Playwright specs (issue #434) seed + assert via these hooks; production UI
  // never reads them. Cleared on unmount so a hot reload cannot leave a stale fn.
  // Also cancel pending announce() frames — otherwise a rAF scheduled just before
  // unmount (hot reload / test teardown) can still call setState after unmount.
  useEffect(() => {
    const w = window as AnnouncerTestWindow;
    w.__campfireAnnounce = announce;
    w.__campfireClearAnnouncements = clear;
    return () => {
      if (politeRafRef.current != null) {
        cancelAnimationFrame(politeRafRef.current);
        politeRafRef.current = null;
      }
      if (assertiveRafRef.current != null) {
        cancelAnimationFrame(assertiveRafRef.current);
        assertiveRafRef.current = null;
      }
      delete w.__campfireAnnounce;
      delete w.__campfireClearAnnouncements;
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

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
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type AnnounceOptions = { assertive?: boolean };
type AnnounceFn = (message: string, options?: AnnounceOptions) => void;

const AnnounceContext = createContext<AnnounceFn>(() => {});

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const rafRef = useRef<number | null>(null);

  const announce = useCallback<AnnounceFn>((message, options) => {
    const setter = options?.assertive ? setAssertive : setPolite;
    // Clear first so an identical consecutive message still triggers the SR.
    setter('');
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setter(message));
  }, []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </AnnounceContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAnnounce(): AnnounceFn {
  return useContext(AnnounceContext);
}

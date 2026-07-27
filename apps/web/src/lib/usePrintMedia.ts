import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * True while the browser is in print media (Playwright emulateMedia, print
 * preview, or a real print pass). Uses flushSync on beforeprint so paper-only
 * trees mount before the browser snapshots the document.
 */
export function usePrintMedia(): boolean {
  const [isPrint, setIsPrint] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia('print');
    const set = (next: boolean) => {
      flushSync(() => {
        setIsPrint(next);
      });
    };
    const syncFromMql = () => set(mql.matches);
    syncFromMql();
    mql.addEventListener('change', syncFromMql);
    const onBeforePrint = () => set(true);
    const onAfterPrint = () => set(mql.matches);
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);
    return () => {
      mql.removeEventListener('change', syncFromMql);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
    };
  }, []);

  return isPrint;
}

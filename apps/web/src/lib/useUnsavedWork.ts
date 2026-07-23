/**
 * Register a dirty form with the shared unsaved-work registry (issue #760).
 */
import { useEffect } from 'react';
import { setUnsavedWork } from './unsavedWork';

export function useUnsavedWork(id: string, dirty: boolean): void {
  useEffect(() => {
    setUnsavedWork(id, dirty);
    return () => setUnsavedWork(id, false);
  }, [id, dirty]);
}

import type { ReactNode } from 'react';
import { usePrintMedia } from '../lib/usePrintMedia';

/**
 * Mounts children only while print media is active. Keeps paper-only reference
 * trees out of the screen DOM so Playwright and a11y queries do not see
 * duplicate headings, secrets, or mention links.
 */
export function PrintOnly({ children }: { children: ReactNode }) {
  const isPrint = usePrintMedia();
  if (!isPrint) return null;
  return children;
}

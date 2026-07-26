/**
 * Responsive `srcset` construction for map images (issue #604).
 *
 * Before #604 both map surfaces pointed an <img> at the untouched original, so a
 * phone rendering a 360px-wide world-map card still downloaded every byte of a
 * multi-MB image. The server now stores a durable ladder of derivatives and reports
 * it as a manifest; these builders turn that manifest into a `srcset` the browser
 * can choose from.
 *
 * Kept as a pure module (no React, no component imports) so the descriptor maths —
 * the part that is easy to get subtly wrong — is directly unit-testable.
 */
import type { AttachmentDerivativeManifest, DerivativeVariant } from '@campfire/schema';
import { API } from '../lib/api';

/**
 * `srcset` for the role-safe encounter map route (issue #463 + #604).
 * Every URL stays on `/encounters/:id/map`, which re-applies the role and fog
 * rules per request, so a player's responsive map never touches an attachment URL.
 * The fogged view is rendered live at the requested rung and has the same dimensions
 * as the stored rung, so the manifest's widths are correct for players too.
 */
export function encounterMapSrcSet(
  encounterId: number,
  revision: string,
  manifest: AttachmentDerivativeManifest | null,
): string | undefined {
  return buildSrcSet(
    manifest,
    (variant) => `${API}/encounters/${encounterId}/map?revision=${encodeURIComponent(revision)}&size=${variant}`,
  );
}

/**
 * Only `ready` rungs with a real width may appear: a `pending` rung has no bytes on
 * disk yet (the request would fall back to the ORIGINAL, i.e. the browser would
 * silently download the largest possible image for the smallest slot), and a
 * `skipped`/`failed` rung has none at all.
 */
export function buildSrcSet(
  manifest: AttachmentDerivativeManifest | null,
  urlFor: (variant: DerivativeVariant) => string,
): string | undefined {
  if (!manifest) return undefined;
  const entries = manifest.derivatives
    .filter((d) => d.state === 'ready' && d.width > 0)
    .map((d) => `${urlFor(d.variant)} ${d.width}w`);
  return entries.length > 0 ? entries.join(', ') : undefined;
}

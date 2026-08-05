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

/**
 * Whether — and how — the battle map may use responsive delivery (issues #547 + #604).
 *
 * THE CAST RULE IS THE WHOLE POINT OF THIS FUNCTION. A Player Display / TV kiosk
 * authenticates with a `castToken` carried in the URL; the derivative manifest route
 * and every `srcset` rung authenticate from the session COOKIE instead. On a TV that
 * happens to still carry a DM's cookie, a single srcset rung would therefore be served
 * the DM's UNFOGGED SOURCE map — reintroducing exactly the fog-of-war leak that the
 * cast capability (#547) exists to close. So when a cast projection is active, responsive
 * delivery is off ENTIRELY: no manifest fetch, no retry, no srcset. The board still
 * renders, at full size, through its capability URL.
 *
 * This lives here, as one pure function, precisely so that rule is expressed ONCE and
 * can be asserted directly — three separate `!castToken` guards at the call site could
 * silently drift apart under a later edit.
 */
export interface EncounterMapResponsivePlan {
  /** Manifest URL to poll, or null when responsive delivery is disabled. */
  manifestUrl: string | null;
  /** DM-only regenerate URL, or null (players, cast displays, or no map). */
  retryUrl: string | null;
  /** False when no `srcset`/`sizes` may be emitted for this surface. */
  responsive: boolean;
}

export function planEncounterMapResponsive(input: {
  encounterId: number;
  mapAttachmentId: number | null | undefined;
  castToken: string | null | undefined;
  isCastProjection?: boolean;
  canDmWrite: boolean;
}): EncounterMapResponsivePlan {
  const { encounterId, mapAttachmentId, castToken, isCastProjection = false, canDmWrite } = input;
  // A cast display, or an encounter with no map at all, gets nothing.
  if (mapAttachmentId == null || castToken || isCastProjection) {
    return { manifestUrl: null, retryUrl: null, responsive: false };
  }
  return {
    // Read through the ROLE-SAFE encounter route, never `/attachments/:id/...`: a
    // player may not touch the attachment but still needs the rung widths (#463).
    manifestUrl: `${API}/encounters/${encounterId}/map/derivatives`,
    // Regeneration acts on the underlying attachment, so it is a DM-writer action;
    // players see the status text without a button.
    retryUrl: canDmWrite ? `${API}/attachments/${mapAttachmentId}/derivatives/retry` : null,
    responsive: true,
  };
}

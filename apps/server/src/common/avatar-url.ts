/**
 * Return a portrait URL that is safe to retain as immutable historical display
 * metadata. Character portraits are user-controlled, so comment attribution must
 * never snapshot active-content schemes such as javascript:, data:, or blob:.
 *
 * Same-origin attachment routes are allowed (always normalized to the canonical
 * relative `/api/v1/attachments/:id/file` form) and can be validated/remapped by
 * the caller. Absolute URLs that point at an attachment route are NOT kept as
 * remotes — they must go through the same campaign/kind/visibility checks and
 * id remapping as relative attachment portraits. Other remote portraits must use
 * HTTPS and may not contain URL credentials.
 */
export function safeHistoricalAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 500) return null;

  const attachmentId = historicalAvatarAttachmentId(candidate);
  if (attachmentId != null) {
    // Normalize absolute and relative attachment routes to the canonical relative
    // form so validation/remapping cannot be bypassed by an https://…/attachments/…
    // portrait.
    return `/api/v1/attachments/${attachmentId}/file`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Extract the attachment id from a canonical portrait route.
 *
 * Accepts the relative form `/api/v1/attachments/:id/file` and absolute URLs
 * whose pathname is that same route (with optional query/hash). Absolute hosts
 * are ignored — callers validate the id against the current campaign.
 */
export function historicalAvatarAttachmentId(value: string): number | null {
  const relative = value.match(/^\/api\/v1\/attachments\/(\d+)\/file(?:\?[^#\s]*)?(?:#[^\s]*)?$/);
  if (relative) {
    const id = Number(relative[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  try {
    const parsed = new URL(value);
    const absolute = parsed.pathname.match(/^\/api\/v1\/attachments\/(\d+)\/file$/);
    if (!absolute) return null;
    const id = Number(absolute[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

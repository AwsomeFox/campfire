/**
 * Return a portrait URL that is safe to retain as immutable historical display
 * metadata. Character portraits are user-controlled, so comment attribution must
 * never snapshot active-content schemes such as javascript:, data:, or blob:.
 *
 * Same-origin attachment routes are allowed and can be validated/remapped by the
 * caller. Remote portraits must use HTTPS and may not contain URL credentials.
 */
export function safeHistoricalAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 500) return null;
  if (historicalAvatarAttachmentId(candidate) != null) return candidate;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Extract the attachment id from a canonical same-origin portrait route. */
export function historicalAvatarAttachmentId(value: string): number | null {
  const match = value.match(/^\/api\/v1\/attachments\/(\d+)\/file(?:\?[^#\s]*)?(?:#[^\s]*)?$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

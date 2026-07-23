/**
 * Open-redirect guard for post-auth return targets (issue #478).
 * Mirrors the web client's `safeInternalPath`: only same-origin in-app absolute
 * paths. Used by the OIDC login/callback round-trip so a `?redirect=` query
 * cannot send the browser off-site after SSO.
 */
export function safeInternalPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if (/^\/(login|setup|signup|reset-password)(\/|\?|#|$)/.test(raw)) return null;
  if (raw.length > 512) return null;
  return raw;
}

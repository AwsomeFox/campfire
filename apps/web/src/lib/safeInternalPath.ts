/**
 * Open-redirect guard for post-login / post-auth return targets (issue #478).
 * Only honor same-origin, in-app absolute paths. Rejects protocol-relative
 * (`//evil.com`), backslash tricks (`/\evil.com`), and anything not rooted at
 * a single `/`. Returns null when unsafe.
 */
export function safeInternalPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // Never bounce back into an auth screen (would loop or hide the target).
  if (/^\/(login|setup|signup|reset-password)(\/|\?|#|$)/.test(raw)) return null;
  // Cap length so a huge query string cannot be smuggled through cookies/URLs.
  if (raw.length > 512) return null;
  return raw;
}

/** Build `/login?redirect=<safe path>` when the path is a valid in-app return target. */
export function loginHrefWithReturn(returnPath: string): string {
  const safe = safeInternalPath(returnPath);
  if (!safe) return '/login';
  return `/login?redirect=${encodeURIComponent(safe)}`;
}

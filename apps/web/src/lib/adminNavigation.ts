/**
 * Known campaign-setup surfaces that may ask the server-admin rules page to
 * provide a return link. Keep this deliberately narrower than a generic
 * same-origin redirect guard: the rules page only needs to return to the new
 * campaign wizard or an existing campaign's settings page.
 */
export const NEW_CAMPAIGN_SETUP_PATH = '/?newCampaign=1';

export function adminRulesHref(returnTo: string): string {
  const safeReturnTo = safeAdminRulesReturnPath(returnTo);
  if (!safeReturnTo) return '/admin/rules';
  return `/admin/rules?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export function safeAdminRulesReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === NEW_CAMPAIGN_SETUP_PATH) return value;
  if (/^\/c\/[1-9]\d*\/settings$/.test(value)) return value;
  return null;
}

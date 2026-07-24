/**
 * Parse a `:campaignId` route param into a positive safe integer, or undefined
 * when missing/invalid. Shared by AuthedLayout and Layout so scope clearing and
 * campaign lookups stay consistent (issue #434).
 */
export function parseCampaignIdParam(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  // Base-10 positive integers only — reject "1.5", "0x10", whitespace, etc.
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

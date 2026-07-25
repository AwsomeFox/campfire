/**
 * Cross-page hand-off for encounter aftermath recap drafts (issue #473).
 * The aftermath panel stores a draft before navigating to Sessions; the recap
 * form consumes and clears it on mount.
 */
const PREFIX = 'cf.encounterAftermathRecap.v1';

export function encounterAftermathRecapStorageKey(campaignId: number, encounterId: number): string {
  return `${PREFIX}:${campaignId}:${encounterId}`;
}

export function storeEncounterAftermathRecap(campaignId: number, encounterId: number, recap: string): void {
  if (!recap.trim()) return;
  try {
    sessionStorage.setItem(encounterAftermathRecapStorageKey(campaignId, encounterId), recap);
  } catch {
    /* storage blocked — the deep link still opens the recap form */
  }
}

export function consumeEncounterAftermathRecap(campaignId: number, encounterId: number): string | null {
  const key = encounterAftermathRecapStorageKey(campaignId, encounterId);
  try {
    const value = sessionStorage.getItem(key);
    if (value != null) sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

export const CAMPAIGN_ONBOARDING_KEY_PREFIX = 'cf.campaignOnboarding';

export interface CampaignOnboardingPrefs {
  skipped: boolean;
  checklistOpen: boolean;
  soloMode: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_CAMPAIGN_ONBOARDING_PREFS: CampaignOnboardingPrefs = {
  skipped: false,
  checklistOpen: false,
  soloMode: false,
};

export function campaignOnboardingStorageKey(campaignId: number): string {
  return `${CAMPAIGN_ONBOARDING_KEY_PREFIX}.${campaignId}`;
}

export function normalizeCampaignOnboardingPrefs(value: unknown): CampaignOnboardingPrefs {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CAMPAIGN_ONBOARDING_PREFS };
  const raw = value as Partial<Record<keyof CampaignOnboardingPrefs, unknown>>;
  return {
    skipped: raw.skipped === true,
    checklistOpen: raw.checklistOpen === true,
    soloMode: raw.soloMode === true,
  };
}

export function readCampaignOnboardingPrefs(
  storage: StorageLike | null | undefined,
  campaignId: number,
): CampaignOnboardingPrefs {
  if (!storage) return { ...DEFAULT_CAMPAIGN_ONBOARDING_PREFS };
  try {
    const raw = storage.getItem(campaignOnboardingStorageKey(campaignId));
    if (!raw) return { ...DEFAULT_CAMPAIGN_ONBOARDING_PREFS };
    return normalizeCampaignOnboardingPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CAMPAIGN_ONBOARDING_PREFS };
  }
}

export function persistCampaignOnboardingPrefs(
  storage: StorageLike | null | undefined,
  campaignId: number,
  prefs: CampaignOnboardingPrefs,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(campaignOnboardingStorageKey(campaignId), JSON.stringify(normalizeCampaignOnboardingPrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

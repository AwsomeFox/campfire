export const SETTINGS_SECTIONS = [
  { id: 'campaign', translationKey: 'settings.categories.campaign' },
  { id: 'gameplay-rules', translationKey: 'settings.categories.gameplayRules' },
  { id: 'ai', translationKey: 'settings.categories.ai' },
  { id: 'data', translationKey: 'settings.categories.data' },
  { id: 'lifecycle', translationKey: 'settings.categories.lifecycle' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * Category hashes are canonical. Card/subsection hashes remain supported so links
 * from onboarding, bookmarks, and older notifications keep their precise target.
 */
const HASH_SECTION: Readonly<Record<string, SettingsSectionId>> = {
  campaign: 'campaign',
  'campaign-general': 'campaign',
  'public-recap-sharing': 'campaign',
  'public-invites': 'campaign',
  'cast-sessions': 'campaign',
  'gameplay-rules': 'gameplay-rules',
  'rule-system': 'gameplay-rules',
  ai: 'ai',
  'ai-dm': 'ai',
  'ai-dm-readiness': 'ai',
  'ai-dm-mode': 'ai',
  'ai-dm-narration-language': 'ai',
  'ai-dm-provider': 'ai',
  'ai-dm-budget': 'ai',
  'ai-dm-instructions': 'ai',
  'ai-dm-style': 'ai',
  'ai-dm-comprehension': 'ai',
  data: 'data',
  export: 'data',
  duplicate: 'data',
  lifecycle: 'lifecycle',
  status: 'lifecycle',
  'danger-zone': 'lifecycle',
};

export function settingsHashTarget(hash: string): string | null {
  if (!hash || hash === '#') return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

export function settingsSectionForHash(hash: string): SettingsSectionId | null {
  const target = settingsHashTarget(hash);
  return target ? HASH_SECTION[target] ?? null : null;
}

/**
 * Character sheet Play vs Build/Profile IA (issue #646).
 *
 * Pure helpers for tab validation, deep-link focus targets, local persistence,
 * and a Play-first default. The URL (`?tab=`, `?focus=`) is authoritative;
 * when absent, the last tab per character is restored from localStorage; when
 * that is also absent, Play is shown first.
 */

export type CharacterSheetTab = 'play' | 'build';

export type CharacterSheetFocus =
  | 'abilities'
  | 'hp'
  | 'conditions'
  | 'actions'
  | 'saves'
  | 'skills'
  | 'slots'
  | 'xp'
  | 'background'
  | 'inventory'
  | 'portrait'
  | 'player'
  | 'dm-secret';

export const CHARACTER_SHEET_TAB_ORDER: ReadonlyArray<CharacterSheetTab> = ['play', 'build'];

export const CHARACTER_SHEET_TAB_LABEL: Record<CharacterSheetTab, string> = {
  play: 'Play',
  build: 'Build & profile',
};

const PLAY_FOCUS = new Set<CharacterSheetFocus>([
  'abilities',
  'hp',
  'conditions',
  'actions',
  'saves',
  'skills',
  'slots',
]);

const BUILD_FOCUS = new Set<CharacterSheetFocus>([
  'xp',
  'background',
  'inventory',
  'portrait',
  'player',
  'dm-secret',
]);

const FOCUS_ALIASES: Record<string, CharacterSheetFocus> = {
  abilities: 'abilities',
  ability: 'abilities',
  scores: 'abilities',
  hp: 'hp',
  health: 'hp',
  conditions: 'conditions',
  condition: 'conditions',
  actions: 'actions',
  action: 'actions',
  saves: 'saves',
  'saving-throws': 'saves',
  skills: 'skills',
  skill: 'skills',
  slots: 'slots',
  'spell-slots': 'slots',
  spells: 'slots',
  xp: 'xp',
  experience: 'xp',
  level: 'xp',
  background: 'background',
  story: 'background',
  inventory: 'inventory',
  portrait: 'portrait',
  player: 'player',
  profile: 'player',
  'dm-secret': 'dm-secret',
  dm: 'dm-secret',
};

export function parseCharacterSheetTabParam(raw: string | null): CharacterSheetTab | null {
  if (raw === 'play' || raw === 'build') return raw;
  return null;
}

export function parseCharacterSheetFocusParam(raw: string | null): CharacterSheetFocus | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const focus = FOCUS_ALIASES[key];
  return focus ?? null;
}

export function characterSheetTabStorageKey(campaignId: number, characterId: number): string {
  return `cf.characterSheetTab.${campaignId}.${characterId}`;
}

export function readPersistedCharacterSheetTab(storageKey: string): CharacterSheetTab | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey) ?? null;
    return parseCharacterSheetTabParam(raw);
  } catch {
    return null;
  }
}

export function writePersistedCharacterSheetTab(storageKey: string, tab: CharacterSheetTab): void {
  try {
    globalThis.localStorage?.setItem(storageKey, tab);
  } catch {
    // Private mode / quota — tab still works for the session via URL/state.
  }
}

export function tabForFocus(focus: CharacterSheetFocus): CharacterSheetTab {
  if (PLAY_FOCUS.has(focus)) return 'play';
  if (BUILD_FOCUS.has(focus)) return 'build';
  return 'play';
}

export function characterSheetSectionId(focus: CharacterSheetFocus): string {
  return `character-section-${focus}`;
}

export function isPlayFocus(focus: CharacterSheetFocus): boolean {
  return PLAY_FOCUS.has(focus);
}

export function isBuildFocus(focus: CharacterSheetFocus): boolean {
  return BUILD_FOCUS.has(focus);
}

/**
 * Resolve the active tab. Precedence:
 *  1. Explicit `?tab=` deep link
 *  2. `?focus=` deep link (opens the tab that owns the section)
 *  3. Persisted per-character preference
 *  4. Default `play`
 */
export function resolveCharacterSheetTab(input: {
  urlTab: CharacterSheetTab | null;
  urlFocus: CharacterSheetFocus | null;
  persistedTab: CharacterSheetTab | null;
}): CharacterSheetTab {
  if (input.urlTab) return input.urlTab;
  if (input.urlFocus) return tabForFocus(input.urlFocus);
  if (input.persistedTab) return input.persistedTab;
  return 'play';
}

/** Play-panel sections in mobile-friendly order (issue #646 scroll reduction). */
export const CHARACTER_SHEET_PLAY_SECTIONS = [
  'abilities',
  'hp',
  'conditions',
  'actions',
  'saves',
  'skills',
  'slots',
] as const satisfies ReadonlyArray<CharacterSheetFocus>;

/** Build-panel sections in profile/advancement order. */
export const CHARACTER_SHEET_BUILD_SECTIONS = [
  'xp',
  'background',
  'inventory',
  'portrait',
  'player',
  'dm-secret',
] as const satisfies ReadonlyArray<CharacterSheetFocus>;

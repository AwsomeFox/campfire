/**
 * Character sheet editor draft helpers (issue #641).
 */
import type { Character, CharacterStatus, RuleSystemAdapter } from '@campfire/schema';
import { abilityFieldsForCharacter, abilityScore } from '../../lib/characterStats';
import { recordsEqual } from '../../lib/protectedFormState';

export type CharacterSheetDraft = {
  name: string;
  species: string;
  className: string;
  background: string;
  level: string;
  ac: string;
  speed: string;
  hpMax: string;
  status: CharacterStatus;
  stats: Record<string, string>;
};

export function characterSheetDraftFrom(character: Character, adapter: RuleSystemAdapter): CharacterSheetDraft {
  const stats: Record<string, string> = {};
  for (const { key } of abilityFieldsForCharacter(adapter, character)) {
    const score = abilityScore(character, key);
    stats[key] = score === null ? '' : String(score);
  }
  return {
    name: character.name,
    species: character.species,
    className: character.className,
    background: character.background,
    level: String(character.level),
    ac: character.ac != null ? String(character.ac) : '',
    speed: character.speed != null ? String(character.speed) : '',
    hpMax: String(character.hpMax),
    status: character.status,
    stats,
  };
}

export function isCharacterSheetDirty(draft: CharacterSheetDraft, baseline: CharacterSheetDraft): boolean {
  return !characterSheetDraftsEqual(draft, baseline);
}

export function characterSheetDraftsEqual(a: CharacterSheetDraft, b: CharacterSheetDraft): boolean {
  return (
    a.name === b.name &&
    a.species === b.species &&
    a.className === b.className &&
    a.background === b.background &&
    a.level === b.level &&
    a.ac === b.ac &&
    a.speed === b.speed &&
    a.hpMax === b.hpMax &&
    a.status === b.status &&
    recordsEqual(a.stats, b.stats)
  );
}

export function snapshotCharacterSheetDraft(input: {
  name: string;
  species: string;
  className: string;
  background: string;
  level: string;
  ac: string;
  speed: string;
  hpMax: string;
  status: CharacterStatus;
  stats: Record<string, string>;
}): CharacterSheetDraft {
  return {
    name: input.name,
    species: input.species,
    className: input.className,
    background: input.background,
    level: input.level,
    ac: input.ac,
    speed: input.speed,
    hpMax: input.hpMax,
    status: input.status,
    stats: { ...input.stats },
  };
}

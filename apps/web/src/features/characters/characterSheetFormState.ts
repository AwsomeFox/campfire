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

/**
 * Issue #1910 review (Devin, PR #1980): `readFormDraft` validates only the
 * envelope (`v: 1`) and that `data` exists — never the field set — so a draft
 * persisted before a field joined `CharacterSheetDraft` restores with that key
 * `undefined`. Feeding that straight into `setSpeed`/etc puts a non-string into
 * state typed `string`; `save()`'s later `field.trim()` then throws inside the
 * async handler (`void save()`, so the rejection is unhandled) — the Save
 * button silently does nothing. `speed` (added by #1910) is the one field with
 * a REAL exposure today: every other field here shipped in the very first
 * version of this draft shape (issue #641), so no version of the app has ever
 * persisted a draft missing them. Normalizing the whole shape in one place
 * (rather than one `?? fallback` per call site) closes the class defensively
 * against the next field this shape gains, not just the reported line.
 */
export function normalizeRestoredDraft(restored: Partial<CharacterSheetDraft>): CharacterSheetDraft {
  return {
    name: restored.name ?? '',
    species: restored.species ?? '',
    className: restored.className ?? '',
    background: restored.background ?? '',
    level: restored.level ?? '',
    ac: restored.ac ?? '',
    speed: restored.speed ?? '',
    hpMax: restored.hpMax ?? '',
    status: restored.status ?? 'active',
    stats: { ...restored.stats },
  };
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

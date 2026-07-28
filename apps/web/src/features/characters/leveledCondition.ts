/**
 * Issue #1643 — pure helpers for the character sheet's leveled condition track (5e
 * Exhaustion, levels 1-6; PF2e and most other systems have none). Extracted from
 * CharacterPage so the adapter-lookup and level math are unit-testable without a live
 * campaign, character, or DOM — mirrors the split `characterSheetTabs.ts` already uses.
 */
import { leveledConditionTrackFor, type Character, type LeveledConditionTrack, type RuleSystemAdapter } from '@campfire/schema';

/** The leveled condition track this campaign's adapter declares, or undefined for none. */
export function findLeveledConditionTrack(adapter: RuleSystemAdapter): LeveledConditionTrack | undefined {
  return leveledConditionTrackFor(adapter.id);
}

/** The track's condition's CURRENT level on this character — 0 if it isn't present at all. */
export function conditionLevel(track: Pick<LeveledConditionTrack, 'name'>, character: Pick<Character, 'conditionInstances'>): number {
  const key = track.name.trim().toLowerCase();
  const inst = character.conditionInstances.find((i) => i.name.trim().toLowerCase() === key);
  return inst?.stacks ?? 0;
}

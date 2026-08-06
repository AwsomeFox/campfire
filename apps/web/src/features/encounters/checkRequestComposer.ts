/**
 * Pure logic for the group-check composer (issue #1943 review).
 *
 * Two independent concerns live here:
 *  - {@link commonChecks} (finding #7): two party members can have genuinely different
 *    roll-check catalogs. That's SAFE to ignore for the 5e/PF2e adapters (`buildCheckCatalog`),
 *    which return the identical set of check ids for every character under one rule system (only
 *    the numeric modifiers differ) — but every other registered system (OSR, Open Legend, 13th
 *    Age, Starforged, homebrew) falls back to `neutralCheckCatalog`, which derives `skill:*` ids
 *    from `Object.entries(character.skills ?? {})` and `ability:*`/`save:*` ids from THAT
 *    character's own `stats` keys. Assuming one representative character's catalog applies to
 *    every selected target would let the DM pick a check some targets cannot roll at all —
 *    previously only discovered when the server 404s partway through a group send (see
 *    `requestChecks`'s own atomicity fix for the write-time half of that bug).
 *  - {@link wholePartyTargetIds}/{@link exceedsCheckRequestCap} (finding #6): the "whole party"
 *    one-tap preset must mean "everyone currently playing," not every sheet the campaign has
 *    ever created — a retired/dead/draft/inactive character targeted by the preset would get a
 *    pending prompt nobody can meaningfully answer — and must never mint a request the server
 *    would 400 on for exceeding `CheckRequestCreate.characterIds.max(20)`.
 */
import type { Character, RollCheckDefinition } from '@campfire/schema';

/**
 * The checks every one of `checksLists` (one fetched catalog per selected character, in
 * selection order) can roll. Keeps the FIRST list's definitions — for stable label/ordering —
 * filtered down to ids present in every other list too. A single list (one character selected,
 * the common case) passes through unfiltered. Empty input, or no id common to every list,
 * returns `[]` — the caller must show that explicitly rather than silently offering nothing.
 */
export function commonChecks(checksLists: readonly (readonly RollCheckDefinition[])[]): RollCheckDefinition[] {
  const [first, ...rest] = checksLists;
  if (!first) return [];
  return first.filter((def) => rest.every((list) => list.some((d) => d.id === def.id)));
}

/** `CheckRequestCreate.characterIds` is capped server-side at 20 (`packages/schema/src/index.ts`). */
export const CHECK_REQUEST_MAX_TARGETS = 20;

/**
 * The character ids the "whole party" preset should select: `status === 'active'` only. The
 * individual checkboxes in the composer still list every character regardless of status — a DM
 * who genuinely wants a retired/dead sheet to roll (a flashback scene, say) can still check it
 * by hand; only this one-tap PRESET is scoped.
 */
export function wholePartyTargetIds(characters: readonly Pick<Character, 'id' | 'status'>[]): number[] {
  return characters.filter((c) => c.status === 'active').map((c) => c.id);
}

/**
 * Whether a target-id list would overflow the server's cap. The caller must disable the "whole
 * party" preset (with a visible reason) rather than let it mint a request the server 400s —
 * a silent failure on exactly the long-running, large-roster campaigns most likely to reach for
 * a one-tap "everyone" button is the opposite of the feature's point.
 */
export function exceedsCheckRequestCap(targetIds: readonly number[]): boolean {
  return targetIds.length > CHECK_REQUEST_MAX_TARGETS;
}

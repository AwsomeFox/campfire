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
 *  - {@link commonChecksFromQueries} (follow-up to #7): a failed per-character catalog fetch
 *    must never be read as "this character rolls nothing" — see its own doc comment.
 */
import { CHECK_REQUEST_MAX_TARGETS, type Character, type RollCheckDefinition } from '@campfire/schema';

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

/** The subset of a TanStack Query result {@link commonChecksFromQueries} actually reads. */
export interface CheckCatalogQueryState {
  data: readonly RollCheckDefinition[] | undefined;
  isSuccess: boolean;
  isError: boolean;
}

export interface CommonChecksResult {
  /** The intersection — meaningful ONLY when every query has loaded; `[]` otherwise. */
  checks: RollCheckDefinition[];
  /** True once EVERY query succeeded but they share no rollable check — a genuine empty intersection. */
  noCommonCheck: boolean;
  /** True when at least one query is in an error state. The caller must surface a retryable error and must NOT read `noCommonCheck` as "the catalogs are disjoint" — they may simply be unknown. */
  anyError: boolean;
}

/**
 * Distinguishes three states a set of per-character catalog queries can be in (issue #1943
 * review): LOADING (any query still pending) — nothing to show yet; FAILED (any query
 * `isError`) — the caller must surface a retryable error and NOT compute an intersection at all;
 * LOADED (every query `isSuccess`) — intersect for real, and an empty result genuinely means the
 * selected characters share no check.
 *
 * The bug this closes: naively reading `query.data ?? []` conflates "this character has no
 * checks" with "we don't know what this character has" — a query that failed (or is offline/
 * paused) has `isLoading: false` and `data: undefined` exactly like one that legitimately
 * resolved to an empty catalog. Feeding that `[]` into an INTERSECTION is the worst place for
 * that conflation: one unknown collapses the whole result to empty regardless of what every
 * OTHER selected character can roll, silently telling the DM their party shares nothing in
 * common and blocking every send — self-healing only on a full page reload. An explicit error
 * is both more honest (it says what actually happened) and more recoverable (retryable in place).
 */
export function commonChecksFromQueries(queries: readonly CheckCatalogQueryState[]): CommonChecksResult {
  const anyError = queries.some((q) => q.isError);
  const allLoaded = queries.length > 0 && queries.every((q) => q.isSuccess);
  if (!allLoaded) return { checks: [], noCommonCheck: false, anyError };
  const checks = commonChecks(queries.map((q) => q.data ?? []));
  return { checks, noCommonCheck: checks.length === 0, anyError };
}

/**
 * Re-exported for callers that only need this module's import (`CheckRequests.tsx` imports it
 * from here rather than adding a second `@campfire/schema` import line). The single declaration
 * lives in `@campfire/schema` — see its doc comment — so the UI's cap cannot drift from the
 * server's `CheckRequestCreate.characterIds.max()`.
 */
export { CHECK_REQUEST_MAX_TARGETS };

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

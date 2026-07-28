/**
 * Issue #1642 — pure helpers for the "special" adapter-declared counted resource a
 * character sheet surfaces: 5e `inspiration` or PF2e `heroPoints`. Extracted from
 * CharacterPage so the adapter-selection and pip-availability math are unit-testable
 * without a live campaign, character, or DOM (mirrors `characterSheetTabs.ts`'s split).
 *
 * Deliberately NOT a generic "render every adapter resource" browser — #422/#1578 already
 * cover arbitrary resources via GET :id/resource-vocabulary and POST :id/resources for
 * clients that want that (the AI tools, primarily). This is the narrower, named surface
 * #1642 actually asks for.
 */
import type { AdapterResourceDef, Character, RuleSystemAdapter } from '@campfire/schema';

/**
 * The two resources #1642 surfaces. A campaign's adapter declares at most one of these —
 * see `resources.spec.ts`'s "#1073 declares inspiration for 5e and hero points for PF2e,
 * with their own economies" — never both, and most adapters (Open Legend, Starforged, the
 * OSR pack, …) declare neither.
 */
export const SPECIAL_RESOURCE_KEYS = new Set(['inspiration', 'heroPoints']);

/**
 * Whichever of {@link SPECIAL_RESOURCE_KEYS} this adapter declares, or `undefined` if
 * neither. Reads `adapter.resources` directly (already loaded client-side alongside the
 * rest of the adapter, same as `adapter.characterSheet?.supportsSpellSlotEditor` elsewhere
 * in CharacterPage) rather than a network round trip to GET :id/resource-vocabulary — that
 * endpoint additionally merges in a character's own custom resources, which this narrow
 * surface has no use for.
 */
export function findSpecialResource(adapter: RuleSystemAdapter): AdapterResourceDef | undefined {
  return (adapter.resources ?? []).find((r) => SPECIAL_RESOURCE_KEYS.has(r.key));
}

export type ResourceAvailability = { max: number; used: number; available: number };

/**
 * Current max/used/available for one resource on a character.
 *
 * Issue #422's `characters.resources` is sparse — a key is only present once
 * `adjustResource` has written it at least once. Inspiration / hero points are
 * DM-awarded (see `resources.spec.ts` #1073): absence must NOT be treated as a
 * full pool, or a fresh sheet would let the player Spend a reroll that was never
 * awarded. Untouched characters therefore show the adapter's capacity with
 * nothing available; Restore on the card awards the pool on first touch.
 */
export function resourceAvailability(
  def: Pick<AdapterResourceDef, 'key' | 'defaultMax'>,
  character: Pick<Character, 'resources'>,
): ResourceAvailability {
  const stored = character.resources[def.key];
  if (!stored) {
    const max = def.defaultMax ?? 1;
    return { max, used: max, available: 0 };
  }
  const max = stored.max;
  const used = stored.used ?? 0;
  return { max, used, available: Math.max(0, max - used) };
}

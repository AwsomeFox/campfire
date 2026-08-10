/**
 * The character sheet's proficiency ladder, and how an equipped weapon finds its rank on it
 * (issue #2144).
 *
 * A leaf module on purpose. `equipped-item-action.ts` derives an attack and needs to price a
 * rank, but it deliberately has no runtime dependency on index.ts (see its own header) — so the
 * ladder lives here, where both it and index.ts can import it and there is exactly one copy.
 */
import { z } from 'zod';

/**
 * The canonical proficiency ladder, lowest to highest.
 *
 * PF2e's five rungs are the ladder every supported system's ranks fit onto, so they are the
 * canonical spelling: 5e's "proficient" IS trained and its "expertise" IS expert — the same two
 * rungs under different printed names — while 5e simply has nothing above them. Modelling one
 * ladder is what lets a rank be stored once and priced by whichever adapter the campaign runs,
 * instead of each system carrying a vocabulary the others have to guess at.
 *
 * `untrained` is spellable but never needs storing: a key absent from a proficiency record is
 * untrained, and that is the shape every reader assumes.
 */
export const PROFICIENCY_RANKS = ['untrained', 'trained', 'expert', 'master', 'legendary'] as const;
export const ProficiencyRank = z.enum(PROFICIENCY_RANKS);
export type ProficiencyRank = z.infer<typeof ProficiencyRank>;

/**
 * The 5e spellings of the bottom two rungs, still accepted everywhere a rank is.
 *
 * Every `characters.skills` row written before the ladder existed holds one of these, and so
 * does every REST/MCP client built against the old two-value enum. They stay VALID rather than
 * being migrated away: a stored `'proficient'` means exactly `'trained'`, so rewriting the rows
 * would churn data to change nothing, and rejecting the input would break clients over a
 * synonym. {@link normalizeProficiencyRank} folds them to canonical at every point that prices
 * a rank, so nothing downstream has to know both spellings.
 */
export const LEGACY_RANK_ALIASES: Readonly<Record<string, ProficiencyRank>> = { proficient: 'trained', expertise: 'expert' };

/** Fold a stored or submitted rank (either spelling, any case) to the canonical ladder. */
export function normalizeProficiencyRank(rank: string | null | undefined): ProficiencyRank {
  if (!rank) return 'untrained';
  const lower = rank.trim().toLowerCase();
  const canonical = LEGACY_RANK_ALIASES[lower] ?? lower;
  return ProficiencyRank.safeParse(canonical).success ? (canonical as ProficiencyRank) : 'untrained';
}

/** Position on the ladder, for taking the better of two ranks. */
function rankOrder(rank: ProficiencyRank): number {
  return PROFICIENCY_RANKS.indexOf(rank);
}

/** The higher of two ranks. */
export function bestProficiencyRank(a: ProficiencyRank, b: ProficiencyRank): ProficiencyRank {
  return rankOrder(a) >= rankOrder(b) ? a : b;
}

/**
 * The rank a character has with one specific weapon.
 *
 * Both systems train a character in a CATEGORY (5e "simple"/"martial"; PF2e adds "advanced" and
 * "unarmed") and, separately, in named weapons their class or ancestry singles out — an Elf's
 * longsword, a Cleric's deity's favoured weapon. So the answer is the BEST of every key that
 * applies: the weapon's own name and each category it belongs to. Taking the best is what makes
 * the two kinds of entry compose instead of one silently shadowing the other, and it matches how
 * a player reads their sheet ("I'm trained in martial weapons, and expert with the longsword").
 *
 * Keys are matched case-insensitively and trimmed, because they come from three directions with
 * three conventions: a human typing into the sheet, an importer copying a source's printed name,
 * and compendium data ("Martial" from AoN, "martial" from Open5e).
 */
export function weaponProficiencyRank(
  proficiencies: Record<string, string> | null | undefined,
  weaponName: string,
  categories: readonly string[] = [],
): ProficiencyRank {
  if (!proficiencies) return 'untrained';
  const byKey = new Map<string, ProficiencyRank>();
  for (const [key, value] of Object.entries(proficiencies)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) continue;
    const rank = normalizeProficiencyRank(value);
    if (rank === 'untrained') continue;
    const existing = byKey.get(normalizedKey);
    byKey.set(normalizedKey, existing ? bestProficiencyRank(existing, rank) : rank);
  }
  if (byKey.size === 0) return 'untrained';

  let best: ProficiencyRank = 'untrained';
  for (const candidate of [weaponName, ...categories]) {
    const key = candidate.trim().toLowerCase();
    if (!key) continue;
    const rank = byKey.get(key);
    if (rank) best = bestProficiencyRank(best, rank);
  }
  return best;
}

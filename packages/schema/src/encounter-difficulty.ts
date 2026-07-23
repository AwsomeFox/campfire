/**
 * Encounter difficulty estimation (issues #58 + #429).
 *
 * The D&D 5e DMG XP-budget math (CR→XP, party thresholds, number-of-monsters
 * multiplier) lives here so the RuleSystemAdapter can own labels, assumptions,
 * and support status. Unsupported systems return an explicit unsupported result
 * instead of a misleading 5e "Trivial" band for zero-data fights.
 */
import { z } from 'zod';

// ---------- encounter difficulty (5e XP-budget estimation, issue #58) ----------
// Computed (read-only) difficulty band for an encounter: the party's summed 5e XP
// thresholds vs the total adjusted monster XP (monster CR->XP with the standard
// number-of-monsters multiplier). `trivial` is below the party's Easy threshold.
export const DifficultyBand = z.enum(['trivial', 'easy', 'medium', 'hard', 'deadly']);
export type DifficultyBand = z.infer<typeof DifficultyBand>;

/** Whether the ruleset could score this fight, and whether the inputs were complete. */
export const EncounterDifficultyStatus = z.enum(['ok', 'unknown', 'unsupported']);
export type EncounterDifficultyStatus = z.infer<typeof EncounterDifficultyStatus>;

export const DIFFICULTY_BAND_LABELS: Record<DifficultyBand, string> = {
  trivial: 'Trivial',
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  deadly: 'Deadly',
};

export const UNKNOWN_DIFFICULTY_LABEL = 'Unknown—add XP/CR';

export const EncounterDifficulty = z.object({
  /**
   * Support / completeness (issue #429):
   * - `ok` — band is meaningful for this ruleset + input
   * - `unknown` — monsters present but lack required CR/XP (never label as Trivial)
   * - `unsupported` — this ruleset has no encounter-budget math
   */
  status: EncounterDifficultyStatus,
  /** Display label owned by the adapter (`Trivial`, `Unknown—add XP/CR`, …). */
  label: z.string().min(1).max(120),
  /** Meaningful only when `status === 'ok'`; null for unknown/unsupported. */
  band: DifficultyBand.nullable(),
  // Party XP thresholds (sum across the PC combatants' per-level thresholds).
  thresholds: z.object({
    easy: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    deadly: z.number().int().nonnegative(),
  }),
  partySize: z.number().int().nonnegative(), // number of PC (character) combatants counted
  partyLevels: z.array(z.number().int()), // the PC levels that fed the thresholds
  monsterCount: z.number().int().nonnegative(), // number of monster combatants counted
  totalMonsterXp: z.number().int().nonnegative(), // raw summed monster XP (pre-multiplier)
  multiplier: z.number(), // 5e encounter multiplier for the monster count
  adjustedXp: z.number().int().nonnegative(), // totalMonsterXp * multiplier, compared to thresholds
  /** Monsters that contributed no CR/XP (manual / incomplete statblocks). */
  monstersMissingRating: z.number().int().nonnegative(),
  /** Transparent caveats (action economy, missing party levels, partial CR data). */
  warnings: z.array(z.string()),
  /** Rules assumptions the estimate rests on (e.g. DMG XP tables). */
  assumptions: z.array(z.string()),
});
export type EncounterDifficulty = z.infer<typeof EncounterDifficulty>;

/** Input the adapter difficulty estimator consumes. */
export interface EncounterDifficultyInput {
  partyLevels: number[];
  /** Per-monster CR (null = missing / unparseable). */
  monsterChallengeRatings: (number | null)[];
}

/** Standard 5e DMG XP-by-CR table. Keys are CR as a number (fractional CRs use 0.125/0.25/0.5). */
const XP_BY_CR: Record<string, number> = {
  '0': 10,
  '0.125': 25,
  '0.25': 50,
  '0.5': 100,
  '1': 200,
  '2': 450,
  '3': 700,
  '4': 1100,
  '5': 1800,
  '6': 2300,
  '7': 2900,
  '8': 3900,
  '9': 5000,
  '10': 5900,
  '11': 7200,
  '12': 8400,
  '13': 10000,
  '14': 11500,
  '15': 13000,
  '16': 15000,
  '17': 18000,
  '18': 20000,
  '19': 22000,
  '20': 25000,
  '21': 33000,
  '22': 41000,
  '23': 50000,
  '24': 62000,
  '25': 75000,
  '26': 90000,
  '27': 105000,
  '28': 120000,
  '29': 135000,
  '30': 155000,
};

/** Per-character-level XP thresholds (5e DMG "XP Thresholds by Character Level"). */
const XP_THRESHOLDS_BY_LEVEL: Record<number, { easy: number; medium: number; hard: number; deadly: number }> = {
  1: { easy: 25, medium: 50, hard: 75, deadly: 100 },
  2: { easy: 50, medium: 100, hard: 150, deadly: 200 },
  3: { easy: 75, medium: 150, hard: 225, deadly: 400 },
  4: { easy: 125, medium: 250, hard: 375, deadly: 500 },
  5: { easy: 250, medium: 500, hard: 750, deadly: 1100 },
  6: { easy: 300, medium: 600, hard: 900, deadly: 1400 },
  7: { easy: 350, medium: 750, hard: 1100, deadly: 1700 },
  8: { easy: 450, medium: 900, hard: 1300, deadly: 2100 },
  9: { easy: 550, medium: 1100, hard: 1600, deadly: 2400 },
  10: { easy: 600, medium: 1200, hard: 1900, deadly: 2800 },
  11: { easy: 800, medium: 1600, hard: 2400, deadly: 3600 },
  12: { easy: 1000, medium: 2000, hard: 3000, deadly: 4500 },
  13: { easy: 1100, medium: 2200, hard: 3400, deadly: 5100 },
  14: { easy: 1250, medium: 2500, hard: 3800, deadly: 5700 },
  15: { easy: 1400, medium: 2800, hard: 4300, deadly: 6400 },
  16: { easy: 1600, medium: 3200, hard: 4800, deadly: 7200 },
  17: { easy: 2000, medium: 3900, hard: 5900, deadly: 8800 },
  18: { easy: 2100, medium: 4200, hard: 6300, deadly: 9500 },
  19: { easy: 2400, medium: 4900, hard: 7300, deadly: 10900 },
  20: { easy: 2800, medium: 5700, hard: 8500, deadly: 12700 },
};

/**
 * Parse a monster's challenge rating into a numeric CR. Handles the number form the
 * open5e importer stores (e.g. 0.25, 5) and the string forms it can also carry
 * ("1/4", "1/8", "5"). Returns null for an unparseable / missing CR so the caller
 * can simply skip that monster rather than mis-score it.
 */
export function parseCr(cr: unknown): number | null {
  if (typeof cr === 'number' && Number.isFinite(cr)) return cr;
  if (typeof cr !== 'string') return null;
  const s = cr.trim();
  if (!s) return null;
  if (s.includes('/')) {
    const [num, den] = s.split('/');
    const n = Number(num);
    const d = Number(den);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) return n / d;
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Monster CR -> XP via the 5e table. Snaps fractional CRs to the nearest table key; null CR -> 0 XP. */
export function crToXp(cr: number | null): number {
  if (cr === null) return 0;
  // Exact table hit (covers 0, 0.125, 0.25, 0.5, and every integer 1..30).
  const direct = XP_BY_CR[String(cr)];
  if (direct !== undefined) return direct;
  // Fractional CR that isn't a table key: clamp into range, then round to the nearest
  // integer CR (fractional keys below 1 are handled by the direct hits above).
  const clamped = Math.max(0, Math.min(30, cr));
  const rounded = Math.round(clamped);
  return XP_BY_CR[String(rounded)] ?? 0;
}

/** XP thresholds for one PC level (clamped to the 1..20 table). */
export function xpThresholdsForLevel(level: number): { easy: number; medium: number; hard: number; deadly: number } {
  const clamped = Math.max(1, Math.min(20, Math.floor(level)));
  return XP_THRESHOLDS_BY_LEVEL[clamped];
}

/**
 * 5e "encounter multiplier" for the number of monsters — a larger group is more
 * dangerous than its raw XP sum (action economy). 1 -> ×1, 2 -> ×1.5, 3–6 -> ×2,
 * 7–10 -> ×2.5, 11–14 -> ×3, 15+ -> ×4.
 */
export function encounterMultiplier(monsterCount: number): number {
  if (monsterCount <= 0) return 0;
  if (monsterCount === 1) return 1;
  if (monsterCount === 2) return 1.5;
  if (monsterCount <= 6) return 2;
  if (monsterCount <= 10) return 2.5;
  if (monsterCount <= 14) return 3;
  return 4;
}

const DND5E_ASSUMPTIONS = [
  'Uses D&D 5e DMG XP thresholds by character level.',
  'Monster XP comes from the DMG CR→XP table.',
  'Applies the DMG number-of-monsters encounter multiplier (action economy).',
] as const;

function emptyThresholds(): EncounterDifficulty['thresholds'] {
  return { easy: 0, medium: 0, hard: 0, deadly: 0 };
}

/**
 * Build an explicit unsupported difficulty result for a non-5e (or homebrew) campaign
 * so the UI can hide or explain the limitation instead of showing a fake 5e band.
 */
export function unsupportedEncounterDifficulty(
  systemLabel: string,
  input: EncounterDifficultyInput = { partyLevels: [], monsterChallengeRatings: [] },
): EncounterDifficulty {
  const monsterCount = input.monsterChallengeRatings.length;
  return {
    status: 'unsupported',
    label: `Not calculated for ${systemLabel}`,
    band: null,
    thresholds: emptyThresholds(),
    partySize: input.partyLevels.length,
    partyLevels: [...input.partyLevels],
    monsterCount,
    totalMonsterXp: 0,
    multiplier: 0,
    adjustedXp: 0,
    monstersMissingRating: 0,
    warnings: [`${systemLabel} has no built-in encounter XP/CR budget — difficulty is not estimated.`],
    assumptions: [],
  };
}

/**
 * Compute an encounter's 5e difficulty band from the party's PC levels and the
 * combatant monsters' CRs (issue #58), with explicit unknown/unsupported handling
 * so zero-data fights are never labelled Trivial (issue #429).
 */
export function computeDnd5eEncounterDifficulty(input: EncounterDifficultyInput): EncounterDifficulty {
  const partyLevels = input.partyLevels;
  const monsterCrs = input.monsterChallengeRatings;
  const thresholds = emptyThresholds();
  for (const level of partyLevels) {
    const t = xpThresholdsForLevel(level);
    thresholds.easy += t.easy;
    thresholds.medium += t.medium;
    thresholds.hard += t.hard;
    thresholds.deadly += t.deadly;
  }

  const monstersMissingRating = monsterCrs.filter((cr) => cr === null).length;
  const totalMonsterXp = monsterCrs.reduce<number>((sum, cr) => sum + crToXp(cr), 0);
  const monsterCount = monsterCrs.length;
  const multiplier = encounterMultiplier(monsterCount);
  const adjustedXp = Math.round(totalMonsterXp * multiplier);

  const warnings: string[] = [];
  if (partyLevels.length === 0 && monsterCount > 0) {
    warnings.push('No PC levels in this encounter — party XP thresholds are unknown.');
  }
  if (monstersMissingRating > 0) {
    warnings.push(
      monstersMissingRating === 1
        ? '1 monster has no CR/XP and was omitted from the XP total.'
        : `${monstersMissingRating} monsters have no CR/XP and were omitted from the XP total.`,
    );
  }
  if (monsterCount >= 3 && adjustedXp > 0) {
    warnings.push(
      `Action economy: ${monsterCount} monsters apply a ×${multiplier} encounter multiplier.`,
    );
  }

  // Manual / incomplete enemies with no CR/XP must not read as an authoritative Trivial fight.
  if (monsterCount > 0 && totalMonsterXp === 0 && monstersMissingRating > 0) {
    return {
      status: 'unknown',
      label: UNKNOWN_DIFFICULTY_LABEL,
      band: null,
      thresholds,
      partySize: partyLevels.length,
      partyLevels: [...partyLevels],
      monsterCount,
      totalMonsterXp: 0,
      multiplier,
      adjustedXp: 0,
      monstersMissingRating,
      warnings,
      assumptions: [...DND5E_ASSUMPTIONS],
    };
  }

  let band: DifficultyBand = 'trivial';
  if (partyLevels.length > 0 && adjustedXp > 0) {
    if (adjustedXp >= thresholds.deadly) band = 'deadly';
    else if (adjustedXp >= thresholds.hard) band = 'hard';
    else if (adjustedXp >= thresholds.medium) band = 'medium';
    else if (adjustedXp >= thresholds.easy) band = 'easy';
    else band = 'trivial';
  }

  return {
    status: 'ok',
    label: DIFFICULTY_BAND_LABELS[band],
    band,
    thresholds,
    partySize: partyLevels.length,
    partyLevels: [...partyLevels],
    monsterCount,
    totalMonsterXp,
    multiplier,
    adjustedXp,
    monstersMissingRating,
    warnings,
    assumptions: [...DND5E_ASSUMPTIONS],
  };
}

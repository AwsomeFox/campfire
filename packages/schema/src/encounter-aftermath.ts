import { z } from 'zod';
import { EncounterDifficulty } from './encounter-difficulty';

const Id = z.number().int().positive();
const IsoDate = z.string();

/** One combatant line in the ended-encounter outcome review (issue #473). */
export const EncounterAftermathCombatant = z.object({
  name: z.string(),
  kind: z.enum(['character', 'monster', 'npc']),
});
export type EncounterAftermathCombatant = z.infer<typeof EncounterAftermathCombatant>;

export const EncounterAftermathOutcome = z.object({
  rounds: z.number().int().nonnegative(),
  dead: z.array(EncounterAftermathCombatant),
  downed: z.array(EncounterAftermathCombatant),
  survivors: z.array(EncounterAftermathCombatant),
});
export type EncounterAftermathOutcome = z.infer<typeof EncounterAftermathOutcome>;

/** Adapter-aware XP suggestion derived from the encounter difficulty estimate. */
export const EncounterAftermathXp = z.object({
  supported: z.boolean(),
  /** Raw monster XP awarded when the ruleset could score the fight. */
  suggestedPartyTotal: z.number().int().nonnegative().nullable(),
  /** Even split across character combatants in the fight (rounded down). */
  suggestedPerCharacter: z.number().int().nonnegative().nullable(),
  /** XP left after an even per-character split; null when no split is available. */
  undistributedXp: z.number().int().nonnegative().nullable(),
  difficultyLabel: z.string(),
  warnings: z.array(z.string()),
});
export type EncounterAftermathXp = z.infer<typeof EncounterAftermathXp>;

/** Deep-link targets for loot, XP, quest, and recap hand-offs (issue #473). */
export const EncounterAftermathHandoffs = z.object({
  recapPath: z.string(),
  awardXpPath: z.string(),
  inventoryPath: z.string(),
  questPath: z.string().nullable(),
  sessionPath: z.string().nullable(),
  encounterLogPath: z.string(),
});
export type EncounterAftermathHandoffs = z.infer<typeof EncounterAftermathHandoffs>;

/**
 * Read model for the post-encounter aftermath workflow (issue #473): outcome review,
 * recap draft seeded from combat events, adapter-aware XP guidance, and hand-off links.
 * `dismissedAt` is set when the DM defers the panel (idempotent resume).
 */
export const EncounterAftermath = z.object({
  encounterId: Id,
  campaignId: Id,
  outcome: EncounterAftermathOutcome,
  recapDraft: z.string(),
  /** Notable combat-log lines woven into the recap scaffold. */
  combatLogHighlights: z.array(z.string()),
  xp: EncounterAftermathXp,
  difficulty: EncounterDifficulty,
  handoffs: EncounterAftermathHandoffs,
  questId: Id.nullable(),
  sessionId: Id.nullable(),
  locationId: Id.nullable(),
  dismissedAt: IsoDate.nullable(),
});
export type EncounterAftermath = z.infer<typeof EncounterAftermath>;

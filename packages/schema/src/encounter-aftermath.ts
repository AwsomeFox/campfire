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

/** Single loot item in an aftermath package (issue #1448). */
export const EncounterAftermathLootItem = z.object({
  id: z.string(),
  name: z.string(),
  qty: z.number().int().min(1).default(1),
  notes: z.string().default(''),
  claimed: z.boolean().default(false),
  claimedByCharacterId: Id.nullable().default(null),
  claimedToParty: z.boolean().default(false),
});
export type EncounterAftermathLootItem = z.infer<typeof EncounterAftermathLootItem>;

/** Currency loot in an aftermath package (issue #1448). */
export const EncounterAftermathCoins = z.object({
  cp: z.number().int().min(0).default(0),
  sp: z.number().int().min(0).default(0),
  ep: z.number().int().min(0).default(0),
  gp: z.number().int().min(0).default(0),
  pp: z.number().int().min(0).default(0),
});
export type EncounterAftermathCoins = z.infer<typeof EncounterAftermathCoins>;

/** Loot summary for aftermath (issue #1448). */
export const EncounterAftermathLoot = z.object({
  items: z.array(EncounterAftermathLootItem),
  coins: EncounterAftermathCoins,
  coinsClaimed: z.boolean().default(false),
});
export type EncounterAftermathLoot = z.infer<typeof EncounterAftermathLoot>;

/** Input for applying XP / milestone award from aftermath (issue #1448). */
export const EncounterAftermathApplyXpInput = z.object({
  amount: z.number().int().min(1).optional(),
  characterIds: z.array(Id).optional(),
  isMilestone: z.boolean().optional(),
  milestoneNote: z.string().optional(),
});
export type EncounterAftermathApplyXpInput = z.infer<typeof EncounterAftermathApplyXpInput>;

/** Input for transferring loot from aftermath to inventory or treasury (issue #1448). */
export const EncounterAftermathLootTransferInput = z.object({
  itemId: z.string().optional(),
  ownerType: z.enum(['character', 'party']).default('party').optional(),
  characterId: Id.nullable().optional(),
  qty: z.number().int().min(1).optional(),
  transferCoins: EncounterAftermathCoins.partial().optional(),
});
export type EncounterAftermathLootTransferInput = z.infer<typeof EncounterAftermathLootTransferInput>;

/** Input for updating quest objectives / status from aftermath (issue #1448). */
export const EncounterAftermathQuestUpdateInput = z.object({
  questId: Id,
  objectiveIndex: z.number().int().min(0).optional(),
  objectiveCompleted: z.boolean().optional(),
  questStatus: z.enum(['available', 'active', 'completed', 'failed']).optional(),
  note: z.string().optional(),
});
export type EncounterAftermathQuestUpdateInput = z.infer<typeof EncounterAftermathQuestUpdateInput>;

/** Input for updating or creating a storyline beat from aftermath (issue #1448). */
export const EncounterAftermathBeatUpdateInput = z.object({
  beatId: Id.optional(),
  arcId: Id.optional(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
  status: z.enum(['planned', 'active', 'done', 'skipped']).optional(),
});
export type EncounterAftermathBeatUpdateInput = z.infer<typeof EncounterAftermathBeatUpdateInput>;

/** Input for adding a timeline event from aftermath (issue #1448). */
export const EncounterAftermathTimelineEventInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(50_000).optional(),
  inGameDate: z.string().optional(),
  era: z.string().optional(),
  sortIndex: z.number().int().optional(),
});
export type EncounterAftermathTimelineEventInput = z.infer<typeof EncounterAftermathTimelineEventInput>;

/**
 * Read model for the post-encounter aftermath workflow (issue #473, #1448): outcome review,
 * recap draft seeded from combat events, adapter-aware XP guidance, in-panel XP and loot transfers,
 * quest/storyline/timeline mutation controls, and hand-off links.
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
  xpAwardedAt: IsoDate.nullable(),
  xpAwarded: z.boolean(),
  milestoneMode: z.boolean(),
  loot: EncounterAftermathLoot,
  difficulty: EncounterDifficulty,
  handoffs: EncounterAftermathHandoffs,
  questId: Id.nullable(),
  sessionId: Id.nullable(),
  locationId: Id.nullable(),
  dismissedAt: IsoDate.nullable(),
});
export type EncounterAftermath = z.infer<typeof EncounterAftermath>;


/**
 * Campfire domain contract — single source of truth.
 *
 * Every API DTO, OpenAPI shape, and (later) MCP tool schema derives from these
 * Zod schemas. Server and web import types from here; neither redefines domain shapes.
 *
 * Conventions:
 *  - ids are integer PKs (SQLite rowid-friendly)
 *  - timestamps are ISO strings set by the server
 *  - `dmSecret` fields exist on canon entities and are STRIPPED server-side for non-DM
 *  - Create/Update input schemas are derived from the entity schema
 */
import { z } from 'zod';
import {
  DifficultyBand,
  EncounterDifficulty,
  EncounterDifficultyStatus,
  DIFFICULTY_BAND_LABELS,
  UNKNOWN_DIFFICULTY_LABEL,
  parseCr,
  crToXp,
  xpThresholdsForLevel,
  encounterMultiplier,
  computeDnd5eEncounterDifficulty,
  unsupportedEncounterDifficulty,
  type EncounterDifficultyInput,
} from './encounter-difficulty';
import {
  initModDescThenSortOrderAsc,
  sortOrderAscTiebreak,
  type InitiativeTiebreakCombatant,
} from './initiative-tiebreak';

export {
  DifficultyBand,
  EncounterDifficultyStatus,
  EncounterDifficulty,
  DIFFICULTY_BAND_LABELS,
  UNKNOWN_DIFFICULTY_LABEL,
  parseCr,
  crToXp,
  xpThresholdsForLevel,
  encounterMultiplier,
  computeDnd5eEncounterDifficulty,
  unsupportedEncounterDifficulty,
  initModDescThenSortOrderAsc,
  sortOrderAscTiebreak,
};
export type { EncounterDifficultyInput };
export type { InitiativeTiebreakCombatant };

// ---------- shared ----------
export const Role = z.enum(['dm', 'player', 'viewer']);
export type Role = z.infer<typeof Role>;

export const Id = z.number().int().positive();
export const IsoDate = z.string(); // ISO-8601, server-assigned

const timestamps = {
  createdAt: IsoDate,
  updatedAt: IsoDate,
};

// ---------- pagination (issue #71) ----------
// Shared list-pagination convention. High-volume list endpoints (sessions, notes,
// audit) and their MCP equivalents accept optional `?limit` & `?offset` query
// params, pushed down into SQL. When both are omitted the endpoint returns its
// full (or historically-capped) result, so existing callers are unaffected —
// pagination is opt-in. `limit` is clamped to a per-endpoint maximum server-side.
export const PageParams = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type PageParams = z.infer<typeof PageParams>;

// ---------- optimistic concurrency (issue #157) ----------
// The `updatedAt` timestamp a client last read for an entity, echoed back on a
// PATCH/update as a compare-and-swap guard. When provided and it no longer matches
// the row's current `updatedAt` (someone else — a co-DM, or a connected AI over MCP
// — saved in the meantime), the write is rejected with 409 Conflict instead of blindly
// overwriting their edit. Omitted => unconditional write (unchanged back-compat). Kept
// OUT of the entity Create/Update schemas on purpose: it's a request-time concern, not
// a stored field, and must never leak into a proposal payload — the server DTO layer and
// the MCP update tools attach it explicitly.
export const ExpectedUpdatedAt = z
  .string()
  .max(64)
  .optional()
  .describe(
    'Optimistic-concurrency guard: the `updatedAt` timestamp you last read for this entity. If provided and it no ' +
      'longer matches the stored row (someone else saved since you loaded it), the update is rejected with 409 ' +
      'Conflict instead of silently overwriting their edit. Omit to force an unconditional write.',
  );

// ---------- campaign ----------
export const DangerLevel = z.enum(['low', 'moderate', 'high', 'deadly']);

export const Campaign = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(10_000).default(''),
  status: z.enum(['active', 'paused', 'completed']).default('active'),
  currentLocationId: Id.nullable().default(null),
  dangerLevel: DangerLevel.default('low'),
  // When true, only the DM may award XP / level up characters (issue #270); when false
  // (default) any character owner may self-progress, preserving the original behavior.
  dmControlsProgression: z.boolean().default(false),
  // Campaign-level privacy kill switch for unauthenticated recap links. This is
  // mutated through the dedicated session-share policy endpoint so disabling it
  // can atomically revoke every active capability rather than leaving old URLs
  // ready to spring back to life when the setting is re-enabled.
  publicRecapSharingEnabled: z.boolean().default(true),
  // Campaign-level join-link kill switch (issue #857). Archive/trash auto-clears
  // this so paused/completed/trashed campaigns stop disclosing via bearer invite
  // links; restoring the campaign does NOT flip it back — the DM must deliberately
  // re-enable via PUT /campaigns/:id/invites/policy. Distinct from revoke-all
  // (row delete): suspension keeps invite rows so a deliberate reactivation can
  // restore the same codes.
  publicInvitesEnabled: z.boolean().default(true),
  sessionCount: z.number().int().nonnegative().default(0),
  ruleSystem: z.string().max(80).default(''), // slug of the installed rule pack (see RulePack), or '' if none picked
  mapAttachmentId: Id.nullable().default(null), // Attachment (kind='map') rendered as the campaign map background
  // Per-campaign upload quota in bytes, or null for no limit (issue #24). Set by a
  // server admin via the storage console — NOT part of CampaignCreate/Update, so a
  // DM can never lift their own campaign's cap. Enforced on attachment upload.
  storageQuotaBytes: z.number().int().nonnegative().nullable().default(null),
  // Soft-delete / trash timestamp (issue #116). Non-null => the campaign is in the
  // trash: excluded from normal listings but its rows + on-disk uploads survive for a
  // grace period, restorable via POST /campaigns/:id/restore. A deliberate second
  // step (DELETE /campaigns/:id/purge) is what finally hard-cascades + wipes the disk.
  deletedAt: IsoDate.nullable().default(null),
  ...timestamps,
});
export type Campaign = z.infer<typeof Campaign>;
export const CampaignCreate = Campaign.omit({ id: true, createdAt: true, updatedAt: true, sessionCount: true, storageQuotaBytes: true, deletedAt: true, publicRecapSharingEnabled: true, publicInvitesEnabled: true }).partial({ description: true, status: true, currentLocationId: true, dangerLevel: true, dmControlsProgression: true, ruleSystem: true, mapAttachmentId: true });
export const CampaignUpdate = CampaignCreate.partial();

// Clone/template input — POST /campaigns/:id/clone.
//  - 'full': faithful duplicate (everything except members, attachments and audit/proposals/tokens)
//  - 'template': prep only (quests reset to available, objectives unchecked, npcs, locations
//    reset to unexplored) — play state (sessions, notes, encounters, characters, session count,
//    current party location) is stripped so the copy starts fresh.
export const CampaignCloneMode = z.enum(['full', 'template']);
export const CampaignClone = z.object({
  name: z.string().min(1).max(120).optional(), // defaults server-side to "<source name> (copy)"
  mode: CampaignCloneMode.default('full'),
});

// Import input — POST /campaigns/import (issue #120). The body is a Campfire JSON
// export (the shape ExportService.buildExport produces): make the one-way export
// round-trippable by re-creating the campaign from it. Validated permissively —
// only `campaign.name` is truly required, and unknown/extra keys (attachmentsNote,
// members, audit, proposals, …) are tolerated via .passthrough() so a real export
// document is accepted verbatim. All entity ids in the document are treated as
// source ids and remapped to fresh ids on import; the entities themselves are read
// defensively field-by-field in the service, so a loose object[] is enough here.
const ImportedEntity = z.object({}).passthrough();
export const CampaignImport = z
  .object({
    // Optional override for the imported campaign's name (defaults to the export's own).
    name: z.string().min(1).max(120).optional(),
    campaign: z.object({ name: z.string().min(1).max(120) }).passthrough(),
    locations: z.array(ImportedEntity).optional(),
    npcs: z.array(ImportedEntity).optional(),
    quests: z.array(ImportedEntity).optional(),
    characters: z.array(ImportedEntity).optional(),
    sessions: z.array(ImportedEntity).optional(),
    notes: z.array(ImportedEntity).optional(),
    comments: z.array(ImportedEntity).optional(),
    encounters: z.array(ImportedEntity).optional(),
    // Issue #266: entity types the export previously dropped and now round-trips.
    // Arrays are loose objects (remapped defensively in the service); the two
    // single-row records (calendar, charter) and treasury are loose objects too.
    factions: z.array(ImportedEntity).optional(),
    storyArcs: z.array(ImportedEntity).optional(), // each arc nests beats -> branches
    timelineEvents: z.array(ImportedEntity).optional(),
    timelineCalendar: ImportedEntity.optional(),
    sessionZero: ImportedEntity.optional(),
    inventory: z.array(ImportedEntity).optional(),
    treasury: ImportedEntity.optional(),
    // Issue #813: immutable prose versions (author + replacer provenance) round-trip
    // with remapped entity / restoredFrom ids. Loose objects — the importer is defensive.
    revisions: z.array(ImportedEntity).optional(),
  })
  .passthrough();
export type CampaignImport = z.infer<typeof CampaignImport>;

// ---------- per-campaign trash (issue #269) ----------
// The soft-delete/undo feature (#116) gave every trashable entity a `deleted_at`
// column + a POST /<type>/:id/restore endpoint, but the only Trash UI was for whole
// trashed *campaigns* on the home page — a soft-deleted entity was unrecoverable once
// its Undo toast expired. GET /campaigns/:id/trash lists a campaign's soft-deleted
// child entities (DM-only) as these lightweight rows: enough to render a Trash page
// and drive Restore (POST /<type>/:id/restore). `type` is the entity kind, mapped to
// its restore route by pluralizing (session -> /sessions/:id/restore, etc.).
export const TrashedEntityType = z.enum(['session', 'character', 'quest', 'npc', 'location']);
export type TrashedEntityType = z.infer<typeof TrashedEntityType>;

export const TrashedEntity = z.object({
  type: TrashedEntityType,
  id: Id,
  // A human label for the row (session title/number, character/npc/location name,
  // quest title) — never a secret field, so it is safe to show the DM.
  name: z.string(),
  deletedAt: IsoDate,
});
export type TrashedEntity = z.infer<typeof TrashedEntity>;

// ---------- character ----------
// characters.ownerUserId is stored as TEXT (it must also hold 'dev:<name>' dev-auth ids)
// while users.id / CampaignMember.userId are integers — the historical type mismatch of
// issue #32. Inputs accept either shape and normalize to the canonical string form
// (String(users.id)), so a DM can pass a member's numeric userId straight through.
export const UserIdRef = z.union([z.string().max(120), Id.transform((n) => String(n))]);

export const AbilityKey = z.enum(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']);
export type AbilityKey = z.infer<typeof AbilityKey>;

/** Canonical ability keys in sheet order. */
export const ABILITY_KEYS = AbilityKey.options;

/**
 * Fold an ability-score record to canonical uppercase keys (STR/DEX/…). The stats
 * record is typed `z.record(z.string(), …)`, so any key case is schema-valid, and an
 * API/MCP writer may store lowercase keys (`{ str: 16 }`). Callers that look scores up
 * by canonical key — the character sheet, and the initiative engine's `stats.DEX` —
 * would otherwise miss every lowercase entry and read a default of 10 (issue #48).
 * An exact-uppercase key is authoritative, so a lowercase duplicate never clobbers it.
 */
export function normalizeStats(stats: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!stats) return out;
  for (const [key, value] of Object.entries(stats)) {
    const upper = key.toUpperCase();
    if (upper in out && key !== upper) continue;
    out[upper] = value;
  }
  return out;
}

/** Skill proficiency rank; a skill absent from the record is unproficient. */
export const SkillRank = z.enum(['proficient', 'expertise']);
export type SkillRank = z.infer<typeof SkillRank>;

/**
 * 5e death-save lifecycle (issue #57 / #711). Lives on every Combatant AND, since
 * #711, on the persistent Character row as the post-encounter reconciliation echo.
 * - `none`: alive (hp > 0), or a monster (monsters don't roll death saves — 0 HP
 *   is simply "down"); death-save counters are held at 0.
 * - `dying`: a character at 0 HP, rolling death saves (successes/failures 0–2).
 * - `stable`: a character at 0 HP that reached 3 successes (or was stabilized) —
 *   unconscious but no longer rolling. Any further damage flips back to `dying`.
 * - `dead`: 3 death-save failures, OR instant death from massive damage
 *   (a single hit whose overflow past 0 HP is >= hpMax).
 *
 * Declared up here (ahead of Character) so Character can reference it for its
 * persistent echo; the Combatant below reuses the same enum.
 */
export const DeathState = z.enum(['none', 'dying', 'stable', 'dead']);
export type DeathState = z.infer<typeof DeathState>;

/**
 * Character lifecycle (issue #115). Only `active` PCs are auto-conscripted into a
 * new encounter's combatant list; dead/retired/inactive characters stay on the
 * roster (viewable, full sheet + history intact) but are skipped by the auto-add
 * so a long campaign's graveyard of fallen and replaced PCs stops being force-added
 * to every fight. Deleting a character remains the destructive alternative — this
 * is the non-destructive shelf.
 */
export const CharacterStatus = z.enum(['active', 'dead', 'retired', 'inactive']);
export type CharacterStatus = z.infer<typeof CharacterStatus>;

/** One row in the Actions card — attack, spell, or feature. toHit/damage are free text ("+5", "1d8+3 slashing") so non-attack actions stay valid. */
export const CharacterAction = z.object({
  name: z.string().min(1).max(120),
  kind: z.string().max(40).default(''), // "melee", "ranged", "spell", "feature"…
  toHit: z.string().max(20).default(''),
  damage: z.string().max(80).default(''),
  notes: z.string().max(500).default(''),
});
export type CharacterAction = z.infer<typeof CharacterAction>;

/** Slots at one spell level. `used` is clamped server-side to [0, max]. */
export const SpellSlotLevel = z.object({
  max: z.number().int().min(0).max(20),
  used: z.number().int().min(0).max(20).default(0),
});
export type SpellSlotLevel = z.infer<typeof SpellSlotLevel>;

export const Character = z.object({
  id: Id,
  campaignId: Id,
  // Owning player's user id as a string — String(users.id) for real accounts, 'dev:<name>'
  // under DEV_AUTH; null = DM-managed. Kept in sync with CampaignMember.characterId links
  // (linking a member to a character grants them ownership — see MembersService).
  ownerUserId: UserIdRef.nullable().default(null),
  name: z.string().min(1).max(120),
  species: z.string().max(80).default(''),
  className: z.string().max(80).default(''),
  level: z.number().int().min(1).max(20).default(1),
  xp: z.number().int().min(0).default(0),
  background: z.string().max(120).default(''),
  // Lifecycle state (issue #115). `active` is the only status auto-added as a combatant
  // on encounter create; dead/retired/inactive PCs are kept but skipped. Editable by the
  // owning player or DM through the normal update path (and upsert_character over MCP).
  status: CharacterStatus.default('active').describe(
    "Lifecycle status: 'active' (default; auto-added to new encounters), 'dead', 'retired', or 'inactive'. Non-active PCs stay on the roster but are skipped by encounter auto-add.",
  ),
  stats: z.record(z.string(), z.number().int()).default({}), // e.g. { STR: 8, DEX: 14 }
  ac: z.number().int().nullable().default(null),
  hpCurrent: z.number().int().default(10),
  hpMax: z.number().int().min(1).default(10),
  // Issue #711: persistent echo of the per-combatant death/temp-HP subsystem
  // (originally issue #57). The encounter tracker is the source of truth during
  // a fight; on /end these four fields are reconciled back onto the sheet so a
  // dead PC stays dead (and stays off the next encounter's auto-add), a stable
  // PC keeps its unconscious state, and a leftover temp-HP pool carries forward.
  // Defaults mirror Combatant's so a pre-#711 sheet reads as alive + temp-less.
  hpTemp: z.number().int().min(0).default(0),
  deathState: DeathState.default('none'),
  deathSaveSuccesses: z.number().int().min(0).max(3).default(0),
  deathSaveFailures: z.number().int().min(0).max(3).default(0),
  conditions: z.array(z.string().max(40)).default([]),
  saveProficiencies: z.array(AbilityKey).default([]), // abilities with saving-throw proficiency
  skills: z.record(z.string().max(40), SkillRank).default({}), // skill name -> rank; absent = unproficient
  actions: z.array(CharacterAction).max(100).default([]),
  spellSlots: z.record(z.string().regex(/^[1-9]$/), SpellSlotLevel).default({}), // spell level "1".."9" -> slots
  portraitUrl: z.string().max(500).nullable().default(null),
  ddbId: z.string().max(40).nullable().default(null),
  notes: z.string().max(20_000).default(''), // public character bio/story
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM (a secret curse, hidden true identity…)
  ...timestamps,
});
export type Character = z.infer<typeof Character>;
export const CharacterCreate = Character.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const CharacterUpdate = CharacterCreate.partial();

/**
 * Request body for importing a character from a PUBLIC D&D Beyond sheet (issue #18).
 * The importer is unofficial and read-only — it reads the public character-service
 * JSON that D&D Beyond exposes for characters whose privacy is set to Public. Callers
 * pass either the raw numeric character id (`ddbId`) or a share/character URL (`url`,
 * e.g. https://www.dndbeyond.com/characters/12345678); at least one is required. `url`
 * (base-URL override, mainly for tests pointing at a fake server) is separate from the
 * `url` that carries a character link — the server derives the id from whichever of
 * ddbId/url is present.
 */
export const DdbCharacterImport = z
  .object({
    ddbId: z.string().max(200).optional(),
    url: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.ddbId?.trim() || v.url?.trim()), {
    message: 'Provide a D&D Beyond character id (ddbId) or a character URL (url)',
  });
export type DdbCharacterImport = z.infer<typeof DdbCharacterImport>;

export const HpPatch = z.union([
  z.object({ delta: z.number().int() }),
  z.object({ set: z.number().int().nonnegative() }),
]);
export const ConditionsPatch = z.object({
  add: z.array(z.string().max(40)).optional(),
  remove: z.array(z.string().max(40)).optional(),
});
/**
 * Canonical 5e condition vocabulary — the single source of truth shared across
 * the character sheet, the encounter tracker, and the compendium (issue #111).
 * The wire schema stays `string` (DM homebrew is allowed), but non-DM combatant
 * adds are validated against the active adapter's list (issue #495). These are
 * also the standard names surfaced as suggestions so the three surfaces speak
 * the same vocabulary instead of each hardcoding its own list.
 */
export const CONDITIONS = [
  'Blinded',
  'Charmed',
  'Deafened',
  'Exhaustion',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Invisible',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Stunned',
  'Unconscious',
] as const;
export type ConditionName = (typeof CONDITIONS)[number];

/**
 * Case-insensitive membership check against a rule-system condition vocabulary
 * (issue #495). Trims the candidate; empty strings never match.
 */
export function isKnownCondition(vocab: readonly string[], name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return vocab.some((c) => c.toLowerCase() === needle);
}
/** Spend (+delta) or restore (-delta) slots at one level; `used` is clamped to [0, max]. Slot maxima are edited via PATCH `spellSlots`. */
export const SpellSlotPatch = z.object({
  level: z.number().int().min(1).max(9),
  delta: z.number().int(),
});
export const XpPatch = z.union([
  z.object({ delta: z.number().int() }),
  z.object({ set: z.number().int().nonnegative() }),
]);
/**
 * DM party XP award. Omitting `characterIds` targets active characters only.
 * A non-active (inactive, retired, or dead) recipient is accepted only when the
 * caller explicitly opts in with `includeNonActive: true`; this keeps archived
 * careers safe while preserving deliberate historical corrections.
 */
export const XpAward = z.object({
  amount: z.number().int().min(1).max(1_000_000),
  characterIds: z
    .array(Id)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Recipient characterIds must be unique' })
    .optional(),
  includeNonActive: z.boolean().optional().default(false).describe(
    'Explicit opt-in required to award XP to inactive, retired, or dead characters.',
  ),
});
/**
 * Guided level-up: +1 level, optionally raising hpMax (hpCurrent grows by the
 * same amount — you gain the new hit points, existing damage stays).
 * Intentionally NOT gated on xp thresholds — milestone-levelling tables level
 * without XP, so the threshold check is advisory (see xpForLevel/levelForXp).
 */
export const LevelUp = z.object({
  hpMax: z.number().int().min(1).optional(),
});

/**
 * D&D 5e cumulative XP thresholds; XP_THRESHOLDS[n] = total XP required to be
 * level n+1 (so index 0 = level 1 at 0 XP, index 19 = level 20 at 355,000 XP).
 */
export const XP_THRESHOLDS = [
  0, 300, 900, 2_700, 6_500, 14_000, 23_000, 34_000, 48_000, 64_000, 85_000, 100_000, 120_000, 140_000, 165_000,
  195_000, 225_000, 265_000, 305_000, 355_000,
] as const;

/** Total XP required to reach `level` (clamped to [1, 20]). */
export function xpForLevel(level: number): number {
  return XP_THRESHOLDS[Math.max(1, Math.min(20, Math.floor(level))) - 1];
}

/** Highest level the given total XP qualifies for (1–20). */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

// ---------- quest ----------
export const QUEST_STATUSES = ['available', 'active', 'completed', 'failed'] as const;
export const QuestStatus = z.enum(QUEST_STATUSES);

export const QuestObjective = z.object({
  id: Id,
  questId: Id,
  text: z.string().min(1).max(500),
  done: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type QuestObjective = z.infer<typeof QuestObjective>;

export const Quest = z.object({
  id: Id,
  campaignId: Id,
  parentId: Id.nullable().default(null), // subquests
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).default(''), // markdown
  status: QuestStatus.default('available'),
  giverNpcId: Id.nullable().default(null),
  reward: z.string().max(500).default(''),
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM
  // Entity-level secrecy (issue #42): a hidden quest is excluded WHOLESALE from
  // every non-DM read (list/get/summary/export) — not merely dmSecret-redacted.
  // Default false = visible; the DM sets it true to prep future content, then
  // "reveals" by patching it back to false.
  hidden: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  ...timestamps,
});
export type Quest = z.infer<typeof Quest>;
export const QuestCreate = Quest.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ title: true });
export const QuestUpdate = QuestCreate.partial();
export const QuestStatusPatch = z.object({ status: QuestStatus });
export const ObjectiveCreate = z.object({ text: z.string().min(1).max(500), sortOrder: z.number().int().optional() });
export const ObjectivePatch = z.object({ text: z.string().min(1).max(500).optional(), done: z.boolean().optional(), sortOrder: z.number().int().optional() });
// Reorder a quest's objectives in one atomic call: `objectiveIds` must be a
// permutation of exactly that quest's current objective ids; the server assigns
// sortOrder by array index. Cleaner (and race-free) than N per-objective PATCHes.
export const ObjectiveReorder = z.object({ objectiveIds: z.array(Id).min(1) });
export type ObjectiveReorder = z.infer<typeof ObjectiveReorder>;

// Bounded quest-board projection (issue #786). The list endpoint exposes objective
// progress and at most one objective body: the first incomplete objective in the
// DM-controlled order. Full objective collections remain on the quest detail and
// campaign-summary contracts, so a large quest cannot inflate every board load.
export const QuestListObjective = QuestObjective.pick({ id: true, text: true });
export type QuestListObjective = z.infer<typeof QuestListObjective>;
export const QuestListItem = Quest.extend({
  objectiveProgress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  nextObjective: QuestListObjective.nullable(),
});
export type QuestListItem = z.infer<typeof QuestListItem>;

// "What changed since last session" (issue #66). `since` is the reference instant
// the diff was taken against — by default the campaign's latest session date
// (max of each session's playedAt, falling back to its createdAt), or the caller's
// explicit `?since=` override (e.g. the player's last visit). `quests` are the
// visible quests whose updatedAt is at/after `since`, in board order. `since` is
// null when the campaign has no sessions to diff against — then `quests` is empty.
// A quest is "new" when its createdAt is also at/after `since`, otherwise "changed"
// (the client derives this from the returned createdAt to keep the payload a plain
// Quest list). Respects redaction + hidden filtering like every other quest read.
export const QuestChanges = z.object({
  since: IsoDate.nullable(),
  quests: z.array(Quest),
});
export type QuestChanges = z.infer<typeof QuestChanges>;

// ---------- storylines (issue #27) ----------
// A branching story/arc planner for the DM to plan FUTURE beats with branching
// options. An Arc groups ordered Beats; each Beat carries ordered Branches, where
// a branch is a labelled next-option (trigger label + optional target beat). The
// whole surface is DM-only — it is prep/planning content, never exposed to players.
export const ArcStatus = z.enum(['planned', 'active', 'resolved', 'abandoned']);
export type ArcStatus = z.infer<typeof ArcStatus>;

export const BeatStatus = z.enum(['planned', 'active', 'done', 'skipped']);
export type BeatStatus = z.infer<typeof BeatStatus>;

// A branch is a directed, labelled edge FROM a beat TO an optional next beat.
// `toBeatId` is nullable so the DM can sketch an option ("players betray the king")
// before its destination beat exists; `label` is the trigger/condition text.
export const StoryBranch = z.object({
  id: Id,
  beatId: Id,
  toBeatId: Id.nullable().default(null),
  label: z.string().min(1).max(200),
  sortOrder: z.number().int().default(0),
});
export type StoryBranch = z.infer<typeof StoryBranch>;
export const StoryBranchCreate = z.object({
  toBeatId: Id.nullable().optional(),
  label: z.string().min(1).max(200),
  sortOrder: z.number().int().optional(),
});
export type StoryBranchCreate = z.infer<typeof StoryBranchCreate>;

export const StoryBeat = z.object({
  id: Id,
  campaignId: Id,
  arcId: Id,
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).default(''), // markdown — the DM's notes for the beat
  status: BeatStatus.default('planned'),
  sortOrder: z.number().int().default(0),
  // Optional links to the play record this planned beat corresponds to (issue #264) —
  // WHEN it landed (session), the quest it advanced, and the encounter that resolved it.
  // Mirrors how Encounter carries its location/quest/session links (issue #126). All
  // nullable; absent in older DBs pre-migration (0036_story_beats_links).
  sessionId: Id.nullable().default(null),
  questId: Id.nullable().default(null),
  encounterId: Id.nullable().default(null),
  ...timestamps,
});
export type StoryBeat = z.infer<typeof StoryBeat>;
// arcId is set from the create URL, never the body.
export const StoryBeatCreate = StoryBeat.omit({ id: true, campaignId: true, arcId: true, createdAt: true, updatedAt: true }).partial().required({ title: true });
export type StoryBeatCreate = z.infer<typeof StoryBeatCreate>;
export const StoryBeatUpdate = StoryBeatCreate.partial();
export type StoryBeatUpdate = z.infer<typeof StoryBeatUpdate>;
export const StoryBeatStatusPatch = z.object({ status: BeatStatus });
export type StoryBeatStatusPatch = z.infer<typeof StoryBeatStatusPatch>;

export const StoryArc = z.object({
  id: Id,
  campaignId: Id,
  title: z.string().min(1).max(200),
  summary: z.string().max(50_000).default(''), // markdown
  status: ArcStatus.default('planned'),
  sortOrder: z.number().int().default(0),
  ...timestamps,
});
export type StoryArc = z.infer<typeof StoryArc>;
export const StoryArcCreate = StoryArc.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ title: true });
export type StoryArcCreate = z.infer<typeof StoryArcCreate>;
export const StoryArcUpdate = StoryArcCreate.partial();
export type StoryArcUpdate = z.infer<typeof StoryArcUpdate>;
export const StoryArcStatusPatch = z.object({ status: ArcStatus });
export type StoryArcStatusPatch = z.infer<typeof StoryArcStatusPatch>;

// Read shapes: a beat embeds its branches; an arc embeds its beats (each with branches).
export const StoryBeatWithBranches = StoryBeat.extend({ branches: z.array(StoryBranch) });
export type StoryBeatWithBranches = z.infer<typeof StoryBeatWithBranches>;
export const StoryArcWithBeats = StoryArc.extend({ beats: z.array(StoryBeatWithBranches) });
export type StoryArcWithBeats = z.infer<typeof StoryArcWithBeats>;

// ---------- npc ----------
// NPC disposition remains open text so campaigns can use setting-specific values.
// These are the canonical values the shipped UI gives semantic treatment; every
// other value is deliberately presented as neutral.
export const CANONICAL_NPC_DISPOSITIONS = ['friendly', 'neutral', 'hostile'] as const;
export const CanonicalNpcDisposition = z.enum(CANONICAL_NPC_DISPOSITIONS);

export const Npc = z.object({
  id: Id,
  campaignId: Id,
  name: z.string().min(1).max(120),
  role: z.string().max(120).default(''), // "Townmaster", "Midwife"…
  disposition: z.string().max(40).default('neutral'),
  locationId: Id.nullable().default(null),
  // Faction/organization membership (issue #221): the guild/cult/government this
  // NPC belongs to, or null. A single nullable FK (not a join table) — one NPC
  // belongs to at most one faction, which satisfies the v1 use case ("which NPCs
  // belong to the Zhentarim") without many-to-many machinery. FK-validated against
  // the same campaign's factions on write.
  factionId: Id.nullable().default(null),
  body: z.string().max(50_000).default(''),
  dmSecret: z.string().max(20_000).default(''),
  // Optional on-theme icon (issue #302): the slug of a bundled game-icons.net
  // entity icon (see apps/web/src/lib/icons) shown in place of the initials
  // avatar. '' means "no icon — fall back to initials". The web app validates
  // the slug against its bundled catalog; the server stores it opaquely (an
  // unknown slug simply renders as no icon), so the field stays forward-compatible
  // as the curated set grows. Shared mechanism reused by #305/#307.
  iconSlug: z.string().max(80).default(''),
  // Entity-level secrecy (issue #42) — see Quest.hidden. A hidden NPC is dropped
  // wholesale from every non-DM read until the DM reveals it (hidden=false).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type Npc = z.infer<typeof Npc>;
export const NpcCreate = Npc.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const NpcUpdate = NpcCreate.partial();

// ---------- faction / organization (issue #221) ----------
// A first-class group entity — Thieves' Guild, the Crown, a cult, a merchant
// consortium. Mirrors the NPC entity's secrecy machinery (dmSecret redaction +
// wholesale `hidden` gating) and adds a party-reputation model: a numeric
// `reputation` score the DM (or the AI scribe) can bump, plus a human `standing`
// label on the hostile→allied scale. NPCs link to a faction via npcs.factionId.
export const FACTION_STANDINGS = Object.freeze(['hostile', 'unfriendly', 'neutral', 'friendly', 'allied'] as const);
export const FactionStanding = z.enum(FACTION_STANDINGS);
export type FactionStanding = z.infer<typeof FactionStanding>;

export const Faction = z.object({
  id: Id,
  campaignId: Id,
  name: z.string().min(1).max(120),
  // Free-ish organization type: "guild", "cult", "government", "crime syndicate"…
  kind: z.string().max(60).default(''),
  body: z.string().max(50_000).default(''), // markdown description
  goals: z.string().max(20_000).default(''), // the faction's aims/agenda
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM
  // Entity-level secrecy (issue #42) — see Npc.hidden. A hidden faction is dropped
  // wholesale from every non-DM read until the DM reveals it (hidden=false).
  hidden: z.boolean().default(false),
  // Party standing/reputation. `reputation` is a numeric score (-100 hostile →
  // +100 allied, 0 neutral) the DM/scribe bumps; `standing` is the coarse label.
  reputation: z.number().int().min(-100).max(100).default(0),
  standing: FactionStanding.default('neutral'),
  ...timestamps,
});
export type Faction = z.infer<typeof Faction>;
export const FactionCreate = Faction.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const FactionUpdate = FactionCreate.partial();

// A faction with its member NPCs embedded (the detail read — issue #221 "surface
// a faction's members"). Members are the campaign's NPCs whose factionId points here,
// role-filtered/redacted like any other NPC read.
export const FactionWithMembers = Faction.extend({ members: z.array(Npc) });
export type FactionWithMembers = z.infer<typeof FactionWithMembers>;

// ---------- location ----------
// Entity-level secrecy (issue #42) reuses `status` rather than adding a separate
// `hidden` flag (reconcile, don't duplicate): an `unexplored` location is the
// DM's un-revealed prep and is dropped wholesale from every non-DM read
// (list/get/summary/export). The DM "reveals" it via the existing discovery
// action (POST /locations/:id/discover → explored|current).
export const LocationStatus = z.enum(['unexplored', 'explored', 'current']);

export const Location = z.object({
  id: Id,
  campaignId: Id,
  parentId: Id.nullable().default(null), // nesting: region→city→dungeon→room (#99)
  name: z.string().min(1).max(120),
  kind: z.string().max(80).default(''), // town, dungeon, region…
  status: LocationStatus.default('unexplored'),
  mapX: z.number().nullable().default(null), // 0..100 on the abstract pin canvas
  mapY: z.number().nullable().default(null),
  body: z.string().max(50_000).default(''),
  dmSecret: z.string().max(20_000).default(''),
  ...timestamps,
});
export type Location = z.infer<typeof Location>;
export const LocationCreate = Location.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const LocationUpdate = LocationCreate.partial();

// ---------- session ----------
export const Session = z.object({
  id: Id,
  campaignId: Id,
  number: z.number().int().positive(),
  title: z.string().max(200).default(''),
  playedAt: IsoDate.nullable().default(null),
  recap: z.string().max(100_000).default(''), // markdown
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM (session prep notes)
  ...timestamps,
});
export type Session = z.infer<typeof Session>;
// `number` is OPTIONAL on create: when omitted, the server assigns the next
// available session number atomically at write time (and, for a proposed recap,
// at APPROVAL time) — see SessionsService.create. Precomputing it in the caller
// froze stale numbers into proposals (#125) and let retries sidestep the
// campaign-unique guard (#160).
export const SessionCreate = Session.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial();
export const SessionUpdate = SessionCreate.partial();

// The list-shape of a session (issue #71): a session's `recap` markdown can be up
// to 100KB, so list/summary payloads deliberately DROP the full body and carry a
// short plain-text `recapExcerpt` instead — a 150-session campaign's list stays
// small. Fetch the full recap with GET /sessions/:id when a single session is opened.
export const SessionListItem = Session.omit({ recap: true }).extend({
  recapExcerpt: z.string().default(''),
});
export type SessionListItem = z.infer<typeof SessionListItem>;

// The canonical recap scaffold — the structured headings a DM fills instead of
// staring at a blank box. Shared by the web "Insert template" affordance and the
// MCP `draft_session_recap` tool so a hand-written recap and an AI-drafted one
// use the same shape. Headings are `##` so they render under the recap's own
// `#`/title in the Markdown viewer.
export const RECAP_HEADINGS = ['Recap', 'Loot', 'NPCs met', 'Cliffhanger'] as const;
export const RECAP_TEMPLATE = RECAP_HEADINGS.map((h) => `## ${h}\n\n`).join('').trimEnd() + '\n';

// ---------- session attendance (issue #121) ----------
// Which characters played a given session. A session is otherwise all-or-nothing:
// West Marches / rotating-cast tables (a big rostered party, only 4-6 of whom show
// up each outing) need a per-session "who was there" record so recaps, per-attendee
// context and "you weren't there" all become possible. One row per (session,
// character); the set is REPLACED on write (PUT /sessions/:id/attendance), not
// accumulated. characterName is the current character name when the character row
// is available, with the stored write-time snapshot used as a graceful fallback.
export const SessionAttendee = z.object({
  id: Id,
  sessionId: Id,
  characterId: Id,
  characterName: z.string().max(200).default(''),
  createdAt: IsoDate,
});
export type SessionAttendee = z.infer<typeof SessionAttendee>;
// Replace a session's attendance with exactly this set of characters. Each id must
// be a character in the session's own campaign (else 400) — the honest analogue of
// "only campaign members are valid attendees". Empty array clears attendance.
export const SessionAttendanceSet = z.object({
  characterIds: z.array(Id).max(500),
});
export type SessionAttendanceSet = z.infer<typeof SessionAttendanceSet>;

// ---------- session share links (public read-only recap access) ----------
// A DM-minted, unguessable capability URL for one session recap — viewable
// without an account (absent players). The raw token is returned ONCE at
// creation and stored hashed (sha256), same policy as PATs; deleting the row
// revokes the link.
export const SessionShare = z.object({
  id: Id,
  sessionId: Id,
  campaignId: Id,
  label: z.string().max(120).default(''),
  createdBy: z.string().max(200).default(''), // member-visible display name; durable actor id lives in audit
  tokenPrefix: z.string().max(16), // display only, e.g. cf_share_9f2a
  // NULL means a deliberately selected "never" expiry. New share requests must
  // always send this field so omission can never accidentally create a forever URL.
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  accessCount: z.number().int().nonnegative().default(0),
  firstAccessedAt: z.string().datetime({ offset: true }).nullable().default(null),
  lastAccessedAt: z.string().datetime({ offset: true }).nullable().default(null),
  ...timestamps,
});
export type SessionShare = z.infer<typeof SessionShare>;
export const SessionShareCreate = z.object({
  label: z.string().trim().max(120).default(''),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});
export type SessionShareCreate = z.infer<typeof SessionShareCreate>;
export const SessionShareUpdate = z
  .object({
    label: z.string().trim().max(120).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.expiresAt !== undefined, 'at least one field is required');
export type SessionShareUpdate = z.infer<typeof SessionShareUpdate>;
export const SessionShareCreated = z.object({ token: z.string(), share: SessionShare });
export type SessionShareCreated = z.infer<typeof SessionShareCreated>;
export const SessionSharePolicyUpdate = z.object({ enabled: z.boolean() });
export type SessionSharePolicyUpdate = z.infer<typeof SessionSharePolicyUpdate>;
export const SessionShareMutationResult = z.object({ revoked: z.number().int().nonnegative() });
export type SessionShareMutationResult = z.infer<typeof SessionShareMutationResult>;

// Payload served by the UNauthenticated GET /shared/recaps/:token endpoint.
// Deliberately minimal — no internal ids, no dmSecret-bearing entities, just
// what an absent player needs to catch up on the session.
export const SharedRecap = z.object({
  campaignName: z.string(),
  sessionNumber: z.number().int().positive(),
  title: z.string().default(''),
  playedAt: IsoDate.nullable().default(null),
  recap: z.string().default(''),
});
export type SharedRecap = z.infer<typeof SharedRecap>;

// ---------- session scheduling (next session + availability + ICS feed) ----------
// A ScheduledSession is a *future* (planned) game night — distinct from Session
// above, which is the play log/recap of a session that already happened.
const IsoDateTime = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'expected an ISO-8601 date-time'); // normalized to UTC server-side

export const ScheduledSession = z.object({
  id: Id,
  campaignId: Id,
  scheduledAt: IsoDateTime, // when the session starts (stored as ISO UTC)
  // min 0 allows mid-session "End session" to shrink the window immediately
  // (issue #818). Create still requires ≥15 via ScheduledSessionCreate.
  durationMinutes: z.number().int().min(0).max(24 * 60).default(240), // drives DTEND in the ICS feed
  title: z.string().max(200).default(''),
  location: z.string().max(200).default(''), // "Sam's place", a VTT link…
  notes: z.string().max(5000).default(''),
  ...timestamps,
});
export type ScheduledSession = z.infer<typeof ScheduledSession>;
export const ScheduledSessionCreate = ScheduledSession.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true })
  .partial()
  .required({ scheduledAt: true })
  .extend({
    // Planned game nights stay at least 15 minutes; keep the 240-minute default when
    // callers omit the field (updates may shrink to 0 via ScheduledSessionUpdate).
    durationMinutes: z.number().int().min(15).max(24 * 60).default(240),
  });
// Explicit optional fields without `.default()` so PATCH bodies that omit a key
// do not materialize create-time defaults (Zod applies defaults on undefined).
export const ScheduledSessionUpdate = z.object({
  scheduledAt: IsoDateTime.optional(),
  durationMinutes: z.number().int().min(0).max(24 * 60).optional(),
  title: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
});

export const RsvpStatus = z.enum(['yes', 'no', 'maybe']);
export type RsvpStatus = z.infer<typeof RsvpStatus>;

export const SessionRsvp = z.object({
  id: Id,
  scheduledSessionId: Id,
  userId: z.string().max(120), // same shape as Note.authorUserId (String(users.id) or dev user)
  userName: z.string().max(120).default(''), // denormalized for display
  status: RsvpStatus,
  note: z.string().max(500).default(''), // "might be 30min late"
  ...timestamps,
});
export type SessionRsvp = z.infer<typeof SessionRsvp>;
export const RsvpSetBody = z.object({ status: RsvpStatus.optional(), note: z.string().max(500).optional() });
export const RSVP_SET_REQUIRED_MESSAGE = 'status or note is required';
export function hasAnyRsvpSetField(value: z.infer<typeof RsvpSetBody>): boolean {
  return value.status !== undefined || value.note !== undefined;
}
export const RsvpSet = RsvpSetBody
  .refine(hasAnyRsvpSetField, {
    message: RSVP_SET_REQUIRED_MESSAGE,
  });
export type RsvpSet = z.infer<typeof RsvpSet>;

export const ScheduledSessionWithRsvps = ScheduledSession.extend({ rsvps: z.array(SessionRsvp) });
export type ScheduledSessionWithRsvps = z.infer<typeof ScheduledSessionWithRsvps>;

// Schedule temporal windows (issue #818) — shared by server next-session logic and the web UI.
export * from './scheduleWindow';

// Schedule notification metadata + locale-aware copy (issue #820).
export * from './scheduleNotifications';

// Per-campaign ICS calendar feed. `token` is an unguessable capability secret
// (cf_ics_<48 hex>) baked into the feed URL; null = feed disabled. Any member
// may read it (the feed only exposes schedule data members already see);
// enable/rotate/disable is DM-only.
//
// Issue #554: every issued token carries an `expiresAt` (ISO UTC). After it
// passes, the public .ics endpoint stops serving that token (404) — a leaked
// URL self-destructs on a schedule rather than living forever. Members see the
// expiry so the UI can nudge the DM to rotate before it lapses. Null on legacy
// rows written before #554 (no expiry) and after disable (no live token).
export const CalendarFeed = z.object({
  token: z.string().nullable(),
  url: z.string().nullable(), // relative feed path, e.g. /api/v1/calendar/<token>.ics
  expiresAt: z.string().nullable(), // ISO UTC when the current token stops authorizing the feed
});
export type CalendarFeed = z.infer<typeof CalendarFeed>;

// ---------- timeline (in-world calendar / campaign timeline) — issue #63 ----------
// The real-world Session.playedAt tells you WHEN a table met; it says nothing about
// the in-fiction date ("the 3rd of Flamerule, 1492 DR"). This is a standalone module:
// a DM sequences in-world events on a campaign timeline, each carrying a free-text
// in-world date (fantasy calendars aren't ISO-parseable) plus a DM-controlled
// `sortIndex` so the timeline orders by narrative sequence, not by that unsortable
// string. Canon-entity secrecy conventions apply: `dmSecret` is stripped for non-DM,
// and a `hidden` event is dropped WHOLESALE from every non-DM read (prep for a reveal).
export const TimelineEvent = z.object({
  id: Id,
  campaignId: Id,
  title: z.string().min(1).max(200),
  // Free-text in-fiction date, e.g. "3rd of Flamerule, 1492 DR". Empty = undated
  // (a floating "sometime around here" beat the DM can still sequence via sortIndex).
  inWorldDate: z.string().max(200).default(''),
  body: z.string().max(50_000).default(''), // markdown
  // Optional era/age grouping ("Age of Chains", "Second Era") — a light bucket the
  // timeline view can header on; free text, no enum (every world names its ages).
  era: z.string().max(120).default(''),
  // DM-controlled ordering along the timeline. Free-text dates can't be sorted, so
  // the timeline reads by this (ascending), id as a stable tiebreaker.
  sortIndex: z.number().int().default(0),
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM
  // Entity-level secrecy (issue #42 convention): a hidden event is excluded WHOLESALE
  // from every non-DM read until the DM reveals it (hidden=false).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;
export const TimelineEventCreate = TimelineEvent.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true })
  .partial()
  .required({ title: true });
export type TimelineEventCreate = z.infer<typeof TimelineEventCreate>;
export const TimelineEventUpdate = TimelineEventCreate.partial();
export type TimelineEventUpdate = z.infer<typeof TimelineEventUpdate>;

// The "honest v0" from the issue: one free-text "current in-world date" per campaign
// ("It is presently the 3rd of Flamerule, 1492 DR"), plus an optional calendar note
// (month names, moon phases, whatever the DM wants to remember). Stored in the
// timeline module's own single-row-per-campaign table so it touches nothing else.
export const TimelineCalendar = z.object({
  campaignId: Id,
  currentDate: z.string().max(200).default(''),
  note: z.string().max(4000).default(''), // markdown — calendar reference / month list
  ...timestamps,
});
export type TimelineCalendar = z.infer<typeof TimelineCalendar>;
export const TimelineCalendarUpdate = z.object({
  currentDate: z.string().max(200).optional(),
  note: z.string().max(4000).optional(),
});
export type TimelineCalendarUpdate = z.infer<typeof TimelineCalendarUpdate>;

// ---------- session zero / table charter (safety tools & expectations) — issue #122 ----------
// Session zero is where a table agrees on the content it will and won't play through
// and the tools it will use to steer in the moment. Before this, none of that had a
// home — a campaign carried only name/description/status/danger/ruleSystem, so lines &
// veils lived (if anywhere) in a markdown blob players might never open. This is a
// first-class, structured, per-campaign record: ONE row per campaign, DM-authored,
// readable by the whole table (no dmSecret — a safety charter everyone must see). It's
// also exposed read-only over MCP so a connected AI (and the roadmap's AI DM) is bound
// by the same lines & veils the humans agreed to.
export const SessionZero = z.object({
  campaignId: Id,
  // Hard limits ("lines") — content that never appears at the table, full stop.
  lines: z.array(z.string().min(1).max(500)).max(200).default([]),
  // Soft limits ("veils") — content that may exist in the fiction but stays off-screen
  // (fade to black), never described in detail.
  veils: z.array(z.string().min(1).max(500)).max(200).default([]),
  // Safety tools this table has agreed to use — X-Card, Open Door, Script Change, etc.
  // Free text (every table names them differently), one agreed tool per entry.
  safetyTools: z.array(z.string().min(1).max(200)).max(50).default([]),
  // House rules — table conventions and rules-as-written deviations (markdown).
  houseRules: z.string().max(20_000).default(''),
  // Tone & content expectations — the register the table is playing in: gritty vs.
  // heroic, comedic vs. serious, expected spotlight/PvP norms, etc. (markdown).
  toneAndExpectations: z.string().max(20_000).default(''),
  ...timestamps,
});
export type SessionZero = z.infer<typeof SessionZero>;
// Update is a partial patch: every field optional so the DM can revise one section
// without resending the whole charter (the single-row-per-campaign upsert convention).
export const SessionZeroUpdate = z.object({
  lines: z.array(z.string().min(1).max(500)).max(200).optional(),
  veils: z.array(z.string().min(1).max(500)).max(200).optional(),
  safetyTools: z.array(z.string().min(1).max(200)).max(50).optional(),
  houseRules: z.string().max(20_000).optional(),
  toneAndExpectations: z.string().max(20_000).optional(),
});
export type SessionZeroUpdate = z.infer<typeof SessionZeroUpdate>;

// ---------- participant-owned access-support preferences (issue #877) ----------
// Practical participation support belongs to the participant who supplied it. Human
// visibility and model use are intentionally separate decisions: facilitator-only does
// not imply AI consent, and table visibility does not imply AI consent either.
export const SupportPreferenceVisibility = z.enum(['table', 'facilitator']);
export type SupportPreferenceVisibility = z.infer<typeof SupportPreferenceVisibility>;

export const ParticipantSupportPreference = z.object({
  id: Id,
  campaignId: Id,
  ownerUserId: z.string().min(1).max(120),
  ownerName: z.string().max(120).default(''),
  supportText: z.string().min(1).max(2000),
  visibility: SupportPreferenceVisibility,
  aiUseConsent: z.boolean(),
  ...timestamps,
});
export type ParticipantSupportPreference = z.infer<typeof ParticipantSupportPreference>;

// PUT is a complete replacement, not a partial patch. Requiring both privacy
// choices on every write prevents an API/MCP caller from accidentally inheriting
// stale consent while changing the support text.
export const ParticipantSupportPreferenceUpsert = z.object({
  supportText: z.string().trim().min(1).max(2000),
  visibility: SupportPreferenceVisibility,
  aiUseConsent: z.boolean(),
});
export type ParticipantSupportPreferenceUpsert = z.infer<typeof ParticipantSupportPreferenceUpsert>;

// Deliberately excludes owner ids and timestamps: model-facing contexts need only
// the respectful instruction and participant label, and receive rows only after the
// service has enforced explicit AI consent.
export const AiSupportPreference = z.object({
  participantName: z.string().max(120),
  supportText: z.string().min(1).max(2000),
  visibility: SupportPreferenceVisibility,
  aiUseConsent: z.literal(true),
});
export type AiSupportPreference = z.infer<typeof AiSupportPreference>;

export const FacilitatorSupportSummary = z.object({
  campaignId: Id,
  entries: z.array(ParticipantSupportPreference),
});
export type FacilitatorSupportSummary = z.infer<typeof FacilitatorSupportSummary>;

// ---------- notes ----------
// `whisper` is a per-player secret channel (issue #127): the note is visible ONLY to
// its author, the single targeted recipient (recipientUserId), and any DM. This is the
// player-vs-player asymmetry the other visibilities can't express — private is
// author-only, dm_shared flows up to the DM, party_shared broadcasts to everyone.
export const NoteVisibility = z.enum(['private', 'dm_shared', 'party_shared', 'whisper']);
export const NoteKind = z.enum(['note', 'inbox']);
export const EntityType = z.enum(['quest', 'npc', 'location', 'session', 'character', 'campaign', 'encounter', 'faction']);

export const Note = z.object({
  id: Id,
  campaignId: Id,
  authorUserId: z.string().max(120), // OIDC sub or dev user
  authorName: z.string().max(120).default(''),
  kind: NoteKind.default('note'),
  visibility: NoteVisibility.default('private'),
  entityType: EntityType.nullable().default(null),
  entityId: Id.nullable().default(null),
  // Display name of the anchored entity (quest title, npc/location/character/campaign
  // name, session title), resolved server-side at read time — not stored. Null when
  // the note is unanchored or the entity no longer exists.
  entityName: z.string().max(300).nullable().default(null),
  // The single member a `whisper` note is targeted at — same identity space as
  // authorUserId (String(users.id), or dev:<name> under DEV_AUTH). Null for every
  // other visibility. Set only when visibility === 'whisper'.
  recipientUserId: z.string().max(120).nullable().default(null),
  // Display name of the whisper recipient, resolved server-side at read time (like
  // entityName) — not stored. Null when the note isn't a whisper or the recipient is
  // no longer a member.
  recipientName: z.string().max(120).nullable().default(null),
  body: z.string().min(1).max(20_000),
  resolved: z.boolean().default(false), // inbox items only
  resolvedNote: z.string().max(1000).default(''),
  ...timestamps,
});
export type Note = z.infer<typeof Note>;
export const NoteCreate = Note.omit({ id: true, campaignId: true, authorUserId: true, entityName: true, recipientName: true, createdAt: true, updatedAt: true, resolved: true, resolvedNote: true }).partial().required({ body: true });
export const NoteUpdate = z.object({
  body: z.string().min(1).max(20_000).optional(),
  visibility: NoteVisibility.optional(),
  entityType: EntityType.nullable().optional(),
  entityId: Id.nullable().optional(),
  recipientUserId: z.string().max(120).nullable().optional(),
});
export const InboxCreate = z.object({
  authorName: z.string().max(120).default('someone'),
  body: z.string().min(1).max(20_000),
});
export const InboxResolve = z
  .object({
    resolvedNote: z.string().max(1000).default(''),
    // Optional link to the entity this item was resolved into (drives the history view).
    entityType: EntityType.nullable().optional(),
    entityId: Id.nullable().optional(),
  })
  // Reject unknown keys (issue #131). This request-input schema is `.strict()` at
  // its source — unlike the entity Create/Update schemas (kept lenient and made
  // strict at the server DTO layer), this one is a `.refine()`-wrapped ZodEffects
  // with no `.strict()` to apply downstream, and it's a pure request DTO reused
  // nowhere as a pass-through (no MCP/proposal path), so tightening it here is safe.
  .strict()
  .refine((v) => (v.entityType == null) === (v.entityId == null), {
    message: 'entityType and entityId must be provided together',
  });

// ---------- entity revisions (issue #157 / #813) ----------
// Immutable prose versions for the entities most at risk of a blind last-write-wins
// clobber (a co-DM polishing a recap while a connected AI saves its own edit). Each
// row is a version of the prose itself (not merely "content being overwritten"):
// `author*` + `createdAt` are who/when that version became authoritative, while
// `replacedBy*` + `replacedAt` record who later superseded it. A null `replacedAt`
// marks the current tip (live content); history listings omit tips. Restoring a
// prior version opens a NEW tip attributed to the restorer and linked via
// `restoredFromRevisionId`. Legacy rows migrated from the pre-#813 shape (where
// author/time were the replacing editor) set `authorshipKnown=false` so the UI can
// label them honestly as "Replaced by …" instead of inventing an author.
// Covers DM-authored world-building prose — sessions (recap), quests/npcs/locations/
// factions (body) — AND notes (body). Notes carry their own per-note visibility/
// author-only-edit model, so revision reads are gated on the note's OWN visibility
// and restore is author-only — see RevisionsController.
export const RevisionEntityType = z.enum(['session', 'quest', 'npc', 'location', 'faction', 'note']);
export type RevisionEntityType = z.infer<typeof RevisionEntityType>;

/** How the version's prose was produced — human editor, AI seat, or tool/PAT. */
export const RevisionAuthorSource = z.enum(['human', 'ai', 'tool']);
export type RevisionAuthorSource = z.infer<typeof RevisionAuthorSource>;

export const EntityRevision = z.object({
  id: Id,
  campaignId: Id,
  entityType: RevisionEntityType,
  entityId: Id,
  // The prose OF THIS VERSION, keyed by the entity's prose field ('recap' for a
  // session, 'body' for quest/npc/location/faction/note). A plain string map so the
  // shape is uniform across entity types and the web can render whichever key is present.
  snapshot: z.record(z.string(), z.string()).default({}),
  // Version author (who wrote this snapshot). Empty when authorshipKnown is false.
  authorUserId: z.string().max(120).default(''),
  authorName: z.string().max(120).default(''),
  authorSource: RevisionAuthorSource.default('human'),
  // Token name / AI seat id / provider hint — empty for ordinary human cookie sessions.
  authorSourceDetail: z.string().max(200).default(''),
  // When this version became authoritative. Empty string for legacy rows whose
  // original authored-at is unknowable (authorshipKnown=false).
  createdAt: IsoDate,
  // Who/when superseded this version. Null replacedAt = current tip (still live).
  replacedByUserId: z.string().max(120).default(''),
  replacedByName: z.string().max(120).default(''),
  replacedBySource: RevisionAuthorSource.default('human'),
  replacedBySourceDetail: z.string().max(200).default(''),
  replacedAt: z.string().nullable().default(null),
  // Set when this version was created by restoring another revision.
  restoredFromRevisionId: Id.nullable().default(null),
  // false for pre-#813 rows: author fields must not be presented as provenance.
  authorshipKnown: z.boolean().default(true),
});
export type EntityRevision = z.infer<typeof EntityRevision>;

// ---------- comments (threaded discussion / play-by-post — issue #123) ----------
// A first-class DISCUSSION layer, distinct from private-or-shared `notes`: every
// comment is anchored to a campaign entity (session/recap, quest, npc, location,
// character, campaign — the same entityType/entityId convention notes use) and is
// visible to ALL campaign members. Unlike notes there is no per-comment visibility;
// discussion is inherently shared. `parentId` gives one level of threading (a reply
// to a comment). `inCharacter` flags an in-character post (a play-by-post scene) vs
// out-of-character table chatter. Author-or-DM may edit/delete.
//
// Soft delete / tombstone (issue #503): a top-level comment that has other members'
// replies is NOT hard-deleted (that would destroy their content). Instead it is
// tombstoned: deletedAt is set, body is redacted to a neutral placeholder in API
// responses, and the row stays so replies keep their parent pointer. A tombstoned
// root is still returned by list/get (as a placeholder) — it is NOT filtered out of
// normal reads the way a trashed note is, precisely because replies anchor to it.
// deletedBy records who pulled the trigger (author or DM moderating).
export const Comment = z.object({
  id: Id,
  campaignId: Id,
  // A comment ALWAYS anchors to an entity (no unanchored discussion) — required,
  // unlike Note.entityType which is nullable.
  entityType: EntityType,
  entityId: Id,
  // One level of threading: null = a top-level comment; set = a reply to that
  // comment. Replies to replies still hang off the same top-level ancestor (the
  // web thread renders two visual levels), so this is a soft parent pointer.
  parentId: Id.nullable().default(null),
  authorUserId: z.string().max(120), // String(users.id) or dev:<name>
  authorName: z.string().max(120).default(''),
  body: z.string().min(1).max(20_000), // markdown (redacted to a placeholder when tombstoned)
  inCharacter: z.boolean().default(false),
  // Immutable creation-time persona attribution (issue #787). characterId is a
  // soft reference to the selected owned character; the name/avatar snapshots are
  // authoritative for display so a later rename or character deletion cannot
  // rewrite old dialogue. Legacy/OOC comments carry nulls.
  characterId: Id.nullable().default(null),
  characterName: z.string().max(120).nullable().default(null),
  characterAvatarUrl: z.string().max(500).nullable().default(null),
  // Tombstone (issue #503). null = live; an ISO timestamp means the comment was
  // deleted by its author / a DM and its body has been redacted. The row remains so
  // replies keep their parent. Cleared on restore.
  deletedAt: IsoDate.nullable().default(null),
  // Who tombstoned the comment (String(users.id), 'dev:<name>', or 'token:<name>');
  // null on a live row. While tombstoned, this lets the UI distinguish "[deleted
  // by author]" from a DM removal. It is cleared on restore, so durable
  // provenance of a past tombstone (who/when) lives in the AUDIT LOG, not here.
  deletedBy: z.string().max(120).nullable().default(null),
  // Editor provenance for the trust case (issue #783): null on a comment whose
  // only edits are by its own author. Stamped ONLY when a non-author (a DM
  // moderating) edits the body — edited_at then and edited_by (same identity
  // space as authorUserId / deletedBy) record that editor. The original
  // authorUserId/authorName are NEVER overwritten, so the player who wrote the
  // comment stays its author of record and the UI can render "Author: X (edited
  // by DM Y)". A self-edit leaves both null (the usual updated_at "edited" badge
  // already covers the author touching their own prose).
  editedAt: IsoDate.nullable().default(null),
  editedBy: z.string().max(120).nullable().default(null),
  ...timestamps,
});
export type Comment = z.infer<typeof Comment>;
export const CommentCreate = Comment.omit({
  id: true,
  campaignId: true,
  authorUserId: true,
  authorName: true,
  characterName: true,
  characterAvatarUrl: true,
  deletedAt: true,
  deletedBy: true,
  editedAt: true,
  editedBy: true,
  createdAt: true,
  updatedAt: true,
})
  .partial()
  .required({ entityType: true, entityId: true, body: true });
export const CommentUpdate = z.object({
  body: z.string().min(1).max(20_000).optional(),
  // Kept for wire compatibility, but changing it after creation is rejected by
  // the service because persona attribution is immutable historical provenance.
  inCharacter: z.boolean().optional(),
});

// ---------- notifications (in-app) ----------
// Per-user notification rows written by the server when something a member cares
// about happens while they're not looking: a session recap is posted, someone
// replies on a shared note thread (or the DM answers an inbox item), a player
// shares a note up to the DM or to the whole party (note_shared), someone posts
// on a discussion thread they're part of (comment_reply), they're added to a
// campaign, the next session gets scheduled (session_scheduled) or a member
// RSVPs to one (session_rsvp), a quest is completed or revealed to the party
// (quest_updated), a member submits a proposal to the DM (proposal_submitted) or
// the DM approves/rejects it (proposal_resolved), or a member posts to the DM
// scribe inbox (inbox_submitted, issue #832). Read via
// GET /notifications (own rows only); real-time push can layer on later — the
// store is plain rows, transport-agnostic.
export const NotificationType = z.enum([
  'recap_posted',
  'recap_share_enabled',
  'recap_share_extended',
  'note_reply',
  'note_shared',
  'comment_reply',
  'added_to_campaign',
  // Issue #819: exclusive character seat transferred away from (or onto) this member.
  'character_reassigned',
  'session_scheduled',
  'session_rsvp',
  'quest_updated',
  'proposal_submitted',
  'proposal_resolved',
  // Issue #832: a player (or any member) posted to the DM scribe inbox.
  'inbox_submitted',
  // The driver AI-DM got stuck / a recovery lever was pulled (issue #314): AI errored/looped,
  // budget exhausted, a ruling was disputed, a table vote resolved, or a human took the seat.
  'ai_dm_alert',
]);
export type NotificationType = z.infer<typeof NotificationType>;

export const Notification = z.object({
  id: Id,
  userId: Id, // recipient (users.id) — never exposed to anyone but the recipient
  campaignId: Id,
  type: NotificationType,
  title: z.string().min(1).max(200),
  body: z.string().max(1000).default(''), // short excerpt/context, plain text
  entityType: EntityType.nullable().default(null), // deep-link target (e.g. session), if any
  entityId: Id.nullable().default(null),
  /**
   * Issue #446: when set (typically `comment_reply`), the UI focuses this comment
   * inside the parent entity's discussion thread (`entityType`/`entityId`).
   */
  commentId: Id.nullable().default(null),
  /**
   * Issue #820: optional structured event payload (JSON object). Schedule
   * lifecycle pings store {@link ScheduleNotificationData} here so clients can
   * localize the start instant instead of trusting a UTC date baked into title.
   */
  data: z.record(z.string(), z.unknown()).nullable().default(null),
  actorName: z.string().max(120).default(''), // display name of who triggered it
  readAt: IsoDate.nullable().default(null), // null = unread
  createdAt: IsoDate,
});
export type Notification = z.infer<typeof Notification>;

export const NotificationUnreadCount = z.object({ count: z.number().int().nonnegative() });
export type NotificationUnreadCount = z.infer<typeof NotificationUnreadCount>;

// ---------- rule packs (Compendium backend) ----------
// Installed, server-wide rules content (spells/monsters/items/…) imported from
// an open-licensed source (currently Open5e). Read by any authed user;
// install/uninstall is server-admin only (see rules.controller.ts).
export const RulePack = z.object({
  id: Id,
  slug: z.string().min(1).max(80), // e.g. "open5e-srd", unique
  name: z.string().min(1).max(120),
  version: z.string().max(40).default(''),
  license: z.string().max(120).default(''), // e.g. "OGL 1.0a", "CC-BY-4.0"
  sourceUrl: z.string().max(500).default(''),
  installedAt: IsoDate,
  entryCount: z.number().int().nonnegative().default(0),
  // Authoritative, server-wide count of campaigns whose `ruleSystem` == this pack's slug
  // (issue #385). Populated by GET /rules/packs; the uninstall-safety gate reads THIS, not a
  // client-side count of only the caller's visible campaigns. Optional so other RulePack
  // producers (e.g. an install response) needn't compute it.
  usageCount: z.number().int().nonnegative().optional(),
});
export type RulePack = z.infer<typeof RulePack>;

export const RuleEntryType = z.enum(['spell', 'monster', 'item', 'class', 'race', 'feat', 'condition', 'section', 'other']);
export type RuleEntryType = z.infer<typeof RuleEntryType>;

export const RuleEntry = z.object({
  id: Id,
  packId: Id,
  slug: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
  type: RuleEntryType,
  summary: z.string().max(1000).default(''),
  body: z.string().max(50_000).default(''), // markdown
  dataJson: z.string().nullable().default(null), // raw structured fields (stats etc.), JSON-encoded
  // Human-readable source/document label the entry came from (Open5e `document.name`,
  // e.g. "System Reference Document 5.1"), so entries from different rulebooks are
  // distinguishable and the reader can attribute the real source/license (issue #143).
  // '' for older imports/uploads that predate the column — the reader falls back to the pack name.
  source: z.string().max(200).default(''),
  // Per-entry provenance (issue #734): a pack may mix licenses (an OGL pack with a CC-BY
  // spell, a community feat under ORC). Previously the entry's license was dropped on
  // import and the reader labelled every entry with the PACK license — losing attribution
  // the licence legally requires. These four fields capture what the entry ACTUALLY came
  // under, falling back to the pack's value when the source data doesn't say otherwise
  // (see effectiveLicense/effectiveAttribution). '' for rows written before the columns
  // existed (migration 0050) — callers treat '' as "inherit the pack's value".
  //   - license: the SPDX-ish/open-license string the entry is distributed under
  //     ("OGL 1.0a", "CC-BY-4.0", "ORC"). Validated open by the importer/upload path.
  //   - attribution: the credit line the licence obliges us to show (author + title +
  //     copyright statement), e.g. "Fireball, © WotC, Open Game Content under the OGL 1.0a".
  //   - author: the creator/rights-holder name to credit, when separable from the
  //     attribution line ("Chris Gonnerman", "Archives of Nethys").
  //   - sourceUrl: a deep link back to the entry on its origin site (CC-BY(-SA) requires
  //     a link; also useful for the reader's "view original" affordance).
  license: z.string().max(160).default(''),
  attribution: z.string().max(500).default(''),
  author: z.string().max(200).default(''),
  sourceUrl: z.string().max(500).default(''),
  // Optional manual icon override (issue #305): the slug of a bundled game-icons.net
  // entity icon (see apps/web/src/lib/icons) shown in the compendium list + reader in
  // place of the type/school-derived default. '' means "no override — the web app
  // derives a sensible default from `type` + `dataJson` (spell school, monster type,
  // item category, condition)". Stored opaquely (an unknown slug simply falls back to
  // the default), mirroring Npc.iconSlug from #302 so the field stays forward-compatible
  // as the curated set grows.
  iconSlug: z.string().max(80).default(''),
  ...timestamps,
});
export type RuleEntry = z.infer<typeof RuleEntry>;

/**
 * DM-editable fields on an already-imported rule entry (issue #305). The compendium's
 * entries come from importers/uploads, not a manual create form, so the only mutable
 * field a DM sets by hand is the icon override — a small PATCH surface (mirrors the
 * shape of NpcUpdate, which also carries iconSlug). Widen this object if more per-entry
 * homebrew edits are added later.
 */
export const RuleEntryUpdate = z.object({
  iconSlug: z.string().max(80),
}).partial();
export type RuleEntryUpdate = z.infer<typeof RuleEntryUpdate>;

/**
 * Importer registry for the /rules/packs/install endpoint (issue #70). Was a bare
 * `z.literal('open5e')`, welding the install path to a single importer. Widened first to a
 * small enum (open5e/pf2e, issue #295) and then — issue #345 — to the full open-ruleset
 * family so every shipped importer is reachable from the endpoint:
 *   - 'open5e'      — D&D 5e SRD (default, the built-in API importer)
 *   - 'pf2e'        — Pathfinder 2e (Archives of Nethys, issue #295)
 *   - 'sf2e'        — Starfinder 2e (Archives of Nethys, issue #400)
 *   - 'pf1e'        — Pathfinder 1e SRD (issue #296)
 *   - 'starfinder'  — Starfinder 1e SRD (issue #297)
 *   - 'archmage'    — 13th Age / Archmage Engine SRD (issue #298)
 *   - 'open-legend' — Open Legend community codex (issue #299)
 *   - 'osr'         — the OSR retroclone family (issue #300; see `system` below)
 *   - 'other'       — generic/placeholder (routes to the Open5e path for back-compat)
 * The existing Open5e/PF2e request shape is unchanged: callers still pass `source: 'open5e'`
 * (or 'pf2e'). Generic JSON uploads take the separate RulePackUpload path, `source: 'upload'`.
 */
export const RulePackInstallSource = z.enum([
  'open5e',
  'pf2e',
  'sf2e',
  'pf1e',
  'starfinder',
  'archmage',
  'open-legend',
  'osr',
  'other',
]);
export type RulePackInstallSource = z.infer<typeof RulePackInstallSource>;

/**
 * OSR variant selector (issue #345): the single `osr` importer serves several retroclone
 * packs, so an OSR install picks which source system's pack it installs under. Each value
 * maps to an `OsrSource` (slug/license/attribution) in the OSR importer; the pack installs
 * under that slug, which the shared `OsrAdapter` is registered against. Defaults to
 * 'basic-fantasy' (the cleanest CC-BY-SA source) when omitted, matching `osrSource()`.
 */
export const OsrInstallSystem = z.enum([
  'basic-fantasy',
  'osric',
  'swords-wizardry',
  'labyrinth-lord',
  'old-school-essentials',
]);
export type OsrInstallSystem = z.infer<typeof OsrInstallSystem>;

/**
 * The union of every section name any importer accepts (issue #345). The original enum was
 * 5e-shaped (spells/monsters/…); the sibling systems add their own vocabularies — Starfinder
 * adds equipment/starships/vehicles, Open Legend uses banes/boons/feats. A section name
 * that parses here is still validated against the CHOSEN source server-side (a foreign
 * section, e.g. 'starships' for an open5e install, is rejected 400 before a job is enqueued),
 * because Zod alone can't express the per-source subset without a discriminated union.
 */
export const RulePackInstallSection = z.enum([
  // 5e-shaped (Open5e, Pathfinder 1e; PF2e ignores the filter, OSR uses a subset)
  'spells',
  'monsters',
  'items',
  'conditions',
  'classes',
  'races',
  'feats',
  // Starfinder
  'equipment',
  'starships',
  'vehicles',
  // Open Legend
  'creatures',
  'banes',
  'boons',
]);
export type RulePackInstallSection = z.infer<typeof RulePackInstallSection>;

export const RulePackInstall = z.object({
  source: RulePackInstallSource,
  url: z.string().max(500).optional(), // override API base, mainly for tests (fake server)
  sections: z.array(RulePackInstallSection).optional(), // default: all (validated per-source server-side)
  system: OsrInstallSystem.optional(), // OSR only: which retroclone pack to install under (default basic-fantasy)
});
export type RulePackInstall = z.infer<typeof RulePackInstall>;

/**
 * How a given install source obtains its data (issue #346). The five sibling importers
 * (#296-300) were shipped against test fixtures, but only some of the target systems
 * actually have an OPEN, machine-readable, first-party source that installs without the
 * caller supplying a URL. This enum lets the API be HONEST about that, and lets the install
 * picker (#347) either offer a one-click live import or steer the user to "bring your own
 * pack" via the upload endpoint — rather than presenting a source that would fail.
 *   - 'api'           — a validated live/first-party source; installs with no `url`.
 *   - 'manual-upload' — no usable open source found; the user must upload an open-licensed
 *                       JSON pack (POST /rules/packs/upload) or pass an explicit `url`.
 */
export const RulePackSourceKind = z.enum(['api', 'manual-upload']);
export type RulePackSourceKind = z.infer<typeof RulePackSourceKind>;

/** Honesty metadata for one install source — consumed by the install picker (#347). */
export interface RulePackSourceMeta {
  source: RulePackInstallSource;
  label: string;
  sourceKind: RulePackSourceKind;
  /** True when POST /rules/packs/install works with no caller-supplied `url`. */
  installableWithoutUrl: boolean;
  /** License the wired source publishes under, or that an uploaded pack for this system must carry. */
  license: string;
  /** One-line, user-facing explanation of how this system installs (and why, if manual-upload). */
  note: string;
  /**
   * For a manual-upload system: a documented source a user could convert into an uploadable
   * pack (recorded so the finding is auditable, NOT a wired importer). null when even a
   * candidate is dead/unusable. For an api system: the base the importer actually pulls from.
   */
  candidateSourceUrl: string | null;
}

/**
 * The result of the #346 research pass — which placeholder systems have a real open,
 * machine-readable source and which honestly do not. Validated live 2026-07-21:
 *   - open5e / pf2e / open-legend → real first-party open source, wired, no `url` needed.
 *   - pf1e / starfinder / archmage / osr → NO stable first-party open machine-readable
 *     source. Their former defaults were dead or placeholder (a `.example` host, dead DNS,
 *     HTTP 410, or a project homepage that is not an API). They install via upload only.
 */
export const RULE_PACK_SOURCE_META: Record<RulePackInstallSource, RulePackSourceMeta> = {
  open5e: {
    source: 'open5e',
    label: 'D&D 5e SRD (Open5e)',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'OGL v1.0a / CC-BY-4.0',
    note: 'Live import from the Open5e v2 API.',
    candidateSourceUrl: 'https://api.open5e.com/v2',
  },
  pf2e: {
    source: 'pf2e',
    label: 'Pathfinder 2e (Archives of Nethys)',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'OGL / ORC',
    note: 'Live import from the Archives of Nethys 2e Elasticsearch backend.',
    candidateSourceUrl: 'https://elasticsearch.aonprd.com',
  },
  sf2e: {
    source: 'sf2e',
    label: 'Starfinder 2e (Archives of Nethys)',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'ORC / OGL',
    note: 'Live import from the Archives of Nethys SF2e Elasticsearch backend (aonsf index).',
    candidateSourceUrl: 'https://elasticsearch.aonprd.com',
  },
  'open-legend': {
    source: 'open-legend',
    label: 'Open Legend',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'Open Legend Community License',
    note: 'Live import of boons, banes, and feats from the official Open Legend core-rules repository (YAML).',
    candidateSourceUrl: 'https://github.com/openlegend/core-rules',
  },
  pf1e: {
    source: 'pf1e',
    label: 'Pathfinder 1e',
    sourceKind: 'manual-upload',
    installableWithoutUrl: false,
    license: 'Open Game License v1.0a',
    note: 'No stable first-party open SRD API exists. Upload an OGL-licensed JSON pack (or pass an explicit `url`). Community datasets exist but none is a dependable first-party source.',
    candidateSourceUrl: 'https://github.com/Noobulater/pathfinder-srd',
  },
  starfinder: {
    source: 'starfinder',
    label: 'Starfinder 1e',
    sourceKind: 'manual-upload',
    installableWithoutUrl: false,
    license: 'Open Game License v1.0a',
    note: 'Foundry system pack data is stored as multi-file JSON and LevelDB databases. Upload an OGL-licensed JSON pack (or pass an explicit `url`).',
    candidateSourceUrl: 'https://github.com/foundryvtt-starfinder/foundryvtt-starfinder',
  },
  archmage: {
    source: 'archmage',
    label: '13th Age (Archmage Engine)',
    sourceKind: 'manual-upload',
    installableWithoutUrl: false,
    license: 'Open Game License v1.0a',
    note: 'The official 13thagesrd.com is HTTP 410 Gone; the only open mirror is unstructured Markdown, not a data API. Upload an OGL JSON pack, or pass `url`.',
    candidateSourceUrl: 'https://github.com/Obsidian-TTRPG-Community/13th-Age-SRD-Markdown',
  },
  osr: {
    source: 'osr',
    label: 'OSR retroclones',
    sourceKind: 'manual-upload',
    installableWithoutUrl: false,
    license: 'CC-BY-SA-4.0 (Basic Fantasy) / OGL v1.0a (OSRIC, S&W, Labyrinth Lord, OSE)',
    note: 'Basic Fantasy is CC-BY-SA but published only as PDF/ODT — not machine-readable — and the OGL retroclones have no JSON API. Upload a converted pack, or pass `url`.',
    candidateSourceUrl: 'https://basicfantasy.org/downloads.html',
  },
  other: {
    source: 'other',
    label: 'Other (Open5e-compatible)',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'OGL / CC',
    note: 'Alias for the Open5e importer.',
    candidateSourceUrl: 'https://api.open5e.com/v2',
  },
};

/** Look up the honesty metadata for an install source (#346). */
export function rulePackSourceMeta(source: RulePackInstallSource): RulePackSourceMeta {
  return RULE_PACK_SOURCE_META[source];
}

/** Every install source, in a stable display order, with its honesty metadata (#347 install picker). */
export function listRulePackSources(): RulePackSourceMeta[] {
  return (RulePackInstallSource.options as readonly RulePackInstallSource[]).map((s) => RULE_PACK_SOURCE_META[s]);
}

// ---------- rule-system adapters (issue #70) ----------
// The combat/statblock layers used to bake D&D-5e rules in at every call site: the
// ability-modifier formula floor((score-10)/2), DEX-derived initiative rolled on a d20,
// a hardcoded condition list in the web UI, and the monster-statblock field mapping.
// Adding a second system (Pathfinder, a d100 game) would have meant editing each layer.
//
// `RuleSystemAdapter` is the seam that captures those decisions behind one interface,
// resolved from `campaign.ruleSystem` via `ruleSystemAdapter()`. 5e is the first and
// default implementation (`Dnd5eAdapter`), so every existing campaign — whatever its
// rule-pack slug — resolves to the exact same behavior it has today. A future system is
// one adapter object registered in ADAPTERS, not a sweep across the combat code.

/**
 * How values in a monster `abilityScores` map (or a character ability map) should be
 * interpreted before rolling or rendering (issue #767):
 * - `score` — classic 3–18 ability scores; convert with `abilityModifier` (5e/PF1e/…).
 * - `modifier` — already signed modifiers as listed on PF2e creature statblocks; use as-is.
 * - `native` — system-native values used directly (Open Legend attributes).
 */
export type AbilityRepresentation = 'score' | 'modifier' | 'native';

/** Raw statblock fields picked out of a monster rule-entry's `dataJson` (pre-formatting). */
export interface MonsterStatblockData {
  size: unknown;
  creatureType: unknown;
  challengeRating: unknown;
  armorClass: unknown;
  hitPoints: unknown;
  speed: unknown;
  /** The ability-score sub-object (5e: `{ strength, dexterity, … }`), or undefined. */
  abilityScores: Record<string, unknown> | undefined;
  /**
   * How to interpret `abilityScores` for this mapped monster. Defaults are applied by each
   * adapter's `mapStatblock` (5e → score, PF2e creatures → modifier, Open Legend → native).
   */
  abilityRepresentation: AbilityRepresentation;
  specialAbilities: unknown;
  actions: unknown;
  /** Optional action categories used by systems that distinguish them in a statblock. */
  legendaryActions?: unknown;
  reactions?: unknown;
}

/**
 * One user-facing statblock label (issue #763). `full` is the accessible term shown by
 * default; `short` is an optional visual abbreviation (e.g. AC, HD, CR) for compact
 * surfaces that still expose `full` via tooltip / screen-reader text.
 */
export interface StatblockPresentationLabel {
  /** Full accessible term (e.g. "Armor Class", "Guard", "Hit Dice"). */
  readonly full: string;
  /** Optional short visual form (e.g. "AC", "HD"). Omit when the full term is always shown. */
  readonly short?: string;
}

/**
 * Adapter-native presentation metadata for the shared StatBlock renderer (issue #763).
 * Mechanical fields stay generic (`challengeRating` / `armorClass`); labels are what the
 * UI says — Level / Hit Dice / Guard instead of hardcoded "Challenge" / "Armor Class".
 */
export interface StatblockPresentation {
  /** Difficulty / threat rating (Challenge, Level, Hit Dice, Rating, …). */
  readonly rating: StatblockPresentationLabel;
  /** Primary defense number (Armor Class, Guard, Kinetic Armor Class, Defense, …). */
  readonly defense: StatblockPresentationLabel;
  /** Hit-point / vitality pool label. */
  readonly hitPoints: StatblockPresentationLabel;
  /** Ability-score / attribute block label. */
  readonly abilities: StatblockPresentationLabel;
  /** Actions / attacks section heading. */
  readonly actions: StatblockPresentationLabel;
  /** Creature-type / traits / descriptor / role label. */
  readonly creatureType: StatblockPresentationLabel;
}

/**
 * Neutral labels for unknown / homebrew rule systems (issue #763). Mechanical mapping may
 * still fall back to the 5e adapter, but the UI must not claim "Challenge" / "Armor Class"
 * for a pack that never defined those terms.
 */
export const NEUTRAL_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Rating' },
  defense: { full: 'Defense' },
  hitPoints: { full: 'Hit Points', short: 'HP' },
  abilities: { full: 'Abilities' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Type' },
};

/** D&D 5e / Open5e SRD presentation — Challenge + Armor Class. */
export const DND5E_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Challenge', short: 'CR' },
  defense: { full: 'Armor Class', short: 'AC' },
  hitPoints: { full: 'Hit Points', short: 'HP' },
  abilities: { full: 'Abilities' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Type' },
};

/** Pick the visible form of a presentation label (`short` when requested and present). */
export function statblockLabelText(label: StatblockPresentationLabel, preferShort = false): string {
  return preferShort && label.short ? label.short : label.full;
}

export interface RuleSystemAdapter {
  /** Stable family id for this adapter (not a pack slug), e.g. 'dnd5e'. */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /**
   * User-facing statblock field labels for this system (issue #763). The shared StatBlock
   * renderer reads these instead of hardcoding "Challenge" / "Armor Class".
   * Optional for external / custom adapters — {@link statblockPresentation} falls back to
   * {@link NEUTRAL_STATBLOCK_PRESENTATION} when omitted.
   */
  readonly presentation?: StatblockPresentation;
  /** Ability-score → modifier (5e: floor((score - 10) / 2)). Character sheets always use this. */
  abilityModifier(score: number): number;
  /** Die size for an initiative roll (5e: d20). Keeps the d20 assumption out of the generic roller. */
  readonly initiativeDie: number;
  /**
   * Hard level cap for this system, sourced from the adapter so `levelUp` doesn't bake in 5e's
   * 20 (issue #535). 5e/PF1e/PF2e/Starfinder are 20; 13th Age is 10. A system with no hard cap
   * (Open Legend, OSR retroclones) uses `Infinity`, so a `levelUp` check of
   * `existing.level >= maxLevel` is never true and the character may advance without bound.
   * Always read via comparison (never `level + 1 === maxLevel`): Infinity + 1 is still Infinity.
   */
  readonly maxLevel: number;
  /**
   * Derive a combatant's initiative modifier from an ability map (5e: the DEX modifier).
   * Accepts either canonical character stats (`{ DEX: 14 }`) or a raw monster `abilityScores`
   * object (`{ dexterity: 14 }`); returns 0 when the governing value is absent or non-numeric.
   * Pass `representation` from `mapStatblock().abilityRepresentation` for monsters so
   * already-modifier / native values are not converted a second time (issue #767).
   * Optional `level` is for systems whose initiative check includes a level/proficiency
   * term (PF2e Perception = WIS mod + proficiency; issue #491). Callers pass the
   * character's level on the character-sheet path; monster/statblock paths omit it.
   */
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation?: AbilityRepresentation,
    level?: number,
  ): number;
  /**
   * OPTIONAL — resolve an initiative modifier, or `null` when it cannot be derived
   * (issue #764). Systems that implement this (PF1e) let encounter/generator callers
   * surface "unavailable" instead of inventing a silent +0; the numeric
   * {@link initiativeModifier} seam remains for rollers that need a default. Other
   * adapters leave this undefined and keep returning 0 from `initiativeModifier`.
   */
  initiativeModifierOrNull?(
    abilities: Record<string, unknown> | null | undefined,
    representation?: AbilityRepresentation,
    level?: number,
  ): number | null;
  /**
   * Compare two combatants with equal initiative totals for running-order sort (issue #611).
   * Return negative if `a` should act before `b`. Called only after initiative totals match
   * (or both are null). 5e: higher DEX/`initMod` first, then `sortOrder` ascending as a
   * stable fallback (no roll-off prompt — DM may manually reorder). PF2e: preserve
   * roll/add order via `sortOrder` only (do not re-sort by DEX).
   */
  initiativeTiebreak(a: InitiativeTiebreakCombatant, b: InitiativeTiebreakCombatant): number;
  /** The condition vocabulary offered in the combat UI (5e: the run-session chip list). */
  readonly conditions: readonly string[];
  /** Map a monster rule-entry's `dataJson` to canonical statblock fields (AC/HP/CR/abilities/…). */
  mapStatblock(data: Record<string, unknown>): MonsterStatblockData;
  /** Resolve a monster's numeric max HP from its `dataJson`, or null when unavailable. */
  monsterHitPoints(data: Record<string, unknown>): number | null;
  /**
   * OPTIONAL — dice-pool systems only (issue #299, Open Legend). A d20-and-modifier
   * system (5e) leaves this undefined and keeps rolling `initiativeDie + initiativeModifier`
   * through the generic roller. A system whose action resolution is an *exploding attribute
   * dice pool* rather than a single die+mod implements this to expose that pool: given an
   * attribute score it returns the die sizes to roll (summed, each exploding on its max),
   * and whether the pool is rolled at disadvantage (rolled twice, keep the lower total).
   * Purely descriptive — no RNG — so it is deterministic and unit-testable; `rollActionDice`
   * (a free function) applies an injected roller to it.
   */
  attributeDicePool?(score: number): AttributeDicePool;
  /**
   * Whether this rule system is field-compatible with the D&D Beyond public-sheet importer
   * (issue #714). The importer maps a DDB sheet into the D&D-5e character shape (six
   * abilities, 5e AC/HP math, 5e conditions, 5e skills/saves), so importing into a
   * Pathfinder/OSR/13th-Age/Open-Legend campaign would silently produce a character whose
   * numbers belong to a different game. Only the 5e adapter opts in here; every other
   * adapter leaves it undefined (treated as false), so `ddbImportSupported()` hides and
   * rejects the import for them. This is the capability the UI checks to SHOW the import
   * affordance and the server checks to REJECT a direct-API request that bypasses the UI.
   */
  readonly supportsDdbImport?: boolean;
  /**
   * Whether this adapter owns encounter-difficulty math (issue #429). Only D&D 5e opts in;
   * other systems omit it so `encounterDifficultySupported()` / getDifficulty return an
   * explicit unsupported result instead of a misleading 5e "Trivial" band.
   */
  readonly supportsEncounterDifficulty?: boolean;
  /**
   * Estimate encounter difficulty for this ruleset. Required when
   * `supportsEncounterDifficulty` is true; unsupported adapters omit it.
   */
  estimateEncounterDifficulty?(input: EncounterDifficultyInput): EncounterDifficulty;
}

/**
 * The exploding dice pool for one attribute score (issue #299, Open Legend). `dice` are the
 * die sizes rolled and SUMMED; every die that shows its maximum face explodes (is rolled
 * again and added, repeatedly). `disadvantage` (Open Legend attribute score 0) means the
 * whole pool is rolled twice and the LOWER total is kept.
 */
export interface AttributeDicePool {
  score: number;
  dice: number[];
  disadvantage: boolean;
}

/**
 * Convert a stored ability value into the modifier used for rolls/display (issue #767).
 * Character sheets always pass `score` (or omit representation) so PF2e/5e keep
 * `floor((score-10)/2)`. Monster statblocks pass the representation from `mapStatblock`
 * so PF2e creature modifiers and Open Legend attributes are consumed exactly once.
 */
export function resolveAbilityModifier(
  adapter: Pick<RuleSystemAdapter, 'abilityModifier'>,
  value: number,
  representation: AbilityRepresentation = 'score',
): number {
  if (!Number.isFinite(value)) return 0;
  if (representation === 'score') return adapter.abilityModifier(value);
  return Math.trunc(value);
}

/** Read the governing (DEX) score from either a canonical or raw ability map, if numeric. */
function dnd5eDexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  const raw = abilities.DEX ?? abilities.dexterity ?? abilities.dex;
  return typeof raw === 'number' ? raw : null;
}

/** Family id of the built-in D&D 5e adapter (the default). */
export const DND5E_ADAPTER_ID = 'dnd5e';
/**
 * Rule-pack slug the Open5e importer installs the D&D 5e SRD under — what a campaign's
 * `ruleSystem` holds for a 5e campaign. Registered alongside the family id in the ADAPTERS
 * map so a campaign storing the pack slug resolves to the 5e adapter explicitly (not via
 * the unknown-slug fallback), which is what the DDB-import compatibility gate keys on.
 */
export const DND5E_PACK_SLUG = 'open5e-srd';

export const Dnd5eAdapter: RuleSystemAdapter = {
  id: DND5E_ADAPTER_ID,
  label: 'D&D 5e',
  presentation: DND5E_STATBLOCK_PRESENTATION,
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  // 5e caps character level at 20 (PHB). The cap lives here, not hardcoded in `levelUp`, so a
  // non-5e system enforces its own ceiling (issue #535): 13th Age (10), an uncapped OSR game, etc.
  maxLevel: 20,
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number {
    const dex = dnd5eDexScore(abilities);
    return dex === null ? 0 : resolveAbilityModifier(this, dex, representation);
  },
  // Issue #611: on equal initiative totals, higher DEX (stored as initMod) goes first.
  // Equal DEX falls back to sortOrder (stable insertion order). A DM roll-off / reorder
  // UI is out of scope for this PR — the DM can manually set initiative or reorder.
  initiativeTiebreak: initModDescThenSortOrderAsc,
  // The combat-UI condition vocabulary is the canonical 5e list (issue #111's single
  // source of truth), not a separate hand-maintained subset. This is what every 5e
  // surface — character sheet, encounter tracker, compendium — offers as suggestions.
  conditions: CONDITIONS,
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    const abilityScores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
    return {
      size: d.size,
      creatureType: d.type ?? d.creatureType,
      challengeRating: d.challengeRating ?? d.challenge_rating ?? d.cr,
      armorClass: d.armorClass ?? d.armor_class,
      hitPoints: d.hitPoints ?? d.hit_points ?? d.hp,
      speed: d.speed,
      abilityScores: abilityScores && typeof abilityScores === 'object' ? abilityScores : undefined,
      abilityRepresentation: 'score',
      specialAbilities: d.specialAbilities ?? d.special_abilities,
      actions: d.actions,
      legendaryActions: d.legendaryActions ?? d.legendary_actions,
      reactions: d.reactions,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const hp = d.hitPoints ?? d.hit_points ?? d.hp;
    return typeof hp === 'number' && hp > 0 ? Math.round(hp) : null;
  },
  // The D&D Beyond importer produces a 5e-shaped character (5e abilities/AC/HP/conditions),
  // so 5e is the one system that is field-compatible with it (issue #714).
  supportsDdbImport: true,
  // 5e owns the DMG XP-budget difficulty estimate (issues #58 + #429).
  supportsEncounterDifficulty: true,
  estimateEncounterDifficulty(input: EncounterDifficultyInput): EncounterDifficulty {
    return computeDnd5eEncounterDifficulty(input);
  },
};

// ---------- Open Legend adapter (issue #299) ----------
// Open Legend (openlegendrpg.com) is a fully-open OGL system with a dice model quite unlike
// 5e's d20+modifier: it has NO classes — eighteen *attributes* drive everything — and an
// action roll is an *exploding attribute dice pool*, not a single die plus a flat bonus. An
// attribute score (0–10+) indexes a fixed table of dice that are rolled and summed, and any
// die that lands on its maximum face explodes (rolls again, adds, repeatedly). Banes and
// boons are Open Legend's status-effect vocabulary (≈ 5e conditions).
//
// The 5e adapter's method shapes still fit where they can: `abilityModifier` is the identity
// (an Open Legend attribute IS its own modifier — it isn't halved-and-offset like a 5e score),
// initiative is an Agility roll so `initiativeModifier` reads Agility and `initiativeDie`
// stays 20 (the d20 that anchors every Open Legend pool) — so turn order rolled through the
// generic `rollInitiative(mod, die)` is `d20 + Agility`, monotonic in Agility, which is all
// initiative ordering needs. The genuinely new behaviour — the exploding attribute pool — is
// added as the OPTIONAL `attributeDicePool` interface member (5e leaves it undefined and is
// wholly unaffected); `rollActionDice` applies an injected roller to that pool.

/** Family id of the Open Legend adapter. */
export const OPEN_LEGEND_ADAPTER_ID = 'open-legend';
/** Rule-pack slug the Open Legend importer installs under (what a campaign's `ruleSystem` holds). */
export const OPEN_LEGEND_PACK_SLUG = 'open-legend-srd';

/**
 * Open Legend's status-effect vocabulary — banes (harmful) and boons (beneficial) — offered
 * as the combat-UI condition list for an Open Legend campaign, the same seam 5e fills with
 * CONDITIONS. This is the canonical core-rules set; an installed rule pack's imported
 * bane/boon entries are the searchable long-form reference, this list is the quick-apply chips.
 */
export const OPEN_LEGEND_BANES_BOONS = [
  // Banes (27) — exact names from openlegend/core-rules `banes/banes.yml`.
  'Blinded',
  'Charmed',
  'Deafened',
  'Death',
  'Demoralized',
  'Disarmed',
  'Dominated',
  'Fatigued',
  'Fear',
  'Forced Move',
  'Immobile',
  'Incapacitated',
  'Knockdown',
  'Memory Alteration',
  'Mind Dredge',
  'Nullify',
  'Persistent Damage',
  'Phantasm',
  'Polymorph',
  'Provoked',
  'Spying',
  'Sickened',
  'Silenced',
  'Slowed',
  'Stunned',
  'Stupefied',
  'Truthfulness',
  // Boons (32) — exact names from openlegend/core-rules `boons/boons.yml`.
  'Absorb Object',
  'Animation',
  'Aura',
  'Barrier',
  'Blindsight',
  'Bolster',
  'Concealment',
  'Darkness',
  'Detection',
  'Flight',
  'Genesis',
  'Haste',
  'Heal',
  'Insubstantial',
  'Invisible',
  'Life Drain',
  'Light',
  'Precognition',
  'Reading',
  'Regeneration',
  'Resistance',
  'Restoration',
  'Seeing',
  'Shapeshift',
  'Summon Creature',
  'Sustenance',
  'Telekinesis',
  'Telepathy',
  'Teleport',
  'Tongues',
  'Transmutation',
  'Truesight',
] as const;
export type BaneOrBoonName = (typeof OPEN_LEGEND_BANES_BOONS)[number];

/**
 * Open Legend action-dice table (official Core Rules / SRD — openlegend/core-rules
 * `core/SRD.md`, "Action Dice"): an attribute score maps to the dice rolled and summed for any
 * action using that attribute, always alongside the anchoring d20. Score 0 is the d20 rolled at
 * disadvantage (twice, keep lower); score 1 adds 1d4; each further point upgrades or adds bonus
 * dice. No official score uses mixed die sizes. Table is authoritative for 0–10 (the PC/NPC
 * range). Above 10 (rare extraordinary attributes) the progression continues its published
 * shape: from score 6 up the bonus pool is (⌊score/2⌋ − 1) dice, all d8 on an even score and all
 * d10 on an odd score (so 11 → 4d10, 12 → 5d8, 13 → 5d10, …).
 */
const OPEN_LEGEND_ACTION_DICE: Record<number, number[]> = {
  1: [20, 4],
  2: [20, 6],
  3: [20, 8],
  4: [20, 10],
  5: [20, 6, 6],
  6: [20, 8, 8],
  7: [20, 10, 10],
  8: [20, 8, 8, 8],
  9: [20, 10, 10, 10],
  10: [20, 8, 8, 8, 8],
};

/** The exploding dice pool for an Open Legend attribute score (see OPEN_LEGEND_ACTION_DICE). */
export function openLegendAttributeDicePool(score: number): AttributeDicePool {
  const s = Number.isFinite(score) ? Math.max(0, Math.trunc(score)) : 0;
  if (s === 0) return { score: 0, dice: [20], disadvantage: true };
  if (s <= 10) return { score: s, dice: [...OPEN_LEGEND_ACTION_DICE[s]], disadvantage: false };
  // >10: continue the official progression — (⌊s/2⌋ − 1) bonus dice, d8 on an even score and
  // d10 on an odd score (11 → 4d10, 12 → 5d8, 13 → 5d10, …), all beside the anchoring d20.
  const count = Math.floor(s / 2) - 1;
  const size = s % 2 === 0 ? 8 : 10;
  const bonus = Array.from({ length: count }, () => size);
  return { score: s, dice: [20, ...bonus], disadvantage: false };
}

/** Read Open Legend's Agility score (governs initiative) from a canonical or raw attribute map. */
function openLegendAgility(abilities: Record<string, unknown> | null | undefined): number {
  if (!abilities) return 0;
  const raw = abilities.AGILITY ?? abilities.agility ?? abilities.AGI ?? abilities.agi;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** Open Legend presentation — Level + Guard (not Challenge / Armor Class). */
export const OPEN_LEGEND_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Level' },
  defense: { full: 'Guard' },
  hitPoints: { full: 'Hit Points', short: 'HP' },
  abilities: { full: 'Attributes' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Descriptor' },
};

export const OpenLegendAdapter: RuleSystemAdapter = {
  id: OPEN_LEGEND_ADAPTER_ID,
  label: 'Open Legend',
  presentation: OPEN_LEGEND_STATBLOCK_PRESENTATION,
  // Open Legend attributes are used directly (no floor((score-10)/2) offset) — an attribute
  // both indexes the dice table and, where a flat value is wanted, IS that value.
  abilityModifier(score: number): number {
    return Number.isFinite(score) ? Math.trunc(score) : 0;
  },
  // The d20 that anchors every Open Legend action pool. Turn order rolled through the generic
  // roller is d20 + Agility — the full exploding pool is available via attributeDicePool for
  // action resolution, but initiative only needs an Agility-monotonic ordering.
  initiativeDie: 20,
  // Open Legend has no class/level framework and no published hard character-level cap, so the
  // adapter reports Infinity — `levelUp` never rejects on the cap (issue #535). A campaign that
  // models "level" as a loose progression tier is free to advance without a synthetic 5e ceiling.
  maxLevel: Infinity,
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    _representation: AbilityRepresentation = 'native',
  ): number {
    // Agility is already the native attribute value (no score→mod conversion).
    return openLegendAgility(abilities);
  },
  // Open Legend initiative is Agility-monotonic; on a tied total, higher Agility (initMod)
  // goes first, then sortOrder — same shape as the 5e DEX-desc default (issue #611).
  initiativeTiebreak: initModDescThenSortOrderAsc,
  conditions: OPEN_LEGEND_BANES_BOONS,
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    const attributes = (d.attributes ?? d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
    const defenses = (d.defenses ?? d.defense) as Record<string, unknown> | undefined;
    // Open Legend's Guard defence is the closest analogue to 5e Armor Class (the number an
    // attack must beat); fall back to an explicit armorClass if the source carried one.
    const guard = defenses && typeof defenses === 'object' ? defenses.guard ?? defenses.Guard : undefined;
    return {
      size: d.size,
      creatureType: d.descriptor ?? d.type ?? d.creatureType,
      // Open Legend rates threat by level, not CR — expose it through the same channel.
      challengeRating: d.level ?? d.challengeRating ?? d.cr,
      armorClass: guard ?? d.armorClass ?? d.armor_class,
      hitPoints: d.hp ?? d.hitPoints ?? d.hit_points,
      speed: d.speed,
      abilityScores: attributes && typeof attributes === 'object' ? attributes : undefined,
      abilityRepresentation: 'native',
      specialAbilities: d.specialAbilities ?? d.special_abilities ?? d.actions,
      actions: d.actions,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const hp = d.hp ?? d.hitPoints ?? d.hit_points;
    return typeof hp === 'number' && hp > 0 ? Math.round(hp) : null;
  },
  attributeDicePool(score: number): AttributeDicePool {
    return openLegendAttributeDicePool(score);
  },
};

/** One die's exploding roll: the sequence of faces rolled (each explosion appended) and their sum. */
export interface ExplodingDieRoll {
  sides: number;
  faces: number[];
  total: number;
}

/** The full result of rolling an Open Legend attribute dice pool. */
export interface ActionDiceRoll {
  score: number;
  pool: number[];
  /** Per-die exploding sequences of the kept roll. */
  dice: ExplodingDieRoll[];
  /** Present only for a disadvantage (score-0) pool: the discarded higher-total roll's dice. */
  discarded?: ExplodingDieRoll[];
  disadvantage: boolean;
  total: number;
}

/**
 * Roll one die that explodes on its maximum face. `roll(sides)` MUST return an integer in
 * [1, sides]; injecting it keeps this pure and unit-testable. A guard caps the explosion
 * chain so a roller stuck returning the max face can't loop forever.
 */
export function rollExplodingDie(sides: number, roll: (sides: number) => number, maxExplosions = 100): ExplodingDieRoll {
  const faces: number[] = [];
  let total = 0;
  let n = 0;
  do {
    const face = roll(sides);
    faces.push(face);
    total += face;
    n += 1;
    if (face !== sides) break;
  } while (n < maxExplosions);
  return { sides, faces, total };
}

/**
 * Roll an Open Legend action for an attribute `score` using injected `roll(sides)` → [1,sides].
 * Every die in the pool explodes on its max face; a score-0 pool is rolled twice and the LOWER
 * total kept (disadvantage). Pure given `roll` — the server's dice module passes a crypto-backed
 * roller, tests pass a deterministic one.
 */
export function rollActionDice(score: number, roll: (sides: number) => number): ActionDiceRoll {
  const pool = openLegendAttributeDicePool(score);
  const rollPool = (): ExplodingDieRoll[] => pool.dice.map((sides) => rollExplodingDie(sides, roll));
  const sum = (ds: ExplodingDieRoll[]): number => ds.reduce((acc, d) => acc + d.total, 0);

  if (pool.disadvantage) {
    const a = rollPool();
    const b = rollPool();
    const aTotal = sum(a);
    const bTotal = sum(b);
    const [kept, discarded] = aTotal <= bTotal ? [a, b] : [b, a];
    return { score: pool.score, pool: pool.dice, dice: kept, discarded, disadvantage: true, total: sum(kept) };
  }

  const dice = rollPool();
  return { score: pool.score, pool: pool.dice, dice, disadvantage: false, total: sum(dice) };
}

// ---------- Pathfinder 2e adapter (issue #295) ----------
// PF2e is the flagship non-5e rule system and the pattern the other Tier-1 systems
// (#296-300) follow: a system-specific adapter object that (a) satisfies the shared
// RuleSystemAdapter seam so the combat/statblock code routes through it unchanged, and
// (b) exposes the system's own pure math (degrees of success, level-based DCs,
// proficiency) as extra members that callers holding the PF2e adapter can reach for.
// Everything here is pure and unit-tested — it has no data-source dependency, so it is
// the durable, correct core even before any PF2e content is imported.

/** Stable family id of the Pathfinder 2e adapter (not a pack slug). */
export const PF2E_ADAPTER_ID = 'pf2e';
/**
 * Pack slug the PF2e importer installs under. Registered in ADAPTERS so a campaign whose
 * `ruleSystem` is this slug routes its combat math through Pf2eAdapter (the importer and
 * the adapter share this one constant rather than hardcoding the string in two places).
 */
export const PF2E_PACK_SLUG = 'pf2e-srd';

/** PF2e proficiency ranks, lowest to highest. */
export const PF2E_PROFICIENCY_RANKS = ['untrained', 'trained', 'expert', 'master', 'legendary'] as const;
export type Pf2eProficiencyRank = (typeof PF2E_PROFICIENCY_RANKS)[number];

/** Rank bonus added on top of level when trained or better. */
const PF2E_RANK_BONUS: Record<Pf2eProficiencyRank, number> = {
  untrained: 0,
  trained: 2,
  expert: 4,
  master: 6,
  legendary: 8,
};

/**
 * PF2e proficiency bonus: your level plus a rank bonus (trained +2 … legendary +8) — this
 * "add your level" scaling is the core mechanical departure from 5e's fixed proficiency.
 * Untrained is a flat +0: you do NOT add your level (Player Core, "Proficiency").
 */
export function pf2eProficiencyBonus(level: number, rank: Pf2eProficiencyRank): number {
  if (rank === 'untrained') return 0;
  return Math.max(0, Math.trunc(level)) + PF2E_RANK_BONUS[rank];
}

/**
 * Level-based DC (GM Core, "DCs by Level") — the DC to set for a task of a given level.
 * The table isn't a clean linear formula (it steps by an extra +1 roughly every third
 * level and by +2 above 20th), so it is encoded exactly for levels 0–25 and clamped
 * outside that range rather than approximated.
 */
const PF2E_LEVEL_DC = [
  14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50,
];
export function pf2eLevelBasedDC(level: number): number {
  const l = Math.trunc(level);
  if (l <= 0) return PF2E_LEVEL_DC[0];
  if (l >= PF2E_LEVEL_DC.length) return PF2E_LEVEL_DC[PF2E_LEVEL_DC.length - 1];
  return PF2E_LEVEL_DC[l];
}

/** Simple DCs keyed by the required proficiency rank (GM Core): untrained 10 … legendary 40. */
const PF2E_SIMPLE_DC: Record<Pf2eProficiencyRank, number> = {
  untrained: 10,
  trained: 15,
  expert: 20,
  master: 30,
  legendary: 40,
};
export function pf2eSimpleDC(rank: Pf2eProficiencyRank): number {
  return PF2E_SIMPLE_DC[rank];
}

/** The four PF2e degrees of success, worst to best. */
export const PF2E_DEGREES = ['criticalFailure', 'failure', 'success', 'criticalSuccess'] as const;
export type Pf2eDegreeOfSuccess = (typeof PF2E_DEGREES)[number];

/**
 * PF2e degree of success (Player Core, "Checks"). Compare the check total to the DC:
 *   ≥ DC+10 → critical success; ≥ DC → success; ≤ DC−10 → critical failure; else failure.
 * Then a natural 20 shifts the result one degree BETTER and a natural 1 one degree WORSE
 * (a critical success can't improve further, a critical failure can't worsen further).
 * Pass `naturalRoll` (the raw d20 face) to apply that step; omit it to compare totals only.
 */
export function pf2eDegreeOfSuccess(total: number, dc: number, naturalRoll?: number): Pf2eDegreeOfSuccess {
  let step: number;
  if (total >= dc + 10) step = 3;
  else if (total >= dc) step = 2;
  else if (total <= dc - 10) step = 0;
  else step = 1;
  if (naturalRoll === 20) step = Math.min(3, step + 1);
  else if (naturalRoll === 1) step = Math.max(0, step - 1);
  return PF2E_DEGREES[step];
}

/**
 * PF2e condition vocabulary (remaster / ORC). A distinct vocabulary from the 5e list —
 * e.g. clumsy, enfeebled, frightened, off-guard (the remaster's name for legacy
 * "flat-footed"). Condition names are open game content, not Product Identity. Offered as
 * the combat-UI condition chips for a PF2e campaign.
 */
export const PF2E_CONDITIONS = [
  'Blinded',
  'Clumsy',
  'Concealed',
  'Confused',
  'Controlled',
  'Dazzled',
  'Deafened',
  'Doomed',
  'Drained',
  'Dying',
  'Encumbered',
  'Enfeebled',
  'Fascinated',
  'Fatigued',
  'Fleeing',
  'Frightened',
  'Grabbed',
  'Hidden',
  'Immobilized',
  'Invisible',
  'Observed',
  'Off-Guard',
  'Paralyzed',
  'Persistent Damage',
  'Petrified',
  'Prone',
  'Quickened',
  'Restrained',
  'Sickened',
  'Slowed',
  'Stunned',
  'Stupefied',
  'Unconscious',
  'Undetected',
  'Unnoticed',
  'Wounded',
] as const;
export type Pf2eConditionName = (typeof PF2E_CONDITIONS)[number];

/**
 * PF2e adapter surface — the shared RuleSystemAdapter seam plus the PF2e-only pure math a
 * caller that knows it holds the PF2e adapter can use directly. The extra members live
 * here (not on the shared interface) so 5e stays clean; systems #296-300 follow the same
 * "conform to the seam, extend with your own math" shape.
 */
export interface Pf2eRuleSystemAdapter extends RuleSystemAdapter {
  proficiencyBonus(level: number, rank: Pf2eProficiencyRank): number;
  levelBasedDC(level: number): number;
  simpleDC(rank: Pf2eProficiencyRank): number;
  degreeOfSuccess(total: number, dc: number, naturalRoll?: number): Pf2eDegreeOfSuccess;
}

/** PF2e / SF2e presentation — Level + Armor Class; creature type is Traits. */
export const PF2E_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Level' },
  defense: { full: 'Armor Class', short: 'AC' },
  hitPoints: { full: 'Hit Points', short: 'HP' },
  abilities: { full: 'Abilities' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Traits' },
};

export const Pf2eAdapter: Pf2eRuleSystemAdapter = {
  id: PF2E_ADAPTER_ID,
  label: 'Pathfinder 2e',
  presentation: PF2E_STATBLOCK_PRESENTATION,
  // Character ability SCORES still use the same floor((score-10)/2) mapping as 5e.
  // Creature statblocks store modifiers separately (`abilityRepresentation: 'modifier'`).
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  // PF2e characters cap at level 20 (Core Rulebook), the same ceiling as 5e.
  maxLevel: 20,
  // PF2e initiative is a SKILL CHECK — Perception by default — rolled on a d20, not a flat
  // DEX modifier (the 5e assumption). A numeric `perception` is already the full
  // Perception modifier and is LEVEL-INCLUSIVE (monster statblocks publish Perception
  // with level baked in; a character sheet that stores a computed Perception number is
  // the same). Otherwise (a character sheet of ability SCORES) Perception is
  // Wisdom-based and at least trained for every PC (Player Core), so the fallback is
  // `WIS mod + pf2eProficiencyBonus(level, 'trained')` — never the bare 5e-style WIS
  // mod alone (issue #491). When `representation` is `modifier` (mapped creatures),
  // WIS is already a modifier and must not be converted again (issue #767); that path
  // does not add proficiency (creatures expose Perception instead).
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
    level?: number,
  ): number {
    if (!abilities) return 0;
    const perception = abilities.perception ?? abilities.Perception;
    // Level-inclusive: return as-is (do not add proficiency a second time).
    if (typeof perception === 'number') return perception;
    const wisScore = abilities.WIS ?? abilities.wisdom ?? abilities.wis;
    if (typeof wisScore !== 'number') return 0;
    const wisMod = resolveAbilityModifier(this, wisScore, representation);
    // Character-sheet fallback only: ability scores + known level → trained Perception.
    if (
      representation === 'score' &&
      typeof level === 'number' &&
      Number.isFinite(level)
    ) {
      return wisMod + pf2eProficiencyBonus(Math.max(0, Math.trunc(level)), 'trained');
    }
    return wisMod;
  },
  // Issue #611: PF2e keeps tied combatants in preserved roll/add order (sortOrder).
  // Do NOT re-sort by DEX/initMod after equal initiative totals.
  initiativeTiebreak: sortOrderAscTiebreak,
  conditions: PF2E_CONDITIONS,
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    // PF2e statblocks list ability MODIFIERS (Str +4), not scores; the importer stores them
    // under `abilityMods`. Surface those under the seam's `abilityScores` field with
    // `abilityRepresentation: 'modifier'`, and fold in the flat Perception modifier so
    // initiativeModifier (above) can read it back out without a second conversion.
    const mods = (d.abilityMods ?? d.ability_mods ?? d.abilityScores ?? d.abilities) as
      | Record<string, unknown>
      | undefined;
    const perception = d.perception ?? d.perceptionMod;
    const abilityScores =
      mods && typeof mods === 'object'
        ? typeof perception === 'number'
          ? { ...mods, perception }
          : { ...mods }
        : typeof perception === 'number'
          ? { perception }
          : undefined;
    // Traits stand in for a 5e "creature type" (PF2e creatures are typed by traits). An
    // empty traits array joins to "" — treat that (and a blank string) as absent so the
    // creatureType/type fallback still applies instead of surfacing an empty label.
    const traitsRaw = Array.isArray(d.traits) ? (d.traits as unknown[]).join(', ') : d.traits;
    const traits = typeof traitsRaw === 'string' && traitsRaw.trim() === '' ? undefined : traitsRaw;
    return {
      size: d.size,
      creatureType: traits ?? d.creatureType ?? d.type,
      // PF2e has no CR — a creature's LEVEL is its difficulty rating; surface it in the CR slot.
      challengeRating: d.level ?? d.challengeRating ?? d.cr,
      armorClass: d.ac ?? d.armorClass ?? d.armor_class,
      hitPoints: d.hp ?? d.hitPoints ?? d.hit_points,
      speed: d.speed ?? d.speeds,
      abilityScores,
      abilityRepresentation: 'modifier',
      specialAbilities: d.specialAbilities ?? d.special ?? d.abilities_special,
      actions: d.actions ?? d.attacks,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const hp = d.hp ?? d.hitPoints ?? d.hit_points;
    return typeof hp === 'number' && hp > 0 ? Math.round(hp) : null;
  },
  proficiencyBonus: pf2eProficiencyBonus,
  levelBasedDC: pf2eLevelBasedDC,
  simpleDC: pf2eSimpleDC,
  degreeOfSuccess: pf2eDegreeOfSuccess,
};

/** Stable family id of the Starfinder 2e adapter. */
export const SF2E_ADAPTER_ID = 'sf2e';
/** Pack slug the SF2e importer installs under. */
export const SF2E_PACK_SLUG = 'sf2e-srd';

export type Sf2eRuleSystemAdapter = Pf2eRuleSystemAdapter;

export const Sf2eAdapter: Sf2eRuleSystemAdapter = {
  ...Pf2eAdapter,
  id: SF2E_ADAPTER_ID,
  label: 'Starfinder 2e',
};

// Sibling ruleset adapters (issues #296-300) live in their own files (type-only imports
// from here, so no runtime cycle) and register below. Adding a system is one import + one
// ADAPTERS entry, never a sweep across the combat code.
import { Pathfinder1eAdapter, PF1E_PACK_SLUG } from './pathfinder1e';
export * from './pathfinder1e';
import { StarfinderAdapter, STARFINDER_ADAPTER_ID } from './starfinder-adapter';
export * from './starfinder-adapter';
import { Archmage13aAdapter, ARCHMAGE_ADAPTER_ID } from './adapters/archmage';
export * from './adapters/archmage';
import { OsrAdapter, OSR_RULE_SYSTEM_SLUGS } from './osr-adapter';
export * from './osr-adapter';

/**
 * Registry of rule-system adapters, keyed by family id (and, for a system with its own
 * importer, its pack slug too — so `campaign.ruleSystem`, which stores the pack slug,
 * resolves straight to the adapter). 5e is the default; PF2e (issue #295) is the first
 * registered second system. A further system is added here, not by editing combat code.
 */
const ADAPTERS: Record<string, RuleSystemAdapter> = {
  [DND5E_ADAPTER_ID]: Dnd5eAdapter,
  // Pack slug the Open5e importer installs the 5e SRD under — campaigns store the slug in
  // `ruleSystem`, so it must resolve explicitly (not via the unknown-slug fallback) for the
  // DDB-import compatibility gate to recognize a real 5e campaign (issue #714).
  [DND5E_PACK_SLUG]: Dnd5eAdapter,
  // Open Legend (issue #299): registered under BOTH its family id and the pack slug a
  // campaign's `ruleSystem` actually holds (there is no 5e-style fallback for a non-default
  // system — an installed Open Legend campaign stores the pack slug, which must resolve here).
  [OPEN_LEGEND_ADAPTER_ID]: OpenLegendAdapter,
  [OPEN_LEGEND_PACK_SLUG]: OpenLegendAdapter,
  [PF2E_ADAPTER_ID]: Pf2eAdapter,
  // Pack slug the PF2e importer installs under — campaigns store the slug in `ruleSystem`.
  [PF2E_PACK_SLUG]: Pf2eAdapter,
  [SF2E_ADAPTER_ID]: Sf2eAdapter,
  [SF2E_PACK_SLUG]: Sf2eAdapter,
  [PF1E_PACK_SLUG]: Pathfinder1eAdapter, // Pathfinder 1e (issue #296)
  [STARFINDER_ADAPTER_ID]: StarfinderAdapter, // Starfinder 1e (issue #297)
  [ARCHMAGE_ADAPTER_ID]: Archmage13aAdapter, // 13th Age (issue #298)
  'archmage-srd': Archmage13aAdapter, // …and its installed rule-pack slug
};
// OSR pack (issue #300): one shared adapter resolves several retroclone slugs.
for (const slug of OSR_RULE_SYSTEM_SLUGS) ADAPTERS[slug] = OsrAdapter;

/**
 * Resolve the adapter for a campaign's `ruleSystem`. `ruleSystem` is a rule-pack slug
 * (or ''); it is matched against the adapter registry and falls back to the 5e adapter
 * for anything unrecognized — so every existing campaign keeps 5e behavior. The default
 * is deliberate, not a stopgap: 5e is the built-in system.
 */
export function ruleSystemAdapter(ruleSystem?: string | null): RuleSystemAdapter {
  if (ruleSystem && ADAPTERS[ruleSystem]) return ADAPTERS[ruleSystem];
  return Dnd5eAdapter;
}

/**
 * Resolve statblock presentation labels for a campaign's `ruleSystem` (issue #763).
 *
 * Unlike {@link ruleSystemAdapter}, unknown / empty / homebrew slugs do **not** inherit
 * the 5e "Challenge" / "Armor Class" copy — they return {@link NEUTRAL_STATBLOCK_PRESENTATION}
 * ("Rating" / "Defense") so a homebrew pack isn't mislabeled with 5e jargon. Registered
 * adapters (including explicit 5e) return their native `presentation`.
 */
export function statblockPresentation(ruleSystem?: string | null): StatblockPresentation {
  if (ruleSystem && ADAPTERS[ruleSystem]) {
    return ADAPTERS[ruleSystem].presentation ?? NEUTRAL_STATBLOCK_PRESENTATION;
  }
  return NEUTRAL_STATBLOCK_PRESENTATION;
}

/**
 * Unique registered adapters (by family id), stable order — for snapshot / parity tests
 * that must cover every system once (issue #763).
 */
export function listRuleSystemAdapters(): RuleSystemAdapter[] {
  const seen = new Set<string>();
  const out: RuleSystemAdapter[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    if (seen.has(adapter.id)) continue;
    seen.add(adapter.id);
    out.push(adapter);
  }
  // Sort by id so snapshot order does not depend on ADAPTERS insertion order.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Whether the D&D Beyond public-sheet import (issue #18) should be offered for a campaign
 * whose `ruleSystem` is the given slug (issue #714). The importer maps a DDB sheet into the
 * D&D-5e character shape, so it is only field-compatible with an explicitly-5e campaign.
 *
 * "Explicitly" matters: a homebrew campaign (empty/undefined slug) falls back to the 5e
 * adapter for COMBAT math, but that fallback is a behaviour default, not a declaration that
 * the campaign is running D&D 5e. The issue calls for hiding the import unless an explicitly
 * compatible D&D pack is selected, so an empty/unknown slug is treated as INCOMPATIBLE here
 * even though it resolves to the 5e adapter downstream. Only a slug registered in the adapter
 * map AND whose adapter opts in via `supportsDdbImport` returns true.
 */
export function ddbImportSupported(ruleSystem?: string | null): boolean {
  if (!ruleSystem) return false; // homebrew / none selected
  const adapter = ADAPTERS[ruleSystem];
  if (!adapter) return false; // unrecognized slug — don't trust an unknown pack
  return adapter.supportsDdbImport === true;
}

/**
 * Whether encounter-difficulty estimation should run for a campaign whose `ruleSystem`
 * is the given slug (issue #429).
 *
 * - Empty / unrecognized slugs fall back to the 5e estimator (same default as combat math)
 *   so homebrew tables still get XP guidance — zero-data fights surface as `unknown`, not
 *   a fake Trivial band.
 * - A registered non-5e adapter (PF2e, OSR, …) that does not opt in returns unsupported.
 */
export function encounterDifficultySupported(ruleSystem?: string | null): boolean {
  if (!ruleSystem) return true; // homebrew → 5e fallback
  const adapter = ADAPTERS[ruleSystem];
  if (!adapter) return true; // unrecognized → 5e fallback
  return adapter.supportsEncounterDifficulty === true;
}

/**
 * Resolve difficulty for a campaign rule-system slug (issue #429). Supported adapters own
 * the math/labels; registered non-supporting systems return an explicit unsupported result.
 */
export function estimateEncounterDifficultyForRuleSystem(
  ruleSystem: string | null | undefined,
  input: EncounterDifficultyInput,
): EncounterDifficulty {
  if (!ruleSystem || !ADAPTERS[ruleSystem]) {
    return Dnd5eAdapter.estimateEncounterDifficulty!(input);
  }
  const adapter = ADAPTERS[ruleSystem];
  if (!adapter.supportsEncounterDifficulty || !adapter.estimateEncounterDifficulty) {
    return unsupportedEncounterDifficulty(adapter.label, input);
  }
  return adapter.estimateEncounterDifficulty(input);
}

// ---------- generic uploaded rule packs (issue #19) ----------
// Any open-licensed rules dataset (Pathfinder 2e ORC, other OGL/CC systems, homebrew
// under an open license) can be uploaded as JSON without needing a per-system API
// importer. The uploaded pack MUST carry an open license (validated server-side via
// isOpenLicense) — copyrighted/purchased content is out of scope and rejected.
const OPEN_LICENSE_KEYWORDS = [
  'ogl',
  'open game license',
  'open gaming license',
  'orc', // ORC / Open RPG Creative license
  'open rpg creative',
  'cc0',
  'cc-by',
  'cc by',
  'creative commons',
  'public domain',
  'unlicense',
  'wtfpl',
  'gfdl',
  'gnu free documentation',
];

/**
 * Whether a license string names a recognized open/free-culture license. Used to
 * gate uploaded rule packs (issue #19) so only open-licensed content can be added —
 * proprietary strings ("All Rights Reserved", a publisher name, "Proprietary") are
 * rejected. Substring match, case-insensitive, intentionally permissive about
 * formatting ("OGL 1.0a", "CC-BY-4.0", "Creative Commons Attribution 4.0" all pass).
 */
export function isOpenLicense(license: string): boolean {
  const l = (license ?? '').trim().toLowerCase();
  if (!l) return false;
  return OPEN_LICENSE_KEYWORDS.some((k) => l.includes(k));
}

/**
 * Whether a license string carries a Creative Commons NonCommercial (NC) or NoDerivatives
 * (ND) restriction, which forbids the redistribution/re-serving that bundling a map into a
 * campaign entails. This is the failure mode for battle-map content specifically (issue
 * #303): nearly every 'free map' pack is CC-BY-NC-ND, and — because `isOpenLicense` is a
 * permissive substring match — the string "CC-BY-NC-ND" itself sneaks past that gate on the
 * "cc-by" substring. This is an ADDITIVE guard layered on top of `isOpenLicense` (it does
 * not change that shared gate's behaviour): content-import paths that redistribute the bytes
 * must reject anything this flags, even when `isOpenLicense` returns true. Matches the "nc"/
 * "nd" tokens in CC short-forms ("by-nc", "by-nc-nd", "by-nd", "noncommercial",
 * "no derivatives") but not incidental substrings of unrelated words.
 */
export function licenseForbidsRedistribution(license: string): boolean {
  const l = (license ?? '').trim().toLowerCase();
  if (!l) return false;
  if (/\bnoncommercial\b|\bnon-commercial\b|\bno[\s-]?deriv\w*/.test(l)) return true;
  // CC short-form tokens: an "-nc" or "-nd" segment, or a bare "nc"/"nd" token.
  return /(^|[\s-])n[cd]([\s-]|$)/.test(l);
}

export const RulePackUploadEntry = z.object({
  slug: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
  type: RuleEntryType,
  summary: z.string().max(1000).optional(),
  body: z.string().max(50_000).optional(), // markdown
  dataJson: z.string().max(100_000).nullable().optional(), // raw structured fields, JSON-encoded
  license: z.string().max(120).optional(), // per-entry license; falls back to the pack license (validated open, issue #734)
  source: z.string().max(200).optional(), // per-entry source/document label; falls back to the pack name
  // Per-entry attribution/authorship provenance (issue #734): captured so a pack can mix
  // licenses/sources and the reader credits each entry correctly. Each falls back to the
  // pack-level value when omitted (attribution to the pack name, author to '', sourceUrl
  // to the pack's sourceUrl).
  attribution: z.string().max(500).optional(), // credit line the licence obliges us to show
  author: z.string().max(200).optional(), // creator/rights-holder name to credit
  sourceUrl: z.string().max(500).optional(), // deep link back to the entry on its origin site
  iconSlug: z.string().max(80).optional(), // optional bundled game-icons.net slug to seed the entry's icon (issue #305)
});
export type RulePackUploadEntry = z.infer<typeof RulePackUploadEntry>;

export const RulePackUpload = z.object({
  source: z.literal('upload'),
  pack: z.object({
    slug: z.string().min(1).max(80), // unique across installed packs, e.g. "pf2e-srd"
    name: z.string().min(1).max(120),
    version: z.string().max(40).optional(),
    license: z.string().min(1).max(120), // required — must be an open license (see isOpenLicense)
    sourceUrl: z.string().max(500).optional(),
  }),
  entries: z.array(RulePackUploadEntry).min(1).max(20_000),
});
export type RulePackUpload = z.infer<typeof RulePackUpload>;

// ---------- non-blocking install jobs (issue #20) ----------
export const RulePackInstallJobStatus = z.enum(['pending', 'running', 'completed', 'failed']);
export type RulePackInstallJobStatus = z.infer<typeof RulePackInstallJobStatus>;

export const RulePackSectionProgress = z.object({
  section: z.string(), // Open5e section name, or a rule-entry type for uploads
  status: z.enum(['pending', 'running', 'done', 'failed']),
  imported: z.number().int().nonnegative().default(0),
});
export type RulePackSectionProgress = z.infer<typeof RulePackSectionProgress>;

/**
 * Status of a background rule-pack install (issue #20). Install is no longer a
 * blocking request: POST /rules/packs/install (or /upload) returns 202 with one of
 * these immediately, and the UI polls GET /rules/packs/install-jobs/:id for progress.
 * `outcome` distinguishes a fresh install ('created') from an incremental add to an
 * existing pack ('updated', which also sets `added`/`skippedExisting`).
 */
export const RulePackInstallJob = z.object({
  id: z.string(), // opaque job id (uuid)
  source: z.enum(['open5e', 'pf2e', 'sf2e', 'pf1e', 'starfinder', 'archmage', 'open-legend', 'osr', 'upload']),
  status: RulePackInstallJobStatus,
  progress: z.array(RulePackSectionProgress).default([]),
  totalSections: z.number().int().nonnegative().default(0),
  completedSections: z.number().int().nonnegative().default(0),
  outcome: z.enum(['created', 'updated']).nullable().default(null),
  pack: RulePack.nullable().default(null), // populated on success
  added: z.number().int().nonnegative().nullable().default(null), // incremental installs only
  skippedExisting: z.number().int().nonnegative().nullable().default(null), // incremental installs only
  error: z.string().nullable().default(null), // populated on failure
  ...timestamps,
});
export type RulePackInstallJob = z.infer<typeof RulePackInstallJob>;

/** Default page size for GET /rules/search (issue #613). */
export const RULE_SEARCH_DEFAULT_LIMIT = 50;
/** Hard cap for `?limit=` on rule search — clients page with `cursor`, not a huge page. */
export const RULE_SEARCH_MAX_LIMIT = 100;

export const RuleSearchQuery = z.object({
  q: z.string().max(200).default(''),
  type: RuleEntryType.optional(),
  pack: z.string().max(80).optional(), // pack slug
  /** Page size (default 50, max 100). Omitted → default; never silently returns a truncated array. */
  limit: z.number().int().positive().max(RULE_SEARCH_MAX_LIMIT).optional(),
  /** Opaque stable cursor from a previous page's `nextCursor` (issue #613). */
  cursor: z.string().max(512).optional(),
});

/**
 * Paginated rule-search response (issue #613).
 *
 * Replaces the historical bare `RuleEntry[]` (hard-capped at 50 with no totals).
 * Always includes `total` + `hasMore` so clients never silently truncate; continue
 * with `nextCursor` when `hasMore` is true.
 */
export const RuleSearchPage = z.object({
  items: z.array(RuleEntry),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().max(512).optional(),
  limit: z.number().int().positive(),
});
export type RuleSearchPage = z.infer<typeof RuleSearchPage>;

// ---------- campaign summary (dashboard aggregate / AI primer) ----------
// Compact per-encounter digest for the campaign summary (issue #126) — enough for an
// AI drafting a recap or "the story so far" to SEE that combat happened, where/why/
// when it was pinned, and a survivor/down tally, without pulling every combatant row.
export const EncounterDigest = z.object({
  id: Id,
  name: z.string(),
  // Inline enum (mirrors EncounterStatus, declared later in this file) to avoid a
  // temporal-dead-zone reference — CampaignSummary sits above the encounter section.
  status: z.enum(['preparing', 'running', 'ended']),
  round: z.number().int().nonnegative(),
  endedAt: IsoDate.nullable(),
  locationId: Id.nullable(),
  questId: Id.nullable(),
  sessionId: Id.nullable(),
  combatantCount: z.number().int().nonnegative(),
  // Issue #625: the "down" tally used to sum EVERY combatant at 0 HP / dead — including
  // every dead monster — which inflated a glance at the summary. It now counts only
  // PCs (and NPCs) who fell; defeated monsters are reported separately so each number
  // is meaningful on its own.
  downCount: z.number().int().nonnegative(), // kind='character'|'npc' at 0 HP / down / dead
  monstersDefeated: z.number().int().nonnegative(), // kind='monster' at 0 HP / dead
});
export type EncounterDigest = z.infer<typeof EncounterDigest>;
export const CampaignSummary = z.object({
  campaign: Campaign,
  currentLocation: Location.nullable(),
  quests: z.array(Quest.extend({ objectives: z.array(QuestObjective) })),
  npcs: z.array(Npc),
  locations: z.array(Location),
  characters: z.array(Character),
  sessions: z.array(SessionListItem), // list-shape (recapExcerpt, not full recap) — issue #71
  encounters: z.array(EncounterDigest), // combat digest (issue #126) — makes fights visible to the continuity layer
  // Newer systems (issue #257) — bring the summary up to parity with what shipped.
  timeline: z.array(TimelineEvent), // in-world events, role-redacted (dmSecret stripped, hidden dropped for non-DM)
  // Party coin totals inlined (Treasury is declared below CampaignSummary — avoid a temporal-dead-zone reference).
  treasury: z.object({
    cp: z.number().int().nonnegative(),
    sp: z.number().int().nonnegative(),
    ep: z.number().int().nonnegative(),
    gp: z.number().int().nonnegative(),
    pp: z.number().int().nonnegative(),
  }),
  inventoryCount: z.number().int().nonnegative(), // number of loot/inventory items tracked
  commentCount: z.number().int().nonnegative(), // discussion comments the caller may see (anchor-visibility redacted)
  // Issue #818: split "happening now" from "next" so an in-progress game night stays
  // visible without hiding the later upcoming event. `nextSession` is the soonest
  // not-yet-started night (scheduledAt >= now); `inProgressSession` is the soonest
  // still inside its [scheduledAt, scheduledAt+duration) window.
  inProgressSession: ScheduledSessionWithRsvps.nullable(),
  nextSession: ScheduledSessionWithRsvps.nullable(),
  openInboxCount: z.number().int().nonnegative(),
});
export type CampaignSummary = z.infer<typeof CampaignSummary>;

// ---------- auth, users, settings, membership ----------
export const ServerRole = z.enum(['admin', 'user']);
export type ServerRole = z.infer<typeof ServerRole>;

// Hex color, e.g. #9184d9. Shared by User.accentColor and PreferencesUpdate below.
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// Semantic reading preference. The persisted field keeps its historical
// `textSize` name for API/storage compatibility, but the values now tune prose
// and other reading surfaces only — never controls, maps, or VTT geometry.
// `comfortable` also constrains prose to a readable line length.
export const TextSize = z.enum(['default', 'comfortable', 'large']);
export type TextSize = z.infer<typeof TextSize>;

export const User = z.object({
  id: Id,
  username: z.string().min(2).max(60).regex(/^[a-z0-9_.-]+$/i, 'letters, numbers, _ . - only'),
  displayName: z.string().max(120).default(''),
  serverRole: ServerRole.default('user'),
  disabled: z.boolean().default(false),
  // Personal accent color override (per-user UI theming). null = follow the server default (Nocturne blurple).
  accentColor: HexColor.nullable().default(null),
  // Personal reading preference (per-user semantic typography).
  textSize: TextSize.default('default'),
  ...timestamps,
}); // passwordHash never leaves the server
export type User = z.infer<typeof User>;

export const Password = z.string().min(8).max(200);
export const SetupRequest = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional() });
// password capped at 200 (matches `Password` above) — an unbounded string on this
// UNauthenticated path would let a caller force the server to run scrypt (CPU-heavy)
// against an arbitrarily large input before verifyPassword() even gets to reject it.
export const LoginRequest = z.object({ username: z.string().min(1), password: z.string().min(1).max(200) });
export const UserCreate = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional(), serverRole: ServerRole.optional() });
// Self-service signup (POST /auth/signup) — same shape as SetupRequest, but the created
// account is always serverRole 'user' (never admin) and the route is gated on allowSignup.
export const SignupRequest = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional() });
export const UserUpdate = z.object({ displayName: z.string().max(120).optional(), serverRole: ServerRole.optional(), disabled: z.boolean().optional() });
export const PasswordChange = z.object({ currentPassword: z.string().optional(), newPassword: Password }); // current required for self-change; admin reset omits

// Self-service preferences (PATCH /me/preferences) — separate from admin-only UserUpdate above.
export const PreferencesUpdate = z.object({
  displayName: z.string().max(120).optional(),
  accentColor: HexColor.nullable().optional(),
  textSize: TextSize.optional(),
});
export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>;

// ---------- forgot-password / self-service reset ----------
// The server may have no mail transport, so the reset path is admin-approved:
// a user files a reset request from the login screen (POST /auth/reset-request,
// @Public — always 202, no user-enumeration signal), a server admin approves it
// and receives a ONE-TIME reset code (stored hashed, short expiry) to hand to
// the user out-of-band, and the user redeems it (POST /auth/reset-confirm) to
// set a new password without the admin ever learning it.
export const PasswordResetRequestCreate = z.object({ username: z.string().min(1).max(60) });
export type PasswordResetRequestCreate = z.infer<typeof PasswordResetRequestCreate>;

export const PasswordResetStatus = z.enum(['pending', 'approved']);
export type PasswordResetStatus = z.infer<typeof PasswordResetStatus>;

export const PasswordResetRequest = z.object({
  id: Id,
  userId: Id,
  username: z.string().default(''), // denormalized for display
  displayName: z.string().default(''),
  status: PasswordResetStatus,
  requestedAt: IsoDate,
  approvedAt: IsoDate.nullable().default(null),
  expiresAt: IsoDate.nullable().default(null), // set when approved — code is dead past this
}); // codeHash never leaves the server
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

// Admin approval response — `code` is returned ONCE, stored hashed.
export const PasswordResetApproval = z.object({ code: z.string(), expiresAt: IsoDate, request: PasswordResetRequest });
export type PasswordResetApproval = z.infer<typeof PasswordResetApproval>;

// code capped like passwords — this is an UNauthenticated path (see LoginRequest note above).
export const PasswordResetConfirm = z.object({ code: z.string().min(1).max(200), newPassword: Password });
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirm>;

export const AuthStatus = z.object({
  setupRequired: z.boolean(), // true until the first (admin) user exists
  localLoginEnabled: z.boolean(), // for non-admin users (admins can always log in locally)
  signupEnabled: z.boolean(), // effective: allowSignup && allowLocalLogin && !setupRequired
  oidcEnabled: z.boolean(),
  // Optional operator-authored branding for the public login button. Null means
  // the UI must use neutral "SSO" copy; no issuer/client/group details belong here.
  oidcProviderName: z.string().max(80).nullable(),
  version: z.string(),
  /** Optional git SHA / build id when the image stamped one (issue #432). */
  commit: z.string().min(1).optional(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

/**
 * Safe, public reasons an OIDC browser flow can land on Campfire's recovery
 * page. These values are deliberately coarse: provider responses, OAuth
 * codes, state, PKCE material, tokens, claims, and configuration details must
 * never be copied into the recovery URL or rendered by the web client.
 */
export const OidcRecoveryCategory = z.enum([
  'cancelled',
  'flow_expired',
  'state_pkce_mismatch',
  'provider_unavailable',
  'client_token_failure',
  'missing_claims',
  'group_denied',
  'account_disabled',
]);
export type OidcRecoveryCategory = z.infer<typeof OidcRecoveryCategory>;

export const ServerSettings = z.object({
  allowLocalLogin: z.boolean().default(true), // gate for non-admin local login
  allowSignup: z.boolean().default(false), // gate for self-service signup (POST /auth/signup) — off by default
  // Experimental server-side AI Dungeon Master (issue #28) — OFF by default. When
  // false, every AI-DM configure/turn path is 403-gated server-wide, so the feature
  // is inert until an admin opts the whole server in. See modules/ai-dm. This flag
  // doubles as the admin console's KILL SWITCH (issue #315): flipping it off pauses
  // all AI immediately.
  experimentalAiDm: z.boolean().default(false),
  // Server-wide HARD token cap (issue #315) — a ceiling on total tokens metered
  // across EVERY campaign's AI-DM seat. 0 = unlimited. When positive, a turn is
  // rejected (403) once the aggregate tokensUsed across all seats reaches the cap,
  // regardless of any per-campaign budget still remaining. Admin-managed from the
  // AI console (PUT /settings/ai/caps).
  aiServerTokenCap: z.number().int().nonnegative().max(1_000_000_000).default(0),
});
export type ServerSettings = z.infer<typeof ServerSettings>;
export const SettingsUpdate = ServerSettings.partial();

// ── OIDC / SSO in-app configuration (server-admin only) ──────────────────────
// Persisted alongside server settings so OIDC can be configured from the admin
// UI, not only via env vars. Precedence: an OIDC_* env var, when set, OVERRIDES
// the stored value for that field (see server oidc.config.ts). The client
// secret is WRITE-ONLY — it is accepted on update but never returned.
const OidcField = z.string().trim().max(2048);
const OidcProviderNameField = z.string().trim().max(80);

/** Non-secret origin of a single OIDC field value used during a diagnostic probe (issue #848). */
export const OidcConfigValueSource = z.enum(['draft', 'stored', 'environment', 'default']);
export type OidcConfigValueSource = z.infer<typeof OidcConfigValueSource>;

/** Last successful (or attempted) admin end-to-end OIDC diagnostic — never includes secrets. */
export const OidcLastE2eTest = z.object({
  testedAt: IsoDate,
  fingerprint: z.string(), // non-secret fingerprint of the config that was tested
  ok: z.boolean(),
});
export type OidcLastE2eTest = z.infer<typeof OidcLastE2eTest>;

/** OIDC settings as returned to admins (GET). Never includes the client secret. */
export const OidcSettings = z.object({
  providerName: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  adminGroup: z.string(),
  allowedGroup: z.string(),
  groupsClaim: z.string(),
  scope: z.string(),
  // Server-computed, read-only:
  clientSecretSet: z.boolean(), // a secret is stored or set via env (value never returned)
  enabled: z.boolean(), // effective config is complete (issuer + clientId + clientSecret all resolve)
  envKeys: z.array(z.string()), // OIDC_* env vars currently set — these override the stored values
  effectiveRedirectUri: z.string(), // the callback URL the flow will actually use
  /** Non-secret fingerprint of the effective (env-over-stored) config — compare to lastE2eTest.fingerprint. */
  configFingerprint: z.string(),
  /** Most recent admin end-to-end diagnostic result, if any. */
  lastE2eTest: OidcLastE2eTest.nullable().default(null),
});
export type OidcSettings = z.infer<typeof OidcSettings>;

/** Admin update payload. All fields optional. clientSecret is write-only: omit to keep the current secret, pass '' to clear it. */
export const OidcSettingsUpdate = z.object({
  providerName: OidcProviderNameField.optional(),
  issuer: OidcField.optional(),
  clientId: OidcField.optional(),
  clientSecret: z.string().max(2048).optional(),
  redirectUri: OidcField.optional(),
  adminGroup: OidcField.optional(),
  allowedGroup: OidcField.optional(),
  groupsClaim: OidcField.optional(),
  scope: OidcField.optional(),
});
export type OidcSettingsUpdate = z.infer<typeof OidcSettingsUpdate>;

/**
 * Diagnostic probe request (issue #848). Optional draft fields let an admin
 * validate before saving; omitted fields resolve from env-over-stored effective
 * config. `clientSecret` is write-only: omit/blank reuses the effective secret.
 */
export const OidcTestRequest = z.object({
  issuer: OidcField.optional(),
  clientId: OidcField.optional(),
  clientSecret: z.string().max(2048).optional(),
  redirectUri: OidcField.optional(),
  adminGroup: OidcField.optional(),
  allowedGroup: OidcField.optional(),
  groupsClaim: OidcField.optional(),
  scope: OidcField.optional(),
});
export type OidcTestRequest = z.infer<typeof OidcTestRequest>;

/** Per-check status for OIDC diagnostics. `skip` = not exercised by this probe kind. */
export const OidcCheckStatus = z.enum(['pass', 'fail', 'skip']);
export type OidcCheckStatus = z.infer<typeof OidcCheckStatus>;

export const OidcCheckResult = z.object({
  status: OidcCheckStatus,
  message: z.string(),
});
export type OidcCheckResult = z.infer<typeof OidcCheckResult>;

export const OidcDiagnosticChecks = z.object({
  discovery: OidcCheckResult,
  redirectClient: OidcCheckResult,
  tokenExchange: OidcCheckResult,
  requiredClaims: OidcCheckResult,
  groupPolicy: OidcCheckResult,
});
export type OidcDiagnosticChecks = z.infer<typeof OidcDiagnosticChecks>;

/** Which diagnostic probe produced the result. */
export const OidcDiagnosticKind = z.enum(['discovery', 'e2e']);
export type OidcDiagnosticKind = z.infer<typeof OidcDiagnosticKind>;

/**
 * Result of an OIDC diagnostic probe (discovery-only or end-to-end test login).
 * Never echoes secrets. `message` for a successful discovery probe is
 * "Discovery reachable." (issue #848) — not a claim that login works.
 */
export const OidcTestResult = z.object({
  ok: z.boolean(),
  kind: OidcDiagnosticKind,
  issuer: z.string(),
  message: z.string(),
  authorizationEndpoint: z.string().nullable().default(null),
  tokenEndpoint: z.string().nullable().default(null),
  testedAt: IsoDate,
  /** Non-secret fingerprint of the config values that were tested. */
  fingerprint: z.string(),
  /** Per-field non-secret origin of each value used in the probe. */
  fieldSources: z.object({
    issuer: OidcConfigValueSource,
    clientId: OidcConfigValueSource,
    clientSecret: OidcConfigValueSource,
    redirectUri: OidcConfigValueSource,
    adminGroup: OidcConfigValueSource,
    allowedGroup: OidcConfigValueSource,
    groupsClaim: OidcConfigValueSource,
    scope: OidcConfigValueSource,
  }),
  checks: OidcDiagnosticChecks,
});
export type OidcTestResult = z.infer<typeof OidcTestResult>;

/** Response from starting an admin-only end-to-end OIDC test login (issue #848). */
export const OidcTestLoginStart = z.object({
  authorizationUrl: z.string(),
  fingerprint: z.string(),
  fieldSources: OidcTestResult.shape.fieldSources,
});
export type OidcTestLoginStart = z.infer<typeof OidcTestLoginStart>;

export const CampaignMember = z.object({
  id: Id,
  campaignId: Id,
  userId: Id,
  role: Role, // dm | player | viewer — per campaign
  characterId: Id.nullable().default(null),
  username: z.string().default(''), // denormalized for display
  displayName: z.string().default(''),
  disabled: z.boolean().default(false), // unusable accounts never count as DM authority (#849)
  ...timestamps,
});
export type CampaignMember = z.infer<typeof CampaignMember>;
/**
 * Issue #819 — exclusive character seat model: at most one campaign_members row may
 * link a given characterId. Reassigning a seated (or otherwise owned) character to
 * another member requires an explicit `confirmTransfer: true` so the server can
 * atomically unlink the previous seat and move ownership; without it the write is
 * rejected with 409 CHARACTER_SEAT_TAKEN instead of silently stealing controls.
 */
export const MemberCreate = z.object({
  userId: Id,
  role: Role,
  characterId: Id.nullable().optional(),
  confirmTransfer: z.boolean().optional(),
});
export const MemberUpdate = z.object({
  role: Role.optional(),
  characterId: Id.nullable().optional(),
  confirmTransfer: z.boolean().optional(),
});

// Server-admin-only membership integrity diagnostics/recovery (#849). These
// shapes expose operational metadata only: campaign identity/name, account ids,
// roles and migration actions — never campaign entities or DM-secret content.
export const MembershipIntegrityRepairReason = z.enum([
  'missing_user',
  'missing_campaign',
  'missing_character',
]);
export const MembershipIntegrityRepairAction = z.enum(['removed_membership', 'cleared_character']);
export const MembershipIntegrityRepair = z.object({
  id: Id,
  campaignId: Id,
  campaignName: z.string().nullable(),
  memberId: Id,
  userId: Id,
  role: Role,
  reason: MembershipIntegrityRepairReason,
  action: MembershipIntegrityRepairAction,
  invalidReferenceId: Id.nullable(),
  createdAt: IsoDate,
});
export type MembershipIntegrityRepair = z.infer<typeof MembershipIntegrityRepair>;

export const MembershipIntegrityCampaign = z.object({
  campaignId: Id,
  campaignName: z.string(),
  usableDmCount: z.number().int().nonnegative(),
  disabledDmUserIds: z.array(Id),
  removedGhostMembershipCount: z.number().int().nonnegative(),
  repairRequired: z.boolean(),
});
export type MembershipIntegrityCampaign = z.infer<typeof MembershipIntegrityCampaign>;

export const MembershipIntegrityReport = z.object({
  generatedAt: IsoDate,
  campaigns: z.array(MembershipIntegrityCampaign),
  repairs: z.array(MembershipIntegrityRepair),
});
export type MembershipIntegrityReport = z.infer<typeof MembershipIntegrityReport>;

export const CampaignDmRepair = z.object({ campaignId: Id, userId: Id });
export type CampaignDmRepair = z.infer<typeof CampaignDmRepair>;

// ---------- campaign invites (DM invite links / join codes) ----------
// A DM-generated, shareable link that onboards a player without a server admin:
// whoever opens /join/<code> creates their own account (or joins with an existing
// one) and lands in the campaign at the role the DM chose. Never grants 'dm' —
// a leaked link must not hand out DM power. Codes are unguessable (128-bit
// random), expiring, optionally use-capped, and revocable by the DM.
export const InviteRole = z.enum(['player', 'viewer']);
export type InviteRole = z.infer<typeof InviteRole>;

export const CampaignInvite = z.object({
  id: Id,
  campaignId: Id,
  code: z.string(), // join code — the shareable link is <origin>/join/<code>
  role: InviteRole,
  createdByUserId: Id.nullable().default(null),
  expiresAt: IsoDate,
  maxUses: z.number().int().positive().nullable().default(null), // null = unlimited (until expiry/revocation)
  useCount: z.number().int().nonnegative().default(0),
  ...timestamps,
});
export type CampaignInvite = z.infer<typeof CampaignInvite>;

export const InviteCreate = z.object({
  role: InviteRole.default('player'),
  expiresInDays: z.number().int().min(1).max(365).default(7), // invites always expire — default one week
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
});
export type InviteCreate = z.infer<typeof InviteCreate>;

// DM kill-switch for public invite links (issue #857) — mirrors SessionSharePolicyUpdate.
// Disabling suspends every outstanding code without deleting rows; re-enabling is a
// deliberate act and is refused while the campaign is archived or trashed.
export const InvitePolicyUpdate = z.object({ enabled: z.boolean() });
export type InvitePolicyUpdate = z.infer<typeof InvitePolicyUpdate>;
export const InviteMutationResult = z.object({ revoked: z.number().int().nonnegative() });
export type InviteMutationResult = z.infer<typeof InviteMutationResult>;

// Public preview of a valid invite (GET /invites/:code) — just enough for the
// join page to say what you're joining and as what. campaignId is included so
// the web app can navigate to /c/:id after joining.
export const InvitePreview = z.object({
  campaignId: Id,
  campaignName: z.string(),
  role: InviteRole,
  expiresAt: IsoDate,
});
export type InvitePreview = z.infer<typeof InvitePreview>;

// Accept an invite as a brand-new user (POST /invites/:code/accept, @Public):
// creates the account AND the membership in one call, then starts a session.
export const InviteAccept = z.object({
  username: User.shape.username,
  password: Password,
  displayName: z.string().max(120).optional(),
});
export type InviteAccept = z.infer<typeof InviteAccept>;

// Server-enforced WRITE authority, orthogonal to token `scope` (which caps
// READ/role). A token's read role (dm/player/viewer) and its write mode are
// independent dimensions: a dm-scoped token can READ every secret yet still be
// forced to route every mutation through the DM's proposal queue.
//  - 'direct'  — writes apply immediately when the caller's role allows; the
//                per-request `?proposed=true` flag is honored as an opt-in. This
//                is the back-compat default: every pre-existing token behaves as
//                it always did.
//  - 'propose' — every mutation is COERCED into a pending proposal server-side,
//                regardless of the `?proposed=` flag; the token can never write
//                canon directly. Intended for AI/DM agents (issue #158).
//  - 'none'    — read-only: every write is rejected outright, no proposal path.
// Ordering (broadest → narrowest): direct > propose > none. A token minted BY a
// token can never be granted a broader writeScope than the calling token (see
// TokensService.create), mirroring the scope/adminEnabled caps.
export const WriteScope = z.enum(['direct', 'propose', 'none']);
export type WriteScope = z.infer<typeof WriteScope>;

// Present on Me only when the request authenticated via a PAT (Authorization:
// Bearer cf_pat_...). Describes what THAT token can actually do, so /me is
// truthful for debugging scoped AI access (issue #55): `scope` caps every
// per-campaign role, `campaignId` (when set) restricts the token to one
// campaign, and `serverAdmin` is the token's EFFECTIVE server-admin power
// (owner is a server admin AND the token was minted adminEnabled) — see
// hasServerAdminPower() on the server.
export const MeToken = z.object({
  tokenId: Id,
  name: z.string(),
  scope: Role,
  // Server-enforced write authority of THIS token (see WriteScope). Surfaced on
  // /me so an AI agent can see whether its writes are read-only ('none'), forced
  // to the proposal queue ('propose'), or direct ('direct').
  writeScope: WriteScope,
  campaignId: Id.nullable(),
  adminEnabled: z.boolean(),
  serverAdmin: z.boolean(),
});
export type MeToken = z.infer<typeof MeToken>;

/**
 * Server instance + data-generation identity (issue #723).
 *
 * A whole-server backup restore reuses the same numeric user/campaign IDs but
 * swaps out the entire dataset (DB rows + uploads) underneath. The PWA's
 * `/api` runtime cache (Workbox, 7-day TTL) is keyed only by URL, so after a
 * restore a cached GET for, say, `/api/v1/campaigns/3` would still serve the
 * PRE-restore bytes offline — leaking data the operator just rolled back.
 * Numeric IDs alone can't detect that; we need a token that changes whenever
 * the underlying data is replaced.
 *
 *   - `instanceId`  is a per-install UUID generated once and persisted in the
 *                   DB (server_meta). It differs across physically distinct
 *                   installs (two homelabs, or a dev vs prod box) so an SW that
 *                   somehow pointed at the wrong origin can never serve one
 *                   install's cached data for another. It is STABLE across a
 *                   backup/restore (it travels inside the restored DB), so it
 *                   alone is not enough to invalidate on restore.
 *   - `dataGeneration` is a monotonic integer (also persisted) that the server
 *                   bumps on every whole-server restore. It is the actual
 *                   "the bytes under these IDs have changed" signal: a restore
 *                   bumps it, so a client that cached responses against the
 *                   prior generation sees a mismatch and wipes them.
 *
 * Both fields ride on `/me` (already proven-live — see vite.config.ts) so the
 * web client learns the current identity from a response that did NOT come
 * from the SW cache, then namespaces its cached responses by
 * `${instanceId}:${dataGeneration}`. On a restore the next proven-live `/me`
 * carries a new generation; the client notices the change and purges the old
 * cache, so stale pre-restore bytes can never render as truth (online or
 * offline). The server itself does not need to know the client's cache key —
 * the contract is just "this is who I am right now".
 *
 * The combined token is also surfaced as the response header
 * `cf-data-generation` on `/me` so a non-/me caller that needs the current
 * generation (e.g. a diagnostic) can read it without parsing JSON.
 */
export const ServerInstance = z.object({
  /** Stable per-install UUID; travels inside a backup so the same box keeps it. */
  instanceId: z.string().min(1),
  /** Monotonic integer bumped on every whole-server restore. */
  dataGeneration: z.number().int().nonnegative(),
});
export type ServerInstance = z.infer<typeof ServerInstance>;

export const Me = z.object({
  user: User,
  // When `token` is present (PAT auth), memberships reflect the token's
  // EFFECTIVE view: role is capped to min(token scope, membership role) and a
  // campaign-bound token only lists that campaign. Cookie sessions see raw
  // membership roles and no `token` field.
  memberships: z.array(z.object({ campaignId: Id, role: Role, characterId: Id.nullable() })),
  // Server instance + data-generation identity (issue #723) — see
  // ServerInstance. Always present on a proven-live /me; the web client
  // namespaces the SW runtime cache by this so a restore invalidates stale
  // bytes. /me is excluded from the SW cache (vite.config.ts), so this value
  // is always authoritative, never a cached copy.
  instance: ServerInstance,
  token: MeToken.optional(),
});
export type Me = z.infer<typeof Me>;

// ---------- API tokens (PATs — REST + MCP auth) ----------
export const TokenScope = Role; // token caps the effective role; real role = min(scope, membership role)

export const ApiToken = z.object({
  id: Id,
  userId: Id,
  name: z.string().min(1).max(80),
  scope: TokenScope,
  // Server-enforced write authority, independent of `scope` — see WriteScope.
  // DB ROW default 'direct' (back-compat: pre-existing rows write exactly as
  // before). This is NOT the minting default — newly MINTED tokens omitting
  // writeScope are defaulted to 'propose' server-side (issue #575, see
  // TokensService). Existing DBs get the column added defaulting to 'direct'
  // via migrateApiTokensTableForWriteScope() (db.module.ts).
  writeScope: WriteScope.default('direct'),
  campaignId: Id.nullable().default(null), // null = all campaigns the owner can access
  // Whether this token may exercise SERVER-admin powers (ServerRolesGuard-gated routes,
  // install_rule_pack, etc) on behalf of an admin owner. Independent of `scope`, which
  // only caps per-campaign role — see RoleResolver / user.types.ts hasServerAdminPower().
  // Default false: a token minted without this explicitly set is never server-admin-capable,
  // even if its owner is a server admin. Only a caller who is CURRENTLY exercising real
  // server-admin power may mint a token with this true (TokensService.create).
  adminEnabled: z.boolean().default(false),
  tokenPrefix: z.string().max(12), // display only, e.g. cf_pat_9f2a
  lastUsedAt: IsoDate.nullable().default(null),
  ...timestamps,
}); // raw token is returned ONCE at creation, stored hashed
export type ApiToken = z.infer<typeof ApiToken>;
export const ApiTokenCreate = z.object({
  name: z.string().min(1).max(80),
  // When the caller is itself authenticated via a PAT, both scope and campaignId are
  // additionally capped to the CALLING token (TokensService.create): scope is silently
  // downgraded to min(requested, calling token's scope), and a campaign-bound calling
  // token can only mint tokens bound to that same campaign — a scoped-down token can
  // never mint a broader sibling.
  scope: TokenScope,
  // Server-enforced write authority (omitted → server defaults to 'propose',
  // issue #575: newly-issued tokens funnel mutations through the DM proposal
  // queue rather than writing canon directly). When the caller is itself
  // authenticated via a PAT, this is additionally capped to the calling token's
  // writeScope (min in the direct>propose>none order) — a propose-only token
  // can never mint a direct-write sibling. See WriteScope / TokensService.create.
  writeScope: WriteScope.optional(),
  campaignId: Id.nullable().optional(),
  adminEnabled: z.boolean().optional(), // requires the caller to currently hold real server-admin power; silently forced false otherwise
});
export const ApiTokenCreated = z.object({ token: z.string(), apiToken: ApiToken });

// Headless PAT bootstrap (POST /auth/token, @Public): verifies credentials in the
// same call that mints the token, so an AI agent can go from nothing to a working
// Bearer token in one round trip, no cookie/session dance required.
export const AuthTokenRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1).max(200), // same cap as LoginRequest.password — scrypt DoS guard on an unauthenticated path
  tokenName: z.string().min(1).max(80),
  scope: TokenScope.optional(), // default: 'viewer' (least privilege) — see TokensService.mintFor
  writeScope: WriteScope.optional(), // omitted → server defaults to 'propose' (issue #575); see WriteScope
  campaignId: Id.nullable().optional(),
  adminEnabled: z.boolean().optional(), // caller (the just-authenticated user) must currently be a server admin — see TokensService.create
});
export type AuthTokenRequest = z.infer<typeof AuthTokenRequest>;

// Admin provisioning (POST /users/:id/tokens, server-admin only): mint a PAT on
// behalf of another user. No username/password — the admin's own session/PAT is
// the credential; scope/campaignId are validated against the TARGET user's access.
export const AdminTokenCreate = z.object({
  tokenName: z.string().min(1).max(80),
  scope: TokenScope.optional(), // default: 'viewer'
  writeScope: WriteScope.optional(), // omitted → server defaults to 'propose' (issue #575); see WriteScope
  campaignId: Id.nullable().optional(),
  // May only be set true when the TARGET user (owner of the minted token) is themself
  // a server admin, AND the calling admin currently holds real (non-token-capped)
  // server-admin power — see UsersController.mintToken() / TokensService.create.
  adminEnabled: z.boolean().optional(),
});
export type AdminTokenCreate = z.infer<typeof AdminTokenCreate>;

// ---------- proposals (AI/collab writes pending DM approval) ----------
export const ProposalAction = z.enum(['create', 'update', 'delete']);
// `withdrawn` is a self-service terminal state (issue #124): the proposer pulled
// their own still-pending proposal before the DM acted. Distinct from `rejected`
// (a DM decision) so provenance/history stays honest about who ended it.
export const ProposalStatus = z.enum(['pending', 'approved', 'rejected', 'withdrawn']);

export const Proposal = z.object({
  id: Id,
  campaignId: Id,
  entityType: EntityType,
  // For creates this is null at propose time; once an approved create-proposal has
  // been applied it is backfilled with the created row's id, so the record's
  // provenance points at the entity it produced (issue #124).
  entityId: Id.nullable().default(null),
  action: ProposalAction,
  payload: z.record(z.string(), z.unknown()), // the Create/Update body that would have been applied
  // The target entity's state captured at propose time (update/delete proposals; null for
  // creates) — lets the DM review UI render a real before/after diff even if the entity
  // changes between propose and review. Persisted as the full DM-review snapshot
  // (dmSecret included). Non-DM proposer egress (create response, self-view list, MCP,
  // member export) projects a redacted/omitted view so dmSecret and unrevealed entities
  // never leak through the approval queue (issue #817).
  snapshot: z.record(z.string(), z.unknown()).nullable().default(null),
  // Human-readable attribution: the display name of the USER who submitted, even when
  // the write came in over a PAT (resolved to the token's owning user — issue #124).
  proposer: z.string().max(200),
  // Stable id of the submitting user (String(users.id), or `dev:<name>` under DEV_AUTH).
  // Powers the proposer self-view: a non-DM member lists only proposals where this
  // matches them. Empty string on rows written before this column existed.
  proposerUserId: z.string().max(200).default(''),
  // Secondary provenance: the token name when submitted via a PAT, else null. Lets the
  // DM see "acting as <user> via token <name>" without losing the human attribution.
  proposerToken: z.string().max(200).nullable().default(null),
  status: ProposalStatus.default('pending'),
  resolvedBy: z.string().max(200).default(''),
  note: z.string().max(1000).default(''),
  ...timestamps,
});
export type Proposal = z.infer<typeof Proposal>;
export const ProposalResolve = z.object({ note: z.string().max(1000).optional() });
// Revise a still-pending proposal (issue #124): the proposer amends their own
// proposed create/update body before the DM acts. Validated against the target
// entity's Create/Update schema server-side, same as an edit-before-approve.
export const ProposalRevise = z.object({ payload: z.record(z.string(), z.unknown()) });
export type ProposalRevise = z.infer<typeof ProposalRevise>;
// Approve may carry an amended `payload` (edit-before-approve): the DM tweaks the
// proposed create/update body before it's applied through the normal write path.
// Ignored for `delete` proposals (which carry no payload). Omit `payload` to apply
// the proposal exactly as submitted.
export const ProposalApprove = z.object({
  note: z.string().max(1000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ProposalApprove = z.infer<typeof ProposalApprove>;
// Batch resolve: approve or reject up to 100 pending proposals in one request. Each
// id is resolved independently through the same atomic approve/reject path, so the
// response reports per-id success/failure rather than failing the whole batch.
export const ProposalBatchResolve = z.object({
  ids: z.array(Id).min(1).max(100),
  note: z.string().max(1000).optional(),
});
export type ProposalBatchResolve = z.infer<typeof ProposalBatchResolve>;

// ---------- experimental: server-side AI Dungeon Master (issue #28) ----------
// Plumbing for an AI that holds the DM seat of a campaign: everyone else plays,
// a connected agent (over MCP or REST, authenticated with a dm-scoped PAT) drives
// the existing tool layer — narrating, running combat, writing recaps. It is
// deliberately MCP-FIRST and self-hosted: Campfire ships NO server-side LLM
// dependency and never calls a vendor. The narration text is produced by an
// injected AiDmProvider (server DI seam) whose shipped default is a no-op that
// returns a scaffold response and instructs the operator to point the seat at a
// connected agent — an operator may swap in their own provider. Gated twice: the
// server-wide experimental flag (ServerSettings.experimentalAiDm) AND the
// per-campaign seat's `enabled`. Every turn is metered against a per-campaign
// token budget and audited as `ai-dm`.
export const AiDmTurnKind = z.enum(['narrate', 'combat', 'recap']);
export type AiDmTurnKind = z.infer<typeof AiDmTurnKind>;

// How the AI participates in a campaign (issue #311). This is the first-class
// "operating mode" of the seat, orthogonal to the metering/`enabled` turn gate:
//   - off    : no AI participation (default).
//   - co_dm  : AI only PROPOSES — every write flows through the approval queue
//              (#124); the human DM runs the table. The safe, recommended mode.
//   - driver : the AI HOLDS the DM seat and runs the game (#312). Requires the
//              server experimental flag, a positive token budget, AND a configured
//              provider — configuring it otherwise is a 409 (enforced server-side).
// Non-secret, so players can see it: it is the honest indicator of whether an AI
// is co-DMing or driving (unlike `instructions`, which is redacted per #261).
export const AiDmMode = z.enum(['off', 'co_dm', 'driver']);
export type AiDmMode = z.infer<typeof AiDmMode>;

/**
 * The canonical, player-visible description of what each AI DM mode may do (issue #752).
 * This is NON-SECRET — it is the honest provenance the trust copy is built from — and it
 * mirrors the server-side tool authority exactly:
 *   - Co-DM (`co-dm.service.ts`) only ever files PENDING PROPOSALS; nothing applies until
 *     a human DM approves. `directActions` is empty by design.
 *   - Driver (`ai-driver.service.ts`) holds the DM seat. The `directActions` list below is
 *     the one rendered into trust copy (login, settings, the transparency note) so the copy
 *     cannot drift from what the seat actually does; it is a description of the server's
 *     DRIVER_LIVE_PLAY_TOOLS allow-list, not a separate grant. Canon edits (new NPCs, quests,
 *     locations) are still forced onto the proposal path in both modes — that is `canonViaProposal`.
 *
 * UI copy and the policy-backed content test both read from here so the words a player sees
 * stay anchored to the actual tool permissions.
 */
export interface AiDmModeCapability {
  /** Short label for the capability as it appears in trust copy (e.g. "rolls dice"). */
  label: string;
  /**
   * A keyword that MUST appear in any trust-copy sentence claiming the Driver acts directly.
   * The content test asserts each keyword is present in the Driver-facing copy surfaces, so
   * a copy edit can't quietly drop a capability the seat actually has (or claim one it lacks).
   */
  copyKeyword: string;
}

export const AI_DM_MODE_CAPABILITIES: Readonly<
  Record<AiDmMode, { proposes: boolean; directActions: readonly AiDmModeCapability[]; canonViaProposal: boolean }>
> = {
  off: { proposes: false, directActions: [], canonViaProposal: false },
  co_dm: {
    // Co-DM only ever drafts proposals a human DM must approve — never a direct write.
    proposes: true,
    directActions: [],
    canonViaProposal: true,
  },
  driver: {
    // Driver holds the DM seat and resolves live play directly within its budget; canon
    // edits still become proposals. directActions mirrors DRIVER_LIVE_PLAY_TOOLS.
    proposes: true,
    directActions: [
      { label: 'narrates the scene', copyKeyword: 'narrat' },
      { label: 'rolls dice', copyKeyword: 'roll' },
      { label: 'applies HP and conditions', copyKeyword: 'HP' },
      { label: 'awards XP and levels', copyKeyword: 'XP' },
      { label: 'advances combat turns', copyKeyword: 'turn' },
      { label: 'reveals map regions', copyKeyword: 'map' },
      // Capabilities the seat has but the trust-copy summary does not enumerate by name.
      // Listed so the manifest stays a complete mirror of DRIVER_LIVE_PLAY_TOOLS; their
      // absence from player-facing prose is intentional (a summary, not an inventory).
      { label: 'ticks quest objectives', copyKeyword: '' },
      { label: 'jots table notes', copyKeyword: '' },
    ],
    canonViaProposal: true,
  },
};

// One AI-DM "seat" per campaign (created lazily on first configure/read).
export const AiDmSeat = z.object({
  campaignId: Id,
  mode: AiDmMode.default('off'), // operating mode: off / co_dm / driver (issue #311)
  enabled: z.boolean().default(false), // per-campaign on/off (in addition to the server flag)
  model: z.string().max(120).default(''), // informational label of the model/agent occupying the seat
  instructions: z.string().max(20_000).default(''), // the DM persona / house rules the connected agent should follow
  // Per-campaign metering, in tokens. tokenBudget is a HARD cap: a turn whose cost
  // would push tokensUsed past it is rejected (403). 0 = no budget → no turns allowed
  // (a positive budget must be configured to run the seat).
  tokenBudget: z.number().int().nonnegative().max(1_000_000_000).default(0),
  tokensUsed: z.number().int().nonnegative().default(0),
  turnCount: z.number().int().nonnegative().default(0),
  lastTurnAt: IsoDate.nullable().default(null),
  ...timestamps,
});
export type AiDmSeat = z.infer<typeof AiDmSeat>;

// Configure the seat (PUT /campaigns/:id/ai-dm, dm only). All fields optional;
// an omitted field is left unchanged.
export const AiDmSeatUpdate = z.object({
  mode: AiDmMode.optional(), // operating mode (issue #311); driver has server-side preconditions
  enabled: z.boolean().optional(),
  model: z.string().max(120).optional(),
  instructions: z.string().max(20_000).optional(),
  tokenBudget: z.number().int().min(0).max(1_000_000_000).optional(),
});
export type AiDmSeatUpdate = z.infer<typeof AiDmSeatUpdate>;

// Ask the AI DM to take a turn (POST /campaigns/:id/ai-dm/turn, dm only, or the
// MCP ai_dm_narrate tool). `prompt` is the situation/what the players just did.
export const AiDmTurnRequest = z.object({
  prompt: z.string().min(1).max(20_000),
  kind: AiDmTurnKind.default('narrate'),
  maxTokens: z.number().int().min(1).max(4096).optional(), // cap on this turn's output; provider clamps to the remaining budget
});
export type AiDmTurnRequest = z.infer<typeof AiDmTurnRequest>;

export const AiDmTurnResult = z.object({
  narration: z.string(), // the DM's response text (from the configured provider; the default is a no-op scaffold)
  provider: z.string(), // which provider produced it ('noop' by default)
  kind: AiDmTurnKind,
  tokensUsed: z.number().int().nonnegative(), // this turn's cost
  tokenBudget: z.number().int().nonnegative(), // the seat's cap
  budgetRemaining: z.number().int().nonnegative(), // after this turn
  seat: AiDmSeat, // the seat after metering
});
export type AiDmTurnResult = z.infer<typeof AiDmTurnResult>;

// Per-turn usage history (issue #1060). One row per metered token spend
// (driver step, co-DM draft, scribe run). Powers the DM's usage sparkline and
// audit view. Returned by GET /campaigns/:id/ai-dm/usage-history newest-first.
export const AiDmUsageHistoryEntry = z.object({
  id: Id,
  campaignId: Id,
  tokensUsed: z.number().int().nonnegative(),
  action: z.string(),   // e.g. 'ai-dm.driver.turn', 'ai-dm.scribe'
  model: z.string(),
  actor: z.string(),
  createdAt: IsoDate,
});
export type AiDmUsageHistoryEntry = z.infer<typeof AiDmUsageHistoryEntry>;

export const AiDmUsageHistoryResponse = z.object({
  items: z.array(AiDmUsageHistoryEntry),
  totalTokens: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});
export type AiDmUsageHistoryResponse = z.infer<typeof AiDmUsageHistoryResponse>;

// ── Co-DM authoring: draft content for the approval queue (issue #313) ────────
// The AI acts as a co-DM that DRAFTS content the human DM reviews. A `draft`
// request is turned by the configured provider into structured entity content and
// filed as a PENDING PROPOSAL (never a direct write) — so nothing lands in canon
// until the DM approves it. Encounters/maps reuse the deterministic generators
// (#304/#306); the proposal payload carries their (seeded) params and approval
// runs the generator. Every draft is metered against the seat budget and the
// proposer is attributed to the AI seat + model, not a raw token name.
export const CoDmDraftTarget = z.enum(['npc', 'location', 'beat', 'recap', 'encounter', 'map', 'quest', 'faction']);
export type CoDmDraftTarget = z.infer<typeof CoDmDraftTarget>;

// POST /campaigns/:id/ai-dm/draft (dm only) and the draft_content MCP tool.
export const CoDmDraftRequest = z.object({
  target: CoDmDraftTarget,
  // Free-text brief for the model, e.g. "a shady fence tied to the thieves guild".
  prompt: z.string().min(1).max(20_000),
  // How many drafts to produce (npc/location/beat only; ignored for recap/encounter/map).
  count: z.number().int().min(1).max(10).optional(),
});
export type CoDmDraftRequest = z.infer<typeof CoDmDraftRequest>;

export const CoDmDraftResult = z.object({
  target: CoDmDraftTarget,
  provider: z.string(), // which provider produced the draft ('noop' by default)
  model: z.string(), // the seat's model label
  // The proposal entity type the drafts were filed under (npc/location/quest/session/
  // encounter/map) — a beat files a quest, a recap files a session.
  entityType: z.string(),
  proposalIds: z.array(Id), // the pending proposals awaiting DM review
  proposals: z.array(Proposal),
  tokensUsed: z.number().int().nonnegative(), // metered against the seat budget
  tokenBudget: z.number().int().nonnegative(),
  budgetRemaining: z.number().int().nonnegative(),
});
export type CoDmDraftResult = z.infer<typeof CoDmDraftResult>;

// ── AI provider config: encrypted API-key + provider storage (issue #310) ────
// Feeds the vendor-neutral provider factory (#309) with the credentials/config it
// needs, at TWO scopes: a `server` default (admin-managed) and an optional
// per-`campaign` override (DM-managed) that FALLS BACK to the server default.
//
// The API key is stored ENCRYPTED at rest (aes-256-gcm) and is WRITE-ONLY: it is
// accepted on write but NEVER returned by any read/export/log/audit. A read exposes
// only a `configured` flag + the last-4 chars (`keyLast4`) — never the key. The
// non-secret `credentialSource` + `ready` fields distinguish encrypted storage,
// operator environment fallback, server fallback, and a missing credential. The
// decrypted key is materialized in-process only at call time (the effective-config
// resolver hands it straight to createAiProvider) and is never serialized to a client.
export const AiProviderConfigType = z.enum(['openai', 'anthropic', 'gemini', 'mock']);
export type AiProviderConfigType = z.infer<typeof AiProviderConfigType>;

// Non-secret description of where the effective credential comes from. `server`
// means a campaign override is borrowing the server-default stored credential;
// `environment` means the matching OPENAI_API_KEY / ANTHROPIC_API_KEY is in use.
// Keyless providers such as `mock` report `not-required` rather than pretending a
// secret exists. This enum is safe to return to admins/DMs; it never carries key
// material, a last-four value, or an environment-variable value.
export const AiProviderCredentialSource = z.enum([
  'stored',
  'environment',
  'server',
  'not-required',
  'none',
]);
export type AiProviderCredentialSource = z.infer<typeof AiProviderCredentialSource>;

// Sampling / limit params carried alongside the provider selection.
export const AiProviderParams = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});
export type AiProviderParams = z.infer<typeof AiProviderParams>;

// Write payload (PUT /settings/ai-provider | /campaigns/:id/ai-provider).
// `apiKey` is WRITE-ONLY: omit to KEEP the stored key, pass a value to set/ROTATE
// it, pass '' to CLEAR it. `allowedModels` is honored only for the SERVER scope —
// it is the admin model allowlist; when non-empty a campaign override's `model`
// must be one of the listed values (enforced server-side).
// Defense-in-depth for issue #373: a `baseUrl` override must be an absolute http(s)
// URL, not an arbitrary scheme (no `file:`, `javascript:`, credential-in-userinfo, …).
// The primary exfiltration fix binds the API key to its own scope's endpoint (see
// AiProviderConfigService.resolveEffectiveConfig); this guard additionally constrains
// what an override endpoint may even look like. `http` is permitted so self-hosted
// local model servers (e.g. http://localhost:11434) can be expressed — but the server
// applies a separate SSRF host policy (issue #1064): cloud metadata / link-local are
// always blocked, and private/loopback hosts require an operator opt-in
// (`AI_PROVIDER_ALLOW_PRIVATE_HOSTS`) or an explicit host allowlist.
const AiProviderBaseUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
      } catch {
        return false;
      }
    },
    { message: 'baseUrl must be an absolute http(s) URL without embedded credentials.' },
  );

export const AiProviderConfigUpdate = z.object({
  providerType: AiProviderConfigType,
  model: z.string().min(1).max(120),
  baseUrl: AiProviderBaseUrl.optional(),
  params: AiProviderParams.optional(),
  apiKey: z.string().max(4096).optional(),
  allowedModels: z.array(z.string().min(1).max(120)).max(200).optional(),
});
export type AiProviderConfigUpdate = z.infer<typeof AiProviderConfigUpdate>;

// Redacted read (GET). NEVER carries the API key — only `configured` + `keyLast4`.
export const AiProviderConfigView = z.object({
  scope: z.enum(['server', 'campaign']),
  campaignId: Id.nullable(), // set for the campaign scope; null for the server default
  providerType: AiProviderConfigType,
  model: z.string(),
  baseUrl: z.string().nullable(),
  params: AiProviderParams,
  configured: z.boolean(), // an encrypted API key is stored for this scope
  keyLast4: z.string().nullable(), // masked indicator only — never the key
  credentialSource: AiProviderCredentialSource,
  ready: z.boolean(), // the selected provider can resolve every required credential
  allowedModels: z.array(z.string()), // admin model allowlist (server scope); [] = unrestricted
  createdBy: z.string(),
  ...timestamps,
});
export type AiProviderConfigView = z.infer<typeof AiProviderConfigView>;

// Non-persisting candidate for POST .../ai-provider/test (issue #852). This is
// deliberately narrower than AiProviderConfigUpdate: testing cannot mutate the
// allowlist or sampling params. `apiKey` is WRITE-ONLY. Omitted OR '' means
// "reuse the current credential chain", matching the form's leave-key-blank
// behavior: this scope's stored key first, then the permitted environment/server
// fallback. A non-empty value tests that candidate key without storing it.
export const AiProviderTestRequest = z
  .object({
    providerType: AiProviderConfigType,
    model: z.string().min(1).max(120),
    baseUrl: AiProviderBaseUrl.optional(),
    apiKey: z.string().max(4096).optional(),
  })
  .strict();
export type AiProviderTestRequest = z.infer<typeof AiProviderTestRequest>;

// Non-secret credential source used by a connection test. `candidate` means the
// request supplied a non-empty write-only key; every other value describes a
// server-side reuse/fallback decision and carries no key material.
export const AiProviderTestCredentialSource = z.enum([
  'candidate',
  'stored',
  'environment',
  'server',
  'not-required',
  'none',
]);
export type AiProviderTestCredentialSource = z.infer<typeof AiProviderTestCredentialSource>;

// Result of POST .../ai-provider/test — a live, non-persisting probe of the
// submitted candidate. `testedTarget` distinguishes a campaign draft that can use
// its own endpoint from one whose blank key inherits the server credential AND,
// for SSRF safety, the server-owned provider/endpoint. Never echoes a credential.
export const AiProviderTestResult = z.object({
  ok: z.boolean(),
  scope: z.enum(['server', 'campaign']),
  testedTarget: z.enum(['server-default', 'campaign-override', 'inherited-server-default']),
  providerType: AiProviderConfigType,
  model: z.string(),
  baseUrl: z.string().nullable(),
  credentialSource: AiProviderTestCredentialSource,
  testedAt: IsoDate,
  error: z.string().nullable().default(null),
});
export type AiProviderTestResult = z.infer<typeof AiProviderTestResult>;

// Non-secret effective-provider indicator (GET /campaigns/:id/ai-provider/effective).
// A campaign DM cannot read the admin-only server-default config (/settings/ai-provider),
// so this minimal, role-gated (dm) read tells the campaign AI settings which provider is
// actually in effect and whether it comes from the SERVER default or a CAMPAIGN override.
// It carries NO key material — only the resolved type/model, source scope, and
// non-secret credential source/readiness.
// `configured` is false (and the other fields null) when neither scope has a provider.
export const AiProviderEffectiveView = z.object({
  configured: z.boolean(),
  providerType: AiProviderConfigType.nullable(),
  model: z.string().nullable(),
  source: z.enum(['server', 'campaign']).nullable(),
  credentialSource: AiProviderCredentialSource,
  ready: z.boolean(),
});
export type AiProviderEffectiveView = z.infer<typeof AiProviderEffectiveView>;

// ── Admin AI console (issue #315): opt-in, budgets & caps, usage, kill switch ──
// A server-admin-only cockpit over the AI program: the global kill switch
// (ServerSettings.experimentalAiDm), server-wide + per-campaign token caps, a usage
// rollup aggregated from the existing per-seat metering (AiDmSeat.tokensUsed —
// NO new ledger table), the model allowlist (#310's allowedModels) editor, and a
// provider-health "test all". Every route lives under `/settings/ai/*` and is
// @ServerRoles('admin'). No API key or raw prompt is ever surfaced here.

// One row of the usage dashboard: a campaign's AI-DM seat metering. `model` is the
// informational label of the model/agent occupying the seat (never a credential).
export const AiUsageCampaignRow = z.object({
  campaignId: Id,
  campaignName: z.string(),
  enabled: z.boolean(), // the seat's per-campaign on/off
  model: z.string(),
  tokenBudget: z.number().int().nonnegative(), // per-campaign hard cap (0 = seat can't run)
  tokensUsed: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  lastTurnAt: IsoDate.nullable(),
});
export type AiUsageCampaignRow = z.infer<typeof AiUsageCampaignRow>;

// Tokens/turns grouped by the seat's model label — the "by model" dashboard axis.
export const AiUsageModelRow = z.object({
  model: z.string(), // '' = seats with no model label set
  tokensUsed: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  seats: z.number().int().nonnegative(), // how many campaign seats use this model
});
export type AiUsageModelRow = z.infer<typeof AiUsageModelRow>;

// The full usage rollup (GET /settings/ai/usage) — aggregated live from seat counters.
export const AiUsageRollup = z.object({
  totalTokensUsed: z.number().int().nonnegative(),
  totalTurns: z.number().int().nonnegative(),
  seatCount: z.number().int().nonnegative(), // configured seats (persisted rows)
  activeSeatCount: z.number().int().nonnegative(), // seats with enabled=true
  serverTokenCap: z.number().int().nonnegative(), // 0 = unlimited
  serverBudgetRemaining: z.number().int().nonnegative().nullable(), // null when uncapped
  byCampaign: z.array(AiUsageCampaignRow),
  byModel: z.array(AiUsageModelRow),
});
export type AiUsageRollup = z.infer<typeof AiUsageRollup>;

// One provider-health probe result (GET-triggered POST /settings/ai/health). Reuses
// the connection-test shape; `campaignId` is null for the server-default provider.
export const AiProviderHealthEntry = z.object({
  scope: z.enum(['server', 'campaign']),
  campaignId: Id.nullable(),
  campaignName: z.string().nullable(),
  ok: z.boolean(),
  // The effective provider type as reported by the live probe. A plain string (not
  // the narrow config enum) because the provider factory's runtime type union is
  // broader (e.g. 'custom'); a health readout just displays whatever ran.
  providerType: z.string(),
  model: z.string(),
  error: z.string().nullable(),
});
export type AiProviderHealthEntry = z.infer<typeof AiProviderHealthEntry>;

// The console overview (GET /settings/ai) — everything the admin cockpit renders in
// one shot: kill switch, caps, allowlist, usage rollup, provider-config presence.
export const AiConsoleOverview = z.object({
  killSwitchEnabled: z.boolean(), // experimentalAiDm — the global opt-in/kill switch
  serverTokenCap: z.number().int().nonnegative(), // 0 = unlimited
  allowedModels: z.array(z.string()), // the #310 server allowlist ([] = unrestricted)
  serverProviderConfigured: z.boolean(), // a server-default provider row exists
  serverProviderType: AiProviderConfigType.nullable(),
  serverProviderReady: z.boolean(),
  serverCredentialSource: AiProviderCredentialSource,
  usage: AiUsageRollup,
});
export type AiConsoleOverview = z.infer<typeof AiConsoleOverview>;

// PUT /settings/ai/caps — set the server-wide token cap and/or per-campaign budgets.
// Both optional; an omitted field is left unchanged. Per-campaign entries upsert the
// seat's tokenBudget only (never touch usage counters).
export const AiCapsUpdate = z
  .object({
    serverTokenCap: z.number().int().nonnegative().max(1_000_000_000).optional(),
    campaigns: z
      .array(
        z.object({
          campaignId: Id,
          tokenBudget: z.number().int().nonnegative().max(1_000_000_000),
        }),
      )
      .max(500)
      .optional(),
  })
  .strict();
export type AiCapsUpdate = z.infer<typeof AiCapsUpdate>;

// POST /settings/ai/kill — the kill switch. `enabled:false` pauses all AI immediately.
export const AiKillSwitchUpdate = z.object({ enabled: z.boolean() }).strict();
export type AiKillSwitchUpdate = z.infer<typeof AiKillSwitchUpdate>;

// PUT /settings/ai/allowlist — replace the server model allowlist ([] = unrestricted).
export const AiAllowlistUpdate = z
  .object({ allowedModels: z.array(z.string().min(1).max(120)).max(200) })
  .strict();
export type AiAllowlistUpdate = z.infer<typeof AiAllowlistUpdate>;
// ── AI scribe: scheduled / automatic server-side recap jobs (issue #316) ──────
// The scribe runs the configured provider (#309/#310) on a trigger to draft a
// session recap from the campaign's own material (resolved inbox + encounters),
// filing it ALWAYS as a PROPOSAL for the DM to approve — nothing auto-publishes
// to canon. Governance is the AI-DM seat's: the server-wide experimentalAiDm
// flag + the per-campaign seat being enabled + its token budget (metered like a
// turn). Triggers: on-demand (endpoint/MCP), a post-session sweep after a
// scheduled game night ends, and an optional cron tick — the last two share one
// idempotent `sweep()` so a re-run never duplicates a recap.

// How a scribe run was initiated. `post_session`/`cron` fire from the periodic
// sweep; `on_demand` from the REST endpoint or the run_scribe MCP tool.
export const ScribeTrigger = z.enum(['on_demand', 'post_session', 'cron']);
export type ScribeTrigger = z.infer<typeof ScribeTrigger>;

// Terminal state of one recorded scribe run.
//  - succeeded         : a recap proposal was drafted + filed.
//  - skipped           : idempotent no-op (identical source already drafted, or a
//                        scribe recap proposal is already pending review).
//  - no_provider       : neither a configured provider (#310) nor an injected one.
//  - no_material       : the campaign had no inbox/encounter material to recap.
//  - disabled          : the experimental flag is off or the seat isn't enabled.
//  - over_budget       : the seat's token budget is exhausted.
//  - failed            : the provider call (or filing) threw.
export const ScribeJobStatus = z.enum([
  'succeeded',
  'skipped',
  'no_provider',
  'no_material',
  'disabled',
  'over_budget',
  'failed',
]);
export type ScribeJobStatus = z.infer<typeof ScribeJobStatus>;

// Per-campaign scribe configuration (GET/PUT /campaigns/:id/scribe, dm only).
// All triggers default OFF: the scribe is opt-in, so enabling the AI-DM seat
// alone never makes recaps appear unrequested. `budgetPerRun` caps a single
// run's output tokens (further clamped by the seat's remaining budget).
export const ScribeConfig = z.object({
  campaignId: Id,
  postSession: z.boolean().default(false), // sweep + draft after a scheduled session ends
  cron: z.boolean().default(false), // include this campaign in the periodic cron sweep
  budgetPerRun: z.number().int().min(1).max(200_000).default(2000), // per-run output-token cap
  ...timestamps,
});
export type ScribeConfig = z.infer<typeof ScribeConfig>;

export const ScribeConfigUpdate = z.object({
  postSession: z.boolean().optional(),
  cron: z.boolean().optional(),
  budgetPerRun: z.number().int().min(1).max(200_000).optional(),
});
export type ScribeConfigUpdate = z.infer<typeof ScribeConfigUpdate>;

// A recorded scribe run (read via GET /campaigns/:id/scribe/jobs).
export const ScribeJob = z.object({
  id: Id,
  campaignId: Id,
  trigger: ScribeTrigger,
  status: ScribeJobStatus,
  proposalId: Id.nullable().default(null), // the filed recap proposal, when status=succeeded
  proposalCount: z.number().int().nonnegative().default(0),
  tokensUsed: z.number().int().nonnegative().default(0),
  provider: z.string().default(''), // which provider produced it (e.g. 'mock','anthropic','noop')
  detail: z.string().default(''), // human-readable note / skip reason / error
  createdBy: z.string().default(''),
  createdAt: IsoDate,
});
export type ScribeJob = z.infer<typeof ScribeJob>;

// On-demand run request (POST /campaigns/:id/scribe/run). `dryRun` assembles +
// generates but files no proposal — a preview the DM can inspect before committing.
export const ScribeRunRequest = z.object({
  dryRun: z.boolean().default(false),
});
export type ScribeRunRequest = z.infer<typeof ScribeRunRequest>;

// Result of a run: the recorded job, the proposal ids filed (empty on skip/dry-run),
// and — on a dry run — the drafted recap text for preview.
export const ScribeRunResult = z.object({
  job: ScribeJob,
  proposalIds: z.array(Id).default([]),
  dryRun: z.boolean().default(false),
  preview: z.string().nullable().default(null), // drafted recap text (dry-run only)
});
export type ScribeRunResult = z.infer<typeof ScribeRunResult>;

// ---------- attachments (uploaded images: character portraits, campaign maps) ----------
export const AttachmentKind = z.enum(['portrait', 'map', 'image']);

export const Attachment = z.object({
  id: Id,
  campaignId: Id,
  uploaderUserId: z.string().max(120), // OIDC sub or dev user; audit/ownership (delete-by-uploader)
  kind: AttachmentKind,
  filename: z.string().max(255), // original client filename, display only
  mime: z.string().max(80),
  size: z.number().int().nonnegative(), // bytes
  // Per-attachment visibility / staged reveal (issue #97). `hidden` gates the file
  // bytes AND the row itself: a hidden attachment is DM-only — non-DM members get a
  // 404 on GET /attachments/:id/file and never see it in the campaign list, so an
  // uploaded-but-unrevealed handout (next-arc dungeon map, reveal art) can't be
  // fetched by id enumeration. New 'map'/'image' uploads default hidden=true (DM
  // prep material); 'portrait' uploads default hidden=false (player-visible). The
  // DM stages the reveal moment via POST /attachments/:id/reveal (hidden=false).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type Attachment = z.infer<typeof Attachment>;

// ---------- encounters (combat tracker) ----------
export const EncounterStatus = z.enum(['preparing', 'running', 'ended']);
export type EncounterStatus = z.infer<typeof EncounterStatus>;

// ---------- VTT: grid, token size, fog of war (issue #40, phases 2–3) ----------

/**
 * Token footprint size category (issue #40, phase 2). Scales the rendered token on the
 * battle map — a Medium creature occupies one grid cell (1×1), Large 2×2, etc. Purely a
 * display/footprint attribute; it does not affect combat math.
 */
export const TokenSize = z.enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan']);
export type TokenSize = z.infer<typeof TokenSize>;

/**
 * One DM-revealed rectangle of fog-of-war (issue #40, phase 3). Coordinates are 0–100
 * percent of the rendered map surface (same convention as combatant tokenX/tokenY): x/y is
 * the top-left corner, w/h the width/height. Everything OUTSIDE the union of revealed
 * rectangles is "in the dark".
 */
export const FogRect = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().min(0).max(100),
  h: z.number().min(0).max(100),
});
export type FogRect = z.infer<typeof FogRect>;

/**
 * Fog-of-war state for an encounter's battle map (issue #40, phase 3). When `enabled`, a
 * non-DM viewer sees only the revealed rectangles; the server additionally WITHHOLDS
 * (nulls) any combatant token whose position sits in an unrevealed region, so a player
 * client can't read where monsters lurk in the dark (the redaction is server-side, mirroring
 * the issue #43 monster-HP band). `revealed` is capped to keep the JSON blob bounded.
 */
export const FogState = z.object({
  enabled: z.boolean().default(false),
  revealed: z.array(FogRect).max(500).default([]),
});
export type FogState = z.infer<typeof FogState>;

/**
 * Battle-map grid geometry (issue #40 / #238). 'square' is the classic Battlemat grid; 'hex'
 * renders a pointy-top hexagonal overlay for hex-crawl / wilderness maps. Purely a display
 * choice for the overlay — the measurement ruler still reads cell size off gridSize/gridScale.
 */
export const GridType = z.enum(['square', 'hex']);
export type GridType = z.infer<typeof GridType>;

/**
 * Area-of-effect template shape (issue #238). 'circle' is a radius burst; 'cone' is a 5e
 * quadrant cone (length ≈ width); 'line' is a straight ray. Unlike the original client-only
 * circle, templates live in encounter state so every client at the table sees the same shape.
 */
export const AoeShape = z.enum(['circle', 'cone', 'line']);
export type AoeShape = z.infer<typeof AoeShape>;

/**
 * One shared AoE template painted on the battle map (issue #238). Coordinates are 0–100 percent
 * of the map surface (same convention as tokens/fog). `x`/`y` is the origin — the centre for a
 * circle, the apex for a cone or line. `sizeFt` is the radius (circle) or length (cone/line) in
 * the encounter's grid units; `angleDeg` aims a cone/line (0° points right/east, growing
 * clockwise) and is ignored for a circle. Persisted on the encounter so it syncs over SSE.
 */
export const AoeTemplate = z.object({
  id: z.string().min(1).max(40),
  shape: AoeShape,
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  sizeFt: z.number().positive().max(1000),
  angleDeg: z.number().min(-360).max(360).default(0),
  color: z.string().max(24).nullable().default(null),
});
export type AoeTemplate = z.infer<typeof AoeTemplate>;

/**
 * A transient "look here" ping broadcast over SSE (issue #238). Not persisted — it rides the
 * campaign event stream as a one-shot signal that every open client renders for a moment and
 * then lets fade. Coordinates are 0–100 percent of the map surface; any writing member may
 * drop one (a live table gesture, not DM-gated like fog).
 */
export const MapPing = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  color: z.string().max(24).nullable().default(null),
  label: z.string().max(40).nullable().default(null),
});
export type MapPing = z.infer<typeof MapPing>;

export const Encounter = z.object({
  id: Id,
  campaignId: Id,
  name: z.string().min(1).max(120),
  status: EncounterStatus.default('preparing'),
  round: z.number().int().nonnegative().default(0),
  // Positional turn cursor, kept in lockstep with `currentCombatantId` as a
  // display/back-compat convenience — it is the index of the current combatant in
  // the server-sorted order. `currentCombatantId` is the AUTHORITATIVE pointer
  // (issue #49): a positional index alone corrupts when a combatant is added or
  // removed mid-fight (everyone after the removed row shifts a slot and the
  // "current turn" highlight jumps to the wrong creature). null = no current
  // combatant (not running, or the encounter is empty).
  turnIndex: z.number().int().nonnegative().default(0),
  currentCombatantId: Id.nullable().default(null),
  // Optional links to WHERE / WHY / WHEN the encounter happened (issue #126) and an
  // optional battle map (issue #39). All nullable; absent in older DBs pre-migration.
  locationId: Id.nullable().default(null),
  questId: Id.nullable().default(null),
  sessionId: Id.nullable().default(null),
  // Battle map: a DM-uploaded image (attachment kind='map'|'image') rendered as the
  // run-session background, with combatant tokens overlaid at combatant.tokenX/tokenY (0–100).
  mapAttachmentId: Id.nullable().default(null),
  // VTT grid overlay (issue #40, phase 2). gridSize = one cell's edge length as a percent of
  // the map's rendered width (null = no grid drawn). gridScale + gridUnit give the cell's
  // real-world size (e.g. 5 ft) so the measurement ruler can read out distance; gridSnap
  // snaps a dropped token to the nearest cell centre. All nullable/absent on older DBs.
  gridSize: z.number().min(1).max(100).nullable().default(null),
  gridScale: z.number().positive().nullable().default(null),
  gridUnit: z.string().max(12).nullable().default(null),
  gridSnap: z.boolean().default(false),
  // Grid geometry (issue #238). 'square' (default) or 'hex' — a pointy-top hex overlay. Older
  // DBs backfill to 'square' via migration, preserving the original square-only behaviour.
  gridType: GridType.default('square'),
  // Fog of war (issue #40, phase 3). null = never configured (map fully visible). See FogState.
  fog: FogState.nullable().default(null),
  // Shared AoE templates (issue #238) — circle/cone/line shapes every client sees, unlike the
  // original client-local circle. Empty by default; capped so the JSON blob stays bounded.
  aoe: z.array(AoeTemplate).max(50).default([]),
  // Entity-level secrecy (issue #262) — see Quest.hidden. A hidden encounter is a
  // DM's prepared (not-yet-sprung) fight: its combatant roster (Ancient Red Dragon ×3)
  // and computed 5e difficulty stay DM-only, and the encounter is dropped WHOLESALE
  // from every non-DM read (list/get/difficulty) until the DM reveals it (hidden=false).
  hidden: z.boolean().default(false),
  endedAt: IsoDate.nullable().default(null),
  ...timestamps,
});
export type Encounter = z.infer<typeof Encounter>;
export const EncounterCreate = z.object({
  name: z.string().min(1).max(120),
  // Optional attachment links (issue #126) — where/why/when this encounter belongs.
  locationId: Id.nullable().optional(),
  questId: Id.nullable().optional(),
  sessionId: Id.nullable().optional(),
  // Entity-level secrecy (issue #262) — start an encounter hidden (DM prep). Default false.
  hidden: z.boolean().optional(),
});
// Edit an encounter's name, its location/quest/session links (issue #126), and/or its
// battle-map attachment (issue #39). Every field optional; `null` clears a link/map,
// omitting leaves it as-is. round/turn/status are driven by the lifecycle endpoints.
export const EncounterUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  locationId: Id.nullable().optional(),
  questId: Id.nullable().optional(),
  sessionId: Id.nullable().optional(),
  mapAttachmentId: Id.nullable().optional(),
  // VTT grid config (issue #40, phase 2) — dm only, enforced server-side. null clears a
  // field (gridSize: null turns the grid off); omitting leaves it unchanged.
  gridSize: z.number().min(1).max(100).nullable().optional(),
  gridScale: z.number().positive().nullable().optional(),
  gridUnit: z.string().max(12).nullable().optional(),
  gridSnap: z.boolean().optional(),
  // Grid geometry (issue #238) — dm only. 'square' | 'hex'.
  gridType: GridType.optional(),
  // Fog of war (issue #40, phase 3) — dm only. Replace the whole fog state (enable/disable +
  // revealed rectangles); null clears it. The dedicated reveal_map_region MCP tool appends
  // a single rectangle for an AI DM without round-tripping the full mask.
  fog: FogState.nullable().optional(),
  // Shared AoE templates (issue #238) — dm only. Replace the whole template list (empty clears).
  aoe: z.array(AoeTemplate).max(50).optional(),
  // Entity-level secrecy (issue #262) — dm only. true hides the encounter (roster + difficulty)
  // from non-DM reads; the DM "reveals" it by patching hidden back to false.
  hidden: z.boolean().optional(),
});

// ---------- procedural battle-map generation (issue #306) ----------

/**
 * First-party procedural battle-map generator (issue #306). Because there is no
 * bundle-able, license-clean open battle-map dataset (#303), Campfire generates its
 * OWN maps server-side — deterministic (seeded), offline, no external calls — and saves
 * the result as a normal attachment (kind='map') that flows through the existing VTT
 * grid/fog (#40) and handout-visibility (#97/#259) machinery.
 *
 * `kind` selects the generator:
 *  - 'dungeon'    — classic room-and-corridor dungeon (v1 primary).
 *  - 'cave'       — organic cellular-automata cavern.
 *  - 'wilderness' — open ground scattered with terrain blobs (light).
 * ('building' is deferred to a later phase — see the issue.)
 */
export const MapKind = z.enum(['dungeon', 'cave', 'wilderness']);
export type MapKind = z.infer<typeof MapKind>;

/** Overall map footprint. Bounded cell dimensions (guardrail against huge blobs). */
export const MapSize = z.enum(['small', 'medium', 'large']);
export type MapSize = z.infer<typeof MapSize>;

/** Palette theme for the rendered SVG. Purely cosmetic; does not change layout. */
export const MapTheme = z.enum(['stone', 'cavern', 'forest', 'crypt']);
export type MapTheme = z.infer<typeof MapTheme>;

/**
 * Parameters for a generate-map request. All optional except that the generator
 * defaults kind='dungeon', size='medium'. `seed` makes generation reproducible — the
 * same seed + params always yields byte-identical output; omit it and the server picks a
 * random seed and returns it so the DM can reproduce the map. `complexity` (0..1) scales
 * room count / carve density. `gridScale`/`gridUnit` describe one cell's real-world size
 * (default 5 ft) for the VTT ruler; the percent-of-width `gridSize` is DERIVED from the
 * generated cell dimensions so the overlay lines up exactly.
 */
export const GenerateMapParams = z.object({
  kind: MapKind.default('dungeon'),
  size: MapSize.default('medium'),
  complexity: z.number().min(0).max(1).optional(),
  seed: z.string().min(1).max(64).optional(),
  theme: MapTheme.optional(),
  gridScale: z.number().positive().max(1000).optional(),
  gridUnit: z.string().min(1).max(12).optional(),
});
export type GenerateMapParams = z.infer<typeof GenerateMapParams>;

/** The grid geometry a generated map hands back, ready to set on the encounter. */
export const MapGridConfig = z.object({
  gridSize: z.number().min(1).max(100), // one cell's edge as a percent of map width
  gridScale: z.number().positive(), // real-world size of one cell
  gridUnit: z.string().max(12),
  gridType: GridType,
});
export type MapGridConfig = z.infer<typeof MapGridConfig>;

/** Result of a generate-map call: the created attachment id + reproducibility info. */
export const GeneratedMapResult = z.object({
  attachmentId: Id,
  seed: z.string(),
  kind: MapKind,
  widthCells: z.number().int().positive(),
  heightCells: z.number().int().positive(),
  roomCount: z.number().int().nonnegative(),
  gridConfig: MapGridConfig,
});
export type GeneratedMapResult = z.infer<typeof GeneratedMapResult>;

// ---------- open map SOURCES (issue #303) ----------
// Complements the first-party procedural generator (#306) with EXTERNAL, license-clean
// ways for a DM to get a map. The hard reality (#303): there is no bulk dataset of open
// battle maps to bundle — nearly every 'free' map pack is CC-BY-NC-ND (no commercial use,
// no modification, no redistribution), so Campfire can't legally re-serve them. What IS
// clean and surfaced here:
//   - map *generators* the DM runs themselves and imports the output of (Watabou, donjon),
//   - the first-party #306 procedural generator, and
//   - the One Page Dungeon Contest entries (CC-BY-SA 3.0), importable WITH attribution.
// This is a curated catalog only — nothing here is bundled/re-served; external generators
// are linked, and CC-BY-SA content is imported by the DM via the attributed-import path
// (which stamps the attribution required by the licence, mirroring the per-source
// attribution the rules importer records, #143).
export const MapSourceKind = z.enum([
  'generator-builtin', // the first-party procedural generator (#306) — no external site
  'generator-external', // a third-party generator the DM runs client-side, then imports
  'importable-collection', // an open-licensed collection the DM imports individual maps from
]);
export type MapSourceKind = z.infer<typeof MapSourceKind>;

/**
 * One curated entry in the "get a map" affordance (issue #303). Purely informational —
 * the server never fetches these on the DM's behalf (Watabou/donjon maps are generated
 * client-side, and CC-BY-SA collections are downloaded by the DM), so there is no bundling
 * and no NC/ND content can leak in. `attributionRequired` maps and `licence`/`licenseUrl`
 * spell out exactly what the DM must preserve when importing, keeping the flow license-clean.
 */
export const MapSource = z.object({
  id: z.string().min(1).max(60), // stable slug, e.g. 'watabou-one-page-dungeon'
  name: z.string().min(1).max(120),
  kind: MapSourceKind,
  description: z.string().max(400),
  /** Where the DM goes to generate/download a map. Omitted for the built-in generator. */
  url: z.string().max(500).optional(),
  /** Human-readable licence label, e.g. 'CC-BY-SA 3.0', 'CC0', 'free for commercial use'. */
  license: z.string().min(1).max(120),
  licenseUrl: z.string().max(500).optional(),
  /** True when the licence obliges the DM to credit the author on import (CC-BY / CC-BY-SA). */
  attributionRequired: z.boolean(),
  /** What this source is best for — 'town', 'dungeon', 'wilderness', 'battle map', etc. */
  goodFor: z.array(z.string().max(40)).max(12),
  /** True when Campfire has a first-party import path for this source (One Page Dungeon). */
  importable: z.boolean(),
});
export type MapSource = z.infer<typeof MapSource>;

/**
 * Attribution the DM supplies when importing an open-licensed external map (issue #303) —
 * e.g. a One Page Dungeon Contest entry (CC-BY-SA 3.0). The licence string is validated
 * server-side against `isOpenLicense` (the same gate that rejects NC/ND rule packs, #19)
 * so a proprietary/NC map can never be imported through this path. The attribution is
 * stamped onto the stored map (its filename) so the credit travels with the artifact.
 */
export const ImportMapAttribution = z.object({
  title: z.string().min(1).max(160), // the map/entry title, e.g. 'The Sunken Abbey'
  author: z.string().min(1).max(160), // who to credit
  license: z.string().min(1).max(120).default('CC-BY-SA 3.0'),
  sourceUrl: z.string().max(500).optional(), // link back to the entry (CC-BY-SA attribution)
  sourceId: z.string().max(60).optional(), // the MapSource.id this came from, when known
});
export type ImportMapAttribution = z.infer<typeof ImportMapAttribution>;

// Encounter difficulty schemas + 5e math live in ./encounter-difficulty (issues #58 + #429).

// ---------- encounter generator (issue #304) ----------
// First-party, offline & deterministic encounter builder. There is no open dataset of
// prebuilt encounters to import, but Campfire already ships the two ingredients — a
// monster compendium (rule_entries) and the 5e difficulty-band math (#58) — so we assemble
// a themed monster group from installed rule packs to hit a target difficulty band for the
// party. Generation is a read-only *suggestion* (no persistence); committing goes through
// the normal encounter-create write path, so write-mode (#158)/proposals (#124) and
// secrecy (#262) all still apply.

/**
 * The requested "shape" of a generated group — a loose action-economy silhouette that
 * bounds the monster count: solo (1), pair (2), group (a small band, 3–6), horde (a
 * swarm, 7+). Omitting it lets the generator pick whatever count best fits the budget.
 */
export const EncounterShape = z.enum(['solo', 'pair', 'group', 'horde']);
export type EncounterShape = z.infer<typeof EncounterShape>;

/** Optional filters narrowing which compendium monsters the generator may pick from. */
export const EncounterGenerateFilters = z.object({
  // Creature type / tag substring match against the statblock's type (e.g. "undead",
  // "dragon", "fiend"). Case-insensitive.
  creatureType: z.string().min(1).max(60).optional(),
  // Environment/terrain substring match against the statblock's environments (e.g.
  // "forest", "underdark") when the source data carries them. Case-insensitive.
  environment: z.string().min(1).max(60).optional(),
  // Inclusive CR range. Fractional CRs allowed (0.25). A monster with an unparseable CR
  // is excluded whenever either bound is set.
  minCr: z.number().min(0).max(30).optional(),
  maxCr: z.number().min(0).max(30).optional(),
  // Restrict to a single installed rule pack by slug (list_rule_packs). Omitting spans
  // every installed pack.
  packSlug: z.string().min(1).max(160).optional(),
});
export type EncounterGenerateFilters = z.infer<typeof EncounterGenerateFilters>;

/**
 * Request body for POST /campaigns/:id/encounters/generate (and the generate_encounter
 * MCP tool). `difficulty` is the TARGET band to hit. Party is auto-inferred from the
 * campaign's active PCs unless an explicit `party` (list of PC levels) is supplied.
 * `seed` makes the (otherwise seeded-random) selection reproducible.
 */
export const EncounterGenerate = z.object({
  difficulty: DifficultyBand, // target band (trivial → deadly)
  // Explicit party PC levels; when omitted the generator infers them from the campaign's
  // active characters (issue #115 lifecycle).
  party: z.array(z.number().int().min(1).max(20)).max(20).optional(),
  filters: EncounterGenerateFilters.optional(),
  // Upper bound on the number of monsters (before the shape's own bound). Defaults to 12.
  count: z.number().int().min(1).max(30).optional(),
  shape: EncounterShape.optional(),
  // Deterministic seed. Omit to have the server mint one (returned in the suggestion so
  // the same group can be reproduced or re-rolled with a new seed).
  seed: z.number().int().nonnegative().max(4294967295).optional(),
  // Commit-only fields — used solely when the REST endpoint is called with ?commit=true
  // (they run through the create write path). Ignored by the non-mutating generate.
  name: z.string().min(1).max(120).optional(),
  locationId: Id.nullable().optional(),
  questId: Id.nullable().optional(),
  // Created encounters default hidden (DM-only prep, #262). Pass false to create it visible.
  hidden: z.boolean().optional(),
});
export type EncounterGenerate = z.infer<typeof EncounterGenerate>;

/** One suggested monster line (a stack of `count` identical statblocks). */
export const EncounterSuggestionCombatant = z.object({
  ruleEntryId: Id, // compendium statblock id — feed straight to add_combatant
  name: z.string(),
  cr: z.number().nullable(), // numeric CR (null if the statblock's CR was unparseable)
  xp: z.number().int().nonnegative(), // per-monster XP (5e CR→XP table)
  hpMax: z.number().int().nullable(), // resolved max HP, when the statblock carries it
  count: z.number().int().min(1), // how many of this monster to add
});
export type EncounterSuggestionCombatant = z.infer<typeof EncounterSuggestionCombatant>;

/**
 * Read-only result of a generation: the selected monster lines, the computed 5e
 * difficulty (reusing the #58 math), the adjusted total XP, and the seed that produced
 * it. Nothing is persisted — the caller commits via create_encounter + add_combatant.
 */
export const EncounterSuggestion = z.object({
  combatants: z.array(EncounterSuggestionCombatant),
  targetBand: DifficultyBand, // what was asked for
  difficulty: EncounterDifficulty, // what was produced (band may differ if unachievable)
  totalXp: z.number().int().nonnegative(), // adjusted monster XP (post number-multiplier)
  shape: EncounterShape, // the resolved shape of the produced group
  seed: z.number().int().nonnegative(), // reproduce with this seed; re-roll with a new one
  // True when the produced band matches the target; false when the compendium couldn't
  // field a group in the requested band (a best-effort closest group is still returned).
  matchedBand: z.boolean(),
});
export type EncounterSuggestion = z.infer<typeof EncounterSuggestion>;

// 'npc' combatants are DM-controlled like monsters (exact HP redacted for non-DM
// viewers, no death saves) but carry an `npcId` link to the campaign NPC for
// identity, and may optionally borrow a compendium statblock via `ruleEntryId`.
export const CombatantKind = z.enum(['character', 'monster', 'npc']);
export type CombatantKind = z.infer<typeof CombatantKind>;

/**
 * Coarse HP status band shown to non-DM viewers in place of a monster's exact HP
 * (issue #43). `down` = 0 HP; `critical` <= 25%; `bloodied` <= 50%; `healthy`
 * above. Null for combatants whose exact HP is visible (characters, or any
 * combatant when the DM is viewing).
 */
export const HpBand = z.enum(['healthy', 'bloodied', 'critical', 'down']);
export type HpBand = z.infer<typeof HpBand>;

// DeathState is declared near the top of the file (ahead of Character) so the
// persistent Character echo can reference it; see its full docblock there.

export const Combatant = z.object({
  id: Id,
  encounterId: Id,
  kind: CombatantKind,
  characterId: Id.nullable().default(null),
  // Set for kind==='npc': the campaign NPC this combatant represents (identity/icon;
  // its NPC page + dmSecret stay DM-gated as usual). Null for characters/monsters.
  npcId: Id.nullable().default(null),
  name: z.string().min(1).max(120),
  initiative: z.number().int().nullable().default(null),
  initMod: z.number().int().default(0),
  // Nullable so a monster's exact HP can be redacted to `null` for non-DM viewers
  // (issue #43); `hpBand` then carries the coarse status instead.
  hpCurrent: z.number().int().nullable().default(10),
  hpMax: z.number().int().min(1).nullable().default(10),
  // Temporary HP (issue #57): a separate pool that absorbs damage BEFORE hpCurrent,
  // does not stack (taking the higher of the two), and is not bounded by hpMax.
  // Nullable so it's redacted alongside exact HP for non-DM monster viewers (#43).
  hpTemp: z.number().int().min(0).nullable().default(0),
  hpBand: HpBand.nullable().default(null),
  // Death-save subsystem (issue #57). successes/failures are 0–3; `deathState`
  // is the derived lifecycle band (see DeathState). Monsters keep these at
  // none/0/0 — they simply go "down" at 0 HP.
  deathState: DeathState.default('none'),
  deathSaveSuccesses: z.number().int().min(0).max(3).default(0),
  deathSaveFailures: z.number().int().min(0).max(3).default(0),
  conditions: z.array(z.string().max(40)).default([]),
  ruleEntryId: Id.nullable().default(null),
  sortOrder: z.number().int().default(0),
  // Battle-map token position (issue #39): 0–100 percent overlay on the encounter's
  // map image, mirroring location.mapX/mapY. null = not yet placed on the map.
  tokenX: z.number().nullable().default(null),
  tokenY: z.number().nullable().default(null),
  // Token footprint size category (issue #40, phase 2) — scales the rendered token on the
  // battle map (tiny→gargantuan). Defaults to 'medium' (a 1×1 cell). No effect on combat math.
  tokenSize: TokenSize.default('medium'),
  // Ephemeral fog redaction flag (issue #418): when fog withholds tokenX/tokenY for a
  // non-DM viewer, this is true so the client can distinguish "placed but outside the
  // revealed area" from a truly unplaced token — without leaking coordinates. Always
  // false for DMs and for tokens whose position is visible (or truly null in storage).
  tokenHiddenByFog: z.boolean().default(false),
});
export type Combatant = z.infer<typeof Combatant>;

export const CombatantCreate = z.object({
  kind: CombatantKind,
  name: z.string().min(1).max(120).optional(), // required unless resolvable from ruleEntryId
  characterId: Id.optional(), // link a late-joining party member
  npcId: Id.optional(), // link a campaign NPC as an 'npc' combatant (identity/icon)
  ruleEntryId: Id.optional(),
  hpMax: z.number().int().min(1).optional(),
  initMod: z.number().int().optional(),
  // Add N identical combatants in one call (issue #114). When >1 the names are
  // auto-suffixed "Goblin 1".."Goblin N" so duplicate monsters are distinguishable.
  // Ignored (single add, no suffix) for character/characterId adds — a PC is unique.
  count: z.number().int().min(1).max(50).optional(),
});
export const CombatantUpdate = z.object({
  hpDelta: z.number().int().optional(),
  hpSet: z.number().int().nonnegative().optional(),
  // Temp HP absolute set (issue #57). 0 clears it.
  hpTemp: z.number().int().min(0).optional(),
  // Issue #620: explicit attacker attribution for damage/heal/death log events. When
  // set to a combatant id, the combat-log entry records that combatant as the actor
  // ("Ember hit Goblin 3 for 8"). Omit it and the server falls back to the current-turn
  // combatant when one is set and distinct from the target. Pass `null` to opt out of
  // attribution entirely (no current-turn fallback) — useful when a caller wants the
  // legacy target-only phrasing. Ignored for non-HP / non-death patches. The id must
  // reference a combatant in the same encounter (validated server-side); an unknown id
  // is ignored rather than 400ing so a stale client (e.g. one that removed the
  // attacker) can still apply damage without a second round-trip.
  actorId: Id.nullable().optional(),
  // Death-save counters, absolute set 0–3 (issue #57). Reaching 3 failures -> dead;
  // 3 successes -> stable. Cleared automatically when the combatant is healed above 0.
  deathSaveSuccesses: z.number().int().min(0).max(3).optional(),
  deathSaveFailures: z.number().int().min(0).max(3).optional(),
  // A death-save d20 roll result (issue #619). Mutually exclusive in spirit with the
  // manual counter sets above: instead of a DM clicking pips, a rolled death save drives
  // the outcome per the 5e crit/fumble rules — nat 1 = two failures, nat 20 = revive at
  // 1 HP (clears the dying slate), 10–19 = one success, 2–9 = one failure. The server's
  // 5e HP engine (applyCombatantHp) applies the roll to the combatant's death-save state.
  deathSaveRoll: z.number().int().min(1).max(20).optional(),
  addConditions: z.array(z.string().max(40)).optional(),
  removeConditions: z.array(z.string().max(40)).optional(),
  // Nullable so a mistaken value can be cleared back to the unrolled state (issue
  // #715): `initiative: null` writes NULL onto the row (distinguished from omitting
  // the field, which leaves it unchanged). DM only, enforced server-side. A cleared
  // combatant sinks to the bottom of the running order (see sortCombatants).
  initiative: z.number().int().nullable().optional(),
  // Combatant identity edits (issue #114) — dm only, enforced server-side. Let a DM
  // rename a duplicate ("Goblin" -> "Goblin (archer)") or fix a mistyped hpMax/initMod
  // at add-time without a delete + re-add.
  name: z.string().min(1).max(120).optional(),
  hpMax: z.number().int().min(1).optional(),
  initMod: z.number().int().optional(),
  // Battle-map token position (issue #39), 0–100 percent overlay. The DM may move any
  // token; a player may move only their own character's. Values are clamped to 0–100
  // server-side (mirrors the campaign map's location-pin drag). A place/move normally
  // sends both, but each axis is applied independently — omitting one leaves it as-is.
  // Nullable so an explicit `null` clears the position and returns the token to the
  // "Unplaced" tray without deleting the combatant (issue #271).
  tokenX: z.number().nullable().optional(),
  tokenY: z.number().nullable().optional(),
  // Token footprint size category (issue #40) — dm only, enforced server-side (an
  // identity-like attribute, alongside name/hpMax/initMod above).
  tokenSize: TokenSize.optional(),
});

/**
 * Combat HP slice compared against the character sheet on reopen/re-end (issue #466).
 * When the sheet advanced after /end, the DM must choose a resync direction before
 * reopening — never silently overwrite intervening healing/rest.
 */
export const HpSyncSlice = z.object({
  hpCurrent: z.number().int(),
  hpTemp: z.number().int().min(0),
  deathState: DeathState,
  deathSaveSuccesses: z.number().int().min(0).max(3),
  deathSaveFailures: z.number().int().min(0).max(3),
});
export type HpSyncSlice = z.infer<typeof HpSyncSlice>;

export const HpSyncConflict = z.object({
  combatantId: Id,
  characterId: Id,
  name: z.string(),
  combatant: HpSyncSlice,
  sheet: HpSyncSlice.extend({ updatedAt: IsoDate }),
});
export type HpSyncConflict = z.infer<typeof HpSyncConflict>;

export const HpResyncDirection = z.enum(['keep_combatant', 'pull_sheet']);
export type HpResyncDirection = z.infer<typeof HpResyncDirection>;

/** Body for POST /encounters/:id/reopen — required when hpSyncConflicts is non-empty. */
export const EncounterReopen = z.object({
  hpResync: z
    .array(
      z.object({
        combatantId: Id,
        direction: HpResyncDirection,
      }),
    )
    .optional(),
});
export type EncounterReopen = z.infer<typeof EncounterReopen>;

export const EncounterWithCombatants = Encounter.extend({
  combatants: z.array(Combatant),
  /** Present for DM reads of an ended encounter when sheet HP diverged from the snapshot (#466). */
  hpSyncConflicts: z.array(HpSyncConflict).optional(),
});
export type EncounterWithCombatants = z.infer<typeof EncounterWithCombatants>;

// roll-initiative response (issue #702). The encounter (with combatants) is returned as
// before, plus a `rolledCount` of how many combatants had their initiative filled this
// call. A fully-rolled roster is a no-op: rolledCount=0, no audit entry, no SSE broadcast.
export const EncounterRollInitiativeResult = EncounterWithCombatants.extend({
  rolledCount: z.number().int().nonnegative(),
});
export type EncounterRollInitiativeResult = z.infer<typeof EncounterRollInitiativeResult>;

// ---------- persistent per-encounter combat log (issue #61) ----------
// The in-encounter dice/turn history used to be client-only React state, capped and
// lost on reload. `encounter_events` persists a per-encounter trail written by the
// encounters service on meaningful combat activity (HP damage/heal, condition
// add/remove, death, rolls, next-turn/round, notes, overrides, and corrections), so
// the DM can reconstruct "round 2: Ember Hound took 8 damage" for a recap and a
// refresh no longer wipes it.
export const EncounterEventType = z.enum(['damage', 'heal', 'condition', 'death', 'roll', 'turn', 'note', 'override', 'correction']);
export type EncounterEventType = z.infer<typeof EncounterEventType>;

export const EncounterEvent = z.object({
  id: Id,
  encounterId: Id,
  // The encounter round the event happened in (0 while still preparing).
  round: z.number().int().nonnegative().default(0),
  type: EncounterEventType,
  // Free-text names, denormalized so the log renders without joining combatants
  // (which may since have been removed). `actor` is who acted (turn events, or a
  // heal source when known); `target` is who it happened to. Either may be null.
  // Issue #869: for non-DMs these are projected from current hidden-NPC visibility
  // (names appear after reveal); prefer `actorId`/`targetId` for stable identity.
  actor: z.string().max(200).nullable().default(null),
  target: z.string().max(200).nullable().default(null),
  // Stable combatant ids for role-aware projection (issue #869). Nullable when the
  // event has no actor/target, or for rows written before the columns existed.
  // Survives rename; listing re-derives display names from current combatant/NPC
  // secrecy so a later reveal unmasks historical log lines.
  actorId: Id.nullable().default(null),
  targetId: Id.nullable().default(null),
  // Human phrasing of the event. Must stay free of exact monster HP totals (issue
  // #43) AND of combatant names that could bypass actor/target redaction (issue
  // #869) — store deltas/outcomes only ("took 8 damage", "Combat started"); the
  // UI composes names from actor/target.
  detail: z.string().max(500).default(''),
  createdAt: IsoDate,
});
export type EncounterEvent = z.infer<typeof EncounterEvent>;

// ---------- inventory & loot (party treasury + per-character items) ----------
export const ItemOwnerType = z.enum(['party', 'character']);
export type ItemOwnerType = z.infer<typeof ItemOwnerType>;

export const InventoryItem = z.object({
  id: Id,
  campaignId: Id,
  ownerType: ItemOwnerType.default('party'),
  characterId: Id.nullable().default(null), // set iff ownerType='character'
  name: z.string().min(1).max(200),
  qty: z.number().int().min(0).default(1),
  notes: z.string().max(5_000).default(''),
  // Optional explicit game-icons.net slug (issue #307) overriding the type-derived
  // default icon. '' means "no override" — the UI falls back to a name/type
  // heuristic. Same bundled icon library as NPCs (#302); see apps/web/src/lib/icons.
  iconSlug: z.string().max(80).default(''),
  ...timestamps,
});
export type InventoryItem = z.infer<typeof InventoryItem>;
export const InventoryItemCreate = InventoryItem.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
// Issue #782: quantity writes are either an atomic relative `qtyDelta` (preferred for
// +/-; requires a per-action `idempotencyKey` so retries never double-apply) or an
// absolute `qty` reconciliation that MUST carry `expectedUpdatedAt` (CAS) so a stale
// form cannot clobber a concurrent increment. Other item fields (name/notes/icon/
// owner move) stay on the same PATCH. Server enforces the qty/qtyDelta exclusivity
// and the CAS / idempotency requirements — kept as optional fields here so MCP
// `InventoryItemUpdate.shape` still spreads cleanly.
export const InventoryItemUpdate = InventoryItemCreate.partial().extend({
  qtyDelta: z.number().int().optional(),
  expectedUpdatedAt: IsoDate.optional(),
  // Client-generated per-action key (UUID). Required with qtyDelta; optional on an
  // absolute qty set so a lost-response retry can replay the committed item.
  idempotencyKey: z.string().min(1).max(128).optional(),
});

// Party treasury — one row of coin totals per campaign (cp/sp/ep/gp/pp).
const Coin = z.number().int().nonnegative();
export const Treasury = z.object({
  campaignId: Id,
  cp: Coin.default(0),
  sp: Coin.default(0),
  ep: Coin.default(0),
  gp: Coin.default(0),
  pp: Coin.default(0),
  updatedAt: IsoDate,
});
export type Treasury = z.infer<typeof Treasury>;
// Union like HpPatch: { delta } (relative, may be negative but result must stay >= 0)
// or { set } (absolute). Omitted denominations are left untouched.
//
// Issue #582: the `set` path is a full reconciliation, so it carries an optional
// `expectedUpdatedAt` compare-and-swap token. The server returns 409 when the token
// doesn't match the row's current updatedAt (someone else wrote in between), attaching
// the fresh server values so the client can merge. The `delta` path never needs CAS —
// two players spending different coins compose atomically and never conflict, and even
// spending the SAME coin just composes (a spend that would go negative still 400s), so
// deltas are the preferred write shape for add/spend flows.
export const TreasuryPatch = z.union([
  z.object({
    delta: z.object({
      cp: z.number().int().optional(),
      sp: z.number().int().optional(),
      ep: z.number().int().optional(),
      gp: z.number().int().optional(),
      pp: z.number().int().optional(),
    }),
  }),
  z.object({
    set: z.object({ cp: Coin.optional(), sp: Coin.optional(), ep: Coin.optional(), gp: Coin.optional(), pp: Coin.optional() }),
    expectedUpdatedAt: IsoDate.optional(),
  }),
]);
export type TreasuryPatch = z.infer<typeof TreasuryPatch>;

// ---------- dice rolling ----------
// Safe, restricted dice expression. A SUM of terms joined by + / -, where each term is
// either a die (NdM, optionally with a keep/drop clause khN/klN/dhN/dlN — advantage,
// disadvantage, stat-gen) or a bare integer modifier K. Keep/drop lets a single die term
// express D&D-style advantage/disadvantage and stat-gen: "2d20kh1" (advantage),
// "2d20kl1" (disadvantage), "4d6kh3" / "4d6dl1" (drop-lowest stat roll). A leading sign
// is allowed ("-1d4", "+5"). Examples: "1d20+3", "2d6-1", "d20", "4d6dl1+2",
// "1d20+1d4+3", "2d6-1d4-2". The regex only fixes SHAPE — count/sides/modifier bounds
// are enforced in apps/server/src/common/dice.ts (parseCompoundDiceExpr), so a shape
// match is never sufficient on its own.
//
// Unicode digit normalization (issue #633): the wire contract is INTENTIONALLY
// ASCII-only — this regex matches ASCII `0-9` and the server's parser reads ASCII
// digits. Non-ASCII decimal digits (Arabic-Indic ٠-٩, Extended Arabic-Indic ۰-۹,
// Devanagari ०-९) typed or pasted by international rollers are normalized to ASCII at
// the INPUT boundary, in apps/web/src/lib/i18nNumbers.ts (canonicalizeDiceExpr), before
// the expression is sent here. So an Arabic user typing `٢d٢٠+٣` is canonicalized to
// `2d20+3` on the client and validates cleanly. Keeping the regex ASCII means the
// stored/persisted form is always canonical, while the input surface is permissive of
// the scripts a multilingual table types. The web client calls canonicalizeDiceExpr in
// SharedDiceLog.submitExpr; any future client that posts raw dice expressions MUST do
// the same normalization before relying on this pattern.
export const DiceExprPattern =
  /^\s*(?:(?:\d{1,2})?d\d{1,3}(?:\s*(?:kh|kl|dh|dl)\s*\d{1,2})?|[+-]\s*(?:(?:\d{1,2})?d\d{1,3}(?:\s*(?:kh|kl|dh|dl)\s*\d{1,2})?|\d{1,3}))(?:\s*[+-]\s*(?:(?:\d{1,2})?d\d{1,3}(?:\s*(?:kh|kl|dh|dl)\s*\d{1,2})?|\d{1,3}))*\s*$/i;
export const RollRequest = z.object({
  expr: z.string().min(1).max(40).regex(DiceExprPattern, 'expected a sum of die terms (NdM) and modifiers, e.g. "1d20+3", "2d20kh1", or "1d20+1d4+3"'),
  // Optional check context (issue #130): a human label ("DEX save") and a difficulty
  // class. When dc is present the server computes success (total >= dc) into the result.
  label: z.string().max(120).optional(),
  dc: z.number().int().min(1).max(99).optional(),
});
export type RollRequest = z.infer<typeof RollRequest>;
// Per-term breakdown entry for a compound dice expression (issue #536). Named so the
// roller, the persistence layer, and the web UI all share one shape. A die term carries
// its rolls + the kept subset; a modifier term carries only its signed value.
export const RollResultTerm = z.object({
  // The original term text, e.g. "1d20", "1d4", "+3", "-2".
  term: z.string(),
  // Net contribution of this term to the total. For a die term, the sum of the KEPT dice;
  // for a modifier, the signed value itself.
  value: z.number().int(),
  // Die terms only: every die rolled for this term, in roll order. Absent for a bare
  // modifier term.
  rolls: z.array(z.number().int()).optional(),
  // Die terms only: the subset of this term's `rolls` that counted (present when a
  // keep/drop clause applied to THIS term). Absent otherwise.
  kept: z.array(z.number().int()).optional(),
});
export type RollResultTerm = z.infer<typeof RollResultTerm>;
export const RollResult = z.object({
  expr: z.string(),
  rolls: z.array(z.number().int()), // every die rolled, in roll order — attestable
  // The subset of `rolls` that counted toward the total, present ONLY when a keep/drop
  // clause applied (e.g. advantage keeps 1 of 2 d20s). Absent == all dice counted.
  kept: z.array(z.number().int()).optional(),
  total: z.number().int(),
  // Per-term breakdown for display (issue #536): present ONLY for a compound expression
  // (more than one term) — each entry describes one evaluated term, so the UI can render
  // "1d20: 14, 1d4: 2, +3 = 19". Absent for a single-term roll (backward compat).
  terms: z.array(RollResultTerm).optional(),
  // Echoed check context (issue #130). success is server-computed (total >= dc).
  label: z.string().max(120).optional(),
  dc: z.number().int().optional(),
  success: z.boolean().optional(),
});
export type RollResult = z.infer<typeof RollResult>;

// ---------- real-time campaign events (SSE) ----------
// Thin invalidation signals pushed over GET /campaigns/:id/events — they carry ids, not
// entity payloads, so clients refetch through the normal (permission-checked) REST reads.
//
// A discriminated union on `type`: encounter.* signals are id-only change notifications;
// `membership.revoked` (issue #527) carries the affected user instead — the SSE controller
// uses it to tear down that user's open stream the instant they are removed (previously the
// requireMember check ran once at open, so a kicked member kept receiving ticks until they
// themselves disconnected). It is still thin (no entity payload): the only consumer is the
// subscriber whose own stream it ends, and a reconnecting client re-hits requireMember and
// gets a 403. `memberId` is the campaign_members row id (included so a future UI can surface
// "you were removed" rather than just dropping the tab — but it carries no secret fields).
export const CampaignEventType = z.enum([
  'encounter.updated',
  'encounter.deleted',
  'encounter.ping',
  'schedule.updated',
  'membership.revoked',
  // Issue #437: a member's role changed (promote/demote). Thin invalidation so the
  // affected client's open UI can refetch /me and drop or reveal role-gated chrome
  // without a full reload. Forwarded on the data path (unlike membership.revoked).
  'membership.updated',
  'treasury.updated',
  // Issue #421: character sheet / member-resource writes (stats, actions, slots, …).
  'character.updated',
]);
export type CampaignEventType = z.infer<typeof CampaignEventType>;
export const CampaignEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('encounter.updated'),
    campaignId: Id,
    encounterId: Id,
    at: IsoDate,
  }),
  z.object({
    type: z.literal('encounter.deleted'),
    campaignId: Id,
    encounterId: Id,
    at: IsoDate,
  }),
  z.object({
    // Present only on 'encounter.ping' (issue #238): the transient battle-map ping's location and
    // optional colour/label. Unlike the id-only updated/deleted signals this carries a small,
    // non-secret payload (a click coordinate the sender chose), so there is nothing to leak.
    type: z.literal('encounter.ping'),
    campaignId: Id,
    encounterId: Id,
    ping: MapPing,
    at: IsoDate,
  }),
  z.object({
    // Issue #790: a scheduled session was created, edited, cancelled, or received
    // an RSVP. This remains an id-only invalidation signal: clients refetch the
    // permission-checked campaign projection so a reschedule replaces every detail
    // together and a cancellation clears the card instead of merging stale fields.
    type: z.literal('schedule.updated'),
    campaignId: Id,
    scheduleId: Id,
    at: IsoDate,
  }),
  z.object({
    // Issue #527: a member was removed (or self-left) from the campaign. The affected
    // user's open SSE stream completes on receipt; other members' streams ignore it (they
    // are not the revokee). `userId` is String(users.id) — the same identity space as
    // RequestUser.id / campaignMembers.userId (String form), so the controller can match it
    // against the subscriber's own id without a second lookup.
    type: z.literal('membership.revoked'),
    campaignId: Id,
    userId: z.string().max(120),
    memberId: Id,
    at: IsoDate,
  }),
  z.object({
    // Issue #437: a member's campaign role changed. `role` is the NEW effective role so
    // the affected client can refresh /me (and other tabs via BroadcastChannel) and
    // immediately show or hide DM chrome without waiting for a reload. `userId` matches
    // RequestUser.id / String(campaignMembers.userId).
    type: z.literal('membership.updated'),
    campaignId: Id,
    userId: z.string().max(120),
    memberId: Id,
    role: Role,
    at: IsoDate,
  }),
  z.object({
    // Issue #582: the party treasury changed. A thin invalidation signal like the
    // encounter.* ticks: no coin payload (permission-checked REST read is authoritative),
    // so an open editor that snapshotted stale balances can mark itself stale and refetch
    // instead of silently overwriting another player's concurrent spend on save. `userId`
    // is String(users.id) of the actor (same identity space as RequestUser.id) so the
    // editor can show "changed by <player>" without a second lookup — and so the editor's
    // OWN write doesn't re-mark itself stale when it round-trips through the SSE stream
    // (the client compares userId against the local session and ignores its own echo).
    type: z.literal('treasury.updated'),
    campaignId: Id,
    userId: z.string().max(120),
    at: IsoDate,
  }),
  z.object({
    // Issue #421: a character sheet (or member-linked resource on that sheet) changed.
    // Thin invalidation only — no stats/actions payload — so run-session inline cards
    // refetch the permission-checked character list without requiring an encounterId
    // (the old SSE filter dropped these as non-encounter frames). `userId` is the actor
    // (String(users.id)); `characterId` identifies which sheet went stale.
    type: z.literal('character.updated'),
    campaignId: Id,
    characterId: Id,
    userId: z.string().max(120),
    at: IsoDate,
  }),
]);
export type CampaignEvent = z.infer<typeof CampaignEvent>;

/**
 * Distributive Omit over the CampaignEvent union so each variant keeps its own
 * discriminated shape. A plain `Omit<Union, K>` collapses to one object with a
 * widened `type`, which then rejects object-literal emit() calls whose `type` is
 * a subset of the literals (TS can't correlate a variable discriminant with which
 * extra fields are present, so it flags `encounterId`/`userId` as excess). Routing
 * the union through a generic conditional forces real distribution: each member
 * is omitted independently and the result is a union of single-variant shapes,
 * against which an object literal with a matching `type` discriminant assigns fine.
 * This is the input shape for CampaignEventsService.emit(): callers pass one
 * variant minus its server-assigned `at` timestamp.
 */
export type DistributiveOmit<T, K extends keyof any> = [T] extends [never] ? never : T extends unknown ? Omit<T, K> : never;
export type CampaignEventInput = DistributiveOmit<CampaignEvent, 'at'>;

// A persisted, campaign-shared dice roll (issue #35): RollResult plus authorship +
// timestamp. Rolls are stored server-side so every campaign member sees the same
// feed — POST /campaigns/:id/roll returns one of these, and GET /campaigns/:id/rolls
// lists the recent history (polled by the web today; the same payload is what an
// SSE stream would push later).
export const DiceRoll = RollResult.extend({
  id: Id,
  campaignId: Id,
  rollerUserId: z.string().max(200), // RequestUser.id — String(users.id) or 'dev:<name>' / 'token:<name>' actors
  rollerName: z.string().max(200).default(''),
  createdAt: IsoDate,
});
export type DiceRoll = z.infer<typeof DiceRoll>;

// ---------- audit ----------
// Type aliases for enum/value exports (TS declaration merging: value + type share the name)
export type DangerLevel = z.infer<typeof DangerLevel>;
export type CampaignCloneMode = z.infer<typeof CampaignCloneMode>;
export type QuestStatus = z.infer<typeof QuestStatus>;
export type CanonicalNpcDisposition = z.infer<typeof CanonicalNpcDisposition>;
export type LocationStatus = z.infer<typeof LocationStatus>;
export type NoteVisibility = z.infer<typeof NoteVisibility>;
export type NoteKind = z.infer<typeof NoteKind>;
export type EntityType = z.infer<typeof EntityType>;
export type TokenScope = z.infer<typeof TokenScope>;
export type ProposalAction = z.infer<typeof ProposalAction>;
export type ProposalStatus = z.infer<typeof ProposalStatus>;
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;
export type AttachmentKind = z.infer<typeof AttachmentKind>;

// The role attributed to an audit-log actor. The audit table's `actor_role`
// column is a free-form TEXT column (NOT a DB enum — see the server's
// db/schema.ts), so its value space is wider than the campaign `Role` enum.
//
// `dm`/`player`/`viewer` are the campaign-scoped roles (who did what *inside* a
// campaign — the actor's effective membership role at the time). `admin` is the
// server-scoped sentinel (issue #526): it marks an action taken by a server
// admin exercising server-wide power (user/rule-pack/ai-provider/settings
// writes), so an incident reviewer can distinguish a privileged operator action
// from an ordinary campaign-DM one. Server-scoped admin rows carry
// `campaignId: null`; a campaign-scoped row is never attributed `admin`
// (an admin who also happens to be a DM in a campaign is recorded by their
// campaign role there).
export const AuditActorRole = z.enum(['dm', 'player', 'viewer', 'admin']);
export type AuditActorRole = z.infer<typeof AuditActorRole>;

export const AuditEntry = z.object({
  id: Id,
  campaignId: Id.nullable(),
  actor: z.string().max(200), // user id or token name
  actorRole: AuditActorRole,
  action: z.string().max(80), // e.g. quest.update
  entityType: z.string().max(40).nullable(),
  entityId: Id.nullable(),
  detail: z.string().max(2000).default(''),
  createdAt: IsoDate,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ---------- admin observability (issue #22) ----------
// Server-wide operational snapshot for the admin console (GET /admin/metrics,
// @ServerRoles('admin')). Everything here is cheap to compute — COUNT(*) per
// table plus PRAGMA page_count/page_size for on-disk DB size — so the dashboard
// can be polled without straining the server. Nothing here is per-campaign or
// exposes story secrets: it's counts, sizes, uptime, and version only.

// COUNT(*) of each top-level entity. Kept as an explicit object (not a generic
// map) so the shape is typed end-to-end and the web dashboard can label each row.
export const AdminMetricsCounts = z.object({
  users: z.number().int().nonnegative(),
  campaigns: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  npcs: z.number().int().nonnegative(),
  locations: z.number().int().nonnegative(),
  quests: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  encounters: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
  apiTokens: z.number().int().nonnegative(),
  rulePacks: z.number().int().nonnegative(),
  ruleEntries: z.number().int().nonnegative(),
});
export type AdminMetricsCounts = z.infer<typeof AdminMetricsCounts>;

export const AdminMetricsDatabase = z.object({
  sizeBytes: z.number().int().nonnegative(), // page_count * page_size (on-disk file size)
  pageCount: z.number().int().nonnegative(),
  pageSize: z.number().int().nonnegative(),
});
export type AdminMetricsDatabase = z.infer<typeof AdminMetricsDatabase>;

export const AdminMetrics = z.object({
  version: z.string(), // server package.json version (same source as /healthz)
  /** Optional git SHA / build id when the image stamped one (issue #432). */
  commit: z.string().min(1).optional(),
  now: IsoDate, // server clock when this snapshot was taken
  startedAt: IsoDate, // process start (now - uptime)
  uptimeSeconds: z.number().nonnegative(),
  activeSessions: z.number().int().nonnegative(), // non-expired rows in user_sessions
  counts: AdminMetricsCounts,
  database: AdminMetricsDatabase,
  recentActivity: z.array(AuditEntry), // most-recent audit rows (read-only, newest first)
});
export type AdminMetrics = z.infer<typeof AdminMetrics>;

// ---------- storage management (issue #24) ----------
// Server-admin storage console: upload-size visibility, per-campaign quotas, and
// orphan cleanup. All surfaces are gated by @ServerRoles('admin'). Byte counts
// come from the attachments table (metadata) plus a walk of DATA_DIR/uploads.

// One campaign's slice of upload usage.
export const StorageCampaignUsage = z.object({
  campaignId: Id,
  name: z.string(),
  fileCount: z.number().int().nonnegative(), // committed attachment rows for this campaign
  reservedFileCount: z.number().int().nonnegative(), // in-flight quota reservations
  totalBytes: z.number().int().nonnegative(), // backward-compatible alias of committedBytes
  committedBytes: z.number().int().nonnegative(), // publicly readable attachment bytes
  reservedBytes: z.number().int().nonnegative(), // quota held by in-flight publications
  quotaBytes: z.number().int().nonnegative().nullable(), // per-campaign cap, or null for unlimited
  overQuota: z.boolean(), // committed + reserved > quotaBytes (always false when unlimited)
});
export type StorageCampaignUsage = z.infer<typeof StorageCampaignUsage>;

// Orphans: DB rows whose bytes are missing on disk, and on-disk files with no row.
export const StorageOrphans = z.object({
  rowsWithoutFile: z.number().int().nonnegative(), // attachment rows whose file is gone from disk
  filesWithoutRow: z.number().int().nonnegative(), // upload files (incl. thumbs) with no backing row
  orphanBytes: z.number().int().nonnegative(), // bytes occupied by files-without-row (reclaimable)
});
export type StorageOrphans = z.infer<typeof StorageOrphans>;

export const FsCleanupPendingItem = z.object({
  id: z.number().int().positive(),
  relPath: z.string(),
  scope: z.enum(['attachment', 'campaign_purge']),
  // `held` = reserved before metadata commit; drain must not erase until armed.
  status: z.enum(['held', 'pending', 'failed']),
  attempts: z.number().int().nonnegative(),
  lastError: z.string(),
  updatedAt: IsoDate,
});
export type FsCleanupPendingItem = z.infer<typeof FsCleanupPendingItem>;

export const FsCleanupSummary = z.object({
  pendingCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  /** Total rows in fs_deletion_queue (items may be truncated for the admin UI). */
  queueCount: z.number().int().nonnegative(),
  items: z.array(FsCleanupPendingItem),
});
export type FsCleanupSummary = z.infer<typeof FsCleanupSummary>;

/** Response when metadata is removed but filesystem erasure may still be in flight (issue #727). */
export const PermanentDeletionResult = z.object({
  filesPending: z.boolean(),
  pendingPaths: z.array(z.string()).optional(),
});
export type PermanentDeletionResult = z.infer<typeof PermanentDeletionResult>;

export const StorageStats = z.object({
  totalBytes: z.number().int().nonnegative(), // backward-compatible alias of committedBytes
  committedBytes: z.number().int().nonnegative(), // publicly readable bytes across all campaigns
  reservedBytes: z.number().int().nonnegative(), // quota held by in-flight publications
  fileCount: z.number().int().nonnegative(), // total committed attachment rows
  reservedFileCount: z.number().int().nonnegative(), // total reservation rows
  diskBytes: z.number().int().nonnegative(), // actual bytes on disk under uploads/ (originals + thumbs)
  campaigns: z.array(StorageCampaignUsage), // per-campaign breakdown, largest first
  orphans: StorageOrphans,
  fsCleanup: FsCleanupSummary,
});
export type StorageStats = z.infer<typeof StorageStats>;

// Set (or clear, with null) a campaign's upload quota.
export const StorageQuotaUpdate = z.object({
  quotaBytes: z.number().int().nonnegative().nullable(),
});
export type StorageQuotaUpdate = z.infer<typeof StorageQuotaUpdate>;

// Result of an orphan-cleanup run. With dryRun=true nothing is deleted and the
// *Deleted counts are 0 — only the found counts are populated, for a preview.
export const StorageCleanupResult = z.object({
  dryRun: z.boolean(),
  rowsWithoutFile: z.number().int().nonnegative(), // orphan rows found
  filesWithoutRow: z.number().int().nonnegative(), // orphan files found
  rowsDeleted: z.number().int().nonnegative(),
  filesDeleted: z.number().int().nonnegative(),
  bytesReclaimed: z.number().int().nonnegative(), // disk bytes freed by deleting orphan files
});
export type StorageCleanupResult = z.infer<typeof StorageCleanupResult>;

// ---------- campaign-wide search + @-mention cross-linking (issue #64) ----------
// The kinds of things a campaign-wide search can turn up. `campaign` from
// EntityType is deliberately excluded — a campaign never searches its own row,
// only the entities inside it — and `note` is added (notes are searchable but
// aren't a mention/link target).
export const SearchResultType = z.enum([
  'quest',
  'npc',
  'location',
  'character',
  'session',
  'encounter',
  'scheduled_session',
  'faction',
  'note',
  // Newer content types now indexed (issue #265): timeline events, inventory
  // items, threaded discussion comments, and DM-only story arcs/beats.
  'timeline',
  'item',
  'comment',
  'arc',
  'beat',
]);
export type SearchResultType = z.infer<typeof SearchResultType>;

// A single hit. The service ONLY ever builds these from role-filtered lists or
// bounded role-filtered search queries, so a hidden quest/npc/encounter,
// unexplored location, non-visible note, and every dmSecret are already stripped
// before a result object is constructed — hits never leak an entity the caller
// can't see. Encounter-linked labels are included only when that linked entity is
// visible to the caller; scheduled-session notes are party-visible by definition.
export const SearchResult = z.object({
  type: SearchResultType,
  id: Id,
  campaignId: Id,
  title: z.string().default(''), // display name/title (session -> title || "Session N")
  snippet: z.string().default(''), // short excerpt around the first match
  matchedField: z.string().default(''), // which field matched (name/title/body/recap/notes…)
  // For a note anchored to another entity — lets the UI deep-link to the anchor
  // rather than the (page-less) note itself. Null for the entity types themselves.
  entityType: EntityType.nullable().default(null),
  entityId: Id.nullable().default(null),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResponse = z.object({
  query: z.string(),
  results: z.array(SearchResult),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// @-mention cross-linking: the set of named entities a member may link to (and
// that the Markdown renderer may auto-link by name). Notes/inventory items/
// comments are excluded — a comment has no name to match, and notes/items are
// not narrative link targets. Timeline events and (DM-only) story arcs/beats are
// named narrative entities and ARE linkable (issue #265).
export const MentionTargetType = z.enum(['quest', 'npc', 'location', 'character', 'session', 'faction', 'timeline', 'arc', 'beat']);
export type MentionTargetType = z.infer<typeof MentionTargetType>;

export const MentionTarget = z.object({
  type: MentionTargetType,
  id: Id,
  name: z.string(), // quest/session title, or entity name — what to match & display
});
export type MentionTarget = z.infer<typeof MentionTarget>;

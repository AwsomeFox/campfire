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
export const CampaignCreate = Campaign.omit({ id: true, createdAt: true, updatedAt: true, sessionCount: true, storageQuotaBytes: true, deletedAt: true }).partial({ description: true, status: true, currentLocationId: true, dangerLevel: true, dmControlsProgression: true, ruleSystem: true, mapAttachmentId: true });
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
 * Conditions stay free-text on the wire (homebrew is allowed), but these are the
 * standard names surfaced as suggestions so the three surfaces speak the same
 * vocabulary instead of each hardcoding its own list.
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
/** Spend (+delta) or restore (-delta) slots at one level; `used` is clamped to [0, max]. Slot maxima are edited via PATCH `spellSlots`. */
export const SpellSlotPatch = z.object({
  level: z.number().int().min(1).max(9),
  delta: z.number().int(),
});
export const XpPatch = z.union([
  z.object({ delta: z.number().int() }),
  z.object({ set: z.number().int().nonnegative() }),
]);
/** DM party-wide XP award: amount to every character in the campaign, or just `characterIds`. */
export const XpAward = z.object({
  amount: z.number().int().min(1).max(1_000_000),
  characterIds: z.array(Id).min(1).optional(),
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
export const QuestStatus = z.enum(['available', 'active', 'completed', 'failed']);

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
export const FactionStanding = z.enum(['hostile', 'unfriendly', 'neutral', 'friendly', 'allied']);
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
// accumulated. characterName is denormalized for display.
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
  createdBy: z.string().max(200).default(''), // user id or token name, display/audit only
  tokenPrefix: z.string().max(16), // display only, e.g. cf_share_9f2a
  ...timestamps,
});
export type SessionShare = z.infer<typeof SessionShare>;
export const SessionShareCreated = z.object({ token: z.string(), share: SessionShare });
export type SessionShareCreated = z.infer<typeof SessionShareCreated>;

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
  durationMinutes: z.number().int().min(15).max(24 * 60).default(240), // drives DTEND in the ICS feed
  title: z.string().max(200).default(''),
  location: z.string().max(200).default(''), // "Sam's place", a VTT link…
  notes: z.string().max(5000).default(''),
  ...timestamps,
});
export type ScheduledSession = z.infer<typeof ScheduledSession>;
export const ScheduledSessionCreate = ScheduledSession.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ scheduledAt: true });
export const ScheduledSessionUpdate = ScheduledSessionCreate.partial();

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
export const RsvpSet = z.object({ status: RsvpStatus, note: z.string().max(500).optional() });
export type RsvpSet = z.infer<typeof RsvpSet>;

export const ScheduledSessionWithRsvps = ScheduledSession.extend({ rsvps: z.array(SessionRsvp) });
export type ScheduledSessionWithRsvps = z.infer<typeof ScheduledSessionWithRsvps>;

// Per-campaign ICS calendar feed. `token` is an unguessable capability secret
// (cf_ics_<48 hex>) baked into the feed URL; null = feed disabled. Any member
// may read it (the feed only exposes schedule data members already see);
// enable/rotate/disable is DM-only.
export const CalendarFeed = z.object({
  token: z.string().nullable(),
  url: z.string().nullable(), // relative feed path, e.g. /api/v1/calendar/<token>.ics
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

// ---------- entity revisions (issue #157) ----------
// A revision-history layer for the prose entities most at risk of a blind
// last-write-wins clobber (a co-DM polishing a recap while a connected AI saves its
// own edit). On every committed prose update the server snapshots the PRIOR content
// here; the history can then be listed and any prior snapshot RESTORED (re-applied as
// a new update, itself recorded). Covers the DM-authored world-building prose whose
// edit path is uniformly dm-gated — sessions (recap), quests/npcs/locations/factions
// (body) — AND notes (body), which #157 cited by line as the destroyed prose. Notes
// carry their own per-note visibility/author-only-edit model, so their revision reads
// are gated on the note's OWN visibility (not a blanket dm-gate) and restore is
// author-only — see RevisionsController — so history is never a redaction back-door.
export const RevisionEntityType = z.enum(['session', 'quest', 'npc', 'location', 'faction', 'note']);
export type RevisionEntityType = z.infer<typeof RevisionEntityType>;

export const EntityRevision = z.object({
  id: Id,
  campaignId: Id,
  entityType: RevisionEntityType,
  entityId: Id,
  // The snapshotted PRIOR prose, keyed by the entity's prose field ('recap' for a
  // session, 'body' for quest/npc/location/faction/note). A plain string map so the
  // shape is uniform across entity types and the web can render whichever key is present.
  snapshot: z.record(z.string(), z.string()).default({}),
  authorUserId: z.string().max(120).default(''),
  authorName: z.string().max(120).default(''),
  createdAt: IsoDate,
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
  body: z.string().min(1).max(20_000), // markdown
  inCharacter: z.boolean().default(false),
  ...timestamps,
});
export type Comment = z.infer<typeof Comment>;
export const CommentCreate = Comment.omit({
  id: true,
  campaignId: true,
  authorUserId: true,
  authorName: true,
  createdAt: true,
  updatedAt: true,
})
  .partial()
  .required({ entityType: true, entityId: true, body: true });
export const CommentUpdate = z.object({
  body: z.string().min(1).max(20_000).optional(),
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
// the DM approves/rejects it (proposal_resolved). Read via
// GET /notifications (own rows only); real-time push can layer on later — the
// store is plain rows, transport-agnostic.
export const NotificationType = z.enum([
  'recap_posted',
  'note_reply',
  'note_shared',
  'comment_reply',
  'added_to_campaign',
  'session_scheduled',
  'session_rsvp',
  'quest_updated',
  'proposal_submitted',
  'proposal_resolved',
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
  ...timestamps,
});
export type RuleEntry = z.infer<typeof RuleEntry>;

/**
 * Importer registry for the /rules/packs/install endpoint (issue #70). Was a bare
 * `z.literal('open5e')`, welding the install path to a single importer. Widened to a
 * small enum so a second importer can be added without rewriting the schema — 'open5e'
 * stays the built-in API importer, 'other' is a placeholder for a future/generic
 * importer. The existing Open5e path is unchanged: callers still pass `source: 'open5e'`.
 * (Generic JSON uploads take the separate RulePackUpload path, `source: 'upload'`.)
 */
export const RulePackInstallSource = z.enum(['open5e', 'other']);
export type RulePackInstallSource = z.infer<typeof RulePackInstallSource>;

export const RulePackInstall = z.object({
  source: RulePackInstallSource,
  url: z.string().max(500).optional(), // override API base, mainly for tests (fake server)
  sections: z.array(z.enum(['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats'])).optional(), // default: all
});
export type RulePackInstall = z.infer<typeof RulePackInstall>;

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
  specialAbilities: unknown;
  actions: unknown;
}

export interface RuleSystemAdapter {
  /** Stable family id for this adapter (not a pack slug), e.g. 'dnd5e'. */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** Ability-score → modifier (5e: floor((score - 10) / 2)). */
  abilityModifier(score: number): number;
  /** Die size for an initiative roll (5e: d20). Keeps the d20 assumption out of the generic roller. */
  readonly initiativeDie: number;
  /**
   * Derive a combatant's initiative modifier from an ability-score map (5e: the DEX
   * modifier). Accepts either canonical character stats (`{ DEX: 14 }`) or a raw monster
   * `abilityScores` object (`{ dexterity: 14 }`); returns 0 when the governing score is
   * absent or non-numeric.
   */
  initiativeModifier(abilities: Record<string, unknown> | null | undefined): number;
  /** The condition vocabulary offered in the combat UI (5e: the run-session chip list). */
  readonly conditions: readonly string[];
  /** Map a monster rule-entry's `dataJson` to canonical statblock fields (AC/HP/CR/abilities/…). */
  mapStatblock(data: Record<string, unknown>): MonsterStatblockData;
  /** Resolve a monster's numeric max HP from its `dataJson`, or null when unavailable. */
  monsterHitPoints(data: Record<string, unknown>): number | null;
}

/** Read the governing (DEX) score from either a canonical or raw ability map, if numeric. */
function dnd5eDexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  const raw = abilities.DEX ?? abilities.dexterity ?? abilities.dex;
  return typeof raw === 'number' ? raw : null;
}

/** Family id of the built-in D&D 5e adapter (the default). */
export const DND5E_ADAPTER_ID = 'dnd5e';

export const Dnd5eAdapter: RuleSystemAdapter = {
  id: DND5E_ADAPTER_ID,
  label: 'D&D 5e',
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  initiativeModifier(abilities: Record<string, unknown> | null | undefined): number {
    const dex = dnd5eDexScore(abilities);
    return dex === null ? 0 : this.abilityModifier(dex);
  },
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
      specialAbilities: d.specialAbilities ?? d.special_abilities,
      actions: d.actions,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const hp = d.hitPoints ?? d.hit_points ?? d.hp;
    return typeof hp === 'number' && hp > 0 ? Math.round(hp) : null;
  },
};

// Pathfinder 1e adapter (issue #296) lives in its own file (imports only *types* from here,
// so there is no runtime import cycle). Registered below and re-exported for consumers.
import { Pathfinder1eAdapter, PF1E_PACK_SLUG } from './pathfinder1e';
export * from './pathfinder1e';

/**
 * Registry of rule-system adapters, keyed by family id (which, for packs like PF1e, is also
 * the rule-pack slug so `ruleSystemAdapter(campaign.ruleSystem)` resolves directly). Adding a
 * system is one entry here plus its own adapter file — not a sweep across the combat code.
 */
const ADAPTERS: Record<string, RuleSystemAdapter> = {
  [DND5E_ADAPTER_ID]: Dnd5eAdapter,
  [PF1E_PACK_SLUG]: Pathfinder1eAdapter, // Pathfinder 1e (issue #296)
};

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

export const RulePackUploadEntry = z.object({
  slug: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
  type: RuleEntryType,
  summary: z.string().max(1000).optional(),
  body: z.string().max(50_000).optional(), // markdown
  dataJson: z.string().max(100_000).nullable().optional(), // raw structured fields, JSON-encoded
  license: z.string().max(120).optional(), // per-entry license; falls back to the pack license
  source: z.string().max(200).optional(), // per-entry source/document label; falls back to the pack name
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
  source: z.enum(['open5e', 'upload']),
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

export const RuleSearchQuery = z.object({
  q: z.string().max(200).default(''),
  type: RuleEntryType.optional(),
  pack: z.string().max(80).optional(), // pack slug
});

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
  downCount: z.number().int().nonnegative(), // combatants at 0 HP / down / dead
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
  nextSession: ScheduledSessionWithRsvps.nullable(), // the soonest not-yet-past game night (with RSVPs), or null
  openInboxCount: z.number().int().nonnegative(),
});
export type CampaignSummary = z.infer<typeof CampaignSummary>;

// ---------- auth, users, settings, membership ----------
export const ServerRole = z.enum(['admin', 'user']);
export type ServerRole = z.infer<typeof ServerRole>;

// Hex color, e.g. #9184d9. Shared by User.accentColor and PreferencesUpdate below.
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// UI text-size preference. 'default' follows the design's base scale; 'large'
// scales the whole UI up for readability. Shared by User.textSize and
// PreferencesUpdate below.
export const TextSize = z.enum(['default', 'large']);
export type TextSize = z.infer<typeof TextSize>;

export const User = z.object({
  id: Id,
  username: z.string().min(2).max(60).regex(/^[a-z0-9_.-]+$/i, 'letters, numbers, _ . - only'),
  displayName: z.string().max(120).default(''),
  serverRole: ServerRole.default('user'),
  disabled: z.boolean().default(false),
  // Personal accent color override (per-user UI theming). null = follow the server default (Nocturne blurple).
  accentColor: HexColor.nullable().default(null),
  // Personal text-size preference (per-user UI scaling).
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
  oidcEnabled: z.boolean(), // future
  version: z.string(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const ServerSettings = z.object({
  allowLocalLogin: z.boolean().default(true), // gate for non-admin local login
  allowSignup: z.boolean().default(false), // gate for self-service signup (POST /auth/signup) — off by default
  // Experimental server-side AI Dungeon Master (issue #28) — OFF by default. When
  // false, every AI-DM configure/turn path is 403-gated server-wide, so the feature
  // is inert until an admin opts the whole server in. See modules/ai-dm.
  experimentalAiDm: z.boolean().default(false),
});
export type ServerSettings = z.infer<typeof ServerSettings>;
export const SettingsUpdate = ServerSettings.partial();

// ── OIDC / SSO in-app configuration (server-admin only) ──────────────────────
// Persisted alongside server settings so OIDC can be configured from the admin
// UI, not only via env vars. Precedence: an OIDC_* env var, when set, OVERRIDES
// the stored value for that field (see server oidc.config.ts). The client
// secret is WRITE-ONLY — it is accepted on update but never returned.
const OidcField = z.string().trim().max(2048);

/** OIDC settings as returned to admins (GET). Never includes the client secret. */
export const OidcSettings = z.object({
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
});
export type OidcSettings = z.infer<typeof OidcSettings>;

/** Admin update payload. All fields optional. clientSecret is write-only: omit to keep the current secret, pass '' to clear it. */
export const OidcSettingsUpdate = z.object({
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

/** Test-connection request. Optional issuer lets an admin validate before saving; omitted = test the effective issuer. */
export const OidcTestRequest = z.object({ issuer: OidcField.optional() });
export type OidcTestRequest = z.infer<typeof OidcTestRequest>;

/** Result of fetching + validating the issuer's OIDC discovery document. */
export const OidcTestResult = z.object({
  ok: z.boolean(),
  issuer: z.string(),
  message: z.string(),
  authorizationEndpoint: z.string().nullable().default(null),
  tokenEndpoint: z.string().nullable().default(null),
});
export type OidcTestResult = z.infer<typeof OidcTestResult>;

export const CampaignMember = z.object({
  id: Id,
  campaignId: Id,
  userId: Id,
  role: Role, // dm | player | viewer — per campaign
  characterId: Id.nullable().default(null),
  username: z.string().default(''), // denormalized for display
  displayName: z.string().default(''),
  ...timestamps,
});
export type CampaignMember = z.infer<typeof CampaignMember>;
export const MemberCreate = z.object({ userId: Id, role: Role, characterId: Id.nullable().optional() });
export const MemberUpdate = z.object({ role: Role.optional(), characterId: Id.nullable().optional() });

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

export const Me = z.object({
  user: User,
  // When `token` is present (PAT auth), memberships reflect the token's
  // EFFECTIVE view: role is capped to min(token scope, membership role) and a
  // campaign-bound token only lists that campaign. Cookie sessions see raw
  // membership roles and no `token` field.
  memberships: z.array(z.object({ campaignId: Id, role: Role, characterId: Id.nullable() })),
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
  // Defaults 'direct' (back-compat: existing tokens write exactly as before).
  // Existing DBs get the column added defaulting to 'direct' via
  // migrateApiTokensTableForWriteScope() (db.module.ts).
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
  // Server-enforced write authority (default 'direct'). When the caller is itself
  // authenticated via a PAT, this is additionally capped to the calling token's
  // writeScope (min in the direct>propose>none order) — a propose-only token can
  // never mint a direct-write sibling. See WriteScope / TokensService.create.
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
  writeScope: WriteScope.optional(), // default: 'direct' — server-enforced write authority (see WriteScope)
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
  writeScope: WriteScope.optional(), // default: 'direct' — server-enforced write authority (see WriteScope)
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
  // The target entity's state captured at propose time (update proposals only; null for
  // creates) — lets the DM review UI render a real before/after diff even if the entity
  // changes between propose and review.
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

// One AI-DM "seat" per campaign (created lazily on first configure/read).
export const AiDmSeat = z.object({
  campaignId: Id,
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

// ---------- encounter difficulty (5e XP-budget estimation, issue #58) ----------
// Computed (read-only) difficulty band for an encounter: the party's summed 5e XP
// thresholds vs the total adjusted monster XP (monster CR->XP with the standard
// number-of-monsters multiplier). `trivial` is below the party's Easy threshold.
export const DifficultyBand = z.enum(['trivial', 'easy', 'medium', 'hard', 'deadly']);
export type DifficultyBand = z.infer<typeof DifficultyBand>;
export const EncounterDifficulty = z.object({
  band: DifficultyBand,
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
});
export type EncounterDifficulty = z.infer<typeof EncounterDifficulty>;

export const CombatantKind = z.enum(['character', 'monster']);
export type CombatantKind = z.infer<typeof CombatantKind>;

/**
 * Coarse HP status band shown to non-DM viewers in place of a monster's exact HP
 * (issue #43). `down` = 0 HP; `critical` <= 25%; `bloodied` <= 50%; `healthy`
 * above. Null for combatants whose exact HP is visible (characters, or any
 * combatant when the DM is viewing).
 */
export const HpBand = z.enum(['healthy', 'bloodied', 'critical', 'down']);
export type HpBand = z.infer<typeof HpBand>;

/**
 * 5e death-save lifecycle for a combatant at 0 HP (issue #57).
 * - `none`: alive (hp > 0), or a monster (monsters don't roll death saves — 0 HP
 *   is simply "down"); death-save counters are held at 0.
 * - `dying`: a character at 0 HP, rolling death saves (successes/failures 0–2).
 * - `stable`: a character at 0 HP that reached 3 successes (or was stabilized) —
 *   unconscious but no longer rolling. Any further damage flips back to `dying`.
 * - `dead`: 3 death-save failures, OR instant death from massive damage
 *   (a single hit whose overflow past 0 HP is >= hpMax).
 */
export const DeathState = z.enum(['none', 'dying', 'stable', 'dead']);
export type DeathState = z.infer<typeof DeathState>;

export const Combatant = z.object({
  id: Id,
  encounterId: Id,
  kind: CombatantKind,
  characterId: Id.nullable().default(null),
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
});
export type Combatant = z.infer<typeof Combatant>;

export const CombatantCreate = z.object({
  kind: CombatantKind,
  name: z.string().min(1).max(120).optional(), // required unless resolvable from ruleEntryId
  characterId: Id.optional(), // link a late-joining party member
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
  // Death-save counters, absolute set 0–3 (issue #57). Reaching 3 failures -> dead;
  // 3 successes -> stable. Cleared automatically when the combatant is healed above 0.
  deathSaveSuccesses: z.number().int().min(0).max(3).optional(),
  deathSaveFailures: z.number().int().min(0).max(3).optional(),
  addConditions: z.array(z.string().max(40)).optional(),
  removeConditions: z.array(z.string().max(40)).optional(),
  initiative: z.number().int().optional(), // dm only, enforced server-side
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

export const EncounterWithCombatants = Encounter.extend({ combatants: z.array(Combatant) });
export type EncounterWithCombatants = z.infer<typeof EncounterWithCombatants>;

// ---------- persistent per-encounter combat log (issue #61) ----------
// The in-encounter dice/turn history used to be client-only React state, capped and
// lost on reload. `encounter_events` persists a per-encounter trail written by the
// encounters service on the meaningful combat mutations (HP damage/heal, condition
// add/remove, death, next-turn/round), so the DM can reconstruct "round 2: Ember
// Hound took 8 damage" for a recap and a refresh no longer wipes it.
export const EncounterEventType = z.enum(['damage', 'heal', 'condition', 'death', 'roll', 'turn', 'note']);
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
  actor: z.string().max(200).nullable().default(null),
  target: z.string().max(200).nullable().default(null),
  // Human phrasing of the event, deliberately kept free of exact monster HP totals
  // so listing the log to a non-DM viewer can't leak what issue #43 redacts on the
  // combatant rows (only the damage/heal delta is recorded, never the resulting HP).
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
  ...timestamps,
});
export type InventoryItem = z.infer<typeof InventoryItem>;
export const InventoryItemCreate = InventoryItem.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const InventoryItemUpdate = InventoryItemCreate.partial();

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
  }),
]);
export type TreasuryPatch = z.infer<typeof TreasuryPatch>;

// ---------- dice rolling ----------
// Safe, restricted dice expression: NdM, optionally followed by a keep/drop clause
// (khN/klN/dhN/dlN) and then +K or -K. Keep/drop lets a single roll express D&D-style
// advantage/disadvantage and stat-gen: "2d20kh1" (advantage), "2d20kl1" (disadvantage),
// "4d6kh3" / "4d6dl1" (drop-lowest stat roll). Examples: "1d20+3", "2d6-1", "d20",
// "4d6dl1+2". Capture groups: 1=count, 2=sides, 3=keep/drop clause, 4=modifier.
export const DiceExprPattern = /^\s*(\d{1,2})?d(\d{1,3})\s*((?:kh|kl|dh|dl)\s*\d{1,2})?\s*([+-]\s*\d{1,3})?\s*$/i;
export const RollRequest = z.object({
  expr: z.string().min(1).max(40).regex(DiceExprPattern, 'expected NdM(kh/kl/dh/dlN)(+/-K), e.g. "1d20+3" or "2d20kh1"'),
  // Optional check context (issue #130): a human label ("DEX save") and a difficulty
  // class. When dc is present the server computes success (total >= dc) into the result.
  label: z.string().max(120).optional(),
  dc: z.number().int().min(1).max(99).optional(),
});
export type RollRequest = z.infer<typeof RollRequest>;
export const RollResult = z.object({
  expr: z.string(),
  rolls: z.array(z.number().int()), // every die rolled, in roll order — attestable
  // The subset of `rolls` that counted toward the total, present ONLY when a keep/drop
  // clause applied (e.g. advantage keeps 1 of 2 d20s). Absent == all dice counted.
  kept: z.array(z.number().int()).optional(),
  total: z.number().int(),
  // Echoed check context (issue #130). success is server-computed (total >= dc).
  label: z.string().max(120).optional(),
  dc: z.number().int().optional(),
  success: z.boolean().optional(),
});
export type RollResult = z.infer<typeof RollResult>;

// ---------- real-time campaign events (SSE) ----------
// Thin invalidation signals pushed over GET /campaigns/:id/events — they carry ids, not
// entity payloads, so clients refetch through the normal (permission-checked) REST reads.
export const CampaignEventType = z.enum(['encounter.updated', 'encounter.deleted', 'encounter.ping']);
export type CampaignEventType = z.infer<typeof CampaignEventType>;
export const CampaignEvent = z.object({
  type: CampaignEventType,
  campaignId: Id,
  encounterId: Id,
  // Present only on 'encounter.ping' (issue #238): the transient battle-map ping's location and
  // optional colour/label. Unlike the id-only updated/deleted signals this carries a small,
  // non-secret payload (a click coordinate the sender chose), so there is nothing to leak.
  ping: MapPing.optional(),
  at: IsoDate,
});
export type CampaignEvent = z.infer<typeof CampaignEvent>;

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
export type LocationStatus = z.infer<typeof LocationStatus>;
export type NoteVisibility = z.infer<typeof NoteVisibility>;
export type NoteKind = z.infer<typeof NoteKind>;
export type EntityType = z.infer<typeof EntityType>;
export type TokenScope = z.infer<typeof TokenScope>;
export type ProposalAction = z.infer<typeof ProposalAction>;
export type ProposalStatus = z.infer<typeof ProposalStatus>;
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const AuditEntry = z.object({
  id: Id,
  campaignId: Id.nullable(),
  actor: z.string().max(200), // user id or token name
  actorRole: Role,
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
  fileCount: z.number().int().nonnegative(), // attachment rows for this campaign
  totalBytes: z.number().int().nonnegative(), // sum of attachment.size for this campaign
  quotaBytes: z.number().int().nonnegative().nullable(), // per-campaign cap, or null for unlimited
  overQuota: z.boolean(), // totalBytes > quotaBytes (always false when unlimited)
});
export type StorageCampaignUsage = z.infer<typeof StorageCampaignUsage>;

// Orphans: DB rows whose bytes are missing on disk, and on-disk files with no row.
export const StorageOrphans = z.object({
  rowsWithoutFile: z.number().int().nonnegative(), // attachment rows whose file is gone from disk
  filesWithoutRow: z.number().int().nonnegative(), // upload files (incl. thumbs) with no backing row
  orphanBytes: z.number().int().nonnegative(), // bytes occupied by files-without-row (reclaimable)
});
export type StorageOrphans = z.infer<typeof StorageOrphans>;

export const StorageStats = z.object({
  totalBytes: z.number().int().nonnegative(), // sum of attachment.size across all campaigns (DB view)
  fileCount: z.number().int().nonnegative(), // total attachment rows
  diskBytes: z.number().int().nonnegative(), // actual bytes on disk under uploads/ (originals + thumbs)
  campaigns: z.array(StorageCampaignUsage), // per-campaign breakdown, largest first
  orphans: StorageOrphans,
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

// A single hit. The service ONLY ever builds these from role-filtered lists
// (listForCampaign(role)), so a hidden quest/npc/unexplored location, a
// non-visible note, and every dmSecret are already stripped before a result
// object is ever constructed — hits never leak an entity the caller can't see.
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

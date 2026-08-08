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
  EncounterDifficultyExplanation,
  buildDifficultyExplanation,
  type EncounterDifficultyInput,
} from './encounter-difficulty';
import {
  initModDescThenSortOrderAsc,
  sortOrderAscTiebreak,
  type InitiativeTiebreakCombatant,
} from './initiative-tiebreak';
import {
  ActionSpec,
  MAX_PENDING_CONCENTRATION_CHECKS,
  PendingConcentrationCheck,
  RESOLVER_MATH_D20_5E,
  type CriticalDamageRule,
  type ResolverMathProfile,
  type AttackRollInput,
  type AttackRollResult,
} from './action-resolver';
// Issue #1502/#765: imported early (ahead of the sibling-adapter registration block further
// down, which still carries `export * from './osr-adapter'`) because `Campaign` below
// references `HomebrewMechanicsProfile` directly, and CommonJS `require` — unlike ESM import —
// is NOT hoisted, so a value used at this position must be required at or before this position.
// osr-adapter.ts only imports TYPES from this file, so there is no runtime circular require.
import {
  HomebrewMechanicsProfile,
  OsrAdapter,
  OSR_RULE_SYSTEM_SLUGS,
  OSR_VARIANT_ADAPTERS,
  tryCreateHomebrewRuleSystemAdapter,
  type CustomMechanicsProfile,
  type OsrMechanicsProfile,
} from './osr-adapter';
export type { CustomMechanicsProfile, OsrMechanicsProfile };
import type { RestModel, RestOptionDef } from './rest';
export { type RestOptionDef, DEFAULT_GENERIC_REST_OPTIONS, DEFAULT_STARFINDER_REST_OPTIONS, restOptionsForAdapter } from './rest';
import { CharacterAction } from './character-action';
import { CombatantStatblock } from './combatant-statblock';
import { NarrationLanguage } from './narration-language';
import {
  MAX_SERIES_OCCURRENCES,
  RECURRENCE_FREQS,
  isLocalDate,
  isLocalDateTime,
  isLocalTime,
  isValidIanaTimeZone,
} from './recurrence';
// Structured action resolver (issue #414): data model + pure, system-aware resolution math.
// Re-exported so server / MCP / web import it from '@campfire/schema' alongside everything else.
export * from './action-resolver';
export * from './spell-slots';
export * from './rest';
export * from './character-action';
export * from './combatant-statblock';
export * from './osr-adapter';
export * from './character-creation';
export * from './narration-language';
export * from './leveled-conditions';

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
  EncounterDifficultyExplanation,
  buildDifficultyExplanation,
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

/**
 * A client-minted operation id that makes ONE logical, non-idempotent intent safe to
 * retry (issue #580). Optional on the wire so existing callers (and MCP) keep working;
 * when present the server deduplicates by (actor, operation, key) and REPLAYS the
 * original response rather than re-executing the effect.
 *
 * The contract that matters is where it is minted: once per user intent (the click),
 * never once per HTTP attempt. A key generated inside a fetch/retry wrapper differs on
 * every attempt and protects nothing.
 */
export const IdempotencyKey = z.string().min(1).max(128).optional();

export * from './encounter-aftermath';
export * from './sample-encounter';

// Campaign modules — package identity, lineage, three-way updates, overlays and
// rollback (issue #585) — plus the semver helpers their compatibility/dependency
// ranges are evaluated with.
export * from './semver';
export * from './campaign-module';

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

/**
 * Shared cursor-paginated list envelope (issue #615).
 *
 * High-traffic lists return `{ items, total, hasMore, nextCursor, limit }` instead
 * of unbounded arrays. `nextCursor` is always present and is `null` on the terminal
 * page so REST/MCP consumers see a stable shape.
 */
export function CursorListPage<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().max(512).nullable(),
    limit: z.number().int().positive(),
  });
}

/** Default page size for session log lists (issue #612). */
export const SESSIONS_LIST_DEFAULT_LIMIT = 50;
/** Hard cap for `?limit=` on session lists — clients page with offset, not a huge page. */
export const SESSIONS_LIST_MAX_LIMIT = 200;
/** Default page size for past scheduled-session history (issue #612). */
export const SCHEDULE_PAST_DEFAULT_LIMIT = 20;
/** Hard cap for `?limit=` on past schedule lists. */
export const SCHEDULE_PAST_MAX_LIMIT = 100;

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
/**
 * Issue #871: campaign danger level, defined —
 *  - Object: the whole campaign, not any single scene, session, location, or encounter.
 *  - Timeframe: persistent until the DM deliberately changes it; not a live/moment-to-moment state.
 *  - Audience: visible to every campaign member (dashboard chip + Settings); editable by the DM only.
 *  - Owner: the DM, set via PATCH /campaigns/:id or the `update_campaign`/`update_campaign_status`
 *    MCP tools — the same field both REST and MCP mutate.
 *  - Consequence: purely descriptive narrative backdrop. It has no mechanical effect on rules and
 *    does not gate content; the only functional effect is coloring the AI Driver's narration tone
 *    when non-default (see world-state-prompt.ts formatLocationEnvironmentFromSummary).
 * Explicitly distinct from: per-encounter difficulty (`DifficultyBand`, a computed party-vs-monster
 * budget for one specific encounter), a combatant's live HP band (`hpBand` — current wound state),
 * and the Session Zero safety charter (the table's agreed content/safety boundaries). See the
 * in-app glossary entry (`dangerLevel` in glossaryTerms.ts) for the copy shown to users.
 */
export const DangerLevel = z.enum(['low', 'moderate', 'high', 'deadly']);
export const AiExternalContentPolicy = z.enum(['disabled', 'member_consent']);
export type AiExternalContentPolicy = z.infer<typeof AiExternalContentPolicy>;

/**
 * Map replacement lifecycle (issue #870). When a world or battle map is replaced or
 * removed, the caller chooses whether to keep the old alignment (preserve) or clear
 * the dependent spatial state (reset). Default omitted = preserve, so existing API/MCP
 * callers do not lose data.
 */
export const MapAlignment = z.enum(['preserve', 'reset']);
export type MapAlignment = z.infer<typeof MapAlignment>;

/**
 * Lifecycle status of a campaign (issue #16). `active` is editable; `paused` and
 * `completed` are read-only ("archived"). Named so the status-transition record
 * (#846) and the web status control share one canonical enum.
 */
export const CampaignStatus = z.enum(['active', 'paused', 'completed']);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const Campaign = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(10_000).default(''),
  status: CampaignStatus.default('active'),
  currentLocationId: Id.nullable().default(null),
  dangerLevel: DangerLevel.default('low').describe(
    "Campaign-wide narrative tone/challenge backdrop the DM sets (low/moderate/high/deadly). " +
      "Persistent until changed — not tied to a specific scene, session, or encounter. Purely " +
      "descriptive: no mechanical effect on rules; only colors AI Driver narration when non-default. " +
      "Distinct from encounter difficulty, a combatant's live HP band, and Session Zero safety boundaries.",
  ),
  // When true, only the DM may award XP / level up characters (issue #270); when false
  // (default) any character owner may self-progress, preserving the original behavior.
  dmControlsProgression: z.boolean().default(false),
  // When true, only the DM may advance combat turns (issue #413) — a player's "End turn"
  // on their own active combatant is rejected, preserving the classic DM-only "Next turn"
  // control. When false (default) a player may end their OWN combatant's turn (server still
  // validates ownership + that it is that combatant's turn, and advancement is serialized).
  dmControlsTurns: z.boolean().default(false),
  // When true, a player's "End turn" is staged as a request the DM confirms rather than
  // advancing immediately (issue #413). When false (default) an authorized player end-turn
  // advances directly. Independent of dmControlsTurns (which forbids player end-turn entirely).
  requireDmTurnConfirmation: z.boolean().default(false),
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
  // Issue #635: language contract for AI-generated campaign content (Driver, co-DM,
  // Scribe). Distinct from the client UI locale — only governs model narration output.
  narrationLanguage: NarrationLanguage.default('en'),
  // Issue #501: campaign-level policy for sending member-authored campaign source
  // material (currently scribe inbox notes) to external AI providers. Even when
  // enabled, each member must separately opt in on their own membership row.
  aiExternalContentPolicy: AiExternalContentPolicy.default('member_consent'),
  sessionCount: z.number().int().nonnegative().default(0),
  // Issue #841: highest canonical session number among live recaps, distinct from the
  // COUNT(*) in sessionCount, so cards can show "Session 12" without treating 3 recaps
  // (after gaps or deletes) as the current session number. Denormalized and recomputed.
  latestSessionNumber: z.number().int().nonnegative().default(0),
  ruleSystem: z.string().max(80).default(''), // slug of the installed rule pack (see RulePack), or '' if none picked
  // Issue #1502: a per-campaign, DM-authored homebrew mechanics profile — the same closed-enum
  // ability-table/AC-convention/initiative-model/tiebreak shape `createOsrVariantAdapter`
  // already builds a complete RuleSystemAdapter from for the six built-in OSR retroclones
  // (issue #765), runtime-validated so a persisted profile can never smuggle in unvetted code.
  // Only meaningful when `ruleSystem` is NOT a built-in registered slug and its own `slug` must
  // equal `ruleSystem` (both enforced server-side, not by this schema alone) — see
  // `ruleSystemAdapter(ruleSystem, customMechanicsProfile)`. null (default) — no homebrew
  // profile stored, and every existing campaign has this column NULL after migration.
  customMechanicsProfile: HomebrewMechanicsProfile.nullable().default(null),
  mapAttachmentId: Id.nullable().default(null), // Attachment (kind='map') rendered as the campaign map background
  // Per-campaign upload quota in bytes, or null for no limit (issue #24). Set by a
  // server admin via the storage console — NOT part of CampaignCreate/Update, so a
  // DM can never lift their own campaign's cap. Enforced on attachment upload.
  storageQuotaBytes: z.number().int().nonnegative().nullable().default(null),
  // Soft-delete / trash timestamp (issue #116). Non-null => the campaign is in the
  // trash: excluded from normal listings but its rows + on-disk uploads survive for a
  // grace period, restorable via POST /campaigns/:id/restore. A deliberate second
  // step (DELETE /campaigns/:id/purge) is what finally hard-cascades + wipes the disk.
  // Issue #867: trash freezes EVERY child API (REST/MCP/AI/streams/jobs); only Trash
  // list + restore + purge (with confirm) are exempt. Live purge is refused.
  deletedAt: IsoDate.nullable().default(null),
  ...timestamps,
});
export type Campaign = z.infer<typeof Campaign>;

/**
 * One durable lifecycle-status transition for a campaign (issue #846): who changed
 * the status, when, the from/to pair, and an optional DM-only reason. The table is
 * append-only, so reactivating (back to active) and re-archiving keeps the full
 * history; the latest row is the current provenance shown in the archived banner/settings.
 *
 * `actorUserId` is the durable install-local id; `actorName` is a display-name
 * snapshot captured at transition time (a later rename does not rewrite history).
 * `reason` is DM operational text and must NOT be shown to players; the banner uses
 * only actor + status + time for the player-visible line.
 */
export const CampaignStatusTransition = z.object({
  id: Id,
  campaignId: Id,
  actorUserId: z.string().max(120),
  actorName: z.string().max(200),
  fromStatus: CampaignStatus,
  toStatus: CampaignStatus,
  reason: z.string().max(500).default(''),
  createdAt: IsoDate,
});
export type CampaignStatusTransition = z.infer<typeof CampaignStatusTransition>;

export const CampaignCreate = Campaign.omit({ id: true, createdAt: true, updatedAt: true, sessionCount: true, latestSessionNumber: true, storageQuotaBytes: true, deletedAt: true, publicRecapSharingEnabled: true, publicInvitesEnabled: true }).partial({ description: true, status: true, currentLocationId: true, dangerLevel: true, dmControlsProgression: true, dmControlsTurns: true, requireDmTurnConfirmation: true, narrationLanguage: true, aiExternalContentPolicy: true, ruleSystem: true, mapAttachmentId: true, customMechanicsProfile: true });
export const CampaignUpdate = CampaignCreate.partial().extend({
  // Map replacement lifecycle (issue #870). 'reset' clears location pin coordinates
  // in the same transaction as the mapAttachmentId change; 'preserve' (default) keeps them.
  mapAlignment: MapAlignment.optional(),
  // Issue #846: optional DM-only reason recorded with a status transition. Not a
  // stored column; the service consumes it to stamp the provenance row, then strips
  // it before the row update. Ignored when `status` is absent or unchanged.
  statusChangeReason: z.string().max(500).optional(),
});

/**
 * DELETE /campaigns/:id/purge body (issue #867). Purge is irreversible and refused
 * unless the campaign is already trashed (`deletedAt IS NOT NULL`). Callers must
 * echo the exact confirmation token so a stray DELETE (replay, stale tab, MCP)
 * cannot destroy a campaign without an explicit destructive acknowledgement.
 */
export const CAMPAIGN_PURGE_CONFIRM_TOKEN = 'PURGE' as const;
export const CampaignPurge = z.object({
  confirm: z.literal(CAMPAIGN_PURGE_CONFIRM_TOKEN),
});
export type CampaignPurge = z.infer<typeof CampaignPurge>;

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

/** Versioned manifest returned by GET /campaigns/:id/clone/preview (issue #435). */
export const CAMPAIGN_CLONE_PREVIEW_FORMAT_VERSION = 1;

export const ClonePreviewExclusion = z.object({
  module: z.string(),
  reason: z.string(),
});
export type ClonePreviewExclusion = z.infer<typeof ClonePreviewExclusion>;

export const ClonePreviewWarning = z.object({
  code: z.string(),
  message: z.string(),
});
export type ClonePreviewWarning = z.infer<typeof ClonePreviewWarning>;

export const ClonePreviewModuleInclusion = z.object({
  included: z.boolean(),
  count: z.number().int().nonnegative(),
  note: z.string().optional(),
});
export type ClonePreviewModuleInclusion = z.infer<typeof ClonePreviewModuleInclusion>;

export const CampaignClonePreview = z.object({
  app: z.literal('campfire'),
  kind: z.literal('campaign-clone-preview'),
  formatVersion: z.number().int(),
  appVersion: z.string(),
  schemaVersion: z.number().int(),
  campaignId: Id,
  mode: CampaignCloneMode,
  createdAt: IsoDate,
  counts: z.record(z.string(), z.number().int().nonnegative()),
  inclusions: z.record(z.string(), ClonePreviewModuleInclusion),
  exclusions: z.array(ClonePreviewExclusion),
  warnings: z.array(ClonePreviewWarning),
});
export type CampaignClonePreview = z.infer<typeof CampaignClonePreview>;

// ── Export profiles + pre-export inventory (issue #586) ──────────────────────
// The campaign export is no longer one artifact. `backup` is the unredacted DM
// backup; `handoff` hands the world (and its secrets) to a new DM without the old
// group's identities or paper trail; `publish` produces a redistributable adventure
// module whose default is to exclude everything identity- or operations-shaped.
export const ExportProfile = z.enum(['backup', 'handoff', 'publish']);
export type ExportProfile = z.infer<typeof ExportProfile>;

/** Opt-ins that WIDEN the publish profile. All default false — redaction-safe. */
export const ExportProfileOptions = z.object({
  includeDmSecrets: z.boolean().default(false),
  includePlayedState: z.boolean().default(false),
  includePlayerContent: z.boolean().default(false),
});
export type ExportProfileOptions = z.infer<typeof ExportProfileOptions>;

export const ExportInventoryRow = z.object({
  module: z.string(),
  included: z.number().int().nonnegative(),
  redacted: z.number().int().nonnegative(),
  reason: z.string().optional(),
  /** Columns the per-entity ALLOWLIST withheld from the rows that did travel. */
  fieldsWithheld: z.array(z.string()).optional(),
});
export type ExportInventoryRow = z.infer<typeof ExportInventoryRow>;

export const ExportAttachmentInventory = z.object({
  included: z.number().int().nonnegative(),
  bytesWithheld: z.number().int().nonnegative(),
  filenamesNeutralized: z.number().int().nonnegative(),
  metadataStripped: z.number().int().nonnegative(),
  notes: z.array(z.string()),
});
export type ExportAttachmentInventory = z.infer<typeof ExportAttachmentInventory>;

/** Pre-export inventory returned by GET /campaigns/:id/export/preview (issue #586). */
export const ExportInventory = z.object({
  app: z.literal('campfire'),
  kind: z.literal('campaign-export-inventory'),
  formatVersion: z.number().int(),
  campaignId: Id,
  profile: ExportProfile,
  options: ExportProfileOptions,
  secrecyProfile: z.string(),
  summary: z.string(),
  createdAt: IsoDate,
  policy: z.record(z.string(), z.boolean()),
  rows: z.array(ExportInventoryRow),
  attachments: ExportAttachmentInventory,
  identifiers: z.object({
    scanned: z.number().int().nonnegative(),
    unscannable: z.array(z.string()),
    occurrencesRedacted: z.number().int().nonnegative(),
  }),
  pseudonyms: z.object({ contributors: z.number().int().nonnegative() }),
  /** What this redaction does NOT protect against — always shown to the DM. */
  limitations: z.array(z.string()),
});
export type ExportInventory = z.infer<typeof ExportInventory>;

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
    // Issue #436: planned game nights (with nested RSVPs) and per-session attendance.
    scheduledSessions: z.array(ImportedEntity).optional(),
    sessionAttendance: z.array(ImportedEntity).optional(),
    // Issue #584: open-license packs the export's compendium refs depend on (loose — validated in service).
    compendiumDependencies: z.array(ImportedEntity).optional(),
    /** When refs cannot resolve: block (default) or import with detached snapshots. */
    onUnresolvedCompendium: z.enum(['block', 'detach']).optional(),
    // Issue #846: durable lifecycle-status provenance (actor/time/from->to/reason),
    // re-inserted with fresh ids. Loose; the importer is defensive (see importCampaign).
    statusTransitions: z.array(ImportedEntity).optional(),
  })
  .passthrough();
export type CampaignImport = z.infer<typeof CampaignImport>;

// ---------- per-campaign trash (issue #269) ----------
// The soft-delete/undo feature (#116) gave every trashable entity a `deleted_at`
// column + a POST /<route>/:id/restore endpoint, but the only Trash UI was for whole
// trashed *campaigns* on the home page — a soft-deleted entity was unrecoverable once
// its Undo toast expired. GET /campaigns/:id/trash lists a campaign's soft-deleted
// child entities (DM-only) as these lightweight rows: enough to render a Trash page
// and drive Restore. `type` is the entity kind; restore routes are mapped (usually
// the plural resource name — session -> /sessions/:id/restore — with exceptions such
// as story_arc -> /arcs, story_beat -> /beats, timeline_event -> /timeline/:id/restore).
// See TrashPage TYPE_META.
export const TrashedEntityType = z.enum([
  'session',
  'character',
  'quest',
  'npc',
  'location',
  'faction',
  'encounter',
  'story_arc',
  'story_beat',
  'timeline_event',
]);
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
 * Character lifecycle (issue #115, #719). Only `active` PCs are auto-conscripted into a
 * new encounter's combatant list; `draft` (incomplete sheets), dead, retired, and
 * inactive characters stay on the roster (viewable, full sheet + history intact) but
 * are skipped by the auto-add
 * so a long campaign's graveyard of fallen and replaced PCs stops being force-added
 * to every fight. Deleting a character remains the destructive alternative — this
 * is the non-destructive shelf.
 */
export const CharacterStatus = z.enum(['active', 'draft', 'dead', 'retired', 'inactive']);
export type CharacterStatus = z.infer<typeof CharacterStatus>;

/** Slots at one spell level. `used` is clamped server-side to [0, max]. */
export const SpellSlotLevel = z.object({
  max: z.number().int().min(0).max(20),
  used: z.number().int().min(0).max(20).default(0),
});
export type SpellSlotLevel = z.infer<typeof SpellSlotLevel>;

/** Bounded resource pool on a character sheet (issue #422). */
export const CharacterResource = z.object({
  max: z.number().int().min(0).max(100),
  used: z.number().int().min(0).max(100).default(0),
  name: z.string().max(80).optional(),
  recharge: z.enum(['short-rest', 'long-rest', 'refocus', 'dawn', 'turn-start', 'special']).optional(),
  source: z.string().max(80).optional(),
});
export type CharacterResource = z.infer<typeof CharacterResource>;

/**
 * Issue #1492: the shared schema's hard ceiling on `level`. This is a generous DB-sanity
 * bound chosen so the most permissive rule-system adapter (Open Legend / an OSR retroclone
 * reporting `maxLevel: Infinity`) can never reach it in practice, while still keeping a sane
 * upper guard on the integer column. It mirrors the web form's `Infinity ? 99` convention
 * (`NewCharacterForm.tsx`). Exported as a named constant so `CharactersService.levelUp` (and
 * any other server-side ceiling check) reads the same number the schema enforces — without
 * this, an Infinity-cap campaign leveling a level-99 PC to 100 writes a row the schema then
 * rejects on the next save, re-bricking the sheet exactly the way the old hardcoded 20 did.
 * The server takes `min(adapter.maxLevel, MAX_LEVEL)`.
 */
export const MAX_LEVEL = 99;

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
  // Issue #1492: the schema cap must not conflict with a rule system whose adapter allows
  // past 20 (Open Legend / an OSR retroclone report `maxLevel: Infinity`). The per-system
  // ceiling stays authoritative — `CharactersService.create`/`update`/`levelUp` reject a level
  // above `adapter.maxLevel` (5e=20, 13th Age=10, …) — so this bound is a generous DB-sanity
  // ceiling that the most permissive adapter can never exceed in practice. It mirrors the web
  // form's `Infinity ? 99` convention (`NewCharacterForm.tsx`), so REST, MCP and the sheet all
  // agree on what an uncapped system may reach, without re-bricking the sheet on the next edit.
  // `MAX_LEVEL` is the single exported source for this bound so `levelUp`'s own ceiling check
  // reads the same number the schema enforces — otherwise an Infinity-cap campaign advancing
  // a level-99 PC to 100 would write a row the schema then rejects on every subsequent save
  // (the exact brick this widened bound was meant to end). The server takes the minimum of the
  // adapter cap and `MAX_LEVEL` so an uncapped system still stops here.
  level: z.number().int().min(1).max(MAX_LEVEL).default(1),
  xp: z.number().int().min(0).default(0),
  background: z.string().max(120).default(''),
  // Lifecycle state (issue #115, #719). `active` is the only status auto-added as a combatant
  // on encounter create; draft/dead/retired/inactive PCs are kept but skipped. Editable by
  // the owning player or DM through the normal update path (and upsert_character over MCP).
  status: CharacterStatus.default('active').describe(
    "Lifecycle status: 'active' (default; auto-added to new encounters), 'draft' (incomplete sheet), 'dead', 'retired', or 'inactive'. Non-active PCs stay on the roster but are skipped by encounter auto-add.",
  ),
  stats: z.record(z.string(), z.number().int()).default({}), // e.g. { STR: 8, DEX: 14 }
  ac: z.number().int().nullable().default(null),
  eac: z.number().int().nullable().default(null),
  kac: z.number().int().nullable().default(null),
  // Issue #1910: movement speed in the adapter's movement unit (feet for 5e/PF2e; no
  // 5e-specific naming since a future adapter may use meters/squares). Nullable, default
  // null rather than a baked-in 30 — null means "unset", so this field itself can tell
  // "a 30-speed PC" apart from "no speed on file yet". This value is snapshotted onto
  // Combatant.speed at add time; both getTurnWorkspace's DISPLAY and
  // ActionResolverService.resolveActionEconomyCost's spend/guard ENFORCEMENT resolve the
  // turn-economy movement max the same way, through the shared `movementSlotMax`
  // (encounters.logic.ts): the combatant's own snapshot, or — full stop — the adapter's
  // movement-slot max (e.g. 30 ft for 5e's DND5E_ACTION_ECONOMY), never this field's live
  // value — a null combatant snapshot can't distinguish "predates the column" from "the
  // character had no speed set at add time" (the common case, since this field defaults
  // null), so neither path falls through to this live value once a fight is running
  // (round 4/5 review findings on PR #1980; see Combatant.speed's own doc). min(0): a
  // homebrew "speed 0" (e.g. petrified) is valid; negative is not.
  speed: z.number().int().min(0).nullable().default(null),
  hpCurrent: z.number().int().default(10),
  hpMax: z.number().int().min(0).default(10),
  spCurrent: z.number().int().min(0).default(0),
  spMax: z.number().int().min(0).default(0),
  rpCurrent: z.number().int().min(0).default(0),
  rpMax: z.number().int().min(0).default(0),
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
  // Issue #1643: structured condition instances (source/duration/saves/`stacks`) were
  // already written to this row's `condition_instances` column by #1047, and already
  // exposed on `Combatant` (below, `conditionInstances`) — but never on `Character`, so a
  // client had no way to read a leveled condition's LEVEL (5e Exhaustion's `stacks`) off a
  // sheet, only its bare name. `z.lazy` because `ConditionInstance` is defined much later
  // in this file (the encounter/combat section) and `Character` is defined here, early —
  // a direct forward reference would read `ConditionInstance` before its own `const`
  // initializer has run. Same encounter-only-field-stripping as the write side
  // (`toSheetConditionInstance` in common/conditions.ts): a sheet instance's
  // durationRounds/timing/saveDc/etc. are always null/none, since there is no round loop
  // outside combat.
  conditionInstances: z.lazy(() => z.array(ConditionInstance).max(50).default([])),
  saveProficiencies: z.array(AbilityKey).default([]), // abilities with saving-throw proficiency
  skills: z.record(z.string().max(40), SkillRank).default({}), // skill name -> rank; absent = unproficient
  actions: z.array(CharacterAction).max(100).default([]),
  spellSlots: z.record(z.string().regex(/^[1-9]$/), SpellSlotLevel).default({}), // spell level "1".."9" -> slots
  resources: z.record(z.string().max(80), CharacterResource).default({}),
  portraitUrl: z.string().max(500).nullable().default(null),
  ddbId: z.string().max(40).nullable().default(null),
  notes: z.string().max(20_000).default(''), // public character bio/story — a field ON the sheet, NOT a row in the `notes` system (issue #1784)
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM (a secret curse, hidden true identity…)
  ...timestamps,
});
export type Character = z.infer<typeof Character>;
// `conditionInstances` is omitted here (issue #1643): it's a READ projection Character
// exposes so a client can see a leveled condition's `stacks`, not a general write surface —
// writes go through the dedicated POST :id/conditions (names) and POST :id/conditions/level
// (a leveled track's level) endpoints. `resources` (read via GET :id/resource-vocabulary +
// the Character.resources projection) is writable through BOTH the dedicated POST :id/resources
// spend path (transactional single-pool adjust, issue #1039) AND the general update since
// issue #1492 — the general update MERGES supplied pools over the existing map (so a partial
// send preserves the rest) and rejects an overspend the same way the dedicated path does.
// Also a real necessity, not just tidiness: its `z.lazy()` (see the field's own doc comment on
// `Character`) makes zod-to-json-schema emit a `$ref` for any tool whose input schema spreads
// `CharacterUpdate.shape` — some MCP clients don't resolve `$ref`, which is exactly what
// upsert_character's own test asserts never happens (`test/mcp.e2e-spec.ts`, "no tool schema
// may contain a $ref at all").
export const CharacterCreate = Character.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true, conditionInstances: true })
  .partial()
  .required({ name: true });
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

/**
 * What a D&D Beyond import produced beyond the character's vitals (issue #1903). The
 * importer never drops an unparseable attack/spell entry silently — it lands as a
 * text-only `CharacterAction` (name + notes, no resolvable `spec`) and its name is echoed
 * here so the caller can show the DM/player what needs a manual touch-up. REST and MCP
 * return this identically alongside the created character.
 */
export const DdbImportSummary = z.object({
  actionsImported: z.number().int().min(0).default(0),
  spellsImported: z.number().int().min(0).default(0),
  spellSlotsImported: z.boolean().default(false),
  // Names of imported actions/spells that came in as text-only (no resolvable spec) —
  // never a silent drop, always visible to the importer's caller.
  textOnly: z.array(z.string().max(120)).max(200).default([]),
  // Count of raw sheet entries trimmed by Character.actions' schema cap (issue #1903
  // review) — 0 for the overwhelming majority of sheets (well under the cap); reported
  // rather than silently dropped when a sheet is large enough to exceed it.
  entriesOmitted: z.number().int().min(0).default(0),
});
export type DdbImportSummary = z.infer<typeof DdbImportSummary>;

/** REST/MCP result shape for a D&D Beyond import: the created character plus its summary. */
export const DdbImportResult = z.object({
  character: Character,
  summary: DdbImportSummary,
});
export type DdbImportResult = z.infer<typeof DdbImportResult>;

export const HpPatch = z.union([
  z.object({ delta: z.number().int() }),
  z.object({ set: z.number().int().nonnegative() }),
]);
export const ConditionsPatch = z.object({
  add: z.array(z.string().max(40)).optional(),
  remove: z.array(z.string().max(40)).optional(),
});
/**
 * Set/adjust the LEVEL of one leveled condition track (issue #1643) — e.g. 5e Exhaustion —
 * on a character sheet. `ConditionsPatch` above is presence-only (`add`/`remove` a bare
 * name); it preserves an existing instance's `stacks` unchanged and has no way to move it,
 * which is exactly the gap #1643 found: nothing could raise or lower exhaustion without
 * hand-editing the stored condition. `delta`/`level` are alternatives, not a pair — same
 * shape as {@link ResourcePatch} (`delta` adjusts relative to the current level, `level`
 * sets it absolutely, `level` is applied first when both are sent). `level`/resulting level
 * 0 removes the condition entirely (there is no zero-stacks instance — `ConditionInstance`
 * itself requires `stacks >= 1`). Going below 0 or above the track's `max` is a 400, not a
 * clamp, matching every other bounded-resource write in this schema (#1039).
 */
export const ConditionLevelPatchShape = {
  name: z.string().min(1).max(40),
  delta: z.number().int().optional().describe('Relative level change. Required unless `level` is provided.'),
  level: z.number().int().min(0).max(99).optional().describe('Absolute level to set. Required unless `delta` is provided.'),
} as const;
export const ConditionLevelPatch = z
  .object(ConditionLevelPatchShape)
  .strict()
  .refine((patch) => patch.delta !== undefined || patch.level !== undefined, {
    message: 'Either delta or level is required',
  });
export type ConditionLevelPatch = z.infer<typeof ConditionLevelPatch>;
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

/** Canonical 5e damage-type vocabulary for rule-aware encounter damage (issue #605). */
export const DND5E_DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
] as const;

/**
 * Case-insensitive membership check against a rule-system condition vocabulary
 * (issue #495). Trims the candidate; empty strings never match.
 */
export function isKnownCondition(vocab: readonly string[], name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return vocab.some((c) => c.toLowerCase() === needle);
}
/**
 * Spend (+delta) or restore (-delta) slots at one level; `used` is clamped to [0, max]. Slot
 * maxima are edited via PATCH `spellSlots`. `expectedUpdatedAt` is the same optimistic-
 * concurrency guard as {@link ExpectedUpdatedAt} everywhere else (issue #1902 rework): a
 * `delta` is meaningless without knowing what it is relative to, so a caller that read
 * `used` from a render and echoes back the character's `updatedAt` at that moment gets a
 * 409 instead of a silently-misapplied delta if another client changed the sheet (this
 * slot or otherwise) in between. Omitted => unconditional write, matching every other
 * caller of this contract (AI DM/MCP tools included) exactly as before.
 *
 * {@link ResourcePatch} carries the identical guard for the sibling resource contract
 * (issue #1902 rework, round 24) — the two are separate hand-written shapes, not one
 * merged type, but the same rule.
 */
export const SpellSlotPatch = z.object({
  level: z.number().int().min(1).max(9),
  delta: z.number().int(),
  expectedUpdatedAt: ExpectedUpdatedAt,
});
export type SpellSlotPatch = z.infer<typeof SpellSlotPatch>;
/**
 * Spend, restore, or configure one bounded character resource (issue #422/#1578) —
 * `hitDice`/`rage`/`kiPoints` under 5e, `focusPoints` under PF2e, or a custom pool the
 * character defines by using a `key` the adapter does not declare. `key` is never
 * validated against a closed enum: {@link resourceVocabularyForAdapter} is how a caller
 * DISCOVERS the adapter's standard keys, but the write path stays open to a homebrew
 * resource the same way `characters.resources` always has.
 *
 * `delta` and `used` are alternatives, not a pair — `delta` adjusts relative to the
 * resource's current `used`, `used` sets it absolutely; the service applies `used` first
 * when both are sent, then `delta`. Spending past 0 or restoring past `max` is a 400, not
 * a clamp (see `CharactersService.adjustResource`'s own doc comment for why).
 *
 * `expectedUpdatedAt` is the same optimistic-concurrency guard as {@link SpellSlotPatch}'s
 * own field (issue #1902 rework, round 24): an absolute `used` is a full overwrite, not a
 * delta, so a caller that read `used` from a stale render and echoes back the character's
 * `updatedAt` at that moment gets a 409 instead of silently undoing a concurrent spend/rest
 * from another tab, a REST client, or an MCP caller. Omitted => unconditional write,
 * matching every other caller of this contract exactly as before.
 */
export const ResourcePatch = z.object({
  key: z.string().min(1).max(80),
  delta: z.number().int().optional(),
  used: z.number().int().min(0).max(100).optional(),
  max: z.number().int().min(0).max(100).optional(),
  name: z.string().min(1).max(80).optional(),
  recharge: z.enum(['short-rest', 'long-rest', 'refocus', 'dawn', 'turn-start', 'special']).optional(),
  source: z.string().max(80).optional(),
  expectedUpdatedAt: ExpectedUpdatedAt,
});
export type ResourcePatch = z.infer<typeof ResourcePatch>;
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

/** Total XP required to reach `level` (clamped to [1, 20]). Uses the 5e PHB table. */
export function xpForLevel(level: number): number {
  return XP_THRESHOLDS[Math.max(1, Math.min(20, Math.floor(level))) - 1]!;
}

/** Highest level the given total XP qualifies for (1–20). Uses the 5e PHB table. */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]!) level = i + 1;
  }
  return level;
}

/** Advisory XP progress toward the next level — for character-sheet UI (issue #441). */
export interface XpProgress {
  /** False when the adapter does not model XP thresholds (OSR, Open Legend, …). */
  readonly supported: boolean;
  readonly atCap: boolean;
  readonly currentThreshold: number;
  readonly nextThreshold: number | null;
  readonly ready: boolean;
  readonly pct: number;
}

/** Build `xpForLevel` / `levelForXp` from a cumulative threshold table (issue #441).
 * `thresholds` must be non-empty and strictly increasing; length should match `maxLevel`
 * when the system has a finite level cap. */
export function xpProgressionFromThresholds(
  thresholds: readonly number[],
  maxLevel: number,
): Pick<RuleSystemAdapter, 'supportsXpProgression' | 'xpForLevel' | 'levelForXp'> {
  if (thresholds.length === 0) {
    throw new Error('xpProgressionFromThresholds: thresholds must not be empty');
  }
  if (thresholds.some((v, i) => i > 0 && v <= thresholds[i - 1]!)) {
    throw new Error('xpProgressionFromThresholds: thresholds must be strictly increasing');
  }
  if (Number.isFinite(maxLevel) && thresholds.length < maxLevel) {
    throw new Error(
      `xpProgressionFromThresholds: thresholds.length (${thresholds.length}) must be >= maxLevel (${maxLevel})`,
    );
  }
  const cap = maxLevel === Infinity ? thresholds.length : Math.min(maxLevel, thresholds.length);
  return {
    supportsXpProgression: true,
    xpForLevel(level: number): number {
      const clamped = Math.max(1, Math.min(cap, Math.floor(level)));
      return thresholds[clamped - 1] ?? thresholds[thresholds.length - 1]!;
    },
    levelForXp(xp: number): number {
      let level = 1;
      for (let i = 0; i < cap; i++) {
        if (xp >= thresholds[i]!) level = i + 1;
      }
      return level;
    },
  };
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
  // Stored default false = visible when present; CREATE paths default omitted
  // `hidden` to DM-only (issue #754) — pass false only for an intentional public create.
  hidden: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  // Encounters linked to this quest (issue #480) — present on GET reads only.
  linkedEncounters: z
    .array(
      z.object({
        id: Id,
        name: z.string().min(1).max(120),
        status: z.enum(['preparing', 'running', 'ended']),
      }),
    )
    .optional(),
  ...timestamps,
});
export type Quest = z.infer<typeof Quest>;
// Create: `hidden` stays optional with NO Zod default so omit≠false. Service
// `resolveCreateHidden` then applies issue #754 (omit → DM-only). A `.default(false)`
// here would materialize false before the service and bypass private-by-default
// on MCP/proposal/DTO parse paths.
export const QuestCreate = Quest.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true })
  .partial()
  .required({ title: true })
  .extend({ hidden: z.boolean().optional() });
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
export const StoryBranchUpdate = z.object({
  label: z.string().min(1).max(200).optional(),
  toBeatId: Id.nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type StoryBranchUpdate = z.infer<typeof StoryBranchUpdate>;

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
// Proposal payload for AI/manual beat creates (#1307). arcId pins the beat to an arc;
// when omitted on approve, the server auto-creates a default arc.
export const StoryBeatProposalCreate = StoryBeatCreate.extend({ arcId: Id.optional() });
export type StoryBeatProposalCreate = z.infer<typeof StoryBeatProposalCreate>;
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
  portraitUrl: z.string().max(500).nullable().default(null),
  // Optional on-theme icon (issue #302): the slug of a bundled game-icons.net
  // entity icon (see apps/web/src/lib/icons) shown in place of the initials
  // avatar. '' means "no icon — fall back to initials". The web app validates
  // the slug against its bundled catalog; the server stores it opaquely (an
  // unknown slug simply renders as no icon), so the field stays forward-compatible
  // as the curated set grows. Shared mechanism reused by #305/#307.
  iconSlug: z.string().max(80).default(''),
  // Entity-level secrecy (issue #42) — see Quest.hidden. A hidden NPC is dropped
  // wholesale from every non-DM read until the DM reveals it (hidden=false).
  // CREATE omits default to DM-only (issue #754).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type Npc = z.infer<typeof Npc>;
// Create: optional `hidden` without Zod default — see QuestCreate (#754).
export const NpcCreate = Npc.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true })
  .partial()
  .required({ name: true })
  .extend({ hidden: z.boolean().optional() });
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
  // CREATE omits default to DM-only (issue #754).
  hidden: z.boolean().default(false),
  // Party standing/reputation. `reputation` is a numeric score (-100 hostile →
  // +100 allied, 0 neutral) the DM/scribe bumps; `standing` is the coarse label.
  reputation: z.number().int().min(-100).max(100).default(0),
  standing: FactionStanding.default('neutral'),
  // Emblem/banner portrait image (issue #1324). Nullable URL to an attachment
  // `/api/v1/attachments/:id/file`; absent/empty falls back to faction initials.
  portraitUrl: z.string().max(500).nullable().default(null),
  ...timestamps,
});
export type Faction = z.infer<typeof Faction>;
// Create: optional `hidden` without Zod default — see QuestCreate (#754).
export const FactionCreate = Faction.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true })
  .partial()
  .required({ name: true })
  .extend({ hidden: z.boolean().optional() });
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
  // Encounters linked to this location (issue #480) — present on GET reads only.
  linkedEncounters: z
    .array(
      z.object({
        id: Id,
        name: z.string().min(1).max(120),
        status: z.enum(['preparing', 'running', 'ended']),
      }),
    )
    .optional(),
  // Landmark/portrait image (issue #1324). Nullable URL to an attachment; absent
  // falls back to the status-colored map pin placeholder.
  portraitUrl: z.string().max(500).nullable().default(null),
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
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM (session prep notes; a field ON the session, NOT a row in the `notes` system — issue #1784)
  scheduledSessionId: Id.nullable().default(null),
  // Encounters linked to this session (issue #480) — present on GET reads only.
  linkedEncounters: z
    .array(
      z.object({
        id: Id,
        name: z.string().min(1).max(120),
        status: z.enum(['preparing', 'running', 'ended']),
      }),
    )
    .optional(),
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

/**
 * Paginated session-log list response (issue #612).
 *
 * Returned when the sessions list endpoint is called with `?limit` and/or `?offset`.
 * Newest-first (`number` desc). Always includes `total` + `hasMore` so the UI never
 * silently truncates a long campaign history.
 */
export const SessionListPage = z.object({
  items: z.array(SessionListItem),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type SessionListPage = z.infer<typeof SessionListPage>;

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

// Read-only Player Display cast sessions. The raw token and exit PIN are shown once
// at creation; persisted/listed metadata never carries enough material to recreate them.
export const CastSession = z.object({
  id: Id,
  campaignId: Id,
  label: z.string(),
  createdBy: z.string(),
  tokenPrefix: z.string(),
  expiresAt: IsoDate,
  accessCount: z.number().int().nonnegative(),
  firstAccessedAt: IsoDate.nullable(),
  lastAccessedAt: IsoDate.nullable(),
  ...timestamps,
});
export type CastSession = z.infer<typeof CastSession>;
export const CastSessionCreate = z.object({
  label: z.string().trim().max(120).default(''),
  expiresAt: z.string().datetime({ offset: true }),
});
export type CastSessionCreate = z.infer<typeof CastSessionCreate>;
export const CastSessionCreated = z.object({
  token: z.string(),
  exitPin: z.string(),
  url: z.string(),
  session: CastSession,
});
export type CastSessionCreated = z.infer<typeof CastSessionCreated>;
export const CastSessionExit = z.object({ pin: z.string().trim().min(4).max(20) });
export type CastSessionExit = z.infer<typeof CastSessionExit>;
export const CastSessionMutationResult = z.object({ revoked: z.number().int().nonnegative() });
export type CastSessionMutationResult = z.infer<typeof CastSessionMutationResult>;

/**
 * Payload served by the UNauthenticated `GET /cast/:token/safety` endpoint (issue #1908).
 *
 * A cast client has no member identity, so it gets the same anonymity contract as the
 * member-facing {@link TableSafetyHold} minus everything: no actor, no name, no note, no
 * timestamps, no counts. `active` is the only field any gate ever reads, and it is the
 * only field a shared-TV display needs to blank the fight.
 */
export const CastSafetyState = z.object({ active: z.boolean() });
export type CastSafetyState = z.infer<typeof CastSafetyState>;

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

/**
 * Strictly validate an offset-bearing ISO-8601 date-time and return its canonical
 * `...Z` UTC instant, or `null` if the value is not a valid offset-bearing
 * ISO-8601 date-time.
 *
 * Unlike the lenient {@link IsoDateTime} refinement (which only checks
 * `Date.parse`), this validates the actual calendar components, so it rejects
 * values V8's `Date` would silently roll over — e.g. `2030-02-30` (Feb 30),
 * `2030-04-31` (April 31), or `2030-05-01T24:00:00Z` (hour 24) — which
 * `new Date(...).toISOString()` otherwise quietly moves to a different day. It
 * also requires an explicit offset (`Z` or ±HH:MM), so a zone-less value is
 * never read in the host's local timezone (which would import the same archive
 * to different UTC instants on hosts with different TZ settings).
 *
 * Intended for trust boundaries such as campaign import, where the value comes
 * from an untrusted archive; trusted client inputs keep using {@link IsoDateTime}
 * so existing create/patch behaviour is unchanged.
 */
export function normalizeOffsetIsoDateTime(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  // day 0 of the next (0-based) month = last day of this month — calendar-correct
  // and timezone-independent, so it catches Feb 30 / April 31 before Date rolls them over.
  if (day < 1 || day > new Date(year, month, 0).getDate()) return null;
  const instant = Date.parse(input);
  if (Number.isNaN(instant)) return null;
  return new Date(instant).toISOString();
}


/**
 * Organized-play scheduling fields (issue #588).
 *
 * A scheduled session IS the occurrence: rather than fork a parallel
 * "occurrence" table, the organized-play layer decorates the existing row, so
 * RSVPs, reminders, the ICS feed and the schedule↔recap link keep working
 * unchanged. Every field defaults to an empty/absent value, so a campaign that
 * never opts into venues or series is byte-for-byte the same as before.
 */
const organizedPlayScheduleFields = {
  /** Parent recurring series, or null for a one-off night. */
  seriesId: Id.nullable().default(null),
  /** 0-based position within the parent series (the recurrence identity). */
  occurrenceIndex: z.number().int().min(0).default(0),
  /**
   * IANA zone this night's wall clock is expressed in. '' = legacy row with no
   * explicit zone; clients then localize the UTC instant to the viewer, exactly
   * as they did before #588.
   */
  timezone: z.string().max(64).default(''),
  /** `YYYY-MM-DDTHH:MM` wall clock in `timezone`. '' when `timezone` is ''. */
  localStart: z.string().max(20).default(''),
  venueId: Id.nullable().default(null),
  /** Booked room/table. Null = no room resource (free-text `location` only). */
  roomId: Id.nullable().default(null),
  /** Running DM for this table. '' = unassigned. Same id space as Note.authorUserId. */
  assignedDmUserId: z.string().max(120).default(''),
  /** Seat capacity. 0 = unlimited (and the pre-#588 behaviour). */
  capacity: z.number().int().min(0).max(1000).default(0),
  /** Organized-play event / season grouping keys. '' = ungrouped. */
  eventId: z.string().max(80).default(''),
  seasonId: z.string().max(80).default(''),
  /**
   * Stable RFC 5545 UID. Survives reschedules and updates so a subscribed
   * calendar rewrites the event in place instead of accumulating ghosts.
   * '' on rows written before #588 — the ICS emitter then derives the legacy
   * `campfire-c<campaign>-s<id>` UID, which is the same string those
   * subscribers already hold.
   */
  icsUid: z.string().max(200).default(''),
  /** RFC 5545 SEQUENCE, bumped on every change a calendar client must re-apply. */
  icsSequence: z.number().int().min(0).default(0),
  /** First materialized instant, retained across reschedules as lineage. */
  originalScheduledAt: IsoDateTime.nullable().default(null),
};

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
  prepNotes: z.string().max(20_000).default(''),
  status: z.enum(['scheduled', 'cancelled', 'completed']).default('scheduled'),
  cancelledAt: IsoDateTime.nullable().default(null),
  cancelledBy: z.string().max(120).nullable().default(null),
  cancellationReason: z.string().max(1000).default(''),
  sessionId: Id.nullable().default(null),
  ...organizedPlayScheduleFields,
  ...timestamps,
});
export type ScheduledSession = z.infer<typeof ScheduledSession>;

/**
 * Organized-play fields are server-owned: they are set by series materialization
 * and by the dedicated assignment/reschedule endpoints (which run conflict
 * checks first), never by a raw schedule create/update body. Omitting them keeps
 * `POST /campaigns/:id/schedule` from accepting a `seriesId` that would silently
 * adopt a night into someone else's series, or a `roomId` that skipped its
 * double-booking check.
 */
/**
 * Organized-play decoration keys that campaign export/import deliberately does
 * not carry (issue #1548). Shared by {@link ScheduledSessionCreate}'s omit list
 * and {@link toScheduledSessionExport}'s strip list so the two cannot drift.
 */
export const ORGANIZED_PLAY_OMIT = {
  seriesId: true,
  occurrenceIndex: true,
  venueId: true,
  roomId: true,
  assignedDmUserId: true,
  capacity: true,
  eventId: true,
  seasonId: true,
  icsUid: true,
  icsSequence: true,
  originalScheduledAt: true,
} as const;

export const ScheduledSessionCreate = ScheduledSession.omit({
  id: true,
  campaignId: true,
  status: true,
  cancelledAt: true,
  cancelledBy: true,
  cancellationReason: true,
  sessionId: true,
  createdAt: true,
  updatedAt: true,
  ...ORGANIZED_PLAY_OMIT,
  // `localStart` is derived server-side from `scheduledAt` + `timezone`; a caller
  // supplying both could assert a wall clock that contradicts the instant.
  localStart: true,
})
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
  prepNotes: z.string().max(20_000).optional(),
});
// `timezone` is deliberately absent (#588), so a one-off's zone is set at creation
// and never corrected here. On a one-off the INSTANT is authoritative and the zone
// is display metadata that `localStart` is derived from — a wrong zone therefore
// mislabels the wall clock but never moves the game, and PATCHing `scheduledAt`
// re-derives `localStart` from the stored zone, so the row stays self-consistent
// either way. A series occurrence is the opposite (wall clock authoritative), and
// its zone belongs to the series, which is why the reschedule endpoint owns it.
// The cost of this is real but bounded: correcting a zone typo means recreating
// the row. If that becomes a live complaint, the fix is a dedicated endpoint that
// re-derives `localStart` — not a field here, which would silently rewrite a
// derived column through a path that does no organized-play validation.
export const ScheduledSessionCancel = z.object({
  reason: z.string().max(1000).optional(),
});
export type ScheduledSessionCancel = z.infer<typeof ScheduledSessionCancel>;
/**
 * Restore body (#588). Fully optional: every pre-existing caller posts no body.
 *
 * `force` exists because a restore RE-ACQUIRES the room and DM its cancellation
 * released — while the night was cancelled, another campaign may legitimately have
 * booked them — so restore rejects with 409 SCHEDULE_CONFLICT like every other
 * booking path and needs the same coordinator override. Carried in a body rather
 * than a query param to match `ScheduledSessionCancel` on `DELETE /schedule/:id`:
 * the same shape of optional lifecycle payload on the same controller.
 */
export const ScheduledSessionRestore = z.object({
  force: z.boolean().default(false),
  /**
   * Why the night is coming back. Written to the `restore` ledger entry.
   *
   * Bounds copied from `ScheduledSessionCancel.reason` deliberately, not chosen
   * afresh: both are audit prose on the SAME append-only ledger, and two fields
   * on one ledger disagreeing about their own limits is how the next
   * inconsistency starts. Without this the ledger could hold "cancelled: venue
   * flooded" followed by a restore explaining nothing, and a coordinator reading
   * it could not tell whether the flood receded or someone misclicked — which is
   * the question the ledger exists to answer.
   */
  reason: z.string().max(1000).optional(),
});
export type ScheduledSessionRestore = z.infer<typeof ScheduledSessionRestore>;

export const ScheduledSessionDuplicate = z.object({
  scheduledAt: IsoDateTime.optional(),
  durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
  title: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
});
export type ScheduledSessionDuplicate = z.infer<typeof ScheduledSessionDuplicate>;

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

/**
 * Campaign-export shape for a scheduled session (issue #1548).
 *
 * `CampaignsService.importCampaign` has never restored organized-play decoration —
 * it inserts scheduled sessions from a closed literal that writes only the legacy
 * fields (`scheduledAt`, `durationMinutes`, `title`, `location`, `notes`, `status`,
 * `cancelledAt`, `cancellationReason`), the same "drop install-local/cross-collection
 * ids" discipline it already applies to `cancelledBy` and `sessionId`. A campaign
 * export carrying `seriesId`/`venueId`/`roomId`/etc. anyway made an organized-play
 * campaign's export LOOK like a full backup of its scheduling, when restoring it
 * silently flattened every occurrence into a one-off — the export promised more than
 * import could ever deliver. Per the maintainer's ruling on #1548: campaign
 * export/import cares about the campaign, not install-level scheduling/venue/room
 * resources, so the fix is to stop exporting decoration import was never going to
 * restore, rather than teach import to restore it.
 *
 * Reuses {@link ORGANIZED_PLAY_OMIT} — the exact field set import already never
 * reads on the CREATE path — rather than a second hand-maintained list that could
 * drift from it.
 */
export const ScheduledSessionExport = ScheduledSessionWithRsvps.omit(ORGANIZED_PLAY_OMIT);
export type ScheduledSessionExport = z.infer<typeof ScheduledSessionExport>;

/**
 * Drop organized-play decoration from a scheduled-session row for campaign export.
 *
 * Deliberately does **not** re-validate through {@link ScheduledSessionExport}.parse:
 * `importCampaign` writes schedule fields through a closed insert literal into SQLite
 * without enforcing Zod bounds (e.g. title length, RSVP status enum), so a previously
 * exportable imported campaign can hold out-of-schema values. Re-parsing here would
 * turn every JSON / mdzip / export-preview path into a 500 for those campaigns.
 * Export's job is to project trusted stored rows; validation belongs at write boundaries.
 */
export function toScheduledSessionExport(
  row: ScheduledSessionWithRsvps,
): ScheduledSessionExport {
  const out: Record<string, unknown> = { ...row };
  for (const key of Object.keys(ORGANIZED_PLAY_OMIT) as Array<keyof typeof ORGANIZED_PLAY_OMIT>) {
    delete out[key];
  }
  return out as ScheduledSessionExport;
}

/**
 * Paginated past-schedule list (issue #612). Most-recent ended nights first.
 */
export const ScheduledSessionListPage = z.object({
  items: z.array(ScheduledSessionWithRsvps),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type ScheduledSessionListPage = z.infer<typeof ScheduledSessionListPage>;

// ---------- organized play: venues, rooms, series, conflicts (issue #588) ----------
// Wall-clock/recurrence math lives in ./recurrence so it can be unit-tested with
// no DB and reused by any surface that has to reason about a series.
export * from './recurrence';

/** A recognized IANA zone, validated against this runtime's ICU data. */
export const IanaTimeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidIanaTimeZone, 'expected an IANA time zone (e.g. America/New_York)');

/** `YYYY-MM-DD` calendar date in some zone — deliberately not an instant. */
export const LocalDateString = z.string().trim().max(10).refine(isLocalDate, 'expected a YYYY-MM-DD local date');
/** `HH:MM` 24-hour wall clock in some zone. */
export const LocalTimeString = z.string().trim().max(5).refine(isLocalTime, 'expected an HH:MM local time');
/** `YYYY-MM-DDTHH:MM` wall clock in some zone. */
export const LocalDateTimeString = z
  .string()
  .trim()
  .max(16)
  .refine(isLocalDateTime, 'expected a YYYY-MM-DDTHH:MM local date-time');

/**
 * A physical (or virtual) place organized play happens. Install-level, not
 * campaign-scoped: the whole point is that several campaigns share one room
 * calendar, so a venue cannot hang off a single campaign.
 */
export const PlayVenue = z.object({
  id: Id,
  name: z.string().trim().min(1).max(120),
  /** Default zone for series booked here. Rooms inherit it. */
  timezone: IanaTimeZone,
  address: z.string().max(300).default(''),
  notes: z.string().max(2000).default(''),
  ...timestamps,
});
export type PlayVenue = z.infer<typeof PlayVenue>;
export const PlayVenueCreate = PlayVenue.omit({ id: true, createdAt: true, updatedAt: true }).partial({
  address: true,
  notes: true,
});
export type PlayVenueCreate = z.infer<typeof PlayVenueCreate>;
export const PlayVenueUpdate = PlayVenueCreate.partial();
export type PlayVenueUpdate = z.infer<typeof PlayVenueUpdate>;

/** One bookable table/room inside a venue. `capacity` 0 = unlimited. */
export const PlayRoom = z.object({
  id: Id,
  venueId: Id,
  name: z.string().trim().min(1).max(120),
  capacity: z.number().int().min(0).max(1000).default(0),
  notes: z.string().max(2000).default(''),
  ...timestamps,
});
export type PlayRoom = z.infer<typeof PlayRoom>;
export const PlayRoomCreate = PlayRoom.omit({ id: true, venueId: true, createdAt: true, updatedAt: true }).partial({
  capacity: true,
  notes: true,
});
export type PlayRoomCreate = z.infer<typeof PlayRoomCreate>;
export const PlayRoomUpdate = PlayRoomCreate.partial();
export type PlayRoomUpdate = z.infer<typeof PlayRoomUpdate>;

export const PlayVenueWithRooms = PlayVenue.extend({ rooms: z.array(PlayRoom) });
export type PlayVenueWithRooms = z.infer<typeof PlayVenueWithRooms>;

export const RecurrenceFreqEnum = z.enum(RECURRENCE_FREQS);
export type RecurrenceFreqEnum = z.infer<typeof RecurrenceFreqEnum>;

/**
 * A recurring run of game nights.
 *
 * The recurrence is stored as (IANA zone + local start date + local start time +
 * rule), NOT as a first instant plus a fixed millisecond stride. That is the
 * whole DST story: "Tuesdays at 19:00 America/New_York" must stay 19:00 local
 * when the offset flips, and only a wall clock can say that.
 */
export const SessionSeries = z.object({
  id: Id,
  campaignId: Id,
  title: z.string().max(200).default(''),
  location: z.string().max(200).default(''),
  notes: z.string().max(5000).default(''),
  timezone: IanaTimeZone,
  startDate: LocalDateString,
  startTime: LocalTimeString,
  durationMinutes: z.number().int().min(15).max(24 * 60).default(240),
  freq: RecurrenceFreqEnum,
  interval: z.number().int().min(1).max(52).default(1),
  count: z.number().int().min(1).max(MAX_SERIES_OCCURRENCES).default(1),
  untilDate: LocalDateString.nullable().default(null),
  venueId: Id.nullable().default(null),
  roomId: Id.nullable().default(null),
  assignedDmUserId: z.string().max(120).default(''),
  capacity: z.number().int().min(0).max(1000).default(0),
  eventId: z.string().max(80).default(''),
  seasonId: z.string().max(80).default(''),
  /** Stable UID root shared by every occurrence's ICS UID. Server-assigned. */
  seriesUid: z.string().max(120),
  status: z.enum(['active', 'cancelled']).default('active'),
  ...timestamps,
});
export type SessionSeries = z.infer<typeof SessionSeries>;

export const SessionSeriesCreate = SessionSeries.omit({
  id: true,
  campaignId: true,
  seriesUid: true,
  status: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  title: true,
  location: true,
  notes: true,
  durationMinutes: true,
  interval: true,
  count: true,
  untilDate: true,
  venueId: true,
  roomId: true,
  assignedDmUserId: true,
  capacity: true,
  eventId: true,
  seasonId: true,
});
export type SessionSeriesCreate = z.infer<typeof SessionSeriesCreate>;

/**
 * Series-level edits. Deliberately excludes the recurrence rule: changing
 * "when" on a live series would have to reconcile every materialized occurrence
 * against its exceptions, and the honest operation for that is cancelling the
 * series and creating a new one. Metadata edits fan out to future occurrences
 * that carry no per-occurrence override.
 */
export const SessionSeriesUpdate = z.object({
  title: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
  roomId: Id.nullable().optional(),
  assignedDmUserId: z.string().max(120).optional(),
  capacity: z.number().int().min(0).max(1000).optional(),
  eventId: z.string().max(80).optional(),
  seasonId: z.string().max(80).optional(),
});
export type SessionSeriesUpdate = z.infer<typeof SessionSeriesUpdate>;

/** Materialize `addCount` more occurrences past the end of an existing series. */
export const SessionSeriesExtend = z.object({
  addCount: z.number().int().min(1).max(MAX_SERIES_OCCURRENCES),
});
export type SessionSeriesExtend = z.infer<typeof SessionSeriesExtend>;

export const SessionSeriesCancel = z.object({ reason: z.string().max(1000).optional() });
export type SessionSeriesCancel = z.infer<typeof SessionSeriesCancel>;

/**
 * Append-only ledger of everything that happened to a single occurrence after it
 * was materialized. This is what makes "per-occurrence exceptions, cancellations
 * and reschedule lineage" auditable rather than inferred from the current row.
 */
/**
 * `edit` records a per-occurrence PROSE edit (title / location / notes) made
 * through the legacy `PATCH /schedule/:id` (#588). It is deliberately NOT a
 * metadata override — see `METADATA_OVERRIDE_KINDS` — so the occurrence still
 * receives later series edits; it exists so the lineage shows the edit happened
 * at all. Treating it as an override would freeze the night out of every later
 * series edit permanently, because the ledger is append-only.
 */
export const SeriesExceptionKind = z.enum(['cancel', 'reschedule', 'reassign', 'restore', 'edit']);
export type SeriesExceptionKind = z.infer<typeof SeriesExceptionKind>;

export const SeriesException = z.object({
  id: Id,
  seriesId: Id,
  occurrenceId: Id.nullable().default(null),
  /** The occurrence's ORIGINAL local date — the RFC 5545 RECURRENCE-ID analogue. */
  recurrenceLocalDate: z.string().max(10).default(''),
  kind: SeriesExceptionKind,
  fromScheduledAt: IsoDateTime.nullable().default(null),
  toScheduledAt: IsoDateTime.nullable().default(null),
  toLocalStart: z.string().max(20).default(''),
  /**
   * The assignment delta this entry represents (#588).
   *
   * Recorded because the surviving occurrence holds only its FINAL assignment, so
   * an A->B->C sequence of room moves loses B entirely — and a ledger that
   * advertises "append-only exception lineage" while retaining only the instants
   * cannot answer what any entry actually changed. Equal `from`/`to` on a
   * cancel/restore, which states the seating in force at that moment.
   */
  fromRoomId: z.number().int().nullable().default(null),
  toRoomId: z.number().int().nullable().default(null),
  fromAssignedDmUserId: z.string().max(120).default(''),
  toAssignedDmUserId: z.string().max(120).default(''),
  fromCapacity: z.number().int().min(0).default(0),
  toCapacity: z.number().int().min(0).default(0),
  reason: z.string().max(1000).default(''),
  actorUserId: z.string().max(120).default(''),
  createdAt: IsoDate,
});
export type SeriesException = z.infer<typeof SeriesException>;

/** Move ONE occurrence without disturbing the rest of its series. */
export const OccurrenceReschedule = z.object({
  /** New wall clock. Combined with the occurrence's zone (or `timezone`). */
  localStart: LocalDateTimeString.optional(),
  timezone: IanaTimeZone.optional(),
  /** Alternative to localStart for callers that already have an instant. */
  scheduledAt: IsoDateTime.optional(),
  durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
  roomId: Id.nullable().optional(),
  reason: z.string().max(1000).optional(),
  /** Book anyway despite reported conflicts (coordinator override). */
  force: z.boolean().default(false),
});
export type OccurrenceReschedule = z.infer<typeof OccurrenceReschedule>;

/** Re-seat one occurrence: different room, different running DM, different capacity. */
export const OccurrenceReassign = z.object({
  roomId: Id.nullable().optional(),
  assignedDmUserId: z.string().max(120).optional(),
  capacity: z.number().int().min(0).max(1000).optional(),
  reason: z.string().max(1000).optional(),
  force: z.boolean().default(false),
});
export type OccurrenceReassign = z.infer<typeof OccurrenceReassign>;

export const ScheduleConflictKind = z.enum(['room', 'dm', 'member']);
export type ScheduleConflictKind = z.infer<typeof ScheduleConflictKind>;

/**
 * One reason a proposed booking cannot go ahead.
 *
 * PRIVACY: `campaignId`, `campaignName`, `scheduleId` and `title` are populated
 * ONLY when the caller can already read that campaign. A coordinator who cannot
 * still learns that the resource is taken and for how long — which is the whole
 * point of a shared room — but learns nothing about whose game it is. `visible`
 * says which of the two shapes this is, so a client never has to guess whether a
 * null means "redacted" or "genuinely absent".
 */
export const ScheduleConflict = z.object({
  kind: ScheduleConflictKind,
  /** True when the caller may see the conflicting campaign's identity. */
  visible: z.boolean(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  roomId: Id.nullable().default(null),
  roomName: z.string().max(120).default(''),
  venueName: z.string().max(120).default(''),
  /** Which subject collided: the DM's or the member's user id (never redacted — the caller supplied it). */
  subjectUserId: z.string().max(120).default(''),
  campaignId: Id.nullable().default(null),
  campaignName: z.string().max(200).nullable().default(null),
  scheduleId: Id.nullable().default(null),
  title: z.string().max(200).nullable().default(null),
});
export type ScheduleConflict = z.infer<typeof ScheduleConflict>;
/**
 * Restore RESPONSE (#588) — a restored night plus what forcing it overrode.
 *
 * `conflicts` is REQUIRED, not optional and not defaulted, and that is the
 * point: `restore` accepts `force`, and the rule this feature states is that an
 * override the caller cannot tell they took is not an override. Every other
 * force-taking booking path already returned its redacted list; restore returned
 * a bare `ScheduledSessionWithRsvps`, so a forced restore that double-booked a
 * room succeeded in silence. Making the field required means a restore path that
 * forgets to report does not compile.
 *
 * Empty on an unforced restore that hit nothing — the caller overrode nothing.
 */
export const ScheduledSessionRestored = ScheduledSessionWithRsvps.extend({
  conflicts: z.array(ScheduleConflict),
});
export type ScheduledSessionRestored = z.infer<typeof ScheduledSessionRestored>;

/**
 * Response of the two per-occurrence booking writes (reschedule / reassign).
 *
 * Named rather than left as an inline `{ occurrence, conflicts }` so that the
 * "a force-taking write reports what it overrode" rule is checkable by
 * machine — see force-reports-conflicts.spec.ts. `conflicts` is required here
 * for the same reason it is on ScheduledSessionRestored.
 */
export const OccurrenceWriteResult = z.object({
  occurrence: ScheduledSession,
  conflicts: z.array(ScheduleConflict),
});
export type OccurrenceWriteResult = z.infer<typeof OccurrenceWriteResult>;

export const SessionSeriesWithOccurrences = SessionSeries.extend({
  occurrences: z.array(ScheduledSession),
  exceptions: z.array(SeriesException),
  /**
   * Conflicts a coordinator FORCED past on the write that returned this payload
   * (#588). Empty on reads, and empty on any write that was not forced.
   *
   * The whole justification for `force` is that overriding is a decision the
   * caller makes knowingly — so create, extend and the metadata fan-out have to
   * report what they overbooked, exactly as applyTemplate and the per-occurrence
   * endpoints already did. A 200 that silently double-books is an override the
   * caller cannot tell they took.
   */
  conflicts: z.array(ScheduleConflict).default([]),
});
export type SessionSeriesWithOccurrences = z.infer<typeof SessionSeriesWithOccurrences>;

/** Ask "would this booking collide?" without writing anything. */
export const ScheduleConflictQuery = z.object({
  scheduledAt: IsoDateTime.optional(),
  localStart: LocalDateTimeString.optional(),
  timezone: IanaTimeZone.optional(),
  durationMinutes: z.number().int().min(1).max(24 * 60).default(240),
  roomId: Id.nullable().default(null),
  assignedDmUserId: z.string().max(120).default(''),
  memberUserIds: z.array(z.string().max(120)).max(50).default([]),
  /** Ignore this occurrence when checking (used when editing it in place). */
  excludeScheduleId: Id.optional(),
});
export type ScheduleConflictQuery = z.infer<typeof ScheduleConflictQuery>;

export const ScheduleConflictReport = z.object({
  scheduledAt: IsoDateTime,
  endsAt: IsoDateTime,
  conflicts: z.array(ScheduleConflict),
});
export type ScheduleConflictReport = z.infer<typeof ScheduleConflictReport>;

/**
 * One row of the cross-campaign coordinator calendar. Same privacy rule as
 * ScheduleConflict: a night in a campaign the caller cannot read is reported as
 * an opaque busy block against its room/DM, never with its title or campaign.
 */
export const CoordinatorCalendarEntry = z.object({
  visible: z.boolean(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  status: z.enum(['scheduled', 'cancelled', 'completed']),
  timezone: z.string().max(64).default(''),
  localStart: z.string().max(20).default(''),
  venueId: Id.nullable().default(null),
  venueName: z.string().max(120).default(''),
  roomId: Id.nullable().default(null),
  roomName: z.string().max(120).default(''),
  capacity: z.number().int().min(0).default(0),
  seatsTaken: z.number().int().min(0).default(0),
  eventId: z.string().max(80).default(''),
  seasonId: z.string().max(80).default(''),
  assignedDmUserId: z.string().max(120).default(''),
  scheduleId: Id.nullable().default(null),
  campaignId: Id.nullable().default(null),
  campaignName: z.string().max(200).nullable().default(null),
  title: z.string().max(200).nullable().default(null),
  seriesId: Id.nullable().default(null),
});
export type CoordinatorCalendarEntry = z.infer<typeof CoordinatorCalendarEntry>;

export const CoordinatorCalendar = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
  entries: z.array(CoordinatorCalendarEntry),
});
export type CoordinatorCalendar = z.infer<typeof CoordinatorCalendar>;

/**
 * A reusable blueprint for a block of organized-play tables — "Tuesday 19:00 in
 * the Blue Room, Thursday 19:00 in the Red Room, 8 weeks" — applied in one call
 * to create every series at once.
 */
export const ScheduleTemplateSlot = z.object({
  /** 0 = Sunday … 6 = Saturday. The template anchors to the next matching date. */
  weekday: z.number().int().min(0).max(6),
  startTime: LocalTimeString,
  durationMinutes: z.number().int().min(15).max(24 * 60).default(240),
  roomId: Id.nullable().default(null),
  assignedDmUserId: z.string().max(120).default(''),
  capacity: z.number().int().min(0).max(1000).default(0),
  title: z.string().max(200).default(''),
});
export type ScheduleTemplateSlot = z.infer<typeof ScheduleTemplateSlot>;

export const ScheduleTemplate = z.object({
  id: Id,
  name: z.string().trim().min(1).max(120),
  venueId: Id.nullable().default(null),
  timezone: IanaTimeZone,
  freq: RecurrenceFreqEnum.default('weekly'),
  interval: z.number().int().min(1).max(52).default(1),
  count: z.number().int().min(1).max(MAX_SERIES_OCCURRENCES).default(8),
  eventId: z.string().max(80).default(''),
  seasonId: z.string().max(80).default(''),
  slots: z.array(ScheduleTemplateSlot).min(1).max(20),
  ...timestamps,
});
export type ScheduleTemplate = z.infer<typeof ScheduleTemplate>;

export const ScheduleTemplateCreate = ScheduleTemplate.omit({ id: true, createdAt: true, updatedAt: true }).partial({
  venueId: true,
  freq: true,
  interval: true,
  count: true,
  eventId: true,
  seasonId: true,
});
export type ScheduleTemplateCreate = z.infer<typeof ScheduleTemplateCreate>;

/** Instantiate a template into a campaign, starting on/after `startDate`. */
export const ScheduleTemplateApply = z.object({
  campaignId: Id,
  startDate: LocalDateString,
  /** Override the template's occurrence count for this application. */
  count: z.number().int().min(1).max(MAX_SERIES_OCCURRENCES).optional(),
  /**
   * Rotate DMs across the generated slots. When non-empty this overrides each
   * slot's `assignedDmUserId`, cycling through the list slot by slot — the
   * organized-play "rotating DM" pattern.
   */
  dmRotation: z.array(z.string().max(120)).max(50).default([]),
  eventId: z.string().max(80).optional(),
  seasonId: z.string().max(80).optional(),
  /** Create the series even where occurrences collide with existing bookings. */
  force: z.boolean().default(false),
});
export type ScheduleTemplateApply = z.infer<typeof ScheduleTemplateApply>;

export const ScheduleTemplateApplyResult = z.object({
  templateId: Id,
  campaignId: Id,
  series: z.array(SessionSeries),
  occurrencesCreated: z.number().int().nonnegative(),
  /** Conflicts detected during the bulk create (reported even when forced). */
  conflicts: z.array(ScheduleConflict),
});
export type ScheduleTemplateApplyResult = z.infer<typeof ScheduleTemplateApplyResult>;

/**
 * Non-destructive read joining an occurrence to the play log it produced and the
 * characters recorded present. Nothing here writes: the occurrence keeps its own
 * lifecycle, the recap keeps its own attendance rows, and this view simply reads
 * across the existing link.
 */
export const OccurrenceAttendance = z.object({
  scheduleId: Id,
  sessionId: Id.nullable().default(null),
  sessionNumber: z.number().int().positive().nullable().default(null),
  capacity: z.number().int().min(0).default(0),
  rsvpYes: z.number().int().min(0).default(0),
  seatsRemaining: z.number().int().nullable().default(null),
  attendees: z.array(z.object({ characterId: Id, characterName: z.string().max(200).default('') })),
});
export type OccurrenceAttendance = z.infer<typeof OccurrenceAttendance>;

// Fog-of-war visibility helpers shared by server redaction and the web VTT (issue #465).
export * from './fog-visibility';
export * from './fog-editor';

// Schedule temporal windows (issue #818) — shared by server next-session logic and the web UI.
export * from './scheduleWindow';

// Schedule notification metadata + locale-aware copy (issue #820).
export * from './scheduleNotifications';

// User time-of-day rendering preference (issue #634).
export * from './timeFormat';

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
  // CREATE omits default to DM-only (issue #754).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;
// Create: optional `hidden` without Zod default — see QuestCreate (#754).
export const TimelineEventCreate = TimelineEvent.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true })
  .partial()
  .required({ title: true })
  .extend({ hidden: z.boolean().optional() });
export type TimelineEventCreate = z.infer<typeof TimelineEventCreate>;
export const TimelineEventUpdate = TimelineEventCreate.partial();
export type TimelineEventUpdate = z.infer<typeof TimelineEventUpdate>;

/** Default page size for timeline list endpoints (issue #615). */
export const TIMELINE_LIST_DEFAULT_LIMIT = 50;
/** Hard cap for `?limit=` on timeline lists — clients page with `cursor`, not a huge page. */
export const TIMELINE_LIST_MAX_LIMIT = 200;

/**
 * Paginated timeline list response (issue #615).
 *
 * Replaces the historical bare `TimelineEvent[]`. Ordered by DM-controlled
 * `sortIndex` (ascending), then `id`. Continue with `nextCursor` when `hasMore`.
 */
export const TimelineListPage = CursorListPage(TimelineEvent);
export type TimelineListPage = z.infer<typeof TimelineListPage>;

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

// ---------- catch-up (#549) ----------
// Per-user, per-campaign "since you were last here" diff for returning players.
// `since` is the reference instant used for this response; `lastCaughtUpAt` is the
// stored cursor (null when never marked caught up). Each group carries a `kind` so
// the UI can distinguish new-to-you, edited, and resolved-since-last-visit items.
// All entity payloads reuse existing list shapes and inherit role redaction/hidden
// filtering from their source services — nothing here widens visibility.
export const CatchUpChangeKind = z.enum(['new', 'changed', 'resolved']);
export type CatchUpChangeKind = z.infer<typeof CatchUpChangeKind>;

export const CatchUpQuestItem = z.object({
  kind: CatchUpChangeKind,
  quest: Quest,
});
export type CatchUpQuestItem = z.infer<typeof CatchUpQuestItem>;

export const CatchUpSessionItem = z.object({
  kind: CatchUpChangeKind,
  session: SessionListItem,
});
export type CatchUpSessionItem = z.infer<typeof CatchUpSessionItem>;

export const CatchUpTimelineItem = z.object({
  kind: CatchUpChangeKind,
  event: TimelineEvent,
});
export type CatchUpTimelineItem = z.infer<typeof CatchUpTimelineItem>;

export const CatchUpScheduleItem = z.object({
  kind: CatchUpChangeKind,
  schedule: ScheduledSessionWithRsvps,
});
export type CatchUpScheduleItem = z.infer<typeof CatchUpScheduleItem>;

export const CampaignCatchUp = z.object({
  since: IsoDate.nullable(),
  lastCaughtUpAt: IsoDate.nullable(),
  quests: z.array(CatchUpQuestItem),
  sessions: z.array(CatchUpSessionItem),
  timeline: z.array(CatchUpTimelineItem),
  schedules: z.array(CatchUpScheduleItem),
  totalCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type CampaignCatchUp = z.infer<typeof CampaignCatchUp>;

export const CatchUpMark = z.object({
  at: IsoDate.optional(),
});
export type CatchUpMark = z.infer<typeof CatchUpMark>;

export const CatchUpCursor = z.object({
  lastCaughtUpAt: IsoDate.nullable(),
});
export type CatchUpCursor = z.infer<typeof CatchUpCursor>;

/** Classify a catch-up row relative to the reference instant. */
export function catchUpChangeKind(
  createdAt: string,
  _updatedAt: string,
  since: string,
  resolved = false,
): CatchUpChangeKind {
  if (resolved) return 'resolved';
  if (createdAt >= since) return 'new';
  return 'changed';
}

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

// ---------- session-zero consent lifecycle (issue #600) ----------
//
// The problem this solves: the invite preview showed a campaign NAME and a role, join
// created a membership immediately, and the charter was ONE MUTABLE ROW a DM could
// rewrite under everybody's feet. So a participant could not see the table's boundaries
// before committing to it, and once inside there was no record of what they had actually
// agreed to — the row they consented to no longer existed.
//
// The backbone is therefore IMMUTABLE VERSIONS. `session_zero` remains the DM's working
// DRAFT; publishing snapshots it into a `session_zero_charter_versions` row that is never
// updated afterwards. An acknowledgment points at one specific version id, which is the
// only way "renewed consent after a material change" can be expressed at all: without a
// stable target, "they agreed" has no referent.

/**
 * How a participant answered ONE charter version.
 *
 * `discuss` is deliberately its own state rather than a flavour of decline. A participant
 * who wants to talk about a line before agreeing is not refusing, and collapsing the two
 * would either overstate their objection or silently count them as consenting. Both
 * `discuss` and `declined` block the consent gate; only `acknowledged` clears it.
 */
export const CharterAcknowledgmentState = z.enum(['acknowledged', 'discuss', 'declined']);
export type CharterAcknowledgmentState = z.infer<typeof CharterAcknowledgmentState>;

/** How much of the charter a not-yet-member sees at the invite link. */
export const CharterPreviewPolicy = z.enum(['boundaries', 'full']);
export type CharterPreviewPolicy = z.infer<typeof CharterPreviewPolicy>;

/**
 * One immutable published charter version.
 *
 * Nothing here is ever UPDATEd after insert. A "change" is always a new row with the
 * next `version` number, which is what lets an acknowledgment name exactly what was
 * agreed to and lets the diff between two versions be reconstructed years later.
 */
export const SessionZeroCharterVersion = z.object({
  id: Id,
  campaignId: Id,
  /** 1-based, per campaign, gapless. */
  version: z.number().int().positive(),
  lines: z.array(z.string().min(1).max(500)).max(200).default([]),
  veils: z.array(z.string().min(1).max(500)).max(200).default([]),
  safetyTools: z.array(z.string().min(1).max(200)).max(50).default([]),
  houseRules: z.string().max(20_000).default(''),
  toneAndExpectations: z.string().max(20_000).default(''),
  /**
   * Whether this version WITHDREW a protection relative to its predecessor — see
   * `isMaterialCharterChange`. Frozen at publish time rather than recomputed on read:
   * the consent gate depends on it, and a gate whose answer can change retroactively
   * because somebody edited the comparison rule is not a gate.
   */
  material: z.boolean().default(false),
  /** DM's own note on what changed and why. Shown alongside the diff. */
  changeSummary: z.string().max(2000).default(''),
  publishedBy: z.string().max(120).default(''),
  publishedAt: IsoDate,
});
export type SessionZeroCharterVersion = z.infer<typeof SessionZeroCharterVersion>;

export const SessionZeroCharterPublish = z
  .object({ changeSummary: z.string().max(2000).default('') })
  .strict();
export type SessionZeroCharterPublish = z.infer<typeof SessionZeroCharterPublish>;

/**
 * The field-level difference between two versions.
 *
 * `removed*` are the entries that make a change MATERIAL — a protection the table had
 * and no longer has. `added*` are recorded for the reader but never invalidate consent:
 * a version that only adds a line is strictly more protective than the one somebody
 * already agreed to, and forcing re-acknowledgment for it would train participants to
 * click through safety prompts.
 */
export const CharterVersionDiff = z.object({
  fromVersion: z.number().int().nonnegative(),
  toVersion: z.number().int().positive(),
  material: z.boolean(),
  addedLines: z.array(z.string()).default([]),
  removedLines: z.array(z.string()).default([]),
  addedVeils: z.array(z.string()).default([]),
  removedVeils: z.array(z.string()).default([]),
  addedSafetyTools: z.array(z.string()).default([]),
  removedSafetyTools: z.array(z.string()).default([]),
  houseRulesChanged: z.boolean().default(false),
  toneChanged: z.boolean().default(false),
});
export type CharterVersionDiff = z.infer<typeof CharterVersionDiff>;

export const SessionZeroAcknowledgment = z.object({
  id: Id,
  campaignId: Id,
  versionId: Id,
  version: z.number().int().positive(),
  userId: z.string().min(1).max(120),
  userName: z.string().max(120).default(''),
  state: CharterAcknowledgmentState,
  /** Participant's own words — required for `discuss`/`declined`, so an objection is legible. */
  note: z.string().max(2000).default(''),
  ...timestamps,
});
export type SessionZeroAcknowledgment = z.infer<typeof SessionZeroAcknowledgment>;

export const SessionZeroAcknowledgmentInput = z
  .object({
    versionId: Id,
    state: CharterAcknowledgmentState,
    note: z.string().max(2000).default(''),
  })
  .strict();
export type SessionZeroAcknowledgmentInput = z.infer<typeof SessionZeroAcknowledgmentInput>;

/**
 * Whether this campaign's consent gate is currently satisfied, and by which version.
 *
 * `effectiveVersion` is what the AI is bound by and what "play" is licensed against. It
 * is NOT simply the newest version: a newly published version that withdrew a protection
 * does not take effect until everyone who must acknowledge it has. Until then the table
 * — and the model — keep operating under the last version everybody actually agreed to,
 * which is the only reading of "renewed acknowledgment before live AI or play" that is
 * safe in the direction that matters.
 */
export const SessionZeroConsentStatus = z.object({
  campaignId: Id,
  /** Newest published version, acknowledged or not. Null before the first publish. */
  latestVersion: SessionZeroCharterVersion.nullable().default(null),
  /** The newest version whose consent gate is satisfied. Null before anyone acknowledges. */
  effectiveVersion: SessionZeroCharterVersion.nullable().default(null),
  /** True when latest !== effective because a material version is awaiting acknowledgment. */
  awaitingRenewal: z.boolean().default(false),
  /**
   * Members who must still answer the latest version for the gate to clear.
   * Empty when the strict all-members gate is already satisfied — including when a
   * non-material addition "rode along" and became effective without a fresh answer.
   */
  outstanding: z
    .array(z.object({ userId: z.string(), userName: z.string().default(''), state: CharterAcknowledgmentState.nullable() }))
    .default([]),
  /** The caller's own answer to the latest version, if any. */
  mine: SessionZeroAcknowledgment.nullable().default(null),
  /** Diff from the effective version to the latest, when they differ. */
  diff: CharterVersionDiff.nullable().default(null),
});
export type SessionZeroConsentStatus = z.infer<typeof SessionZeroConsentStatus>;

/**
 * A private boundary a participant sends to the FACILITATOR only.
 *
 * The public charter is negotiated out loud; this is the channel for the line somebody
 * cannot say in front of the group. It is never readable by other participants, never
 * exported, and never sent to a model. `anonymous` additionally withholds the submitter
 * from the facilitator — the DM sees the boundary and can honour it without learning
 * whose it is.
 */
export const SessionZeroBoundarySubmission = z.object({
  id: Id,
  campaignId: Id,
  kind: z.enum(['line', 'veil']),
  text: z.string().min(1).max(500),
  anonymous: z.boolean().default(false),
  /** '' whenever `anonymous` — the server drops it on the way out, it is not merely hidden. */
  submitterUserId: z.string().max(120).default(''),
  submitterName: z.string().max(120).default(''),
  /** True only for the submitter's own rows, so a participant can find and withdraw theirs. */
  mine: z.boolean().default(false),
  ...timestamps,
});
export type SessionZeroBoundarySubmission = z.infer<typeof SessionZeroBoundarySubmission>;

export const SessionZeroBoundarySubmissionCreate = z
  .object({
    kind: z.enum(['line', 'veil']),
    text: z.string().trim().min(1).max(500),
    anonymous: z.boolean().default(false),
  })
  .strict();
export type SessionZeroBoundarySubmissionCreate = z.infer<typeof SessionZeroBoundarySubmissionCreate>;

/**
 * Guardian consent — WITHOUT collecting a date of birth, ever.
 *
 * The issue asks for a guardian flow that does not collect exact birth dates, and the
 * tempting shortcut is to take a date and derive an age from it. That stores precisely
 * the identifier being avoided, and storing it is the harm — deriving a boolean from it
 * afterwards does not un-store it. So the model carries a single ATTESTATION boolean
 * plus guardian contact details, and there is no column, field, or request key anywhere
 * in this flow that holds a date, an age, or a year. `session-zero-consent.spec.ts`
 * asserts that against the live table definition rather than trusting this comment.
 */
export const GuardianConsentStatus = z.enum(['pending', 'granted', 'declined', 'withdrawn']);
export type GuardianConsentStatus = z.infer<typeof GuardianConsentStatus>;

export const SessionZeroGuardianConsent = z.object({
  id: Id,
  campaignId: Id,
  /** The participant the guardian is answering for. */
  userId: z.string().min(1).max(120),
  userName: z.string().max(120).default(''),
  /** The charter version the guardian was shown and is answering about. */
  versionId: Id,
  version: z.number().int().positive(),
  guardianName: z.string().max(120).default(''),
  guardianEmail: z.string().max(200).default(''),
  guardianRelationship: z.string().max(80).default(''),
  status: GuardianConsentStatus,
  decisionNote: z.string().max(2000).default(''),
  decidedAt: IsoDate.nullable().default(null),
  ...timestamps,
});
export type SessionZeroGuardianConsent = z.infer<typeof SessionZeroGuardianConsent>;

/**
 * Requesting guardian consent. `.strict()` is load-bearing rather than stylistic here:
 * it is what makes an integrator's `birthDate`/`dateOfBirth`/`age` field a 400 instead
 * of a silently ignored key that its sender believes was stored.
 */
export const SessionZeroGuardianConsentRequest = z
  .object({
    versionId: Id,
    guardianName: z.string().trim().min(1).max(120),
    guardianEmail: z.string().trim().min(3).max(200),
    guardianRelationship: z.string().trim().max(80).default(''),
    /**
     * The participant is below the age of majority where they live. A single boolean,
     * asserted by the person requesting the flow — deliberately not a threshold, a
     * jurisdiction, or anything from which a birth date could be reconstructed.
     */
    minorAttested: z.literal(true),
  })
  .strict();
export type SessionZeroGuardianConsentRequest = z.infer<typeof SessionZeroGuardianConsentRequest>;

export const SessionZeroGuardianConsentDecision = z
  .object({
    status: z.enum(['granted', 'declined', 'withdrawn']),
    note: z.string().max(2000).default(''),
  })
  .strict();
export type SessionZeroGuardianConsentDecision = z.infer<typeof SessionZeroGuardianConsentDecision>;

/**
 * The charter as shown to somebody who has NOT joined — the privacy-critical projection.
 *
 * This is served to an unauthenticated caller holding an invite code, so it is built the
 * same way as the #587 admin catalog: an enumerated allowlist, never "the charter minus
 * a few fields". It carries the safety boundaries a person needs in order to decline
 * meaningfully and NOTHING else — no member names or counts, no private boundary
 * submissions, no campaign description, no quests/notes/sessions, and never the DM's
 * unpublished draft. Only a published version is ever previewable.
 */
export const CharterPreview = z.object({
  version: z.number().int().positive(),
  lines: z.array(z.string()).default([]),
  veils: z.array(z.string()).default([]),
  safetyTools: z.array(z.string()).default([]),
  /** Present only under the `full` preview policy; '' otherwise. */
  houseRules: z.string().default(''),
  toneAndExpectations: z.string().default(''),
  /** Whether the DM chose to disclose the prose fields as well as the boundaries. */
  previewPolicy: CharterPreviewPolicy,
  /** The campaign's external-AI content policy, so "is a model reading my words" is answerable pre-join. */
  aiExternalContentPolicy: AiExternalContentPolicy,
  publishedAt: IsoDate,
});
export type CharterPreview = z.infer<typeof CharterPreview>;

/** Body for POST /invites/:code/join — the version the joiner agrees to (issue #600). */
export const InviteJoin = z.object({ acknowledgeVersion: z.number().int().positive().optional() }).strict();
export type InviteJoin = z.infer<typeof InviteJoin>;

/** Body for POST /invites/:code/decline — a recorded refusal, not just a closed tab. */
export const InviteDecline = z.object({ note: z.string().max(2000).default('') }).strict();
export type InviteDecline = z.infer<typeof InviteDecline>;

export const SessionZeroPreviewPolicyUpdate = z
  .object({ previewPolicy: CharterPreviewPolicy })
  .strict();
export type SessionZeroPreviewPolicyUpdate = z.infer<typeof SessionZeroPreviewPolicyUpdate>;

// ---------- table safety hold / X-Card (issue #599) ----------
//
// Session zero (above) records the safety tools a table AGREED to use as free text.
// This is the tool itself: one immediate, unilateral, reason-free stop that any member
// of the campaign can pull mid-play, freezing encounter advancement and the AI seat's
// input, output, and tool dispatch until a facilitator recovers the table.
//
// THREE PROPERTIES ARE LOAD-BEARING AND EVERYTHING ELSE BENDS AROUND THEM.
//
//  1. NO GATE ON ACTIVATION. No vote, no reason field, no minimum role. `requireMember`
//     is the only check — a viewer at the table can stop play exactly like a player can.
//     A mechanism that asks you to justify yourself has already failed at the moment it
//     matters, which is why there is no `reason` on the activation request: the note
//     field lives on the facilitator's RELEASE, where a human is explaining a recovery
//     rather than a participant explaining a need.
//
//  2. IDEMPOTENT, NEVER-FAILING ACTIVATION. Activating a hold that is already active
//     succeeds and changes nothing (the FIRST activation's timestamp is what the table
//     keeps). Two participants tapping at once both get 200 and the table pauses once.
//     Pausing twice is harmless; a state machine that can reject a pause is not.
//
//  3. ASYMMETRIC RECOVERY. Anyone pauses; only a facilitator (`dm`) releases. That
//     asymmetry — not a role check on activation — is what makes the mechanism safe to
//     leave unguarded.
//
// ANONYMITY. `anonymous` (default TRUE) suppresses attribution: the server stores no
// user id and no display name for the activation, writes the audit row under a synthetic
// actor with the request correlation id stripped, and notifies EVERY member including
// the activator. See the note on TableSafetyHold.activatedByName for the residual
// exposure this does NOT close.
export const SafetyHoldRecovery = z.enum([
  'resume',       // pick play back up where it stopped
  'rewind',       // undo the last beat and replay it differently
  'veil',         // the content stays in the fiction but moves off-screen
  'scene_change', // cut away to a different scene
  'end',          // stop the session here
]);
export type SafetyHoldRecovery = z.infer<typeof SafetyHoldRecovery>;

/**
 * The table's current safety-hold state — one row per campaign, readable by every member.
 *
 * A released hold keeps its `releasedAt` / `recovery` / `facilitatorNote` so the table can
 * see how the last stop was resolved; `active: false` is what ungates play.
 */
export const TableSafetyHold = z.object({
  campaignId: Id,
  /** True while play is frozen. The single field every gate reads. */
  active: z.boolean(),
  /** When the CURRENT hold was raised (first activation wins; re-activation does not move it). */
  activatedAt: IsoDate.nullable(),
  /**
   * Display name of the participant who raised it, or null.
   *
   * NULL IS DELIBERATELY AMBIGUOUS — it means "anonymous" and it means "no hold", and no
   * API distinguishes them. There is no companion `activatedByUserId` on this contract or
   * in the database for an anonymous hold: the identity is dropped at the controller
   * boundary and never reaches storage, so there is no projection to forget to redact.
   *
   * WHAT THIS DOES NOT HIDE, stated plainly because "anonymous" must not overclaim:
   *  - The server operator. Reverse proxy access logs, the structured request log (which
   *    carries the authenticated actor), and a debugger all see the HTTP request. Anonymity
   *    here is anonymity from the TABLE, not from whoever runs the box.
   *  - Deduction from table size. At a two-person table an anonymous hold the facilitator
   *    did not raise was raised by the other person. No server-side design fixes that.
   *  - A participant who tells the table it was them.
   */
  activatedByName: z.string().nullable(),
  /** Whether the CURRENT (or most recent) hold was raised anonymously. */
  anonymous: z.boolean(),
  /**
   * How many holds this campaign has recorded, ever. A count is not attributable and is
   * what makes "we keep stopping in this arc" visible without naming anyone.
   */
  activationCount: z.number().int().nonnegative(),
  releasedAt: IsoDate.nullable(),
  /** The facilitator who released it — release is never anonymous; it is an accountable act. */
  releasedByName: z.string().nullable(),
  /** How the facilitator recovered the table, or null while a hold is active. */
  recovery: SafetyHoldRecovery.nullable(),
  /** The facilitator's optional note on the recovery. Never the participant's words. */
  facilitatorNote: z.string().nullable(),
  updatedAt: IsoDate,
});
export type TableSafetyHold = z.infer<typeof TableSafetyHold>;

/**
 * POST /campaigns/:id/safety/hold. Note what is NOT here: no reason, no severity, no
 * target, no role. The only decision the activating participant makes is whether to
 * attach their name, and the default is that they do not have to.
 */
export const TableSafetyHoldActivate = z
  .object({
    anonymous: z.boolean().default(true),
  })
  // `.strict()` is load-bearing, not hygiene: it means a client cannot smuggle a `reason` past
  // this endpoint, so no UI can grow a "why did you stop us?" prompt against it by accident.
  .strict();
export type TableSafetyHoldActivate = z.infer<typeof TableSafetyHoldActivate>;

/** POST /campaigns/:id/safety/release — facilitator only. */
export const TableSafetyHoldRelease = z.object({
  recovery: SafetyHoldRecovery,
  /** The facilitator's own note about the recovery (audited, shown to the table). */
  note: z.string().max(500).optional(),
  /**
   * Only meaningful with `recovery: 'veil'` — appended to the session-zero charter's veils
   * so a stop that produced a new soft limit actually changes what the table (and the AI,
   * which reads the same charter) plays going forward, instead of being a banner nobody
   * revisits.
   */
  veil: z.string().min(1).max(500).optional(),
}).strict();
export type TableSafetyHoldRelease = z.infer<typeof TableSafetyHoldRelease>;

/** Error code returned (409) by every play-advancement path while a hold is active. */
export const TABLE_SAFETY_HOLD_ERROR_CODE = 'TABLE_SAFETY_HOLD';

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
// Issue #1784 re-examined whether "notes" is one overloaded concept across the app.
// It isn't — `Character.notes` (public bio prose) and the `dmSecret` fields on canon
// entities (a DM-only secret paired with the SAME entity, e.g. `Session.dmSecret` =
// session-prep notes) are unrelated data; they just share a field name with the
// system below. `Note`/`NoteKind`/`NoteVisibility` are the actual "notes" system: a
// standalone row a member writes, with its own visibility. `comments` (see Comment
// below) is a third, separate thing again — always-shared discussion anchored to an
// entity, no per-comment visibility. See `design/notes-concept-decision.md` for the
// full inventory, file:line citations, and why each stays as its own thing.
//
// Within THIS system, `kind` draws the one real remaining seam: `kind: 'note'` is a
// member's own recall/sharing (any of the 4 visibilities); `kind: 'inbox'` is always a
// fixed `dm_shared` triage submission awaiting DM resolution (`resolved`/`resolvedNote`,
// meaningless on a `kind: 'note'` row). REST/MCP already surface the two as first-class,
// separately-routed operations (`/notes` vs `/inbox`, `list_notes` vs `read_inbox` /
// `submit_inbox_item`) — only storage shares one table, and the decision record is why.
//
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

/**
 * Inbox sweep (issue #1644) — server-side orchestration that reads a campaign's OPEN
 * scribe-inbox captures, infers create/update/dismiss, and files PENDING PROPOSALS ONLY
 * (never a direct canon write). Entity types are deliberately the four bootstrapped by
 * `get_campaign_summary`/`CampaignsService.summary` — objective ticks, HP, and combat
 * writes are explicitly unsupported and always skip with a stated reason.
 */
export const InboxSweepEntityType = z.enum(['quest', 'npc', 'location', 'character']);
export type InboxSweepEntityType = z.infer<typeof InboxSweepEntityType>;

/** Per-item outcome (issue #1644) — must survive to the caller, never just logged. */
export const InboxSweepOutcome = z.enum(['proposed', 'skipped', 'errored']);
export type InboxSweepOutcome = z.infer<typeof InboxSweepOutcome>;

export const InboxSweepItemResult = z.object({
  noteId: Id,
  outcome: InboxSweepOutcome,
  entityType: InboxSweepEntityType.nullable(),
  entityId: Id.nullable(),
  proposalId: Id.nullable(),
  reason: z.string().min(1),
  body: z.string().optional(),
});
export type InboxSweepItemResult = z.infer<typeof InboxSweepItemResult>;

/** `disabled` = no AI provider configured for the campaign (campaign or server default). */
export const InboxSweepJobStatus = z.enum(['succeeded', 'disabled', 'running', 'failed']);
export type InboxSweepJobStatus = z.infer<typeof InboxSweepJobStatus>;

export const InboxSweepJob = z.object({
  id: Id,
  campaignId: Id,
  status: InboxSweepJobStatus,
  // Total per-outcome counts for this job, INCLUDING items recovered from an earlier,
  // already-acknowledged sweep's ledger row (see `itemsNewly*` below).
  itemsTotal: z.number().int().nonnegative(),
  itemsProposed: z.number().int().nonnegative(),
  itemsSkipped: z.number().int().nonnegative(),
  itemsErrored: z.number().int().nonnegative(),
  // Issue #1717: `itemsProposed`/`itemsSkipped`/`itemsErrored` above conflate two very
  // different things — an outcome decided freshly by THIS sweep, and a ledger row
  // recovered from an earlier, already-acknowledged run (the crash-recovery path: a
  // terminal ledger row was written but the inbox item never got resolved). A client
  // driving a "bump the badge by N" UI off the total double-counts every recovered row.
  // These `itemsNewly*` counts exclude recovered rows — optional (rather than always
  // required) so older persisted job rows / mocked responses without this breakdown still
  // validate; a client should fall back to the corresponding total when a `itemsNewly*`
  // field is absent.
  itemsNewlyProposed: z.number().int().nonnegative().optional(),
  itemsNewlySkipped: z.number().int().nonnegative().optional(),
  itemsNewlyErrored: z.number().int().nonnegative().optional(),
  detail: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type InboxSweepJob = z.infer<typeof InboxSweepJob>;

export const InboxSweepResult = z.object({
  job: InboxSweepJob,
  items: z.array(InboxSweepItemResult),
});
export type InboxSweepResult = z.infer<typeof InboxSweepResult>;

/** Default page size for notes + inbox list endpoints (issue #608). */
export const NOTES_LIST_DEFAULT_LIMIT = 50;
/** Hard cap for `?limit=` on notes/inbox lists — clients page with `cursor`, not a huge page. */
export const NOTES_LIST_MAX_LIMIT = 200;
/** Dashboard NotesQuickRail asks for exactly this many newest notes (issue #608). */
export const NOTES_RECENT_LIMIT = 5;

/**
 * Paginated notes / inbox list response (issue #608).
 *
 * Replaces the historical bare `Note[]` (unbounded when `limit` was omitted).
 * Always includes `total` + `hasMore` so clients never silently truncate; continue
 * with `nextCursor` when `hasMore` is true. Order is newest-first.
 *
 * `nextCursor` is ALWAYS present and is `null` on the terminal page (not omitted), so
 * REST/MCP consumers see a stable, observable shape rather than a disappearing field.
 */
export const NoteListPage = z.object({
  items: z.array(Note),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().max(512).nullable(),
  limit: z.number().int().positive(),
});
export type NoteListPage = z.infer<typeof NoteListPage>;

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
export const RevisionEntityType = z.enum([
  'session',
  'quest',
  'npc',
  'location',
  'faction',
  'note',
  'timeline_event',
  'timeline_calendar',
  'scheduled_session',
  'session_zero',
  'comment',
  'story_beat',
  'campaign_library_monster',
]);
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
  // Moderation quarantine (issue #601). null = normal; an ISO timestamp means a DM
  // has withheld this comment's body pending review — `body` reads back as a neutral
  // placeholder for EVERY caller, including the author and the DM who quarantined it.
  // Distinct from `deletedAt` on purpose: a tombstone is a lifecycle act by the author
  // or a DM and reads as "[deleted]"; a quarantine is a moderation act tied to an open
  // report and reads as "[withheld pending moderation review]". Surfacing the flag is
  // deliberate — a reader who sees a placeholder deserves to know which one it is, and
  // the original prose lives on only in the (separately gated) evidence snapshot.
  quarantinedAt: IsoDate.nullable().default(null),
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
  quarantinedAt: true,
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

/** Default page size for discussion root-thread lists (issue #609). */
export const COMMENTS_THREAD_DEFAULT_LIMIT = 20;
/** Hard cap for `?limit=` on root-thread pages. */
export const COMMENTS_THREAD_MAX_LIMIT = 100;
/** How many replies to inline-preview per root on the first page (issue #609). */
export const COMMENTS_REPLY_PREVIEW_LIMIT = 3;
/** Hard cap for `?limit=` when loading additional replies for one root. */
export const COMMENTS_REPLY_MAX_LIMIT = 50;

/**
 * One discussion root with a bounded reply preview (issue #609). Pagination is by
 * root thread — flat row paging cannot split a root from its replies. When
 * `replyHasMore` is true, continue with `replyNextCursor` on the replies endpoint.
 */
export const CommentThread = z.object({
  root: Comment,
  replies: z.array(Comment),
  replyCount: z.number().int().nonnegative(),
  replyHasMore: z.boolean(),
  replyNextCursor: z.string().max(512).nullable(),
});
export type CommentThread = z.infer<typeof CommentThread>;

/**
 * Paginated discussion list for one anchored entity (issue #609). `total` is the
 * root-thread count; `totalComments` includes every reply. Order is oldest-first
 * (root id asc) so the thread reads naturally top-to-bottom.
 */
export const CommentThreadPage = z.object({
  items: z.array(CommentThread),
  total: z.number().int().nonnegative(),
  totalComments: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().max(512).nullable(),
  limit: z.number().int().positive(),
});
export type CommentThreadPage = z.infer<typeof CommentThreadPage>;

/** Additional replies for one root thread (issue #609). */
export const CommentReplyPage = z.object({
  rootId: Id,
  items: z.array(Comment),
  replyCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().max(512).nullable(),
  limit: z.number().int().positive(),
});
export type CommentReplyPage = z.infer<typeof CommentReplyPage>;

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
  // Issue #1640: membership REVOKED (removed, or left) — as opposed to `added_to_campaign`,
  // which also covers a role change on a membership you still hold. A different type because
  // the client reaction differs: a role change re-renders chrome in place, a revocation must
  // move the user off any page scoped to that campaign (see MEMBERSHIP_NOTIFICATION_TYPES).
  'removed_from_campaign',
  // Issue #1707: the CAMPAIGN itself was trashed (not one member's role or seat) — the sibling
  // gap #1653/#1640 didn't reach. `removed_from_campaign` fires per-user; this fires once for
  // every member (via notifyCampaign), because trash removes everyone's access at once, not
  // one member's. Its own type rather than reusing `removed_from_campaign` for the same reason
  // that one has its own type rather than reusing `added_to_campaign`: the client already
  // branches on `NotificationType` for icon/copy/routing (see NotificationsBell.tsx,
  // entityLinks.ts), and "your campaign was deleted" is a different fact from "you personally
  // were removed" even though both end at the same redirect. See MEMBERSHIP_NOTIFICATION_TYPES
  // for why it still drives the same `membershipChanged` discriminator.
  'campaign_trashed',
  // Issue #819: exclusive character seat transferred away from (or onto) this member.
  'character_reassigned',
  'session_scheduled',
  'session_rsvp',
  // Issue #789: deduplicated pre-session reminder and the optional unanswered-RSVP
  // nudge. Both belong to the `schedule` notification category (see notificationCategory).
  'session_reminder',
  'rsvp_nudge',
  'quest_updated',
  'proposal_submitted',
  'proposal_resolved',
  // Issue #832: a player (or any member) posted to the DM scribe inbox.
  'inbox_submitted',
  // The driver AI-DM got stuck / a recovery lever was pulled (issue #314): AI errored/looped,
  // budget exhausted, a ruling was disputed, a table vote resolved, or a human took the seat.
  'ai_dm_alert',
  // A new session-zero charter version was published (issue #600). Sent to the whole
  // table, and deliberately NOT muteable into silence when the change was material: a
  // version that withdrew a protection is the one notification a participant most needs,
  // because play and live AI are gated on their answer to it (see notificationCategory).
  'charter_published',
  // Issue #599: a table safety hold (X-Card) was raised or resolved. Its own type rather than
  // a reuse of ai_dm_alert because it fires on tables with no AI seat at all, and because
  // "AI DM Alert" is the wrong thing to show someone whose table just stopped for safety.
  // Maps to the always-on `security` category below: a safety stop must not be mutable by a
  // notification preference or deferrable into a digest.
  // Live play events (issue #1322)
  'encounter_started',
  'encounter_ended',
  'encounter_turn',
  'character_downed',
  'safety_hold',
]);
export type NotificationType = z.infer<typeof NotificationType>;

/**
 * Notification types that mean "your membership or role somewhere changed", as opposed to
 * ordinary table activity (issue #1590). The single canonical list, so the server-side
 * `unreadCount` query and the client-side account-wide /me refresh it drives agree on exactly
 * what counts — a type added here without updating a hand-maintained duplicate elsewhere is
 * the failure mode this constant exists to rule out.
 *
 * `added_to_campaign` already covers being added, promoted (including the admin
 * `reassign_owner` path, #1546), and — after #1590 — a DM's own promote/demote of an existing
 * member (issue #437's `members.service.ts#update`). It is reused rather than split into a
 * separate "role changed" type because both describe the same fact a client needs to react to:
 * re-fetch `/me`, the memberships list may be stale.
 *
 * `removed_from_campaign` (issue #1640) is deliberately its OWN type rather than folded into
 * `added_to_campaign` too: a role change leaves the membership in place (re-render chrome from
 * fresh `/me` data, stay put), but a revocation removes it entirely — a client sitting on a
 * route scoped to that campaign must navigate away, not just re-render. Both still belong in
 * this same list because the account-wide `membershipChanged` discriminator below only needs
 * to answer "is `/me` possibly stale", not which of the two happened.
 *
 * `campaign_trashed` (issue #1707) belongs here for the same reason `removed_from_campaign`
 * does: `/me`'s memberships list already excludes trashed campaigns (`auth.service.ts`'s
 * `isNull(campaigns.deletedAt)` join), so trashing a campaign makes `/me` stale for every one
 * of its members at once, not just the actor who trashed it.
 */
export const MEMBERSHIP_NOTIFICATION_TYPES = [
  'added_to_campaign',
  'removed_from_campaign',
  'campaign_trashed',
] as const satisfies readonly NotificationType[];

/**
 * Notification types that must stay visible/actionable even after their `campaignId` is
 * trashed (issue #1707). Every notification READ path (`listForUser`, `unreadSummary`,
 * `markRead`, `markUnread`, `markReadBulk`, `markUnreadBulk` — see notifications.service.ts)
 * joins against `campaigns` and drops rows whose campaign is trashed, so old activity about a
 * now-dead campaign (a stale `recap_posted`, say) doesn't clutter the bell with dead links.
 * That rule is correct for ordinary activity, but `campaign_trashed` IS the announcement that
 * the campaign just died — hiding it the instant it's written (which happens after the SAME
 * request stamps `deletedAt`, so by the time anyone polls, the campaign is already trashed)
 * would silently defeat the exact backstop this type exists to drive: the account-wide
 * `membershipChanged` poll would never see it, and a row nobody can ever list or mark read
 * would inflate the unread badge forever with no way to clear it. A single canonical list
 * (mirroring MEMBERSHIP_NOTIFICATION_TYPES's own reasoning) so a query added later doesn't
 * silently reintroduce the hidden-forever failure mode at one call site while the others stay
 * fixed.
 */
export const CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES = [
  'campaign_trashed',
] as const satisfies readonly NotificationType[];

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

export const NotificationUnreadCount = z.object({
  count: z.number().int().nonnegative(),
  /**
   * Issue #1590 — true when at least one UNREAD notification is membership-shaped (see
   * {@link MEMBERSHIP_NOTIFICATION_TYPES}). Computed from the same user-scoped row set
   * `count` already reads — this endpoint has never returned anyone's notifications but the
   * caller's own, so the flag discloses nothing the caller could not already learn by paging
   * `GET /notifications` themselves. It exists so a poller that already runs account-wide
   * (mounted once per authenticated session, not per campaign) has something to discriminate
   * on: today `unread-count` is a bare number, and nothing distinguishes "a recap posted" from
   * "your role changed and cached /me is now wrong".
   */
  membershipChanged: z.boolean(),
});
export type NotificationUnreadCount = z.infer<typeof NotificationUnreadCount>;

// ---------- notification preferences (issue #789) ----------
// Per-user, per-campaign control over which notification CATEGORIES are delivered
// and how. Every NotificationType maps to exactly one category (see
// notificationCategory below); users tune preferences by category, not by the
// finer-grained type. Preferences are consulted during fan-out
// (NotificationsService.dispatch) BEFORE a row is written — except the ALWAYS-ON
// critical categories (`access`, `security`), which ignore preferences AND quiet
// hours so a member can never silence a security/access notice.

/** Coarse grouping a NotificationType belongs to — the unit users actually tune. */
export const NotificationCategory = z.enum([
  'recaps', // recap_posted, recap_share_enabled, recap_share_extended
  'notes', // note_reply, note_shared
  'comments', // comment_reply
  'schedule', // session_scheduled, session_rsvp, session_reminder, rsvp_nudge
  'quests', // quest_updated
  'proposals', // proposal_submitted, proposal_resolved
  'inbox', // inbox_submitted
  'live_play', // encounter_started, encounter_ended, encounter_turn, character_downed
  'access', // added_to_campaign, removed_from_campaign, campaign_trashed, character_reassigned, charter_published — ALWAYS ON (access control)
  'security', // ai_dm_alert, safety_hold — ALWAYS ON (security/recovery)
]);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

/** How a (non-critical) category is delivered. */
export const NotificationDeliveryMode = z.enum([
  'immediate', // write the row now (subject to quiet hours)
  'digest', // defer; flushed in a batch on the digest cadence
  'muted', // drop entirely
]);
export type NotificationDeliveryMode = z.infer<typeof NotificationDeliveryMode>;

/** Every category value, in display order. */
export const NOTIFICATION_CATEGORIES = NotificationCategory.options;

/**
 * Critical categories are ALWAYS delivered immediately regardless of stored
 * preferences or quiet hours — silencing access-control or security/recovery
 * notices would be a footgun (issue #789). The UI renders these as locked.
 */
export const CRITICAL_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = ['access', 'security'];

export function isCriticalNotificationCategory(category: NotificationCategory): boolean {
  return CRITICAL_NOTIFICATION_CATEGORIES.includes(category);
}

/** Static NotificationType -> NotificationCategory map (single source of truth). */
export const NOTIFICATION_TYPE_CATEGORY: Record<NotificationType, NotificationCategory> = {
  recap_posted: 'recaps',
  recap_share_enabled: 'recaps',
  recap_share_extended: 'recaps',
  note_reply: 'notes',
  note_shared: 'notes',
  comment_reply: 'comments',
  added_to_campaign: 'access',
  removed_from_campaign: 'access',
  campaign_trashed: 'access',
  character_reassigned: 'access',
  session_scheduled: 'schedule',
  session_rsvp: 'schedule',
  session_reminder: 'schedule',
  rsvp_nudge: 'schedule',
  quest_updated: 'quests',
  proposal_submitted: 'proposals',
  proposal_resolved: 'proposals',
  inbox_submitted: 'inbox',
  encounter_started: 'live_play',
  encounter_ended: 'live_play',
  encounter_turn: 'live_play',
  character_downed: 'live_play',
  ai_dm_alert: 'security',
  // 'access' rather than a category of its own, and therefore ALWAYS ON. A published
  // charter version can withdraw a protection the recipient previously agreed to, and
  // their answer to it gates play and live AI for the whole table (issue #600). A
  // notification a participant can mute into silence, or defer into a digest that
  // arrives after the session, would make the consent gate look like an ambush.
  charter_published: 'access',
  safety_hold: 'security',
};

/** Resolve the category a notification type belongs to. */
export function notificationCategory(type: NotificationType): NotificationCategory {
  return NOTIFICATION_TYPE_CATEGORY[type];
}

/** Sensible default mode for a category — everything is `immediate` out of the box. */
export function defaultNotificationMode(_category: NotificationCategory): NotificationDeliveryMode {
  // Critical categories are effectively immediate-and-locked; everything else
  // defaults to immediate so behavior matches the pre-preferences fan-out until a
  // user opts into digest/muted.
  return 'immediate';
}

// Quiet hours are a per-user, per-campaign local-time window during which
// non-critical IMMEDIATE notifications are held (deferred) instead of delivered,
// then flushed once the window passes. Stored as minutes-of-day in the member's
// chosen IANA timezone; the window may wrap past midnight (start > end).
export const QuietHours = z.object({
  enabled: z.boolean().default(false),
  startMinute: z.number().int().min(0).max(1439).default(1320), // 22:00 local
  endMinute: z.number().int().min(0).max(1439).default(420), // 07:00 local
  timezone: z.string().min(1).max(64).default('UTC'), // IANA tz id
});
export type QuietHours = z.infer<typeof QuietHours>;

/** Fully-resolved preferences for a single campaign (defaults filled in). */
export const NotificationCampaignPreferences = z.object({
  campaignId: Id,
  campaignName: z.string().default(''),
  // one mode per category (critical categories always report 'immediate')
  categories: z.record(NotificationCategory, NotificationDeliveryMode),
  quietHours: QuietHours,
});
export type NotificationCampaignPreferences = z.infer<typeof NotificationCampaignPreferences>;

/** GET /notifications/preferences — one entry per campaign the caller belongs to. */
export const NotificationPreferences = z.object({
  campaigns: z.array(NotificationCampaignPreferences),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

/**
 * PUT /notifications/preferences/:campaignId body. Additive/partial: only the
 * provided categories/quiet-hours fields are changed. Attempts to set a critical
 * category to anything other than 'immediate' are ignored server-side.
 */
export const NotificationPreferencesUpdate = z.object({
  categories: z.record(NotificationCategory, NotificationDeliveryMode).optional(),
  quietHours: QuietHours.partial().optional(),
});
export type NotificationPreferencesUpdate = z.infer<typeof NotificationPreferencesUpdate>;

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
  sourceUrl: z.string().max(500).refine((url) => !url || /^https?:\/\//i.test(url), 'Source URL must be http(s)').default(''),
  installedAt: IsoDate,
  entryCount: z.number().int().nonnegative().default(0),
  // Authoritative, server-wide count of campaigns whose `ruleSystem` == this pack's slug
  // (issue #385). Populated by GET /rules/packs; the uninstall-safety gate reads THIS, not a
  // client-side count of only the caller's visible campaigns. Optional so other RulePack
  // producers (e.g. an install response) needn't compute it.
  usageCount: z.number().int().nonnegative().optional(),
});
export type RulePack = z.infer<typeof RulePack>;

export const RuleEntryType = z.enum(['spell', 'monster', 'hazard', 'item', 'class', 'race', 'feat', 'condition', 'section', 'other']);
export type RuleEntryType = z.infer<typeof RuleEntryType>;

export const RuleEntry = z.object({
  id: Id,
  packId: Id,
  campaignId: Id.nullable().optional(),
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
  sourceUrl: z.string().max(500).refine((url) => !url || /^https?:\/\//i.test(url), 'Source URL must be http(s)').default(''),
  // Optional manual icon override (issue #305): the slug of a bundled game-icons.net
  // entity icon (see apps/web/src/lib/icons) shown in the compendium list + reader in
  // place of the type/school-derived default. '' means "no override — the web app
  // derives a sensible default from `type` + `dataJson` (spell school, monster type,
  // item category, condition)". Stored opaquely (an unknown slug simply falls back to
  // the default), mirroring Npc.iconSlug from #302 so the field stays forward-compatible
  // as the curated set grows.
  iconSlug: z.string().max(80).default(''),
  rightsStatus: z.enum(['private_original', 'permission_granted', 'open_licensed']).default('open_licensed'),
  archivedAt: IsoDate.nullable().optional(),
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

// ---------- campaign homebrew (issue #741) ----------
// Homebrew is deliberately an entry-level, campaign-private concern.  It is not a
// pack upload and therefore never inherits the global/open-pack licensing contract.
export const HomebrewRightsStatus = z.enum(['private_original', 'permission_granted', 'open_licensed']);
export type HomebrewRightsStatus = z.infer<typeof HomebrewRightsStatus>;
const HomebrewDataObject = z.record(z.string(), z.unknown());
export const HomebrewRuleEntryInput = z.object({
  slug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a stable lowercase slug'),
  name: z.string().min(1).max(200),
  type: RuleEntryType,
  summary: z.string().max(1000).default(''),
  body: z.string().max(50_000).default(''),
  /** Structured editors serialize here; raw mode accepts only a JSON object. */
  data: HomebrewDataObject.optional(),
  dataJson: z.string().max(100_000).optional(),
  rightsStatus: HomebrewRightsStatus.default('private_original'),
  license: z.string().max(160).default(''),
  attribution: z.string().max(500).default(''),
  author: z.string().max(200).default(''),
  sourceUrl: z.string().max(500).refine((url) => !url || /^https?:\/\//i.test(url), 'Source URL must be http(s)').default(''),
  iconSlug: z.string().max(80).default(''),
}).superRefine((value, ctx) => {
  if (value.data !== undefined && value.dataJson !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide data or dataJson, not both' });
  if (value.dataJson !== undefined) {
    try { const parsed: unknown = JSON.parse(value.dataJson); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataJson'], message: 'Raw data must be a JSON object' }); }
  }
  if (value.rightsStatus === 'open_licensed') {
    if (!value.license.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['license'], message: 'Open-licensed work requires a license' });
    if (!value.attribution.trim() && !value.author.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attribution'], message: 'Open-licensed work requires attribution or author' });
    if (!value.sourceUrl.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceUrl'], message: 'Open-licensed work requires a source URL' });
  }
  if (value.rightsStatus === 'permission_granted' && !value.attribution.trim() && !value.author.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attribution'], message: 'Permission-granted work requires attribution or author' });
});
export type HomebrewRuleEntryInput = z.infer<typeof HomebrewRuleEntryInput>;
// Re-parse an update after merging it with the stored entry; keeping this permissive
// patch shape avoids accidentally requiring every field on a normal edit.
export const HomebrewRuleEntryUpdate = z.object({
  slug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  name: z.string().min(1).max(200).optional(), type: RuleEntryType.optional(),
  summary: z.string().max(1000).optional(), body: z.string().max(50_000).optional(),
  data: HomebrewDataObject.optional(), dataJson: z.string().max(100_000).optional(),
  rightsStatus: HomebrewRightsStatus.optional(), license: z.string().max(160).optional(),
  attribution: z.string().max(500).optional(), author: z.string().max(200).optional(),
  sourceUrl: z.string().max(500).refine((url) => !url || /^https?:\/\//i.test(url), 'Source URL must be http(s)').optional(), iconSlug: z.string().max(80).optional(),
  expectedUpdatedAt: ExpectedUpdatedAt,
});
export type HomebrewRuleEntryUpdate = z.infer<typeof HomebrewRuleEntryUpdate>;
export const HomebrewImportEntry = HomebrewRuleEntryInput;
export const HomebrewImportPreview = z.object({ entries: z.array(HomebrewImportEntry).min(1).max(1000) });
export const HomebrewConflictStrategy = z.enum(['skip', 'replace', 'duplicate']);
export const HomebrewImportApply = HomebrewImportPreview.extend({ strategy: HomebrewConflictStrategy, expectedUpdatedAt: z.record(z.string(), z.string()).optional() });
export type HomebrewImportApply = z.infer<typeof HomebrewImportApply>;

/**
 * Portable compendium identity for campaign export/import (issue #584). Replaces
 * server-local `ruleEntryId` in export documents — numeric ids are autoincrement
 * values that alias unrelated content on another install.
 */
export const CompendiumRef = z.object({
  packSlug: z.string().min(1).max(80),
  packVersion: z.string().max(40).default(''),
  entrySlug: z.string().min(1).max(160),
  entryType: RuleEntryType,
  /** sha256 hex of the portable entry payload (see computeRuleEntryContentHash). */
  contentHash: z.string().length(64),
});
export type CompendiumRef = z.infer<typeof CompendiumRef>;

/** Entry content captured at export time for detached import when a pack is missing (issue #584). */
export const CompendiumSnapshot = z.object({
  slug: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
  type: RuleEntryType,
  summary: z.string().max(1000).default(''),
  body: z.string().max(50_000).default(''),
  dataJson: z.string().nullable().default(null),
  source: z.string().max(200).default(''),
  license: z.string().max(160).default(''),
  attribution: z.string().max(500).default(''),
  author: z.string().max(200).default(''),
  sourceUrl: z.string().max(500).default(''),
});
export type CompendiumSnapshot = z.infer<typeof CompendiumSnapshot>;

/** One installed/open-licensed pack the export's compendium refs depend on (issue #584). */
export const CompendiumDependency = z.object({
  packSlug: z.string().min(1).max(80),
  packVersion: z.string().max(40).default(''),
  name: z.string().min(1).max(120),
  license: z.string().max(120).default(''),
  sourceUrl: z.string().max(500).default(''),
  entrySlugs: z.array(z.string().min(1).max(160)),
});
export type CompendiumDependency = z.infer<typeof CompendiumDependency>;

export const CompendiumRefStatus = z.enum([
  'resolved',
  'missing_pack',
  'missing_entry',
  'hash_mismatch',
  'type_mismatch',
  'legacy_numeric_id',
]);
export type CompendiumRefStatus = z.infer<typeof CompendiumRefStatus>;

export const CompendiumInstallHint = z.object({
  packSlug: z.string().min(1).max(80),
  packName: z.string().min(1).max(120),
  license: z.string().max(120).default(''),
  sourceUrl: z.string().max(500).default(''),
  /** Suggested `source` for POST /rules/packs/install when known (e.g. open5e, pf2e). */
  suggestedSource: z.string().max(40).optional(),
});
export type CompendiumInstallHint = z.infer<typeof CompendiumInstallHint>;

export const CompendiumRefReport = z.object({
  compendiumRef: CompendiumRef.nullable(),
  legacyRuleEntryId: Id.nullable().optional(),
  combatantName: z.string().max(120).optional(),
  status: CompendiumRefStatus,
  resolvedEntryId: Id.nullable(),
  expectedContentHash: z.string().length(64).optional(),
  actualContentHash: z.string().length(64).optional(),
  installHint: CompendiumInstallHint.nullable().optional(),
  detached: z.boolean().optional(),
});
export type CompendiumRefReport = z.infer<typeof CompendiumRefReport>;

export const CampaignImportPreflight = z.object({
  compendiumDependencies: z.array(CompendiumDependency),
  references: z.array(CompendiumRefReport),
  canImport: z.boolean(),
  canImportDetached: z.boolean(),
  unresolvedCount: z.number().int().nonnegative(),
});
export type CampaignImportPreflight = z.infer<typeof CampaignImportPreflight>;

/** How import handles compendium refs that cannot be resolved on this server (issue #584). */
export const OnUnresolvedCompendium = z.enum(['block', 'detach']);
export type OnUnresolvedCompendium = z.infer<typeof OnUnresolvedCompendium>;

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
 *   - 'cepheus'     — Cepheus Engine SRD (2D6 sci-fi; mdBook Markdown, issue #406)
 *   - 'datasworn'   — Ironsworn: Starforged, via the canonical rsek/datasworn CC-BY-4.0
 *                     JSON dataset (issue #405; a PbtA reference-text pack — one real
 *                     statblock section, NPCs, the rest reference text)
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
  'cepheus',
  'datasworn',
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
  // 5e-shaped (Open5e, Pathfinder 1e; OSR uses a subset). PF2e/SF2e now honor their
  // own native section keys (below) rather than ignoring the filter.
  'spells',
  'monsters',
  'items',
  'conditions',
  'classes',
  'races',
  'feats',
  // Open5e mundane gear (issue #2096). `items` maps to Open5e's /magicitems/ path and so
  // never contained a Longsword or Chain Mail; these two carry the SRD's ordinary weapons
  // and armour, which is what a character sheet actually equips.
  'weapons',
  'armor',
  // Starfinder
  'equipment',
  'starships',
  'vehicles',
  // PF2e / SF2e Archives of Nethys native sections
  'creatures',
  'ancestries',
  'backgrounds',
  'hazards',
  'deities',
  'rituals',
  'planes',
  'curses',
  'diseases',
  // Open Legend
  'banes',
  'boons',
  // Datasworn / Ironsworn: Starforged (issue #405). A PbtA/narrative game whose native model
  // is oracles/moves/assets — only `npcs` maps cleanly to a statblock; the rest is reference text.
  'npcs',
  'assets',
  'moves',
  'oracles',
  'truths',
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
  /**
   * The `rule_packs.slug` (or slugs — 'osr' installs several retroclone variants) this
   * source's importer writes to `campaign.ruleSystem` when installed (issue #2081). Attached
   * after `RULE_PACK_SOURCE_META` below, once the per-system `*_PACK_SLUG` constants exist —
   * see the assignment block right before {@link isImporterOnlyRuleSystemSlug}. Left
   * `undefined` here, not a hardcoded slug, so there is exactly one place each source's slug
   * is declared.
   */
  packSlug?: string | readonly string[];
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
    note: 'Live per-section import of open rules/reference content from Archives of Nethys; adventure, scenario, and story publications are excluded.',
    candidateSourceUrl: 'https://elasticsearch.aonprd.com',
  },
  sf2e: {
    source: 'sf2e',
    label: 'Starfinder 2e (Archives of Nethys)',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'ORC / OGL',
    note: 'Live per-section import of open rules/reference content from the Archives of Nethys SF2e backend; adventure, scenario, and story publications are excluded.',
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
  cepheus: {
    source: 'cepheus',
    label: 'Cepheus Engine SRD',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'Open Game License v1.0a',
    note: 'Live import of the section-level SRD text (2D6 sci-fi) from the first-party mdBook Markdown at orffen/cepheus-srd (raw GitHub). Open Game Content only; the "Cepheus Engine"/"Samardan Press" trademarks are not claimed.',
    candidateSourceUrl: 'https://github.com/orffen/cepheus-srd',
  },
  datasworn: {
    source: 'datasworn',
    label: 'Ironsworn: Starforged (datasworn)',
    sourceKind: 'api',
    installableWithoutUrl: true,
    license: 'CC-BY-4.0',
    note: 'Live import of the canonical rsek/datasworn Starforged JSON (a single CC-BY-4.0 data file). A PbtA reference-text pack: NPCs import as monster statblocks; assets, moves, oracles, and truths import as reference sections.',
    candidateSourceUrl: 'https://raw.githubusercontent.com/rsek/datasworn/main/datasworn/starforged/starforged.json',
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
  /** Lair actions the creature takes on initiative count 20 (issue #618). */
  lairActions?: unknown;
  reactions?: unknown;
}

/** 5e lair actions fire on initiative count 20 (issue #618). */
export const LAIR_INITIATIVE_COUNT = 20;

/** Default legendary-action pool per round for boss creatures (issue #618). */
export const LEGENDARY_ACTIONS_PER_ROUND = 3;

/** Action-economy slot key for legendary-action usage on a combatant (issue #618). */
export const LEGENDARY_ACTION_SLOT = 'legendary';

/** Whether a mapped statblock section has at least one named entry (issue #618). */
export function statblockSectionHasEntries(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name.length > 0) return true;
    const desc = typeof o.desc === 'string' ? o.desc : typeof o.description === 'string' ? o.description : '';
    return desc.trim().length > 0;
  });
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

// ---------- adapter-defined action economy (issue #413) ----------
// The turn-workspace surfaces "what can I do now?" as a set of ACTION-ECONOMY SLOTS —
// but the shape of a turn is a per-system decision, not a 5e constant. 5e is
// action / bonus action / reaction / movement; PF2e is a three-action economy plus a
// reaction; a dice-pool / narrative system may have none. This capability lives on the
// RuleSystemAdapter (like `conditions` and `presentation`) so the run-session code reads
// the slots from the campaign's adapter instead of hardcoding the 5e four. Adapters that
// don't define one fall back to {@link NEUTRAL_ACTION_ECONOMY} (a single generic "Action"
// slot), never to 5e's — so a non-5e fight never mislabels its turn as bonus-action-shaped.

/** How an action-economy slot behaves for the tracker + when its usage counter refreshes. */
export type ActionEconomySlotKind = 'action' | 'movement' | 'reaction' | 'resource';

/**
 * One adapter-defined slot in a turn's action economy (issue #413). `key` is a stable id
 * the tracker counts usage against; `max` is how many are available fresh each turn (or
 * round, per `resetsAt`). `help` is plain-language guidance shown to a new player. A
 * `movement` slot's `max` is a speed in feet (0 when the system is gridless / undefined);
 * a `reaction` slot refreshes at the START of the owner's turn (5e: one reaction per round,
 * refreshed at your turn), so its `resetsAt` is 'turn'.
 */
export interface ActionEconomySlot {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly kind: ActionEconomySlotKind;
  /** Fresh count each period. For a movement slot this is a distance (ft); 0 = system default/none. */
  readonly max: number;
  /** When the used-counter refreshes: at the owner's turn start, or at the top of each round. */
  readonly resetsAt: 'turn' | 'round';
}

/** An ordered set of action-economy slots for one rule system (issue #413). */
export interface ActionEconomyModel {
  readonly slots: readonly ActionEconomySlot[];
}

/** Neutral fallback for adapters that don't define an action economy — one generic Action. */
export const NEUTRAL_ACTION_ECONOMY: ActionEconomyModel = {
  slots: [
    { key: 'action', label: 'Action', help: 'Take one action on your turn.', kind: 'action', max: 1, resetsAt: 'turn' },
  ],
};

/** D&D 5e action economy: action, bonus action, reaction, and movement (issue #413). */
export const DND5E_ACTION_ECONOMY: ActionEconomyModel = {
  slots: [
    { key: 'action', label: 'Action', help: 'Attack, Cast a Spell, Dash, Dodge, Disengage, Help, Hide, Ready, Search, or Use an Object.', kind: 'action', max: 1, resetsAt: 'turn' },
    { key: 'bonus', label: 'Bonus Action', help: 'Only when a feature, spell, or item specifically grants one this turn.', kind: 'action', max: 1, resetsAt: 'turn' },
    { key: 'reaction', label: 'Reaction', help: 'One per round, e.g. an opportunity attack or a readied trigger. Refreshes at the start of your turn.', kind: 'reaction', max: 1, resetsAt: 'turn' },
    { key: 'movement', label: 'Movement', help: 'Move up to your speed; you can split it around your action.', kind: 'movement', max: 30, resetsAt: 'turn' },
  ],
};

/** Pathfinder 2e action economy: three actions plus one reaction (issue #413). */
export const PF2E_ACTION_ECONOMY: ActionEconomyModel = {
  slots: [
    { key: 'actions', label: 'Actions', help: 'You have three actions each turn; most activities cost 1–3 of them.', kind: 'action', max: 3, resetsAt: 'turn' },
    { key: 'reaction', label: 'Reaction', help: 'One per round when its trigger occurs. Refreshes at the start of your turn.', kind: 'reaction', max: 1, resetsAt: 'turn' },
  ],
};

/**
 * Resolve the action-economy model for an adapter (issue #413). Falls back to the
 * neutral single-Action model when the adapter doesn't define one — never to 5e's, so a
 * non-5e system that hasn't opted in isn't given bonus-action / reaction slots it lacks.
 */
export function actionEconomyForAdapter(adapter: Pick<RuleSystemAdapter, 'actionEconomy'>): ActionEconomyModel {
  return adapter.actionEconomy ?? NEUTRAL_ACTION_ECONOMY;
}

// ---------- adapter-defined initiative model (issue #765) ----------
// OSR retroclones vary between individual d6+DEX and group d6-per-side initiative.
// This optional capability on RuleSystemAdapter lets encounter rollers and the UI
// show the exact variant's initiative mode without hardcoding Basic Fantasy defaults.

/** How initiative is rolled for a rule system (issue #765). */
export type InitiativeMode = 'individual' | 'group';

/** Per-system initiative configuration (issue #765). */
export interface InitiativeModel {
  readonly mode: InitiativeMode;
  /** Whether DEX modifier is added to the initiative roll (individual mode only). */
  readonly usesDexModifier: boolean;
}

/** Default individual d20+DEX model (5e/PF1e). Adapters that omit `initiativeModel` are treated as individual. */
export const DEFAULT_INITIATIVE_MODEL: InitiativeModel = { mode: 'individual', usesDexModifier: true };

/** Resolve the initiative model for an adapter (issue #765). */
export function initiativeModelForAdapter(adapter: Pick<RuleSystemAdapter, 'initiativeModel'>): InitiativeModel {
  return adapter.initiativeModel ?? DEFAULT_INITIATIVE_MODEL;
}

// ---------- adapter-defined grid distance rules (issue #467) ----------
// Square grids default to Euclidean straight-line ruler distance; hex grids use
// cube/axial hex steps. 5e optionally counts every other diagonal as 2 squares.

/** Square-grid distance mode for the measurement ruler. */
export type SquareDistanceMode = 'euclidean' | 'alternating-diagonal';

/** Hex-grid distance mode — cube/axial steps between hex centres. */
export type HexDistanceMode = 'hex';

/** Per-system ruler distance configuration (issue #467). */
export interface GridDistanceRule {
  readonly square: SquareDistanceMode;
  readonly hex: HexDistanceMode;
}

/** Default ruler distance: Euclidean squares, hex steps on hex grids. */
export const DEFAULT_GRID_DISTANCE_RULE: GridDistanceRule = { square: 'euclidean', hex: 'hex' };

/** Resolve the grid distance rule for an adapter (issue #467). */
export function gridDistanceForAdapter(adapter: Pick<RuleSystemAdapter, 'gridDistanceRule'>): GridDistanceRule {
  return adapter.gridDistanceRule ?? DEFAULT_GRID_DISTANCE_RULE;
}

/** One editable character-sheet attribute/ability owned by a rules adapter (issue #540). */
export interface CharacterSheetAbilityField {
  readonly key: string;
  readonly label: string;
}

/** Optional character-sheet topology owned by a rules adapter (issue #540). */
export interface CharacterSheetClassField {
  readonly label: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly visible: boolean;
}

export interface CharacterSheetTopology {
  readonly abilityFields: readonly CharacterSheetAbilityField[];
  readonly classField: CharacterSheetClassField;
  /**
   * False for systems whose sheet should not expose Campfire's legacy 5e save editor.
   * Their roll catalog can still surface native checks.
   */
  readonly supportsSavingThrowEditor: boolean;
  /** False for systems whose sheet should not expose the fixed 5e skill list. */
  readonly supportsSkillEditor: boolean;
  /** False for systems whose sheet should not expose 5e spell-slot pips. */
  readonly supportsSpellSlotEditor: boolean;
  /** Honest copy shown when the sheet falls back to generic notes/actions/resources. */
  readonly genericModeDescription?: string;
}

export const STANDARD_D20_ABILITY_FIELDS: readonly CharacterSheetAbilityField[] = [
  { key: 'STR', label: 'STR' },
  { key: 'DEX', label: 'DEX' },
  { key: 'CON', label: 'CON' },
  { key: 'INT', label: 'INT' },
  { key: 'WIS', label: 'WIS' },
  { key: 'CHA', label: 'CHA' },
] as const;

export const STANDARD_CLASS_FIELD: CharacterSheetClassField = {
  label: 'Class',
  placeholder: 'Class',
  required: true,
  visible: true,
};

/**
 * How a rule system applies HP changes and treats a combatant at 0 HP (issue #1503). The
 * structured HP engine (`applyCombatantHp` in apps/server) used to hardcode D&D 5e's rules for
 * EVERY combatant — a single hit whose overflow past 0 HP reached the combatant's maxHP killed
 * outright (massive damage), and 0 HP tracked 5e's 3-success/3-failure death saves (dying /
 * stable / dead, nat-20 revive, nat-1 two failures, damage-while-down a failure). A
 * Starforged / Open Legend / OSR character reduced to 0 therefore silently accumulated
 * death-save state a system without them does not have, and could be marked dead by rules the
 * table never agreed to.
 *
 * Each clause is a 5e-specific DEATH rule, not a universal damage rule — temp HP absorbing
 * before real HP stays universal (every system with temp HP works that way) and is NOT modelled
 * here. Only the systems whose model has been confirmed declare an {@link RuleSystemAdapter.hpModel};
 * everyone else omits it and {@link hpModelForAdapter} returns {@link NEUTRAL_HP_MODEL} — 0 HP is
 * simply "down", no 5e death math — never silent 5e rules on a table that isn't 5e.
 */
export interface HpModel {
  /**
   * Whether a single hit whose damage exceeds a combatant's current HP by at least its maxHP
   * kills it outright (D&D 5e massive damage). Systems without this rule drop to 0 HP and are
   * "down" instead.
   */
  readonly massiveDamageInstantDeath: boolean;
  /**
   * Whether this system tracks D&D-5e-style 3-success/3-failure death saving throws at 0 HP
   * (dying / stable / dead, nat-20 revive at 1 HP, nat-1 two failures, damage taken while down a
   * failure). Systems without 5e death saves leave a downed combatant at 0 HP with no death-save
   * state — exactly the monster path.
   */
  readonly deathSaves: boolean;
  /**
   * Whether this system flags a combatant 'dying' when HP reaches 0 via its OWN model — not 5e
   * death saves. Starfinder, for example, treats 0 HP as dying but recovers via Resolve Points
   * rather than a 3-success/3-failure tracker. Systems with no downed concept at all (PF2e, OSR,
   * Open Legend, …) leave this false: 0 HP is simply "down" with deathState 'none'. The damage
   * path still runs each system's own model (e.g. applyStarfinderDamage); this flag only governs
   * the absolute-set (hpSet) path and the character sheet, so a combatant reaches the same state
   * at 0 HP regardless of how the zero was applied (issue #1503).
   */
  readonly dyingAtZeroHp: boolean;
}

/**
 * D&D 5e's HP/death model — massive-damage instant death plus the full death-save tracker.
 * Declared explicitly on {@link Dnd5eAdapter} (the one adapter whose model the engine has
 * audited) rather than relying on a default, the same way 5e declares its own
 * `checkProficiencyBonus` instead of leaning on the resolver's safe default.
 */
export const DND5E_HP_MODEL: HpModel = {
  massiveDamageInstantDeath: true,
  deathSaves: true,
  // 5e also treats 0 HP as dying; the deathSaves branch above is what actually writes it, but the
  // flag is declared so a system whose dying model is NOT 5e death saves can express the same.
  dyingAtZeroHp: true,
};

/**
 * The safe default for every adapter that has not declared an {@link HpModel} — 0 HP is "down",
 * with no 5e massive-damage instant death and no 5e death-save tracker. This is the model
 * {@link hpModelForAdapter} returns for Starforged / Open Legend / OSR / PF2e / Starfinder /
 * 13th Age and any unaudited or custom system, so a non-5e table never has 5e death rules
 * written to its combatants (issue #1503).
 */
export const NEUTRAL_HP_MODEL: HpModel = {
  massiveDamageInstantDeath: false,
  deathSaves: false,
  dyingAtZeroHp: false,
};

export interface RuleSystemAdapter {
  /** Stable adapter id — typically a family id (e.g. 'dnd5e'); OSR variants use their pack slug. */
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
  /** Adapter-owned character-sheet field topology (issue #540). */
  readonly characterSheet?: CharacterSheetTopology;
  /** Ability-score → modifier (5e: floor((score - 10) / 2)). Character sheets always use this. */
  abilityModifier(score: number): number;
  /** Die size for an initiative roll (5e: d20). Keeps the d20 assumption out of the generic roller. */
  readonly initiativeDie: number;
  /**
   * OPTIONAL — how initiative is rolled for this system (issue #765). OSR variants use
   * individual d6+DEX or group d6-per-side; 5e/PF1e omit this and default to individual d20+DEX.
   * Encounter rollers and the UI read this via {@link initiativeModelForAdapter}.
   */
  readonly initiativeModel?: InitiativeModel;
  /**
   * OPTIONAL — how the VTT measurement ruler counts grid cells (issue #467). Square grids
   * default to Euclidean straight-line distance; hex grids use cube/axial hex steps. 5e may
   * opt into alternating-diagonal counting on square grids. Read via {@link gridDistanceForAdapter}.
   */
  readonly gridDistanceRule?: GridDistanceRule;
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
  /** Optional extra term for systems whose character initiative adds level separately (13th Age). */
  levelInitiativeBonus?(level: number): number;
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
  /** Optional typed-damage vocabulary offered by this system's encounter controls (issue #605). */
  readonly damageTypes?: readonly string[];
  /** Whether this adapter owns 5e-style direct-damage semantics (save-half and dice-only crits). */
  readonly supportsDirectDamageRules?: boolean;
  /**
   * OPTIONAL — the action-economy model for this system's turn workspace (issue #413):
   * the ordered slots (action / bonus / reaction / movement, or PF2e's three actions,
   * or a system with none) a player consults to answer "what can I do now?". Omit it and
   * {@link actionEconomyForAdapter} falls back to {@link NEUTRAL_ACTION_ECONOMY} — a single
   * generic Action — never to 5e's, so a non-5e fight never inherits bonus-action / reaction
   * slots it doesn't have. This is the seam that keeps the turn tracker from hardcoding 5e.
   */
  readonly actionEconomy?: ActionEconomyModel;
  /**
   * OPTIONAL — how a critical hit multiplies damage in this system (issue #1053). The
   * structured action resolver used to hardcode 5e's "roll the dice twice, add the modifier
   * once" for every campaign, so a PF2e `1d8+3` crit came out as `2d8+3` instead of the
   * `(1d8+3)*2` PF2e prescribes. Adapters whose crit rule differs from 5e's declare it here;
   * everyone else omits it and {@link criticalDamageRuleForAdapter} returns `double-dice`,
   * which is both 5e's rule and the pre-existing behaviour for every system.
   *
   * Only the systems whose rule has been confirmed are declared today — 5e (by omission) and
   * PF2e/SF2e. The remaining adapters are unaudited and therefore left on the 5e default
   * rather than guessed at; declaring one is a one-line change once a system's rule is confirmed.
   */
  readonly criticalDamage?: CriticalDamageRule;
  /**
   * OPTIONAL, OPT-IN — declare this only if the structured action resolver's OWN maths is this
   * system's maths (issue #1053 review): a single d20 plus a flat modifier, compared against
   * ascending armour class, with 5e's level-based proficiency bonus. See
   * {@link ResolverMathProfile} for why each clause matters and which systems break which one.
   *
   * Omitting it means "the resolver does not speak this system", and omission is the DEFAULT on
   * purpose. Callers ask {@link resolverImplementsSystemMath}; an adapter that has not been
   * audited withholds rather than being assumed d20-compatible, because the cost of a wrong
   * assumption here is `resolve_action` committing HP off the wrong arithmetic. Declaring it is
   * a factual claim — check the three clauses against the system's rules first.
   */
  readonly resolverMath?: ResolverMathProfile;
  /**
   * OPTIONAL — this system's OWN attack roll and hit/miss/crit classification (issue #1598),
   * the way {@link criticalDamage} owns the crit-damage rule. Omit it and the resolver falls
   * back to a single d20 + flat modifier vs ascending AC (5e's maths, and the pre-existing
   * behaviour for every system) — see `defaultAttackRoll` / `resolveAttackForAdapter` in
   * action-resolver.ts. Declaring it does NOT by itself widen {@link resolverMath}: that flag
   * also covers save proficiency (#1599), so an adapter can have correct attack maths here and
   * still withhold `resolverMath` until its saves are correct too.
   */
  resolveAttack?(input: AttackRollInput): AttackRollResult;
  /**
   * OPTIONAL — this system's own proficiency/training bonus (issue #1599), the way
   * {@link resolveAttack} owns the attack roll. Omit it and the resolver falls back to 0 (see
   * `defaultCheckProficiencyBonus` in action-resolver.ts for why the safe default is 0, not 5e's
   * formula, unlike the attack default). `Dnd5eAdapter` declares it explicitly rather than
   * relying on that default; `Pf2eAdapter` (inherited by SF2e) declares its own.
   */
  checkProficiencyBonus?(level: number): number;
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
   * OPTIONAL — whether this rule system tracks 5e 3-success/3-failure death saving throws (issue #424).
   * 5e sets this to true; systems without 5e death saves set it to false or omit it.
   */
  readonly hasDeathSaves?: boolean;
  /**
   * OPTIONAL — whether this system endorses "half or more of the party succeeds" as a group-check
   * convention (issue #1943). The group-check board's X/N tally is universal, but the advisory
   * verdict line built on top of it ("Group succeeds") is a per-system table convention, not a
   * mechanical rule this engine enforces — 5e declares it explicitly; every other system omits
   * it (treated as false) so PF2e/OSR/Open Legend tables see the tally with no verdict text.
   */
  readonly groupCheckMajorityAdvisory?: boolean;
  /**
   * OPTIONAL — this system's HP/death model for the resolution layer (issue #1503): whether a
   * single hit past 0 HP by >= maxHP kills outright (5e massive damage) and whether 0 HP tracks
   * 5e 3-success/3-failure death saves. The structured HP engine (`applyCombatantHp`) used to
   * apply BOTH unconditionally to every combatant, so a non-5e character at 0 HP silently
   * accumulated death-save state a system without them does not have. Adapters whose model is
   * 5e's declare it; everyone else omits it and {@link hpModelForAdapter} returns
   * {@link NEUTRAL_HP_MODEL} (0 HP is "down", no 5e death math) — never silent 5e rules on a
   * table that isn't 5e. {@link hasDeathSaves} remains the UI-facing capability (whether to SHOW
   * a death-save tracker); this is the server-facing one (whether to COMPUTE one).
   */
  readonly hpModel?: HpModel;
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
   * Whether this adapter owns XP threshold math for advisory progress UI (issue #441). D&D-family
   * systems opt in; milestone-first systems (13th Age, Open Legend, OSR, Starforged) omit it so
   * the sheet does not show misleading 5e guidance.
   */
  readonly supportsXpProgression?: boolean;
  /**
   * Cumulative XP required to be `level`. Required when `supportsXpProgression` is true.
   */
  xpForLevel?(level: number): number;
  /**
   * Highest level the given total XP qualifies for. Required when `supportsXpProgression` is true.
   */
  levelForXp?(xp: number): number;
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
  /**
   * OPTIONAL — the encounter/sheet ROLL CATALOG for a character (issue #415): every rollable
   * check (ability checks, skills — proficient AND unproficient — saves/defenses, initiative)
   * with the modifier already computed by this system's authoritative math and a transparent
   * breakdown. Adapters that model their own proficiency (5e's fixed bonus, PF2e's level+rank)
   * implement it; every other adapter omits it and {@link checkCatalogForAdapter} falls back to
   * the honest, configurable {@link neutralCheckCatalog} derived from the character's own data.
   * This is the single source of truth the character sheet, the encounter card, the server
   * roll resolver, and the MCP tools all read — so a sheet roll and an encounter roll are
   * identical by construction and no surface reinvents proficiency math.
   */
  buildCheckCatalog?(character: CheckCatalogCharacter): RollCheckDefinition[];
  /** Standard system resource vocabulary for this rule system (issue #422). */
  readonly resources?: readonly AdapterResourceDef[];
  /**
   * OPTIONAL — how a short/long rest recovers under this system (issue #1041).
   *
   * Deliberately thin, because the load-bearing part of rest customisation already exists:
   * `AdapterResourceDef.recharge` (#422) says which rest refills which resource, and
   * `RECHARGE_RECOVERED_BY_REST` consumes it. This adds only what that cannot express — which
   * conditions a rest clears, the hit-die mechanic, and whether a long rest resets death saves.
   *
   * Omitting it is safe and meaningful: {@link NEUTRAL_REST_MODEL} clears NO conditions and
   * supports no hit dice, so the six adapters with no rest vocabulary recover HP and their
   * declared resources without silently inheriting D&D 5e's recovery rules just because 5e is
   * the fallback adapter.
   */
  readonly restModel?: RestModel;
  /** OPTIONAL — system-defined rest controls offered in the UI. Defaults via restOptionsForAdapter. */
  readonly restOptions?: readonly RestOptionDef[];
}

/** Standard system resource pool definition (issue #422). */
export const AdapterResourceDef = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  recharge: z.enum(['short-rest', 'long-rest', 'refocus', 'dawn', 'turn-start', 'special']),
  defaultMax: z.number().int().min(0).max(100).optional(),
});
export type AdapterResourceDef = z.infer<typeof AdapterResourceDef>;

/**
 * Resolves the combined resource vocabulary for a character under a rule system adapter (issue #422).
 * Combines system-standard resource definitions (from the adapter) and custom character resources.
 */
export function resourceVocabularyForAdapter(
  adapter: RuleSystemAdapter,
  character?: { resources?: Record<string, { max?: number; used?: number; name?: string; recharge?: string }> },
): AdapterResourceDef[] {
  const result: AdapterResourceDef[] = [];
  const seenKeys = new Set<string>();

  if (adapter.resources) {
    for (const r of adapter.resources) {
      result.push(r);
      seenKeys.add(r.key);
    }
  }

  if (character?.resources) {
    for (const [key, res] of Object.entries(character.resources)) {
      if (!seenKeys.has(key)) {
        const rechargeParsed = AdapterResourceDef.shape.recharge.safeParse(res.recharge);
        result.push({
          key,
          name: res.name || key,
          recharge: rechargeParsed.success ? rechargeParsed.data : 'long-rest',
          defaultMax: res.max,
        });
        seenKeys.add(key);
      }
    }
  }

  return result;
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
  // The structured resolver's attack/save maths IS 5e's — d20 + flat modifier vs ascending AC,
  // level-based proficiency — so 5e is the one adapter that can declare this today (#1053).
  // Unknown / empty / homebrew slugs resolve to this adapter via `ruleSystemAdapter`, so they
  // inherit the declaration, which is correct: 5e maths is exactly what those campaigns get.
  resolverMath: RESOLVER_MATH_D20_5E,
  // #1599 — 5e is the one adapter that opts OUT of `checkProficiencyBonus`'s own default (0):
  // that default is deliberately "add nothing" for every UNAUDITED system, but 5e's curve is
  // exactly this formula, so 5e declares it explicitly rather than relying on a default that
  // exists precisely so nobody ELSE has to make this claim by accident.
  checkProficiencyBonus: dnd5eProficiencyBonus,
  presentation: DND5E_STATBLOCK_PRESENTATION,
  characterSheet: {
    abilityFields: STANDARD_D20_ABILITY_FIELDS,
    classField: STANDARD_CLASS_FIELD,
    supportsSavingThrowEditor: true,
    supportsSkillEditor: true,
    supportsSpellSlotEditor: true,
  },
  hasDeathSaves: true,
  // #1943 — 5e's group-check convention ("half or more of the party succeeds") is a documented
  // table norm this adapter opts into explicitly; other systems omit it and get the tally with
  // no verdict text.
  groupCheckMajorityAdvisory: true,
  // #1503 — 5e's HP/death model is the one the engine implements (massive-damage instant death
  // + the 3-success/3-failure death-save tracker). Every other adapter omits hpModel and
  // hpModelForAdapter hands them NEUTRAL_HP_MODEL (0 HP is "down"), so a non-5e table never has
  // 5e death rules written to its combatants.
  hpModel: DND5E_HP_MODEL,
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  resources: [
    { key: 'hitDice', name: 'Hit Dice', recharge: 'long-rest' },
    { key: 'rage', name: 'Rage', recharge: 'long-rest' },
    { key: 'actionSurge', name: 'Action Surge', recharge: 'short-rest' },
    { key: 'kiPoints', name: 'Focus / Ki Points', recharge: 'short-rest' },
    { key: 'recharge', name: 'Recharge Feature', recharge: 'turn-start' },
    // #1073 — inspiration is a COUNTED resource, not a free-text condition, so the AI (and the
    // sheet) can award and spend it instead of writing prose about it.
    //
    // `recharge: 'special'` is a real statement, not a shrug: 5e inspiration is DM-AWARDED and
    // survives rests untouched, so every rest cadence would be wrong — a long-rest recharge
    // would hand it out for free every night, which is precisely the opposite of how it works.
    // `defaultMax: 1` because you either have inspiration or you do not (2014 PHB, and 2024
    // heroic inspiration likewise); a second award while holding one is not a second point.
    { key: 'inspiration', name: 'Inspiration', recharge: 'special', defaultMax: 1 },
  ],
  // Rest recovery (#1041). `clearedByLongRest` is an ALLOWLIST of what a night's sleep removes,
  // never a denylist of what is "permanent" — see the RestModel docs for why that direction is
  // the safe one when conditions are bare strings with no metadata (#1047).
  //
  // These three are the 5e conditions a long rest ends OUTRIGHT on its own — the PHB rest/
  // unconsciousness rules resolve them without an external cure. Exhaustion is deliberately
  // ABSENT from this list (issue #1641 — it used to be here, which was the bug: this allowlist
  // can only express "removed entirely", and 5e's actual rule is "a long rest reduces
  // exhaustion by ONE LEVEL", not to zero). Exhaustion's presence is instead read off
  // `leveledConditionTrackFor('dnd5e')` (`leveled-conditions.ts`, issue #1643) by
  // `restConditionOutcome`, which decrements it by one stack on a long rest and only fully
  // removes it once that reaches 0 — see `rest.ts` for the mechanics. The conditions
  // deliberately absent from BOTH lists are the ones that need a specific remedy — petrified,
  // paralyzed, charmed, poisoned, restrained, grappled, blinded, deafened, invisible — because
  // a rest that silently ended a Medusa's petrification would erase the DM's scene.
  restModel: {
    clearedByLongRest: ['Unconscious', 'Prone', 'Frightened'],
    clearedByShortRest: [],
    // 5e hit dice are per-class (d6 sorcerer … d12 barbarian) and the class die is NOT stored
    // on the sheet in this repo, so there is no honest default: `null` makes a short rest that
    // asks to spend hit dice require an explicit `hitDie` rather than inventing an average one.
    defaultHitDie: null,
    // PHB: a long rest returns spent hit dice up to HALF the character's total (minimum 1).
    longRestHitDiceFraction: 0.5,
    longRestClearsDeathSaves: true,
  },
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
  damageTypes: DND5E_DAMAGE_TYPES,
  supportsDirectDamageRules: true,
  // 5e turn workspace (issue #413): action / bonus action / reaction / movement.
  actionEconomy: DND5E_ACTION_ECONOMY,
  // 5e square-grid ruler: Euclidean by default; DMs may prefer alternating-diagonal counting.
  gridDistanceRule: { square: 'euclidean', hex: 'hex' },
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
      lairActions: d.lairActions ?? d.lair_actions,
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
  // PHB cumulative XP thresholds — the advisory progress bar on the character sheet (issue #441).
  ...xpProgressionFromThresholds(XP_THRESHOLDS, 20),
  // 5e owns the DMG XP-budget difficulty estimate (issues #58 + #429).
  supportsEncounterDifficulty: true,
  estimateEncounterDifficulty(input: EncounterDifficultyInput): EncounterDifficulty {
    return computeDnd5eEncounterDifficulty(input);
  },
  // 5e roll catalog (issue #415): all six ability checks/saves, EVERY skill (incl. unproficient),
  // and initiative — fixed proficiency bonus, with a transparent breakdown for each.
  buildCheckCatalog(character: CheckCatalogCharacter): RollCheckDefinition[] {
    return dnd5eCheckCatalog(this, character);
  },
};

/** Whether this adapter owns XP threshold math (issue #441). */
export function xpProgressionSupported(
  adapter: Pick<RuleSystemAdapter, 'supportsXpProgression' | 'xpForLevel' | 'levelForXp'>,
): adapter is RuleSystemAdapter & {
  supportsXpProgression: true;
  xpForLevel: (level: number) => number;
  levelForXp: (xp: number) => number;
} {
  return !!(adapter.supportsXpProgression && adapter.xpForLevel && adapter.levelForXp);
}

/** Total XP required to reach `level` for a campaign's rule-system adapter. */
export function xpForLevelForAdapter(adapter: RuleSystemAdapter, level: number): number {
  if (xpProgressionSupported(adapter)) return adapter.xpForLevel(level);
  return Dnd5eAdapter.xpForLevel!(level);
}

/** Highest level the given total XP qualifies for under a campaign's rule-system adapter. */
export function levelForXpForAdapter(adapter: RuleSystemAdapter, xp: number): number {
  if (xpProgressionSupported(adapter)) return adapter.levelForXp(xp);
  return Dnd5eAdapter.levelForXp!(xp);
}

/** Compute advisory XP progress for a character sheet (issue #441). */
export function xpProgressForCharacter(adapter: RuleSystemAdapter, level: number, xp: number): XpProgress {
  const atCap = level >= adapter.maxLevel;
  if (!xpProgressionSupported(adapter)) {
    return { supported: false, atCap, currentThreshold: 0, nextThreshold: null, ready: false, pct: 0 };
  }
  const currentThreshold = adapter.xpForLevel(level);
  const nextThreshold = atCap ? null : adapter.xpForLevel(level + 1);
  const ready = nextThreshold != null && xp >= nextThreshold;
  const pct =
    nextThreshold == null || nextThreshold === currentThreshold
      ? 100
      : Math.max(0, Math.min(100, ((xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100));
  return { supported: true, atCap, currentThreshold, nextThreshold, ready, pct };
}

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

/** Open Legend's full native attribute list, stored on characters as uppercase keys. */
export const OPEN_LEGEND_ATTRIBUTE_FIELDS: readonly CharacterSheetAbilityField[] = [
  { key: 'AGILITY', label: 'Agility' },
  { key: 'FORTITUDE', label: 'Fortitude' },
  { key: 'MIGHT', label: 'Might' },
  { key: 'LEARNING', label: 'Learning' },
  { key: 'LOGIC', label: 'Logic' },
  { key: 'PERCEPTION', label: 'Perception' },
  { key: 'WILL', label: 'Will' },
  { key: 'DECEPTION', label: 'Deception' },
  { key: 'PERSUASION', label: 'Persuasion' },
  { key: 'PRESENCE', label: 'Presence' },
  { key: 'ALTERATION', label: 'Alteration' },
  { key: 'CREATION', label: 'Creation' },
  { key: 'ENERGY', label: 'Energy' },
  { key: 'ENTROPY', label: 'Entropy' },
  { key: 'INFLUENCE', label: 'Influence' },
  { key: 'MOVEMENT', label: 'Movement' },
  { key: 'PRESCIENCE', label: 'Prescience' },
  { key: 'PROTECTION', label: 'Protection' },
] as const;

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
  characterSheet: {
    abilityFields: OPEN_LEGEND_ATTRIBUTE_FIELDS,
    classField: {
      label: 'Concept',
      placeholder: 'Concept',
      required: false,
      visible: false,
    },
    supportsSavingThrowEditor: false,
    supportsSkillEditor: false,
    supportsSpellSlotEditor: false,
    genericModeDescription:
      'Open Legend sheets use native attributes, Guard, actions, banes/boons, resources, and notes; Campfire does not expose 5e saves, skills, or spell slots for this ruleset.',
  },
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
  /**
   * Open Legend's OWN attack roll (issue #1598): an exploding attribute dice pool, not a d20.
   * The structured resolver's `computeAttackModifier` already resolves the flat modifier via
   * `abilityModifier`, and THIS adapter's `abilityModifier` (above) returns the raw attribute
   * score truncated rather than a d20-style bonus — deliberately, so the number the resolver
   * hands back here through `input.modifier` in the common case (an action spec naming
   * `attack.ability`) already IS the attribute score `openLegendAttributeDicePool` expects, with
   * no separate lookup needed. A spec that instead sets a flat printed `attack.bonus` hands this
   * the same integer as a score, which `openLegendAttributeDicePool` clamps to a valid table
   * index (negative → 0, the disadvantage pool) rather than throwing — an honest degrade for an
   * input shape this system's actions are not expected to use.
   *
   * No separate crit tier: the pool's OWN exploding dice already are Open Legend's escalation
   * mechanic (a max face re-rolls and adds), so layering a 5e-style "natural 20 crits" on top
   * would double-count an already-escalating result. `naturalRoll` is null — there is no single
   * die whose face is "the" roll to show as d20-style crit/fumble evidence.
   */
  resolveAttack(input: AttackRollInput): AttackRollResult {
    const score = Number.isFinite(input.modifier) ? Math.trunc(input.modifier) : 0;
    const rollDie = (sides: number): number => {
      const r = input.roll(`1d${sides}`);
      return r.rolls[0] ?? r.total;
    };
    const rolled = rollActionDice(score, rollDie);
    return { total: rolled.total, naturalRoll: null, outcome: rolled.total >= input.targetAc ? 'hit' : 'miss' };
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

// ---------- encounter / character-sheet roll catalog (issue #415) ----------
// The encounter character card used to bake in the fixed 5e skill list and proficiency-bonus
// math, and only surfaced PROFICIENT skills — so an ordinary unproficient check could not be
// rolled inline, and a non-5e system displayed or rolled the wrong modifier. The ROLL CATALOG
// moves that decision onto the adapter: every rollable check a character can make (ability
// checks, skills, saves/defenses, initiative, and custom checks) is described once, with a
// transparent server-computable breakdown ("DEX +3, proficient +2 = +5"). The character sheet
// AND the encounter card read the SAME catalog, so a sheet roll and an encounter roll are
// identical by construction — there is no second proficiency formula for either to drift from.
//
// The catalog is pure and deterministic (no RNG, no I/O), so the server resolves the roll
// expression from it authoritatively and clients never invent proficiency math — they render
// what the catalog already computed. Adapters that model their own proficiency (5e's fixed
// bonus, PF2e's level+rank) implement `buildCheckCatalog`; every other adapter falls back to
// an honest, configurable catalog derived from the character's own stored data.

/** The kind of a rollable check in the catalog. */
export type RollCheckCategory = 'ability' | 'skill' | 'save' | 'initiative' | 'custom';

/** One transparent term of a check's modifier, e.g. `{ label: 'DEX', value: 3 }`. */
export interface RollBreakdownComponent {
  /** Short human label ("DEX", "proficient", "trained", "armor"). */
  readonly label: string;
  /** Signed integer contribution to the total modifier. */
  readonly value: number;
}

/**
 * A single rollable check for a character (issue #415). Everything a surface needs to render,
 * search, and roll it — with the modifier already computed by the authoritative adapter math
 * and a transparent breakdown of how it was reached. `id` is stable within a character's
 * catalog (e.g. `skill:Athletics`, `save:DEX`, `ability:STR`, `initiative`) so the server can
 * resolve "roll this check" from an id alone.
 */
export interface RollCheckDefinition {
  readonly id: string;
  readonly label: string;
  readonly category: RollCheckCategory;
  /** Governing ability key (STR/DEX/… or a system-native attribute), or null when none applies. */
  readonly ability: string | null;
  /** Proficiency / training / rank label ("proficient", "expertise", "trained", "expert"…) or null when untrained. */
  readonly proficiency: string | null;
  /** True when the character is trained/proficient in this check — surfaced FIRST (favorites). */
  readonly favorite: boolean;
  /** Flat modifier applied to the check die. */
  readonly modifier: number;
  /** Ordered, transparent breakdown of how `modifier` was computed. */
  readonly breakdown: readonly RollBreakdownComponent[];
  /** The check die (5e/PF2e/d20 systems: 20). Kept explicit so a non-d20 system can differ. */
  readonly die: number;
  /** Whether advantage/disadvantage (roll-two-keep) applies to this check in this system. */
  readonly supportsAdvantage: boolean;
  /** Whether the system reports degrees of success (PF2e) for this check. */
  readonly supportsDegrees: boolean;
  /**
   * True when the catalog could not compute this check from complete data (missing ability
   * score, an unmodeled system) and the surface should flag it rather than trust a silent 0.
   */
  readonly incomplete?: boolean;
}

/** Format a signed integer with an explicit leading sign ("+3", "-1", "+0"). */
export function signedModifier(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Render a check's transparent breakdown, e.g. "DEX +3, proficient +2, armor -1 = +4"
 * (issue #415). This is the SAME text the sheet, the encounter card, and the combat log show.
 */
export function formatCheckBreakdown(def: Pick<RollCheckDefinition, 'breakdown' | 'modifier'>): string {
  const parts = def.breakdown.map((c) => `${c.label} ${signedModifier(c.value)}`);
  const lhs = parts.length > 0 ? parts.join(', ') : signedModifier(def.modifier);
  return `${lhs} = ${signedModifier(def.modifier)}`;
}

/** The three roll modes a d20-style check can be taken with (mirrors the sheet's chooser). */
export type CheckRollMode = 'normal' | 'advantage' | 'disadvantage' | 'crit';

/**
 * Build the restricted dice expression for a catalog check + roll mode (issue #415). Uses the
 * keep-highest / keep-lowest advantage grammar the shared roller already understands. A system
 * that does not support advantage always rolls a single die regardless of the requested mode.
 */
export function checkRollExpr(
  def: Pick<RollCheckDefinition, 'modifier' | 'die' | 'supportsAdvantage'>,
  mode: CheckRollMode = 'normal',
): string {
  const die = def.die > 0 ? def.die : 20;
  const tail = def.modifier === 0 ? '' : signedModifier(def.modifier);
  if (def.supportsAdvantage && mode === 'advantage') return `2d${die}kh1${tail}`;
  if (def.supportsAdvantage && mode === 'disadvantage') return `2d${die}kl1${tail}`;
  return `1d${die}${tail}`;
}

/** Case-insensitive substring search over a catalog's labels / ability keys (issue #415). */
export function filterCheckCatalog(catalog: readonly RollCheckDefinition[], query: string): RollCheckDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...catalog];
  return catalog.filter(
    (c) => c.label.toLowerCase().includes(q) || (c.ability ?? '').toLowerCase().includes(q) || c.category.includes(q),
  );
}

/**
 * Order a catalog for display: favorites (trained/proficient) first, then by category, then by
 * label (issue #415). Stable and pure so the sheet and encounter card show the same order.
 */
export function sortCheckCatalog(catalog: readonly RollCheckDefinition[]): RollCheckDefinition[] {
  const categoryOrder: Record<RollCheckCategory, number> = { initiative: 0, save: 1, ability: 2, skill: 3, custom: 4 };
  return [...catalog].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    if (categoryOrder[a.category] !== categoryOrder[b.category]) return categoryOrder[a.category] - categoryOrder[b.category];
    return a.label.localeCompare(b.label);
  });
}

/** The six 5e ability keys, in canonical order. */
export const DND5E_ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
export type Dnd5eAbilityKey = (typeof DND5E_ABILITY_KEYS)[number];

/** SRD 5e skill list with the ability each is governed by (single source of truth, issue #415). */
export const DND5E_SKILLS: ReadonlyArray<{ readonly name: string; readonly ability: Dnd5eAbilityKey }> = [
  { name: 'Acrobatics', ability: 'DEX' },
  { name: 'Animal Handling', ability: 'WIS' },
  { name: 'Arcana', ability: 'INT' },
  { name: 'Athletics', ability: 'STR' },
  { name: 'Deception', ability: 'CHA' },
  { name: 'History', ability: 'INT' },
  { name: 'Insight', ability: 'WIS' },
  { name: 'Intimidation', ability: 'CHA' },
  { name: 'Investigation', ability: 'INT' },
  { name: 'Medicine', ability: 'WIS' },
  { name: 'Nature', ability: 'INT' },
  { name: 'Perception', ability: 'WIS' },
  { name: 'Performance', ability: 'CHA' },
  { name: 'Persuasion', ability: 'CHA' },
  { name: 'Religion', ability: 'INT' },
  { name: 'Sleight of Hand', ability: 'DEX' },
  { name: 'Stealth', ability: 'DEX' },
  { name: 'Survival', ability: 'WIS' },
];

/** 5e proficiency bonus by level: +2 at 1–4 up to +6 at 17–20 (single source of truth, issue #415). */
export function dnd5eProficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/** Read an ability score from a stats record tolerantly (uppercase-folded; default 10). */
function readAbilityScore(stats: Record<string, number>, ability: string): number {
  const up = ability.toUpperCase();
  const raw = stats[up] ?? stats[ability] ?? stats[ability.toLowerCase()];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 10;
}

/** The minimal character shape the catalog reads — the full {@link Character} satisfies it. */
export interface CheckCatalogCharacter {
  readonly level: number;
  readonly stats: Record<string, number>;
  readonly saveProficiencies: readonly string[];
  readonly skills: Record<string, SkillRank>;
}

/**
 * Build the full D&D 5e roll catalog for a character (issue #415): initiative, all six ability
 * checks and saves, and EVERY skill — proficient or not — so an unproficient skill rolls inline
 * with the correct DEX/… modifier instead of being hidden. Proficiency adds the fixed bonus
 * (expertise doubles it); each entry carries a transparent breakdown. Pure and deterministic.
 */
export function dnd5eCheckCatalog(adapter: Pick<RuleSystemAdapter, 'abilityModifier'>, character: CheckCatalogCharacter): RollCheckDefinition[] {
  const stats = normalizeStats(character.stats);
  const pb = dnd5eProficiencyBonus(character.level);
  const saveProfs = new Set((character.saveProficiencies ?? []).map((a) => String(a).toUpperCase()));
  const out: RollCheckDefinition[] = [];

  const dex = readAbilityScore(stats, 'DEX');
  const dexMod = adapter.abilityModifier(dex);
  out.push({
    id: 'initiative',
    label: 'Initiative',
    category: 'initiative',
    ability: 'DEX',
    proficiency: null,
    favorite: true,
    modifier: dexMod,
    breakdown: [{ label: 'DEX', value: dexMod }],
    die: 20,
    supportsAdvantage: true,
    supportsDegrees: false,
  });

  for (const ability of DND5E_ABILITY_KEYS) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    out.push({
      id: `ability:${ability}`,
      label: `${ability} check`,
      category: 'ability',
      ability,
      proficiency: null,
      favorite: false,
      modifier: mod,
      breakdown: [{ label: ability, value: mod }],
      die: 20,
      supportsAdvantage: true,
      supportsDegrees: false,
    });
  }

  for (const ability of DND5E_ABILITY_KEYS) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    const proficient = saveProfs.has(ability);
    const breakdown: RollBreakdownComponent[] = [{ label: ability, value: mod }];
    if (proficient) breakdown.push({ label: 'proficient', value: pb });
    out.push({
      id: `save:${ability}`,
      label: `${ability} save`,
      category: 'save',
      ability,
      proficiency: proficient ? 'proficient' : null,
      favorite: proficient,
      modifier: mod + (proficient ? pb : 0),
      breakdown,
      die: 20,
      supportsAdvantage: true,
      supportsDegrees: false,
    });
  }

  for (const { name, ability } of DND5E_SKILLS) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    const rank = character.skills?.[name];
    const profTerm = rank === 'expertise' ? pb * 2 : rank === 'proficient' ? pb : 0;
    const breakdown: RollBreakdownComponent[] = [{ label: ability, value: mod }];
    if (rank === 'expertise') breakdown.push({ label: 'expertise', value: profTerm });
    else if (rank === 'proficient') breakdown.push({ label: 'proficient', value: profTerm });
    out.push({
      id: `skill:${name}`,
      label: name,
      category: 'skill',
      ability,
      proficiency: rank ?? null,
      favorite: rank != null,
      modifier: mod + profTerm,
      breakdown,
      die: 20,
      supportsAdvantage: true,
      supportsDegrees: false,
    });
  }

  return out;
}

/**
 * Map the app's stored 5e-shaped skill rank onto the closest PF2e rank so a PF2e character
 * (whose sheet stores `proficient`/`expertise`) gets honest level-based math. `proficient`
 * → trained, `expertise` → expert; absent → untrained.
 */
function pf2eRankFromSkillRank(rank: SkillRank | undefined): Pf2eProficiencyRank {
  if (rank === 'expertise') return 'expert';
  if (rank === 'proficient') return 'trained';
  return 'untrained';
}

/**
 * Build a PF2e roll catalog for a character (issue #415). PF2e proficiency ADDS YOUR LEVEL on
 * top of a rank bonus, so the breakdown is "ability + level + rank". The app stores 5e-shaped
 * ranks, so they are mapped to PF2e ranks (trained/expert); untrained adds nothing (no level).
 * Degrees of success apply; PF2e has no generic advantage/disadvantage, so roll modes collapse
 * to a single die.
 */
export function pf2eCheckCatalog(adapter: Pf2eRuleSystemAdapter, character: CheckCatalogCharacter): RollCheckDefinition[] {
  const stats = normalizeStats(character.stats);
  const level = Math.max(0, Math.trunc(character.level));
  const saveProfs = new Set((character.saveProficiencies ?? []).map((a) => String(a).toUpperCase()));
  const out: RollCheckDefinition[] = [];

  const buildProfBreakdown = (ability: string, abilityMod: number, rank: Pf2eProficiencyRank): { modifier: number; breakdown: RollBreakdownComponent[] } => {
    const breakdown: RollBreakdownComponent[] = [{ label: ability, value: abilityMod }];
    let modifier = abilityMod;
    if (rank !== 'untrained') {
      breakdown.push({ label: 'level', value: level });
      const rankBonus = adapter.proficiencyBonus(0, rank); // rank bonus only (level term added separately)
      breakdown.push({ label: rank, value: rankBonus });
      modifier += adapter.proficiencyBonus(level, rank);
    }
    return { modifier, breakdown };
  };

  // Initiative is a Perception check in PF2e (WIS, at least trained for PCs).
  const wisMod = adapter.abilityModifier(readAbilityScore(stats, 'WIS'));
  const perc = buildProfBreakdown('WIS', wisMod, 'trained');
  out.push({
    id: 'initiative',
    label: 'Initiative (Perception)',
    category: 'initiative',
    ability: 'WIS',
    proficiency: 'trained',
    favorite: true,
    modifier: perc.modifier,
    breakdown: perc.breakdown,
    die: 20,
    supportsAdvantage: false,
    supportsDegrees: true,
  });

  for (const ability of DND5E_ABILITY_KEYS) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    out.push({
      id: `ability:${ability}`,
      label: `${ability} check`,
      category: 'ability',
      ability,
      proficiency: null,
      favorite: false,
      modifier: mod,
      breakdown: [{ label: ability, value: mod }],
      die: 20,
      supportsAdvantage: false,
      supportsDegrees: true,
    });
  }

  for (const ability of DND5E_ABILITY_KEYS) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    const rank: Pf2eProficiencyRank = saveProfs.has(ability) ? 'trained' : 'untrained';
    const built = buildProfBreakdown(ability, mod, rank);
    out.push({
      id: `save:${ability}`,
      label: `${ability} save`,
      category: 'save',
      ability,
      proficiency: rank === 'untrained' ? null : rank,
      favorite: rank !== 'untrained',
      modifier: built.modifier,
      breakdown: built.breakdown,
      die: 20,
      supportsAdvantage: false,
      supportsDegrees: true,
    });
  }

  for (const { name, ability } of DND5E_SKILLS) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    const rank = pf2eRankFromSkillRank(character.skills?.[name]);
    const built = buildProfBreakdown(ability, mod, rank);
    out.push({
      id: `skill:${name}`,
      label: name,
      category: 'skill',
      ability,
      proficiency: rank === 'untrained' ? null : rank,
      favorite: rank !== 'untrained',
      modifier: built.modifier,
      breakdown: built.breakdown,
      die: 20,
      supportsAdvantage: false,
      supportsDegrees: true,
    });
  }

  return out;
}

/**
 * Honest, configurable fallback catalog for adapters that do not model their own proficiency
 * (issue #415). Everything is derived from the character's OWN stored data rather than a fixed
 * 5e list, so it never claims skills or math a homebrew/unknown system doesn't have:
 *  - ability checks for every attribute the sheet actually stores;
 *  - saves for every attribute the sheet stores, +2 flat when the ability is save-proficient;
 *  - skills for every skill the character has recorded (with a flat proficiency term);
 *  - initiative via the adapter's own `initiativeModifier`.
 * Modes: advantage is offered (harmless d20 keep grammar); degrees are not (only PF2e reports them).
 */
export function neutralCheckCatalog(adapter: RuleSystemAdapter, character: CheckCatalogCharacter): RollCheckDefinition[] {
  const stats = normalizeStats(character.stats);
  const abilityKeys = Object.keys(stats);
  const saveProfs = new Set((character.saveProficiencies ?? []).map((a) => String(a).toUpperCase()));
  // A neutral, flat proficiency term. Systems in this bucket vary, so we use a modest +2 and
  // label it plainly; the breakdown makes the assumption visible rather than hidden.
  const FLAT_PROFICIENCY = 2;
  const out: RollCheckDefinition[] = [];

  const initBase = adapter.initiativeModifier(stats, 'score', character.level);
  const initLevel = adapter.levelInitiativeBonus?.(character.level) ?? 0;
  const initMod = initBase + initLevel;
  const initiativeLabel = adapter.id === ARCHMAGE_ADAPTER_ID ? 'DEX' : 'initiative';
  out.push({
    id: 'initiative',
    label: 'Initiative',
    category: 'initiative',
    ability: null,
    proficiency: null,
    favorite: true,
    modifier: initMod,
    breakdown:
      initLevel !== 0
        ? [
            { label: initiativeLabel, value: initBase },
            { label: 'level', value: initLevel },
          ]
        : [{ label: initiativeLabel, value: initMod }],
    die: adapter.initiativeDie > 0 ? adapter.initiativeDie : 20,
    supportsAdvantage: true,
    supportsDegrees: false,
  });

  for (const ability of abilityKeys) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    out.push({
      id: `ability:${ability}`,
      label: `${ability} check`,
      category: 'ability',
      ability,
      proficiency: null,
      favorite: false,
      modifier: mod,
      breakdown: [{ label: ability, value: mod }],
      die: 20,
      supportsAdvantage: true,
      supportsDegrees: false,
    });
  }

  for (const ability of abilityKeys) {
    const mod = adapter.abilityModifier(readAbilityScore(stats, ability));
    const proficient = saveProfs.has(ability.toUpperCase());
    const breakdown: RollBreakdownComponent[] = [{ label: ability, value: mod }];
    if (proficient) breakdown.push({ label: 'proficient', value: FLAT_PROFICIENCY });
    out.push({
      id: `save:${ability}`,
      label: `${ability} save`,
      category: 'save',
      ability,
      proficiency: proficient ? 'proficient' : null,
      favorite: proficient,
      modifier: mod + (proficient ? FLAT_PROFICIENCY : 0),
      breakdown,
      die: 20,
      supportsAdvantage: true,
      supportsDegrees: false,
    });
  }

  for (const [name, rank] of Object.entries(character.skills ?? {})) {
    const profTerm = rank === 'expertise' ? FLAT_PROFICIENCY * 2 : FLAT_PROFICIENCY;
    out.push({
      id: `skill:${name}`,
      label: name,
      category: 'skill',
      ability: null,
      proficiency: rank,
      favorite: true,
      modifier: profTerm,
      breakdown: [{ label: rank, value: profTerm }],
      die: 20,
      supportsAdvantage: true,
      supportsDegrees: false,
      incomplete: true, // no governing-ability math for a homebrew skill — flag it honestly
    });
  }

  return out;
}

/**
 * Resolve the roll catalog for a campaign's adapter + a character (issue #415). Adapters that
 * implement `buildCheckCatalog` (5e, PF2e) own their math; every other adapter gets the honest
 * configurable {@link neutralCheckCatalog}. This is the single entry point the server, the MCP
 * tools, the character sheet, and the encounter card all call — so the math is identical.
 */
export function checkCatalogForAdapter(adapter: RuleSystemAdapter, character: CheckCatalogCharacter): RollCheckDefinition[] {
  return adapter.buildCheckCatalog?.(character) ?? neutralCheckCatalog(adapter, character);
}

/** Find a single check by its stable id within a character's catalog, or null. */
export function findCheckInCatalog(adapter: RuleSystemAdapter, character: CheckCatalogCharacter, checkId: string): RollCheckDefinition | null {
  return checkCatalogForAdapter(adapter, character).find((c) => c.id === checkId) ?? null;
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
  characterSheet: {
    abilityFields: STANDARD_D20_ABILITY_FIELDS,
    classField: STANDARD_CLASS_FIELD,
    supportsSavingThrowEditor: true,
    supportsSkillEditor: true,
    supportsSpellSlotEditor: false,
    genericModeDescription:
      'Pathfinder 2e uses adapter-owned roll catalog math; Campfire maps its current class, ability, save, skill, and resource fields onto that ruleset.',
  },
  // Character ability SCORES still use the same floor((score-10)/2) mapping as 5e.
  // Creature statblocks store modifiers separately (`abilityRepresentation: 'modifier'`).
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  resources: [
    { key: 'focusPoints', name: 'Focus Points', recharge: 'refocus', defaultMax: 3 },
    { key: 'hitDice', name: 'Hit Dice / Stamina', recharge: 'long-rest' },
    // #1073 — PF2e hero points are a DIFFERENT ECONOMY from 5e inspiration, which is why each
    // system declares its own rather than one being modelled as the other. They accrue during
    // a SESSION (1 at the start, more for heroic deeds), reset between sessions rather than on
    // any rest, and spending ALL of them at once is the "avoid death" move — hence `defaultMax: 3`
    // and, again, `recharge: 'special'` because no rest cadence describes a session boundary.
    { key: 'heroPoints', name: 'Hero Points', recharge: 'special', defaultMax: 3 },
  ],
  // PF2e characters cap at level 20 (Core Rulebook), the same ceiling as 5e.
  maxLevel: 20,
  // PF2e awards 1,000 XP per level; cumulative total at level n is (n-1)×1,000 (issue #441).
  ...xpProgressionFromThresholds(
    Array.from({ length: 20 }, (_, i) => i * 1_000),
    20,
  ),
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
  // PF2e turn workspace (issue #413): the three-action economy plus a reaction — a
  // concrete demonstration that action economy is adapter-defined, not the 5e four.
  actionEconomy: PF2E_ACTION_ECONOMY,
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
  // #1599 — the structured resolver's own save/attack proficiency hook. Distinct from
  // `proficiencyBonus` just above: that one takes an explicit RANK (used by the roll catalog,
  // which knows which skill/save it is building a check for); this one is the resolver's
  // one-argument seam (`ResolverAdapter.checkProficiencyBonus`), which only ever knows a
  // boolean "is this character proficient" — `character.saveProficiencies` records no rank.
  // TRAINED is the correct floor for "marked proficient" with no finer data, the same degrade
  // `initiativeModifier` above already makes for Perception: exact for an actual Trained
  // character, an UNDERSTATEMENT for Expert/Master/Legendary (a real improvement over the
  // previous blanket 0, not a full fix — see ResolverMathProfile's #1599 conclusion for why
  // that residual gap keeps this adapter from declaring `resolverMath`).
  checkProficiencyBonus(level: number): number {
    return pf2eProficiencyBonus(Math.max(0, Math.trunc(level)), 'trained');
  },
  levelBasedDC: pf2eLevelBasedDC,
  simpleDC: pf2eSimpleDC,
  degreeOfSuccess: pf2eDegreeOfSuccess,
  // PF2e crits double the TOTAL, not just the dice (issue #1053): "double the damage after
  // adding all the modifiers, bonuses, and penalties". Inherited by the SF2e adapter below,
  // which spreads this object. Without it the resolver applied 5e's dice-only doubling to
  // every PF2e critical and silently under-reported the modifier.
  criticalDamage: 'double-total',
  // PF2e roll catalog (issue #415): proficiency adds your LEVEL plus a rank bonus, and checks
  // report degrees of success — a concrete demonstration that the catalog math is adapter-owned.
  buildCheckCatalog(character: CheckCatalogCharacter): RollCheckDefinition[] {
    return pf2eCheckCatalog(this, character);
  },
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
// OsrAdapter, OSR_RULE_SYSTEM_SLUGS, OSR_VARIANT_ADAPTERS, tryCreateHomebrewRuleSystemAdapter, and
// OsrMechanicsProfile are imported near the top of this file (see the #1502/#765 note there) —
// `Campaign` needs HomebrewMechanicsProfile from the same module ahead of this block.
export * from './osr-adapter';
import { StarforgedAdapter, STARFORGED_ADAPTER_ID, STARFORGED_PACK_SLUG } from './adapters/starforged';
export * from './adapters/starforged';

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
  // Ironsworn: Starforged (issue #405). Registered under BOTH its family id and the datasworn
  // pack slug a campaign's `ruleSystem` holds (matching the sibling adapters), so this
  // PbtA/narrative pack resolves to the neutral Starforged adapter instead of silently
  // inheriting 5e combat via the unknown-slug fallback. STARFORGED_PACK_SLUG mirrors the
  // importer's DATASWORN_PACK_SLUG ('ironsworn-starforged').
  [STARFORGED_ADAPTER_ID]: StarforgedAdapter,
  [STARFORGED_PACK_SLUG]: StarforgedAdapter,
};
// OSR pack (issue #300, #765): each retroclone slug resolves to its own native adapter.
for (const slug of OSR_RULE_SYSTEM_SLUGS) {
  ADAPTERS[slug] = OSR_VARIANT_ADAPTERS[slug] ?? OsrAdapter;
}

/**
 * Attach each source's installed pack slug(s) to `RULE_PACK_SOURCE_META` (issue #2081), now
 * that the per-system `*_PACK_SLUG` constants exist — `RULE_PACK_SOURCE_META` itself is
 * declared much earlier in this file (the install-validation code above needs it), before
 * most of these constants are. Mutating the already-exported object in place, rather than
 * redeclaring it here, keeps a single object identity: every import of
 * `RULE_PACK_SOURCE_META` resolves only after this module finishes evaluating, so callers
 * always see the complete entries.
 *
 * 'archmage' and 'cepheus' have no schema-side `*_PACK_SLUG` export — their importers live
 * in apps/server (ARCHMAGE_PACK_SLUG in archmage-importer.ts, CEPHEUS_PACK_SLUG in
 * cepheus-importer.ts), which this package cannot import from — so those two are literals,
 * pinned to the importers' actual constants by
 * apps/server/test/unit/importer-only-rule-system.spec.ts. 'other' has no pack slug of its
 * own: RulesService routes it to the Open5e importer (see enqueueInstall/installFromSource),
 * so it installs under DND5E_PACK_SLUG too.
 */
RULE_PACK_SOURCE_META.open5e.packSlug = DND5E_PACK_SLUG;
RULE_PACK_SOURCE_META.pf2e.packSlug = PF2E_PACK_SLUG;
RULE_PACK_SOURCE_META.sf2e.packSlug = SF2E_PACK_SLUG;
RULE_PACK_SOURCE_META['open-legend'].packSlug = OPEN_LEGEND_PACK_SLUG;
RULE_PACK_SOURCE_META.pf1e.packSlug = PF1E_PACK_SLUG;
RULE_PACK_SOURCE_META.starfinder.packSlug = STARFINDER_ADAPTER_ID;
RULE_PACK_SOURCE_META.archmage.packSlug = 'archmage-srd';
RULE_PACK_SOURCE_META.osr.packSlug = OSR_RULE_SYSTEM_SLUGS;
RULE_PACK_SOURCE_META.cepheus.packSlug = 'cepheus-srd';
RULE_PACK_SOURCE_META.datasworn.packSlug = STARFORGED_PACK_SLUG;
RULE_PACK_SOURCE_META.other.packSlug = DND5E_PACK_SLUG;

/**
 * Every pack slug a REGISTERED rule-system source (the table above) actually installs
 * under (issue #2081). Deliberately NOT "every installed `rule_packs` row" — that set is
 * unbounded (uploads and homebrew installs carry arbitrary slugs) and is exactly what made
 * the original guard here reject every homebrew/uploaded pack, not just importer-only ones.
 * This set is bounded to the handful of slugs the registry above actually declares.
 */
const IMPORTER_INSTALLED_PACK_SLUGS: ReadonlySet<string> = new Set(
  Object.values(RULE_PACK_SOURCE_META).flatMap((meta) =>
    Array.isArray(meta.packSlug) ? meta.packSlug : meta.packSlug ? [meta.packSlug] : [],
  ),
);

/**
 * Resolve the adapter for a campaign's `ruleSystem`. `ruleSystem` is a rule-pack slug
 * (or ''); it is matched against the adapter registry and falls back to the 5e adapter
 * for anything unrecognized — so every existing campaign keeps 5e behavior. The default
 * is deliberate, not a stopgap: 5e is the built-in system.
 *
 * `customMechanicsProfile` (issue #1502) is the widened factory seam: a campaign's own
 * persisted, already-validated homebrew profile (`Campaign.customMechanicsProfile`). It is
 * consulted ONLY when `ruleSystem` does not match a built-in registered slug AND the
 * profile's own `slug` equals `ruleSystem` — so it can never override a known system's
 * mechanics, and a stale profile left over from a since-changed `ruleSystem` is silently
 * ignored rather than misapplied. Omitting the second argument is byte-identical to the
 * pre-#1502 behavior — every existing call site keeps working unchanged.
 */
export function ruleSystemAdapter(
  ruleSystem?: string | null,
  customMechanicsProfile?: unknown,
): RuleSystemAdapter {
  if (ruleSystem && isRegisteredRuleSystemSlug(ruleSystem)) return ADAPTERS[ruleSystem];
  if (customMechanicsProfile && typeof customMechanicsProfile === 'object' && customMechanicsProfile !== null) {
    const profileSlug = (customMechanicsProfile as { slug?: string }).slug;
    if (!ruleSystem || profileSlug === ruleSystem) {
      const adapter = tryCreateHomebrewRuleSystemAdapter(customMechanicsProfile);
      if (adapter) return adapter;
    }
  }
  return Dnd5eAdapter;
}

/**
 * Whether `ruleSystem` matches a built-in registered adapter slug (issue #1502) — used
 * server-side to keep a persisted `customMechanicsProfile` from overriding a KNOWN system's
 * mechanics (5e, PF2e, OSR, …) through the homebrew-profile side door.
 */
export function isRegisteredRuleSystemSlug(ruleSystem: string): boolean {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, ruleSystem);
}

/**
 * Whether `ruleSystem` names an "importer-only" rule pack (issue #2081): a pack that a
 * REGISTERED rule-system source installed (`ruleSystem` is a member of
 * {@link IMPORTER_INSTALLED_PACK_SLUGS}, derived from `RULE_PACK_SOURCE_META` above) but
 * which has no entry in {@link ADAPTERS}. Cepheus Engine (2D6 sci-fi) is the current
 * example — it ships a full importer (`cepheus` install source, `cepheus-srd` pack slug)
 * but no combat adapter, so without this guard a campaign that selects it silently
 * inherits the unknown-slug 5e fallback (d20 initiative, 5e ability modifiers on 2D6 UPP
 * scores, 5e conditions/action economy/death saves, `maxLevel: 20`, a 5e XP band) instead
 * of failing loudly.
 *
 * `isInstalledPack` (the caller's own `rule_packs.slug` lookup; this module has no DB
 * access, so it cannot determine that fact itself) still gates the check — a slug that
 * merely COINCIDES with a known importer's pack slug but names no actual installed row is
 * not flagged.
 *
 * A first version of this guard (issue #2081's original PR) was
 * `isInstalledPack && !isRegisteredRuleSystemSlug(ruleSystem)` — "installed, and no
 * adapter" — with no reference to which installer put the pack there. That is a materially
 * larger set than "importer-only": every user-uploaded and homebrew pack is also installed
 * and also has no `ADAPTERS` entry (arbitrary slugs like `dnd-homebrew-srd` were never
 * going to be in a fixed adapter registry), so that version rejected uploaded/homebrew
 * packs identically to Cepheus — breaking `apps/web/e2e/global-setup.ts`'s
 * `e2e-open5e-actions` fixture and `ai-dm-stuck.e2e-spec.ts`'s uploaded `dnd-homebrew-srd`
 * campaign in CI before it could reach `main`. `isRegisteredRuleSystemSlug` alone answers
 * "does this slug have an adapter", not "did an importer install this slug" — the two
 * questions were conflated.
 *
 * The `IMPORTER_INSTALLED_PACK_SLUGS` membership check closes that gap: it is bounded to
 * the small set of slugs `RULE_PACK_SOURCE_META` actually declares, so an arbitrary
 * upload/homebrew/test-fixture slug is never a member and is therefore never flagged,
 * regardless of `isInstalledPack`. The predicate is still NOT `ruleSystem === 'cepheus-srd'`
 * or any other string literal naming Cepheus — it stays derived from the registry, so a
 * future importer that (a) is added to `RULE_PACK_SOURCE_META` with a `packSlug` and
 * (b) ships without a matching `ADAPTERS` entry is caught the same way, by definition, not
 * by editing this function. The trade-off is explicit and deliberately fails closed: an
 * importer that forgets to declare its `packSlug` in step (a) is simply not blocked here
 * (same as any other unrecognized slug), rather than the reverse failure mode of blocking
 * real user content.
 *
 * An arbitrary/unknown/homebrew slug that names NO installed pack is unaffected
 * (`isInstalledPack` is false) — that is the long-standing, deliberate "every existing
 * campaign keeps 5e behavior" default {@link ruleSystemAdapter} documents, not a bug this
 * issue is about. A homebrew slug backed by its own `customMechanicsProfile` never reaches
 * this predicate at all — the server's `validateRuleSystem` short-circuits on a
 * `customMechanicsProfile` before ever doing the installed-pack lookup this predicate needs.
 *
 * Empty `ruleSystem` (the "no rule system picked" sentinel, `''`) always returns false
 * regardless of `isInstalledPack` — no `rule_packs` row can have an empty slug, so a true
 * `isInstalledPack` paired with `''` cannot occur from a real lookup, and the function stays
 * safe to call without first checking `ruleSystem` for truthiness.
 */
export function isImporterOnlyRuleSystemSlug(ruleSystem: string, isInstalledPack: boolean): boolean {
  if (!ruleSystem) return false;
  return isInstalledPack && IMPORTER_INSTALLED_PACK_SLUGS.has(ruleSystem) && !isRegisteredRuleSystemSlug(ruleSystem);
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
 * Determine whether a rule system adapter supports 5e 3-pip death saving throws (issue #424).
 * Returns true for 5e / 5e-derived adapters, false for non-5e systems unless explicitly enabled.
 */
export function hasDeathSavesForAdapter(adapter?: Pick<RuleSystemAdapter, 'id' | 'hasDeathSaves'> | null): boolean {
  if (!adapter) return true;
  return adapter.hasDeathSaves ?? (adapter.id === DND5E_ADAPTER_ID || adapter.id === DND5E_PACK_SLUG);
}

/**
 * Whether an adapter's system endorses the "half or more of the party succeeds" group-check
 * convention (issue #1943). Defaults to false for any adapter that has not declared it — the
 * group-check board always shows the X/N tally, but the advisory verdict text renders only when
 * this is true (5e today).
 */
export function groupCheckMajorityAdvisoryForAdapter(adapter?: Pick<RuleSystemAdapter, 'groupCheckMajorityAdvisory'> | null): boolean {
  return adapter?.groupCheckMajorityAdvisory ?? false;
}

/**
 * Resolve the HP/death model an adapter's combatants are governed by (issue #1503). The one
 * place the default lives: an adapter that has declared {@link RuleSystemAdapter.hpModel} (5e)
 * gets its own model; every adapter that has not (Starforged, Open Legend, OSR, PF2e,
 * Starfinder, 13th Age, and any unaudited or custom system) gets {@link NEUTRAL_HP_MODEL} —
 * 0 HP is "down", no 5e massive-damage instant death, no 5e death-save tracker — never silent
 * 5e death math on a table that isn't 5e. Always read the model through this function so an
 * unaudited adapter is never silently handed 5e's rules.
 *
 * A MISSING adapter (null/undefined) resolves to {@link DND5E_HP_MODEL}, matching
 * {@link hasDeathSavesForAdapter}'s `true` default for the same input — a homebrew/unknown
 * campaign shows the 5e death-save tracker, so the server-resolution flag agrees with the UI
 * capability at that boundary too. In practice {@link ruleSystemAdapter} always returns a
 * resolved adapter (5e fallback), so this null branch is defensive consistency, not a live path
 * (Devin review #1812).
 *
 * `hpModel.deathSaves` agrees with {@link hasDeathSavesForAdapter} for every shipped adapter AND
 * for a missing adapter (both true only for 5e / the default): the former is the server-resolution
 * flag (whether to COMPUTE a death save), the latter the UI capability (whether to SHOW a tracker)
 * — see the parity test.
 */
export function hpModelForAdapter(adapter?: Pick<RuleSystemAdapter, 'hpModel'> | null): HpModel {
  if (!adapter) return DND5E_HP_MODEL;
  return adapter.hpModel ?? NEUTRAL_HP_MODEL;
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
  'a5e open content license',
  'open legend community license',
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

const SELF_AUTHORED_LICENSE_KEYWORDS = [
  'my own work',
  'custom',
  'self',
  'homebrew',
  'original work',
  'author reserved',
];

/**
 * Whether a license string names self-authored original work by the author/DM (issue #1504).
 */
export function isSelfAuthoredLicense(license: string): boolean {
  const l = (license ?? '').trim().toLowerCase();
  if (!l) return false;
  return SELF_AUTHORED_LICENSE_KEYWORDS.some((k) => l.includes(k) || l === k);
}

/**
 * Whether a license string names a recognized open/free-culture license. Used to
 * gate uploaded rule packs (issue #19) so only open-licensed content can be added —
 * proprietary strings ("All Rights Reserved", a publisher name, "Proprietary") are
 * rejected. Substring match, case-insensitive, intentionally permissive about
 * formatting ("OGL 1.0a", "CC-BY-4.0", "Creative Commons Attribution 4.0" all pass).
 * NC-ND and self-authored licenses are not open licenses (issue #1504).
 */
export function isOpenLicense(license: string): boolean {
  const l = (license ?? '').trim().toLowerCase();
  if (!l) return false;
  if (licenseForbidsRedistribution(l)) return false;
  return OPEN_LICENSE_KEYWORDS.some((k) => l.includes(k));
}

/**
 * Whether a license string carries a Creative Commons NonCommercial (NC) or NoDerivatives
 * (ND) restriction, or is self-authored original work (issue #1504), which forbids
 * general redistribution.
 */
export function licenseForbidsRedistribution(license: string): boolean {
  const l = (license ?? '').trim().toLowerCase();
  if (!l) return false;
  if (isSelfAuthoredLicense(l)) return true;
  if (/\bnoncommercial\b|\bnon-commercial\b|\bno[\s-]?deriv\w*/.test(l)) return true;
  // CC short-form tokens: an "-nc" or "-nd" segment, or a bare "nc"/"nd" token.
  return /(^|[\s-])n[cd]([\s-]|$)/.test(l);
}

/**
 * Whether a license string is acceptable for rule pack upload (issue #1504): either a recognized
 * open license or self-authored original work.
 */
export function isValidUploadLicense(license: string): boolean {
  return isOpenLicense(license) || isSelfAuthoredLicense(license);
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
export const RulePackInstallJobStatus = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
export type RulePackInstallJobStatus = z.infer<typeof RulePackInstallJobStatus>;

export const RulePackSectionProgress = z.object({
  section: z.string(), // Open5e section name, or a rule-entry type for uploads
  status: z.enum(['pending', 'running', 'done', 'failed']),
  imported: z.number().int().nonnegative().default(0),
});
export type RulePackSectionProgress = z.infer<typeof RulePackSectionProgress>;

export const RulePackUpdatePreview = z.object({
  added: z.number().int().nonnegative().default(0),
  changed: z.number().int().nonnegative().default(0),
  removed: z.number().int().nonnegative().default(0),
  unchanged: z.number().int().nonnegative().default(0),
  sourceHash: z.string().length(64),
  sourceVersion: z.string().max(40).default(''),
});
export type RulePackUpdatePreview = z.infer<typeof RulePackUpdatePreview>;

/**
 * Status of a background rule-pack install (issue #20). Install is no longer a
 * blocking request: POST /rules/packs/install (or /upload) returns 202 with one of
 * these immediately, and the UI polls GET /rules/packs/install-jobs/:id for progress.
 * `outcome` distinguishes a fresh install ('created') from an incremental add to an
 * existing pack ('updated', which also sets `added`/`skippedExisting`).
 */
export const RulePackInstallJob = z.object({
  id: z.string(), // opaque job id (uuid)
  // Derived from RulePackInstallSource so the two lists can't drift: a new install source
  // automatically becomes a valid job source. 'other' is excluded — it's a back-compat install
  // alias that routes through the Open5e path (newJob('open5e', …)), so a job's source is never
  // literally 'other'. 'upload' is added — it's the one source that only ever exists as a job
  // (RulePackUpload), never as a RulePackInstall.source.
  source: z.enum([...RulePackInstallSource.exclude(['other']).options, 'upload']),
  status: RulePackInstallJobStatus,
  progress: z.array(RulePackSectionProgress).default([]),
  totalSections: z.number().int().nonnegative().default(0),
  completedSections: z.number().int().nonnegative().default(0),
  outcome: z.enum(['created', 'updated']).nullable().default(null),
  pack: RulePack.nullable().default(null), // populated on success
  added: z.number().int().nonnegative().nullable().default(null), // incremental installs only
  skippedExisting: z.number().int().nonnegative().nullable().default(null), // incremental installs only
  changed: z.number().int().nonnegative().nullable().default(null),
  removed: z.number().int().nonnegative().nullable().default(null),
  preview: RulePackUpdatePreview.nullable().default(null),
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

export const RuleSearchFacet = z.object({
  type: RuleEntryType,
  label: z.string().min(1).max(80),
  count: z.number().int().nonnegative(),
});
export type RuleSearchFacet = z.infer<typeof RuleSearchFacet>;

/**
 * Paginated rule-search response (issue #613).
 *
 * Replaces the historical bare `RuleEntry[]` (hard-capped at 50 with no totals).
 * Always includes `total` + `hasMore` so clients never silently truncate; continue
 * with `nextCursor` when `hasMore` is true. `facets` reports the type categories the
 * active pack actually contains (categories absent from the pack are omitted entirely),
 * each carrying a live count for the current query/pack computed *before* the active
 * type filter is applied — so a facet's count always equals what selecting it would
 * return, and a category present in the pack but with no match for the current query is
 * reported with `count: 0` rather than dropped from the chip row (issue #544).
 */
export const RuleSearchPage = z.object({
  items: z.array(RuleEntry),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().max(512).optional(),
  limit: z.number().int().positive(),
  facets: z.array(RuleSearchFacet).default([]),
});
export type RuleSearchPage = z.infer<typeof RuleSearchPage>;

// ---------- encounter link metadata (issue #480) ----------
/** Role-safe resolved label for an encounter's location/quest/session link. */
export const EncounterLinkMeta = z.object({
  id: Id,
  label: z.string(),
});
export type EncounterLinkMeta = z.infer<typeof EncounterLinkMeta>;

/** Compact backlink from a location/quest/session to a linked encounter. */
export const EncounterBacklink = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  status: z.enum(['preparing', 'running', 'ended']),
});
export type EncounterBacklink = z.infer<typeof EncounterBacklink>;

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
  // Role-safe resolved link labels (issue #480).
  locationLink: EncounterLinkMeta.nullable().optional(),
  questLink: EncounterLinkMeta.nullable().optional(),
  sessionLink: EncounterLinkMeta.nullable().optional(),
  combatantCount: z.number().int().nonnegative(),
  // Issue #625: the "down" tally used to sum EVERY combatant at 0 HP / dead — including
  // every dead monster — which inflated a glance at the summary. It now counts only
  // PCs (and NPCs) who fell; defeated monsters are reported separately so each number
  // is meaningful on its own.
  downCount: z.number().int().nonnegative(), // kind='character'|'npc' at 0 HP / down / dead
  monstersDefeated: z.number().int().nonnegative(), // kind='monster' at 0 HP / dead
});
export type EncounterDigest = z.infer<typeof EncounterDigest>;

/**
 * Table-safe character roster entry for campaign aggregates and the Player Display.
 * This is deliberately not a partial `Character`: it is an explicit allowlist that
 * never carries sheet mechanics, ownership, notes, actions, resources, or dmSecret.
 */
export const PartyCharacter = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  species: z.string().max(80).default(''),
  className: z.string().max(80).default(''),
  level: z.number().int().min(1).max(MAX_LEVEL).default(1),
  status: CharacterStatus.default('active'),
  ac: z.number().int().nullable().default(null),
  hpCurrent: z.number().int(),
  hpMax: z.number().int().min(0),
  conditions: z.array(z.string().max(40)).default([]),
  portraitUrl: z.string().max(500).nullable().default(null),
});
export type PartyCharacter = z.infer<typeof PartyCharacter>;

export const CampaignSummary = z.object({
  campaign: Campaign,
  currentLocation: Location.nullable(),
  quests: z.array(Quest.extend({ objectives: z.array(QuestObjective) })),
  npcs: z.array(Npc),
  locations: z.array(Location),
  // Full sheets remain caller-scoped (DM: party; other members: own sheets only).
  characters: z.array(Character),
  // Table-safe roster is independently projected by the server for dashboard/cast use.
  party: z.array(PartyCharacter),
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

export const DiceTheme = z.enum([
  'nocturne',
  'obsidian_gold',
  'arcane_amethyst',
  'dragon_ruby',
  'celestial_pearl',
  'cyberpunk_neon',
  'eldritch_void',
  'mahogany_wood',
]);
export type DiceTheme = z.infer<typeof DiceTheme>;

/**
 * Table audio & haptics level (issue #1920): a single field covers both the
 * on/off toggle and a 3-step volume, so there is no separate "enabled" boolean
 * that could disagree with the level. 'off' is the default and produces zero
 * sound and zero vibration — every cue call site must check this before
 * synthesizing audio or calling `navigator.vibrate`. No media assets are
 * involved: cues are synthesized client-side via WebAudio.
 */
export const TableAudioLevel = z.enum(['off', 'low', 'medium', 'high']);
export type TableAudioLevel = z.infer<typeof TableAudioLevel>;
export { TimeFormat, DEFAULT_TIME_FORMAT } from './timeFormat';
import { TimeFormat } from './timeFormat';

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
  /** Per-player custom 3D dice texture/skin theme. */
  diceTheme: DiceTheme.default('nocturne'),
  /** Clock rendering: system locale default, pinned 12-hour, or pinned 24-hour (issue #634). */
  timeFormat: TimeFormat.default('system'),
  /** Whether to play spectator tumble/crit animations for other players' rolls (issue #1899). */
  animateOthersRolls: z.boolean().default(true),
  /**
   * Issue #851 — "approved organizer" eligibility under the 'approved_organizers'
   * campaign-creation policy. Defaults FALSE, matching the database column and every
   * account-creation path: a brand-new account is not an approved organizer.
   *
   * Upgrade safety lives in migration 0164's one-off backfill of accounts that predate
   * the flag — it is a property of that migration, not of this shape. Stating it as the
   * contract's default told every client the opposite of what the server does, and any
   * consumer filling in the missing field from the declared default would have flipped
   * the permission on. Ignored under the 'everyone'/'admins_only' policies.
   */
  canCreateCampaigns: z.boolean().default(false),
  /**
   * Color-vision-assist mode (issue #1942): adds non-color channels (shape/pattern,
   * glyphs, chevrons) alongside the existing color-only combat indicators — token
   * identity, HP danger escalation, current-turn marker, crit/fumble overlay. Off by
   * default so default-path rendering is unchanged.
   */
  colorVisionAssist: z.boolean().default(false),
  /**
   * Table audio & haptics (issue #1920): synthesized dice-clatter/crit/fumble/
   * your-turn cues and vibration. 'off' by default — no sound or vibration
   * plays until the user opts in. No DM/player distinction and no secrecy
   * interaction: cues fire only on events the viewer already sees.
   */
  tableAudio: TableAudioLevel.default('off'),
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
export const UserUpdate = z.object({ displayName: z.string().max(120).optional(), serverRole: ServerRole.optional(), disabled: z.boolean().optional(), canCreateCampaigns: z.boolean().optional() });
export const PasswordChange = z.object({ currentPassword: z.string().optional(), newPassword: Password }); // current required for self-change; admin reset omits

// Self-service preferences (PATCH /me/preferences) — separate from admin-only UserUpdate above.
export const PreferencesUpdate = z.object({
  displayName: z.string().max(120).optional(),
  accentColor: HexColor.nullable().optional(),
  textSize: TextSize.optional(),
  diceTheme: DiceTheme.optional(),
  timeFormat: TimeFormat.optional(),
  animateOthersRolls: z.boolean().optional(),
  colorVisionAssist: z.boolean().optional(),
  tableAudio: TableAudioLevel.optional(),
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

// Issue #851 — shared-instance governance: who may create/import a campaign at all.
//  - 'everyone'            — any authenticated user (the historical, pre-#851 default;
//                            an upgrading instance must not retroactively lock anyone out).
//  - 'approved_organizers' — server admins, plus any user with User.canCreateCampaigns=true.
//  - 'admins_only'         — real server-admin power only (hasServerAdminPower(), NOT the raw
//                            serverRole — a PAT minted without adminEnabled stays capped).
export const CampaignCreationPolicy = z.enum(['everyone', 'approved_organizers', 'admins_only']);
export type CampaignCreationPolicy = z.infer<typeof CampaignCreationPolicy>;

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
  // Issue #851 — who may create/import a campaign. Defaults to the pre-existing
  // unrestricted behavior so an upgrade never locks out an existing user.
  campaignCreationPolicy: CampaignCreationPolicy.default('everyone'),
  // Issue #851 — per-user / server-wide campaign ceilings. null = unlimited (the
  // pre-existing behavior). "Active" counts only status='active' campaigns; "total"
  // counts every non-trashed campaign (active + paused + completed) a user owns
  // (campaignMembers.primaryOwner) or the server holds.
  maxActiveCampaignsPerUser: z.number().int().positive().nullable().default(null),
  maxTotalCampaignsPerUser: z.number().int().positive().nullable().default(null),
  maxActiveCampaignsServerWide: z.number().int().positive().nullable().default(null),
  maxTotalCampaignsServerWide: z.number().int().positive().nullable().default(null),
  // Issue #851 — operator default storage quota inherited atomically by a brand-new
  // campaign (create/import/clone). null = unlimited (matches the pre-#851 default
  // for every campaign already on disk — this only ever affects NEW rows going
  // forward, never retroactively changes an existing campaign's storageQuotaBytes).
  // `.positive()`, not `.nonnegative()` (review). `null` is already the wire value for
  // "unlimited", so 0 carries no useful meaning — and it is not inert: AttachmentsService
  // enforces any non-null quota, so a stored 0 is a real zero-byte allowance that refuses
  // every upload in every campaign created afterwards. The admin card rejects it, but a
  // client-side guard is not the contract: PATCH /settings validates against
  // ServerSettings.partial(), so any API or MCP caller could persist it. Every sibling
  // ceiling in this block already uses `.positive()`.
  defaultCampaignStorageQuotaBytes: z.number().int().positive().nullable().default(null),
});
export type ServerSettings = z.infer<typeof ServerSettings>;
export const SettingsUpdate = ServerSettings.partial();

/**
 * Issue #851 — effective campaign-creation allowance for the CALLING user, computed
 * server-side (GET /campaigns/allowance) so a wizard/import button can show real
 * numbers before the caller commits to the flow. Never itself an authorization
 * decision surface for the client to trust blindly — the server re-checks every
 * one of these at create/import/clone time regardless of what this reports.
 */
export const CampaignAllowanceReason = z.enum([
  'ok',
  'policy_admins_only',
  'policy_requires_approval',
  'limit_active_per_user',
  'limit_total_per_user',
  'limit_active_server_wide',
  'limit_total_server_wide',
]);
export type CampaignAllowanceReason = z.infer<typeof CampaignAllowanceReason>;

const CampaignAllowanceCounter = z.object({ used: z.number().int().nonnegative(), max: z.number().int().positive().nullable() });
export const CampaignAllowance = z.object({
  policy: CampaignCreationPolicy,
  canCreate: z.boolean(),
  reason: CampaignAllowanceReason,
  activePerUser: CampaignAllowanceCounter,
  totalPerUser: CampaignAllowanceCounter,
  // Server-wide counts are ADMIN-ONLY; null for everyone else (issue #851 review).
  // Every other campaign read in this product is membership-scoped — `GET /campaigns` is,
  // even for a server admin — so handing a viewer-scoped PAT an aggregate over campaigns it
  // has no membership relationship with widens that boundary. A non-admin who is blocked by
  // a server-wide ceiling still learns it from `reason`, which is what they need in order to
  // act; the population figure is not.
  activeServerWide: CampaignAllowanceCounter.nullable(),
  totalServerWide: CampaignAllowanceCounter.nullable(),
  defaultStorageQuotaBytes: z.number().int().nonnegative().nullable(),
  /** Whether the caller already has an undecided creation request pending. */
  hasPendingRequest: z.boolean(),
});
export type CampaignAllowance = z.infer<typeof CampaignAllowance>;

// Issue #851 — the safe request/approval flow for a restricted creation policy.
// Mirrors the shape of the existing forgot-password admin-approved flow
// (passwordResetRequests): a user files a 'pending' row, an admin decides it.
export const CampaignCreationRequestStatus = z.enum(['pending', 'approved', 'denied']);
export type CampaignCreationRequestStatus = z.infer<typeof CampaignCreationRequestStatus>;

export const CampaignCreationRequest = z.object({
  id: Id,
  userId: Id,
  username: z.string(),
  displayName: z.string(),
  status: CampaignCreationRequestStatus,
  note: z.string().max(500).default(''),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});
export type CampaignCreationRequest = z.infer<typeof CampaignCreationRequest>;

export const CampaignCreationRequestCreate = z.object({ note: z.string().max(500).optional() });
export const CampaignCreationRequestDecision = z.object({ note: z.string().max(500).optional() });

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

// ---------- effective permissions (issue #597) ----------

/**
 * What a seat can actually DO, resolved from role + the interactive-guest capability.
 *
 * Exists because "Viewer" was documented as read-only while the server gated notes and
 * comments on bare membership, so a Viewer could comment on anything and whisper any
 * member. Rather than leave the word and the behaviour disagreeing, the capability is
 * now explicit and separately grantable, and this object is what the invite preview and
 * the roster render — so nobody has to infer their authority from a role name again.
 *
 * `canKeepPrivateNotes` is deliberately true even for a read-only Viewer: a private note
 * reaches nobody. The read-only boundary this issue enforces is about content that lands
 * in someone ELSE's view or bell, which is every other flag here.
 */
export const EffectivePermissions = z.object({
  role: Role,
  /** true when this seat may not send anything that reaches another member. */
  readOnly: z.boolean(),
  /** The explicit capability that lets a Viewer take part in discussion. */
  interactiveGuest: z.boolean(),
  canKeepPrivateNotes: z.boolean(),
  canComment: z.boolean(),
  canShareNotes: z.boolean(),
  canWhisper: z.boolean(),
  canSubmitToDmInbox: z.boolean(),
  canEditCampaignContent: z.boolean(),
  canModerate: z.boolean(),
});
export type EffectivePermissions = z.infer<typeof EffectivePermissions>;

/**
 * Resolve a seat's capabilities. Single source of truth: the server gates on it, the
 * invite preview renders it, and the roster shows it, so the three can never drift into
 * telling three different stories about the same seat.
 */
export function effectivePermissionsFor(role: Role, interactiveGuest: boolean): EffectivePermissions {
  const interactive = role !== 'viewer' || interactiveGuest;
  return {
    role,
    readOnly: !interactive,
    interactiveGuest: role === 'viewer' && interactiveGuest,
    canKeepPrivateNotes: true,
    canComment: interactive,
    canShareNotes: interactive,
    canWhisper: interactive,
    canSubmitToDmInbox: interactive,
    canEditCampaignContent: role === 'dm' || role === 'player',
    canModerate: role === 'dm',
  };
}

export const CampaignMember = z.object({
  id: Id,
  campaignId: Id,
  userId: Id,
  role: Role, // dm | player | viewer — per campaign
  characterId: Id.nullable().default(null),
  // Issue #501: this member's explicit consent for their authored campaign source
  // material to be included in prompts sent to external AI providers. DMs cannot
  // widen this on behalf of another member; the self-consent endpoint owns writes.
  //
  // `null` means "not disclosed to you". Consent is a personal preference in a way that a
  // role is not, so the roster reveals it only to the DM — who needs it to understand why
  // material was withheld from a recap — and to the member themselves. A player has no
  // need to learn which of their tablemates declined AI processing.
  aiExternalUseConsent: z.boolean().nullable().default(false),
  // The protected campaign owner/creator seat. Ordinary DM and temporary guest
  // authority cannot demote/remove this seat; see MembersService (#545).
  primaryOwner: z.boolean().default(false),
  // Issue #597: the explicit "interactive guest" capability. Meaningful only on a
  // viewer seat — a viewer WITHOUT it is genuinely read-only (no comments, no shared
  // notes, no whispers, no DM-inbox posts); a viewer WITH it may take part in
  // discussion without gaining any authority over campaign content. Players and DMs
  // are interactive by role, so the flag is not consulted for them.
  interactiveGuest: z.boolean().default(false),
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
  // Issue #597: grant/revoke the interactive-guest capability on a viewer seat.
  interactiveGuest: z.boolean().optional(),
});

export const MemberAiConsentUpdate = z.object({
  aiExternalUseConsent: z.boolean(),
});
export type MemberAiConsentUpdate = z.infer<typeof MemberAiConsentUpdate>;

export const GuestDmGrantScope = z.enum(['dm', 'membership_admin', 'destructive']);
export type GuestDmGrantScope = z.infer<typeof GuestDmGrantScope>;

export const GuestDmGrant = z.object({
  id: Id,
  campaignId: Id,
  granteeUserId: Id,
  grantedByUserId: Id.nullable().default(null),
  scopes: z.array(GuestDmGrantScope).default(['dm']),
  startsAt: IsoDate,
  expiresAt: IsoDate,
  revokedAt: IsoDate.nullable().default(null),
  handedBackAt: IsoDate.nullable().default(null),
  username: z.string().default(''),
  displayName: z.string().default(''),
  ...timestamps,
});
export type GuestDmGrant = z.infer<typeof GuestDmGrant>;

const GuestDmGrantScopesInput = z
  .array(GuestDmGrantScope)
  .min(1)
  .max(3)
  .default(['dm'])
  .transform((scopes) => [...new Set(scopes)]);

export const GuestDmGrantCreate = z.object({
  granteeUserId: Id,
  scopes: GuestDmGrantScopesInput.optional(),
  startsAt: IsoDate.optional(),
  expiresAt: IsoDate,
});
export type GuestDmGrantCreate = z.infer<typeof GuestDmGrantCreate>;

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

// Public preview of a valid invite (GET /invites/:code) — what you're joining, as what,
// and (issue #600) WHAT THE TABLE HAS AGREED TO. campaignId is included so the web app
// can navigate to /c/:id after joining.
//
// Issue #600 added `charter`/`consentRequired`: previously this returned a campaign name
// and a role, so the only way to discover a table's lines and veils was to join it —
// which is the commitment the boundaries were supposed to inform. The charter here is a
// privacy-safe projection of a PUBLISHED version only (see CharterPreview); it is null
// when the campaign has never published one, and joining is then ungated exactly as
// before.
export const InvitePreview = z.object({
  campaignId: Id,
  campaignName: z.string(),
  role: InviteRole,
  expiresAt: IsoDate,
  // Issue #597: the join page must say what the seat can DO, not just name its role.
  // "Viewer" told a joiner nothing verifiable — and until this issue it was actively
  // misleading. An invite always seats a read-only viewer or a full player; the
  // interactive-guest capability is granted afterwards by a DM, never by a link.
  permissions: EffectivePermissions,
  charter: CharterPreview.nullable().default(null),
  /**
   * True when the campaign has a published charter, so POST /invites/:code/join and
   * /accept require `acknowledgeVersion`. False for campaigns that never published —
   * their join flow is unchanged, which is what keeps this backwards compatible.
   */
  consentRequired: z.boolean().default(false),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

// Accept an invite as a brand-new user (POST /invites/:code/accept, @Public):
// creates the account AND the membership in one call, then starts a session.
export const InviteAccept = z.object({
  username: User.shape.username,
  password: Password,
  displayName: z.string().max(120).optional(),
  /**
   * Issue #600: the charter version number the joiner is agreeing to. REQUIRED when the
   * campaign has published a charter, and it must be the CURRENT version — accepting a
   * stale one would let a link shared before a material change carry consent across it.
   * Omitted (and ignored) for campaigns that never published, whose join flow is
   * unchanged.
   *
   * The per-campaign VERSION NUMBER rather than the row id: this travels to an
   * unauthenticated caller, and a global autoincrement id would disclose roughly how many
   * charter versions exist server-wide for no benefit. The number is already on the
   * preview.
   */
  acknowledgeVersion: z.number().int().positive().optional(),
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
  /**
   * Which full-text search backend this install booted with (issue #1481):
   * `'fts5'` when SQLite's FTS5 extension is available (the fast, prefix-token
   * index), `'fallback'` when it is not (a JS full-scan with the same matching
   * semantics). Surfaced on `/me` so a deployment whose search silently degraded
   * to the fallback is diagnosable without shell access. Optional only so older
   * clients / fixtures that pre-date the field keep parsing; the server always
   * sets it.
   */
  searchMode: z.enum(['fts5', 'fallback']).optional(),
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

export const AiGenerationProvenance = z.object({
  source: z.enum(['ai_scribe', 'co_dm', 'ai_dm_driver', 'map_generation']),
  provider: z.string().max(120),
  providerType: z.string().max(80).nullable().default(null),
  model: z.string().max(200),
  endpoint: z.object({
    scope: z.enum(['campaign', 'server', 'injected', 'none']).default('none'),
    baseUrl: z.string().max(1000).nullable().default(null),
  }),
  sourceIds: z.record(z.string(), z.array(z.union([Id, z.string()])).or(Id).or(z.string()).or(z.null())).default({}),
  sourceHash: z.string().nullable().default(null),
  promptVersion: z.string().max(80),
  promptHash: z.string(),
  ruleset: z.object({
    id: z.string(),
    pack: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
  }).optional(),
  consent: z.object({
    campaignPolicy: AiExternalContentPolicy,
    /**
     * Whether this generation actually handed content to an endpoint OFF this server,
     * and therefore whether the member EXTERNAL-use consent gate applied to the material.
     *
     * `false` means the text came from the built-in no-op/injected seam, or from an
     * endpoint the operator explicitly declared local — nothing left the deployment, so
     * external-use consent was not the applicable gate (issue #501 is scoped to external
     * use). Without this flag a stored blob reading `excludedInboxByConsent: 0` is
     * ambiguous between "every author consented" and "no consent gate was applied";
     * provenance must not be ambiguous about that.
     *
     * Defaults to `true`: fail-closed for an unrecognised blob, and historically accurate
     * for rows written before the flag existed (the filter always ran, sends were external).
     *
     * Known edge: this records the egress resolved at ASSEMBLY time. If the provider row is
     * removed between assembly and generation, the run falls back to the local seam while
     * this stays `true` — an over-report. That drift direction is deliberately tolerated;
     * the reverse (assembled local, then sent externally) is refused outright by the
     * ordering interlock in `ScribeService.run`.
     */
    externalSend: z.boolean().default(true),
    includedAuthorUserIds: z.array(z.string()).default([]),
    excludedAuthorUserIds: z.array(z.string()).default([]),
    includedInboxCount: z.number().int().nonnegative().default(0),
    /**
     * Notes the EXTERNAL-USE gate withheld — for either reason it can fire.
     *
     * Read `campaignPolicy` for the cause, which fully determines it: under `disabled` the
     * gate rejects every shareable note regardless of who consented, so all of these are
     * policy-excluded and none are consent-excluded; under `member_consent` the reverse.
     * They never mix, which is why this is one truthful total rather than two counters
     * where one is always zero. The distinction matters because the remedies differ — a
     * disabled policy is the DM's to change, and no amount of member opt-in affects it.
     */
    excludedInboxByConsent: z.number().int().nonnegative().default(0),
    excludedInboxPrivate: z.number().int().nonnegative().default(0),
  }).optional(),
  retentionNotice: z.string().max(1000),
  createdAt: IsoDate,
});
export type AiGenerationProvenance = z.infer<typeof AiGenerationProvenance>;

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
  // Revision token of the target entity at propose time (update/delete only; null for
  // creates and legacy rows). Paired with baseSnapshotHash for approve-time stale
  // detection (issue #681).
  baseUpdatedAt: z.string().nullable().default(null),
  // sha256 of the canonical base snapshot JSON at propose time. On approve, the live
  // entity must still match this hash or the server returns 409 STALE_PROPOSAL_TARGET
  // with a three-way diff (base / current / proposed).
  baseSnapshotHash: z.string().nullable().default(null),
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
  // AI generation provenance (issue #501). Null for manual/collab proposals and
  // legacy rows. AI-authored proposals keep the model/provider/source/prompt/consent
  // record durably so approval, audit, and exports remain explainable later.
  generationProvenance: AiGenerationProvenance.nullable().default(null),
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
      // #1022: the seat can ORIGINATE a fight, not just run one a human built. That is a
      // materially different authority from "advances combat turns" and a DM deciding whether
      // to enable Driver mode deserves to see it named, so it carries a real copyKeyword.
      // What it CANNOT do is decide visibility: every encounter it creates is DM-only prep
      // until the human DM reveals it (guardDriverLivePlayArgs), which is why the copy says
      // "prepped" rather than implying the table sees them.
      { label: 'creates encounters as DM-only prep', copyKeyword: 'encounter' },
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

/**
 * Canonical privacy boundary for optional external AI providers (issue #455).
 * Campfire is local-by-default: campaign data lives on your server. When an admin
 * or DM configures an OpenAI-compatible, Anthropic, or Gemini provider, selected
 * campaign context is sent to that endpoint for AI DM turns, Co-DM drafts, scribe
 * recaps, and map generation. Trust copy (login page, provider settings, docs) and
 * the policy-backed unit test both read from here so the words stay anchored to
 * what the server actually sends.
 */
export interface AiExternalProviderContextCategory {
  /** Short label for UI lists. */
  label: string;
  /** One-line description of what may leave the server when a provider is enabled. */
  description: string;
  /**
   * A keyword the privacy notice must mention so a copy edit cannot quietly drop a
   * category the server may send (mirrors AI_DM_MODE_CAPABILITIES.copyKeyword).
   */
  copyKeyword: string;
}

export const AI_EXTERNAL_PROVIDER_PRIVACY = {
  /** Deep-link anchor for the provider privacy notice in settings / admin UI. */
  settingsAnchorId: 'ai-provider-privacy',
  loginTagline:
    'Open-source and free to self-host · your campaign data stays on your server by default; enabling an external AI provider sends only the context listed in its privacy notice.',
  loginFeatureTitle: 'Self-hosted & private',
  loginFeatureBody:
    'Your table, your server, your data. Campaign content stays local unless you opt in to an external AI provider — then only the disclosed context leaves for generation. Export the whole campaign to JSON or Markdown anytime.',
  noticeTitle: 'External AI provider privacy',
  localByDefault:
    'By default Campfire stores your campaign on this server and does not contact any LLM vendor. Connected MCP agents read through the API; their traffic stays between your agent and your server unless you point the agent at an external model.',
  externalException:
    'When you configure and save an external provider (OpenAI-compatible, Anthropic, or Gemini), Campfire sends prompts to that endpoint for the AI DM seat, Co-DM drafts, scheduled scribe recaps, and map generation. Only the context categories below are included — including DM steering you configure. Hidden entities, dmSecret fields, and other DM-only secrets are stripped by default unless you explicitly opt in (map generation only).',
  contextCategories: [
    {
      label: 'Campaign summary',
      description: 'Player-visible campaign overview (hidden entities and dmSecret fields excluded).',
      copyKeyword: 'summary',
    },
    {
      label: 'Session-zero charter',
      description: 'Agreed lines, veils, safety tools, and house rules.',
      copyKeyword: 'charter',
    },
    {
      label: 'Live world state',
      description: 'Calendar, running encounters, party status, and current location/environment.',
      copyKeyword: 'world',
    },
    {
      label: 'DM steering',
      description: 'Per-campaign persona and house rules you write in AI DM settings (DM-only).',
      copyKeyword: 'steering',
    },
    {
      label: 'Turn prompts & tool reads',
      description: 'What players said, plus player-scoped tool results during AI turns (secrets redacted).',
      copyKeyword: 'tool',
    },
    {
      label: 'Co-DM / scribe source material',
      description: 'Your brief or session notes sent for drafting proposals or recaps.',
      copyKeyword: 'scribe',
    },
    {
      label: 'Map generation prompts',
      description: 'Your map prompt and theme; campaign secrets only if you check the explicit opt-in.',
      copyKeyword: 'map',
    },
    {
      label: 'Authorized supports',
      description: 'Practical access supports a participant has explicitly consented to share with AI narration.',
      copyKeyword: 'consent',
    },
  ] satisfies readonly AiExternalProviderContextCategory[],
  exclusions: [
    'Stored API keys (write-only; never sent to any provider)',
    'DM-only secrets by default (hidden entities, dmSecret fields, unexplored locations)',
    "Other campaigns' data",
    'Map campaign secrets unless you explicitly opt in per request',
  ],
  retentionNote:
    "Campfire does not control how your chosen provider stores or retains prompts, tool results, or model replies. Review that vendor's privacy policy and data-retention terms before saving a provider. Removing a provider stops new outbound calls; it does not erase data already held by the vendor.",
} as const;

export const AiDmProactiveSettings = z.object({
  enabled: z.boolean().default(false),
  triggers: z.object({
    encounterEnded: z.boolean().default(true),
    hpCritical: z.boolean().default(true),
    objectiveCompleted: z.boolean().default(true),
    npcTurn: z.boolean().default(true),
  }).default({ encounterEnded: true, hpCritical: true, objectiveCompleted: true, npcTurn: true }),
  cooldownSeconds: z.number().int().min(30).max(3600).default(300),
  maxProactiveTokensPerHour: z.number().int().min(0).max(50_000).default(5_000),
});
export type AiDmProactiveSettings = z.infer<typeof AiDmProactiveSettings>;

/**
 * STRUCTURED TABLE STYLE (#1049). Before this, the only way to steer the AI's voice was the
 * freeform `instructions` textarea — which works if you already know what to write, and
 * leaves everyone else with a blank box and no hint that pacing or NPC depth were dials at all.
 *
 * WHAT THESE ARE, PLAINLY: prompt text. Each chosen value adds a line of guidance to the
 * system prompt. That is a REQUEST TO A LANGUAGE MODEL, not a control the server enforces —
 * nothing here is checked against the narration that comes back, and a model may ignore any
 * of it. They earn their place because a stated preference measurably shifts output, not
 * because it guarantees anything. Do not describe them to users as rules.
 *
 * `'default'` on every axis means "state no preference", and renders NOTHING. An
 * unconfigured seat therefore produces a byte-identical prompt to the one it produced before
 * #1049 — this feature costs zero tokens until a DM opts into it.
 *
 * The values are closed enums rather than free text on purpose. A bounded vocabulary gives
 * the rendered section a KNOWN WORST CASE (see {@link AI_DM_STYLE_SECTION_MAX_TOKENS}), which
 * is what lets it share a prompt with elastic consumers without silently squeezing them.
 * Free-text style fields would have no such bound.
 */
export const AiDmTone = z.enum(['default', 'gritty', 'heroic', 'whimsical', 'noir', 'cozy']);
export type AiDmTone = z.infer<typeof AiDmTone>;

export const AiDmPacing = z.enum(['default', 'brisk', 'deliberate']);
export type AiDmPacing = z.infer<typeof AiDmPacing>;

export const AiDmVerbosity = z.enum(['default', 'concise', 'vivid']);
export type AiDmVerbosity = z.infer<typeof AiDmVerbosity>;

export const AiDmCombatStyle = z.enum(['default', 'tactical', 'cinematic', 'lethal', 'forgiving']);
export type AiDmCombatStyle = z.infer<typeof AiDmCombatStyle>;

export const AiDmNpcDepth = z.enum(['default', 'light', 'deep']);
export type AiDmNpcDepth = z.infer<typeof AiDmNpcDepth>;

export const AI_DM_STYLE_PRESET_DEFAULTS = {
  tone: 'default',
  pacing: 'default',
  verbosity: 'default',
  combatStyle: 'default',
  npcDepth: 'default',
} as const;

export const AiDmStylePresets = z
  .object({
    tone: AiDmTone.default('default'),
    pacing: AiDmPacing.default('default'),
    verbosity: AiDmVerbosity.default('default'),
    combatStyle: AiDmCombatStyle.default('default'),
    npcDepth: AiDmNpcDepth.default('default'),
  })
  .default({ ...AI_DM_STYLE_PRESET_DEFAULTS });
export type AiDmStylePresets = z.infer<typeof AiDmStylePresets>;

/**
 * Ceiling for the rendered `## Table style` section, in the repo's ~4-chars-per-token
 * estimate. NOT a runtime trim — the section is built from a closed enum, so its true worst
 * case is a compile-time constant, and a unit test asserts this constant still holds.
 *
 * It exists so the section's cost is a REVIEWABLE NUMBER rather than an assumption. The AI
 * Driver's system prompt is shared with elastic consumers (live world state, and the bounded
 * conversation history of #1038), and a style block that could grow without limit would
 * quietly crowd them out. Because this one cannot, those budgets are deliberately left
 * untouched: making history shrink when a DM picks a tone would mean changing your table's
 * voice silently costs the AI its memory — a far worse surprise than a couple of hundred
 * fixed tokens.
 *
 * 250 with the true worst case measured at 226 (all five axes on their longest option). The
 * headroom is for a preset or two more; a change that exceeds it fails the unit test rather
 * than silently eating another feature's budget, which is the point of stating it at all.
 */
export const AI_DM_STYLE_SECTION_MAX_TOKENS = 250;

/**
 * Option lists for the seat-config dropdowns, following the `NARRATION_LANGUAGE_OPTIONS`
 * pattern: labels live beside the enum so the form cannot drift out of sync with the values
 * the server accepts. `default` leads every axis because it is the shipped state.
 */
const AI_DM_STYLE_LABELS = {
  tone: {
    default: 'Default (no preference)',
    gritty: 'Gritty — consequences bite',
    heroic: 'Heroic — competent and bright',
    whimsical: 'Whimsical — playful and absurd',
    noir: 'Noir — moral greys, rain-slick',
    cozy: 'Cozy — warm and low-stakes',
  },
  pacing: {
    default: 'Default (no preference)',
    brisk: 'Brisk — cut to the moment',
    deliberate: 'Deliberate — let scenes breathe',
  },
  verbosity: {
    default: 'Default (no preference)',
    concise: 'Concise — short beats',
    vivid: 'Vivid — rich description',
  },
  combatStyle: {
    default: 'Default (no preference)',
    tactical: 'Tactical — positions and options',
    cinematic: 'Cinematic — momentum and imagery',
    lethal: 'Lethal — enemies fight to win',
    forgiving: 'Forgiving — setbacks over death',
  },
  npcDepth: {
    default: 'Default (no preference)',
    light: 'Light — a name and a trait',
    deep: 'Deep — voices and motives',
  },
} as const;

function styleOptions<T extends string>(values: readonly T[], labels: Record<T, string>) {
  return values.map((value) => ({ value, label: labels[value] }));
}

export const AI_DM_STYLE_PRESET_OPTIONS = {
  tone: styleOptions(AiDmTone.options, AI_DM_STYLE_LABELS.tone),
  pacing: styleOptions(AiDmPacing.options, AI_DM_STYLE_LABELS.pacing),
  verbosity: styleOptions(AiDmVerbosity.options, AI_DM_STYLE_LABELS.verbosity),
  combatStyle: styleOptions(AiDmCombatStyle.options, AI_DM_STYLE_LABELS.combatStyle),
  npcDepth: styleOptions(AiDmNpcDepth.options, AI_DM_STYLE_LABELS.npcDepth),
} as const;

/** Axis order + field labels for the seat-config form, so the UI iterates instead of repeating. */
export const AI_DM_STYLE_PRESET_AXES = [
  { key: 'tone', label: 'Tone' },
  { key: 'pacing', label: 'Pacing' },
  { key: 'verbosity', label: 'Verbosity' },
  { key: 'combatStyle', label: 'Combat style' },
  { key: 'npcDepth', label: 'NPC depth' },
] as const;

/**
 * COMPREHENSION PROFILE (issue #874).
 *
 * A DIFFERENT axis from {@link AiDmStylePresets}. Style is a taste preference (voice, tone);
 * this is an ACCESSIBILITY preference — how readable a turn's narration is for the humans at
 * THIS table, independent of what voice the DM likes. Same mechanism as #1049 on purpose: a
 * closed, bounded set of dropdowns that complement the freeform `instructions` textarea rather
 * than replace it, and `'default'` on every axis states no preference.
 *
 * Its COST is not #1049's, and the difference matters for prompt-budget expectations (review).
 * Table style renders nothing at all until a DM opts in. This section always renders: its
 * baseline IS the issue's stated default behaviour, owed to every table whether or not anyone
 * has visited the settings page. So an all-`'default'` profile costs the baseline section, and
 * it is only the four per-axis LINES that are zero-cost while left on `'default'`. The whole
 * section is bounded by `AI_DM_COMPREHENSION_SECTION_MAX_TOKENS`.
 *
 * The four axes are exactly the issue's acceptance criteria: how complex the vocabulary/sentence
 * structure may be, how long a paragraph runs before breaking, how much sensory description to
 * layer in, and how many suggested actions to close a turn with. All four are prompt GUIDANCE —
 * see driver-comprehension.ts, the pure renderer, for the baseline behaviour (chunking, the
 * "What changed" / "What can you do" ending, non-exclusive suggestions alongside free-form
 * input, and support for a player's Simplify/Recap/Explain requests) that applies REGARDLESS of
 * these axis choices, matching the issue's title: none of this ever narrows what a player may
 * type back.
 */
export const AiDmReadingComplexity = z.enum(['default', 'simple', 'standard', 'rich']);
export type AiDmReadingComplexity = z.infer<typeof AiDmReadingComplexity>;

export const AiDmParagraphLength = z.enum(['default', 'short', 'standard', 'long']);
export type AiDmParagraphLength = z.infer<typeof AiDmParagraphLength>;

export const AiDmSensoryIntensity = z.enum(['default', 'minimal', 'standard', 'vivid']);
export type AiDmSensoryIntensity = z.infer<typeof AiDmSensoryIntensity>;

/** How many non-exclusive suggested actions should close a turn (baseline default is 2-4). */
export const AiDmChoiceCount = z.enum(['default', 'two', 'three', 'four']);
export type AiDmChoiceCount = z.infer<typeof AiDmChoiceCount>;

export const AI_DM_COMPREHENSION_PROFILE_DEFAULTS = {
  readingComplexity: 'default',
  paragraphLength: 'default',
  sensoryIntensity: 'default',
  choiceCount: 'default',
} as const;

export const AiDmComprehensionProfile = z
  .object({
    readingComplexity: AiDmReadingComplexity.default('default'),
    paragraphLength: AiDmParagraphLength.default('default'),
    sensoryIntensity: AiDmSensoryIntensity.default('default'),
    choiceCount: AiDmChoiceCount.default('default'),
  })
  .default({ ...AI_DM_COMPREHENSION_PROFILE_DEFAULTS });
export type AiDmComprehensionProfile = z.infer<typeof AiDmComprehensionProfile>;

/**
 * Ceiling for the WHOLE rendered `## Comprehension` section — its fixed baseline (see
 * driver-comprehension.ts) PLUS whatever optional per-axis lines a DM's choices add on top.
 * Mirrors {@link AI_DM_STYLE_SECTION_MAX_TOKENS} for the same reason: a closed enum for the
 * optional axes gives a compile-time worst case, asserted by a unit test, so this section can
 * share a prompt with elastic consumers without crowding them. Unlike the style section this
 * ceiling is never zero-cost — the baseline alone is a real, unconditional per-turn cost — so
 * the unit test also pins the baseline-only figure to keep it a reviewable number on its own.
 *
 * Held at 290 through review. Subordinating the ending shape to the session phase direction
 * was first written as its own bullet, which took the worst case to ~321 and the COMBINED
 * #1038 x #1049 x #874 budget past half a 4k context window. The guards caught it, so the
 * qualification was folded into the ending-shape line instead of the ceiling being raised.
 */
export const AI_DM_COMPREHENSION_SECTION_MAX_TOKENS = 290;

const AI_DM_COMPREHENSION_LABELS = {
  readingComplexity: {
    default: 'Default (no preference)',
    simple: 'Simple — plain words, short sentences',
    standard: 'Standard — everyday vocabulary',
    rich: 'Rich — fuller vocabulary, longer sentences',
  },
  paragraphLength: {
    default: 'Default (no preference)',
    short: 'Short — 1-2 sentences per beat',
    standard: 'Standard — a few sentences per beat',
    long: 'Long — fuller paragraphs, fewer breaks',
  },
  sensoryIntensity: {
    default: 'Default (no preference)',
    minimal: 'Minimal — only what a player needs to act',
    standard: 'Standard — a moderate amount of detail',
    vivid: 'Vivid — rich sensory description',
  },
  choiceCount: {
    default: 'Default (2-4, at the AI’s judgement)',
    two: 'Two suggestions',
    three: 'Three suggestions',
    four: 'Four suggestions',
  },
} as const;

export const AI_DM_COMPREHENSION_PROFILE_OPTIONS = {
  readingComplexity: styleOptions(AiDmReadingComplexity.options, AI_DM_COMPREHENSION_LABELS.readingComplexity),
  paragraphLength: styleOptions(AiDmParagraphLength.options, AI_DM_COMPREHENSION_LABELS.paragraphLength),
  sensoryIntensity: styleOptions(AiDmSensoryIntensity.options, AI_DM_COMPREHENSION_LABELS.sensoryIntensity),
  choiceCount: styleOptions(AiDmChoiceCount.options, AI_DM_COMPREHENSION_LABELS.choiceCount),
} as const;

/** Axis order + field labels for the seat-config form, matching {@link AI_DM_STYLE_PRESET_AXES}. */
export const AI_DM_COMPREHENSION_PROFILE_AXES = [
  { key: 'readingComplexity', label: 'Reading complexity' },
  { key: 'paragraphLength', label: 'Paragraph length' },
  { key: 'sensoryIntensity', label: 'Sensory intensity' },
  { key: 'choiceCount', label: 'Suggested choices' },
] as const;

// One AI-DM "seat" per campaign (created lazily on first configure/read).
export const AiDmSeat = z.object({
  campaignId: Id,
  mode: AiDmMode.default('off'), // operating mode: off / co_dm / driver (issue #311)
  enabled: z.boolean().default(false), // per-campaign on/off (in addition to the server flag)
  model: z.string().max(120).default(''), // informational label of the model/agent occupying the seat
  instructions: z.string().max(20_000).default(''), // the DM persona / house rules the connected agent should follow
  // Per-campaign metering, in tokens. tokenBudget is a HARD cap enforced by
  // reserving capacity before provider contact (#563). 0 = no budget → no turns
  // allowed (a positive budget must be configured to run the seat).
  tokenBudget: z.number().int().nonnegative().max(1_000_000_000).default(0),
  tokensUsed: z.number().int().nonnegative().default(0),
  tokensReserved: z.number().int().nonnegative().default(0), // active in-flight provider reservations
  tokensRefunded: z.number().int().nonnegative().default(0), // cumulative unused reservation returned
  tokensUnknown: z.number().int().nonnegative().default(0), // conservative spend when provider usage is unknown
  tokensOverage: z.number().int().nonnegative().default(0), // known usage above its pre-call reservation
  budgetRemaining: z.number().int().nonnegative().default(0), // after used + reserved + unknown
  turnCount: z.number().int().nonnegative().default(0),
  lastTurnAt: IsoDate.nullable().default(null),
  proactiveSettings: AiDmProactiveSettings.default({}),
  /** Structured table style (#1049) — prompt guidance, not enforcement. See AiDmStylePresets. */
  stylePresets: AiDmStylePresets.default({ ...AI_DM_STYLE_PRESET_DEFAULTS }),
  /** Comprehension profile (#874) — prompt guidance, not enforcement. See AiDmComprehensionProfile. */
  comprehensionProfile: AiDmComprehensionProfile.default({ ...AI_DM_COMPREHENSION_PROFILE_DEFAULTS }),
  actionQueueDepth: z.number().int().min(1).max(20).default(8).optional(),
  /**
   * Which fields on THIS seat came from the server defaults rather than from a DM's own
   * configuration (#1070). Empty for any campaign that has configured its seat, because
   * inheritance detaches whole-seat on first configure — see AI_DM_SEAT_INHERITED_FIELDS.
   *
   * Read-only and derived: the server computes it per read, and the update DTO has no
   * counterpart. It exists so a DM can see an inherited token budget BEFORE enabling the
   * seat, which is the point at which it could start spending.
   */
  inheritedFields: z.array(z.string()).default([]),
  ...timestamps,
});
export type AiDmSeat = z.infer<typeof AiDmSeat>;

/**
 * Session phase for the AI driver's per-profile tool policy (#474 / #1495): prep, live combat, a
 * brief post-fight aftermath, or neutral downtime (no encounter running, prepping, or recently
 * ended). Shared between the server's tool-policy engine and the web tool-confirmation queue so
 * a server-side profile change cannot compile while the client's independent copy silently
 * drifts (issue #1495) — see AGENTS.md's "do not redefine shared domain shapes" rule.
 */
export const DriverSessionProfile = z.enum(['prep', 'live', 'aftermath', 'downtime']);
export type DriverSessionProfile = z.infer<typeof DriverSessionProfile>;

/** How the AI driver may commit a tool call under the campaign's per-profile policy (#474). */
export const DriverToolPolicyClass = z.enum(['auto', 'confirm', 'propose', 'deny']);
export type DriverToolPolicyClass = z.infer<typeof DriverToolPolicyClass>;

/**
 * A DM-reviewed, queued confirm-policy tool call awaiting approval (#474), as returned by
 * `GET /campaigns/:id/ai-dm/tool-confirmations`. `args` is intentionally an opaque record: it
 * carries whatever arguments the specific tool named in `tool` accepts.
 */
export const AiDmToolConfirmation = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  toolCallId: z.string(),
  profile: DriverSessionProfile,
  policy: DriverToolPolicyClass,
  requestedAt: IsoDate,
  actor: z.string(),
  triggeredBy: z.string(),
  turnNumber: z.number().int().nonnegative(),
});
export type AiDmToolConfirmation = z.infer<typeof AiDmToolConfirmation>;

/**
 * The AI DM seat's most recent committed action a DM can still reverse (#1501). The model has
 * always been able to call `undo_action` with the `undoToken` a resolve/apply returned; this
 * captures that same chain server-side so a DM-only control can drive the existing undo path
 * without holding a client token. Only `chainId` (and `encounterId` for the cross-encounter
 * guard) are trusted; `actionName` is display-only. Projected to DMs only (its encounterId could
 * name a DM-only hidden fight), cleared on a successful undo (including one the seat performs
 * itself), and never persisted across restart.
 */
export const DriverLastUndoableCommit = z.object({
  encounterId: z.number().int(),
  actorCombatantId: z.number().int(),
  chainId: z.string(),
  actionName: z.string(),
  committedAt: IsoDate,
});
export type DriverLastUndoableCommit = z.infer<typeof DriverLastUndoableCommit>;

/**
 * SERVER-WIDE AI SEAT DEFAULTS (#1070).
 *
 * A multi-campaign DM used to reconfigure the AI seat from scratch every time: `defaultSeat`
 * gave mode `off`, budget `0`, instructions `''`, and only the PROVIDER inherited server-wide.
 * These are the fields a brand-new campaign picks up instead.
 *
 * INHERITANCE, NOT COPYING. This mirrors the provider's existing mechanism
 * (`resolveEffectiveConfig`: `campaign ?? server`, evaluated live) rather than adding a
 * second model. Live beats a snapshot — an admin fixing a bad default fixes every campaign
 * that never overrode it, which a "copy config from campaign X" action cannot do. Copying was
 * considered and declined: it would need a cross-campaign seat read that does not exist
 * today, i.e. a new authorization surface, in exchange for a snapshot that is stale on
 * arrival.
 *
 * DETACH IS WHOLE-SEAT, exactly like the provider's row-granularity override: while a
 * campaign has no seat row it tracks these live; the first configure creates a row seeded
 * from them, and from then on the seat is its own truth. Seeding on create is what stops
 * detaching from silently reverting values the DM was already relying on.
 */
export const AiDmSeatDefaults = z.object({
  mode: AiDmMode.default('off'),
  instructions: z.string().max(20_000).default(''),
  tokenBudget: z.number().int().nonnegative().max(1_000_000_000).default(0),
  actionQueueDepth: z.number().int().min(1).max(20).default(8),
});
export type AiDmSeatDefaults = z.infer<typeof AiDmSeatDefaults>;

/**
 * The seat fields a new campaign inherits — an ALLOWLIST, never a denylist.
 *
 * Opt-in is the safe direction, and it is the whole point of the shape. A denylist ("copy
 * everything except the credential") silently starts propagating whatever field is added
 * next; an allowlist excludes it by default until someone deliberately classifies it. #1052
 * established that whoever owns the key owns the destination, because a half-config borrowing
 * another row's credential ships that credential wherever the borrowing row points. Carrying
 * config between campaigns is that hazard from the other direction.
 *
 * A unit test enumerates every key of {@link AiDmSeat} and fails unless it appears in this
 * list or in {@link AI_DM_SEAT_NON_INHERITED_FIELDS} — so a new field cannot be added without
 * someone deciding, in writing, whether it travels.
 */
export const AI_DM_SEAT_INHERITED_FIELDS = ['mode', 'instructions', 'tokenBudget', 'actionQueueDepth'] as const;
export type AiDmSeatInheritedField = (typeof AI_DM_SEAT_INHERITED_FIELDS)[number];

/**
 * Every other seat field, with the reason it does NOT travel. Present so the classification
 * test can prove the two lists are exhaustive over {@link AiDmSeat}, and so each exclusion is
 * a recorded decision rather than an omission.
 *
 * Note there is deliberately no credential here to exclude: the seat has never carried key
 * material at all — it lives on `ai_provider_configs` and is decrypted only inside
 * `resolveEffectiveConfig`. The classification test additionally fails if any credential-
 * shaped field name ever appears on the seat, so that stays true by construction rather than
 * by memory.
 */
export const AI_DM_SEAT_NON_INHERITED_FIELDS = {
  campaignId: 'Identity of the row itself; inheriting it would point a seat at another campaign.',
  enabled: 'Consent to spend. A new campaign must be switched on by a human, never by a default.',
  model: 'An informational label derived from the effective provider, which already inherits on its own.',
  proactiveSettings: 'Consent to spend AUTONOMOUSLY — the same reason `enabled` does not travel, and sharper.',
  // #1049. Style is pure prompt guidance and costs nothing to inherit, so this is NOT the
  // consent-to-spend reasoning above — it is simply that there is nothing to inherit FROM.
  // `AiDmSeatDefaults` has no style field, so making this inherited would mean inventing a
  // server-wide default for a setting no admin can currently set, i.e. every campaign would
  // "inherit" a hardcoded all-`default` value and `inheritedFields` would report a source that
  // does not exist. `defaultSeat` therefore keeps stylePresets as a built-in. If a server-wide
  // house style is ever wanted, the change is to add it to AiDmSeatDefaults and move this key
  // into AI_DM_SEAT_INHERITED_FIELDS — the two are deliberately one edit apart.
  stylePresets: 'No server-wide default exists to inherit from; AiDmSeatDefaults has no style field.',
  // #874 — same reasoning as stylePresets immediately above: pure prompt guidance, and there is
  // no server-wide comprehension default to inherit FROM (AiDmSeatDefaults has no such field).
  comprehensionProfile: 'No server-wide default exists to inherit from; AiDmSeatDefaults has no comprehension field.',
  tokensUsed: 'Per-campaign meter reading — spend belongs to the campaign that spent it.',
  tokensReserved: 'Per-campaign meter reading — in-flight capacity held by this campaign alone.',
  tokensRefunded: 'Per-campaign meter reading — refunds settle against this campaign only.',
  tokensUnknown: 'Per-campaign meter reading — conservative spend recorded against this campaign.',
  tokensOverage: 'Per-campaign meter reading — overage is this campaign’s own accounting.',
  budgetRemaining: 'Derived from this campaign’s own meter.',
  turnCount: 'This campaign’s own play history; a fresh table has taken no turns.',
  lastTurnAt: 'This campaign’s own play history; a fresh table has never narrated.',
  inheritedFields: 'Derived per read; describes inheritance rather than participating in it.',
  createdAt: 'Row metadata — when THIS seat was first written, which a new one cannot inherit.',
  updatedAt: 'Row metadata — when THIS seat last changed, which a new one cannot inherit.',
} as const;

// Configure the seat (PUT /campaigns/:id/ai-dm, dm only). All fields optional;
// an omitted field is left unchanged.
export const AiDmSeatUpdate = z.object({
  mode: AiDmMode.optional(), // operating mode (issue #311); driver has server-side preconditions
  enabled: z.boolean().optional(),
  model: z.string().max(120).optional(),
  instructions: z.string().max(20_000).optional(),
  tokenBudget: z.number().int().min(0).max(1_000_000_000).optional(),
  proactiveSettings: AiDmProactiveSettings.optional(),
  stylePresets: AiDmStylePresets.optional(),
  comprehensionProfile: AiDmComprehensionProfile.optional(),
  actionQueueDepth: z.number().int().min(1).max(20).default(8).optional(),
});
export type AiDmSeatUpdate = z.infer<typeof AiDmSeatUpdate>;

// Ask the AI DM to take a turn (POST /campaigns/:id/ai-dm/turn, dm only, or the
// MCP ai_dm_narrate tool). `prompt` is the situation/what the players just did.
export const AiDmTurnRequest = z.object({
  prompt: z.string().min(1).max(20_000),
  kind: AiDmTurnKind.default('narrate'),
  maxTokens: z.number().int().min(1).max(4096).optional(), // cap on this turn's output; provider clamps to the remaining budget
  narrationLanguage: NarrationLanguage.optional(), // per-run override of the campaign narration language (#635)
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

// ── Authoritative multi-player AI-DM table transcript (issue #572) ────────────
// Before #572 the transcript was assembled client-side from the SSE stream plus a
// local echo of that one client's own submissions. Only the sender ever saw the
// player action an AI answer was responding to, and a reload / late join / reconnect
// produced a DIFFERENT transcript per browser. The server now stores one ordered,
// durable transcript per campaign and every table surface reads it.
//
// ORDERING. `seq` is a per-campaign monotonic counter the server assigns INSIDE the
// same synchronous better-sqlite3 transaction as the insert. It is deliberately NOT a
// wall-clock timestamp (two actions in the same millisecond have no total order) and
// deliberately NOT the global row id (which interleaves across campaigns and would leak
// server-wide write volume). It is the pagination cursor AND the reconnect watermark:
// "I have through seq N, give me the rest" has exactly one answer, gap-free within the
// retained window (retention is bounded — see AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS — so
// a client offline past the pruned edge is served what still exists, not events already
// deleted).
export const AiDmTranscriptEventKind = z.enum([
  'player.action',   // an accepted player submission — the gap #572 is about
  'narration',       // one aggregated narration step (never a raw narration.delta)
  'tool',            // a tool the AI invoked (thin signal; refetch via REST)
  'turn.cancelled',  // a stop control aborted mid-generation (#558)
  'turn.ended',      // a turn finished, with its stop reason
  'vote',            // a table vote was opened / cast / resolved (#314)
  'control',         // seat control changed: pause, takeover, handback, state
]);
export type AiDmTranscriptEventKind = z.infer<typeof AiDmTranscriptEventKind>;

/**
 * Row-level role redaction for a transcript event, enforced server-side at BOTH the
 * REST read and the SSE broadcast boundary (never by client-side filtering — a player
 * must not merely fail to render a DM-only event they already received).
 *  - `all` : every campaign member may read it.
 *  - `dm`  : DM-only. Withheld entirely from players and viewers.
 */
export const AiDmTranscriptVisibility = z.enum(['all', 'dm']);
export type AiDmTranscriptVisibility = z.infer<typeof AiDmTranscriptVisibility>;

/** Max length of the client-supplied optimistic-echo correlation token (#572). */
export const AI_DM_TRANSCRIPT_CLIENT_REF_MAX = 64;

/**
 * RETENTION (#572). A campaign keeps at most this many transcript events; the oldest
 * are pruned inside the same transaction as each insert, so the table is self-bounding
 * without a sweeper job. ~2k events is several long sessions of scrollback at the
 * observed event rate (one player action + a handful of narration/tool rows per turn).
 * Beyond that, the run is history a DM should export, not live table scrollback.
 * The rows also cascade-delete with the campaign, and a DM can purge on demand via
 * DELETE /campaigns/:id/ai-dm/transcript.
 */
export const AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS = 2_000;

/**
 * CONVERSATION MEMORY (#1038). The driver built a fresh one-message array per turn, so the
 * model had amnesia between turns even though #572 had already made the table transcript
 * durable and ordered. These constants bound how much of that transcript is replayed back
 * into the prompt. There is deliberately NO second turn log: `ai_dm_transcript_events` is
 * already the per-campaign, densely-sequenced record of what happened, and a `driver_turns`
 * table beside it would be a second source of truth to keep in sync.
 *
 * The budget is EXPLICIT CONSTANTS rather than a fraction of the model's context window on
 * purpose. Every token here is paid on every turn AND on every retry/fallback attempt
 * (#1052), so "remember more" has to be a legible, reviewable cost rather than something
 * that scales silently with whichever model a campaign is pointed at.
 *
 * Two tiers, because recency is worth more than completeness:
 *  - the newest {@link AI_DM_PROMPT_HISTORY_MAX_MESSAGES} events replay VERBATIM as real
 *    conversation turns, so the model sees exact prior wording;
 *  - older events that still fit are COMPACTED to one line each in the `## Recent history`
 *    system-prompt section — the gist survives, the token cost collapses.
 */
export const AI_DM_PROMPT_HISTORY_MAX_MESSAGES = 20;

/**
 * How many older events may be compacted into the `## Recent history` digest, beyond the
 * verbatim window. Bounded separately so a long session cannot grow the system prompt
 * without limit — past this, history is genuinely out of the model's view.
 */
export const AI_DM_PROMPT_HISTORY_MAX_DIGEST = 40;

/**
 * Token ceiling for everything #1038 adds to a turn (verbatim replay + digest), measured
 * with the repo's existing ~4-chars-per-token estimator. Whichever limit binds first — this
 * or the event counts above — wins, so a table of very long posts degrades by dropping the
 * OLDEST context rather than by silently inflating the prompt.
 */
export const AI_DM_PROMPT_HISTORY_MAX_TOKENS = 1_500;

/** Longest single history entry replayed verbatim; longer ones are truncated with an ellipsis. */
export const AI_DM_PROMPT_HISTORY_ENTRY_MAX_CHARS = 1_200;

/** Longest single line in the compacted `## Recent history` digest. */
export const AI_DM_PROMPT_HISTORY_DIGEST_LINE_MAX_CHARS = 200;

export const AiDmTranscriptEvent = z.object({
  /** Stable, client-visible event identity (unique per campaign) — the idempotent merge key. */
  eventId: z.string(),
  /** Authoritative per-campaign order AND cursor. Strictly increasing, assigned server-side. */
  seq: z.number().int().positive(),
  campaignId: Id,
  kind: AiDmTranscriptEventKind,
  /** The user whose action this was, when there is one (null for AI/system events). */
  actorUserId: z.string().nullable(),
  /** Display name captured at write time so the transcript reads correctly after a rename. */
  actorName: z.string().nullable(),
  /**
   * The sender's optimistic-echo correlation token, echoed back verbatim so the
   * submitting client REPLACES its local optimistic entry instead of duplicating it.
   * A client-generated token, NOT content equality — two players typing the same words
   * in the same second must still produce two distinct transcript lines.
   * Null for every event the client did not originate.
   */
  clientRef: z.string().nullable(),
  /**
   * Groups the narration/tool/turn-end events of ONE driver turn so a client rebuilding
   * the transcript from a REST page produces the same DM bubble the live stream did.
   */
  turnId: z.string().nullable(),
  /** Kind-specific body (text, tool name, stop reason, …). Role-projected before it ships. */
  payload: z.record(z.unknown()),
  at: IsoDate,
});
export type AiDmTranscriptEvent = z.infer<typeof AiDmTranscriptEvent>;

/** Default page size for the transcript list — one screen of scrollback. */
export const AI_DM_TRANSCRIPT_LIST_DEFAULT_LIMIT = 50;
/** Hard cap for `?limit=` on the transcript list. */
export const AI_DM_TRANSCRIPT_LIST_MAX_LIMIT = 200;

export const AiDmTranscriptPage = CursorListPage(AiDmTranscriptEvent);
export type AiDmTranscriptPage = z.infer<typeof AiDmTranscriptPage>;

/**
 * DM-facing export of the retained transcript (#572), role-projected exactly like the
 * paged read — a redacted export is a redacted export, not a back door.
 */
export const AiDmTranscriptExport = z.object({
  campaignId: Id,
  exportedAt: IsoDate,
  /** How many events the campaign retains at most (see AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS). */
  retentionMaxEvents: z.number().int().positive(),
  events: z.array(AiDmTranscriptEvent),
});
export type AiDmTranscriptExport = z.infer<typeof AiDmTranscriptExport>;

/** Result of DELETE /campaigns/:id/ai-dm/transcript — the DM's right-to-erase lever. */
export const AiDmTranscriptDeleteResult = z.object({ deleted: z.number().int().nonnegative() });
export type AiDmTranscriptDeleteResult = z.infer<typeof AiDmTranscriptDeleteResult>;
export const AiDmReadinessCheckKey = z.enum([
  'serverFlag',
  'serverCap',
  'provider',
  'model',
  'mode',
  'budget',
  'writeMode',
  'rulesContent',
  'supportConsent',
  'secretPolicy',
  'driverTools',
]);
export type AiDmReadinessCheckKey = z.infer<typeof AiDmReadinessCheckKey>;

export const AiDmReadinessCheck = z.object({
  key: AiDmReadinessCheckKey,
  ok: z.boolean(),
  status: z.enum(['ok', 'warning', 'blocked', 'unknown']),
  actor: z.enum(['admin', 'dm', 'table']),
  title: z.string(),
  detail: z.string(),
  /**
   * Machine-readable id for {@link detail}. The server renders `detail` in English for
   * API consumers and logs; localized clients look up
   * `aiOnboarding.checklist.checkDetails.<detailKey>` (interpolating {@link detailParams})
   * and fall back to `detail` when they do not know the id, so a server that grows a new
   * variant never blanks a checklist row on an older client (issue #629 keeps every
   * user-facing string translatable).
   */
  detailKey: z.string(),
  /** Interpolation values for {@link detailKey} — counts, model names, provider ids. */
  detailParams: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  requiredForDriver: z.boolean().default(false),
  fixHref: z.string().nullable().default(null),
});
export type AiDmReadinessCheck = z.infer<typeof AiDmReadinessCheck>;

// ── Monetary cost model (issue #1065) ────────────────────────────────────────
//
// A token budget is NOT a spending limit, and until now nothing on screen said so. The
// pieces below add the money dimension — and the design constraint that shapes all of them
// is that BEING UNABLE TO ANSWER IS THE COMMON CASE, not the edge case. Pricing changes
// without notice, self-hosted and proxied endpoints have no public price at all, and a
// confident wrong dollar figure is strictly worse than no figure: a DM shown "$3.10" and
// billed $31 was actively misled by us, whereas a DM told we cannot estimate goes and reads
// their provider's billing page, which is the correct behaviour anyway.
//
// So the unknown branch is the DEFAULT and the only state reachable without evidence. See
// {@link AiCostBasis}.

/** Whether a stored price was typed by an admin or prefilled from the shipped reference table. */
export const AiModelPriceSource = z.enum(['manual', 'reference']);
export type AiModelPriceSource = z.infer<typeof AiModelPriceSource>;

/**
 * One admin-configured price, keyed by the identity that actually determines cost.
 *
 * Keyed on `(providerType, model, baseUrl)` — NOT on the campaign. A model's price is a
 * property of the model, not of whoever calls it: `gpt-5` costs the same for campaign 3 and
 * campaign 47. Keying by campaign would make every DM look the same numbers up independently,
 * let them drift apart on one server, and turn a vendor price change into an N-row edit.
 *
 * `baseUrl` is part of the key and that is load-bearing. A model NAME behind a proxy or
 * gateway does not imply the vendor's pricing — someone pointing at a custom endpoint is
 * MORE likely to have a negotiated rate, not less — so a price entered for the vendor's own
 * endpoint must never be applied to a custom one. '' means the provider's own endpoint.
 */
export const AiModelPrice = z.object({
  providerType: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(200),
  /** Custom endpoint this price is scoped to; '' = the provider's own default endpoint. */
  baseUrl: z.string().trim().max(2048).default(''),
  /** USD per MILLION input (prompt) tokens. Per-million, because per-token is unreadable. */
  inputUsdPerMTok: z.number().nonnegative().max(1_000_000),
  /** USD per MILLION output (completion) tokens. */
  outputUsdPerMTok: z.number().nonnegative().max(1_000_000),
  source: AiModelPriceSource.default('manual'),
  /** As-of date (YYYY-MM-DD) of the figures, so staleness is visible rather than implied. */
  asOf: z.string().trim().max(10).nullable().default(null),
  updatedAt: z.string(),
});
export type AiModelPrice = z.infer<typeof AiModelPrice>;

/**
 * THE pricing identity, in one function.
 *
 * `(providerType, model, baseUrl)` is the table's documented key, and three places have to
 * agree on what it means: the write-side validator that rejects a duplicate, the resolver
 * that matches a campaign against a row, and the editor that flags a duplicate before the
 * admin can save one. When each implemented its own comparison they drifted — the resolver
 * matched case-insensitively while nothing stopped two rows differing only in case from
 * being stored, which made the resolved price depend on array order.
 *
 * Provider type and model are trimmed and lowercased — an admin typing `OpenAI` and `openai`
 * means the same row both times, and case-insensitive model matching is the rule the resolver
 * has always documented. The three parts are joined on a NUL escape, which cannot occur in any
 * of them, so no combination of values can collide by containing the separator.
 *
 * The base URL is deliberately NOT lowercased wholesale; see {@link normalizePricingBaseUrl}.
 */
export function aiPricingIdentityKey(entry: {
  providerType: string;
  model: string;
  baseUrl?: string | null;
}): string {
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
  // '\u0000' as an ESCAPE, never a literal NUL byte in this file — a raw control character
  // here makes the whole module read as binary to grep, diff and review tooling.
  return [norm(entry.providerType), norm(entry.model), normalizePricingBaseUrl(entry.baseUrl)].join('\u0000');
}

/**
 * Case-fold a base URL only where a URL is genuinely case-insensitive.
 *
 * Scheme and host are case-insensitive (RFC 3986 3.1 and 6.2.2.1); PATH and QUERY are not, and
 * gateways routinely carry a case-sensitive tenant, deployment or workspace id in the path.
 * Lowercasing the whole string collapsed `https://host/TenantA` and `https://host/tenanta` into
 * ONE pricing identity, which did two things at once: the duplicate check refused to let an
 * admin enter separate prices for two genuinely different endpoints, and the resolver could
 * hand one tenant's negotiated rate to the other — while requests still went to the URL
 * exactly as typed. That is this feature's central failure, a confident wrong number, arriving
 * through the KEY rather than through the arithmetic.
 *
 * A value that does not parse as an absolute URL is compared verbatim after trimming rather
 * than guessed at: with no parse there is no way to know which span is the host.
 */
export function normalizePricingBaseUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    // `protocol` and `host` come back already lowercased from the URL parser, which also drops
    // a redundant default port. Everything from the path on keeps its case.
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return trimmed;
  }
}

/**
 * Indices of entries whose identity repeats an earlier one. Empty means the list is a valid
 * table. Shared by the schema refinement and the admin editor so "duplicate" cannot mean two
 * different things at the two ends of the same round trip.
 *
 * Rows whose provider or model is still blank are SKIPPED rather than compared: a half-typed
 * row is already reported as missing required fields, and treating two blank rows as
 * duplicates of each other stacks a second, misleading error on top of that.
 */
export function aiPricingDuplicateIndices(
  entries: readonly { providerType: string; model: string; baseUrl?: string | null }[],
): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  entries.forEach((entry, index) => {
    if (!entry.providerType.trim() || !entry.model.trim()) return;
    const key = aiPricingIdentityKey(entry);
    if (seen.has(key)) duplicates.push(index);
    else seen.add(key);
  });
  return duplicates;
}

/**
 * Ceiling on the price list. Exported so the admin editor stops an admin AT the limit rather
 * than letting them type past it and discover the cap when the save 400s.
 */
export const AI_PRICING_MAX_ENTRIES = 500;

/**
 * The server-wide pricing table, stored as ONE JSON blob under a settings key.
 *
 * Server-wide rather than per-campaign for the reason above, and in the generic settings k/v
 * rather than on `ai_provider_configs` for a second reason: that table's server row holds a
 * single `providerType`, and a campaign may override the provider entirely. Pricing hung off
 * it would have no home for a campaign on Anthropic under an OpenAI server default. Only an
 * admin writes this, so a single blob has no concurrent read-modify-write problem.
 */
export const AiPricingTable = z.object({
  version: z.literal(1).default(1),
  entries: z.array(AiModelPrice).max(AI_PRICING_MAX_ENTRIES).default([]),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().default(''),
});
export type AiPricingTable = z.infer<typeof AiPricingTable>;

/** Why no dollar figure is available. Each maps to its own honest sentence, never a number. */
export const AiCostUnknownReason = z.enum([
  /** No admin has entered pricing for this server at all. */
  'no_pricing_configured',
  /** Pricing exists, but not for this provider/model pair. */
  'model_not_priced',
  /** The campaign points at a custom endpoint with no price entered FOR that endpoint. */
  'custom_endpoint_not_priced',
  /** No provider/model is resolved yet, so there is nothing to price. */
  'no_provider',
  /**
   * A provider IS configured, but resolving it failed — most often a stored credential that
   * can no longer be decrypted after `AI_CONFIG_KEY` was lost or rotated, and also a model
   * pushed off a tightened allowlist or a stored endpoint that now fails host policy.
   *
   * Distinct from `no_provider` because the fix is different and much less obvious: nothing
   * in the configuration LOOKS wrong, so "no provider is configured yet" would send an
   * operator to re-enter settings that are already correct. The readiness `model` check
   * carries the specific server sentence; this reason points there.
   */
  'provider_unresolved',
]);
export type AiCostUnknownReason = z.infer<typeof AiCostUnknownReason>;

/**
 * THE choke point for "may we show money?" — a discriminated union, deliberately.
 *
 * `unknown` is the variant you get unless a price was actually resolved, so a new provider,
 * a renamed model, or a forgotten config path falls into the DISCLOSURE rather than into a
 * confident wrong number. This is the same reasoning as the exhaustive finish-reason Record
 * in driver-safety.ts: a shape that makes the unsafe state unreachable beats a convention
 * that the unsafe state is handled.
 *
 * Every dollar figure in the product is derived from this via {@link estimateUsdRange}, which
 * returns null on `unknown`. That is the ONLY supported way to turn tokens into money — there
 * is deliberately no point-estimate counterpart, because no caller has a genuinely measured
 * prompt/completion split to give one, and an entry point that accepts an assumed split is an
 * entry point for publishing a guess as a measurement. What makes the guarantee structural
 * rather than a rule someone has to remember is that there is nothing else to call.
 */
export const AiCostBasis = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unknown'),
    reason: AiCostUnknownReason,
  }),
  z.object({
    kind: z.literal('priced'),
    inputUsdPerMTok: z.number().nonnegative(),
    outputUsdPerMTok: z.number().nonnegative(),
    source: AiModelPriceSource,
    asOf: z.string().nullable(),
    /** Echoed back so the UI can say WHICH model the figure is for, never just "$X". */
    providerType: z.string(),
    model: z.string(),
  }),
]);
export type AiCostBasis = z.infer<typeof AiCostBasis>;

/** The basis every caller starts from. Exported so "unknown" is the easy thing to reach for. */
export const AI_COST_BASIS_UNKNOWN: AiCostBasis = { kind: 'unknown', reason: 'no_pricing_configured' };

/**
 * Dollar RANGE for a bare token count, or null when we cannot say.
 *
 * A range and not a point, because a token budget's real cost genuinely depends on how it
 * splits between input and output — which nobody knows in advance, and which differ by
 * several times on most providers. Reporting the midpoint to the cent would invent precision
 * we do not have; reporting the honest span is both true and more useful, because the top of
 * it is the number a DM should actually budget against.
 *
 * Returns null for `unknown`. That is the whole point: there is no argument you can pass to
 * get a number out of an unpriced basis.
 */
export function estimateUsdRange(tokens: number, basis: AiCostBasis): { low: number; high: number } | null {
  if (basis.kind !== 'priced') return null;
  const millions = Math.max(0, tokens) / 1_000_000;
  const a = millions * basis.inputUsdPerMTok;
  const b = millions * basis.outputUsdPerMTok;
  return a <= b ? { low: a, high: b } : { low: b, high: a };
}

export const AiDmEstimatedCost = z.object({
  /**
   * The assumed prompt/completion split, or null when it is NOT known.
   *
   * Null is the metered case, and that is not a gap in the data — it is the data. Metering
   * records one `tokensUsed` total per turn, so a campaign with history knows what a turn
   * costs in tokens and knows nothing about how that total divided. Reporting a split here
   * anyway (an earlier draft multiplied the total by a fixed 57.7%) dressed a constant up as
   * a measurement, which is precisely what {@link AiCostBasis}'s `unknown` variant exists to
   * stop one layer down. Non-null only when the numbers ARE our own stated assumption,
   * i.e. the campaign has no metered turns yet.
   */
  estimatedPromptTokens: z.number().int().nonnegative().nullable().default(null),
  estimatedCompletionTokens: z.number().int().nonnegative().nullable().default(null),
  estimatedTotalTokens: z.number().int().nonnegative(),
  /**
   * #1065 — the money, as a RANGE, or null when we cannot say.
   *
   * A range because the split above is generally unknown and output tokens are priced several
   * times higher than input on most providers: a point value would be an invented ratio
   * carried to two significant figures. The span between all-input and all-output pricing is
   * the honest statement of what we actually know, and its top is the number a DM should
   * budget against.
   */
  estimatedUsdRange: z
    .object({ low: z.number().nonnegative(), high: z.number().nonnegative() })
    .nullable()
    .default(null),
  /**
   * #1065 — what the dollar range above is (or is not) based on. `estimatedUsdRange` is
   * DERIVED from this and is null whenever `basis.kind === 'unknown'`; the basis is what the
   * UI reads to decide between showing a figure and showing the cannot-estimate disclosure.
   */
  basis: AiCostBasis.default(AI_COST_BASIS_UNKNOWN),
  /**
   * English prose for API consumers and logs. Localized clients prefer {@link noteKey} —
   * same split as {@link AiDmReadinessCheck.detail}/`detailKey`, so a server that grows a new
   * variant never blanks a row on an older client (#629).
   */
  note: z.string(),
  /** Machine-readable id for {@link note}: `aiOnboarding.runCost.notes.<noteKey>`. */
  noteKey: z.string().default(''),
  /** Interpolation values for {@link noteKey}. */
  noteParams: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
export type AiDmEstimatedCost = z.infer<typeof AiDmEstimatedCost>;

export const AiDmReadiness = z.object({
  campaignId: Id,
  ok: z.boolean(),
  driverOk: z.boolean(),
  mode: AiDmMode,
  provider: z.lazy(() => AiProviderEffectiveView),
  budgetRemaining: z.number().int().nonnegative(),
  checks: z.array(AiDmReadinessCheck),
  estimatedCost: AiDmEstimatedCost,
  driverUnavailableReason: z.string().nullable().default(null),
});
export type AiDmReadiness = z.infer<typeof AiDmReadiness>;

/**
 * A readiness check BLOCKS the AI when it is not `ok` and not merely advisory.
 * `warning` checks (session-zero content, participant consent counts) are suggestions a DM
 * may ignore; every other status gates. This is the same rule the server applies when it
 * computes `AiDmReadiness.ok`, exported so a client cannot re-derive it differently.
 */
export function aiDmReadinessCheckBlocks(check: Pick<AiDmReadinessCheck, 'ok' | 'status'>): boolean {
  return !check.ok && check.status !== 'warning';
}

/**
 * Is the AI DM actually ready to do something for this table?
 *
 * The mode is part of the answer, not a detail: a campaign can have the server flag, a
 * provider, a model and a budget and still have the seat switched OFF, in which case the AI
 * does nothing. Reporting "ready" there is a lie, so each mode owns its own readiness:
 *   - `driver` — `driverOk`, which mirrors `AiDmService.assertRunnable` (every driver-required
 *     check passes AND the seat is armed in driver mode), AND `ok`. `driverOk` alone would
 *     ignore any BLOCKING check that is not driver-specific, letting the banner fire while
 *     the progress tally is still short — the contradiction {@link aiDmReadinessProgress}
 *     exists to prevent. `driverOk ⊆ ok` in practice, so this only closes the hole.
 *   - `co_dm`  — `ok`, i.e. every blocking check passes (propose-only needs no driver extras).
 *   - `off`    — never ready; picking a mode is the remaining work.
 */
export function aiDmSetupComplete(readiness: Pick<AiDmReadiness, 'ok' | 'driverOk' | 'mode'>): boolean {
  if (readiness.mode === 'driver') return readiness.driverOk && readiness.ok;
  if (readiness.mode === 'co_dm') return readiness.ok;
  return false;
}

/**
 * Checklist progress, counted over BLOCKING checks only.
 *
 * The total must be reachable exactly when {@link aiDmSetupComplete} is true, or the UI says
 * two contradictory things about one state — a runnable table reading "10 of 11" beside a
 * green "the AI DM is ready" banner, because an advisory `warning` check (a campaign with no
 * session-zero content) can never be ticked off. Advisory checks are still rendered; they
 * just do not count against a total that gates the ready claim.
 */
export function aiDmReadinessProgress(
  readiness: Pick<AiDmReadiness, 'checks'>,
): { done: number; total: number } {
  const gating = readiness.checks.filter((check) => check.status !== 'warning');
  return { done: gating.filter((check) => check.ok).length, total: gating.length };
}

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
  // How many drafts to produce (npc/location/beat/quest/faction; ignored for recap/encounter/map).
  count: z.number().int().min(1).max(10).optional(),
  narrationLanguage: NarrationLanguage.optional(), // per-run override (#635)
  // When target is `beat`, pin the drafted beat(s) to this arc (#1307).
  arcId: Id.optional(),
});
export type CoDmDraftRequest = z.infer<typeof CoDmDraftRequest>;

export const CoDmDraftResult = z.object({
  target: CoDmDraftTarget,
  provider: z.string(), // which provider produced the draft ('noop' by default)
  model: z.string(), // the seat's model label
  // The proposal entity type the drafts were filed under (npc/location/story_beat/session/
  // encounter/map, etc.) — a beat files a story_beat, a recap files a session.
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

// ── Provider CAPABILITIES model (issue #410) ──────────────────────────────────
// Genuine AI map generation (#410) can only route honestly if it knows what each
// configured provider can actually DO. A text-only model (Anthropic today) must NOT
// be asked to "generate an image" and then have its prose passed off as one; an
// OpenAI-compatible endpoint with an images model CAN. These booleans are declared
// per provider TYPE (the server factory owns the concrete per-type table — see
// providerCapabilities()) and surfaced to clients so the web wizard can show cost /
// readiness and pick concept-art vs battle-map modes before spending anything.
//
//  - text            — chat/completions style narration + structured output.
//  - toolCalling      — the model can request tool/function calls (drives the driver).
//  - imageGeneration  — the provider exposes a text-to-image endpoint we can call.
//  - imageEditing     — optional: it can edit/inpaint an existing image (mask/refine).
export const AiProviderCapabilities = z.object({
  text: z.boolean(),
  toolCalling: z.boolean(),
  imageGeneration: z.boolean(),
  imageEditing: z.boolean().optional(),
});
export type AiProviderCapabilities = z.infer<typeof AiProviderCapabilities>;

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
// applies a separate SSRF host policy (issues #1064, #570): cloud metadata / link-local /
// multicast are always blocked, and private/loopback hosts require an operator opt-in
// (`AI_PROVIDER_ALLOW_PRIVATE_HOSTS`) or an explicit host/CIDR allowlist. DNS is
// re-validated at request time to defend rebinding.
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
  tokensReserved: z.number().int().nonnegative().default(0),
  tokensRefunded: z.number().int().nonnegative().default(0),
  tokensUnknown: z.number().int().nonnegative().default(0),
  tokensOverage: z.number().int().nonnegative().default(0),
  budgetRemaining: z.number().int().nonnegative().default(0),
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
  totalTokensReserved: z.number().int().nonnegative().default(0),
  totalTokensRefunded: z.number().int().nonnegative().default(0),
  totalTokensUnknown: z.number().int().nonnegative().default(0),
  totalTokensOverage: z.number().int().nonnegative().default(0),
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

// PUT /settings/ai/pricing (issue #1065) — replace the server-wide model price list.
// Wholesale replace rather than per-entry patch: the list is short, an admin edits it as a
// table, and a partial update API would need an identity for rows whose natural key
// (providerType+model+baseUrl) is exactly what an edit changes.
export const AiPricingUpdate = z
  .object({
    entries: z
      .array(
        z
          .object({
            providerType: z.string().trim().min(1).max(40),
            model: z.string().trim().min(1).max(200),
            baseUrl: z.string().trim().max(2048).default(''),
            inputUsdPerMTok: z.number().nonnegative().max(1_000_000),
            outputUsdPerMTok: z.number().nonnegative().max(1_000_000),
            source: AiModelPriceSource.default('manual'),
            asOf: z.string().trim().max(10).nullable().default(null),
          })
          .strict(),
      )
      .max(AI_PRICING_MAX_ENTRIES)
      // The identity is the table's key, so the write boundary is where it has to hold.
      // Without this the store accepted two rows for the same target and `resolveBasisFrom`
      // silently priced against whichever happened to come first — an estimate that depended
      // on array order. Rejecting here also means the editor's duplicate check and the
      // server's agree by construction: both call `aiPricingDuplicateIndices`.
      .superRefine((entries, ctx) => {
        for (const index of aiPricingDuplicateIndices(entries)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message:
              'Duplicate pricing entry: another entry already covers this provider, model and base URL.',
          });
        }
      }),
  })
  .strict();
export type AiPricingUpdate = z.infer<typeof AiPricingUpdate>;

/** GET /settings/ai/pricing — the stored list plus the reference figures offered for prefill. */
export const AiPricingView = z.object({
  entries: z.array(AiModelPrice),
  updatedAt: z.string().nullable(),
  updatedBy: z.string(),
  /**
   * Campfire's shipped reference figures. Offered for PREFILL only — nothing resolves an
   * estimate against them. They become live pricing solely once an admin has reviewed and
   * saved them, at which point they are indistinguishable from typed pricing except for the
   * `source`/`asOf` provenance recorded on the entry.
   */
  reference: z.array(
    z.object({
      providerType: z.string(),
      model: z.string(),
      inputUsdPerMTok: z.number().nonnegative(),
      outputUsdPerMTok: z.number().nonnegative(),
    }),
  ),
  /** The date the reference figures were last verified. Shown at the moment of prefill. */
  referenceAsOf: z.string(),
});
export type AiPricingView = z.infer<typeof AiPricingView>;
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
  // Durable cursor for cron/incremental runs — only material newer than this is assembled (#499).
  sourceCursorAt: IsoDate.nullable().default(null),
  /**
   * DERIVED, read-only: whether a run right now would actually send content OFF this
   * server (issue #501). True when a provider config is resolved and the operator has not
   * declared the endpoint local; false for the built-in no-op/injected seam.
   *
   * Not part of `ScribeConfigUpdate` — it is computed per read, never stored. It exists so
   * the DM-facing external-send confirmation can describe what will really happen instead
   * of warning about a vendor call that will not occur. Defaults to `true` (fail-closed),
   * so a client that cannot read it still shows the strict warning.
   */
  externalSend: z.boolean().default(true),
  ...timestamps,
});
export type ScribeConfig = z.infer<typeof ScribeConfig>;

export const ScribeConfigUpdate = z.object({
  postSession: z.boolean().optional(),
  cron: z.boolean().optional(),
  budgetPerRun: z.number().int().min(1).max(200_000).optional(),
});
export type ScribeConfigUpdate = z.infer<typeof ScribeConfigUpdate>;

// Archived counts for what a run assembled — stored on the job row for audit (#499).
export const ScribeSourceStats = z.object({
  resolvedInbox: z.number().int().nonnegative().default(0),
  encounters: z.number().int().nonnegative().default(0),
  diceRolls: z.number().int().nonnegative().default(0),
  excludedInboxByConsent: z.number().int().nonnegative().default(0),
  excludedInboxPrivate: z.number().int().nonnegative().default(0),
  /**
   * The AI content policy in force when this run assembled (#501).
   *
   * Archived because it is the CAUSE behind `excludedInboxByConsent`, and the two remedies
   * are different people's: under `member_consent` each author opts in for themselves,
   * under `disabled` only the DM can change the policy. Telling a DM to chase member
   * consent on a disabled-policy campaign sends everyone to a control that cannot help.
   *
   * Optional: rows archived before this field existed do not carry it, and a `no_material`
   * run records no provenance, so this is the only place the UI can read the policy from.
   */
  campaignPolicy: AiExternalContentPolicy.optional(),
  scheduledSessionId: Id.optional(),
  windowStart: IsoDate.optional(),
  windowEnd: IsoDate.optional(),
  sinceAt: IsoDate.optional(),
});
export type ScribeSourceStats = z.infer<typeof ScribeSourceStats>;

// Dry-run / pre-flight preview of what would be assembled (#499).
export const ScribeSourcePreview = ScribeSourceStats.extend({
  estimatedPromptTokens: z.number().int().nonnegative().default(0),
});
export type ScribeSourcePreview = z.infer<typeof ScribeSourcePreview>;

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
  sourceHash: z.string().nullable().default(null), // sha256 of assembled source — idempotency archive
  scheduledSessionId: Id.nullable().default(null), // post_session: exactly which game night (#499)
  sourceStats: ScribeSourceStats.nullable().default(null), // archived assembly counts
  generationProvenance: AiGenerationProvenance.nullable().default(null), // provider/model/source/prompt/consent metadata (#501)
  createdBy: z.string().default(''),
  createdAt: IsoDate,
});
export type ScribeJob = z.infer<typeof ScribeJob>;

// On-demand run request (POST /campaigns/:id/scribe/run). `dryRun` assembles +
// generates but files no proposal — a preview the DM can inspect before committing.
export const ScribeRunRequest = z.object({
  dryRun: z.boolean().default(false),
  narrationLanguage: NarrationLanguage.optional(), // per-run override (#635)
  // Bypass idempotency and re-draft even when source is unchanged or a proposal is pending (#499).
  force: z.boolean().default(false),
  // Target a specific ended scheduled session (post_session scope); on-demand only.
  scheduledSessionId: Id.optional(),
});
export type ScribeRunRequest = z.infer<typeof ScribeRunRequest>;

// Result of a run: the recorded job, the proposal ids filed (empty on skip/dry-run),
// and — on a dry run — the drafted recap text for preview.
export const ScribeRunResult = z.object({
  job: ScribeJob,
  proposalIds: z.array(Id).default([]),
  dryRun: z.boolean().default(false),
  preview: z.string().nullable().default(null), // drafted recap text (dry-run only)
  sourcePreview: ScribeSourcePreview.nullable().default(null), // assembly counts + token estimate (#499)
});
export type ScribeRunResult = z.infer<typeof ScribeRunResult>;

// ---------- attachments (uploaded images: character portraits, campaign maps) ----------
export const AttachmentKind = z.enum(['portrait', 'map', 'image']);

// Attribution is deliberately optional: ordinary table uploads should remain a
// one-click operation, while imports and generated assets can record provenance.
/** http(s) URL or empty; preprocess trims so whitespace-only becomes ''. */
export const AttachmentSourceUrl = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.union([
    z.literal(''),
    z.string().url().refine((v) => /^https?:\/\//i.test(v), 'Must be an http(s) URL'),
  ]),
);

export const AttachmentMetadata = z.object({
  title: z.string().trim().max(255).default(''),
  caption: z.string().trim().max(2_000).default(''),
  altText: z.string().trim().max(1_000).default(''),
  creator: z.string().trim().max(255).default(''),
  sourceUrl: AttachmentSourceUrl.default(''),
  license: z.string().trim().max(255).default(''),
  rights: z.string().trim().max(1_000).default(''),
  attribution: z.string().trim().max(1_000).default(''),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
});
export type AttachmentMetadata = z.infer<typeof AttachmentMetadata>;
export const AttachmentMetadataPatch = AttachmentMetadata.omit({ checksumSha256: true }).partial().strict();
export type AttachmentMetadataPatch = z.infer<typeof AttachmentMetadataPatch>;

export const Attachment = z.object({
  id: Id,
  campaignId: Id,
  uploaderUserId: z.string().max(120), // OIDC sub or dev user; audit/ownership (delete-by-uploader)
  kind: AttachmentKind,
  filename: z.string().max(255), // original client filename, display only
  mime: z.string().max(80),
  size: z.number().int().nonnegative(), // bytes
  ...AttachmentMetadata.shape,
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

// ---------- responsive image derivatives (issue #604) ----------
//
// World and encounter maps used to be delivered as the untouched original on every
// load, and the only downscaling the server could do ran synchronously on the
// request thread for a narrow subset of PNGs. Derivatives are now generated ONCE,
// in the background, and recorded durably — so the client needs a contract for
// "which sizes exist, which are still being made, and which failed" in order to
// build an accurate srcset and to show processing / stale / error states instead
// of silently rendering a full-size image.

/** Rungs of the responsive ladder, smallest first. Longest edge in px: 512/1280/2560. */
export const DerivativeVariant = z.enum(['thumb', 'md', 'lg']);
export type DerivativeVariant = z.infer<typeof DerivativeVariant>;

/**
 * Per-rung lifecycle.
 *  - pending: planned, the background worker has not produced it yet.
 *  - ready:   bytes exist on disk and may be served.
 *  - failed:  generation raised repeatedly; the DM can retry.
 *  - skipped: the source is already at/below this rung, so materialising it would
 *             cost disk for no byte saving. Serving falls back to a smaller ready
 *             rung, or to the original.
 */
export const DerivativeState = z.enum(['pending', 'ready', 'failed', 'skipped']);
export type DerivativeState = z.infer<typeof DerivativeState>;

export const AttachmentDerivative = z.object({
  variant: DerivativeVariant,
  state: DerivativeState,
  // Real pixel dimensions of a ready rung (0 otherwise). The client emits these as
  // `w` descriptors rather than assuming the rung's max-dim cap, which would be
  // wrong for every non-square image.
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  format: z.string().max(40),
  attempts: z.number().int().nonnegative(),
  lastError: z.string(),
  /** True when this rung was generated from source bytes that have since changed. */
  stale: z.boolean(),
});
export type AttachmentDerivative = z.infer<typeof AttachmentDerivative>;

export const AttachmentDerivativeManifest = z.object({
  attachmentId: Id,
  // Top-level state the UI renders: every rung settled and at least one usable
  // ('ready'), still generating ('processing'), generation errored ('failed'), or
  // the attachment has no ladder at all — a PDF, or an image whose header could not
  // be read ('unsupported').
  status: z.enum(['ready', 'processing', 'failed', 'unsupported']),
  stale: z.boolean(),
  derivatives: z.array(AttachmentDerivative),
});
export type AttachmentDerivativeManifest = z.infer<typeof AttachmentDerivativeManifest>;

// ---------- encounters (combat tracker) ----------
export const EncounterStatus = z.enum(['preparing', 'running', 'ended']);
export type EncounterStatus = z.infer<typeof EncounterStatus>;

/** One transparent component of an initiative modifier. */
export const InitiativeBreakdownTerm = z.object({
  label: z.string().min(1).max(80),
  value: z.number().int(),
});
export type InitiativeBreakdownTerm = z.infer<typeof InitiativeBreakdownTerm>;

/**
 * Stored initiative provenance for a combatant. `roll` and `total` are null until
 * initiative is rolled; `terms` explain the stored modifier (e.g. DEX + level for 13th Age).
 */
export const CombatantInitiativeBreakdown = z.object({
  die: z.number().int().positive().max(100),
  roll: z.number().int().nullable().default(null),
  modifier: z.number().int(),
  total: z.number().int().nullable().default(null),
  terms: z.array(InitiativeBreakdownTerm).max(10).default([]),
  formula: z.string().max(160).default(''),
});
export type CombatantInitiativeBreakdown = z.infer<typeof CombatantInitiativeBreakdown>;

/** Why the 13th Age escalation die changed for this encounter. */
export const EscalationDieHistorySource = z.enum(['start', 'round', 'hold', 'override', 'undo']);
export type EscalationDieHistorySource = z.infer<typeof EscalationDieHistorySource>;

/** Bounded, structured history used by UI, logs, MCP, and AI to explain escalation state. */
export const EscalationDieHistoryEntry = z.object({
  round: z.number().int().nonnegative(),
  value: z.number().int().min(0).max(6),
  source: EscalationDieHistorySource,
  held: z.boolean().default(false),
  override: z.number().int().min(0).max(6).nullable().default(null),
  note: z.string().max(160).default(''),
  at: IsoDate,
});
export type EscalationDieHistoryEntry = z.infer<typeof EscalationDieHistoryEntry>;

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
  /** Stable id for per-region select/move/delete (issue #472). Omitted on legacy rows. */
  id: z.string().min(1).max(40).optional(),
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
 * Battle-map grid geometry (issue #40 / #238 / #467). 'square' is the classic Battlemat grid;
 * 'hex' uses hex-center snapping, hex-aware distance, footprints, and AoE geometry.
 */
export const GridType = z.enum(['square', 'hex']);
export type GridType = z.infer<typeof GridType>;

/**
 * Per-encounter dial for how much monster/NPC HP a non-DM viewer is told (issue #1925).
 * `band` (default) is today's behaviour: the coarse healthy/bloodied/critical/down status,
 * unchanged. `exact` ships the real hpCurrent/hpMax/hpTemp to non-DMs (a tactical table that
 * wants the numbers on the table). `hidden` ships neither the numbers nor the band — except a
 * combatant at 0 HP still reports `hpBand: 'down'` in every mode, so the table always knows who
 * dropped. The server enforces this in every player-facing serialization (`redactMonsterHp`)
 * — never client-side hiding — so a player inspecting the network response cannot recover
 * exact HP in `band` or `hidden` mode.
 */
export const MonsterHpDisplay = z.enum(['band', 'exact', 'hidden']);
export type MonsterHpDisplay = z.infer<typeof MonsterHpDisplay>;

/** Pointy-top vs flat-top hex orientation (issue #467). Default pointy matches legacy overlay. */
export const HexOrientation = z.enum(['pointy', 'flat']);
export type HexOrientation = z.infer<typeof HexOrientation>;

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
  // Optional owner for player-declared templates (issue #465). DM/AI templates omit this;
  // the declaring player still sees their template in unrevealed fog.
  declaredByUserId: z.string().min(1).max(120).nullable().default(null),
});
export type AoeTemplate = z.infer<typeof AoeTemplate>;

/**
 * A caller-supplied template declaration (issue #1913). The server sets the
 * declarer from the authenticated identity, so accepting `declaredByUserId`
 * here would let a player impersonate another template owner. `.strict()` is
 * therefore an authorization boundary, not merely DTO hygiene.
 */
export const AoeTemplateDeclare = AoeTemplate.omit({ declaredByUserId: true }).strict();
export type AoeTemplateDeclare = z.infer<typeof AoeTemplateDeclare>;

/**
 * Fields a caller may change on an existing AoE template (issue #1913). Its
 * route supplies the template id; ownership and declarer attribution always
 * remain server-controlled.
 */
// This intentionally does not derive from `AoeTemplateDeclare.partial()`: Zod
// defaults on the declaration schema would materialize omitted `angleDeg` and
// `color` keys, turning a one-field PATCH into an accidental reset.
export const AoeTemplateUpdate = z.object({
  shape: AoeShape.optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  sizeFt: z.number().positive().max(1000).optional(),
  angleDeg: z.number().min(-360).max(360).optional(),
  color: z.string().max(24).nullable().optional(),
}).strict();
export type AoeTemplateUpdate = z.infer<typeof AoeTemplateUpdate>;

/**
 * A transient "look here" ping broadcast over SSE (issue #238). Not persisted — it rides the
 * campaign event stream as a one-shot signal that every open client renders for a moment and
 * then lets fade. Coordinates are 0–100 percent of the map surface; any writing member may
 * drop one (a live table gesture, not DM-gated like fog).
 */
/** Encounter turn pointer phase — combatant turn vs lair action at init 20 (issue #618). */
export const EncounterTurnPhase = z.enum(['combatant', 'lair']);
export type EncounterTurnPhase = z.infer<typeof EncounterTurnPhase>;

/** Per-combatant legendary-action pool surfaced on encounter reads (issue #618). */
export const LegendaryActionPool = z.object({
  max: z.number().int().positive(),
  used: z.number().int().nonnegative(),
});
export type LegendaryActionPool = z.infer<typeof LegendaryActionPool>;

export const MapPing = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  color: z.string().max(24).nullable().default(null),
  label: z.string().max(40).nullable().default(null),
  senderId: z.string().nullable().default(null),
  senderName: z.string().nullable().default(null),
});
export type MapPing = z.infer<typeof MapPing>;

export const Encounter = z.object({
  id: Id,
  campaignId: Id,
  name: z.string().min(1).max(120),
  status: EncounterStatus.default('preparing'),
  round: z.number().int().nonnegative().default(0),
  // 13th Age / Archmage Engine escalation die state (issue #542). Non-Archmage campaigns
  // keep the inert defaults. The current value is stored rather than derived-only so DM
  // hold/override decisions, undo, logs, MCP, and AI all observe the same state.
  escalationDie: z.number().int().min(0).max(6).default(0),
  escalationDieHeld: z.boolean().default(false),
  escalationDieOverride: z.number().int().min(0).max(6).nullable().default(null),
  escalationDieHistory: z.array(EscalationDieHistoryEntry).max(200).default([]),
  // Positional turn cursor, kept in lockstep with `currentCombatantId` as a
  // display/back-compat convenience — it is the index of the current combatant in
  // the server-sorted order. `currentCombatantId` is the AUTHORITATIVE pointer
  // (issue #49): a positional index alone corrupts when a combatant is added or
  // removed mid-fight (everyone after the removed row shifts a slot and the
  // "current turn" highlight jumps to the wrong creature). null = no current
  // combatant (not running, or the encounter is empty).
  turnIndex: z.number().int().nonnegative().default(0),
  currentCombatantId: Id.nullable().default(null),
  // Monotonic generation counter bumped on every turn advance (issue #1923's
  // compare-and-set token; the column itself predates this issue). Readable by every
  // role — not a secret, purely a concurrency marker — so a client can echo the value
  // it last rendered back as `expectedTurnVersion` on POST .../combatants/:cid/reorder
  // and get a 409 instead of silently reordering a roster the turn has already moved on
  // from.
  turnVersion: z.number().int().nonnegative().default(0),
  // Boss-fight scheduling (issue #618): when `turnPhase` is `lair`, `currentCombatantId`
  // is null and `lairResumeCombatantId` is the next combatant after the lair slot resolves.
  turnPhase: EncounterTurnPhase.default('combatant'),
  lairResumeCombatantId: Id.nullable().default(null),
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
  // Grid geometry (issue #238 / #467). 'square' (default) or 'hex' with hex-center snapping.
  // Older DBs backfill to 'square' via migration, preserving the original square-only behaviour.
  gridType: GridType.default('square'),
  // Hex orientation (issue #467): pointy-top (default, matches legacy overlay) or flat-top.
  hexOrientation: HexOrientation.default('pointy'),
  // Grid CALIBRATION for aligning the overlay to a map's own printed grid (issue #417).
  // Every field is expressed in the same isotropic unit — percent of the rendered map's
  // WIDTH — so the overlay, snapping, and the ruler share ONE transform (see the web
  // mapRenderedBounds module) that every viewport (DM cockpit + player views) renders
  // identically. Defaults reproduce the pre-#417 behaviour exactly (origin at the map's
  // top-left, square cells the width of gridSize, no rotation), so existing encounters are
  // visually unchanged. All are DM-only PATCHes like the rest of the grid config.
  //   - gridOffsetX/gridOffsetY: the grid origin, offset from the map's top-left corner
  //     (percent of map width; a printed grid rarely starts exactly at the corner).
  //   - gridCellHeight: independent cell HEIGHT (percent of map width); null = square, i.e.
  //     the same as gridSize. Equal numeric values for gridSize/gridCellHeight => square px.
  //   - gridRotation: overlay rotation in degrees (a scanned/printed grid is often slightly
  //     skewed). Bounded to ±45 to keep the cell axes unambiguous.
  //   - gridOpacity: overlay line opacity (0 = invisible, 1 = solid). Default 0.35 matches
  //     the historical hardcoded line alpha.
  gridOffsetX: z.number().min(-100).max(100).default(0),
  gridOffsetY: z.number().min(-100).max(100).default(0),
  gridCellHeight: z.number().min(1).max(100).nullable().default(null),
  gridRotation: z.number().min(-45).max(45).default(0),
  gridOpacity: z.number().min(0).max(1).default(0.35),
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
  // Per-encounter monster-HP display dial for non-DM viewers (issue #1925). 'band' (default)
  // preserves today's coarse healthy/bloodied/critical/down status; 'exact' ships real numbers;
  // 'hidden' ships neither (except the 'down' band, always sent so the table knows who dropped).
  // Enforced server-side in redactMonsterHp — this field itself is readable by players (it drives
  // their own rendering) and leaks nothing about any combatant's HP.
  monsterHpDisplay: MonsterHpDisplay.default('band'),
  // Turn timer (issue #1935): a server-stamped instant so every connected client agrees on
  // when the CURRENT turn began, without any client computing or guessing it. Stamped fresh
  // inside the same serialized transaction as start/nextTurn/endTurn/undoTurn; null when the
  // encounter isn't actively mid-turn — EncounterStatus has no separate paused state, so this
  // covers 'preparing' (not yet started) and 'ended' alike. Undo restamps fresh too — the
  // prior elapsed time is intentionally not restored, it's a new "now" for the same turn.
  // Purely informational: no server-side enforcement, auto-advance, or blocking ever reads it.
  turnStartedAt: IsoDate.nullable().default(null),
  // Optional DM-set pacing limit in seconds; 0 = off (elapsed-only, DM-facing only). DM-editable
  // via EncounterUpdate. Never enforced server-side — purely drives client chip color (issue #1935).
  turnTimerSeconds: z.number().int().nonnegative().default(0),
  // Role-safe resolved link labels (issue #480) — present on list/get/summary reads.
  locationLink: EncounterLinkMeta.nullable().optional(),
  questLink: EncounterLinkMeta.nullable().optional(),
  sessionLink: EncounterLinkMeta.nullable().optional(),
  ...timestamps,
});
export type Encounter = z.infer<typeof Encounter>;
export const EncounterCreate = z.object({
  name: z.string().min(1).max(120),
  // Optional attachment links (issue #126) — where/why/when this encounter belongs.
  locationId: Id.nullable().optional(),
  questId: Id.nullable().optional(),
  sessionId: Id.nullable().optional(),
  // Entity-level secrecy (issue #262/#754) — omit defaults to DM-only prep; pass false to create visible.
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
  // Map replacement lifecycle (issue #870). 'reset' clears grid, fog, AoE, and token
  // coordinates in the same transaction as the mapAttachmentId change; 'preserve' (default) keeps them.
  mapAlignment: MapAlignment.optional(),
  // VTT grid config (issue #40, phase 2) — dm only, enforced server-side. null clears a
  // field (gridSize: null turns the grid off); omitting leaves it unchanged.
  gridSize: z.number().min(1).max(100).nullable().optional(),
  gridScale: z.number().positive().nullable().optional(),
  gridUnit: z.string().max(12).nullable().optional(),
  gridSnap: z.boolean().optional(),
  // Grid geometry (issue #238 / #467) — dm only. 'square' | 'hex'.
  gridType: GridType.optional(),
  // Hex orientation (issue #467) — dm only. 'pointy' | 'flat'.
  hexOrientation: HexOrientation.optional(),
  // Grid calibration (issue #417) — dm only. Align the overlay to a map's printed grid:
  // origin offset, independent cell height, rotation, and overlay opacity. Each field is
  // independently settable; gridCellHeight: null restores square cells. Omitting a field
  // leaves it unchanged (the whole endpoint is optimistic-concurrency + DM-gated as before).
  gridOffsetX: z.number().min(-100).max(100).optional(),
  gridOffsetY: z.number().min(-100).max(100).optional(),
  gridCellHeight: z.number().min(1).max(100).nullable().optional(),
  gridRotation: z.number().min(-45).max(45).optional(),
  gridOpacity: z.number().min(0).max(1).optional(),
  // Fog of war (issue #40, phase 3) — dm only. Replace the whole fog state (enable/disable +
  // revealed rectangles); null clears it. The dedicated reveal_map_region MCP tool appends
  // a single rectangle for an AI DM without round-tripping the full mask.
  fog: FogState.nullable().optional(),
  // Shared AoE templates (issue #238) — dm only. Replace the whole template list (empty clears).
  aoe: z.array(AoeTemplate).max(50).optional(),
  // Entity-level secrecy (issue #262) — dm only. true hides the encounter (roster + difficulty)
  // from non-DM reads; the DM "reveals" it by patching hidden back to false.
  hidden: z.boolean().optional(),
  // Monster-HP display dial (issue #1925) — dm only, enforced server-side. Switching modes
  // mid-fight takes effect on the next non-DM read (SSE refetch); no combatant data changes.
  monsterHpDisplay: MonsterHpDisplay.optional(),
  // Turn timer pacing limit (issue #1935) — dm only, like the rest of this shape. 0 turns the
  // limit off (elapsed-only, DM-facing). `turnStartedAt` is intentionally NOT here: it is
  // server-managed only and can never be set via PATCH.
  turnTimerSeconds: z.number().int().nonnegative().optional(),
});

/** DM control for the 13th Age escalation die: hold automatic advancement and/or override it. */
export const EncounterEscalationUpdate = z.object({
  held: z.boolean().optional(),
  // null clears an override; omitted leaves the current override unchanged.
  override: z.number().int().min(0).max(6).nullable().optional(),
});
export type EncounterEscalationUpdate = z.infer<typeof EncounterEscalationUpdate>;

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
  mapAlignment: MapAlignment.optional(),
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

/**
 * Result of a *preview* generate call (issue #409): the rendered SVG markup plus the
 * same reproducibility/grid metadata a real generate returns — but with NO attachment.
 * The map-generation wizard renders this to show the DM a candidate map (and lets them
 * reroll the seed) WITHOUT persisting anything, so previewing/rerolling never leaves an
 * orphan attachment or burns the campaign's storage quota. Because generation is
 * deterministic by seed, "Use this map" reproduces the previewed map exactly by replaying
 * the same seed through the normal (persisting) generate/attach endpoints.
 */
export const GeneratedMapPreview = z.object({
  svg: z.string(),
  seed: z.string(),
  kind: MapKind,
  widthCells: z.number().int().positive(),
  heightCells: z.number().int().positive(),
  roomCount: z.number().int().nonnegative(),
  gridConfig: MapGridConfig,
});
export type GeneratedMapPreview = z.infer<typeof GeneratedMapPreview>;

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

// ---------- genuine AI map generation (issue #410) ----------
// Turns a DM's free-form brief ("a fog-drowned crypt with a collapsed altar and two
// flanking corridors") into map candidates. Unlike the deterministic procedural
// generator (#306), this ROUTES through the configured AI provider when it can actually
// make an image — and stays HONEST when it can't: a text-only provider (Anthropic) can
// only produce a structured BLUEPRINT, which Campfire renders through its OWN procedural
// renderer and labels as such (never "Anthropic generated this image"). The whole flow is
// orphan-safe: previews live in memory and NOTHING is written to disk or the attachment
// store until the DM explicitly attaches a chosen candidate.

/**
 * Coerce a free-form theme string to a valid {@link MapTheme}, or `undefined` when it
 * can't be mapped (issue #410). The AI (or a chip) may propose any theme word
 * ("volcanic", "sunless", "sylvan"); the procedural renderer only knows a fixed palette
 * enum, so an un-normalized theme used to hard-FAIL `GenerateMapParams.parse`. This maps
 * common synonyms onto the nearest palette and drops anything unknown (so generation
 * proceeds with the kind's default theme instead of 400ing). Pure + deterministic.
 */
export function normalizeMapTheme(input: unknown): MapTheme | undefined {
  if (typeof input !== 'string') return undefined;
  const v = input.trim().toLowerCase();
  if (v === '') return undefined;
  // Exact enum match first.
  const direct = MapTheme.safeParse(v);
  if (direct.success) return direct.data;
  // Synonym / keyword mapping onto the fixed palette (stone/cavern/forest/crypt).
  const table: Array<[readonly string[], MapTheme]> = [
    [['cave', 'cavern', 'underground', 'grotto', 'volcanic', 'lava', 'subterranean', 'mine', 'sunless'], 'cavern'],
    [['forest', 'wood', 'woods', 'woodland', 'jungle', 'sylvan', 'grove', 'swamp', 'marsh', 'wilderness', 'outdoor', 'nature', 'grass'], 'forest'],
    [['crypt', 'tomb', 'grave', 'graveyard', 'catacomb', 'undead', 'necro', 'ossuary', 'mausoleum', 'burial'], 'crypt'],
    [['stone', 'dungeon', 'keep', 'castle', 'fortress', 'ruins', 'temple', 'brick', 'masonry', 'rock', 'gray', 'grey'], 'stone'],
  ];
  for (const [keys, theme] of table) {
    if (keys.some((k) => v.includes(k))) return theme;
  }
  return undefined;
}

/** Concept art (illustrative, no grid guarantee) vs a tactical battle map (grid-aligned). */
export const AiMapMode = z.enum(['battle-map', 'concept-art']);
export type AiMapMode = z.infer<typeof AiMapMode>;

/**
 * How a candidate was actually produced — the honesty backbone of #410. `image-provider`
 * means a real text-to-image provider drew it; `procedural-blueprint` means a text-only
 * provider produced a structured blueprint that Campfire's OWN procedural renderer drew
 * (labeled as such — we never claim the text model made an image); `external-instructions`
 * means no capable provider was available and Campfire returned steps for a client-side
 * external generator instead of a fabricated image.
 */
export const AiMapGenerationMethod = z.enum(['image-provider', 'procedural-blueprint', 'external-instructions']);
export type AiMapGenerationMethod = z.infer<typeof AiMapGenerationMethod>;

/** Lifecycle of an AI map generation job. */
export const AiMapJobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type AiMapJobStatus = z.infer<typeof AiMapJobStatus>;

/**
 * Structured "chips" the web UI offers so a brief is composable rather than a blank box
 * (issue #410): pick terrain / encounter type / mood / hazards / landmarks / grid size.
 * All optional; they are folded into the prompt AND used to seed the blueprint fallback.
 */
export const AiMapChips = z.object({
  terrain: z.string().max(60).optional(),
  encounterType: z.string().max(60).optional(),
  mood: z.string().max(60).optional(),
  hazards: z.array(z.string().max(40)).max(12).default([]),
  landmarks: z.array(z.string().max(40)).max(12).default([]),
  /** Grid size in cells (square), used for battle-map layout + calibration hints. */
  gridSizeCells: z.number().int().min(4).max(60).optional(),
});
export type AiMapChips = z.infer<typeof AiMapChips>;

/** Pixel dimensions for an image-provider render (bounded; ignored for procedural SVG). */
export const AiMapDimensions = z.object({
  width: z.number().int().min(256).max(4096),
  height: z.number().int().min(256).max(4096),
});
export type AiMapDimensions = z.infer<typeof AiMapDimensions>;

/**
 * The request to generate map candidates (issue #410). `theme` is a FREE-FORM string here
 * (normalized server-side via {@link normalizeMapTheme}); `count` bounds the number of
 * previews (2–4 typical). `includeCampaignSecrets` is false by default — campaign secrets
 * are NEVER sent to a provider unless the DM explicitly opts in.
 */
export const AiMapGenerationRequest = z.object({
  prompt: z.string().min(1).max(2000),
  mode: AiMapMode.default('battle-map'),
  chips: AiMapChips.optional(),
  kind: MapKind.optional(),
  size: MapSize.optional(),
  theme: z.string().max(60).optional(),
  dimensions: AiMapDimensions.optional(),
  count: z.number().int().min(1).max(4).default(2),
  seed: z.string().min(1).max(64).optional(),
  complexity: z.number().min(0).max(1).optional(),
  gridScale: z.number().positive().max(1000).optional(),
  gridUnit: z.string().min(1).max(12).optional(),
  /** Explicitly opt in to include DM-only campaign context in the prompt (default: never). */
  includeCampaignSecrets: z.boolean().default(false),
  /** Override the image model for this request (else the provider's configured default). */
  imageModel: z.string().min(1).max(120).optional(),
});
export type AiMapGenerationRequest = z.infer<typeof AiMapGenerationRequest>;

/** Result of the deterministic content-moderation gate run on the prompt before spending. */
export const AiMapModeration = z.object({
  flagged: z.boolean(),
  categories: z.array(z.string().max(40)).default([]),
  note: z.string().max(400).nullable().default(null),
});
export type AiMapModeration = z.infer<typeof AiMapModeration>;

/** Honest provenance recorded for every candidate + persisted with the attachment audit. */
export const AiMapProvenance = z.object({
  method: AiMapGenerationMethod,
  /** Provider type that served (or would have served) the request; null for external-instructions. */
  providerType: z.string().nullable(),
  model: z.string().nullable(),
  /** Human-readable, HONEST label shown in the UI + stamped into the audit trail. */
  label: z.string().max(300),
  seed: z.string().nullable().default(null),
});
export type AiMapProvenance = z.infer<typeof AiMapProvenance>;

/** Rough cost/usage surfaced BEFORE and after generation so the DM can decide to spend. */
export const AiMapCost = z.object({
  imageCount: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative().default(0),
  /** Best-effort estimate in USD when the provider/model pricing is known; else null. */
  estimatedUsd: z.number().nonnegative().nullable().default(null),
});
export type AiMapCost = z.infer<typeof AiMapCost>;

/** A single generated candidate the DM can select / refine / crop / attach. */
export const AiMapPreview = z.object({
  id: z.string(),
  method: AiMapGenerationMethod,
  /** Inline SVG markup (procedural-blueprint renders) — mutually exclusive with imageBase64. */
  svg: z.string().nullable().default(null),
  /** Base64-encoded raster bytes (image-provider renders) — mutually exclusive with svg. */
  imageBase64: z.string().nullable().default(null),
  mime: z.string().max(60),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  seed: z.string(),
  gridConfig: MapGridConfig.nullable().default(null),
  provenance: AiMapProvenance,
  /** Per-candidate warnings (e.g. "grid not guaranteed on a concept-art render"). */
  warnings: z.array(z.string().max(200)).default([]),
});
export type AiMapPreview = z.infer<typeof AiMapPreview>;

/**
 * Readiness hints shown BEFORE generating (issue #410): whether doors/corridors/grid are
 * likely to work for the chosen mode/provider, plus warnings. Concept-art + raster image
 * providers cannot guarantee a usable grid or connected corridors, so the UI warns.
 */
export const AiMapReadiness = z.object({
  mode: AiMapMode,
  method: AiMapGenerationMethod,
  gridLikely: z.boolean(),
  doorsLikely: z.boolean(),
  corridorsLikely: z.boolean(),
  warnings: z.array(z.string().max(200)).default([]),
  cost: AiMapCost,
  moderation: AiMapModeration,
  /** Declared capabilities of the resolved provider (null when none configured). */
  capabilities: AiProviderCapabilities.nullable().default(null),
});
export type AiMapReadiness = z.infer<typeof AiMapReadiness>;

/**
 * The full job view returned by create/status/refine (issue #410). Previews are in-memory
 * only until attached; `externalInstructions` is populated for the external-instructions
 * fallback so a DM without a capable provider still has a concrete next step.
 */
export const AiMapGenerationJob = z.object({
  id: z.string(),
  campaignId: Id,
  status: AiMapJobStatus,
  progress: z.number().int().min(0).max(100),
  mode: AiMapMode,
  method: AiMapGenerationMethod,
  prompt: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  dimensions: AiMapDimensions.nullable().default(null),
  moderation: AiMapModeration,
  cost: AiMapCost,
  previews: z.array(AiMapPreview).default([]),
  externalInstructions: z.array(z.string().max(400)).default([]),
  warnings: z.array(z.string().max(200)).default([]),
  error: z.string().max(400).nullable().default(null),
  createdBy: z.string(),
  ...timestamps,
});
export type AiMapGenerationJob = z.infer<typeof AiMapGenerationJob>;

/** Refine an existing job: tweak the prompt/chips and regenerate (issue #410). */
export const AiMapRefineRequest = z.object({
  prompt: z.string().min(1).max(2000).optional(),
  chips: AiMapChips.optional(),
  count: z.number().int().min(1).max(4).optional(),
  /** Reuse this preview's seed as the base for the refined render (keeps continuity). */
  fromPreviewId: z.string().optional(),
});
export type AiMapRefineRequest = z.infer<typeof AiMapRefineRequest>;

/**
 * Attach a chosen candidate as a real (DM-hidden) 'map' attachment (issue #410). Optional
 * crop/rotation and grid-calibration overrides are applied before persisting. When
 * `encounterId` is set the map is also linked to that encounter's battle map + grid — this
 * is the "reveal/replace a live map" path the driver seat is NOT permitted to take without
 * DM policy/approval.
 */
export const AttachGeneratedMapRequest = z.object({
  previewId: z.string().min(1),
  encounterId: Id.optional(),
  filename: z.string().max(160).optional(),
  mapAlignment: MapAlignment.optional(),
});
export type AttachGeneratedMapRequest = z.infer<typeof AttachGeneratedMapRequest>;

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
  // Hazards are opt-in encounter building blocks. When true, first-class hazard entries
  // join monsters in the same rating/XP budget search; false/omitted preserves legacy output.
  includeHazards: z.boolean().optional(),
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
  // Upper bound on the number of monsters/hazards (before the shape's own bound). Defaults to 12.
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

/** One suggested monster or hazard line (a stack of `count` identical entries). */
export const EncounterSuggestionCombatant = z.object({
  ruleEntryId: Id, // compendium statblock id — feed straight to add_combatant
  name: z.string(),
  entryType: z.enum(['monster', 'hazard']).default('monster'),
  cr: z.number().nullable(), // numeric rating used by the active budget — CR for monsters, level-as-CR for PF2e/SF2e hazards (null if unparseable)
  xp: z.number().int().nonnegative(), // per-entry XP (monster or hazard; 5e CR→XP table)
  hpMax: z.number().int().nullable(), // resolved max HP, when the statblock carries it (null when unknown)
  count: z.number().int().min(1), // how many of this entry (monster or hazard) to add
  // Issue #1927: 'homebrew' when the entry is the campaign's own homebrew (rule_entries row
  // with a non-null campaignId), 'pack' for a globally installed compendium entry. Defaults
  // to 'pack' so payloads persisted before this change still parse.
  source: z.enum(['pack', 'homebrew']).default('pack'),
});
export type EncounterSuggestionCombatant = z.infer<typeof EncounterSuggestionCombatant>;

/**
 * Issue #1928: whether the REPORTED encounter difficulty is the rule system's own audited
 * XP/CR budget math.
 *
 * - `supported` ({@link encounterDifficultySupported} true — 5e and the empty/unrecognized-slug
 *   fallback): the reported `difficulty` is that system's own audited math.
 * - `heuristic` (PF2e, OSR, Open Legend, …): the roster was SIZED by the internal 5e-shaped
 *   count/CR pass, and `totalXp` is that pass's own adjusted total — but the reported
 *   `difficulty` is `status: 'unsupported'` with a **null band**. `heuristic` therefore means
 *   the ABSENCE of an audited reported difficulty, NOT a 5e-shaped estimate of one: there is no
 *   band in the payload to report, and a consumer must not present one. `matchedBand` likewise
 *   describes only the sizing pass and can be `true` beside that null band.
 *
 * Never blocks generation/preview — the roster is valid either way; this only labels what the
 * reported difficulty is, and is not.
 */
export const DifficultySupport = z.enum(['supported', 'heuristic']);
export type DifficultySupport = z.infer<typeof DifficultySupport>;

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
  //
  // Issue #1928: this reflects the ROSTER-SIZING pass only, which is always 5e-shaped, and is
  // NOT a claim about `difficulty`. When `difficultySupport` is `'heuristic'`, `difficulty`
  // is `unsupported` with a null band while this can still be `true` — meaning "the 5e-shaped
  // sizing heuristic hit the band you asked for", not "this system says the fight is that
  // hard". Read it together with `difficultySupport`; it is deliberately not derived from the
  // reported band, because forcing it false for a non-5e system would misreport a sizing pass
  // that genuinely did match.
  matchedBand: z.boolean(),
  /** Issue #1928: whether `difficulty` is the system's own audited math or a 5e-shaped heuristic. */
  difficultySupport: DifficultySupport,
});
export type EncounterSuggestion = z.infer<typeof EncounterSuggestion>;

// ---------- encounter preview / tune / idempotent commit wizard (issue #412) ----------
// The generator (#304) produced a one-shot homogeneous suggestion. The DM wizard needs a
// richer, INTERACTIVE contract: a non-mutating preview that returns a multi-slot roster with
// per-creature inspection data + a difficulty EXPLANATION + actionable warnings, a set of
// deterministic TUNE operations (reroll all / reroll one slot / swap / adjust count / pin) that
// round-trip a plan so re-rolls are reproducible and pinned slots are preserved, and an
// IDEMPOTENT commit that atomically creates the encounter + combatants (+ links/map/grid/tokens)
// with no partial encounters or duplicate combatants. Preview stays read-only; commit is the
// single write. All three are reused by REST and MCP.

/**
 * Per-creature inspection data lifted from a compendium statblock for the preview roster
 * (issue #412): the AC/HP/actions/saves/traits a DM expands inline. Every field is best-effort
 * and nullable — a manual/partial statblock simply omits what it lacks (surfaced as a warning),
 * never fabricated. Labels come from the adapter's presentation metadata upstream; the values
 * here are the raw mechanical facts.
 */
export const EncounterCreatureInspection = z.object({
  /** True when the linked rule entry resolved to a usable statblock. */
  hasStatblock: z.boolean(),
  size: z.string().max(60).nullable().default(null),
  creatureType: z.string().max(120).nullable().default(null),
  armorClass: z.number().int().nullable().default(null),
  hitPointsMax: z.number().int().nullable().default(null),
  hitPointsText: z.string().max(80).nullable().default(null),
  speed: z.string().max(200).nullable().default(null),
  challengeRating: z.number().nullable().default(null),
  xp: z.number().int().nonnegative(),
  /** Ability scores/mods as the statblock lists them (raw, adapter representation applies). */
  abilities: z.array(z.object({ name: z.string().max(40), value: z.string().max(20) })).max(24).default([]),
  savingThrows: z.array(z.object({ name: z.string().max(40), value: z.string().max(20) })).max(24).default([]),
  traits: z.array(z.object({ name: z.string().max(120), text: z.string().max(1200) })).max(50).default([]),
  actions: z.array(z.object({ name: z.string().max(120), text: z.string().max(1200) })).max(50).default([]),
});
export type EncounterCreatureInspection = z.infer<typeof EncounterCreatureInspection>;

/** Machine-readable warning category surfaced on a preview (issue #412). */
export const EncounterWarningCode = z.enum([
  'role-duplication', // the same statblock fills 2+ slots
  'action-economy', // monster/PC action-count imbalance (solo vs party, or swarm)
  'missing-statblock', // a slot's creature has no resolvable HP/CR
  'unsupported-system', // the rule system has no encounter-budget math
  'difficulty-unknown', // monsters present but carry no CR/XP to score
  'swinginess', // high-variance fight (a lone big creature, or well over Deadly)
  'empty-roster', // no monsters were selected
  'no-candidates', // the compendium had nothing to pick from
  'band-miss', // the requested band could not be assembled from the compendium
]);
export type EncounterWarningCode = z.infer<typeof EncounterWarningCode>;

export const EncounterWarning = z.object({
  code: EncounterWarningCode,
  severity: z.enum(['info', 'warn']),
  message: z.string().min(1).max(400),
});
export type EncounterWarning = z.infer<typeof EncounterWarning>;

/**
 * One resolved slot in a preview roster (issue #412). `slotId` is a stable handle the tune
 * operations target; `seed` makes a per-slot reroll reproducible; `pinned` protects a slot from
 * reroll-all. A slot is a stack of `count` identical creatures (maps cleanly onto add_combatant).
 */
export const EncounterRosterSlot = z.object({
  slotId: z.string().min(1).max(40),
  ruleEntryId: Id,
  name: z.string(),
  entryType: z.enum(['monster', 'hazard']).default('monster'),
  cr: z.number().nullable(),
  xp: z.number().int().nonnegative(),
  hpMax: z.number().int().nullable(),
  count: z.number().int().min(1),
  pinned: z.boolean(),
  seed: z.number().int().nonnegative(),
  inspection: EncounterCreatureInspection,
  // Issue #1927: 'homebrew' for the campaign's own rule_entries row (non-null campaignId),
  // 'pack' for a globally installed compendium entry. Defaults to 'pack' so payloads
  // persisted before this change still parse.
  source: z.enum(['pack', 'homebrew']).default('pack'),
});
export type EncounterRosterSlot = z.infer<typeof EncounterRosterSlot>;

/**
 * The slot state a client rounds-trips back into a preview/tune/commit request (issue #412) —
 * just the plan (no resolved inspection). The server re-resolves creatures + difficulty from
 * these, so tuning is stateless: reroll/pin/swap are pure functions of the plan + a seed.
 */
export const EncounterRosterSlotInput = z.object({
  slotId: z.string().min(1).max(40),
  ruleEntryId: Id,
  count: z.number().int().min(1).max(50),
  pinned: z.boolean().default(false),
  seed: z.number().int().nonnegative().max(4294967295),
  entryType: z.enum(['monster', 'hazard']).optional(),
});
export type EncounterRosterSlotInput = z.infer<typeof EncounterRosterSlotInput>;

/**
 * A single tune operation applied to the current plan (issue #412). Deterministic: `reroll-*`
 * mint/accept a seed so the same seed reproduces the same pick; `pin` protects a slot from
 * `reroll-all`; `swap-slot` replaces a slot's creature with an explicit compendium entry;
 * `adjust-count` changes the stack size; add/remove grow or shrink the roster.
 */
export const EncounterTuneOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('reroll-all'), seed: z.number().int().nonnegative().max(4294967295).optional() }),
  z.object({ op: z.literal('reroll-slot'), slotId: z.string().min(1).max(40), seed: z.number().int().nonnegative().max(4294967295).optional() }),
  z.object({ op: z.literal('swap-slot'), slotId: z.string().min(1).max(40), ruleEntryId: Id }),
  z.object({ op: z.literal('adjust-count'), slotId: z.string().min(1).max(40), count: z.number().int().min(1).max(50) }),
  z.object({ op: z.literal('pin'), slotId: z.string().min(1).max(40), pinned: z.boolean() }),
  z.object({ op: z.literal('add-slot'), seed: z.number().int().nonnegative().max(4294967295).optional() }),
  z.object({ op: z.literal('remove-slot'), slotId: z.string().min(1).max(40) }),
]);
export type EncounterTuneOp = z.infer<typeof EncounterTuneOp>;

/**
 * Request body for POST /campaigns/:id/encounters/preview (issue #412) and the preview_encounter
 * MCP tool. A first call with just `difficulty` (+ optional filters/party/shape/count/seed)
 * generates a fresh roster; passing back `roster` (the plan) with an optional `tune` op applies
 * a deterministic tuning step. NON-MUTATING — nothing is persisted.
 */
export const EncounterPreviewRequest = z.object({
  difficulty: DifficultyBand,
  party: z.array(z.number().int().min(1).max(20)).max(20).optional(),
  filters: EncounterGenerateFilters.optional(),
  count: z.number().int().min(1).max(30).optional(),
  shape: EncounterShape.optional(),
  seed: z.number().int().nonnegative().max(4294967295).optional(),
  /** The current plan being tuned; omit for a fresh generation. */
  roster: z.array(EncounterRosterSlotInput).max(30).optional(),
  /** A tuning operation to apply to `roster`. */
  tune: EncounterTuneOp.optional(),
});
export type EncounterPreviewRequest = z.infer<typeof EncounterPreviewRequest>;

/**
 * Read-only preview result (issue #412): the resolved multi-slot roster, the adapter-owned
 * difficulty + a human-readable explanation, actionable warnings, and, when the compendium or
 * the rule system can't support the request, actionable `fallbacks` (never a dead end). The
 * `plan` echoes the round-trippable slot inputs so a client can send them straight back into a
 * tune/commit call.
 */
export const EncounterPreview = z.object({
  roster: z.array(EncounterRosterSlot),
  plan: z.array(EncounterRosterSlotInput),
  targetBand: DifficultyBand,
  difficulty: EncounterDifficulty,
  explanation: EncounterDifficultyExplanation,
  totalXp: z.number().int().nonnegative(),
  shape: EncounterShape,
  seed: z.number().int().nonnegative(),
  // Issue #1928: sizing-pass only — see the note on EncounterSuggestion.matchedBand. Can be
  // `true` alongside an `unsupported` `difficulty`; read it with `difficultySupport`.
  matchedBand: z.boolean(),
  party: z.array(z.number().int()),
  warnings: z.array(EncounterWarning),
  /** Actionable next steps when the compendium is empty or the system lacks budget math. */
  fallbacks: z.array(z.string().max(400)),
  /** Issue #1928: whether `difficulty` is the system's own audited math or a 5e-shaped heuristic. */
  difficultySupport: DifficultySupport,
});
export type EncounterPreview = z.infer<typeof EncounterPreview>;

/** Optional per-slot token placement applied atomically at commit (issue #412). */
export const EncounterCommitTokenPlacement = z.object({
  slotId: z.string().min(1).max(40),
  /** Base position (0–100 percent of the map). Copies in a stack fan out from here. */
  tokenX: z.number().min(0).max(100),
  tokenY: z.number().min(0).max(100),
});
export type EncounterCommitTokenPlacement = z.infer<typeof EncounterCommitTokenPlacement>;

/** Optional map + grid to attach atomically at commit (issue #412). */
export const EncounterCommitMap = z.object({
  /** An existing campaign attachment (kind map|image) to set as the battle map. */
  mapAttachmentId: Id,
  gridSize: z.number().min(1).max(100).optional(),
  gridScale: z.number().positive().optional(),
  gridUnit: z.string().max(12).optional(),
  gridType: GridType.optional(),
});
export type EncounterCommitMap = z.infer<typeof EncounterCommitMap>;

/**
 * Request body for POST /campaigns/:id/encounters/commit (issue #412) and the commit_encounter
 * MCP tool. Commits a tuned roster to a real encounter in ONE atomic transaction. `idempotencyKey`
 * makes a retried commit a no-op that returns the SAME encounter (never a duplicate). The
 * encounter defaults hidden + preparing (DM prep, #262). Links/map/grid/token placement are all
 * applied inside the same transaction — either everything lands or nothing does.
 */
export const EncounterCommit = z.object({
  idempotencyKey: z.string().min(1).max(120),
  name: z.string().min(1).max(120).optional(),
  targetBand: DifficultyBand.optional(),
  party: z.array(z.number().int().min(1).max(20)).max(20).optional(),
  roster: z.array(EncounterRosterSlotInput).min(1).max(30),
  locationId: Id.nullable().optional(),
  questId: Id.nullable().optional(),
  sessionId: Id.nullable().optional(),
  hidden: z.boolean().optional(),
  map: EncounterCommitMap.optional(),
  tokens: z.array(EncounterCommitTokenPlacement).max(30).optional(),
  /** Provenance for the audit trail (which surface committed, and any manual edits). */
  source: z.string().max(60).optional(),
  manualEdits: z.array(z.string().max(200)).max(50).optional(),
});
export type EncounterCommit = z.infer<typeof EncounterCommit>;

/** Result of a commit (issue #412): the created encounter + whether this was an idempotent replay. */
export const EncounterCommitResult = z.object({
  encounter: z.lazy(() => EncounterWithCombatants),
  idempotent: z.boolean(),
});
export type EncounterCommitResult = z.infer<typeof EncounterCommitResult>;

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

// ---------- current-turn workspace: effects + per-turn action economy (issue #413) ----------

/**
 * When a repeating effect prompts a save or applies its tick (issue #413). 5e "save ends"
 * effects repeat at the END of the affected creature's turn; ongoing damage / regeneration
 * conventionally apply at the START. `none` = no timed prompt (a static condition/buff).
 */
export const EffectTiming = z.enum(['start-of-turn', 'end-of-turn', 'none']);
export type EffectTiming = z.infer<typeof EffectTiming>;

/** What an active effect does, so the workspace can raise the right start/end-turn prompt. */
export const ActiveEffectKind = z.enum(['ongoing-damage', 'regeneration', 'condition', 'buff', 'other']);
export type ActiveEffectKind = z.infer<typeof ActiveEffectKind>;

/**
 * One tracked active effect on a combatant (issue #413) — the structured counterpart to the
 * free-text `conditions` list, carrying DURATION and SAVE TIMING so the turn workspace can
 * prompt "ongoing 5 fire damage (start of turn)" or "repeat DC 13 CON save (ends at end of
 * turn)" and expire it automatically. `roundsRemaining` null = until removed; the service
 * decrements it at the owner's turn boundary and drops the effect at 0. Persisted as a JSON
 * array on the combatant (same convention as `conditions`), so it needs no new column per field.
 */
export const ActiveEffect = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  kind: ActiveEffectKind.default('other'),
  timing: EffectTiming.default('none'),
  // Rounds left before the effect expires; null = indefinite (until manually removed).
  roundsRemaining: z.number().int().nonnegative().nullable().default(null),
  // Ongoing damage / regeneration magnitude applied at `timing`; null = no automatic HP tick.
  amount: z.number().int().nullable().default(null),
  // Repeat-save context for "save ends" effects; null when the effect has no save.
  saveAbility: z.string().max(24).nullable().default(null),
  saveDc: z.number().int().nullable().default(null),
  notes: z.string().max(300).default(''),
});
export type ActiveEffect = z.infer<typeof ActiveEffect>;

/**
 * One structured condition instance on a combatant (issue #423). Carries source/rule-entry provenance,
 * duration/expiry timing, repeat saves, concentration link, stack count, notes, and custom condition flag.
 * The legacy `combatant.conditions` string array is derived from instances via `deriveConditionNames()`.
 */
export const ConditionInstance = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  ruleEntryId: Id.nullable().default(null),
  source: z.string().max(160).nullable().default(null),
  sourceCombatantId: Id.nullable().default(null),
  durationRounds: z.number().int().nonnegative().nullable().default(null),
  roundsRemaining: z.number().int().nonnegative().nullable().default(null),
  timing: EffectTiming.default('none'),
  saveTiming: EffectTiming.default('none'),
  saveDc: z.number().int().nullable().default(null),
  saveAbility: z.string().max(24).nullable().default(null),
  isConcentration: z.boolean().default(false),
  stacks: z.number().int().min(1).max(99).default(1),
  notes: z.string().max(300).default(''),
  custom: z.boolean().default(false),
});
export type ConditionInstance = z.infer<typeof ConditionInstance>;

/**
 * Derive string condition names from a list of condition instances.
 */
export function deriveConditionNames(instances: readonly ConditionInstance[]): string[] {
  const set = new Set<string>();
  for (const c of instances) {
    if (c.name.trim().length > 0) {
      set.add(c.name.trim());
    }
  }
  return [...set];
}

/**
 * Per-turn action-economy + resource tracking on a combatant (issue #413). `used` counts
 * consumption against the adapter's {@link ActionEconomyModel} slot keys (e.g. `{ action: 1,
 * bonus: 0 }`); `movementUsedFt` is feet moved this turn; `concentration` names the effect the
 * combatant is concentrating on (null = none). `pendingConcentrationChecks` is the durable,
 * bounded queue created when 5e damage lands. `delaying` / `readied` capture the DM/table
 * turn-order tools (a combatant who delayed, or a readied action + its trigger). The whole
 * `used` map (including reaction) and movement reset at the START of the owner's turn by the
 * service — a 5e reaction refreshes at the start of your turn — while `concentration` persists
 * across turns until it is broken. Persisted as one JSON column on the combatant.
 */
export const CombatantTurnState = z.object({
  // Factory default so each parse gets its OWN empty `used` map — the service mutates
  // `turnState.used` in place, and a shared default object would leak usage between
  // combatants (and could mutate the module-level EMPTY_TURN_STATE).
  used: z.record(z.string().max(40), z.number().int().nonnegative()).default(() => ({})),
  movementUsedFt: z.number().nonnegative().default(0),
  concentration: z.string().max(160).nullable().default(null),
  pendingConcentrationChecks: z
    .array(PendingConcentrationCheck)
    .max(MAX_PENDING_CONCENTRATION_CHECKS)
    .default(() => []),
  delaying: z.boolean().default(false),
  readied: z.string().max(200).nullable().default(null),
});
export type CombatantTurnState = z.infer<typeof CombatantTurnState>;

/** Default (empty) turn state — a combatant that has used nothing and holds no effects. */
export const EMPTY_TURN_STATE: CombatantTurnState = {
  used: {},
  movementUsedFt: 0,
  concentration: null,
  pendingConcentrationChecks: [],
  delaying: false,
  readied: null,
};

/** OSR group-initiative side label. Trims; empty/whitespace normalizes to null. */
export const InitiativeGroup = z.preprocess(
  (val) => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    return val;
  },
  z.string().min(1).max(40).nullable(),
);

export const Combatant = z.object({
  id: Id,
  encounterId: Id,
  kind: CombatantKind,
  characterId: Id.nullable().default(null),
  // Set for kind==='npc': the campaign NPC this combatant represents (identity/icon;
  // its NPC page + dmSecret stay DM-gated as usual). Null for characters/monsters.
  npcId: Id.nullable().default(null),
  // Nullable when captured; omitted by legacy persisted/exported combatants.
  npcDispositionSnapshot: z.string().max(40).nullable().optional(),
  name: z.string().min(1).max(120),
  initiative: z.number().int().nullable().default(null),
  initMod: z.number().int().default(0),
  initiativeBreakdown: CombatantInitiativeBreakdown.nullable().default(null),
  // Initiative side/group for OSR group-initiative variants (issue #765). Combatants sharing
  // the same group name (e.g. "party", "monsters") roll one d6 for the whole side. null =
  // individual initiative (default for 5e and individual-mode OSR).
  initiativeGroup: InitiativeGroup.default(null),
  // Nullable so a monster's exact HP can be redacted to `null` for non-DM viewers
  // (issue #43); `hpBand` then carries the coarse status instead.
  hpCurrent: z.number().int().nullable().default(10),
  hpMax: z.number().int().min(1).nullable().default(10),
  spCurrent: z.number().int().min(0).nullable().default(0),
  spMax: z.number().int().min(0).nullable().default(0),
  rpCurrent: z.number().int().min(0).nullable().default(0),
  rpMax: z.number().int().min(0).nullable().default(0),
  eac: z.number().int().nullable().default(null),
  kac: z.number().int().nullable().default(null),
  // Issue #1910: add-time snapshot of the linked character's speed, mirroring the
  // hp/death-state snapshot convention above — a mid-fight sheet edit must not
  // retroactively change a running encounter's movement budget. Populated only for
  // kind==='character' combatants at addCombatant time (and both bulk party auto-add
  // paths, and campaign clone's combatant carry-forward); monsters/NPCs, combatants
  // added before this column existed, AND a character with no speed set at add
  // time (the common case — Character.speed defaults to null) all keep it null.
  // Both getTurnWorkspace's DISPLAY and ActionResolverService.resolveActionEconomyCost's
  // spend/guard ENFORCEMENT resolve a null snapshot straight to the adapter's movement
  // max (e.g. 30 ft for 5e), through the shared `movementSlotMax` (encounters.logic.ts)
  // — deliberately NOT falling through to the linked character's live speed, which
  // would be unable to tell those cases apart from "genuinely unset at add time" and
  // would silently un-freeze the snapshot for the common case (round 4 review finding
  // on PR #1980). Routing both paths through the same function also closes a round-5
  // finding: display and enforcement independently computing "snapshot or adapter
  // default" drifted apart once the DISPLAY got a per-combatant value and the
  // ENFORCEMENT still didn't, so a fast PC was told a number the spend guard wouldn't
  // honor and a slow PC was allowed more than their own sheet said.
  speed: z.number().int().min(0).nullable().default(null),
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
  // DM manual-reorder override (issue #1923 review finding 1; narrowed by #2084 finding
  // 1; corrected to whole-tie-group scope by #2095 review — Devin, Codex, and Copilot
  // independently). This exists because a running encounter's `sortCombatants` orders by
  // initiative, and an adapter's `initiativeTiebreak` (e.g. 5e's
  // `initModDescThenSortOrderAsc`) compares `initMod` BEFORE `sortOrder` — a pure
  // `sortOrder` rewrite is silently discarded by the adapter tiebreak whenever the tied
  // combatants have different `initMod` (different DEX).
  //
  // Set by `reorderCombatant` on EVERY row that shares the moved combatant's landing
  // (possibly just-reassigned) initiative value — its full tie group as it exists in the
  // newly computed order, all in one consistent `orderedIds` index space from that same
  // pass — never the whole roster, and NOT merely the rows the drag's own start/end
  // positions happened to cross. An earlier version stamped every combatant on every
  // drag, which meant one reorder disabled `adapter.initiativeTiebreak` for the entire
  // encounter, including ties the DM never touched; while `preparing` (before most rows
  // have a rolled initiative) that also meant the stamp encoded add order rather than DM
  // intent. A narrower revision then stamped only the moved combatant plus whichever
  // OTHER tie-group members the drag physically crossed — but `sortCombatants` puts ANY
  // stamped row ahead of ANY unstamped one within a tie (see below), with no regard for
  // whether that specific row was crossed, so a partial stamp did not merely fail to help
  // the untouched members — it actively sank them below the touched ones, an order the DM
  // never asked for. Stamping the WHOLE landing group closes that: a tie group nobody
  // dragged into stays entirely null so it keeps falling through to the adapter. Never
  // stamped for a null-initiative row — an unrolled tie is decided by `sortOrder` alone
  // (see `sortCombatants`'s own null/null branch and the `preparing` sort), so a stamp
  // there would outlive the roll and could wrongly decide a REAL tie later by insertion
  // order instead of the adapter.
  //
  // Cleared back to null whenever a combatant's OWN `initiative` value changes outside
  // this same reorder (a DM PATCH, or an overwrite re-roll) — the tie it was placed in no
  // longer exists once its number moves.
  //
  // `sortCombatants` consults this ahead of the adapter tiebreak whenever EITHER side has
  // a value: a stamped row always precedes an unstamped one, which keeps the comparator a
  // total order when a tie mixes stamped and unstamped rows (see that function's own
  // comment for the non-transitive cycle this prevents).
  manualOrder: z.number().int().nullable().default(null),
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
  // Current-turn workspace state (issue #413): per-turn action-economy usage, movement,
  // concentration, and delay/ready flags. Factory default so each parsed combatant gets a
  // FRESH turn-state (with its own `used` map) rather than sharing one mutable object.
  turnState: CombatantTurnState.default(() => ({
    used: {},
    movementUsedFt: 0,
    concentration: null,
    pendingConcentrationChecks: [],
    delaying: false,
    readied: null,
  })),
  // Structured active effects with duration + save timing (issue #413), alongside the
  // free-text `conditions`. Empty by default; capped so the JSON blob stays bounded.
  activeEffects: z.array(ActiveEffect).max(50).default([]),
  // Structured condition instances with source, duration, saves, concentration link, stacks (issue #423).
  conditionInstances: z.array(ConditionInstance).max(50).default([]),
  // Populated server-side when the linked statblock has legendary actions (issue #618).
  legendaryActions: LegendaryActionPool.nullable().default(null),
  // Inline homebrew statblock for manual monsters (issue #425). Null when HP/init-only
  // or when actions are expanded from a linked compendium entry at read time.
  statblock: CombatantStatblock.nullable().default(null),
  // Issue #1926: DM-controlled reveal for a monster/npc's statblock. Server-enforced —
  // when false, the non-DM read path (redactMonsterHp) nulls `statblock` the same way
  // it already bands exact HP; the ruleEntryId link itself is not gated by this flag
  // (compendium reads stay their own authorization surface, unchanged by this issue).
  statblockRevealed: z.boolean().default(false),
});
export type Combatant = z.infer<typeof Combatant>;

// Current (intentionally unversioned) contract for atomic battle-map placement.
// A preview is opaque to clients: it captures the exact roster slice the server
// checked, and apply rejects it rather than silently accepting a stale partial plan.
export const TokenBatchPlacement = z.object({
  combatantId: Id,
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});
export type TokenBatchPlacement = z.infer<typeof TokenBatchPlacement>;
export const TokenBatchPreviewRequest = z.object({
  placements: z.array(TokenBatchPlacement).min(1).max(100),
  // Percent token coordinates use independent map width/height axes. The client
  // supplies the currently rendered map height / width so the server can persist
  // and replay the same physical geometry for apply and undo.
  mapAspect: z.number().finite().positive().max(100),
});
export type TokenBatchPreviewRequest = z.infer<typeof TokenBatchPreviewRequest>;
export const TokenBatchApply = z.object({
  previewToken: z.string().min(16).max(4096),
  idempotencyKey: z.string().min(1).max(128),
});
export type TokenBatchApply = z.infer<typeof TokenBatchApply>;
export const TokenBatchUndo = z.object({
  undoToken: z.string().min(16).max(4096),
  idempotencyKey: z.string().min(1).max(128),
});
export type TokenBatchUndo = z.infer<typeof TokenBatchUndo>;
export const SavedTokenFormation = z.object({
  name: z.string().trim().min(1).max(80),
  // Formation slots deliberately name a side/kind, never a roster id.  A saved
  // formation is campaign reusable rather than tied to the encounter that created it.
  slots: z.array(z.object({ side: z.enum(['party', 'enemy', 'any']).default('any'), kind: CombatantKind.optional(), x: z.number().min(-100).max(100), y: z.number().min(-100).max(100) })).min(1).max(100),
});
export type SavedTokenFormation = z.infer<typeof SavedTokenFormation>;

export const CombatantCreate = z.object({
  kind: CombatantKind,
  duplicateOfCombatantId: Id.optional(),
  name: z.string().min(1).max(120).optional(), // required unless resolvable from ruleEntryId
  characterId: Id.optional(), // link a late-joining party member
  npcId: Id.optional(), // link a campaign NPC as an 'npc' combatant (identity/icon)
  ruleEntryId: Id.optional(),
  hpMax: z.number().int().min(1).optional(),
  initMod: z.number().int().optional(),
  tokenSize: TokenSize.optional(),
  // OSR group-initiative side label (issue #765). When the campaign adapter uses group
  // initiative, combatants on the same side share one d6 roll. Defaults to kind-based
  // ("party" for characters, "monsters" for monsters) when omitted on a group-mode system.
  initiativeGroup: InitiativeGroup.optional(),
  // Add N identical combatants in one call (issue #114). When >1 the names are
  // auto-suffixed "Goblin 1".."Goblin N" so duplicate monsters are distinguishable.
  // Ignored (single add, no suffix) for character/characterId adds — a PC is unique.
  count: z.number().int().min(1).max(50).optional(),
  // Inline homebrew statblock (issue #425). When omitted on a manual add, the server
  // seeds sensible defaults so the monster is immediately playable.
  statblock: CombatantStatblock.optional(),
  // Add from a saved campaign-library monster (snapshot copied server-side).
  libraryMonsterId: Id.optional(),
});
/** Retry key for a combatant removal whose response may be lost in transit. */
export const CombatantRemoveRequest = z.object({ idempotencyKey: IdempotencyKey.optional() });
export type CombatantRemoveRequest = z.infer<typeof CombatantRemoveRequest>;
/** The committed removal receipt; retain every field to retry either side safely. */
export const CombatantRemoveResult = z.object({ undoToken: z.string().uuid(), encounterId: Id, combatantId: Id });
export type CombatantRemoveResult = z.infer<typeof CombatantRemoveResult>;
export const CombatantRemoveUndo = z.object({ undoToken: z.string().uuid() });
export type CombatantRemoveUndo = z.infer<typeof CombatantRemoveUndo>;
/** How a target's saving throw changes a manually-applied damage roll. */
export const DamageSaveOutcome = z.enum(['full', 'half']);
export type DamageSaveOutcome = z.infer<typeof DamageSaveOutcome>;

/**
 * DM force-toggle of a combatant's limited-use action pool (issue #1921) — sets `spent`
 * directly to a value in `[0, max]` (server-clamped), rather than a relative delta, so a
 * single call both forces a recharge (`spent: 0`) and forces an exhaust (`spent: max`).
 * The target action is identified the SAME way `resolve_action`/`list_usable_actions`
 * identify one — by `actionIndex` or `actionName` on the combatant's current sheet/
 * statblock action list — never by the server's internal fingerprint+source spend key,
 * which is an implementation detail no caller should have to construct.
 */
export const CombatantActionUsesPatch = z
  .object({
    actionIndex: z.number().int().min(0).max(99).optional(),
    actionName: z.string().max(120).optional(),
    spent: z.number().int().min(0).max(99),
  })
  // Both identifiers optional individually, but at least one is required: a patch naming no
  // action at all is not a meaningful request, and letting it through only defers the failure
  // into `resolveActionUsesTarget` as a confusing "Action undefined not found" at write time.
  // Reject it at parse time, where the caller gets a field-level 400 instead.
  .refine((v) => v.actionIndex !== undefined || v.actionName !== undefined, {
    message: 'Provide actionIndex or actionName to identify which action to set.',
    path: ['actionIndex'],
  });
export type CombatantActionUsesPatch = z.infer<typeof CombatantActionUsesPatch>;

export const CombatantUpdate = z.object({
  hpDelta: z.number().int().optional(),
  // Direct encounter damage metadata (issue #605).  These fields are meaningful only
  // for negative hpDelta values; the server derives the final delta from the target's
  // statblock defences so REST, MCP, and the encounter UI use one rules path.
  damageType: z.string().trim().min(1).max(24).optional(),
  saveOutcome: DamageSaveOutcome.optional(),
  isCrit: z.boolean().optional(),
  // The dice-only portion of hpDelta.  On a critical hit the engine adds this once,
  // leaving the flat modifier untouched (5e's "double dice, not modifier" rule).
  damageDice: z.number().int().positive().optional(),
  hpSet: z.number().int().nonnegative().optional(),
  spDelta: z.number().int().optional(),
  spSet: z.number().int().nonnegative().optional(),
  rpDelta: z.number().int().optional(),
  rpSet: z.number().int().nonnegative().optional(),
  eac: z.number().int().nullable().optional(),
  kac: z.number().int().nullable().optional(),
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
  deathState: DeathState.optional(),
  addConditions: z.array(z.string().max(40)).optional(),
  removeConditions: z.array(z.string().max(40)).optional(),
  // Structured condition instance mutations (issue #423)
  addConditionInstance: ConditionInstance.optional().describe('Add a single structured condition instance. Preferred over addConditions.'),
  removeConditionInstanceId: z.string().min(1).max(40).optional().describe('Remove a structured condition instance by its ID (e.g. from conditionInstances).'),
  updateConditionInstance: ConditionInstance.optional().describe('Update an existing structured condition instance (must match its ID).'),
  conditionInstances: z.array(ConditionInstance).max(50).optional().describe('Absolute set of structured condition instances.'),
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
  // Inline homebrew statblock edits (issue #425) — dm only, enforced server-side.
  statblock: CombatantStatblock.optional(),
  // Reveal/hide this monster/npc's statblock to non-DM viewers (issue #1926) — dm
  // only, enforced server-side (rejected outright for a non-DM patch, alongside
  // name/hpMax/initMod/tokenSize/initiative above). Toggling logs a combat-log
  // 'note' event and an audit row.
  statblockRevealed: z.boolean().optional(),
  // DM force-toggle of a limited-use/recharge action's spend state (issue #1921) — dm
  // only, enforced server-side (rejected outright for a non-DM patch, same list as
  // statblockRevealed above). Audit-logged; does not touch action-economy or spell slots.
  actionUses: CombatantActionUsesPatch.optional(),
  // Issue #580: per-intent operation id. `hpDelta` / `spDelta` / `rpDelta` are
  // relative writes — replaying one double-damages. Send a key
  // minted at the click and a retry after a lost response replays the ORIGINAL
  // committed combatant (same hpCurrent, same death state) instead of re-applying.
  // Reusing one key for a DIFFERENT patch is a 409 IDEMPOTENCY_KEY_REUSE.
  idempotencyKey: IdempotencyKey,
});

/**
 * Body for `POST /encounters/:id/combatants/:cid/resources` (issue #1909) — spend or
 * restore ONE bounded resource or spell-slot level on a combatant mid-fight, whether it is
 * linked to a character sheet or an inline monster/NPC statblock. This is the delta-based,
 * transactional counterpart to `CombatantUpdate.statblock` above: flipping one Ki pip or one
 * spell-slot checkbox no longer requires PATCHing the whole statblock/character JSON built
 * from whatever the client last saw, which raced last-writer-wins across the ENTIRE blob
 * with a second writer (another tab, an MCP-driven AI DM) and silently reverted their
 * unrelated edits.
 *
 * `key` (a feature resource) and `spellLevel` (1–9) are alternatives, never both/neither.
 * `delta` is relative to the resource's current `used` (default +1, matching a single pip
 * click); 0 is rejected as a no-op that would still mint a `resource_changed` event for
 * nothing. Spending past 0 or restoring past `max` is a 400, never a silent clamp, matching
 * every other bounded-resource write in this schema (`ResourcePatch`/`SpellSlotPatch`).
 * `idempotencyKey` reuses the issue #580 convention `CombatantUpdate.idempotencyKey`
 * documents just above: this is a RELATIVE write, so a lost-response retry must replay the
 * original outcome rather than double-spend the resource.
 *
 * `expectedUsed` (issue #1909 review, Codex P2) closes a DIFFERENT race than the delta
 * mechanics above protect against: a pip click represents an ABSOLUTE intent ("set this
 * pip to used=1"), converted to a relative `delta` against whatever `used` this caller last
 * rendered. If two callers both last rendered `used: 0` and both click the first pip, both
 * send `delta: 1` — the transactional fresh-row read prevents the WHOLE-BLOB lost-update
 * this endpoint replaced (issue #1909's headline bug), but does nothing to stop the SECOND
 * delta from applying on top of the FIRST's fresh result (`used: 0 -> 1`, then `1 -> 2`),
 * silently landing on a value neither caller intended. Optional so a caller with a purely
 * relative intent (an AI DM's "restore 2 charges", or any caller not tracking a rendered
 * baseline) is unaffected; when present, the server verifies it against the FRESH `used`
 * inside the same transaction that computes `delta` and 409s on a mismatch instead of
 * applying a delta computed from a baseline that has since moved.
 */
export const CombatantResourceAdjust = z
  .object({
    key: z.string().min(1).max(80).optional(),
    spellLevel: z.number().int().min(1).max(9).optional(),
    delta: z.number().int().optional().default(1),
    expectedUsed: z.number().int().min(0).optional(),
    idempotencyKey: IdempotencyKey,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.key !== undefined) === (value.spellLevel !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one of key or spellLevel',
        path: ['key'],
      });
    }
    if (value.delta === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'delta must not be 0', path: ['delta'] });
    }
  });
export type CombatantResourceAdjust = z.infer<typeof CombatantResourceAdjust>;

/**
 * Body for the server-authoritative death-save action (issue #1462). The caller supplies
 * no die face: the server rolls exactly one d20, applies that same face, and writes it to
 * the shared dice log. An explicit contract prevents REST and MCP from drifting into
 * accepting a player-selected result.
 */
export const DeathSaveRollRequest = z.object({
  // Unlike legacy combatant PATCHes, this endpoint is new and every call changes
  // state. Require an intent key so a client that loses its response can replay
  // the same d20 outcome rather than roll again.
  idempotencyKey: z.string().min(1).max(128),
});
export type DeathSaveRollRequest = z.infer<typeof DeathSaveRollRequest>;

/**
 * Body for the server-authoritative per-combatant initiative roll (issue #1904). The
 * caller supplies no die result — the server rolls `adapter.initiativeDie + initMod`,
 * writes the roll + its breakdown, and records one matching campaign-shared dice-log
 * entry (skipped only for a hidden encounter, since the dice log is campaign-wide). A
 * combatant that already has initiative set 409s unless `overwrite` is sent by the DM.
 * 400s for a group-initiative rule system — a side shares one roll, which stays
 * exclusively the DM's bulk `POST /encounters/:id/roll-initiative`.
 */
export const CombatantRollInitiativeRequest = z.object({
  // Same replay contract as DeathSaveRollRequest: a lost-response retry replays the
  // committed roll instead of rolling again.
  idempotencyKey: z.string().min(1).max(128),
  // DM-only escape hatch to re-roll a combatant that already has initiative set. A
  // non-DM caller sending this is still 409'd server-side — the field is silently
  // ignored rather than granting a player overwrite power via a body flag.
  overwrite: z.boolean().optional(),
});
export type CombatantRollInitiativeRequest = z.infer<typeof CombatantRollInitiativeRequest>;

/**
 * Body for the DM-only manual reorder (issue #1923) — POST
 * /encounters/:id/combatants/:cid/reorder. `sortCombatants`'s own tiebreak comparators
 * (initiative-tiebreak.ts) are the automatic answer to a tie; this is the documented manual
 * escape hatch, and the only mechanical expression of Delay/Ready ("the fighter acts after
 * the wizard now"). `afterCombatantId` names the combatant the moved one should land
 * immediately after under `sortCombatants`, or the literal `'top'` to become first.
 * `expectedTurnVersion` is a compare-and-set against the encounter's monotonic
 * `turnVersion` (bumped on every turn advance) — a stale drag issued after the turn moved
 * on 409s instead of silently reordering against a roster the DM is no longer looking at.
 */
export const CombatantReorderRequest = z.object({
  afterCombatantId: z.union([Id, z.literal('top')]),
  expectedTurnVersion: z.number().int().nonnegative().optional(),
});
export type CombatantReorderRequest = z.infer<typeof CombatantReorderRequest>;

/**
 * Combat HP slice compared against the character sheet on reopen/re-end (issue #466).
 * When the sheet advanced after /end, the DM must choose a resync direction before
 * reopening — never silently overwrite intervening healing/rest.
 */
export const HpSyncSlice = z.object({
  hpCurrent: z.number().int(),
  hpTemp: z.number().int().min(0),
  spCurrent: z.number().int().min(0).default(0),
  spMax: z.number().int().min(0).default(0),
  rpCurrent: z.number().int().min(0).default(0),
  rpMax: z.number().int().min(0).default(0),
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
// 'effect' (issue #413) records a start/end-of-turn effect resolution (ongoing damage,
// regeneration tick, an expired effect, a prompted repeat save). Appended alongside the
// existing types by the turn-advancement path; free-text column, so older DBs are unaffected.
export const EncounterEventType = z.enum(['damage', 'heal', 'condition', 'death', 'roll', 'turn', 'note', 'override', 'correction', 'effect', 'resource_changed', 'token_batch']);
export type EncounterEventType = z.infer<typeof EncounterEventType>;

/** Phase within an action-resolution event chain (issue #426). */
export const EncounterEventPhase = z.enum(['declare', 'roll', 'ruling', 'consequence', 'resource', 'undo']);
export type EncounterEventPhase = z.infer<typeof EncounterEventPhase>;

/** Who performed the action that produced a combat-log chain (issue #426). */
export const EncounterEventPerformedBy = z.object({
  userId: z.string().max(120).nullable().default(null),
  role: z.string().max(24).nullable().default(null),
  kind: z.enum(['human', 'ai', 'system']).default('human'),
});
export type EncounterEventPerformedBy = z.infer<typeof EncounterEventPerformedBy>;

/** Structured payload for expandable combat-log details (issue #426). */
export const EncounterEventMetadata = z.object({
  actionName: z.string().max(120).optional(),
  mode: z.string().max(24).optional(),
  outcome: z.string().max(24).optional(),
  playerText: z.string().max(600).optional(),
  dmText: z.string().max(600).optional(),
  naturalRoll: z.number().int().nullable().optional(),
  attackTotal: z.number().int().nullable().optional(),
  saveTotal: z.number().int().nullable().optional(),
  vsValue: z.number().int().nullable().optional(),
  saveDc: z.number().int().nullable().optional(),
  degree: z.string().max(24).optional(),
  damageSummary: z.string().max(200).optional(),
  costSlot: z.string().max(40).optional(),
  costCount: z.number().int().optional(),
  spellLevelSpent: z.number().int().optional(),
  undoOfChainId: z.string().max(64).optional(),
  ruleSystem: z.string().max(40).optional(),
  escalationDie: z.number().int().min(0).max(6).optional(),
  escalationApplied: z.boolean().optional(),
  escalationPrevented: z.boolean().optional(),
  // Issue #580: the client-minted operation id behind this event, when the write that
  // produced it carried one. Makes the combat log auditable for the exact question the
  // idempotency layer answers — "did this damage land once, or did a retry double it?" —
  // by letting an operator group log lines by intent rather than by wall-clock proximity.
  operationId: z.string().max(128).optional(),
});
export type EncounterEventMetadata = z.infer<typeof EncounterEventMetadata>;

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
  // Issue #426: correlate declaration, rolls, rulings, consequences, resources,
  // and undo in one event chain without rewriting history.
  chainId: z.string().max(64).nullable().default(null),
  parentEventId: Id.nullable().default(null),
  phase: EncounterEventPhase.nullable().default(null),
  performedBy: EncounterEventPerformedBy.nullable().default(null),
  metadata: EncounterEventMetadata.default({}),
  createdAt: IsoDate,
});
export type EncounterEvent = z.infer<typeof EncounterEvent>;

// ---------- current-turn workspace read model (issue #413) ----------
// The turn workspace answers "what can I do now?" for the active combatant: the
// adapter-defined action-economy slots (with usage + plain-language help), movement /
// resources / reaction / concentration / active effects, suggested actions, and the
// start/end-of-turn prompts the player and DM should resolve before advancing. It is a
// READ MODEL derived server-side from the encounter + combatant + campaign-adapter state;
// GET /encounters/:id/turn returns it, and it re-derives on every read (no stored blob).

/** One action-economy slot as presented in the workspace: the adapter's slot + live usage. */
export const TurnActionSlot = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string(),
  kind: z.enum(['action', 'movement', 'reaction', 'resource']),
  max: z.number().int().nonnegative(),
  used: z.number().nonnegative(),
  resetsAt: z.enum(['turn', 'round']),
});
export type TurnActionSlot = z.infer<typeof TurnActionSlot>;

/** A suggested action pulled from the active combatant's sheet / statblock (issue #413). */
export const TurnSuggestedAction = z.object({
  name: z.string().min(1).max(160),
  // Where it came from — 'action', 'reaction', 'legendary', 'special', 'spell', or 'feature'.
  // ALWAYS the action-economy/kind hint, never a display label — the web client keys BOTH
  // the Action/Bonus/Reaction/Other tab bucketing and the fallback spell-list detection off
  // this string (see TurnWorkspace.tsx), so overloading it with something else (e.g. an
  // equipping item's name) breaks both for any equipped item whose economy slot isn't
  // explicit in `spec.cost.slot` — or, worse, silently renders a mundane item as a
  // fabricated spell entry the moment its name happens to contain "spell" (issue #1901
  // review: devin-ai-integration on PR #1951).
  source: z.string().max(40),
  /**
   * The equipping item's name (issue #1901), for a row contributed by a character's
   * equipped-item action — `null` for a hand-authored sheet action or a monster/NPC
   * statblock action. Kept SEPARATE from `source` (see above) precisely so the "equipped:
   * <item>" label the web UI renders alongside an action never contaminates `source`'s
   * economy-hint meaning. Capped at 200 to match `InventoryItem.name` (review:
   * chatgpt-codex-connector P2) — a shorter limit here would reject an otherwise-valid
   * item's full name once forwarded into this field, failing this exported response schema.
   */
  equippedItemName: z.string().max(200).nullable().default(null),
  summary: z.string().max(600).default(''),
  toHit: z.string().default(''),
  damage: z.string().default(''),
  // Index into the combatant's usable-actions list (issue #425). Omitted for prose-only rows.
  actionIndex: z.number().int().min(0).optional(),
  // True when the action carries a structured spec the Use flow can resolve.
  resolvable: z.boolean().default(false),
  // Structured spec when resolvable (issue #425) — omitted for prose-only rows.
  spec: ActionSpec.nullable().optional(),
});
export type TurnSuggestedAction = z.infer<typeof TurnSuggestedAction>;

/**
 * A castable spell surfaced in the current-turn workspace (issue #1900) — the in-combat
 * Spellbook's data source. Derived server-side from the SAME action rows as
 * {@link TurnSuggestedAction} (see {@link deriveTurnSpells}), never fabricated: fields with no
 * data model (school, range, casting time) simply do not exist here. `level`/`castingSlot`/
 * `concentration` come straight off the row's `spec.uses`/`spec.cost` — there is no separate
 * spell data model.
 */
export const TurnSpellEntry = z.object({
  name: z.string().min(1).max(160),
  // 0 = cantrip / at-will; 1-9 = the slot level the row's structured spec declares.
  level: z.number().int().min(0).max(9),
  // Adapter action-economy slot this spell's cast consumes ('action', 'bonus', …); '' = unset.
  castingSlot: z.string().max(40).default(''),
  concentration: z.boolean().default(false),
  // Same index space as TurnSuggestedAction.actionIndex — feeds the resolve/apply Use flow.
  actionIndex: z.number().int().min(0).optional(),
  resolvable: z.boolean().default(false),
  spec: ActionSpec.nullable().optional(),
});
export type TurnSpellEntry = z.infer<typeof TurnSpellEntry>;

/**
 * Pure derivation (issue #1900): pick the spell-qualifying rows out of the same
 * `TurnSuggestedAction[]` the workspace already built for `suggestedActions`, and reshape them
 * into {@link TurnSpellEntry}. A row qualifies when its structured spec spends a spell slot
 * (`spec.uses.spellLevel >= 1`), or its source/kind reads as a spell or cantrip at level 0 (a
 * cantrip has no slot to spend, so `spellLevel` alone can't distinguish it from a non-spell
 * action). No school/range/casting-time invention — those fields have no data model and are
 * simply absent from the result, unlike the deleted client-side fallback this replaces.
 */
export function deriveTurnSpells(actions: readonly TurnSuggestedAction[]): TurnSpellEntry[] {
  const out: TurnSpellEntry[] = [];
  for (const a of actions) {
    const level = a.spec?.uses?.spellLevel ?? 0;
    const kind = a.source.trim().toLowerCase();
    const isSpellKind = kind === 'spell' || kind === 'cantrip';
    if (level < 1 && !isSpellKind) continue;
    out.push({
      name: a.name,
      level,
      castingSlot: a.spec?.cost?.slot ?? '',
      concentration: a.spec?.uses?.concentration ?? false,
      actionIndex: a.actionIndex,
      resolvable: a.resolvable,
      spec: a.spec ?? null,
    });
  }
  return out;
}

/** Quick-roll request body for one-tap attack or damage roll in an encounter (issue #1850). */
export const QuickRollRequest = z.object({
  combatantId: Id.optional(),
  actorName: z.string().max(200).optional(),
  actionName: z.string().min(1).max(160),
  kind: z.enum(['to-hit', 'damage']),
  expr: z.string().min(1).max(100),
  mode: z.enum(['flat', 'advantage', 'disadvantage']).default('flat'),
});
export type QuickRollRequest = z.infer<typeof QuickRollRequest>;


/** What a turn prompt is about, so the client can group/iconify it. */
export const TurnPromptKind = z.enum([
  'death-save',
  'ongoing-damage',
  'regeneration',
  'recharge',
  'repeat-save',
  'expiring-effect',
  'unresolved-action',
  'concentration',
]);
export type TurnPromptKind = z.infer<typeof TurnPromptKind>;

/**
 * A start- or end-of-turn prompt the active combatant / DM should resolve (issue #413):
 * a death save for a dying PC, an ongoing-damage tick, a regeneration heal, a "save ends"
 * repeat save, an expiring effect, or an unresolved action at end of turn. Derived from
 * combatant state; carries the effect id when it maps to an ActiveEffect so a client can act on it.
 */
export const TurnPrompt = z.object({
  id: z.string().min(1).max(80),
  kind: TurnPromptKind,
  timing: z.enum(['start', 'end']),
  combatantId: Id,
  combatantName: z.string(),
  message: z.string().max(300),
  effectId: z.string().max(40).nullable().default(null),
});
export type TurnPrompt = z.infer<typeof TurnPrompt>;

/** The current active combatant's identity + who (if anyone) controls it, for "your turn". */
export const TurnActor = z.object({
  combatantId: Id,
  name: z.string(),
  kind: CombatantKind,
  characterId: Id.nullable().default(null),
  // The user who owns the linked character (null for monsters/NPCs, or an unlinked PC).
  ownerUserId: z.string().nullable().default(null),
  deathState: DeathState.default('none'),
  deathSaveSuccesses: z.number().int().min(0).max(3).default(0),
  deathSaveFailures: z.number().int().min(0).max(3).default(0),
});
export type TurnActor = z.infer<typeof TurnActor>;

export const TurnWorkspace = z.object({
  encounterId: Id,
  status: EncounterStatus,
  round: z.number().int().nonnegative(),
  // The current actor (null when not running / empty roster) and who acts next.
  current: TurnActor.nullable(),
  next: TurnActor.nullable(),
  // True when the requesting user owns the current combatant's character (drives the
  // "your turn" announcement + enabling the player End-turn control).
  isYourTurn: z.boolean(),
  // True when the requesting user is permitted to end the current turn right now
  // (DM always; a player only on their own turn when dmControlsTurns is false).
  canEndTurn: z.boolean(),
  // Campaign turn-control settings echoed for the client (issue #413).
  dmControlsTurns: z.boolean(),
  requireDmTurnConfirmation: z.boolean(),
  // Adapter-defined action-economy slots + live usage for the current combatant.
  actionEconomy: z.array(TurnActionSlot),
  // Movement summary (feet) for the current combatant, when the system tracks it.
  movement: z.object({ maxFt: z.number().nonnegative(), usedFt: z.number().nonnegative() }).nullable(),
  reactionAvailable: z.boolean(),
  concentration: z.string().nullable(),
  activeEffects: z.array(ActiveEffect),
  suggestedActions: z.array(TurnSuggestedAction),
  startPrompts: z.array(TurnPrompt),
  endPrompts: z.array(TurnPrompt),
  // Issue #1900: the current combatant's persisted spell slots (character actors only) —
  // null for a monster/NPC actor, or when the viewer doesn't pass the detail gate above.
  spellSlots: z.record(z.string().regex(/^[1-9]$/), SpellSlotLevel).nullable(),
  // Issue #1900: castable spells derived from the same rows as `suggestedActions` (see
  // {@link deriveTurnSpells}) — empty when the actor is not a character or has none.
  spells: z.array(TurnSpellEntry),
});
export type TurnWorkspace = z.infer<typeof TurnWorkspace>;

/**
 * Body for POST /encounters/:id/end-turn (issue #413). `expectedCurrentCombatantId` opts
 * into double-advance protection: the server only advances when the live current combatant
 * still matches (a stale/duplicate click after someone else advanced is a 409, not a second
 * skipped turn). When the campaign requires DM confirmation, a player's end-turn is staged
 * (409) and the DM advances it directly (a DM end-turn / next-turn IS the confirmation).
 */
export const EncounterEndTurn = z.object({
  expectedCurrentCombatantId: Id.nullable().optional(),
  // Issue #580: client-minted operation id for this ONE logical "end turn" intent.
  // Minted where the user's action originates (not inside the fetch wrapper), so a
  // TanStack auto-retry of a lost response carries the SAME key and the server replays
  // the original response instead of advancing the turn a second time.
  idempotencyKey: IdempotencyKey,
});
export type EncounterEndTurn = z.infer<typeof EncounterEndTurn>;

/**
 * Body for POST /encounters/:id/next-turn (issue #580). Previously a bodyless POST, which
 * made the DM's highest-frequency combat control both non-idempotent AND un-serialized:
 * a lost response retried once advanced twice, and two DM devices each advanced once.
 *
 * `idempotencyKey` dedupes the RETRY of one intent (replaying the original response), and
 * `expectedCurrentCombatantId` compare-and-swaps against the live turn pointer so two
 * DISTINCT intents racing across devices produce one advance plus a 409 — a retry and a
 * race are different failures and need different mechanisms. Both stay optional so the
 * classic bodyless call (and MCP) keeps working, unprotected.
 */
export const EncounterNextTurn = z.object({
  expectedCurrentCombatantId: Id.nullable().optional(),
  idempotencyKey: IdempotencyKey,
});
export type EncounterNextTurn = z.infer<typeof EncounterNextTurn>;

/**
 * Body for POST /encounters/:id/combatants/:cid/turn-state (issue #413) — declare/resolve
 * action economy and effects on a combatant. All fields optional and independent:
 *  - useSlot / releaseSlot: increment / decrement usage of an action-economy slot by 1;
 *  - setSlotUsed: set a slot's usage to an absolute count (movement uses moveFt instead);
 *  - moveFt: add feet to movementUsedFt (negative to correct); resetMovement clears it;
 *  - concentration: set/clear what the combatant is concentrating on;
 *  - resolveConcentrationCheck: pass/fail the first durable pending check by id;
 *  - addEffect / removeEffectId: add or drop a structured ActiveEffect;
 *  - delaying / readied: the delay/ready turn-order tools;
 *  - resetTurn: clear the per-turn slice (the whole `used` map + movement; concentration is kept).
 * DM may edit any combatant; a player only their own linked character's combatant.
 */
export const CombatantTurnStatePatch = z.object({
  useSlot: z.string().max(40).optional(),
  releaseSlot: z.string().max(40).optional(),
  setSlotUsed: z.object({ key: z.string().max(40), used: z.number().int().nonnegative() }).optional(),
  moveFt: z.number().optional(),
  resetMovement: z.boolean().optional(),
  concentration: z.string().max(160).nullable().optional(),
  resolveConcentrationCheck: z
    .object({
      id: z.string().min(1).max(120),
      outcome: z.enum(['pass', 'fail']),
    })
    .optional(),
  addEffect: ActiveEffect.optional(),
  removeEffectId: z.string().max(40).optional(),
  delaying: z.boolean().optional(),
  readied: z.string().max(200).nullable().optional(),
  resetTurn: z.boolean().optional(),
});
export type CombatantTurnStatePatch = z.infer<typeof CombatantTurnStatePatch>;

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
  /** Stable compendium provenance.  Numeric ruleEntryId is only a local cache. */
  ruleEntryId: Id.nullable().default(null),
  compendiumRef: CompendiumRef.nullable().default(null),
  compendiumSnapshot: CompendiumSnapshot.nullable().default(null),
  compendiumState: z.enum(['linked', 'linked_updated', 'overridden', 'detached']).nullable().default(null),
  // ---- equip state (issue #1326) ----
  // Only meaningful for ownerType='character' — a party-stash item cannot be worn/wielded.
  // The server enforces that constraint (and slot-conflict rejection); this shape just
  // carries the state. Not settable at creation — an item is always created unequipped
  // and moves to equipped only via an explicit PATCH, keeping the transition validation
  // (owner, slot required, slot conflict) in one place.
  equipped: z.boolean().default(false),
  /**
   * Free-form slot identifier ('main-hand', 'armor', a homebrew label, …), required
   * when equipped=true and cleared automatically on unequip. Deliberately NOT
   * restricted to a fixed enum: what slots exist is ruleset-dependent, so the server
   * only enforces "at most one equipped item per (character, slot string) pair" — a
   * rule that holds for every rule system without guessing its slot model. A
   * ruleset-aware suggested-slot vocabulary for the UI is deferred to the follow-up
   * that actually builds the equip affordance (issue #1326).
   */
  equipSlot: z.string().max(60).nullable().default(null),
  /**
   * Optional structured action this item grants while equipped (issue #1326) — the same
   * shape as a hand-authored `Character.actions` row, so the resolver can merge it in
   * without a second action representation. Authored directly (by a player or DM) or,
   * in future, hydrated from compendium data; that derivation is out of scope here (the
   * source item's `dataJson` is too thin to auto-generate an attack — see issue #1326).
   * Inert while unequipped.
   */
  equippedAction: CharacterAction.nullable().default(null),
  ...timestamps,
  // Soft-delete tombstone (issue #551). NULL on live items; ISO timestamp + actor
  // id when the item is in the campaign trash. Not user-writable via create/update.
  deletedAt: IsoDate.nullable().default(null),
  deletedBy: z.string().max(120).nullable().default(null),
});
export type InventoryItem = z.infer<typeof InventoryItem>;
export const InventoryItemCreate = InventoryItem.omit({
  id: true,
  campaignId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  deletedBy: true,
  ruleEntryId: true,
  compendiumRef: true,
  compendiumSnapshot: true,
  compendiumState: true,
  equipped: true,
  equipSlot: true,
  equippedAction: true,
}).partial().required({ name: true });

/** Acquire a play-safe snapshot of an installed compendium item. */
export const InventoryFromCompendium = z.object({
  ruleEntryId: Id,
  ownerType: ItemOwnerType.default('party'),
  characterId: Id.nullable().optional(),
  qty: z.number().int().min(1).max(999_999).default(1),
  notes: z.string().max(5_000).default(''),
  duplicateMode: z.enum(['confirm', 'increment', 'separate']).default('confirm'),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type InventoryFromCompendium = z.infer<typeof InventoryFromCompendium>;
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
  // Issue #1326: equip/unequip is a PATCH, not a create-time field (see InventoryItem
  // comment above) — the server validates ownerType='character', requires a non-empty
  // equipSlot when equipping, clears it on unequip, and rejects a slot already occupied
  // by another equipped item on the same character (409 INVENTORY_SLOT_CONFLICT).
  equipped: z.boolean().optional(),
  equipSlot: z.string().max(60).nullable().optional(),
  equippedAction: CharacterAction.nullable().optional(),
  /**
   * Issue #1901 rework: when equipping (equipped:true) into a slot another of this
   * character's items already occupies, the server normally rejects with 409
   * INVENTORY_SLOT_CONFLICT so the caller can choose what to do. Setting this true
   * instead makes the whole swap ATOMIC — the incumbent is unequipped in the SAME
   * transaction as this equip, rather than the caller issuing an unequip PATCH followed
   * by a separate equip PATCH (a sequence with a real window: another writer can claim
   * the slot between the two requests, or the second request can simply fail, leaving
   * the character wearing neither item). Ignored when there is no conflict, or when
   * this write isn't an equip transition at all.
   */
  displaceEquipped: z.boolean().optional(),
  /**
   * Issue #1901 review (chatgpt-codex-connector P2): an optional CAS-style guard for
   * `displaceEquipped` — the id of the incumbent item the caller is confirming displacement
   * of (from an earlier 409 INVENTORY_SLOT_CONFLICT body). If another writer has since
   * changed who occupies the target slot, the server rejects with a FRESH 409 naming the new
   * incumbent instead of silently displacing whichever item happens to be there when this
   * request lands.
   */
  expectedConflictingItemId: Id.optional(),
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

// Open Legend (and future exploding-pool adapters) action-roll request. The client sends
// ONLY the native attribute score; the server resolves the campaign adapter, maps score -> pool,
// rolls with crypto RNG, and persists one shared dice-log event.
export const ActionRollRequest = z.object({
  score: z.number().int().min(0).max(99).describe('Native attribute score to roll. Score 0 is disadvantage.'),
  attribute: z.string().trim().min(1).max(80).optional().describe('Optional attribute name for the roll label.'),
  label: z.string().max(120).optional(),
  dc: z.number().int().min(1).max(99).optional(),
});
export type ActionRollRequest = z.infer<typeof ActionRollRequest>;

/** Honest provenance for a dice-log entry (issue #673). */
export const DiceRollSource = z.enum(['rolled', 'manual']);
export type DiceRollSource = z.infer<typeof DiceRollSource>;

/** Sentinel `expr` stored for a paper-table / physical roll — not a dice expression. */
export const PHYSICAL_ROLL_EXPR = 'physical';

/** DM input for logging a roll that happened off-screen (issue #673). */
export const ManualRollRequest = z.object({
  total: z.number().int().min(-999).max(9999).describe('Final result the player reported'),
  label: z.string().max(120).optional().describe('Optional check label, e.g. "DEX save"'),
  actor: z.string().max(120).optional().describe('Who rolled at the table (character/NPC name); defaults to the logger'),
  natural20: z.number().int().min(1).max(20).optional().describe('Optional natural d20 face before modifiers — recorded, not re-rolled'),
  dc: z.number().int().min(1).max(99).optional().describe('Optional difficulty class; success is computed server-side (total >= dc)'),
});
export type ManualRollRequest = z.infer<typeof ManualRollRequest>;
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
  // Exploding/action-pool metadata (issue #541): side count and flags survive the dice-log
  // round-trip so REST/MCP/web/AI all show the same pool and explosion chain.
  sides: z.number().int().positive().optional(),
  exploded: z.boolean().optional(),
  discarded: z.boolean().optional(),
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
  // Issue #673: manual/physical rolls carry honest provenance — no fabricated dice math.
  source: DiceRollSource.optional(),
  /** Who rolled at the table when `source` is `manual` (character/NPC name). */
  actor: z.string().max(120).optional(),
  /** Optional natural d20 face the DM recorded — informational only, not re-rolled. */
  natural20: z.number().int().min(1).max(20).optional(),
  /**
   * Issue #1904 review finding: the encounter/NPC this roll's identity is tied to, when
   * applicable (currently: per-combatant and bulk initiative rolls). A write-time-only
   * secrecy check cannot react to the encounter or NPC becoming hidden LATER — the label was
   * safe to persist when written but the entity it names may not stay visible. Carrying these
   * ids lets the read path (`RollsService.listForCampaign`) re-check CURRENT visibility and
   * redact accordingly, instead of baking a permanent, unredactable name into the shared log.
   * Absent for the vast majority of rolls (checks, quick-rolls, saves, …), which have no such
   * identity tie and are unaffected.
   */
  encounterId: z.number().int().positive().optional(),
  npcId: z.number().int().positive().optional(),
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
  'encounter.turn_changed',
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
  'party.rest.updated',
  // Issue #415: a DM asked one or more players to roll a check/save (check.requested), and a
  // targeted player answered it (check.resolved). Both are THIN id-only signals like the
  // encounter.* ticks — the payload (DC, consequence text, breakdown) is read back over the
  // permission-checked REST endpoints, never carried on the wire.
  'check.requested',
  'check.resolved',
  // Issue #1899: shared dice roll feed tick. Thin id-only variant so connected clients can
  // refetch the roll log and trigger spectator animations without carrying faces on wire.
  'dice.rolled',
  // Issue #867: campaign moved to Trash. SSE controllers tear down EVERY open
  // stream on the campaign (control signal — filtered from the data path like
  // membership.revoked). A reconnect hits requireMember and 404s.
  'campaign.trashed',
  // Issue #599: a table safety hold (X-Card) was raised or released. Carries `active`
  // and NOTHING else — not who, not why. Every client refetches GET /campaigns/:id/safety
  // for the rest, exactly like the other thin ticks, and that endpoint is what enforces
  // the anonymity rules. Putting the actor on the wire would hand every connected browser
  // the one field the whole feature exists to withhold.
  'safety.hold',
  'turn.start',
  'narration.delta',
  'narration.message',
  'narration.withheld',
  'tool',
  'turn.cancelled',
  'turn.error',
  'turn.end',
  'stuck',
  'recovered',
  'state',
  'phase',
  'vote',
  'takeover',
  'secret-approval',
  'tool-confirmation',
  'transcript',
  'session.reset',
  'transcript.reset',
  'grounding',
  'player-display-scene',
]);
export type CampaignEventType = z.infer<typeof CampaignEventType>;
export const CampaignEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dice.rolled'),
    campaignId: Id,
    rollId: Id,
    encounterId: Id.optional(),
    at: IsoDate,
  }),
  z.object({ type: z.literal('party.rest.updated'), campaignId: Id, batchId: Id, characterIds: z.array(Id), at: IsoDate }),
  z.object({
    type: z.literal('encounter.updated'),
    campaignId: Id,
    encounterId: Id,
    // Issue #1902 rework (round 19, codex P2): most `encounter.updated` frames are pure
    // combat-log/turn activity (a roll, a token move) with NO character-sheet write behind
    // them — every connected client refetching the WHOLE campaign character list on each
    // one is wasted work during a busy fight. Set `true` only by the specific writers that
    // ACTUALLY mirror onto a linked character sheet in the same commit (the apply-action
    // HP/condition/spell-slot mirror, `adjustCombatantResource`), so the client can
    // invalidate `campaignCharacters` precisely instead of on every encounter update.
    sheetMirrored: z.boolean().optional(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('encounter.turn_changed'),
    campaignId: Id,
    encounterId: Id,
    round: z.number().int().min(0).optional(),
    turnIndex: z.number().int().min(0).optional(),
    currentCombatantId: Id.nullable().optional(),
    combatantKind: CombatantKind.nullable().optional(),
    // An undo restores a historical turn for client reconciliation, but must
    // not be interpreted as a fresh NPC turn by proactive automation.
    turnReverted: z.literal(true).optional(),
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
    type: z.literal('player-display-scene'),
    campaignId: Id,
    scene: z.string(),
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
  z.object({
    // Issue #415: a DM requested a check/save from a character. Thin invalidation only —
    // `requestId` identifies the persisted request, `characterId` the target sheet, `userId`
    // the requesting DM (String(users.id)). The targeted player's client refetches the pending
    // request over GET /campaigns/:id/check-requests (permission-checked) to render the prompt;
    // the DC + consequence text never ride the wire.
    type: z.literal('check.requested'),
    campaignId: Id,
    requestId: Id,
    characterId: Id,
    userId: z.string().max(120),
    at: IsoDate,
  }),
  z.object({
    // Issue #415: a targeted player answered a check request (rolled once). Thin signal so the
    // DM's client can drop the pending row / refetch; the roll itself is already in the shared
    // dice feed. `userId` is the roller (String(users.id)).
    type: z.literal('check.resolved'),
    campaignId: Id,
    requestId: Id,
    characterId: Id,
    userId: z.string().max(120),
    at: IsoDate,
  }),
  z.object({
    // Issue #867: the campaign was soft-deleted (moved to Trash). Control signal only —
    // SSE controllers complete every open stream; filtered from the data path.
    type: z.literal('campaign.trashed'),
    campaignId: Id,
    at: IsoDate,
  }),
  z.object({
    // Issue #599: safety hold raised (`active: true`) or released (`active: false`).
    // Deliberately actor-free — see the note on 'safety.hold' in CampaignEventType.
    type: z.literal('safety.hold'),
    campaignId: Id,
    active: z.boolean(),
    at: IsoDate,
  }),
  z.object({ type: z.literal('turn.start'), campaignId: Id, at: IsoDate }),
  z.object({ type: z.literal('narration.delta'), campaignId: Id, text: z.string(), at: IsoDate }),
  z.object({ type: z.literal('narration.message'), campaignId: Id, text: z.string(), at: IsoDate }),
  z.object({
    type: z.literal('narration.withheld'),
    campaignId: Id,
    reason: z.enum(['content_filter', 'refusal']),
    message: z.string(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('tool'),
    campaignId: Id,
    name: z.string(),
    isError: z.boolean(),
    proposed: z.boolean(),
    pendingConfirmation: z.boolean().optional(),
    encounterId: Id.optional(),
    encounterHidden: z.boolean().optional(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('turn.cancelled'),
    campaignId: Id,
    narration: z.string(),
    stopReason: z.string(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('turn.error'),
    campaignId: Id,
    stopReason: z.literal('provider_error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    steps: z.number().int(),
    tokensUsed: z.number().int(),
    tokensUsageUnknown: z.boolean().optional(),
    budgetRemaining: z.number().int(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('turn.end'),
    campaignId: Id,
    stopReason: z.string(),
    steps: z.number().int(),
    tokensUsed: z.number().int(),
    tokensUsageUnknown: z.boolean().optional(),
    budgetRemaining: z.number().int(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('stuck'),
    campaignId: Id,
    reason: z.string(),
    detail: z.string(),
    state: z.string(),
    levers: z.array(z.string()),
    at: IsoDate,
  }),
  z.object({ type: z.literal('recovered'), campaignId: Id, state: z.string(), at: IsoDate }),
  z.object({ type: z.literal('state'), campaignId: Id, state: z.string(), at: IsoDate }),
  z.object({ type: z.literal('phase'), campaignId: Id, phase: z.string(), at: IsoDate }),
  z.object({
    type: z.literal('vote'),
    campaignId: Id,
    action: z.string(),
    kind: z.string(),
    outcome: z.string().optional(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('takeover'),
    campaignId: Id,
    action: z.string(),
    memberId: z.string(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('secret-approval'),
    campaignId: Id,
    action: z.enum(['granted', 'revoked']),
    tool: z.string(),
    entityId: Id,
    at: IsoDate,
  }),
  z.object({
    type: z.literal('tool-confirmation'),
    campaignId: Id,
    action: z.enum(['queued', 'approved', 'rejected']),
    confirmationId: z.string(),
    tool: z.string(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('transcript'),
    campaignId: Id,
    event: AiDmTranscriptEvent,
    visibility: AiDmTranscriptVisibility.optional(),
    at: IsoDate,
  }),
  z.object({
    type: z.literal('session.reset'),
    campaignId: Id,
    voteExpired: z.boolean(),
    approvalsRevoked: z.number().int(),
    confirmationsDiscarded: z.number().int(),
    at: IsoDate,
  }),
  z.object({ type: z.literal('transcript.reset'), campaignId: Id, at: IsoDate }),
  z.object({
    type: z.literal('grounding'),
    campaignId: Id,
    status: z.enum(['clean', 'unverified']),
    supportedCount: z.number().int(),
    unsupportedCount: z.number().int(),
    provider: z.string(),
    model: z.string(),
    claimIds: z.array(Id),
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
export type DistributiveOmit<T, K extends PropertyKey> = [T] extends [never] ? never : T extends unknown ? Omit<T, K> : never;
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

// ---------- catalog check roll (issue #415) ----------
// A request to roll a catalog check for a character. The server resolves the authoritative
// modifier + expression from the adapter's roll catalog (clients never send the math), rolls,
// records the roll to the shared dice log, and returns the transparent breakdown + outcome.
export const CheckRollRequest = z.object({
  checkId: z.string().min(1).max(60).describe('Stable catalog id from GET .../checks, e.g. "skill:Athletics", "save:DEX", "initiative"'),
  mode: z.enum(['normal', 'advantage', 'disadvantage', 'crit']).default('normal').describe('Roll mode; advantage/disadvantage apply only where the system supports them'),
  dc: z.number().int().min(1).max(99).optional().describe('Optional difficulty class; success is computed server-side (total >= dc)'),
  consequence: z.string().max(500).optional().describe('Optional DM-authored consequence text recorded with the roll label'),
});
export type CheckRollRequest = z.infer<typeof CheckRollRequest>;

/** The resolved check + persisted roll returned by the check-roll endpoint / MCP tool (issue #415). */
export const CheckRollResponse = z.object({
  check: z.object({
    id: z.string(),
    label: z.string(),
    category: z.string(),
    ability: z.string().nullable(),
    proficiency: z.string().nullable(),
    modifier: z.number().int(),
    breakdown: z.array(z.object({ label: z.string(), value: z.number().int() })),
    breakdownText: z.string(),
    incomplete: z.boolean().optional(),
  }),
  mode: z.enum(['normal', 'advantage', 'disadvantage', 'crit']),
  roll: DiceRoll,
  // PF2e degree of success (only present when the system reports degrees AND a dc was given).
  degree: z.enum(['criticalFailure', 'failure', 'success', 'criticalSuccess']).optional(),
});
export type CheckRollResponse = z.infer<typeof CheckRollResponse>;

// ---------- DM-initiated check requests (issue #415) ----------
// The interactive "DM asks selected players to roll a check/save with a DC + consequence"
// loop. A DM POSTs one request naming a checkId and one or more target characters; the server
// fans it out to one persisted row per character. Each targeted player reads their pending
// request(s) over a permission-checked REST read (the thin `check.requested` SSE tick only
// tells them to refetch), rolls ONCE via the existing catalog-roll path, and sees the DM's
// consequence text alongside the outcome. The request is then marked resolved.
export const CheckRequestMode = z.enum(['normal', 'advantage', 'disadvantage', 'crit']);
export type CheckRequestMode = z.infer<typeof CheckRequestMode>;
export const CheckRequestStatus = z.enum(['pending', 'resolved']);
export type CheckRequestStatus = z.infer<typeof CheckRequestStatus>;

/**
 * The single source of truth for how many characters one group check-request send may target.
 * Used both by `CheckRequestCreate.characterIds`'s `.max()` below (server-enforced) and by the
 * web composer's "whole party" preset / manual-selection guard (`apps/web/src/features/
 * encounters/checkRequestComposer.ts`) — importing this constant keeps the UI's cap from ever
 * drifting out of sync with what the server actually accepts (issue #1943 review).
 */
export const CHECK_REQUEST_MAX_TARGETS = 20;

/** DM input: request `checkId` from one or more target characters, with an optional DC + consequence. */
export const CheckRequestCreate = z.object({
  characterIds: z.array(Id).min(1).max(CHECK_REQUEST_MAX_TARGETS).describe('Target character ids — one persisted request is created per character'),
  checkId: z.string().min(1).max(60).describe('Stable catalog id (e.g. "save:DEX", "skill:Perception") — must exist in each target\'s catalog'),
  mode: CheckRequestMode.default('normal').describe('Suggested roll mode; advantage/disadvantage apply only where the system supports them'),
  dc: z.number().int().min(1).max(99).optional().describe('Optional difficulty class; success is computed server-side when the player rolls'),
  consequence: z.string().max(500).optional().describe('Optional DM-authored consequence text surfaced to the player with the prompt/result'),
  encounterId: Id.optional().describe('Optional encounter this request is tied to (context only)'),
});
export type CheckRequestCreate = z.infer<typeof CheckRequestCreate>;

/** A persisted, permission-checked check request as read by the DM / targeted player. */
export const CheckRequest = z.object({
  id: Id,
  campaignId: Id,
  characterId: Id,
  characterName: z.string(),
  encounterId: Id.nullable(),
  checkId: z.string(),
  checkLabel: z.string(),
  mode: CheckRequestMode,
  dc: z.number().int().nullable(),
  consequence: z.string().nullable(),
  status: CheckRequestStatus,
  requestedByUserId: z.string(),
  requestedByName: z.string(),
  // The persisted dice-log roll id once resolved (null while pending).
  rollId: Id.nullable(),
  createdAt: IsoDate,
  resolvedAt: IsoDate.nullable(),
  // Issue #1943: server-minted once per `requestChecks` call and stamped on every row it
  // creates, so a group send targeting N characters shares one id across its N rows. Null for
  // rows persisted before this field existed (back-compat) — never backfilled, since there is
  // no way to reconstruct which pre-existing rows were originally one submit.
  groupId: z.string().nullable(),
});
export type CheckRequest = z.infer<typeof CheckRequest>;

/** The resolved request plus the roll result returned when a player answers a check request. */
export const CheckRequestResolution = z.object({
  request: CheckRequest,
  result: CheckRollResponse,
});
export type CheckRequestResolution = z.infer<typeof CheckRequestResolution>;

// ---------- audit ----------
// Type aliases for enum/value exports (TS declaration merging: value + type share the name)
export type DangerLevel = z.infer<typeof DangerLevel>;
export type CampaignCloneMode = z.infer<typeof CampaignCloneMode>;
export type CampaignClone = z.infer<typeof CampaignClone>;
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
  requestId: z.string().max(128).nullable().optional(),
  createdAt: IsoDate,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** Default page size for cursor-paginated campaign audit lists (issue #443). */
export const AUDIT_LIST_DEFAULT_LIMIT = 50;
/** Hard cap for `?limit=` on campaign audit lists — clients page with `cursor`, not a huge page. */
export const AUDIT_LIST_MAX_LIMIT = 200;

/**
 * Paginated campaign audit list response (issue #443).
 *
 * Returned when the client requests the envelope (`envelope=1`) or passes filter/cursor
 * params. Bare GET (no query) and legacy `?limit`/`?offset` paging still return a bare
 * `AuditEntry[]` for backward compatibility.
 */
export const AuditListPage = z.object({
  items: z.array(AuditEntry),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().max(512).nullable(),
  limit: z.number().int().positive(),
});
export type AuditListPage = z.infer<typeof AuditListPage>;

export const AuditRetentionPolicy = z.object({
  days: z.number().int(),
  defaultDays: z.number().int().positive(),
  autoPruneEnabled: z.boolean(),
  requireArchiveBeforePrune: z.boolean(),
  requireRecentBackupHours: z.number().int().nonnegative(),
  source: z.object({
    days: z.enum(['default', 'env', 'settings']),
    autoPruneEnabled: z.enum(['default', 'env', 'settings']),
  }),
  archiveDir: z.string().max(1000),
});
export type AuditRetentionPolicy = z.infer<typeof AuditRetentionPolicy>;

export const AuditRetentionPolicyUpdate = z.object({
  days: z.number().int().optional(),
  autoPruneEnabled: z.boolean().optional(),
  requireArchiveBeforePrune: z.boolean().optional(),
  requireRecentBackupHours: z.number().int().nonnegative().optional(),
});
export type AuditRetentionPolicyUpdate = z.infer<typeof AuditRetentionPolicyUpdate>;

export const AuditLegalHold = z.object({
  global: z.boolean().default(false),
  campaignIds: z.array(Id).default([]),
});
export type AuditLegalHold = z.infer<typeof AuditLegalHold>;

export const AuditPrunePreview = z.object({
  cutoffIso: IsoDate,
  retentionDays: z.number().int(),
  eligibleCount: z.number().int().nonnegative(),
  heldCount: z.number().int().nonnegative(),
  oldestEligibleAt: IsoDate.nullable(),
  newestEligibleAt: IsoDate.nullable(),
});
export type AuditPrunePreview = z.infer<typeof AuditPrunePreview>;

export const AuditPruneJobStatus = z.enum(['running', 'succeeded', 'failed']);
export type AuditPruneJobStatus = z.infer<typeof AuditPruneJobStatus>;

export const AuditPruneJob = z.object({
  id: z.string().max(80),
  status: AuditPruneJobStatus,
  mode: z.enum(['dryRun', 'prune']),
  startedAt: IsoDate,
  finishedAt: IsoDate.nullable(),
  cutoffIso: IsoDate,
  retentionDays: z.number().int(),
  eligibleCount: z.number().int().nonnegative(),
  heldCount: z.number().int().nonnegative(),
  archivedPath: z.string().max(1000).nullable(),
  archiveChecksum: z.string().max(128).nullable(),
  deletedCount: z.number().int().nonnegative(),
  error: z.string().max(2000).nullable(),
  backupLastSuccessAt: IsoDate.nullable(),
  actor: z.string().max(200).nullable(),
});
export type AuditPruneJob = z.infer<typeof AuditPruneJob>;

export const AuditRetentionStatus = z.object({
  policy: AuditRetentionPolicy,
  legalHold: AuditLegalHold,
  lastJob: AuditPruneJob.nullable(),
});
export type AuditRetentionStatus = z.infer<typeof AuditRetentionStatus>;

// ---------- moderation / abuse incidents (issue #601) ----------
//
// The finding behind #601: an author could edit or delete a comment with no
// recoverable, integrity-protected copy of what they wrote; DMs had no way to
// quarantine an abusive whisper; and there was no durable report/incident path
// at all. Everything in this block exists to make abuse EVIDENCE survive the
// abuser's own cleanup, and to keep that evidence walled off from ordinary
// campaign content reads.
//
// Deliberate modelling choice — ONE generic (targetType, targetId) pair rather
// than six near-duplicate report shapes. The six reportable surfaces named in
// #601 (comment / whisper / note / notification / AI narration / conduct) differ
// only in how the server RESOLVES the target and who may see it; the report
// record itself is identical. `whisper` is a distinct target type from `note`
// even though both live in the notes table, because a whisper is the one
// surface with a single private recipient — the reporter is usually the victim,
// and the DM queue must be able to quarantine it without touching ordinary notes.

/**
 * What a report is about. Resolution rules per type (server-enforced):
 *  - `comment`       — a comments row; reporter must be able to see the anchor entity.
 *  - `whisper`       — a notes row with visibility 'whisper'; reporter must be author, recipient, or DM.
 *  - `note`          — any other notes row the reporter can see.
 *  - `notification`  — a notifications row DELIVERED TO the reporter (you may only report your own bell).
 *  - `ai_narration`  — AI-generated prose. Campfire does not persist narration turns as
 *                      addressable rows, so this is the one target whose content is
 *                      REPORTER-SUPPLIED (see ModerationEvidence.source). `targetId` is
 *                      optional and, when present, is an opaque client-side turn id.
 *  - `conduct`       — out-of-band behaviour with no single artefact (voice chat, table
 *                      conduct). No targetId; content is reporter-supplied.
 */
export const ModerationTargetType = z.enum(['comment', 'whisper', 'note', 'notification', 'ai_narration', 'conduct']);
export type ModerationTargetType = z.infer<typeof ModerationTargetType>;

/** Target types whose content the SERVER captures itself (never reporter-supplied). */
export const MODERATION_SERVER_CAPTURED_TARGETS: readonly ModerationTargetType[] = [
  'comment',
  'whisper',
  'note',
  'notification',
];

export const ModerationReportReason = z.enum([
  'harassment',
  'hate',
  'sexual_content',
  'threat_or_violence',
  'self_harm',
  'privacy',
  'spam',
  'other',
]);
export type ModerationReportReason = z.infer<typeof ModerationReportReason>;

/**
 * Report lifecycle. `escalated` is terminal for the DM queue but NOT for the
 * incident: an escalated report leaves DM jurisdiction entirely and can only be
 * read through server-admin break-glass. That is the conflicted-DM path — a
 * report whose subject IS a DM of the campaign is auto-escalated at creation and
 * never appears in that campaign's DM queue.
 */
export const ModerationReportStatus = z.enum(['open', 'acknowledged', 'escalated', 'resolved']);
export type ModerationReportStatus = z.infer<typeof ModerationReportStatus>;

/**
 * How a report ended. `rejected` is the FALSE-REPORT outcome: it resolves the
 * report AND lifts any quarantine the report caused, so a good-faith-but-wrong
 * (or malicious) report cannot permanently suppress someone's content.
 */
export const ModerationResolution = z.enum(['upheld', 'rejected', 'no_action']);
export type ModerationResolution = z.infer<typeof ModerationResolution>;

/**
 * DM queue verbs (#601 bullet 4). `unquarantine` / `unmute` are not in the
 * issue's list but are required for `rejected` to mean anything — a quarantine
 * with no lift is a one-way censor button.
 */
export const ModerationActionType = z.enum([
  'acknowledge',
  'quarantine',
  'unquarantine',
  'mute',
  'unmute',
  'remove',
  'escalate',
  'resolve',
]);
export type ModerationActionType = z.infer<typeof ModerationActionType>;

/**
 * Integrity state of a stored evidence snapshot, recomputed on every read.
 *  - `intact`   — sha256 over the canonical payload still matches `contentHash`.
 *  - `redacted` — content was deliberately redacted (retention expiry or an explicit
 *                 redaction request). The ORIGINAL hash is preserved, so the fact that
 *                 the bytes no longer match is expected and recorded, not suspicious.
 *  - `tampered` — hash mismatch with no recorded redaction. Something wrote to the
 *                 evidence row out of band. Fail loud.
 */
export const ModerationEvidenceIntegrity = z.enum(['intact', 'redacted', 'tampered']);
export type ModerationEvidenceIntegrity = z.infer<typeof ModerationEvidenceIntegrity>;

/** Why a snapshot was taken. Drives nothing but review comprehension — keep it honest. */
export const ModerationEvidenceReason = z.enum(['report', 'pre_edit', 'pre_delete', 'pre_quarantine', 'pre_remove']);
export type ModerationEvidenceReason = z.infer<typeof ModerationEvidenceReason>;

/** Where the snapshot's bytes came from — see ModerationTargetType for why this matters. */
export const ModerationEvidenceSource = z.enum(['server_capture', 'reporter_supplied']);
export type ModerationEvidenceSource = z.infer<typeof ModerationEvidenceSource>;

/**
 * An integrity-protected snapshot of reportable content, captured BEFORE the
 * source row is mutated (or at report time, whichever happens first).
 *
 * `contentHash` is a sha256 over a canonical, unambiguous serialization of the
 * evidence fields — the server's `moderationEvidenceHash` defines the exact byte
 * layout. It is NOT a hash of the JSON row (key order would make that
 * meaningless) and NOT keyed/HMAC'd: an operator with DB write access could
 * recompute a keyed MAC just as easily as a plain digest unless the key lives
 * off-box, which a self-hosted single-binary deployment cannot promise. What
 * this DOES buy is exactly what the issue asks for — tamper EVIDENCE: any edit
 * to the stored content, author, timestamps, or context that is not accompanied
 * by a recorded redaction shows up as `tampered` on the next read.
 */
export const ModerationEvidence = z.object({
  id: Id,
  campaignId: Id,
  targetType: ModerationTargetType,
  targetId: Id.nullable().default(null),
  reason: ModerationEvidenceReason,
  source: ModerationEvidenceSource,
  /** Who authored the captured content (the report SUBJECT). '' when unknown (conduct). */
  authorUserId: z.string().max(120).default(''),
  authorName: z.string().max(120).default(''),
  /** For a whisper/notification: the single member it was delivered to. */
  recipientUserId: z.string().max(120).nullable().default(null),
  /** The entity the content hung off, so a reviewer can situate it months later. */
  anchorEntityType: z.string().max(40).nullable().default(null),
  anchorEntityId: Id.nullable().default(null),
  /**
   * The source row's own `updated_at` at capture time — the "revision" #601 asks
   * for. Combined with `capturedAt` it pins the snapshot to one specific version
   * of the content, so two snapshots of the same target are orderable.
   */
  revisionAt: z.string().max(64).default(''),
  /** The captured prose. Replaced with a placeholder once `redactedAt` is set. */
  content: z.string().max(40_000).default(''),
  /** Extra situating context as JSON (visibility, inCharacter, parentId, ...). */
  context: z.record(z.unknown()).default({}),
  contentHash: z.string().max(128),
  integrity: ModerationEvidenceIntegrity,
  redactedAt: IsoDate.nullable().default(null),
  redactedBy: z.string().max(120).nullable().default(null),
  redactionReason: z.string().max(500).default(''),
  /**
   * When the captured CONTENT stops being retained (bullet 6, "suitable for
   * minors"). At/after this instant the content is redacted to a placeholder —
   * the report shell, hashes, and audit trail survive so the incident record
   * stays coherent, but the abusive material itself does not linger forever.
   */
  expiresAt: IsoDate.nullable().default(null),
  capturedAt: IsoDate,
});
export type ModerationEvidence = z.infer<typeof ModerationEvidence>;

/**
 * The durable incident record. Note what is NOT here: the evidence CONTENT. A
 * report row is queue metadata; reading the actual words requires the separate,
 * always-audited evidence endpoint (#601 bullet 3 — "separate sensitive evidence
 * access from ordinary campaign content").
 */
export const ModerationReport = z.object({
  id: Id,
  campaignId: Id,
  targetType: ModerationTargetType,
  targetId: Id.nullable().default(null),
  reporterUserId: z.string().max(120),
  reporterName: z.string().max(120).default(''),
  /** Who the report is ABOUT — denormalized from the evidence so conflicted-DM checks never need a join. */
  subjectUserId: z.string().max(120).default(''),
  subjectName: z.string().max(120).default(''),
  reason: ModerationReportReason,
  details: z.string().max(4000).default(''),
  status: ModerationReportStatus,
  resolution: ModerationResolution.nullable().default(null),
  resolutionNote: z.string().max(2000).default(''),
  /** FK into moderation_evidence. Always set — a report without a snapshot is not durable. */
  evidenceId: Id,
  /** Integrity of the linked snapshot, surfaced on the queue row so a tampered incident is obvious. */
  evidenceIntegrity: ModerationEvidenceIntegrity,
  /** True while the reported content is withheld from normal reads because of THIS report. */
  quarantined: z.boolean().default(false),
  /** Set when the report left DM jurisdiction (conflicted DM, or an explicit escalate). */
  escalatedAt: IsoDate.nullable().default(null),
  escalationReason: z.string().max(500).default(''),
  acknowledgedAt: IsoDate.nullable().default(null),
  resolvedAt: IsoDate.nullable().default(null),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type ModerationReport = z.infer<typeof ModerationReport>;

export const ModerationReportCreate = z
  .object({
    targetType: ModerationTargetType,
    targetId: Id.nullable().optional(),
    reason: ModerationReportReason,
    details: z.string().max(4000).default(''),
    /**
     * ONLY honoured for `ai_narration` / `conduct`, whose content the server has
     * no addressable row for. Supplying it for a server-captured target is a 400,
     * not a silent drop — a reporter must never believe they attached evidence
     * that the server then ignored.
     */
    content: z.string().max(20_000).optional(),
    /**
     * ONLY honoured for `conduct`, where there is no artefact to read the subject
     * off. Must name a current campaign member. Rejected for every server-captured
     * target: there the server knows who wrote the content and a reporter must not
     * get to assert otherwise. Without it a conduct report is still filed, but the
     * `mute` action has nobody to act on and is refused.
     */
    subjectUserId: z.string().max(120).optional(),
  })
  .strict();
export type ModerationReportCreate = z.infer<typeof ModerationReportCreate>;

export const ModerationActionRequest = z
  .object({
    action: ModerationActionType,
    /** Required for `resolve`; ignored otherwise. */
    resolution: ModerationResolution.optional(),
    note: z.string().max(2000).default(''),
    /** For `mute`: how long, in hours. Omit for an indefinite mute. */
    muteHours: z.number().int().positive().max(24 * 365).optional(),
  })
  .strict();
export type ModerationActionRequest = z.infer<typeof ModerationActionRequest>;

/** An active posting mute in a campaign (the `mute` queue action). */
export const ModerationMute = z.object({
  id: Id,
  campaignId: Id,
  userId: z.string().max(120),
  userName: z.string().max(120).default(''),
  reason: z.string().max(500).default(''),
  /** null = indefinite, until a DM lifts it. */
  expiresAt: IsoDate.nullable().default(null),
  createdBy: z.string().max(120).default(''),
  createdAt: IsoDate,
});
export type ModerationMute = z.infer<typeof ModerationMute>;

/** Default page size for the DM moderation queue. */
export const MODERATION_LIST_DEFAULT_LIMIT = 25;
/** Hard cap for `?limit=` on moderation lists — the queue is paged, never bulk-dumped. */
export const MODERATION_LIST_MAX_LIMIT = 100;

export const ModerationReportPage = CursorListPage(ModerationReport);
export type ModerationReportPage = z.infer<typeof ModerationReportPage>;

/**
 * The controlled export bundle (#601 bullet 6). Produced only by an explicit,
 * audited export call — never by the ordinary campaign export, which must not
 * carry abuse evidence out of the moderation boundary.
 */
export const ModerationIncidentExport = z.object({
  report: ModerationReport,
  /** The snapshot taken when the report was filed. */
  evidence: ModerationEvidence,
  /**
   * Every LATER snapshot of the same target, oldest-first: the pre_edit / pre_delete /
   * pre_quarantine / pre_remove captures taken while this incident was open. Without
   * these the mutation hooks would be write-only, and the single most important thing
   * a reviewer needs — "what did they change after they were reported?" — would be
   * unanswerable. Empty when the content was never touched again.
   */
  additionalEvidence: z.array(ModerationEvidence).default([]),
  /** The incident's own audit rows (acknowledge/quarantine/…/resolve), oldest-first. */
  timeline: z.array(AuditEntry),
  exportedAt: IsoDate,
  exportedBy: z.string().max(200),
});
export type ModerationIncidentExport = z.infer<typeof ModerationIncidentExport>;

/**
 * Retention for moderation evidence. Deliberately the SAME shape as
 * AuditRetentionPolicy's persisted half (days / auto-sweep flag) so operators
 * meet one mental model, and it INHERITS the audit policy's `days` when unset
 * rather than inventing a second default nobody will tune.
 *
 * The critical difference from audit pruning: expiry REDACTS rather than
 * deletes. Destroying the report shell would destroy the record that an
 * incident happened at all, which is the opposite of what a safeguarding
 * retention policy wants.
 */
export const ModerationRetentionPolicy = z.object({
  days: z.number().int(),
  defaultDays: z.number().int().positive(),
  autoRedactEnabled: z.boolean(),
  source: z.enum(['default', 'audit', 'settings']),
});
export type ModerationRetentionPolicy = z.infer<typeof ModerationRetentionPolicy>;

export const ModerationRetentionPolicyUpdate = z.object({
  days: z.number().int().optional(),
  autoRedactEnabled: z.boolean().optional(),
});
export type ModerationRetentionPolicyUpdate = z.infer<typeof ModerationRetentionPolicyUpdate>;

/**
 * Issue #597: a DM silencing a member DIRECTLY, without a report to hang it on.
 * #601 could only mute through the queue's `mute` verb, which requires an incident;
 * a table often needs "stop, cool off for an hour" before anyone has filed anything,
 * and forcing a report first either manufactures a permanent accusation record or
 * leaves the DM with removal as their only tool. `hours` omitted = indefinite until
 * lifted; removal remains a separate, harsher act (DELETE the membership).
 */
export const ModerationSilenceCreate = z
  .object({
    userId: z.string().min(1).max(120),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type ModerationSilenceCreate = z.infer<typeof ModerationSilenceCreate>;

// ---------- personal safety controls (issue #597) ----------

/**
 * The three personal (member-owned, not moderator-owned) safety relationships.
 *
 *  - `block`       — the strongest: the blocked member can no longer reach the owner.
 *                    Nothing they send is delivered to the owner, and none of their
 *                    content is shown to the owner. Deliberately account-wide, not
 *                    per-campaign: a block is a statement about a PERSON, and having
 *                    to re-block the same harasser at every shared table is exactly
 *                    the friction that makes people stop using the control.
 *  - `mute_sender` — noise control, not safety: their content stays fully visible,
 *                    they simply stop generating notifications for the owner.
 *  - `mute_thread` — same, scoped to one anchored discussion rather than a person.
 *
 * Distinct from ModerationMute (issue #601), which is a DM/moderator SANCTION that
 * stops the muted member posting at all. These are the recipient's own settings and
 * are never disclosed to their subject.
 */
export const SafetyControlKind = z.enum(['block', 'mute_sender', 'mute_thread']);
export type SafetyControlKind = z.infer<typeof SafetyControlKind>;

export const SafetyControl = z.object({
  id: Id,
  kind: SafetyControlKind,
  /** null for an account-wide control (every `block` is account-wide). */
  campaignId: Id.nullable().default(null),
  ownerUserId: z.string().max(120),
  /** null for `mute_thread`. */
  targetUserId: z.string().max(120).nullable().default(null),
  /** Display label for the target, resolved at read time — never stored. */
  targetName: z.string().default(''),
  /** Set for `mute_thread` only. */
  threadEntityType: EntityType.nullable().default(null),
  threadEntityId: Id.nullable().default(null),
  reason: z.string().max(500).default(''),
  createdAt: IsoDate,
});
export type SafetyControl = z.infer<typeof SafetyControl>;

export const SafetyBlockCreate = z
  .object({
    targetUserId: z.string().min(1).max(120),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type SafetyBlockCreate = z.infer<typeof SafetyBlockCreate>;

/**
 * Either a person mute (`targetUserId`) or a thread mute (`entityType` + `entityId`),
 * never both — the service rejects a body that supplies neither or both.
 */
export const SafetyMuteCreate = z
  .object({
    targetUserId: z.string().min(1).max(120).optional(),
    entityType: EntityType.optional(),
    entityId: Id.optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type SafetyMuteCreate = z.infer<typeof SafetyMuteCreate>;

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
  /** SQLite's allocated logical pages; this is not necessarily the DB file's physical bytes. */
  sizeBytes: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  pageSize: z.number().int().nonnegative(),
  dbFileBytes: z.number().int().nonnegative().nullable(),
  walBytes: z.number().int().nonnegative().nullable(),
  shmBytes: z.number().int().nonnegative().nullable(),
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
  storage: z.object({
    freeBytes: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
    availableBytes: z.number().int().nonnegative().nullable(),
    uploadsBytes: z.number().int().nonnegative().nullable(),
    backupsBytes: z.number().int().nonnegative().nullable(),
    tempBytes: z.number().int().nonnegative().nullable(),
    status: z.enum(['ok', 'degraded', 'failed', 'unknown']),
    quickCheck: z.object({ status: z.enum(['ok', 'degraded', 'failed', 'unknown']), checkedAt: IsoDate.nullable() }),
  }),
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

// ---------- admin bulk roster import (issue #589) ----------
// Server-admin dry-run + commit for seasonal roster setup. CSV/JSON rows map to
// local usernames and/or OIDC subjects, optionally seat users in campaigns.
// New accounts are created passwordless; commit returns expiring activation codes
// ONCE (never logged or exported in audit detail).
export const RosterImportFormat = z.enum(['csv', 'json']);
export type RosterImportFormat = z.infer<typeof RosterImportFormat>;

export const RosterImportField = z.enum([
  'username',
  'displayName',
  'oidcSub',
  'campaignId',
  'campaignRole',
  'characterId',
]);
export type RosterImportField = z.infer<typeof RosterImportField>;

/** Canonical row after parsing + mapping (commit payload). */
export const RosterImportRow = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    username: User.shape.username.optional(),
    displayName: z.string().max(120).optional(),
    oidcSub: z.string().max(200).optional(),
    campaignId: Id.optional(),
    campaignRole: Role.optional(),
    characterId: Id.nullable().optional(),
  })
  .refine((row) => row.username != null || row.oidcSub != null, {
    message: 'Row needs at least one of username or oidcSub',
  });
export type RosterImportRow = z.infer<typeof RosterImportRow>;

export const RosterImportRowAction = z.enum(['create', 'update', 'skip', 'error']);
export type RosterImportRowAction = z.infer<typeof RosterImportRowAction>;

export const RosterImportRowDiagnostic = z.object({
  rowIndex: z.number().int().nonnegative(),
  action: RosterImportRowAction,
  matchedUserId: Id.nullable().optional(),
  matchBy: z.enum(['username', 'oidcSub']).nullable().optional(),
  username: z.string().optional(),
  displayName: z.string().optional(),
  oidcSub: z.string().optional(),
  campaignId: Id.optional(),
  campaignRole: Role.optional(),
  characterId: Id.nullable().optional(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type RosterImportRowDiagnostic = z.infer<typeof RosterImportRowDiagnostic>;

export const RosterImportRequest = z.object({
  dryRun: z.boolean().default(true),
  format: RosterImportFormat,
  content: z.string().max(1_000_000),
  /** CSV only: header name -> canonical field. Unmapped headers are ignored. */
  columnMap: z.record(z.string(), RosterImportField).optional(),
  activationExpiresInDays: z.number().int().min(1).max(30).default(7),
  /** Required on commit — the reviewed normalized rows from the dry-run preview. */
  rows: z.array(RosterImportRow).max(500).optional(),
  /** Fingerprint from dry-run; must match on commit. */
  batchId: z.string().max(128).optional(),
});
export type RosterImportRequest = z.infer<typeof RosterImportRequest>;

export const RosterImportPreview = z.object({
  dryRun: z.literal(true),
  batchId: z.string(),
  totalRows: z.number().int().nonnegative(),
  validRows: z.number().int().nonnegative(),
  errorRows: z.number().int().nonnegative(),
  rows: z.array(RosterImportRowDiagnostic),
  /** Normalized rows eligible for commit (action create|update|skip, no errors). */
  commitRows: z.array(RosterImportRow),
});
export type RosterImportPreview = z.infer<typeof RosterImportPreview>;

export const RosterImportActivation = z.object({
  userId: Id,
  username: z.string(),
  activationCode: z.string(),
  expiresAt: IsoDate,
});
export type RosterImportActivation = z.infer<typeof RosterImportActivation>;

export const RosterImportCommitResult = z.object({
  dryRun: z.literal(false),
  batchId: z.string(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  membershipsAdded: z.number().int().nonnegative(),
  membershipsUpdated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  activations: z.array(RosterImportActivation),
});
export type RosterImportCommitResult = z.infer<typeof RosterImportCommitResult>;

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

// The total/truncated fields (issue #1481) surface silent truncation: `results`
// is already sliced to the request limit, so a campaign with 200 matches is
// indistinguishable from one with exactly `limit` without them. `total` is the
// number of matches the server actually found within the (possibly bounded)
// scan, before slicing; `truncated` is true whenever the returned page does not
// contain every existing match — either because `total > results.length`
// (paging a known set), or because a scan/index cap was hit (the FTS candidate
// LIMIT, a fallback per-collection scan cap, or a fallback bounded projection
// cap) and more matches may exist that were never examined. In that capped case
// `total` is a lower bound, so `truncated` is the authoritative “this list may
// be incomplete” signal regardless of mode; clients must not treat `total` as a
// complete count when `truncated` is true.
export const SearchResponse = z.object({
  query: z.string(),
  results: z.array(SearchResult),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
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

// ---------- server-admin campaign metadata catalog (issue #587) ----------
//
// The premise of #587, and the only thing that makes this surface defensible:
// an operator must be able to FIND and MANAGE a campaign without being able to
// READ it. Everything below is therefore an explicit, enumerated projection of
// operational metadata. It is NOT "the campaigns row minus a few fields" —
// `SELECT campaigns.*` would already ship `ics_token` (a live capability secret
// for the public calendar feed) today, and would silently ship whatever column
// lands next. Adding a field here is a deliberate act with a review attached.
//
// What is deliberately absent, and must stay absent: quests, notes, comments,
// attachments' bytes or filenames, session-zero lines/veils/safety tools, any
// `dmSecret`, `icsToken`, `currentLocationId`, `activeEncounterId`, and the
// campaign's own recap/session prose. See the negative tests in
// test/admin-campaign-catalog-isolation.e2e-spec.ts.

/**
 * Whether a catalog row's human-authored strings are disclosed to the operator.
 *
 * A campaign NAME can itself be sensitive ("Tuesday Trauma Processing Group"),
 * which is why #587 asks for this to be configurable rather than assumed public.
 */
export const CampaignCatalogFieldVisibility = z.enum(['visible', 'redacted']);
export type CampaignCatalogFieldVisibility = z.infer<typeof CampaignCatalogFieldVisibility>;

/**
 * A campaign's OWN opt-out, set by its DM (see PUT /campaigns/:id/catalog-privacy).
 *
 * TIGHTEN-ONLY, on purpose. `inherit` follows the server default; `redacted`
 * overrides it toward privacy. There is deliberately no per-campaign value that
 * forces disclosure when the server default is `redacted`, and — more
 * importantly — a server admin cannot move a campaign back to `inherit`. If an
 * operator could un-redact a table that opted out, the opt-out would be
 * decorative.
 */
export const CampaignCatalogPrivacy = z.enum(['inherit', 'redacted']);
export type CampaignCatalogPrivacy = z.infer<typeof CampaignCatalogPrivacy>;

/**
 * Server-wide default disclosure for catalog strings.
 *
 * `descriptions` defaults to `redacted` and `names` to `visible`: a name is the
 * handle an operator needs in order to talk to a DM about their campaign at all,
 * while a description is free prose that routinely carries pitch, premise, and
 * content warnings — i.e. the thing the issue is worried about. Operators who
 * want either treated differently flip it here, and it is audited when they do.
 */
export const CampaignCatalogPrivacyPolicy = z.object({
  names: CampaignCatalogFieldVisibility,
  descriptions: CampaignCatalogFieldVisibility,
  /** 'default' until an operator stores an override, then 'settings'. */
  source: z.enum(['default', 'settings']),
});
export type CampaignCatalogPrivacyPolicy = z.infer<typeof CampaignCatalogPrivacyPolicy>;

export const CampaignCatalogPrivacyPolicyUpdate = z.object({
  names: CampaignCatalogFieldVisibility.optional(),
  descriptions: CampaignCatalogFieldVisibility.optional(),
});
export type CampaignCatalogPrivacyPolicyUpdate = z.infer<typeof CampaignCatalogPrivacyPolicyUpdate>;

/** The installed rule pack ("module") powering a campaign, as the catalog reports it. */
export const CampaignCatalogModule = z.object({
  /** campaigns.rule_system — the slug the campaign asked for. '' when unset. */
  slug: z.string().max(120).default(''),
  /** Display name of the installed pack, or '' when nothing with this slug is installed. */
  name: z.string().max(200).default(''),
  /** Installed pack version, or '' when unknown/uninstalled. */
  version: z.string().max(60).default(''),
  /**
   * False when `slug` is non-empty but no rule pack with that slug is installed —
   * the campaign is pinned to a module this server cannot serve. This is the
   * fleet-wide condition the `update_module` bulk operation exists to fix.
   */
  installed: z.boolean().default(false),
});
export type CampaignCatalogModule = z.infer<typeof CampaignCatalogModule>;

/** The primary owner / DM of record, identified only well enough to contact them. */
export const CampaignCatalogOwner = z.object({
  userId: Id,
  displayName: z.string().max(200).default(''),
  username: z.string().max(200).default(''),
  /** True when resolved from campaign_members.is_primary_owner rather than "first dm". */
  primaryOwner: z.boolean().default(false),
});
export type CampaignCatalogOwner = z.infer<typeof CampaignCatalogOwner>;

/**
 * ONE catalog row. Every field here is either operational (counts, bytes, dates,
 * policy flags) or an explicitly privacy-gated string. Nothing here is campaign
 * content, and nothing here is derived from campaign content.
 */
export const CampaignCatalogEntry = z.object({
  id: Id,
  /**
   * The campaign name, or a non-identifying placeholder when redacted.
   *
   * The placeholder is derived SOLELY from the id (`Campaign #42`), which the
   * row already discloses — so it reveals exactly zero additional bits. It is
   * deliberately not blank (an operator must still be able to tell two rows
   * apart and act on one) and deliberately not a truncation, initialism, or
   * length hint, all of which leak the very string being withheld.
   */
  name: z.string().max(200),
  nameRedacted: z.boolean().default(false),
  /** '' whenever `descriptionRedacted` is true — a redacted description has no placeholder. */
  description: z.string().max(10_000).default(''),
  descriptionRedacted: z.boolean().default(false),
  /** The campaign's own opt-out, so an operator can see WHY a row is redacted. */
  catalogPrivacy: CampaignCatalogPrivacy,
  status: z.enum(['active', 'paused', 'completed']),
  /** paused/completed — the campaign is read-only for its members. */
  archived: z.boolean().default(false),
  /** Soft-deleted (issue #116). Excluded from the catalog unless explicitly requested. */
  trashed: z.boolean().default(false),
  module: CampaignCatalogModule,
  primaryDm: CampaignCatalogOwner.nullable().default(null),
  memberCount: z.number().int().nonnegative().default(0),
  dmCount: z.number().int().nonnegative().default(0),
  /** Logged sessions (campaigns.session_count) — a play-volume signal, not session content. */
  sessionCount: z.number().int().nonnegative().default(0),
  /** Earliest still-scheduled future session, or null. Timestamp only — no title, no notes. */
  nextSessionAt: IsoDate.nullable().default(null),
  /** max(campaigns.updated_at, newest audit row for the campaign). Never an entity body. */
  lastActivityAt: IsoDate.nullable().default(null),
  /**
   * Sum of COMMITTED attachment sizes — stored content, excluding bytes merely reserved
   * by in-flight uploads. Bytes only, never a filename or a mime type. Deliberately a
   * narrower measure than the one `overQuota` uses; see below.
   */
  storageBytes: z.number().int().nonnegative().default(0),
  /** Committed attachment rows, on the same committed-only basis as `storageBytes`. */
  attachmentCount: z.number().int().nonnegative().default(0),
  storageQuotaBytes: z.number().int().nonnegative().nullable().default(null),
  /**
   * True when a quota is set and committed + RESERVED bytes exceed it — the same sum
   * upload enforcement compares against, so this flag agrees with whether the server is
   * currently refusing uploads for the campaign. It can therefore be true while
   * `storageBytes` alone is under the cap, for a campaign held over by in-flight uploads.
   */
  overQuota: z.boolean().default(false),
  publicInvitesEnabled: z.boolean().default(true),
  aiExternalContentPolicy: AiExternalContentPolicy,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type CampaignCatalogEntry = z.infer<typeof CampaignCatalogEntry>;

/** Default page size for the admin catalog. */
export const CAMPAIGN_CATALOG_DEFAULT_LIMIT = 25;
/** Hard cap for `?limit=` — the catalog is paged in SQL, never bulk-dumped. */
export const CAMPAIGN_CATALOG_MAX_LIMIT = 100;

export const CampaignCatalogSort = z.enum(['name', 'status', 'storage', 'activity', 'nextSession', 'created', 'id']);
export type CampaignCatalogSort = z.infer<typeof CampaignCatalogSort>;

/**
 * Offset pagination rather than a keyset cursor, and that is a considered choice:
 * the catalog is an operator table with SEVEN user-selectable sort keys, most of
 * them non-unique aggregates (storage bytes, activity timestamps). A keyset
 * cursor over a non-unique, mutable aggregate silently skips or repeats rows.
 * LIMIT/OFFSET is honest about being a snapshot, and `total` is a real COUNT(*)
 * over the same predicates. Both are pushed into SQL — see the issue's complaint
 * about campaigns.service.ts loading every row and filtering in memory.
 */
export const CampaignCatalogPage = z.object({
  items: z.array(CampaignCatalogEntry),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** Echoed so an operator (and the audit row) can see exactly which slice this was. */
  sort: CampaignCatalogSort,
  order: z.enum(['asc', 'desc']),
});
export type CampaignCatalogPage = z.infer<typeof CampaignCatalogPage>;

// ---- bulk lifecycle operations (issue #587 bullet 3) ----

/**
 * Every bulk operation the catalog offers. Deliberately a closed enum: an
 * operator acting across campaigns they are not a member of gets exactly these
 * verbs and no generic "patch arbitrary columns" escape hatch.
 */
export const CampaignCatalogBulkOperation = z.enum([
  'archive',
  'pause',
  'activate',
  'reassign_owner',
  'set_quota',
  'set_policy',
  'request_export',
  'update_module',
]);
export type CampaignCatalogBulkOperation = z.infer<typeof CampaignCatalogBulkOperation>;

export const CampaignCatalogBulkOutcome = z.enum(['would_apply', 'applied', 'skipped', 'failed']);
export type CampaignCatalogBulkOutcome = z.infer<typeof CampaignCatalogBulkOutcome>;

/**
 * The one `skipped` reason that means "nothing to do; the campaign is already like
 * this", as opposed to the several that mean "this item was ineligible" or "the preview
 * went stale".
 *
 * Exported as a shared constant because the UI needs to tell those apart and must not do
 * it by counting: a summary that asserts WHY nothing happened has to read the per-item
 * reasons, and a literal duplicated on the client would drift out of agreement with the
 * server the first time the wording is touched.
 */
export const CAMPAIGN_CATALOG_NO_OP_REASON = 'already in the requested state';

export const CampaignCatalogBulkItemResult = z.object({
  campaignId: Id,
  outcome: CampaignCatalogBulkOutcome,
  /** Human-readable "why" — always set for skipped/failed, often set for applied. */
  reason: z.string().max(500).default(''),
  /** The field the operation would change, before → after. Omitted when nothing changes. */
  field: z.string().max(60).default(''),
  before: z.string().max(200).default(''),
  after: z.string().max(200).default(''),
  /**
   * An OPAQUE digest of every table this operation's plan was computed from — not just
   * the campaign row. Compare it for equality; do not parse it.
   *
   * A dry run is only a safety property if Apply performs the plan that was PREVIEWED.
   * The client can detect its own edits, but not the campaign moving underneath it — a
   * DM reactivating a completed campaign between preview and apply turns a `skipped`
   * verdict into a real archive the operator never saw. Echoing the version the plan was
   * computed from lets Apply carry it back as a precondition.
   *
   * It covers EVERY dependency because a guard over a proxy is worse than no guard: this
   * was `campaigns.updated_at` alone, which no write to `campaign_members` or
   * `campaign_export_requests` advances — so a previewed ownership handover still
   * "matched" after someone else had installed a different owner, and Apply demoted them
   * without re-showing the plan.
   */
  stateVersion: z.string().max(64).default(''),
});
export type CampaignCatalogBulkItemResult = z.infer<typeof CampaignCatalogBulkItemResult>;

export const CampaignCatalogBulkRequest = z
  .object({
    operation: CampaignCatalogBulkOperation,
    campaignIds: z.array(Id).min(1).max(200),
    /**
     * Defaults TRUE. A bulk lifecycle change across campaigns the operator cannot
     * read should require typing `"dryRun": false`, not merely forgetting a flag.
     */
    dryRun: z.boolean().default(true),
    /** Recorded verbatim in the audit trail for real runs. */
    reason: z.string().max(500).default(''),
    /** reassign_owner: the user who becomes dm + primary owner. */
    toUserId: Id.optional(),
    /** set_quota: bytes, or null to clear the quota. */
    storageQuotaBytes: z.number().int().nonnegative().nullable().optional(),
    /**
     * set_policy: close public invite links. `false` only.
     *
     * The catalog can shut invites off — the containment action an operator needs —
     * but cannot turn them on. Enabling is gated on the campaign being active and
     * untrashed (see `InvitesService.setPolicy`), and arming the flag from here would
     * bypass that: the next `activate` preserves it and every retained link revives at
     * once. `true` is rejected with a 400 rather than silently ignored.
     */
    publicInvitesEnabled: z.boolean().optional(),
    /** set_policy: external-AI content policy. */
    aiExternalContentPolicy: AiExternalContentPolicy.optional(),
    /** update_module: the rule-pack slug to move campaigns onto. */
    ruleSystem: z.string().max(120).optional(),
    /**
     * request_export: which export profile the DM is being asked to produce.
     *
     * Constrained to the profiles the export module can actually build. A free string
     * here reaches the DM as a request for something that cannot be produced — they
     * approve it and then have no way to satisfy it — so the operator is corrected at
     * request time instead. Defaults to `backup` when omitted.
     */
    exportProfile: ExportProfile.optional(),
    /**
     * Per-campaign preconditions carried back from a dry run.
     *
     * Each entry pins the opaque `stateVersion` the previewed verdict was computed from,
     * which covers every table that verdict was planned from rather than the campaign row
     * alone. A
     * campaign whose version has moved is SKIPPED with a reason rather than replanned
     * from its new state — the operator agreed to a specific plan, and silently applying
     * a different one is the failure a dry run exists to prevent. Skipping per item
     * rather than rejecting the batch is deliberate: a 200-campaign run that aborts
     * because one campaign moved is its own bad outcome.
     *
     * Optional, so an API client that never previews is unaffected.
     */
    preconditions: z
      .array(z.object({ campaignId: Id, stateVersion: z.string().max(64) }))
      .max(200)
      .optional(),
  })
  .strict();
export type CampaignCatalogBulkRequest = z.infer<typeof CampaignCatalogBulkRequest>;

export const CampaignCatalogBulkResult = z.object({
  operation: CampaignCatalogBulkOperation,
  dryRun: z.boolean(),
  requested: z.number().int().nonnegative(),
  wouldApply: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(CampaignCatalogBulkItemResult),
});
export type CampaignCatalogBulkResult = z.infer<typeof CampaignCatalogBulkResult>;

// ---- admin-initiated export REQUESTS (issue #587 bullet 3) ----
//
// An operator can ask for an export; they cannot take one. The catalog's whole
// premise collapses if "request export" hands the requester a file containing
// every quest, note and DM secret in the campaign. So the request is a durable
// ASK addressed to the campaign's DMs, who approve or deny it and who alone can
// then run the existing DM-gated export route. The admin-facing views of these
// rows carry status and timestamps — never an artifact, never content.

export const CampaignExportRequestStatus = z.enum(['pending', 'approved', 'denied', 'cancelled']);
export type CampaignExportRequestStatus = z.infer<typeof CampaignExportRequestStatus>;

export const CampaignExportRequest = z.object({
  id: Id,
  campaignId: Id,
  /** Audit-actor string of the requesting operator (`token:<name>` or a user id). */
  requestedBy: z.string().max(200),
  requestedByUserId: z.string().max(120).default(''),
  /**
   * Which export profile was asked for. Always one of `ExportProfile` for rows this
   * module writes — the request body is validated against that enum — but typed as a
   * plain string because the column carries a `''` default and this is what the DB
   * hands back, not a re-validated value.
   */
  profile: z.string().max(40).default(''),
  /** Why the operator is asking. Required, and shown to the DM who decides. */
  justification: z.string().max(2000).default(''),
  status: CampaignExportRequestStatus,
  decidedBy: z.string().max(200).nullable().default(null),
  decidedAt: IsoDate.nullable().default(null),
  decisionNote: z.string().max(2000).default(''),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type CampaignExportRequest = z.infer<typeof CampaignExportRequest>;

/**
 * A page of export requests for the CROSS-CAMPAIGN admin listing.
 *
 * Paged for the same reason the catalog itself is, and with the same offset/`total`
 * shape rather than a cursor. This listing previously returned a bare array capped at
 * 100 with no offset and no total, which silently truncated: requests raised on other
 * campaigns pushed older pending ones out of the only view that spans campaigns, and an
 * operator could not enumerate the queue without already knowing every affected campaign
 * id — the exact thing a cross-campaign view exists to avoid. A pending approval nobody
 * can see is an approval that never happens, and the waiting DM gets no signal either.
 *
 * The DM-facing per-campaign inbox stays a plain array: it is bounded by one campaign's
 * own history, which is not a queue anyone has to page through.
 */
export const CampaignExportRequestPage = z.object({
  items: z.array(CampaignExportRequest),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type CampaignExportRequestPage = z.infer<typeof CampaignExportRequestPage>;

export const CampaignExportRequestDecision = z
  .object({
    decision: z.enum(['approved', 'denied']),
    note: z.string().max(2000).default(''),
  })
  .strict();
export type CampaignExportRequestDecision = z.infer<typeof CampaignExportRequestDecision>;

/** A campaign's own catalog-privacy opt-out, as its DM reads and writes it. */
export const CampaignCatalogPrivacySetting = z.object({
  campaignId: Id,
  catalogPrivacy: CampaignCatalogPrivacy,
  /** The server default in force, so a DM can see what `inherit` currently means. */
  serverDefault: CampaignCatalogPrivacyPolicy,
  /** What the catalog actually discloses for this campaign right now. */
  effective: z.object({
    names: CampaignCatalogFieldVisibility,
    descriptions: CampaignCatalogFieldVisibility,
  }),
});
export type CampaignCatalogPrivacySetting = z.infer<typeof CampaignCatalogPrivacySetting>;

export const CampaignCatalogPrivacyUpdate = z
  .object({ catalogPrivacy: CampaignCatalogPrivacy })
  .strict();
export type CampaignCatalogPrivacyUpdate = z.infer<typeof CampaignCatalogPrivacyUpdate>;

// ---------- campaign library management (issue #742) ----------
// These contracts deliberately describe a clean, campaign-owned taxonomy.  They do
// not contain a migration/version field: early-alpha clients all speak this shape.
export const LibraryEntityType = z.enum([
  'quest', 'npc', 'location', 'faction', 'encounter', 'timeline_event', 'inventory_item', 'attachment', 'campaign_library_monster',
]);
export type LibraryEntityType = z.infer<typeof LibraryEntityType>;

const LibraryName = z.string().trim().min(1).max(120);
const LibraryAliases = z.array(LibraryName).max(30).default([]);
const LibraryColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #RRGGBB value').default('#64748b');
export const CampaignLibraryTag = z.object({
  id: Id, campaignId: Id, name: LibraryName, aliases: LibraryAliases, color: LibraryColor,
  description: z.string().max(2000).default(''), parentTagId: Id.nullable().default(null), createdAt: IsoDate, updatedAt: IsoDate,
});
export type CampaignLibraryTag = z.infer<typeof CampaignLibraryTag>;
export const CampaignLibraryTagCreate = CampaignLibraryTag.pick({ name: true, aliases: true, color: true, description: true, parentTagId: true }).partial({ aliases: true, color: true, description: true, parentTagId: true });
export const CampaignLibraryTagUpdate = CampaignLibraryTagCreate.partial();
export type CampaignLibraryTagCreate = z.infer<typeof CampaignLibraryTagCreate>;
export type CampaignLibraryTagUpdate = z.infer<typeof CampaignLibraryTagUpdate>;

export const CampaignLibraryCollection = z.object({
  id: Id, campaignId: Id, name: LibraryName, aliases: LibraryAliases, color: LibraryColor,
  description: z.string().max(2000).default(''), parentCollectionId: Id.nullable().default(null), createdAt: IsoDate, updatedAt: IsoDate,
});
export type CampaignLibraryCollection = z.infer<typeof CampaignLibraryCollection>;
export const CampaignLibraryCollectionCreate = CampaignLibraryCollection.pick({ name: true, aliases: true, color: true, description: true, parentCollectionId: true }).partial({ aliases: true, color: true, description: true, parentCollectionId: true });
export const CampaignLibraryCollectionUpdate = CampaignLibraryCollectionCreate.partial();
export type CampaignLibraryCollectionCreate = z.infer<typeof CampaignLibraryCollectionCreate>;
export type CampaignLibraryCollectionUpdate = z.infer<typeof CampaignLibraryCollectionUpdate>;

export const LibraryEntityRef = z.object({ entityType: LibraryEntityType, entityId: Id });
export type LibraryEntityRef = z.infer<typeof LibraryEntityRef>;
const LibraryBulkTargets = z.array(LibraryEntityRef).min(1).max(500).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => { const key = `${item.entityType}:${item.entityId}`; if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'targets must be unique' }); seen.add(key); });
});
export const LibraryBulkOperation = z.enum(['add_tag', 'remove_tag', 'add_collection', 'remove_collection', 'move_collection', 'set_visibility', 'set_status', 'move_inventory_owner', 'archive', 'restore']);
/** Discriminated so an action can never receive ambiguous or ignored fields. */
const LibraryBulkRequestBase = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('add_tag'), targets: LibraryBulkTargets, taxonomyId: Id }).strict(),
  z.object({ operation: z.literal('remove_tag'), targets: LibraryBulkTargets, taxonomyId: Id }).strict(),
  z.object({ operation: z.literal('add_collection'), targets: LibraryBulkTargets, taxonomyId: Id }).strict(),
  z.object({ operation: z.literal('remove_collection'), targets: LibraryBulkTargets, taxonomyId: Id }).strict(),
  z.object({ operation: z.literal('move_collection'), targets: LibraryBulkTargets, taxonomyId: Id }).strict(),
  z.object({ operation: z.literal('set_visibility'), targets: LibraryBulkTargets, visibility: z.enum(['public', 'hidden']) }).strict(),
  z.object({ operation: z.literal('set_status'), targets: LibraryBulkTargets, status: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal('move_inventory_owner'), targets: LibraryBulkTargets, ownerType: z.enum(['party', 'character']), characterId: Id.nullable().optional() }).strict(),
  z.object({ operation: z.literal('archive'), targets: LibraryBulkTargets }).strict(),
  z.object({ operation: z.literal('restore'), targets: LibraryBulkTargets }).strict(),
]);
export const LibraryBulkRequest = LibraryBulkRequestBase.superRefine((value, ctx) => {
  if (value.operation !== 'move_inventory_owner') return;
  if (value.ownerType === 'character' && value.characterId == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['characterId'], message: 'characterId is required for character ownership' });
  if (value.ownerType === 'party' && value.characterId != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['characterId'], message: 'party ownership cannot include characterId' });
});
export type LibraryBulkRequest = z.infer<typeof LibraryBulkRequest>;
export const LibraryBulkResult = z.object({ operationId: Id, applied: z.number().int().nonnegative(), undoAvailable: z.boolean() });
export type LibraryBulkResult = z.infer<typeof LibraryBulkResult>;
export const LibraryEntitySummary = z.object({ entityType: LibraryEntityType, entityId: Id, name: z.string(), description: z.string().default(''), visibility: z.string().nullable().default(null), status: z.string().nullable().default(null), owner: z.string().nullable().default(null), tags: z.array(CampaignLibraryTag), collections: z.array(CampaignLibraryCollection) });
export type LibraryEntitySummary = z.infer<typeof LibraryEntitySummary>;
export const LibraryFacet = z.object({ id: z.union([Id, z.string()]), label: z.string(), count: z.number().int().nonnegative() });
export const LibrarySearchPage = z.object({ items: z.array(LibraryEntitySummary), total: z.number().int().nonnegative(), limit: z.number().int().positive(), offset: z.number().int().nonnegative(), facets: z.object({ types: z.array(LibraryFacet), tags: z.array(LibraryFacet), collections: z.array(LibraryFacet), visibility: z.array(LibraryFacet), status: z.array(LibraryFacet) }) });
export type LibrarySearchPage = z.infer<typeof LibrarySearchPage>;
export const LibrarySearchQuery = z.object({ q: z.string().trim().max(200).optional(), type: LibraryEntityType.optional(), tagId: z.coerce.number().int().positive().optional(), collectionId: z.coerce.number().int().positive().optional(), visibility: z.enum(['public', 'hidden']).optional(), status: z.string().trim().max(80).optional(), owner: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict();
export const CampaignLibraryTemplate = z.object({ id: Id, campaignId: Id, entityType: LibraryEntityType, name: LibraryName, description: z.string().max(2000).default(''), snapshot: z.unknown(), sourceEntityId: Id.nullable().default(null), archivedAt: IsoDate.nullable().default(null), createdAt: IsoDate, updatedAt: IsoDate });
export type CampaignLibraryTemplate = z.infer<typeof CampaignLibraryTemplate>;
export const CampaignLibraryTemplateSave = z.object({ entityType: LibraryEntityType, entityId: Id, name: LibraryName, description: z.string().max(2000).default('') }).strict();
export type CampaignLibraryTemplateSave = z.infer<typeof CampaignLibraryTemplateSave>;
export const CampaignLibraryTemplateInstantiate = z.object({ name: LibraryName.optional(), refs: z.record(z.string().max(80), Id).default({}) }).strict();
export type CampaignLibraryTemplateInstantiate = z.infer<typeof CampaignLibraryTemplateInstantiate>;

export const EncounterTemplateRosterEntry = z.object({
  kind: CombatantKind.exclude(['character']),
  name: z.string().min(1).max(120),
  statblock: CombatantStatblock.nullable().optional().default(null),
  hpMax: z.number().int().min(0),
  initMod: z.number().int().default(0),
  tokenSize: TokenSize.default('medium'),
  sortOrder: z.number().int().default(0),
  count: z.number().int().min(1).default(1),
});
export type EncounterTemplateRosterEntry = z.infer<typeof EncounterTemplateRosterEntry>;

export const EncounterTemplateRoster = z.array(EncounterTemplateRosterEntry);
export type EncounterTemplateRoster = z.infer<typeof EncounterTemplateRoster>;

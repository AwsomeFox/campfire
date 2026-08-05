import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, ConflictException, ForbiddenException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import JSZip from 'jszip';
import type { z } from 'zod';
import {
  CAMPAIGN_PURGE_CONFIRM_TOKEN,
  CampaignClone,
  CampaignCloneMode,
  CampaignCreate,
  CampaignImport,
  CampaignPurge,
  CampaignUpdate,
  AttachmentMetadata,
  CAMPAIGN_CLONE_PREVIEW_FORMAT_VERSION,
  AiExternalContentPolicy,
  NarrationLanguage,
  CompendiumRef,
  CompendiumSnapshot,
  normalizeOffsetIsoDateTime,
  CharacterAction,
  isRegisteredRuleSystemSlug,
} from '@campfire/schema';
import type { Campaign, CampaignClonePreview, CampaignSummary, Role, TrashedEntity, CampaignImportPreflight, OnUnresolvedCompendium, HomebrewMechanicsProfile } from '@campfire/schema';
import { fromJsonText } from '../../common/json';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaigns,
  notes,
  quests,
  questObjectives,
  sessions,
  npcs,
  locations,
  characters,
  encounters,
  combatants,
  proposals,
  campaignMembers,
  campaignModuleArtifacts,
  campaignModuleInstalls,
  campaignModuleSnapshots,
  campaignGuestDmGrants,
  apiTokens,
  attachments,
  rulePacks,
  campaignLibraryMonsters,
  storyArcs,
  storyBeats,
  storyBranches,
  timelineEvents,
  timelineCalendars,
  sessionZero,
  factions,
  sessionAttendees,
  sessionShares,
  castSessions,
  scheduledSessions,
  sessionRsvps,
  sessionSeries,
  seriesExceptions,
  comments,
  entityRevisions,
  campaignInvites,
  diceRolls,
  notifications,
  inventoryItems,
  partyTreasury,
  aiDmSeats,
  aiDriverControlState,
  tableSafetyHolds,
  aiScribeConfigs,
  encounterEvents,
  auditLog,
  participantSupportPreferences,
  campaignPurgeTombstones,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { persistedFogConcealsPixels } from '../../common/fog';
import { AuditService } from '../audit/audit.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { CharactersService } from '../characters/characters.service';
import { SessionsService } from '../sessions/sessions.service';
import { SchedulingService } from '../sessions/scheduling.service';
import { EncountersService } from '../encounters/encounters.service';
import { InventoryService } from '../inventory/inventory.service';
import { TimelineService } from '../timeline/timeline.service';
import { CommentsService } from '../comments/comments.service';
import { RoleResolver } from '../membership/role-resolver.service';
import { MembersService } from '../membership/members.service';
import { InvitesService } from '../membership/invites.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { ALLOWED_MIME_TO_EXT, MAX_UPLOAD_BYTES, sniffImageMime } from '../attachments/attachments.service';
import { copyAttachmentBytes, remapAttachmentFileUrl, attachmentUploadPath } from '../attachments/attachment-copy';
import { FsDeletionService, type FsDeletionOutcome } from '../attachments/fs-deletion.service';
import { uploadsRoot } from '../attachments/uploads-path';
import { historicalAvatarAttachmentId, safeHistoricalAvatarUrl } from '../../common/avatar-url';
import { ATTACHMENT_STATE_COMMITTED } from '../attachments/attachment.constants';
import { sanitizeAttachmentFilename } from '../attachments/filename';
import { APP_VERSION } from '../../common/build-metadata';
import { CURRENT_SCHEMA_REVISION } from '../backup/backup-manifest';
import { freshAiSeatCounters, portableAiSeat, readPortableAiSeat } from '../ai-dm/ai-seat-portability';
import { AiDmService } from '../ai-dm/ai-dm.service';
import { readConditionInstances, sheetConditionWriteSetFromInstances, sheetConditionWriteSetFromNames } from '../../common/conditions';
import {
  assertCompendiumImportAllowed,
  buildResolutionMap,
  preflightCompendiumImport,
  resolveImportedCombatantRuleEntryId,
} from './compendium-import';

function safeImportedCompendiumSnapshot(value: unknown): string | null {
  const parsed = CompendiumSnapshot.safeParse(value);
  if (!parsed.success) return null;
  // Keep play-safe provenance; blank only an unsafe external URL.
  const snapshot = parsed.data.sourceUrl && !/^https?:\/\//i.test(parsed.data.sourceUrl)
    ? { ...parsed.data, sourceUrl: '' }
    : parsed.data;
  return JSON.stringify(snapshot);
}

function safeImportedCompendiumRef(value: unknown): string | null {
  const parsed = CompendiumRef.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

/** Generous cap on an uploaded import archive: several full-size (8MB) maps + text. */
const MAX_IMPORT_ARCHIVE_BYTES = 128 * 1024 * 1024;

/**
 * Issue #725: the staging area where an in-flight import parks its attachment
 * bytes BEFORE any DB row is committed. Lives under uploadsRoot()/.staging/<nonce>/
 * so a rename into the final uploadsRoot()/<campaignId>/ location is atomic (same
 * filesystem — a rename across devices would fall back to copy+unlink and could
 * fail mid-way). Cleaned up on every outcome path (success after publish, or any
 * failure before/after the DB transaction).
 */
function stagingRoot(): string {
  return path.join(uploadsRoot(), '.staging');
}

/**
 * Create a unique staging directory for one import run. A crypto nonce keeps
 * concurrent imports from colliding. Returned path is the dir the caller should
 * write every staged attachment into (any sub-layout the caller wants).
 */
function createStagingDir(): string {
  const dir = path.join(stagingRoot(), crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Best-effort recursive removal of a staging dir — never throws (failures here
 * are harmless: a stray staging dir is invisible to the app and can be GC'd by
 * an operator; it does NOT orphan a campaign the way a stray uploadsRoot()/<id>/
 * entry would, because no DB row points at it).
 */
function cleanupStagingDir(stagingDir: string | null): void {
  if (!stagingDir) return;
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    /* best-effort — see doc above */
  }
}

/**
 * Issue #725 — preflight writability probe for the uploads root. Creates (if
 * needed) and writes+deletes a sentinel file under uploadsRoot() so an
 * unwritable/unmounted DATA_DIR fails the import with a clear 400 BEFORE we
 * spend the work staging every attachment byte. Mirrors the kind of check the
 * issue's acceptance criteria calls out ("quota/free space, and writability").
 */
function assertUploadsWritable(): void {
  const root = uploadsRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.writable-probe-${crypto.randomBytes(8).toString('hex')}`);
    fs.writeFileSync(probe, Buffer.from('ok'));
    fs.rmSync(probe, { force: true });
  } catch (err) {
    throw new BadRequestException(
      `Upload directory is not writable (cannot stage the import): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Module-scoped logger for the free import helpers (publish-failure warnings). */
const importLog = new Logger('CampaignsImport');

/**
 * Issue #725: per-attachment import outcome, surfaced in the ImportResult so the
 * caller (and tests) can tell exactly which files imported, which were skipped
 * (invalid/oversize/dangling manifest entry), and which failed to publish.
 */
export interface ImportAttachmentResult {
  /** The new attachment row id (differs from the source id). */
  id: number;
  kind: string;
  filename: string;
  size: number;
}

/**
 * Issue #725: the import job result returned alongside the new campaign.
 *
 *   - `attachmentsImported` — every attachment whose row AND bytes landed.
 *   - `attachmentsSkipped` — manifest entries dropped during preflight (no bytes
 *     in the archive, wrong magic bytes, or over the per-file size cap); these
 *     never had a row inserted, so there is no dangling reference.
 *   - `attachmentsFailed` — rows committed but whose staged bytes could not be
 *     published to the final location (rare: ENOSPC/EACCES on the rename). A
 *     failed entry is the tolerated "row-without-file" shape (#84): the GET
 *     route 404s that one file, the campaign is otherwise intact.
 *
 * The staging directory itself is always swept (best-effort) in the import's
 * `finally` — a leftover staging entry is invisible to the app (no DB row
 * points at it), so it is not surfaced here.
 */
export interface ImportResult {
  campaign: Campaign;
  attachmentsImported: number;
  attachmentsSkipped: number;
  attachmentsFailed: number;
  attachmentDetails: ImportAttachmentResult[];
  /** Issue #584: compendium dependency preflight outcome for this import run. */
  compendiumPreflight?: CampaignImportPreflight;
  /** Issue #584: combatants imported without a live compendium link (detached snapshots). */
  compendiumDetachedCount?: number;
}

type CampaignCreateInput = z.infer<typeof CampaignCreate>;
type CampaignUpdateInput = z.infer<typeof CampaignUpdate>;
type CampaignCloneInput = z.infer<typeof CampaignClone>;
type CampaignImportInput = z.infer<typeof CampaignImport>;

/**
 * One attachment's bytes + metadata extracted from a zip export's uploads/ folder,
 * to be recreated (row + on-disk file) under the freshly imported campaign. `srcId`
 * is the attachment's id in the SOURCE document — the key every reference to it
 * (campaign.mapAttachmentId, character.portraitUrl, encounter.mapAttachmentId) is
 * remapped through. See importCampaign / importArchive (issue #236).
 */
export interface ImportAttachmentFile {
  srcId: number;
  kind: string;
  filename: string;
  mime: string;
  bytes: Buffer;
  title: string;
  caption: string;
  altText: string;
  creator: string;
  sourceUrl: string;
  license: string;
  rights: string;
  attribution: string;
  checksumSha256: string | null;
}

// ---- defensive readers for an imported export document (issue #120) ----
// The import body is a Campfire JSON export whose entities are validated only as
// loose objects (see @campfire/schema CampaignImport). These coerce each field to
// the shape the DB column wants, tolerating a missing/mistyped value rather than
// trusting the document, so a hand-edited or older-format export still imports.
type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const asArr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(asRec) : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const intOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback);
// Issue #1910 review (Devin, PR #1980, on c3ea4545): `speed` (unlike `ac`) has a
// schema-level `min(0)`, so a malformed/negative import value would otherwise write
// past the domain contract and fail zod validation on the next read (bricking the
// imported sheet) — that part of the original fix was right. But the original
// version of this helper CLAMPED a negative value to 0 via Math.max(0, n), which
// collided with this PR's own stated design: 0 is a REAL value (a homebrew
// immobilized PC), and null means "unset" so the turn workspace falls through to
// the adapter default. Clamping a corrupted/hand-edited negative import to 0 would
// silently paralyze that PC instead of landing it on the adapter default. Returns
// null for anything out of range so it's always schema-valid AND preserves the
// null/0 distinction the rest of the PR depends on.
const nonNegativeIntOrNull = (v: unknown): number | null => {
  const n = intOrNull(v);
  return n == null || n < 0 ? null : n;
};
const realOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOf = (v: unknown): boolean => v === true;
/**
 * Secrecy flag (`hidden`) coercion for import — fails CLOSED (#754). Only an explicit
 * boolean `false` reveals an entity; a missing flag OR any non-boolean value (e.g. a
 * hand-edited export carrying `"true"` or `1`) stays hidden, so a malformed export can
 * never accidentally reveal a private prep entity to players.
 */
const hiddenOf = (v: unknown): boolean => v !== false;
/** Serialize a JSON-ish export field (object/array) back to the TEXT the column stores. */
const jsonCol = (v: unknown, fallback: string): string => {
  if (v === undefined || v === null) return fallback;
  try {
    return JSON.stringify(v);
  } catch {
    return fallback;
  }
};
const importedConditionNames = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((name): name is string => typeof name === 'string') : null;
const characterConditionWriteSetForImport = (row: Rec): { conditions: string; conditionInstances: string } => {
  const names = importedConditionNames(row.conditions);
  const instancesText = jsonCol(row.conditionInstances, '[]');
  if (names) return sheetConditionWriteSetFromNames(names, instancesText);
  return sheetConditionWriteSetFromInstances(readConditionInstances(instancesText, '[]'));
};

function toDomain(row: typeof campaigns.$inferSelect): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as Campaign['status'],
    currentLocationId: row.currentLocationId,
    dangerLevel: row.dangerLevel as Campaign['dangerLevel'],
    dmControlsProgression: row.dmControlsProgression,
    dmControlsTurns: row.dmControlsTurns,
    requireDmTurnConfirmation: row.requireDmTurnConfirmation,
    publicRecapSharingEnabled: row.publicRecapSharingEnabled,
    publicInvitesEnabled: row.publicInvitesEnabled,
    narrationLanguage: (row.narrationLanguage ?? 'en') as Campaign['narrationLanguage'],
    aiExternalContentPolicy: (row.aiExternalContentPolicy ?? 'member_consent') as Campaign['aiExternalContentPolicy'],
    sessionCount: row.sessionCount,
    latestSessionNumber: row.latestSessionNumber,
    ruleSystem: row.ruleSystem,
    customMechanicsProfile: fromJsonText<HomebrewMechanicsProfile | null>(row.customMechanicsProfile, null),
    mapAttachmentId: row.mapAttachmentId,
    storageQuotaBytes: row.storageQuotaBytes ?? null,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly characters: CharactersService,
    private readonly sessions: SessionsService,
    private readonly scheduling: SchedulingService,
    @Inject(forwardRef(() => EncountersService)) private readonly encounters: EncountersService,
    private readonly inventory: InventoryService,
    private readonly timeline: TimelineService,
    private readonly comments: CommentsService,
    private readonly roleResolver: RoleResolver,
    private readonly members: MembersService,
    private readonly invites: InvitesService,
    private readonly fsDeletion: FsDeletionService,
    private readonly events: CampaignEventsService,
    // #1049 review: clone and import write `ai_dm_seats` directly, so they owe the AI-DM
    // module a nudge afterwards — see syncProactiveWatcher. AiDmModule imports nothing that
    // leads back to CampaignsModule, so this edge is acyclic.
    private readonly aiDm: AiDmService,
    // Issue #1707: trash() sends the account-wide `campaign_trashed` signal. NotificationsModule
    // is a leaf module (only DbModule), so importing it here creates no cycle.
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Dev-auth (dev:*) users see all campaigns; everyone else — server admins included
   * (issue #9) — only campaigns they're a member of. Trashed (soft-deleted, issue #116)
   * campaigns are excluded — they surface only through listTrashedForUser().
   */
  async listForUser(user: RequestUser): Promise<Campaign[]> {
    const accessible = await this.roleResolver.accessibleCampaignIds(user);
    const rows = await this.db.select().from(campaigns).where(notDeleted(campaigns.deletedAt));
    if (accessible === 'all') return rows.map(toDomain);
    const allowed = new Set(accessible);
    return rows.filter((r) => allowed.has(r.id)).map(toDomain);
  }

  /**
   * The Trash view (issue #116): the caller's soft-deleted campaigns, newest-trashed
   * first. Same membership scoping as listForUser — the membership rows survive a
   * soft-delete, so a co-DM still sees (and can restore) a campaign a co-DM trashed.
   */
  async listTrashedForUser(user: RequestUser): Promise<Campaign[]> {
    const accessible = await this.roleResolver.accessibleCampaignIds(user);
    const rows = await this.db.select().from(campaigns).where(isNotNull(campaigns.deletedAt));
    const visible = accessible === 'all' ? rows : rows.filter((r) => new Set(accessible).has(r.id));
    return visible.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')).map(toDomain);
  }

  /**
   * The per-campaign Trash (issue #269): every soft-deleted (issue #116) child entity
   * of this campaign, newest-trashed first, as lightweight {type,id,name,deletedAt} rows
   * the Trash page renders and restores (POST /<route>/:id/restore — usually the plural
   * resource name, with timeline_event -> /timeline/:id/restore). DM-only — gated in
   * the controller. Covers the entity types that both carry a `deleted_at` column AND
   * expose a DM-gated restore endpoint today: sessions, characters, quests, npcs,
   * locations, factions, encounters, story arcs, story beats, and timeline events. Notes are deliberately
   * excluded — their per-author/whisper visibility means a trashed note may belong to another member and must not surface in a DM's
   * campaign-wide Trash (their restore is membership+author-scoped, not DM-only). Add a
   * new type here (and to @campfire/schema TrashedEntityType) when it gains a restore route.
   */
  async listTrashedEntities(campaignId: number): Promise<TrashedEntity[]> {
    const [
      sessionRows,
      characterRows,
      questRows,
      npcRows,
      locationRows,
      factionRows,
      encounterRows,
      storyArcRows,
      storyBeatRows,
      timelineEventRows,
    ] = await Promise.all([
      this.db
        .select({ id: sessions.id, title: sessions.title, number: sessions.number, deletedAt: sessions.deletedAt })
        .from(sessions)
        .where(and(eq(sessions.campaignId, campaignId), isNotNull(sessions.deletedAt))),
      this.db
        .select({ id: characters.id, name: characters.name, deletedAt: characters.deletedAt })
        .from(characters)
        .where(and(eq(characters.campaignId, campaignId), isNotNull(characters.deletedAt))),
      this.db
        .select({ id: quests.id, title: quests.title, deletedAt: quests.deletedAt })
        .from(quests)
        .where(and(eq(quests.campaignId, campaignId), isNotNull(quests.deletedAt))),
      this.db
        .select({ id: npcs.id, name: npcs.name, deletedAt: npcs.deletedAt })
        .from(npcs)
        .where(and(eq(npcs.campaignId, campaignId), isNotNull(npcs.deletedAt))),
      this.db
        .select({ id: locations.id, name: locations.name, deletedAt: locations.deletedAt })
        .from(locations)
        .where(and(eq(locations.campaignId, campaignId), isNotNull(locations.deletedAt))),
      this.db
        .select({ id: factions.id, name: factions.name, deletedAt: factions.deletedAt })
        .from(factions)
        .where(and(eq(factions.campaignId, campaignId), isNotNull(factions.deletedAt))),
      this.db
        .select({ id: encounters.id, name: encounters.name, deletedAt: encounters.deletedAt })
        .from(encounters)
        .where(and(eq(encounters.campaignId, campaignId), isNotNull(encounters.deletedAt))),
      this.db
        .select({ id: storyArcs.id, title: storyArcs.title, deletedAt: storyArcs.deletedAt })
        .from(storyArcs)
        .where(and(eq(storyArcs.campaignId, campaignId), isNotNull(storyArcs.deletedAt))),
      this.db
        .select({
          id: storyBeats.id,
          title: storyBeats.title,
          deletedAt: storyBeats.deletedAt,
          arcId: storyBeats.arcId,
        })
        .from(storyBeats)
        .where(and(eq(storyBeats.campaignId, campaignId), isNotNull(storyBeats.deletedAt))),
      this.db
        .select({ id: timelineEvents.id, title: timelineEvents.title, deletedAt: timelineEvents.deletedAt })
        .from(timelineEvents)
        .where(and(eq(timelineEvents.campaignId, campaignId), isNotNull(timelineEvents.deletedAt))),
    ]);

    const trashedArcIds = new Set(storyArcRows.map((r) => r.id));

    const items: TrashedEntity[] = [
      ...sessionRows.map((r) => ({
        type: 'session' as const,
        id: r.id,
        name: r.title || `Session ${r.number}`,
        deletedAt: r.deletedAt as string,
      })),
      ...characterRows.map((r) => ({ type: 'character' as const, id: r.id, name: r.name, deletedAt: r.deletedAt as string })),
      ...questRows.map((r) => ({ type: 'quest' as const, id: r.id, name: r.title, deletedAt: r.deletedAt as string })),
      ...npcRows.map((r) => ({ type: 'npc' as const, id: r.id, name: r.name, deletedAt: r.deletedAt as string })),
      ...locationRows.map((r) => ({ type: 'location' as const, id: r.id, name: r.name, deletedAt: r.deletedAt as string })),
      ...factionRows.map((r) => ({ type: 'faction' as const, id: r.id, name: r.name, deletedAt: r.deletedAt as string })),
      ...encounterRows.map((r) => ({ type: 'encounter' as const, id: r.id, name: r.name, deletedAt: r.deletedAt as string })),
      ...storyArcRows.map((r) => ({ type: 'story_arc' as const, id: r.id, name: r.title, deletedAt: r.deletedAt as string })),
      // Beats trashed as part of an arc cascade surface only via the arc row.
      ...storyBeatRows
        .filter((r) => !trashedArcIds.has(r.arcId))
        .map((r) => ({ type: 'story_beat' as const, id: r.id, name: r.title, deletedAt: r.deletedAt as string })),
      ...timelineEventRows.map((r) => ({
        type: 'timeline_event' as const,
        id: r.id,
        name: r.title,
        deletedAt: r.deletedAt as string,
      })),
    ];
    // Newest-trashed first — a single ordering across the merged types.
    return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  /**
   * Fetch a campaign by id. By default a trashed campaign is invisible (404), same as
   * a nonexistent one — every normal GET/summary path funnels through here. The
   * restore/purge paths pass `{ includeDeleted: true }` so they can act on a trashed row.
   */
  async getOrThrow(id: number, opts?: { includeDeleted?: boolean }): Promise<Campaign> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row || (!opts?.includeDeleted && row.deletedAt != null)) {
      throw new NotFoundException('Campaign not found');
    }
    return toDomain(row);
  }

  /**
   * A non-empty ruleSystem must name an installed rule pack (rule_packs.slug) — otherwise
   * a campaign could point at a system that doesn't exist, silently breaking anything
   * downstream (Compendium lookups scoped by pack slug) that assumes it resolves.
   * Empty string ('' — "no rule system picked") is always allowed, both on create and
   * when clearing it back via PATCH.
   *
   * Issue #1502: a homebrew campaign that carries its OWN validated customMechanicsProfile
   * (checked separately by validateCustomMechanicsProfile, always in the same write) is the
   * one exception — its slug need not match an installed rule pack, since the profile IS
   * the rule system rather than imported content.
   */
  private async validateRuleSystem(ruleSystem: string | undefined, hasCustomMechanicsProfile: boolean): Promise<void> {
    if (!ruleSystem) return;
    if (hasCustomMechanicsProfile) return;
    const [pack] = await this.db.select({ id: rulePacks.id }).from(rulePacks).where(eq(rulePacks.slug, ruleSystem)).limit(1);
    if (!pack) {
      throw new BadRequestException(
        `ruleSystem "${ruleSystem}" does not match any installed rule pack (or provide a matching customMechanicsProfile)`,
      );
    }
  }

  /**
   * Validate a homebrew mechanics profile against the ruleSystem slug it is being stored
   * against (issue #1502). `HomebrewMechanicsProfile` itself already rejects out-of-enum
   * strategy values at the zod boundary (CampaignCreate/CampaignUpdate parsing, both REST
   * and MCP); this covers the cross-field business rules zod alone can't express:
   *  - a profile requires a non-empty ruleSystem slug to attach to;
   *  - that slug must NOT be a built-in registered adapter (5e/PF2e/OSR/…) — a homebrew
   *    profile can never override a known system's mechanics through this side door;
   *  - profile.slug must equal ruleSystem, so `ruleSystemAdapter(ruleSystem, profile)` can
   *    trust the pairing without a second lookup at every resolve call site.
   */
  private validateCustomMechanicsProfile(
    ruleSystem: string | null | undefined,
    profile: HomebrewMechanicsProfile | null | undefined,
  ): void {
    if (profile == null) return;
    if (!ruleSystem) {
      throw new BadRequestException('customMechanicsProfile requires a non-empty ruleSystem slug');
    }
    if (isRegisteredRuleSystemSlug(ruleSystem)) {
      throw new BadRequestException(
        `ruleSystem "${ruleSystem}" is a built-in rule system and cannot carry a customMechanicsProfile`,
      );
    }
    if (profile.slug !== ruleSystem) {
      throw new BadRequestException(`customMechanicsProfile.slug ("${profile.slug}") must match ruleSystem ("${ruleSystem}")`);
    }
  }

  /**
   * currentLocationId (locations) and mapAttachmentId (attachments) are FK-shaped fields
   * that previously accepted any integer with no existence/campaign check — a nonexistent
   * id, or worse, another campaign's location/attachment id, would silently pass through.
   * `campaignId` is the id of the campaign these fields must resolve WITHIN: on create
   * that's the not-yet-known new campaign's own id, which can never match any existing
   * row, so create() only ever passes null through for these two — validation on create
   * would be a pointless always-fail. On update, `campaignId` is the existing campaign id.
   */
  private async validateLocationRef(locationId: number | null | undefined, campaignId: number): Promise<void> {
    if (locationId == null) return;
    const [row] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`currentLocationId ${locationId} does not exist in this campaign`);
  }

  private async validateAttachmentRef(attachmentId: number | null | undefined, campaignId: number): Promise<void> {
    if (attachmentId == null) return;
    const [row] = await this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.campaignId, campaignId),
          eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException(`mapAttachmentId ${attachmentId} does not exist in this campaign`);
  }

  /** Any authenticated user may create a campaign; creator is auto-inserted as 'dm' (skipped for dev:* users). */
  async create(input: CampaignCreateInput, user: RequestUser): Promise<Campaign> {
    this.validateCustomMechanicsProfile(input.ruleSystem ?? '', input.customMechanicsProfile ?? null);
    await this.validateRuleSystem(input.ruleSystem, input.customMechanicsProfile != null);
    // A brand-new campaign has no locations/attachments of its own yet, so any
    // non-null currentLocationId/mapAttachmentId on create can never be valid.
    if (input.currentLocationId != null) {
      throw new BadRequestException('currentLocationId cannot be set on campaign create (no locations exist yet)');
    }
    if (input.mapAttachmentId != null) {
      throw new BadRequestException('mapAttachmentId cannot be set on campaign create (no attachments exist yet)');
    }
    const ts = nowIso();
    const [row] = await this.db
      .insert(campaigns)
      .values({
        name: input.name,
        description: input.description ?? '',
        status: input.status ?? 'active',
        currentLocationId: input.currentLocationId ?? null,
        dangerLevel: input.dangerLevel ?? 'low',
        dmControlsProgression: input.dmControlsProgression ?? false,
        dmControlsTurns: input.dmControlsTurns ?? false,
        requireDmTurnConfirmation: input.requireDmTurnConfirmation ?? false,
        publicRecapSharingEnabled: true,
        // Brand-new campaigns that start archived cannot accept joins until the
        // DM both unarchives and deliberately re-enables invites (#857).
        publicInvitesEnabled: (input.status ?? 'active') === 'active',
        narrationLanguage: input.narrationLanguage ?? 'en',
        aiExternalContentPolicy: input.aiExternalContentPolicy ?? 'member_consent',
        sessionCount: 0,
        latestSessionNumber: 0,
        ruleSystem: input.ruleSystem ?? '',
        customMechanicsProfile: input.customMechanicsProfile ? JSON.stringify(input.customMechanicsProfile) : null,
        mapAttachmentId: input.mapAttachmentId ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    if (!user.devRole) {
      const numericId = Number(user.id);
      if (Number.isInteger(numericId)) {
        await this.members.addCreatorAsDm(row.id, numericId);
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: row.id,
      campaignId: row.id,
    });
    return toDomain(row);
  }

  async update(
    id: number,
    input: CampaignUpdateInput,
    user: RequestUser,
    opts?: { revokeInvites?: boolean },
  ): Promise<Campaign> {
    const existing = await this.getOrThrow(id);
    // mapAlignment is a request-time directive (issue #870), not a stored column.
    // customMechanicsProfile is pulled out too (issue #1502) — it needs cross-field validation
    // against the EFFECTIVE ruleSystem and JSON serialization before it can join campaignInput,
    // which is spread directly into `.set()` below.
    const { mapAlignment, customMechanicsProfile: customMechanicsProfileInput, ...campaignInput } = input;
    const shouldResetPins =
      mapAlignment === 'reset' && (existing.mapAttachmentId != null || campaignInput.mapAttachmentId != null);
    // Archived (paused/completed) campaigns are read-only (issue #16). The one
    // campaign-level PATCH still allowed is flipping `status` itself (un-archive,
    // or paused <-> completed) — any other field requires un-archiving first.
    if (existing.status !== 'active') {
      const extraKeys = Object.keys(input).filter((k) => k !== 'status' && input[k as keyof CampaignUpdateInput] !== undefined);
      if (extraKeys.length > 0) {
        throw new ForbiddenException(
          `Campaign is ${existing.status} (read-only) — only 'status' can be changed; set it back to 'active' first (rejected: ${extraKeys.join(', ')})`,
        );
      }
    }
    // Issue #1502: resolve the EFFECTIVE ruleSystem this write applies against — the incoming
    // value, or the campaign's existing one when this request doesn't touch ruleSystem — so a
    // customMechanicsProfile write is validated against the slug it will actually pair with.
    const effectiveRuleSystem = input.ruleSystem !== undefined ? input.ruleSystem : existing.ruleSystem;
    // #1502 review: a homebrew slug is backed by its PROFILE, not by an installed rule pack, so
    // the rule-pack requirement has to be satisfied by the profile the campaign will actually
    // have after this write — not only by one re-sent in the same request. Without the second
    // clause a homebrew campaign becomes un-PATCHable the moment any request echoes its own
    // `ruleSystem` (a full-object PUT-style update from the settings form does exactly that):
    // no rule pack carries that slug, so it 400s on a value it already holds.
    // An explicit `customMechanicsProfile: null` deliberately does NOT satisfy it — that
    // request is removing the profile, and leaving the slug unbacked is the error this check
    // exists to catch.
    const profileBacksEffectiveRuleSystem =
      customMechanicsProfileInput != null ||
      (customMechanicsProfileInput === undefined &&
        existing.customMechanicsProfile != null &&
        existing.customMechanicsProfile.slug === effectiveRuleSystem);
    await this.validateRuleSystem(input.ruleSystem, profileBacksEffectiveRuleSystem);
    let nextCustomMechanicsProfile: string | null | undefined;
    if (customMechanicsProfileInput !== undefined) {
      // Explicitly set (or cleared with null) in this request.
      this.validateCustomMechanicsProfile(effectiveRuleSystem, customMechanicsProfileInput);
      nextCustomMechanicsProfile = customMechanicsProfileInput ? JSON.stringify(customMechanicsProfileInput) : null;
    } else if (existing.customMechanicsProfile && existing.customMechanicsProfile.slug !== effectiveRuleSystem) {
      // ruleSystem changed away from the slug the stored profile belongs to, in this SAME
      // request, without this request also touching customMechanicsProfile. The stale profile
      // can never resolve again (ruleSystemAdapter only honors an exact slug match against the
      // CURRENT ruleSystem), so clear it rather than leave silently-orphaned data behind.
      nextCustomMechanicsProfile = null;
    } else {
      nextCustomMechanicsProfile = undefined; // leave the column untouched
    }
    const customMechanicsProfilePatch =
      nextCustomMechanicsProfile !== undefined ? { customMechanicsProfile: nextCustomMechanicsProfile } : {};
    await this.validateLocationRef(input.currentLocationId, id);
    await this.validateAttachmentRef(input.mapAttachmentId, id);
    // Assigning a map as the campaign background is an explicit, DM-only act of
    // sharing it with the whole party — the background renders for every member.
    // Attachments now default to DM-only (issue #97), so reveal the newly-wired
    // map here, otherwise players would 404 on the background image they're meant
    // to see. (Clearing the map to null doesn't re-hide — reveal is one-way here.)
    // Fog-protected encounter maps cannot be the region background: players load
    // RegionMap via /attachments/:id/file, which must stay a full-source URL.
    if (campaignInput.mapAttachmentId != null) {
      const fogRows = await this.db
        .select({ fog: encounters.fog })
        .from(encounters)
        .where(and(eq(encounters.mapAttachmentId, campaignInput.mapAttachmentId), eq(encounters.campaignId, id)));
      if (fogRows.some((row) => persistedFogConcealsPixels(row.fog))) {
        throw new ConflictException(
          'This attachment is protecting a fogged encounter map — use a separate image for the campaign region map, or disable fog first',
        );
      }
    }

    const archiving =
      existing.status === 'active' && input.status !== undefined && input.status !== 'active';

    // Atomic archive+revoke: status, invite suspension, and invite-row deletion
    // commit together so a failed archive never leaves invites permanently gone
    // while the campaign stays active (#857 Bugbot).
    if (archiving && opts?.revokeInvites) {
      const ts = nowIso();
      const { row, revoked, wasEnabled, pinsCleared } = this.db.transaction((tx) => {
        const before = tx
          .select({ publicInvitesEnabled: campaigns.publicInvitesEnabled })
          .from(campaigns)
          .where(eq(campaigns.id, id))
          .limit(1)
          .get();
        if (campaignInput.mapAttachmentId != null) {
          tx.update(attachments)
            .set({ hidden: false, updatedAt: ts })
            .where(
              and(
                eq(attachments.id, campaignInput.mapAttachmentId),
                eq(attachments.campaignId, id),
                eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
              ),
            )
            .run();
        }
        const row = tx
          .update(campaigns)
          .set({ ...campaignInput, ...customMechanicsProfilePatch, publicInvitesEnabled: false, updatedAt: ts })
          .where(eq(campaigns.id, id))
          .returning()
          .get();
        let pinsCleared = 0;
        if (shouldResetPins) {
          const reset = tx
            .update(locations)
            .set({ mapX: null, mapY: null, updatedAt: ts })
            .where(
              and(
                eq(locations.campaignId, id),
                notDeleted(locations.deletedAt),
                or(isNotNull(locations.mapX), isNotNull(locations.mapY)),
              ),
            )
            .run();
          pinsCleared = (reset as unknown as { changes?: number }).changes ?? 0;
        }
        const deleted = tx
          .delete(campaignInvites)
          .where(eq(campaignInvites.campaignId, id))
          .returning({ id: campaignInvites.id })
          .all();
        return {
          row,
          revoked: deleted.length,
          wasEnabled: Boolean(before?.publicInvitesEnabled),
          pinsCleared,
        };
      });
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'dm',
        action: 'campaign.update',
        entityType: 'campaign',
        entityId: id,
        campaignId: id,
        detail: shouldResetPins ? JSON.stringify({ mapAlignment: 'reset', pinsCleared }) : undefined,
      });
      if (wasEnabled) {
        await this.audit.log({
          actor: auditActor(user),
          actorRole: 'dm',
          action: 'invite.suspend',
          entityType: 'campaign',
          entityId: id,
          campaignId: id,
          detail: JSON.stringify({ reason: 'archive' }),
        });
      }
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'dm',
        action: 'invite.revoke_all',
        entityType: 'campaign',
        entityId: id,
        campaignId: id,
        detail: JSON.stringify({ revoked }),
      });
      return toDomain(row);
    }

    const ts = nowIso();

    // Issue #870: replacing/removing the world map can optionally reset every location
    // pin in the same transaction, so an unrelated image never inherits old coordinates.
    let updatedRow: typeof campaigns.$inferSelect | undefined;
    let pinsCleared = 0;
    if (shouldResetPins) {
      const resetResult = this.db.transaction((tx) => {
        if (campaignInput.mapAttachmentId != null) {
          tx.update(attachments)
            .set({ hidden: false, updatedAt: ts })
            .where(
              and(
                eq(attachments.id, campaignInput.mapAttachmentId),
                eq(attachments.campaignId, id),
                eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
              ),
            )
            .run();
        }
        const row = tx
          .update(campaigns)
          .set({ ...campaignInput, ...customMechanicsProfilePatch, updatedAt: ts })
          .where(eq(campaigns.id, id))
          .returning()
          .get();
        if (!row) throw new NotFoundException(`Campaign ${id} not found`);
        const reset = tx
          .update(locations)
          .set({ mapX: null, mapY: null, updatedAt: ts })
          .where(
            and(
              eq(locations.campaignId, id),
              notDeleted(locations.deletedAt),
              or(isNotNull(locations.mapX), isNotNull(locations.mapY)),
            ),
          )
          .run();
        return { row, changes: (reset as unknown as { changes?: number }).changes ?? 0 };
      });
      updatedRow = resetResult.row;
      pinsCleared = resetResult.changes;
    }

    if (updatedRow === undefined) {
      // Reveal the chosen map whenever a non-null id is supplied; attachments default
      // to DM-only (issue #97), and re-selecting the same hidden map must still make
      // it visible to players again (#870 review).
      if (campaignInput.mapAttachmentId != null) {
        await this.db
          .update(attachments)
          .set({ hidden: false, updatedAt: ts })
          .where(
            and(
              eq(attachments.id, campaignInput.mapAttachmentId),
              eq(attachments.campaignId, id),
              eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
            ),
          );
      }

      [updatedRow] = await this.db
        .update(campaigns)
        .set({ ...campaignInput, ...customMechanicsProfilePatch, updatedAt: ts })
        .where(eq(campaigns.id, id))
        .returning();
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'campaign.update',
      entityType: 'campaign',
      entityId: id,
      campaignId: id,
      detail: shouldResetPins ? JSON.stringify({ mapAlignment: 'reset', pinsCleared }) : undefined,
    });
    // Archive (active → paused/completed) suspends public invites. Restore/
    // unarchive never flips the flag back — deliberate reactivation required (#857).
    if (archiving) {
      await this.invites.suspendForCampaign(id, user, 'archive');
      const [fresh] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
      return toDomain(fresh ?? updatedRow);
    }
    return toDomain(updatedRow);
  }

  /**
   * Preview what a clone would copy (issue #435) — versioned manifest with per-
   * module counts, inclusions/exclusions for the requested mode, and warnings
   * (private notes omitted, dangling attachment bytes, template play-state strip).
   */
  async clonePreview(id: number, mode: CampaignCloneMode, user: RequestUser): Promise<CampaignClonePreview> {
    const template = mode === 'template';
    const source = await this.getOrThrow(id);

    const [
      locationRows,
      factionRows,
      npcRows,
      questRows,
      characterRows,
      sessionRows,
      noteRows,
      encounterRows,
      commentRows,
      storyArcRows,
      timelineEventRows,
      [timelineCalendarRow],
      [sessionZeroRow],
      inventoryRows,
      [treasuryRow],
      revisionRows,
    ] = await Promise.all([
      this.db.select().from(locations).where(and(eq(locations.campaignId, id), notDeleted(locations.deletedAt))),
      this.db.select().from(factions).where(and(eq(factions.campaignId, id), notDeleted(factions.deletedAt))),
      this.db.select().from(npcs).where(and(eq(npcs.campaignId, id), notDeleted(npcs.deletedAt))),
      this.db.select().from(quests).where(and(eq(quests.campaignId, id), notDeleted(quests.deletedAt))),
      this.db.select().from(characters).where(and(eq(characters.campaignId, id), notDeleted(characters.deletedAt))),
      this.db.select().from(sessions).where(and(eq(sessions.campaignId, id), notDeleted(sessions.deletedAt))),
      // notDeleted(quarantinedAt) on notes and comments (issue #601): a clone copies the
      // prose verbatim into a brand-new campaign that carries none of the reports
      // justifying the quarantine, and the copy loops do not carry the quarantine columns
      // either — so without this filter "clone the campaign" is a one-click way to launder
      // withheld abusive content back into readable form. Skipped rather than
      // copied-with-the-flag: the incident belongs to the original campaign, and a copy of
      // withheld content in an unrelated campaign is neither evidence nor wanted. Applied
      // to the preview query too, so the advertised counts match what a clone would copy.
      this.db
        .select()
        .from(notes)
        .where(and(eq(notes.campaignId, id), notDeleted(notes.deletedAt), notDeleted(notes.quarantinedAt))),
      this.db.select().from(encounters).where(and(eq(encounters.campaignId, id), notDeleted(encounters.deletedAt))),
      this.db.select().from(comments).where(and(eq(comments.campaignId, id), notDeleted(comments.quarantinedAt))),
      this.db.select().from(storyArcs).where(and(eq(storyArcs.campaignId, id), notDeleted(storyArcs.deletedAt))),
      this.db.select().from(timelineEvents).where(eq(timelineEvents.campaignId, id)),
      this.db.select().from(timelineCalendars).where(eq(timelineCalendars.campaignId, id)).limit(1),
      this.db.select().from(sessionZero).where(eq(sessionZero.campaignId, id)).limit(1),
      this.db.select().from(inventoryItems).where(and(eq(inventoryItems.campaignId, id), notDeleted(inventoryItems.deletedAt))),
      this.db.select().from(partyTreasury).where(eq(partyTreasury.campaignId, id)).limit(1),
      this.db.select().from(entityRevisions).where(eq(entityRevisions.campaignId, id)),
    ]);

    const arcIds = storyArcRows.map((r) => r.id);
    const beatRows = arcIds.length
      ? await this.db.select().from(storyBeats).where(inArray(storyBeats.arcId, arcIds))
      : [];
    const beatIds = beatRows.map((r) => r.id);
    const branchRows = beatIds.length
      ? await this.db.select().from(storyBranches).where(inArray(storyBranches.beatId, beatIds))
      : [];

    const questIds = questRows.map((r) => r.id);
    const objectiveCount = questIds.length
      ? (await this.db.select({ n: count() }).from(questObjectives).where(inArray(questObjectives.questId, questIds)))[0]?.n ?? 0
      : 0;

    const encounterIds = encounterRows.map((r) => r.id);
    const combatantCount = encounterIds.length
      ? (await this.db.select({ n: count() }).from(combatants).where(inArray(combatants.encounterId, encounterIds)))[0]?.n ?? 0
      : 0;

    const privateNoteCount = noteRows.filter(
      (n) => n.visibility === 'private' && n.authorUserId !== user.id,
    ).length;
    const cloneableNoteCount = noteRows.length - privateNoteCount;

    const attachmentIds = new Set<number>();
    if (source.mapAttachmentId != null) attachmentIds.add(source.mapAttachmentId);
    if (!template) {
      for (const c of characterRows) {
        const aid = c.portraitUrl ? historicalAvatarAttachmentId(c.portraitUrl) : null;
        if (aid != null) attachmentIds.add(aid);
      }
      for (const n of npcRows) {
        const aid = n.portraitUrl ? historicalAvatarAttachmentId(n.portraitUrl) : null;
        if (aid != null) attachmentIds.add(aid);
      }
      for (const c of commentRows) {
        const aid = c.characterAvatarUrl ? historicalAvatarAttachmentId(c.characterAvatarUrl) : null;
        if (aid != null) attachmentIds.add(aid);
      }
      for (const e of encounterRows) {
        if (e.mapAttachmentId != null) attachmentIds.add(e.mapAttachmentId);
      }
      for (const f of factionRows) {
        const aid = f.portraitUrl ? historicalAvatarAttachmentId(f.portraitUrl) : null;
        if (aid != null) attachmentIds.add(aid);
      }
      for (const l of locationRows) {
        const aid = l.portraitUrl ? historicalAvatarAttachmentId(l.portraitUrl) : null;
        if (aid != null) attachmentIds.add(aid);
      }
    }
    const attachmentRows = attachmentIds.size
      ? await this.db
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.campaignId, id),
              inArray(attachments.id, [...attachmentIds]),
              eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
            ),
          )
      : [];

    const treasuryHasCoins = treasuryRow
      ? treasuryRow.cp > 0 || treasuryRow.sp > 0 || treasuryRow.ep > 0 || treasuryRow.gp > 0 || treasuryRow.pp > 0
      : false;
    const sessionZeroPresent = sessionZeroRow
      ? (() => {
          try {
            const lines = JSON.parse(sessionZeroRow.lines) as unknown;
            const veils = JSON.parse(sessionZeroRow.veils) as unknown;
            const tools = JSON.parse(sessionZeroRow.safetyTools) as unknown;
            return (
              (Array.isArray(lines) && lines.length > 0) ||
              (Array.isArray(veils) && veils.length > 0) ||
              (Array.isArray(tools) && tools.length > 0) ||
              Boolean(sessionZeroRow.houseRules) ||
              Boolean(sessionZeroRow.toneAndExpectations)
            );
          } catch {
            return Boolean(sessionZeroRow.houseRules) || Boolean(sessionZeroRow.toneAndExpectations);
          }
        })()
      : false;
    const timelineCalendarPresent = timelineCalendarRow
      ? Boolean(timelineCalendarRow.currentDate) || Boolean(timelineCalendarRow.note)
      : false;

    const mapAttachmentRows = attachmentRows.filter((a) => a.kind === 'map');
    const portraitAttachmentRows = attachmentRows.filter((a) => a.kind === 'portrait');

    const counts: Record<string, number> = {
      locations: locationRows.length,
      factions: factionRows.length,
      npcs: npcRows.length,
      quests: questRows.length,
      questObjectives: objectiveCount,
      storyArcs: storyArcRows.length,
      storyBeats: beatRows.length,
      storyBranches: branchRows.length,
      timelineEvents: timelineEventRows.length,
      timelineCalendar: timelineCalendarPresent ? 1 : 0,
      sessionZero: sessionZeroPresent ? 1 : 0,
      characters: characterRows.length,
      sessions: sessionRows.length,
      notes: noteRows.length,
      notesCloneable: cloneableNoteCount,
      comments: commentRows.length,
      encounters: encounterRows.length,
      combatants: combatantCount,
      inventory: inventoryRows.length,
      treasury: treasuryHasCoins ? 1 : 0,
      revisions: revisionRows.length,
      attachments: attachmentRows.length,
      mapAttachments: mapAttachmentRows.length,
    };

    const prepInclusion = (count: number, note?: string) => ({
      included: true,
      count,
      ...(note ? { note } : {}),
    });
    const playInclusion = (count: number, note?: string) =>
      template ? { included: false, count: 0, note: note ?? 'Omitted in template mode (play state reset).' } : { included: true, count, ...(note ? { note } : {}) };

    const inclusions: CampaignClonePreview['inclusions'] = {
      locations: prepInclusion(locationRows.length, template ? 'Statuses reset to unexplored.' : undefined),
      factions: prepInclusion(factionRows.length),
      npcs: prepInclusion(npcRows.length),
      quests: prepInclusion(questRows.length, template ? 'Statuses reset to available; objectives unchecked.' : undefined),
      questObjectives: prepInclusion(objectiveCount, template ? 'Copied unchecked.' : undefined),
      storyArcs: prepInclusion(storyArcRows.length),
      storyBeats: prepInclusion(
        beatRows.length,
        template ? 'Play links (session/quest/encounter) are not carried over.' : undefined,
      ),
      storyBranches: prepInclusion(branchRows.length),
      timelineEvents: prepInclusion(timelineEventRows.length),
      timelineCalendar: prepInclusion(timelineCalendarPresent ? 1 : 0),
      sessionZero: prepInclusion(sessionZeroPresent ? 1 : 0),
      characters: playInclusion(characterRows.length),
      sessions: playInclusion(sessionRows.length),
      notes: playInclusion(cloneableNoteCount, 'Other members\' private notes are never copied.'),
      comments: playInclusion(commentRows.length),
      encounters: playInclusion(encounterRows.length, 'Combat state resets to preparing with full HP.'),
      combatants: playInclusion(combatantCount),
      inventory: playInclusion(inventoryRows.length),
      treasury: playInclusion(treasuryHasCoins ? 1 : 0),
      revisions: playInclusion(revisionRows.length, 'Prose history for copied entities only; dangling links drop.'),
      mapAttachments: {
        included: mapAttachmentRows.length > 0,
        count: mapAttachmentRows.length,
        note: 'Campaign and encounter map bytes are copied when present on disk.',
      },
      portraitAttachments: playInclusion(
        portraitAttachmentRows.length,
        'Portrait bytes copy in full mode only.',
      ),
    };

    const exclusions: CampaignClonePreview['exclusions'] = [
      { module: 'members', reason: 'Only the cloning DM becomes a member of the new campaign.' },
      { module: 'audit', reason: 'Audit history is install-specific and never duplicated.' },
      { module: 'proposals', reason: 'Pending proposals are not copied.' },
      { module: 'apiTokens', reason: 'API tokens are not copied.' },
      { module: 'participantSupportPreferences', reason: 'Participant-owned support preferences are never cloned (issue #877).' },
      { module: 'sessionShares', reason: 'Session capability links and RSVP scheduling are not copied.' },
      { module: 'diceRolls', reason: 'Shared dice log entries are not copied.' },
    ];

    const warnings: CampaignClonePreview['warnings'] = [];
    if (privateNoteCount > 0) {
      warnings.push({
        code: 'private_notes_excluded',
        message: `${privateNoteCount} private note(s) from other members will not be copied (invisible to the cloning DM).`,
      });
    }
    for (const a of attachmentRows) {
      const onDisk = fs.existsSync(attachmentUploadPath(id, a.id, a.mime));
      if (!onDisk) {
        warnings.push({
          code: 'attachment_bytes_missing',
          message: `Attachment #${a.id} (${a.kind}: ${a.filename}) is missing on disk — the clone will keep the row but GET may 404 until re-uploaded.`,
        });
      }
    }
    if (template) {
      warnings.push({
        code: 'template_play_state_reset',
        message: 'Template mode copies world prep only and strips sessions, characters, encounters, inventory, treasury, notes, comments, and revisions.',
      });
    }

    return {
      app: 'campfire',
      kind: 'campaign-clone-preview',
      formatVersion: CAMPAIGN_CLONE_PREVIEW_FORMAT_VERSION,
      appVersion: APP_VERSION,
      schemaVersion: CURRENT_SCHEMA_REVISION,
      campaignId: id,
      mode,
      createdAt: nowIso(),
      counts,
      inclusions,
      exclusions,
      warnings,
    };
  }

  /**
   * Clone a campaign into a brand-new one owned by the caller (issue #17 —
   * campaign templates / cloning). Two modes:
   *
   *  - 'full' (default): faithful duplicate — quests (+objectives), npcs,
   *    locations, factions, characters, sessions, notes, encounters
   *    (+combatants), and discussion threads, with every intra-campaign
   *    reference remapped to the cloned rows' new ids. Encounter runtime
   *    combat state resets to a fresh 'preparing' fight (issue #548).
   *  - 'template': prep only — play state stripped; storylines/timeline/
   *    session-zero charter still copy.
   *
   * See clonePreview() for the versioned manifest of counts and warnings (#435).
   */
  async clone(id: number, input: CampaignCloneInput, user: RequestUser): Promise<Campaign> {
    const source = await this.getOrThrow(id);
    const template = input.mode === 'template';
    const name = (input.name ?? `${source.name} (copy)`).slice(0, 120);

    // Read everything up front — only the writes need the transaction. Trashed
    // (soft-deleted, #116) entities are excluded so a clone never resurrects them.
    const [
      locationRows,
      factionRows,
      npcRows,
      questRows,
      characterRows,
      sessionRows,
      noteRows,
      encounterRows,
      commentRows,
      storyArcRows,
      timelineEventRows,
      [timelineCalendarRow],
      [sessionZeroRow],
      inventoryRows,
      [treasuryRow],
      revisionRows,
    ] = await Promise.all([
      this.db.select().from(locations).where(and(eq(locations.campaignId, id), notDeleted(locations.deletedAt))),
      this.db.select().from(factions).where(and(eq(factions.campaignId, id), notDeleted(factions.deletedAt))),
      this.db.select().from(npcs).where(and(eq(npcs.campaignId, id), notDeleted(npcs.deletedAt))),
      this.db.select().from(quests).where(and(eq(quests.campaignId, id), notDeleted(quests.deletedAt))),
      this.db.select().from(characters).where(and(eq(characters.campaignId, id), notDeleted(characters.deletedAt))),
      this.db.select().from(sessions).where(and(eq(sessions.campaignId, id), notDeleted(sessions.deletedAt))),
      // notDeleted(quarantinedAt) on notes and comments (issue #601): a clone copies the
      // prose verbatim into a brand-new campaign that carries none of the reports
      // justifying the quarantine, and the copy loops do not carry the quarantine columns
      // either — so without this filter "clone the campaign" is a one-click way to launder
      // withheld abusive content back into readable form. Skipped rather than
      // copied-with-the-flag: the incident belongs to the original campaign, and a copy of
      // withheld content in an unrelated campaign is neither evidence nor wanted. Applied
      // to the preview query too, so the advertised counts match what a clone would copy.
      this.db
        .select()
        .from(notes)
        .where(and(eq(notes.campaignId, id), notDeleted(notes.deletedAt), notDeleted(notes.quarantinedAt))),
      this.db.select().from(encounters).where(and(eq(encounters.campaignId, id), notDeleted(encounters.deletedAt))),
      this.db.select().from(comments).where(and(eq(comments.campaignId, id), notDeleted(comments.quarantinedAt))),
      this.db.select().from(storyArcs).where(and(eq(storyArcs.campaignId, id), notDeleted(storyArcs.deletedAt))),
      this.db.select().from(timelineEvents).where(eq(timelineEvents.campaignId, id)),
      this.db.select().from(timelineCalendars).where(eq(timelineCalendars.campaignId, id)).limit(1),
      this.db.select().from(sessionZero).where(eq(sessionZero.campaignId, id)).limit(1),
      this.db.select().from(inventoryItems).where(and(eq(inventoryItems.campaignId, id), notDeleted(inventoryItems.deletedAt))),
      this.db.select().from(partyTreasury).where(eq(partyTreasury.campaignId, id)).limit(1),
      this.db.select().from(entityRevisions).where(eq(entityRevisions.campaignId, id)),
    ]);
    const arcIds = storyArcRows.map((r) => r.id);
    const beatRows = arcIds.length
      ? await this.db.select().from(storyBeats).where(inArray(storyBeats.arcId, arcIds))
      : [];
    const beatIds = beatRows.map((r) => r.id);
    const branchRows = beatIds.length
      ? await this.db.select().from(storyBranches).where(inArray(storyBranches.beatId, beatIds))
      : [];
    const questIds = questRows.map((r) => r.id);
    const objectiveRows = questIds.length
      ? await this.db.select().from(questObjectives).where(inArray(questObjectives.questId, questIds))
      : [];
    const encounterIds = encounterRows.map((r) => r.id);
    const combatantRows = encounterIds.length
      ? await this.db.select().from(combatants).where(inArray(combatants.encounterId, encounterIds))
      : [];

    // AI seat + scribe config (issue #1078): read up front with the other bulk reads.
    const [[aiSeatRow], [aiScribeConfigRow]] = await Promise.all([
      this.db.select().from(aiDmSeats).where(eq(aiDmSeats.campaignId, id)).limit(1),
      this.db.select().from(aiScribeConfigs).where(eq(aiScribeConfigs.campaignId, id)).limit(1),
    ]);

    // Issue #524/#435: portrait and map attachments referenced by characters,
    // comment avatar snapshots, the campaign map, and encounter maps are copied
    // into the clone — collect their rows now so the tx can insert remapped
    // attachment rows before entity inserts that point at them.
    const attachmentSrcIds = new Set<number>();
    if (source.mapAttachmentId != null) attachmentSrcIds.add(source.mapAttachmentId);
    if (!template) {
      for (const c of characterRows) {
        const aid = c.portraitUrl ? historicalAvatarAttachmentId(c.portraitUrl) : null;
        if (aid != null) attachmentSrcIds.add(aid);
      }
      for (const n of npcRows) {
        const aid = n.portraitUrl ? historicalAvatarAttachmentId(n.portraitUrl) : null;
        if (aid != null) attachmentSrcIds.add(aid);
      }
      for (const c of commentRows) {
        const aid = c.characterAvatarUrl ? historicalAvatarAttachmentId(c.characterAvatarUrl) : null;
        if (aid != null) attachmentSrcIds.add(aid);
      }
      for (const e of encounterRows) {
        if (e.mapAttachmentId != null) attachmentSrcIds.add(e.mapAttachmentId);
      }
      for (const f of factionRows) {
        const aid = f.portraitUrl ? historicalAvatarAttachmentId(f.portraitUrl) : null;
        if (aid != null) attachmentSrcIds.add(aid);
      }
      for (const l of locationRows) {
        const aid = l.portraitUrl ? historicalAvatarAttachmentId(l.portraitUrl) : null;
        if (aid != null) attachmentSrcIds.add(aid);
      }
    }
    const attachmentAttRows = attachmentSrcIds.size
      ? await this.db
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.campaignId, id),
              inArray(attachments.id, [...attachmentSrcIds]),
              eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
            ),
          )
      : [];

    const ts = nowIso();
    /** Attachment byte copies deferred until after the DB tx commits (#524 / #725 shape). */
    const pendingAttachmentCopies: {
      srcCampaignId: number;
      dstCampaignId: number;
      srcAttachmentId: number;
      dstAttachmentId: number;
      mime: string;
    }[] = [];
    const newId = this.db.transaction((tx) => {
      const [campaignRow] = tx
        .insert(campaigns)
        .values({
          name,
          description: source.description,
          status: 'active',
          currentLocationId: null, // remapped below (full mode only)
          dangerLevel: source.dangerLevel,
          dmControlsProgression: source.dmControlsProgression,
          dmControlsTurns: source.dmControlsTurns,
          requireDmTurnConfirmation: source.requireDmTurnConfirmation,
          publicRecapSharingEnabled: source.publicRecapSharingEnabled,
          publicInvitesEnabled: source.publicInvitesEnabled,
          narrationLanguage: source.narrationLanguage ?? 'en',
          aiExternalContentPolicy: source.aiExternalContentPolicy ?? 'member_consent',
          sessionCount: template ? 0 : source.sessionCount,
          latestSessionNumber: template ? 0 : source.latestSessionNumber,
          ruleSystem: source.ruleSystem,
          // Issue #1502: carry the paired homebrew mechanics profile with its ruleSystem slug —
          // otherwise a clone of a homebrew campaign would silently resolve to the 5e adapter
          // fallback (no ADAPTERS entry for the slug, no profile to pair it with).
          customMechanicsProfile: source.customMechanicsProfile ? JSON.stringify(source.customMechanicsProfile) : null,
          mapAttachmentId: null, // remapped below once attachment rows exist (#435)
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const cloneId = campaignRow.id;

      // Locations first — npcs, quests-via-npcs and currentLocationId all point at them.
      // Two passes like quests below: insert all (parentId deferred), then remap the
      // nesting parentId (#99) — a child's parent may appear after it in insert order.
      const locMap = new Map<number, number>();
      for (const l of locationRows) {
        const [row] = tx
          .insert(locations)
          .values({
            campaignId: cloneId,
            parentId: null,
            name: l.name,
            kind: l.kind,
            status: template ? 'unexplored' : l.status,
            mapX: l.mapX,
            mapY: l.mapY,
            body: l.body,
            dmSecret: l.dmSecret,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        locMap.set(l.id, row.id);
      }
      for (const l of locationRows) {
        if (l.parentId == null) continue;
        const parentId = locMap.get(l.parentId);
        if (parentId != null) {
          tx.update(locations).set({ parentId }).where(eq(locations.id, locMap.get(l.id)!)).run();
        }
      }

      // Factions before npcs — an npc's factionId points at one, and comment/note
      // anchors on factions need the remapped ids available for full-clone copy.
      const factionMap = new Map<number, number>();
      for (const f of factionRows) {
        const [row] = tx
          .insert(factions)
          .values({
            campaignId: cloneId,
            name: f.name,
            kind: f.kind,
            body: f.body,
            goals: f.goals,
            dmSecret: f.dmSecret,
            hidden: f.hidden,
            reputation: f.reputation,
            standing: f.standing,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        factionMap.set(f.id, row.id);
      }

      // Issue #524/#435: recreate attachment rows (portraits + maps) under the clone.
      // Bytes publish after the tx commits via copyAttachmentBytes. Done before npcs
      // and characters so their portraitUrl refs can be remapped to the fresh ids.
      const attMap = new Map<number, number>();
      for (const a of attachmentAttRows) {
        const [row] = tx
          .insert(attachments)
          .values({
            campaignId: cloneId,
            uploaderUserId: a.uploaderUserId,
            kind: a.kind,
            filename: a.filename,
            mime: a.mime,
            size: a.size,
            title: a.title,
            caption: a.caption,
            altText: a.altText,
            creator: a.creator,
            sourceUrl: a.sourceUrl,
            license: a.license,
            rights: a.rights,
            attribution: a.attribution,
            checksumSha256: a.checksumSha256,
            hidden: a.hidden,
            state: ATTACHMENT_STATE_COMMITTED,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        attMap.set(a.id, row.id);
        pendingAttachmentCopies.push({
          srcCampaignId: id,
          dstCampaignId: cloneId,
          srcAttachmentId: a.id,
          dstAttachmentId: row.id,
          mime: a.mime,
        });
      }
      /** Attachment URL → remapped clone URL; keep safe non-attachment (HTTPS) portraits. */
      const remapClonedPortraitUrl = (url: string | null): string | null => {
        if (url == null) return null;
        const remapped = remapAttachmentFileUrl(url, attMap);
        if (remapped != null) return remapped;
        if (historicalAvatarAttachmentId(url) != null) return null;
        return url;
      };
      const remapClonedHistoricalAvatarUrl = (url: unknown): string | null => {
        const safe = safeHistoricalAvatarUrl(url);
        if (!safe) return null;
        const remapped = remapAttachmentFileUrl(safe, attMap);
        if (remapped != null) return remapped;
        if (historicalAvatarAttachmentId(safe) != null) return null;
        return safe;
      };

      // Factions and locations were inserted before attachment rows so that npcs could
      // remap through them; now that attMap exists, patch their portrait URLs (#1324).
      for (const f of factionRows) {
        const newId = factionMap.get(f.id);
        if (newId != null) {
          tx.update(factions)
            .set({ portraitUrl: remapClonedPortraitUrl(f.portraitUrl) })
            .where(eq(factions.id, newId))
            .run();
        }
      }
      for (const l of locationRows) {
        const newId = locMap.get(l.id);
        if (newId != null) {
          tx.update(locations)
            .set({ portraitUrl: remapClonedPortraitUrl(l.portraitUrl) })
            .where(eq(locations.id, newId))
            .run();
        }
      }

      const npcMap = new Map<number, number>();
      for (const n of npcRows) {
        const [row] = tx
          .insert(npcs)
          .values({
            campaignId: cloneId,
            name: n.name,
            role: n.role,
            disposition: n.disposition,
            locationId: n.locationId != null ? (locMap.get(n.locationId) ?? null) : null,
            factionId: n.factionId != null ? (factionMap.get(n.factionId) ?? null) : null,
            body: n.body,
            dmSecret: n.dmSecret,
            portraitUrl: remapClonedPortraitUrl(n.portraitUrl),
            hidden: n.hidden, // entity-level secrecy (issue #42) is preserved on clone
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        npcMap.set(n.id, row.id);
      }

      // Quests in two passes: insert all (parentId deferred), then remap
      // parentId — a subquest's parent may appear after it in insert order.
      const questMap = new Map<number, number>();
      for (const q of questRows) {
        const [row] = tx
          .insert(quests)
          .values({
            campaignId: cloneId,
            parentId: null,
            title: q.title,
            body: q.body,
            status: template ? 'available' : q.status,
            giverNpcId: q.giverNpcId != null ? (npcMap.get(q.giverNpcId) ?? null) : null,
            reward: q.reward,
            dmSecret: q.dmSecret,
            hidden: q.hidden, // entity-level secrecy (issue #42) is preserved on clone
            sortOrder: q.sortOrder,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        questMap.set(q.id, row.id);
      }
      for (const q of questRows) {
        if (q.parentId == null) continue;
        const parentId = questMap.get(q.parentId);
        if (parentId != null) {
          tx.update(quests).set({ parentId }).where(eq(quests.id, questMap.get(q.id)!)).run();
        }
      }
      for (const o of objectiveRows) {
        const questId = questMap.get(o.questId);
        if (questId == null) continue;
        tx.insert(questObjectives)
          .values({ questId, text: o.text, done: template ? false : o.done, sortOrder: o.sortOrder })
          .run();
      }

      const charMap = new Map<number, number>();
      const sessionMap = new Map<number, number>();
      const encounterMap = new Map<number, number>();
      const noteMap = new Map<number, number>();
      const commentMap = new Map<number, number>();
      const timelineEventMap = new Map<number, number>();
      const beatMap = new Map<number, number>();

      if (!template) {
        for (const c of characterRows) {
          const {
            id: _srcId,
            campaignId: _srcCampaignId,
            createdAt: _createdAt,
            updatedAt: _updatedAt,
            deletedAt: _deletedAt,
            portraitUrl: srcPortraitUrl,
            ...characterFields
          } = c;
          const [row] = tx
            .insert(characters)
            .values({
              ...characterFields,
              campaignId: cloneId,
              portraitUrl: remapClonedPortraitUrl(srcPortraitUrl),
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          charMap.set(c.id, row.id);
        }

        for (const s of sessionRows) {
          const [row] = tx
            .insert(sessions)
            .values({
              campaignId: cloneId,
              number: s.number,
              title: s.title,
              playedAt: s.playedAt,
              recap: s.recap,
              dmSecret: s.dmSecret,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          sessionMap.set(s.id, row.id);
        }

        for (const item of inventoryRows) {
          const ownerType = item.ownerType === 'character' ? 'character' : 'party';
          const mappedChar = item.characterId != null ? (charMap.get(item.characterId) ?? null) : null;
          const resolvedOwner = ownerType === 'character' && mappedChar != null ? 'character' : 'party';
          // Issue #1326 review (Codex/Devin/coordinator): a character-owned item's FULL
          // equip triple carries over 1:1 to its cloned character (slot conflicts can't
          // arise — every clone maps at most one source character to one destination
          // character, so relative slot assignments stay unique). An item that falls back
          // to the party stash (its character wasn't cloned/mapped) lands unequipped AND
          // clears its equippedAction too — not just equipped/equipSlot. A half-clear
          // (unequipped but still carrying a granted action) is a state normal play can
          // never produce: the item would silently arm whoever equips it in the new
          // campaign with an attack nobody there authored. Landing the fallback item fully
          // clean means claiming and equipping it in the new campaign is a deliberate act
          // that grants only what the NEW campaign's players/DM choose to attach.
          tx.insert(inventoryItems)
            .values({
              campaignId: cloneId,
              ownerType: resolvedOwner,
              characterId: resolvedOwner === 'character' ? mappedChar : null,
              name: item.name,
              qty: item.qty,
              notes: item.notes,
              iconSlug: item.iconSlug,
              ruleEntryId: item.ruleEntryId,
              compendiumRef: item.compendiumRef,
              compendiumSnapshot: item.compendiumSnapshot,
              compendiumState: item.compendiumState,
              equipped: resolvedOwner === 'character' && item.equipped,
              equipSlot: resolvedOwner === 'character' ? item.equipSlot : null,
              equippedAction: resolvedOwner === 'character' ? item.equippedAction : null,
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
        }

        if (treasuryRow) {
          const treasuryCoins = {
            cp: treasuryRow.cp,
            sp: treasuryRow.sp,
            ep: treasuryRow.ep,
            gp: treasuryRow.gp,
            pp: treasuryRow.pp,
          };
          if (treasuryCoins.cp || treasuryCoins.sp || treasuryCoins.ep || treasuryCoins.gp || treasuryCoins.pp) {
            tx.insert(partyTreasury).values({ campaignId: cloneId, ...treasuryCoins, updatedAt: ts }).run();
          }
        }

        for (const e of encounterRows) {
          const [row] = tx
            .insert(encounters)
            .values({
              campaignId: cloneId,
              name: e.name,
              status: 'preparing',
              round: 0,
              turnIndex: 0,
              currentCombatantId: null,
              locationId: e.locationId != null ? (locMap.get(e.locationId) ?? null) : null,
              questId: e.questId != null ? (questMap.get(e.questId) ?? null) : null,
              sessionId: e.sessionId != null ? (sessionMap.get(e.sessionId) ?? null) : null,
              mapAttachmentId:
                e.mapAttachmentId != null ? (attMap.get(e.mapAttachmentId) ?? null) : null,
              gridSize: e.gridSize,
              gridScale: e.gridScale,
              gridUnit: e.gridUnit,
              gridSnap: e.gridSnap,
              gridType: e.gridType,
              hexOrientation: e.hexOrientation,
              aoe: e.aoe,
              gridOffsetX: e.gridOffsetX,
              gridOffsetY: e.gridOffsetY,
              gridCellHeight: e.gridCellHeight,
              gridRotation: e.gridRotation,
              gridOpacity: e.gridOpacity,
              fog: e.fog,
              hidden: e.hidden,
              endedAt: null,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          encounterMap.set(e.id, row.id);
          for (const c of combatantRows) {
            if (c.encounterId !== e.id) continue;
            const mappedCharacterId = c.characterId != null ? (charMap.get(c.characterId) ?? null) : null;
            tx.insert(combatants)
              .values({
                encounterId: row.id,
                kind: c.kind,
                characterId: mappedCharacterId,
                npcId: c.npcId != null ? (npcMap.get(c.npcId) ?? null) : null,
                npcIdentitySourceId: c.npcIdentitySourceId != null ? (npcMap.get(c.npcIdentitySourceId) ?? null) : null,
                // Clones reset encounters to fresh prep, so they must derive NPC
                // allegiance from the cloned NPC rather than retain played history.
                npcDispositionSnapshot: null,
                name: c.name,
                initiative: null,
                initMod: c.initMod,
                hpCurrent: c.hpMax,
                hpMax: c.hpMax,
                conditions: '[]',
                ruleEntryId: c.ruleEntryId,
                sortOrder: c.sortOrder,
                sheetSyncedUpdatedAt: mappedCharacterId != null ? ts : null,
                // Issue #1910 review (Codex, round 5): a baseline stat snapshot like
                // initMod above, not combat state — carry it forward the same way,
                // rather than silently resetting it like the play-progress fields
                // (hp/initiative/conditions) this insert deliberately does reset.
                speed: c.speed,
              })
              .run();
          }
        }

        const entityMaps: Record<string, Map<number, number>> = {
          quest: questMap,
          npc: npcMap,
          faction: factionMap,
          location: locMap,
          character: charMap,
          session: sessionMap,
          encounter: encounterMap,
        };
        for (const n of noteRows) {
          if (n.visibility === 'private' && n.authorUserId !== user.id) continue;
          let entityType = n.entityType;
          let entityId: number | null = null;
          if (n.entityType === 'campaign') {
            entityId = cloneId;
          } else if (n.entityType != null && n.entityId != null) {
            entityId = entityMaps[n.entityType]?.get(n.entityId) ?? null;
            if (entityId == null) entityType = null;
          }
          const [noteRow] = tx
            .insert(notes)
            .values({
              campaignId: cloneId,
              authorUserId: n.authorUserId,
              authorName: n.authorName,
              authorImported: n.authorImported,
              kind: n.kind,
              visibility: n.visibility,
              entityType,
              entityId,
              body: n.body,
              resolved: n.resolved,
              resolvedNote: n.resolvedNote,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          noteMap.set(n.id, noteRow.id);
        }

        const commentEntityMaps: Record<string, Map<number, number>> = {
          quest: questMap,
          npc: npcMap,
          faction: factionMap,
          location: locMap,
          character: charMap,
          session: sessionMap,
          encounter: encounterMap,
        };
        const insertClonedComment = (c: (typeof commentRows)[number], parentId: number | null) => {
          const entityId = c.entityType === 'campaign'
            ? cloneId
            : commentEntityMaps[c.entityType]?.get(c.entityId);
          if (entityId == null) return;
          const [row] = tx
            .insert(comments)
            .values({
              campaignId: cloneId,
              entityType: c.entityType,
              entityId,
              parentId,
              authorUserId: c.authorUserId,
              authorName: c.authorName,
              authorImported: c.authorImported,
              body: c.body,
              inCharacter: c.inCharacter,
              characterId: c.characterId != null ? (charMap.get(c.characterId) ?? null) : null,
              characterName: c.characterName,
              characterAvatarUrl: remapClonedHistoricalAvatarUrl(c.characterAvatarUrl),
              deletedAt: c.deletedAt,
              deletedBy: c.deletedBy,
              editedAt: c.editedAt,
              editedBy: c.editedBy,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
            })
            .returning()
            .all();
          commentMap.set(c.id, row.id);
        };
        for (const c of commentRows) {
          if (c.parentId == null) insertClonedComment(c, null);
        }
        for (const c of commentRows) {
          if (c.parentId == null) continue;
          insertClonedComment(c, commentMap.get(c.parentId) ?? null);
        }

        if (source.currentLocationId != null) {
          const currentLocationId = locMap.get(source.currentLocationId);
          if (currentLocationId != null) {
            tx.update(campaigns).set({ currentLocationId }).where(eq(campaigns.id, cloneId)).run();
          }
        }
      }

      // Storylines (issue #27/#435): arcs → beats → branches in both modes.
      const arcMap = new Map<number, number>();
      for (const arc of storyArcRows) {
        const [row] = tx
          .insert(storyArcs)
          .values({
            campaignId: cloneId,
            title: arc.title,
            summary: arc.summary,
            status: arc.status,
            sortOrder: arc.sortOrder,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        arcMap.set(arc.id, row.id);
      }
      const beatsByArc = new Map<number, typeof beatRows>();
      for (const beat of beatRows) {
        const list = beatsByArc.get(beat.arcId);
        if (list) list.push(beat);
        else beatsByArc.set(beat.arcId, [beat]);
      }
      for (const arc of storyArcRows) {
        const newArcId = arcMap.get(arc.id);
        if (newArcId == null) continue;
        for (const beat of beatsByArc.get(arc.id) ?? []) {
          const [row] = tx
            .insert(storyBeats)
            .values({
              campaignId: cloneId,
              arcId: newArcId,
              title: beat.title,
              body: beat.body,
              status: beat.status,
              sortOrder: beat.sortOrder,
              sessionId:
                !template && beat.sessionId != null ? (sessionMap.get(beat.sessionId) ?? null) : null,
              questId: !template && beat.questId != null ? (questMap.get(beat.questId) ?? null) : null,
              encounterId:
                !template && beat.encounterId != null ? (encounterMap.get(beat.encounterId) ?? null) : null,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          beatMap.set(beat.id, row.id);
        }
      }
      for (const branch of branchRows) {
        const fromBeatId = beatMap.get(branch.beatId);
        if (fromBeatId == null) continue;
        tx.insert(storyBranches)
          .values({
            beatId: fromBeatId,
            toBeatId: branch.toBeatId != null ? (beatMap.get(branch.toBeatId) ?? null) : null,
            label: branch.label,
            sortOrder: branch.sortOrder,
          })
          .run();
      }

      for (const ev of timelineEventRows) {
        const [row] = tx
          .insert(timelineEvents)
          .values({
            campaignId: cloneId,
            title: ev.title,
            inWorldDate: ev.inWorldDate,
            body: ev.body,
            era: ev.era,
            sortIndex: ev.sortIndex,
            dmSecret: ev.dmSecret,
            hidden: ev.hidden,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        timelineEventMap.set(ev.id, row.id);
      }

      if (timelineCalendarRow) {
        const calendarDate = timelineCalendarRow.currentDate;
        const calendarNote = timelineCalendarRow.note;
        if (calendarDate || calendarNote) {
          tx.insert(timelineCalendars)
            .values({
              campaignId: cloneId,
              currentDate: calendarDate,
              note: calendarNote,
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
        }
      }

      if (sessionZeroRow) {
        tx.insert(sessionZero)
          .values({
            campaignId: cloneId,
            lines: sessionZeroRow.lines,
            veils: sessionZeroRow.veils,
            safetyTools: sessionZeroRow.safetyTools,
            houseRules: sessionZeroRow.houseRules,
            toneAndExpectations: sessionZeroRow.toneAndExpectations,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      if (!template) {
        const revisionEntityMaps: Record<string, Map<number, number>> = {
          session: sessionMap,
          quest: questMap,
          npc: npcMap,
          location: locMap,
          faction: factionMap,
          note: noteMap,
          timeline_event: timelineEventMap,
          story_beat: beatMap,
          comment: commentMap,
        };
        const campaignScopedRevision = new Map<number, number>([[id, cloneId]]);
        const revisionIdMap = new Map<number, number>();
        const revisionSourceKinds = new Set(['human', 'ai', 'tool']);
        const revisionSource = (value: string): 'human' | 'ai' | 'tool' =>
          revisionSourceKinds.has(value) ? (value as 'human' | 'ai' | 'tool') : 'human';
        const resolveRevisionEntityId = (entityType: string, sourceEntityId: number): number | undefined => {
          if (entityType === 'timeline_calendar' || entityType === 'session_zero') {
            return campaignScopedRevision.get(sourceEntityId);
          }
          return revisionEntityMaps[entityType]?.get(sourceEntityId);
        };
        for (const rev of revisionRows) {
          const entityId = resolveRevisionEntityId(rev.entityType, rev.entityId);
          if (entityId == null) continue;
          const [row] = tx
            .insert(entityRevisions)
            .values({
              campaignId: cloneId,
              entityType: rev.entityType,
              entityId,
              snapshot: rev.snapshot,
              authorUserId: rev.authorUserId,
              authorName: rev.authorName,
              authorImported: rev.authorImported,
              authorSource: revisionSource(rev.authorSource),
              authorSourceDetail: rev.authorSourceDetail,
              createdAt: rev.createdAt,
              replacedByUserId: rev.replacedByUserId,
              replacedByName: rev.replacedByName,
              replacedByImported: rev.replacedByImported,
              replacedBySource: revisionSource(rev.replacedBySource),
              replacedBySourceDetail: rev.replacedBySourceDetail,
              replacedAt: rev.replacedAt,
              restoredFromRevisionId: null,
              authorshipKnown: rev.authorshipKnown,
            })
            .returning()
            .all();
          revisionIdMap.set(rev.id, row.id);
        }
        for (const rev of revisionRows) {
          const newRevisionId = revisionIdMap.get(rev.id);
          if (newRevisionId == null || rev.restoredFromRevisionId == null) continue;
          const remapped = revisionIdMap.get(rev.restoredFromRevisionId);
          if (remapped == null) continue;
          tx.update(entityRevisions)
            .set({ restoredFromRevisionId: remapped })
            .where(eq(entityRevisions.id, newRevisionId))
            .run();
        }
      }

      if (source.mapAttachmentId != null) {
        const mapAttachmentId = attMap.get(source.mapAttachmentId);
        if (mapAttachmentId != null) {
          tx.update(campaigns).set({ mapAttachmentId }).where(eq(campaigns.id, cloneId)).run();
        }
      }

      // AI seat + scribe config (issue #1078): carry the DM's hand-authored steering
      // and trigger settings across clone; reset runtime counters to zero.
      if (aiSeatRow) {
        tx.insert(aiDmSeats).values({
          campaignId: cloneId,
          // #1049: one classification, three call sites. Counters are zeroed explicitly rather
          // than left to column defaults so "this clone starts its own accounting" is a stated
          // decision, not an accident of which fields the insert happened to omit.
          ...portableAiSeat(aiSeatRow),
          ...freshAiSeatCounters(),
          createdAt: ts,
          updatedAt: ts,
        }).run();
      }
      if (aiScribeConfigRow) {
        tx.insert(aiScribeConfigs).values({
          campaignId: cloneId,
          postSession: aiScribeConfigRow.postSession,
          cron: aiScribeConfigRow.cron,
          budgetPerRun: aiScribeConfigRow.budgetPerRun,
          createdAt: ts,
          updatedAt: ts,
        }).run();
      }

      // Re-sync denormalized session stats from the rows actually cloned (#841).
      this.sessions.recomputeSessionStatsInTx(tx, cloneId);

      return cloneId;
    });

    // Issue #524/#435: publish attachment bytes after the entity rows committed.
    for (const p of pendingAttachmentCopies) {
      try {
        copyAttachmentBytes(p);
      } catch (err) {
        importLog.warn(
          `clone attachment copy failed src=${p.srcCampaignId}/${p.srcAttachmentId} -> ${p.dstCampaignId}/${p.dstAttachmentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Same membership rule as create(): the caller becomes the clone's dm.
    if (!user.devRole) {
      const numericId = Number(user.id);
      if (Number.isInteger(numericId)) {
        await this.members.addCreatorAsDm(newId, numericId);
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'campaign.clone',
      entityType: 'campaign',
      entityId: newId,
      campaignId: newId,
      detail: `cloned from campaign ${id} (${template ? 'template' : 'full'})`,
    });

    // #1049 review: carrying `proactiveSettings` is not the same as HONOURING them. The watcher
    // is in-memory and starts only from AiDmService.configure's callback, which this path
    // bypasses by inserting the seat row directly inside the copy transaction — so without this
    // the clone reads back proactive ON and never fires a proactive turn. Called AFTER commit
    // deliberately: the sync re-reads the persisted row.
    await this.aiDm.syncProactiveWatcher(newId);
    return this.getOrThrow(newId);
  }

  /**
   * Import a campaign from a Campfire JSON export (issue #120) — the round-trip
   * that makes the previously one-way export re-importable. Recreates a brand-new
   * campaign owned by the caller from the export document, with EVERY id fresh and
   * every intra-campaign reference remapped to the new rows (same two-pass strategy
   * as clone()): location parent nesting, npc→location, quest parent + giver-npc,
   * combatant→character, encounter current-combatant pointer, note entity links and
   * the campaign's currentLocationId. No id from the source document survives, so an
   * import can never collide with the campaign it was exported from.
   *
   * Deliberate handling of the fields the issue calls out:
   *  - ids: always fresh (auto-increment) — the document's ids are source keys only.
   *  - ownerUserId (PCs): reset to null. Owner ids are per-install; on a new server
   *    they wouldn't resolve (and could alias an unrelated user), so imported PCs
   *    come in unowned — a DM can re-assign them from the roster.
   *  - notes.authorUserId: reassigned to the importer (author ids are per-install);
   *    authorName is preserved from the document for provenance.
   *  - attachments (issue #236): a JSON-only import has no bytes, so `attachmentFiles`
   *    is empty — mapAttachmentId comes in null and character.portraitUrl is dropped
   *    (the source-install route wouldn't resolve). When importing a ZIP export (via
   *    importArchive), the embedded uploads/ bytes are passed in here: each attachment
   *    row is recreated under the new campaign with a fresh id + its file written to
   *    disk, and every reference to it — campaign.mapAttachmentId, character.portraitUrl,
   *    encounter.mapAttachmentId — is remapped to that new id instead of being reset.
   *  - ruleSystem: kept only if that rule pack is installed on THIS server; otherwise
   *    cleared to '' so a dangling slug can't break compendium lookups.
   *  - status: forced to 'active' so a freshly imported campaign is editable even if
   *    the source was archived (paused/completed, read-only).
   *  - members / audit / proposals: not imported — install-specific; only the caller
   *    becomes the new campaign's dm (same rule as create()/clone()).
   *
   * Issue #725 — staged + atomic commit. Attachment bytes are STAGED to a unique
   * uploadsRoot()/.staging/<nonce>/ dir BEFORE any row is inserted (so a disk
   * error aborts the import up front, not partway). Every entity row + the dm
   * membership + the import audit row commit in ONE db.transaction() — a throw
   * at any of those boundaries rolls the whole campaign back, no orphan rows.
   * After commit, staged files are renamed into their final uploadsRoot()/<id>/
   * location (atomic per-file on the same fs); a publish failure degrades only
   * THAT one file to the #84 row-without-file shape, never a partial import.
   * Returns an ImportResult with imported/skipped/failed counts + file details.
   */
  /**
   * Issue #584 — compendium dependency/license preflight for a Campfire export document.
   * Runs before any mutation so missing or incompatible rule packs can block import or
   * guide installation. Does not create a campaign.
   */
  async preflightImport(input: CampaignImportInput): Promise<CampaignImportPreflight> {
    const encounterRows = asArr(input.encounters);
    const exportDeps = asArr(input.compendiumDependencies)
      .map((d) => ({
        packSlug: str(d.packSlug),
        packVersion: str(d.packVersion),
        name: str(d.name, str(d.packSlug)),
        license: str(d.license),
        sourceUrl: str(d.sourceUrl),
        entrySlugs: Array.isArray(d.entrySlugs)
          ? (d.entrySlugs as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
          : [],
      }))
      .filter((d) => d.packSlug.length > 0);
    return preflightCompendiumImport(this.db, encounterRows, exportDeps);
  }

  async importCampaign(
    input: CampaignImportInput,
    user: RequestUser,
    attachmentFiles: ImportAttachmentFile[] = [],
  ): Promise<ImportResult> {
    const doc = input;
    const campaignSrc = asRec(doc.campaign);
    const name = (str(input.name) || str(campaignSrc.name) || 'Imported Campaign').slice(0, 120);

    // Keep the source rule system only if that pack is installed here — otherwise a
    // dangling slug would silently break Compendium lookups scoped by pack.
    const ruleSystemSrc = str(campaignSrc.ruleSystem);
    let ruleSystem = '';
    if (ruleSystemSrc) {
      const [pack] = await this.db.select({ id: rulePacks.id }).from(rulePacks).where(eq(rulePacks.slug, ruleSystemSrc)).limit(1);
      if (pack) ruleSystem = ruleSystemSrc;
    }
    const narrationLanguageParsed = NarrationLanguage.safeParse(campaignSrc.narrationLanguage);
    const narrationLanguage = narrationLanguageParsed.success ? narrationLanguageParsed.data : 'en';
    const aiExternalContentPolicyParsed = AiExternalContentPolicy.safeParse(campaignSrc.aiExternalContentPolicy);
    const aiExternalContentPolicy = aiExternalContentPolicyParsed.success
      ? aiExternalContentPolicyParsed.data
      : 'member_consent';

    const locationRows = asArr(doc.locations);
    const npcRows = asArr(doc.npcs);
    const questRows = asArr(doc.quests);
    const characterRows = asArr(doc.characters);
    const sessionRows = asArr(doc.sessions);
    const noteRows = asArr(doc.notes);
    const commentRows = asArr(doc.comments);
    const encounterRows = asArr(doc.encounters);
    const onUnresolvedCompendium: OnUnresolvedCompendium = doc.onUnresolvedCompendium === 'detach' ? 'detach' : 'block';
    const exportDeps = asArr(doc.compendiumDependencies)
      .map((d) => ({
        packSlug: str(d.packSlug),
        packVersion: str(d.packVersion),
        name: str(d.name, str(d.packSlug)),
        license: str(d.license),
        sourceUrl: str(d.sourceUrl),
        entrySlugs: Array.isArray(d.entrySlugs)
          ? (d.entrySlugs as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
          : [],
      }))
      .filter((d) => d.packSlug.length > 0);
    const compendiumPreflight = await preflightCompendiumImport(this.db, encounterRows, exportDeps);
    assertCompendiumImportAllowed(compendiumPreflight, onUnresolvedCompendium);
    const compendiumResolution = buildResolutionMap(compendiumPreflight, onUnresolvedCompendium);
    let compendiumDetachedCount = 0;
    // Issue #266: entity types the export used to drop wholesale — now recreated with
    // fresh ids and intra-campaign refs remapped (npc→faction, beat→arc, branch→beat).
    const factionRows = asArr(doc.factions);
    const storyArcRows = asArr(doc.storyArcs);
    const timelineEventRows = asArr(doc.timelineEvents);
    const inventoryRows = asArr(doc.inventory);
    const timelineCalendarSrc = asRec(doc.timelineCalendar);
    const sessionZeroSrc = asRec(doc.sessionZero);
    const treasurySrc = asRec(doc.treasury);
    // Issue #813: immutable prose versions (tips + superseded), remapped below.
    const revisionRows = asArr(doc.revisions);
    // Issue #436: planned game nights (with nested RSVPs) and per-session attendance.
    const scheduledSessionRows = asArr(doc.scheduledSessions);
    const sessionAttendanceRows = asArr(doc.sessionAttendance);

    // Issue #1078: AI seat + scribe config from the export document.
    const aiSeatSrc = asRec(doc.aiSeat);
    const aiScribeConfigSrc = asRec(doc.aiScribeConfig);

    const importerId = String(user.id);
    const ts = nowIso();

    // Issue #1521: validate + normalize every schedule row's `scheduledAt` at the
    // import boundary — the one path that could write a value SQLite's `julianday()`
    // cannot parse. The Upcoming/Past projections compare `scheduledAt` with
    // `julianday()`, which returns NULL for an unparseable value; a NULL comparison
    // is neither true nor false, so a row carrying a malformed timestamp (an empty
    // string, a truncated value, a locale-formatted date) satisfied NEITHER
    // `scheduleNotEnded` (Upcoming) NOR `scheduleEnded` (Past) and vanished from
    // every list a DM uses — silent data loss worse than a rejected import. Every
    // other write path normalizes via `new Date(iso).toISOString()` (see
    // SchedulingService.normalizeScheduledAt); import wrote the raw value verbatim.
    // The gate deliberately requires an OFFSET-BEARING ISO-8601 date-time (a
    // trailing `Z` or ±HH:MM), not merely `Date.parse()`-able, because `Date.parse`
    // silently accepts locale forms ("05/01/2030 7:00 PM", "May 1, 2030", date-only)
    // and reads a ZONE-LESS value in the SERVER's local timezone — so the same
    // archive would import to different UTC instants on hosts with different TZ
    // settings, silently moving the scheduled time. It also validates the actual
    // calendar components, because V8's `Date` silently rolls impossible/overflow
    // dates (Feb 30, April 31, hour 24) to a different day, which would import an
    // untrusted archive to a CHANGED scheduled date. The strict validator lives in
    // @campfire/schema (normalizeOffsetIsoDateTime) per the shared-shapes
    // invariant; it returns canonical ISO UTC, or null for anything that is not a
    // valid offset-bearing ISO-8601 date-time. The stored invariant is "ISO UTC
    // (normalized on write)", and exports round-trip the exact canonical `...Z`
    // form `toISOString()` produces, so a real archive always validates. Anything
    // else rejects the import with a 400 that names the offending row, so the
    // operator is told exactly what to fix. Runs BEFORE staging so a bad archive
    // fails fast with zero bytes written, like the compendium preflight.
    for (let i = 0; i < scheduledSessionRows.length; i++) {
      const s = scheduledSessionRows[i];
      const raw = s.scheduledAt;
      const normalized = typeof raw === 'string' ? normalizeOffsetIsoDateTime(raw) : null;
      if (normalized === null) {
        const label = str(s.title) || 'untitled';
        throw new BadRequestException(
          `Cannot import scheduled session #${i + 1} (${label}): scheduledAt ${
            typeof raw === 'string' ? `"${raw}"` : `(${typeof raw})`
          } is not a valid offset-bearing ISO-8601 date-time (e.g. 2030-05-01T19:00:00.000Z). Fix the value in the export and re-import.`,
        );
      }
      s.scheduledAt = normalized;
    }

    // Issue #725: STAGE every attachment's bytes BEFORE any DB row is committed,
    // so a mid-import failure (anywhere — preflight, the DB transaction, or the
    // final publish) never leaves a partial import behind. The old order (commit
    // rows first, then write files, swallowing fs errors) could report success
    // with missing maps AND strand an inaccessible campaign (membership/audit
    // ran after the commit). The new order is:
    //   1. stage  — write every byte into uploadsRoot()/.staging/<nonce>/ and
    //               confirm the filesystem will accept it. Surface ENOSPC/EACCES
    //               here as a 400, BEFORE the DB is touched.
    //   2. commit — insert every entity row + the importer's dm membership + the
    //               audit row in ONE synchronous transaction. A throw at any
    //               point rolls back the whole campaign (no orphan rows).
    //   3. publish — rename each staged file into its final uploadsRoot()/<cid>/
    //                location. Per-file rename is atomic on the same filesystem;
    //                a failure here degrades to the #84 "row-without-file" shape
    //                (the GET route 404s that one file) — never a partial import.
    // Staging dir is cleaned up on every outcome (success post-publish, or any
    // failure). `stagingDir` tracks the dir to remove; null until created.
    let stagingDir: string | null = null;
    try {
    // Preflight (issue #725): confirm the uploads root is writable BEFORE we
    // spend the work staging bytes, so an unwritable/unmounted DATA_DIR fails
    // fast with a clear 400 rather than partway through. Only matters when
    // there are attachments to write — a JSON-only import skips this entirely.
    const hasAttachments = attachmentFiles.length > 0;
    if (hasAttachments) {
      assertUploadsWritable();
    }

    // srcAttachmentId -> new attachment id, populated inside the tx.
    const attMap = new Map<number, number>();
    /**
     * Rewrite a source portraitUrl through attMap (shared helper with clone — #524 / #236).
     * Preserve safe remote HTTPS portraits; drop dangling local attachment refs.
     */
    const remapPortraitUrl = (url: unknown): string | null => {
      const safe = safeHistoricalAvatarUrl(url);
      if (!safe) return null;
      const remapped = remapAttachmentFileUrl(safe, attMap);
      if (remapped != null) return remapped;
      return historicalAvatarAttachmentId(safe) == null ? safe : null;
    };
    /** Preserve safe remote historical avatars; remap local attachment snapshots. */
    const remapHistoricalAvatarUrl = (url: unknown): string | null => {
      const safe = safeHistoricalAvatarUrl(url);
      if (!safe) return null;
      const remapped = remapAttachmentFileUrl(safe, attMap);
      if (remapped != null) return remapped;
      // Remote HTTPS (or other non-attachment) — keep; dangling local attachment — drop.
      return historicalAvatarAttachmentId(safe) == null ? safe : null;
    };

    // STAGE: write each attachment's bytes into a unique staging dir now. The
    // final filename embeds the NEW DB id (assigned inside the tx below), so
    // we write under a per-attachment nonce here and rename to the final path
    // on publish. A write failure (disk full, permission, mount loss) aborts
    // the whole import BEFORE a single row is inserted — exactly the atomicity
    // the issue requires. `pendingWrites` carries the staged->final mapping
    // the publish step consumes after the tx commits.
    const pendingWrites: { srcId: number; stagedPath: string; finalRelPath: string; bytes: Buffer }[] = [];
    if (hasAttachments) {
      stagingDir = createStagingDir();
      for (const a of attachmentFiles) {
        const nonce = crypto.randomBytes(8).toString('hex');
        const ext = ALLOWED_MIME_TO_EXT[a.mime] ?? 'bin';
        const stagedPath = path.join(stagingDir, `${nonce}.${ext}`);
        try {
          fs.writeFileSync(stagedPath, a.bytes);
        } catch (err) {
          // A failed stage write means we cannot durably recreate this
          // attachment — abort the whole import rather than reporting success
          // with a missing map (the old behavior the issue calls out).
          cleanupStagingDir(stagingDir);
          stagingDir = null;
          throw new BadRequestException(
            `Could not stage attachment "${a.filename}" for import (disk full, unwritable, or unmounted): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // finalRelPath is resolved against uploadsRoot() on publish, once we
        // know the new campaign id. Stored as <campaignDir>/<newId>.<ext>.
        pendingWrites.push({ srcId: a.srcId, stagedPath, finalRelPath: `${nonce}.${ext}`, bytes: a.bytes });
      }
    }

    const newId = this.db.transaction((tx) => {
      const [campaignRow] = tx
        .insert(campaigns)
        .values({
          name,
          description: str(campaignSrc.description),
          status: 'active', // imported campaigns start editable even if the source was archived
          currentLocationId: null, // remapped below
          dangerLevel: str(campaignSrc.dangerLevel, 'low'),
          dmControlsProgression: boolOf(campaignSrc.dmControlsProgression),
          dmControlsTurns: boolOf(campaignSrc.dmControlsTurns),
          requireDmTurnConfirmation: boolOf(campaignSrc.requireDmTurnConfirmation),
          // Older exports predate the policy field and retain the historical
          // enabled default. Explicitly disabled campaigns stay disabled.
          publicRecapSharingEnabled: campaignSrc.publicRecapSharingEnabled !== false,
          publicInvitesEnabled: campaignSrc.publicInvitesEnabled !== false,
          narrationLanguage,
          aiExternalContentPolicy,
          sessionCount: Math.max(0, intOr(campaignSrc.sessionCount, 0)),
          latestSessionNumber: Math.max(0, intOr(campaignSrc.latestSessionNumber, 0)),
          ruleSystem,
          mapAttachmentId: null, // remapped below once attachment rows have fresh ids
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const cid = campaignRow.id;

      // Attachments first (issue #236): every map/portrait ref downstream — character
      // portraitUrl, encounter mapAttachmentId, the campaign map — remaps through attMap,
      // so the rows must exist before those inserts. Empty for a JSON-only import.
      // Issue #725: the bytes were already STAGED above (before the tx opened) — here we
      // only insert the row. The new id is folded into pendingWrites' finalRelPath on
      // publish, once we know it.
      for (const a of attachmentFiles) {
        const [row] = tx
          .insert(attachments)
          .values({
            campaignId: cid,
            uploaderUserId: importerId,
            kind: a.kind,
            filename: a.filename,
            mime: a.mime,
            size: a.bytes.length,
            title: a.title,
            caption: a.caption,
            altText: a.altText,
            creator: a.creator,
            sourceUrl: a.sourceUrl,
            license: a.license,
            rights: a.rights,
            attribution: a.attribution,
            checksumSha256: crypto.createHash('sha256').update(a.bytes).digest('hex'),
            // Secure default (#97): maps/images land DM-only, portraits stay player-visible.
            hidden: a.kind !== 'portrait',
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        attMap.set(a.srcId, row.id);
        const ext = ALLOWED_MIME_TO_EXT[a.mime] ?? 'bin';
        // Record the FINAL on-disk path (named by the new row id) keyed to this
        // staged file, so the publish step renames the right staging entry to it.
        const pw = pendingWrites.find((p) => p.srcId === a.srcId);
        if (pw) pw.finalRelPath = path.join(String(cid), `${row.id}.${ext}`);
      }

      // Scheduled sessions (issue #436): planned game nights with RSVPs. Inserted
      // early — no cross-refs to other entity types. Source RSVP identities cannot
      // name local accounts, so each copied reply gets a deterministic reserved proxy
      // rather than falsely assigning attendance to the importing DM.
      for (const s of scheduledSessionRows) {
        // Issue #504: the lifecycle status round-trips too. Dropping it would import a
        // cancelled night back as a LIVE one — re-listed under Upcoming, re-armed for
        // reminders, and re-published to the ICS feed. `cancelledBy` is an install-local
        // user id (like the RSVP userIds below) so it is not carried across installs;
        // `session_id` stays null because schedules are inserted before sessions and the
        // exported id belongs to the source install.
        //
        // `completed` is imported AS completed, deliberately, even though its sessionId
        // cannot cross an install boundary. Reviewed and declined the alternative of
        // downgrading it to `scheduled`: completed is historical truth (the night was
        // played), so downgrading would make a played night look unplayed, and for a
        // future-dated row would resurrect it into Upcoming — exactly the bug the
        // cancelled case above fixes. A "Completed" tag with no recap link is mildly
        // lossy but honest. Please don't re-litigate without re-reading this.
        const importedStatus = s.status === 'cancelled' || s.status === 'completed' ? s.status : 'scheduled';
        const [row] = tx
          .insert(scheduledSessions)
          .values({
            campaignId: cid,
            // Issue #1521: validated + normalized to canonical ISO UTC in the
            // boundary pre-pass above, so `julianday(scheduledAt)` always parses
            // and the row can never vanish from both Upcoming and Past. Read
            // directly — no `ts` fallback — because that pre-pass rejected any
            // row whose scheduledAt was not a usable timestamp. The cast is
            // sound: the pre-pass stored a `string` for every row that reaches here.
            scheduledAt: s.scheduledAt as string,
            durationMinutes: intOr(s.durationMinutes, 240),
            title: str(s.title),
            location: str(s.location),
            notes: str(s.notes),
            status: importedStatus,
            cancelledAt: importedStatus === 'cancelled' && typeof s.cancelledAt === 'string' ? s.cancelledAt : null,
            cancelledBy: null,
            cancellationReason: importedStatus === 'cancelled' ? str(s.cancellationReason) : '',
            sessionId: null,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        for (const [rsvpIndex, rsvp] of asArr(s.rsvps).entries()) {
          tx.insert(sessionRsvps)
            .values({
              scheduledSessionId: row.id,
              userId: `imported-rsvp:${cid}:${row.id}:${rsvpIndex}`,
              userName: str(rsvp.userName),
              userImported: true,
              status: str(rsvp.status, 'maybe'),
              note: str(rsvp.note),
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
        }
      }

      // Factions (issue #266) before npcs — an npc's factionId points at one, so the
      // faction rows must exist to remap through. No intra-campaign refs of their own.
      const factionMap = new Map<number, number>();
      for (const f of factionRows) {
        const srcId = intOrNull(f.id);
        const [row] = tx
          .insert(factions)
          .values({
            campaignId: cid,
            name: str(f.name, 'Unnamed Faction'),
            kind: str(f.kind),
            body: str(f.body),
            goals: str(f.goals),
            dmSecret: str(f.dmSecret),
            // #754: missing hidden on import → DM-only (same as create default).
            hidden: hiddenOf(f.hidden),
            reputation: intOr(f.reputation, 0),
            standing: str(f.standing, 'neutral'),
            portraitUrl: remapPortraitUrl(f.portraitUrl),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (srcId != null) factionMap.set(srcId, row.id);
      }

      // Locations first (npcs, quests-via-npcs and currentLocationId point at them).
      // Two passes: insert all with parentId deferred, then remap the nesting parent —
      // a child's parent may appear after it in the document (#99).
      const locMap = new Map<number, number>();
      for (const l of locationRows) {
        const srcId = intOrNull(l.id);
        const [row] = tx
          .insert(locations)
          .values({
            campaignId: cid,
            parentId: null,
            name: str(l.name, 'Untitled Location'),
            kind: str(l.kind),
            status: str(l.status, 'unexplored'),
            mapX: realOrNull(l.mapX),
            mapY: realOrNull(l.mapY),
            body: str(l.body),
            dmSecret: str(l.dmSecret),
            portraitUrl: remapPortraitUrl(l.portraitUrl),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (srcId != null) locMap.set(srcId, row.id);
      }
      for (const l of locationRows) {
        const srcId = intOrNull(l.id);
        const parentSrc = intOrNull(l.parentId);
        if (srcId == null || parentSrc == null) continue;
        const parentId = locMap.get(parentSrc);
        const selfId = locMap.get(srcId);
        if (parentId != null && selfId != null) {
          tx.update(locations).set({ parentId }).where(eq(locations.id, selfId)).run();
        }
      }

      const npcMap = new Map<number, number>();
      for (const n of npcRows) {
        const srcId = intOrNull(n.id);
        const locSrc = intOrNull(n.locationId);
        const factionSrc = intOrNull(n.factionId);
        const [row] = tx
          .insert(npcs)
          .values({
            campaignId: cid,
            name: str(n.name, 'Unnamed NPC'),
            role: str(n.role),
            disposition: str(n.disposition, 'neutral'),
            locationId: locSrc != null ? (locMap.get(locSrc) ?? null) : null,
            // Faction membership (issue #221/#266) remapped to the imported faction; a
            // dangling ref (faction missing from the doc) drops to null, never a stale id.
            factionId: factionSrc != null ? (factionMap.get(factionSrc) ?? null) : null,
            body: str(n.body),
            dmSecret: str(n.dmSecret),
            // Remapped to the freshly imported portrait attachment when a ZIP import
            // carried its bytes; null for a JSON-only import (source route wouldn't resolve).
            portraitUrl: remapPortraitUrl(n.portraitUrl),
            // #754: missing hidden on import → DM-only (same as create default).
            hidden: hiddenOf(n.hidden),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (srcId != null) npcMap.set(srcId, row.id);
      }

      // Quests: two passes for parentId (a subquest's parent may appear after it).
      const questMap = new Map<number, number>();
      for (const q of questRows) {
        const srcId = intOrNull(q.id);
        const giverSrc = intOrNull(q.giverNpcId);
        const [row] = tx
          .insert(quests)
          .values({
            campaignId: cid,
            parentId: null,
            title: str(q.title, 'Untitled Quest'),
            body: str(q.body),
            status: str(q.status, 'available'),
            giverNpcId: giverSrc != null ? (npcMap.get(giverSrc) ?? null) : null,
            reward: str(q.reward),
            dmSecret: str(q.dmSecret),
            // #754: missing hidden on import → DM-only (same as create default).
            hidden: hiddenOf(q.hidden),
            sortOrder: intOr(q.sortOrder, 0),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (srcId != null) questMap.set(srcId, row.id);
        // Objectives are nested on the quest in the export shape.
        for (const o of asArr(q.objectives)) {
          tx.insert(questObjectives)
            .values({ questId: row.id, text: str(o.text), done: boolOf(o.done), sortOrder: intOr(o.sortOrder, 0) })
            .run();
        }
      }
      for (const q of questRows) {
        const srcId = intOrNull(q.id);
        const parentSrc = intOrNull(q.parentId);
        if (srcId == null || parentSrc == null) continue;
        const parentId = questMap.get(parentSrc);
        const selfId = questMap.get(srcId);
        if (parentId != null && selfId != null) {
          tx.update(quests).set({ parentId }).where(eq(quests.id, selfId)).run();
        }
      }

      const charMap = new Map<number, number>();
      for (const c of characterRows) {
        const srcId = intOrNull(c.id);
        const [row] = tx
          .insert(characters)
          .values({
            campaignId: cid,
            ownerUserId: null, // imported PCs come in unowned — owner ids are per-install
            name: str(c.name, 'Unnamed Character'),
            species: str(c.species),
            className: str(c.className),
            level: intOr(c.level, 1),
            xp: Math.max(0, intOr(c.xp, 0)),
            background: str(c.background),
            stats: jsonCol(c.stats, '{}'),
            ac: intOrNull(c.ac),
            speed: nonNegativeIntOrNull(c.speed),
            hpCurrent: intOr(c.hpCurrent, 10),
            hpMax: intOr(c.hpMax, 10),
            // #1667 half B: write the paired condition columns through the sheet helper.
            // When both import fields are present but disagree, the legacy name list is
            // authoritative; stale instances are dropped and combat-only fields are nulled.
            ...characterConditionWriteSetForImport(c),
            saveProficiencies: jsonCol(c.saveProficiencies, '[]'),
            skills: jsonCol(c.skills, '{}'),
            actions: jsonCol(c.actions, '[]'),
            spellSlots: jsonCol(c.spellSlots, '{}'),
            // Remapped to the freshly imported portrait attachment when a ZIP import
            // carried its bytes; null for a JSON-only import (source route wouldn't resolve).
            portraitUrl: remapPortraitUrl(c.portraitUrl),
            ddbId: typeof c.ddbId === 'string' ? c.ddbId : null,
            notes: str(c.notes),
            dmSecret: str(c.dmSecret),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (srcId != null) charMap.set(srcId, row.id);
      }

      // Party/character inventory (issue #266) after characters — a character-owned item
      // remaps its characterId through charMap. If that character is missing (dangling
      // ref), the item falls back to party-owned rather than pointing at a stale id.
      //
      // Issue #1326 review (Codex/Devin): preserving equip state is a DIFFERENT job from
      // ENFORCING its invariants — copying the export's equipped/equipSlot/equippedAction
      // verbatim would let untrusted or stale import data recreate exactly what
      // InventoryService.update() refuses: equipped=true with no slot, or two items
      // sharing one (character, slot) pair. Both are enforced here, deterministically
      // (never a hard reject — an import already committed the rest of the campaign):
      // an equipped item without a non-empty slot is unequipped, and the FIRST item to
      // claim a (character, slot) pair (in export order) wins it; every later claimant
      // for that same pair is imported unequipped. `equippedClaims` tracks that
      // first-wins bookkeeping; `equipIssuesResolved` counts how many rows this touched,
      // recorded on the campaign.import audit row below so the DM can see it happened.
      let equipIssuesResolved = 0;
      const equippedClaims = new Set<string>();
      for (const item of inventoryRows) {
        const ownerType = str(item.ownerType, 'party') === 'character' ? 'character' : 'party';
        const charSrc = intOrNull(item.characterId);
        const mappedChar = charSrc != null ? (charMap.get(charSrc) ?? null) : null;
        const resolvedOwner = ownerType === 'character' && mappedChar != null ? 'character' : 'party';
        // `equippedAction` is re-validated against CharacterAction rather than trusted
        // verbatim — a malformed or foreign-shaped import drops the field rather than
        // storing garbage the resolver would later fail to parse. It is ALSO dropped
        // whenever the item falls back to the party stash (issue #1326 review,
        // coordinator): a party item can never be equipped, so keeping a granted action
        // around for an item nobody can currently equip is a half-clear — the item would
        // silently arm whoever later claims and equips it with an attack nobody in THIS
        // campaign chose. This is conditioned on `resolvedOwner`, not `grantEquip`: a
        // character-owned item that merely lost a slot-conflict race still keeps its
        // action (normal play — unequip the winner, equip this one instead), exactly like
        // a single-item PATCH slot conflict.
        const importedActionParse = resolvedOwner === 'character' ? CharacterAction.safeParse(item.equippedAction) : null;
        const wantsEquip = resolvedOwner === 'character' && item.equipped === true;
        const trimmedSlot = typeof item.equipSlot === 'string' ? item.equipSlot.trim().slice(0, 60) : '';
        const claimKey = wantsEquip && mappedChar != null ? `${mappedChar}:${trimmedSlot.toLowerCase()}` : null;
        // Invalid (no slot) or a slot already claimed by an earlier row: land unequipped.
        const grantEquip = wantsEquip && trimmedSlot.length > 0 && claimKey !== null && !equippedClaims.has(claimKey);
        if (wantsEquip && !grantEquip) equipIssuesResolved += 1;
        if (grantEquip && claimKey) equippedClaims.add(claimKey);
        tx.insert(inventoryItems)
          .values({
            campaignId: cid,
            ownerType: resolvedOwner,
            characterId: resolvedOwner === 'character' ? mappedChar : null,
            name: str(item.name, 'Item'),
            qty: intOr(item.qty, 1),
            notes: str(item.notes),
            iconSlug: str(item.iconSlug), // issue #307 — preserve icon override on import
            // Numeric ids are local only; retained ref/snapshot keep imports play-safe.
            ruleEntryId: null,
            compendiumRef: safeImportedCompendiumRef(item.compendiumRef),
            compendiumSnapshot: safeImportedCompendiumSnapshot(item.compendiumSnapshot),
            // A cross-install numeric id cannot be trusted. Keep the snapshot play-safe
            // and surface a detached link rather than pretending it can be refreshed.
            compendiumState: safeImportedCompendiumRef(item.compendiumRef) && safeImportedCompendiumSnapshot(item.compendiumSnapshot) ? 'detached' : null,
            equipped: grantEquip,
            equipSlot: grantEquip ? trimmedSlot : null,
            equippedAction: importedActionParse?.success ? JSON.stringify(importedActionParse.data) : null,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      // Party treasury (issue #266) — one coin-totals row per campaign. Only insert when
      // the export carried non-empty totals (the module creates it lazily otherwise).
      const treasuryCoins = {
        cp: Math.max(0, intOr(treasurySrc.cp, 0)),
        sp: Math.max(0, intOr(treasurySrc.sp, 0)),
        ep: Math.max(0, intOr(treasurySrc.ep, 0)),
        gp: Math.max(0, intOr(treasurySrc.gp, 0)),
        pp: Math.max(0, intOr(treasurySrc.pp, 0)),
      };
      if (treasuryCoins.cp || treasuryCoins.sp || treasuryCoins.ep || treasuryCoins.gp || treasuryCoins.pp) {
        tx.insert(partyTreasury).values({ campaignId: cid, ...treasuryCoins, updatedAt: ts }).run();
      }

      const sessionMap = new Map<number, number>();
      for (const s of sessionRows) {
        const srcId = intOrNull(s.id);
        const [row] = tx
          .insert(sessions)
          .values({
            campaignId: cid,
            number: intOr(s.number, 0),
            title: str(s.title),
            playedAt: typeof s.playedAt === 'string' ? s.playedAt : null,
            recap: str(s.recap),
            dmSecret: str(s.dmSecret),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (srcId != null) sessionMap.set(srcId, row.id);
      }

      // Session attendance (issue #436): which characters played each session.
      // Requires sessionMap + charMap; dangling refs are dropped.
      for (const a of sessionAttendanceRows) {
        const sessionSrc = intOrNull(a.sessionId);
        const charSrc = intOrNull(a.characterId);
        const sessionId = sessionSrc != null ? sessionMap.get(sessionSrc) : undefined;
        const characterId = charSrc != null ? charMap.get(charSrc) : undefined;
        if (sessionId == null || characterId == null) continue;
        tx.insert(sessionAttendees)
          .values({
            sessionId,
            characterId,
            characterName: str(a.characterName),
            createdAt: ts,
          })
          .run();
      }

      const encounterMap = new Map<number, number>();
      for (const e of encounterRows) {
        const encounterSrcId = intOrNull(e.id);
        const encounterStatus = str(e.status, 'preparing');
        const [row] = tx
          .insert(encounters)
          .values({
            campaignId: cid,
            name: str(e.name, 'Encounter'),
            status: encounterStatus,
            round: intOr(e.round, 0),
            turnIndex: intOr(e.turnIndex, 0),
            currentCombatantId: null, // remapped below once combatants have fresh ids
            // Where/why/when links (issue #126/#864): remap through the import maps.
            // A missing/foreign source id drops to null — never a stale cross-campaign link.
            locationId: (() => {
              const src = intOrNull(e.locationId);
              return src != null ? (locMap.get(src) ?? null) : null;
            })(),
            questId: (() => {
              const src = intOrNull(e.questId);
              return src != null ? (questMap.get(src) ?? null) : null;
            })(),
            sessionId: (() => {
              const src = intOrNull(e.sessionId);
              return src != null ? (sessionMap.get(src) ?? null) : null;
            })(),
            // Battle map (issue #39/#236): remap the map attachment to its imported id so an
            // exported VTT encounter re-imports WITH its map, not as a mapless initiative list.
            // The grid + fog overlay travel with the map (coordinate/scale data — no remap needed).
            mapAttachmentId: (() => {
              const src = intOrNull(e.mapAttachmentId);
              return src != null ? (attMap.get(src) ?? null) : null;
            })(),
            gridSize: realOrNull(e.gridSize),
            gridScale: realOrNull(e.gridScale),
            gridUnit: typeof e.gridUnit === 'string' ? e.gridUnit : null,
            gridSnap: boolOf(e.gridSnap),
            // Grid calibration (issue #417) travels with the map so a cloned/imported
            // encounter keeps its printed-grid alignment. Missing → column defaults.
            gridOffsetX: realOrNull(e.gridOffsetX) ?? 0,
            gridOffsetY: realOrNull(e.gridOffsetY) ?? 0,
            gridCellHeight: realOrNull(e.gridCellHeight),
            gridRotation: realOrNull(e.gridRotation) ?? 0,
            gridOpacity: realOrNull(e.gridOpacity) ?? 0.35,
            fog: e.fog == null ? null : jsonCol(e.fog, ''),
            // #754: missing hidden on import → DM-only (same as create default).
            hidden: hiddenOf(e.hidden),
            endedAt: typeof e.endedAt === 'string' ? e.endedAt : null,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (encounterSrcId != null) encounterMap.set(encounterSrcId, row.id);
        // Map each source combatant id to its fresh id so the encounter's current-turn
        // pointer (identity-based, issue #49) can be remapped.
        const combatantIdMap = new Map<number, number>();
        for (const c of asArr(e.combatants)) {
          const cSrcId = intOrNull(c.id);
          const charSrc = intOrNull(c.characterId);
          const npcSrc = intOrNull(c.npcId);
          const npcIdentitySourceSrc = intOrNull(c.npcIdentitySourceId);
          const mappedNpcId = npcSrc != null ? (npcMap.get(npcSrc) ?? null) : null;
          const mappedNpcIdentitySourceId = npcIdentitySourceSrc != null ? (npcMap.get(npcIdentitySourceSrc) ?? null) : null;
          const compendiumResolved = resolveImportedCombatantRuleEntryId(c, compendiumResolution);
          if (compendiumResolved.detached) compendiumDetachedCount += 1;
          const [cRow] = tx
            .insert(combatants)
            .values({
              encounterId: row.id,
              kind: str(c.kind, 'monster'),
              characterId: charSrc != null ? (charMap.get(charSrc) ?? null) : null,
              npcId: mappedNpcId,
              npcIdentitySourceId: mappedNpcIdentitySourceId,
              // A fresh encounter cannot retain allegiance for an NPC that import
              // could not restore: preparation ignores that snapshot, and /start
              // cannot refresh an unlinked combatant.
              npcDispositionSnapshot:
                encounterStatus === 'preparing' &&
                (npcSrc != null || npcIdentitySourceSrc != null) &&
                mappedNpcId === null &&
                mappedNpcIdentitySourceId === null
                  ? null
                  : typeof c.npcDispositionSnapshot === 'string'
                    ? c.npcDispositionSnapshot
                    : null,
              name: str(c.name, 'Combatant'),
              initiative: intOrNull(c.initiative),
              initMod: intOr(c.initMod, 0),
              hpCurrent: intOr(c.hpCurrent, 10),
              hpMax: intOr(c.hpMax, 10),
              // Issue #1910: carry the add-time speed snapshot through import so a
              // re-imported encounter's movement budget matches what was exported,
              // rather than silently falling back to the adapter default.
              speed: nonNegativeIntOrNull(c.speed),
              conditions: jsonCol(c.conditions, '[]'),
              ruleEntryId: compendiumResolved.ruleEntryId,
              sortOrder: intOr(c.sortOrder, 0),
            })
            .returning()
            .all();
          if (cSrcId != null) combatantIdMap.set(cSrcId, cRow.id);
        }
        const currentSrc = intOrNull(e.currentCombatantId);
        if (currentSrc != null) {
          const currentCombatantId = combatantIdMap.get(currentSrc);
          if (currentCombatantId != null) {
            tx.update(encounters).set({ currentCombatantId }).where(eq(encounters.id, row.id)).run();
          }
        }
      }

      // Notes (issue #436): inserted AFTER encounters so faction + encounter anchors
      // remap correctly. Whisper recipientUserId is install-local — cleared on import.
      const entityMaps: Record<string, Map<number, number>> = {
        quest: questMap,
        npc: npcMap,
        faction: factionMap,
        location: locMap,
        character: charMap,
        session: sessionMap,
        encounter: encounterMap,
      };
      const noteMap = new Map<number, number>();
      for (const n of noteRows) {
        let entityType = typeof n.entityType === 'string' ? n.entityType : null;
        let entityId: number | null = null;
        const entitySrc = intOrNull(n.entityId);
        if (entityType === 'campaign') {
          entityId = cid;
        } else if (entityType != null && entitySrc != null) {
          entityId = entityMaps[entityType]?.get(entitySrc) ?? null;
          if (entityId == null) entityType = null; // dangling link in the source — drop it
        }
        const noteSrcId = intOrNull(n.id);
        const rawVisibility = str(n.visibility, 'private');
        // Whisper targets are install-local — downgrade to dm_shared so the row stays valid.
        const visibility = rawVisibility === 'whisper' ? 'dm_shared' : rawVisibility;
        const [noteRow] = tx
          .insert(notes)
          .values({
            campaignId: cid,
            authorUserId: importerId, // author ids are per-install — the importer owns imported notes
            authorName: str(n.authorName),
            authorImported: true,
            kind: str(n.kind, 'note'),
            visibility,
            recipientUserId: null,
            entityType,
            entityId,
            body: str(n.body),
            resolved: boolOf(n.resolved),
            resolvedNote: str(n.resolvedNote),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (noteSrcId != null) noteMap.set(noteSrcId, noteRow.id);
      }

      // Discussion history (issue #787): rebuild anchors and one-level parent
      // pointers with fresh ids. Imported account ids are install-local and could
      // alias an unrelated destination user, so ownership is assigned to the
      // importer (matching imported notes) while the source authorName remains the
      // visible posted-by provenance. Character labels stay immutable snapshots;
      // only their soft ids and local attachment avatar routes are remapped.
      const commentEntityMaps: Record<string, Map<number, number>> = {
        quest: questMap,
        npc: npcMap,
        faction: factionMap,
        location: locMap,
        character: charMap,
        session: sessionMap,
        encounter: encounterMap,
      };
      // Two linear passes (roots, then one-level replies). Orphaned parent refs
      // become roots in the second pass.
      const commentMap = new Map<number, number>();
      const insertImportedComment = (c: (typeof commentRows)[number], parentId: number | null) => {
        const srcId = intOrNull(c.id);
        if (srcId == null) return;
        const entityType = str(c.entityType);
        const sourceEntityId = intOrNull(c.entityId);
        const entityId = entityType === 'campaign'
          ? cid
          : sourceEntityId != null
            ? commentEntityMaps[entityType]?.get(sourceEntityId)
            : undefined;
        if (entityId == null) return;
        const sourceCharacterId = intOrNull(c.characterId);
        const [row] = tx
          .insert(comments)
          .values({
            campaignId: cid,
            entityType,
            entityId,
            parentId,
            authorUserId: importerId,
            authorName: str(c.authorName).slice(0, 120),
            authorImported: true,
            body: str(c.body, '[deleted]').slice(0, 20_000),
            inCharacter: boolOf(c.inCharacter),
            characterId: sourceCharacterId != null ? (charMap.get(sourceCharacterId) ?? null) : null,
            characterName: typeof c.characterName === 'string' ? c.characterName.slice(0, 120) : null,
            characterAvatarUrl: remapHistoricalAvatarUrl(c.characterAvatarUrl),
            deletedAt: typeof c.deletedAt === 'string' ? c.deletedAt : null,
            deletedBy: typeof c.deletedBy === 'string' ? c.deletedBy.slice(0, 120) : null,
            editedAt: typeof c.editedAt === 'string' ? c.editedAt : null,
            editedBy: typeof c.editedBy === 'string' ? c.editedBy.slice(0, 120) : null,
            createdAt: typeof c.createdAt === 'string' ? c.createdAt : ts,
            updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : ts,
          })
          .returning()
          .all();
        commentMap.set(srcId, row.id);
      };
      for (const c of commentRows) {
        if (intOrNull(c.parentId) == null) insertImportedComment(c, null);
      }
      for (const c of commentRows) {
        const parentSrc = intOrNull(c.parentId);
        if (parentSrc == null) continue;
        insertImportedComment(c, commentMap.get(parentSrc) ?? null);
      }

      // Issue #813: prose revision versions (author + replacer provenance). Entity ids and
      // restoredFromRevisionId are remapped; dangling entity links are dropped. Author
      // user ids are install-local provenance strings and travel as-is (like comment names).
      const revisionEntityMaps: Record<string, Map<number, number>> = {
        session: sessionMap,
        quest: questMap,
        npc: npcMap,
        location: locMap,
        faction: factionMap,
        note: noteMap,
      };
      const revisionSourceKinds = new Set(['human', 'ai', 'tool']);
      const revisionSource = (value: unknown): 'human' | 'ai' | 'tool' =>
        typeof value === 'string' && revisionSourceKinds.has(value) ? (value as 'human' | 'ai' | 'tool') : 'human';
      const revisionIdMap = new Map<number, number>();
      // Two passes so restoredFromRevisionId can point at a sibling imported later.
      for (const rev of revisionRows) {
        const srcId = intOrNull(rev.id);
        const entityType = str(rev.entityType);
        const sourceEntityId = intOrNull(rev.entityId);
        const entityId = sourceEntityId != null ? revisionEntityMaps[entityType]?.get(sourceEntityId) : undefined;
        if (entityId == null) continue;
        const snapshot =
          rev.snapshot && typeof rev.snapshot === 'object' && !Array.isArray(rev.snapshot)
            ? (rev.snapshot as Record<string, unknown>)
            : {};
        const snapshotText: Record<string, string> = {};
        for (const [key, value] of Object.entries(snapshot)) {
          if (typeof value === 'string') snapshotText[key] = value;
        }
        const [row] = tx
          .insert(entityRevisions)
          .values({
            campaignId: cid,
            entityType,
            entityId,
            snapshot: JSON.stringify(snapshotText),
            authorUserId: str(rev.authorUserId).slice(0, 120),
            authorName: str(rev.authorName).slice(0, 120),
            authorImported: true,
            authorSource: revisionSource(rev.authorSource),
            authorSourceDetail: str(rev.authorSourceDetail).slice(0, 200),
            createdAt: typeof rev.createdAt === 'string' ? rev.createdAt : '',
            replacedByUserId: str(rev.replacedByUserId).slice(0, 120),
            replacedByName: str(rev.replacedByName).slice(0, 120),
            replacedByImported: true,
            replacedBySource: revisionSource(rev.replacedBySource),
            replacedBySourceDetail: str(rev.replacedBySourceDetail).slice(0, 200),
            replacedAt: typeof rev.replacedAt === 'string' ? rev.replacedAt : null,
            restoredFromRevisionId: null, // remapped in the second pass
            authorshipKnown: rev.authorshipKnown !== false && rev.authorshipKnown !== 0,
          })
          .returning()
          .all();
        if (srcId != null) revisionIdMap.set(srcId, row.id);
      }
      for (const rev of revisionRows) {
        const srcId = intOrNull(rev.id);
        const newId = srcId != null ? revisionIdMap.get(srcId) : undefined;
        if (newId == null) continue;
        const sourceRestoredFrom = intOrNull(rev.restoredFromRevisionId);
        if (sourceRestoredFrom == null) continue;
        const remapped = revisionIdMap.get(sourceRestoredFrom);
        if (remapped == null) continue;
        tx.update(entityRevisions).set({ restoredFromRevisionId: remapped }).where(eq(entityRevisions.id, newId)).run();
      }

      // Storylines (issue #27/#266): the arc→beat→branch graph. Arcs first (arcMap),
      // then ALL beats (beatMap, arcId remapped), then branches — a branch's toBeatId
      // may point at a beat that appears later, so branches run after every beat exists.
      const arcMap = new Map<number, number>();
      for (const arc of storyArcRows) {
        const srcId = intOrNull(arc.id);
        const [row] = tx
          .insert(storyArcs)
          .values({
            campaignId: cid,
            title: str(arc.title, 'Untitled Arc'),
            summary: str(arc.summary),
            status: str(arc.status, 'planned'),
            sortOrder: intOr(arc.sortOrder, 0),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        if (srcId != null) arcMap.set(srcId, row.id);
      }
      const beatMap = new Map<number, number>();
      const pendingBranches: Rec[] = [];
      for (const arc of storyArcRows) {
        const arcSrcId = intOrNull(arc.id);
        const newArcId = arcSrcId != null ? arcMap.get(arcSrcId) : undefined;
        if (newArcId == null) continue; // arc failed to insert — its beats have nowhere to hang
        for (const beat of asArr(arc.beats)) {
          const beatSrcId = intOrNull(beat.id);
          const [row] = tx
            .insert(storyBeats)
            .values({
              campaignId: cid,
              arcId: newArcId,
              title: str(beat.title, 'Untitled Beat'),
              body: str(beat.body),
              status: str(beat.status, 'planned'),
              sortOrder: intOr(beat.sortOrder, 0),
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          if (beatSrcId != null) beatMap.set(beatSrcId, row.id);
          for (const branch of asArr(beat.branches)) pendingBranches.push(branch);
        }
      }
      for (const branch of pendingBranches) {
        const beatSrc = intOrNull(branch.beatId);
        const fromBeatId = beatSrc != null ? beatMap.get(beatSrc) : undefined;
        if (fromBeatId == null) continue; // source beat gone — drop the dangling edge
        const toSrc = intOrNull(branch.toBeatId);
        tx.insert(storyBranches)
          .values({
            beatId: fromBeatId,
            toBeatId: toSrc != null ? (beatMap.get(toSrc) ?? null) : null,
            label: str(branch.label),
            sortOrder: intOr(branch.sortOrder, 0),
          })
          .run();
      }

      // Timeline events (issue #63/#266) — campaign-scoped, no cross-refs.
      for (const ev of timelineEventRows) {
        tx.insert(timelineEvents)
          .values({
            campaignId: cid,
            title: str(ev.title, 'Untitled Event'),
            inWorldDate: str(ev.inWorldDate),
            body: str(ev.body),
            era: str(ev.era),
            sortIndex: intOr(ev.sortIndex, 0),
            dmSecret: str(ev.dmSecret),
            // #754: missing hidden on import → DM-only (same as create default).
            hidden: hiddenOf(ev.hidden),
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      // Timeline calendar (issue #63/#266) — one "current in-world date" row per campaign.
      // Only materialize when the export carried content (the module creates it lazily).
      const calendarDate = str(timelineCalendarSrc.currentDate);
      const calendarNote = str(timelineCalendarSrc.note);
      if (calendarDate || calendarNote) {
        tx.insert(timelineCalendars)
          .values({ campaignId: cid, currentDate: calendarDate, note: calendarNote, createdAt: ts, updatedAt: ts })
          .run();
      }

      // Session-zero / table charter (issue #122/#266) — one row per campaign. Insert
      // only when the export carried a non-empty charter (lazily created otherwise).
      const szLines = Array.isArray(sessionZeroSrc.lines) ? sessionZeroSrc.lines.filter((v): v is string => typeof v === 'string') : [];
      const szVeils = Array.isArray(sessionZeroSrc.veils) ? sessionZeroSrc.veils.filter((v): v is string => typeof v === 'string') : [];
      const szTools = Array.isArray(sessionZeroSrc.safetyTools)
        ? sessionZeroSrc.safetyTools.filter((v): v is string => typeof v === 'string')
        : [];
      const szHouseRules = str(sessionZeroSrc.houseRules);
      const szTone = str(sessionZeroSrc.toneAndExpectations);
      if (szLines.length || szVeils.length || szTools.length || szHouseRules || szTone) {
        tx.insert(sessionZero)
          .values({
            campaignId: cid,
            lines: JSON.stringify(szLines),
            veils: JSON.stringify(szVeils),
            safetyTools: JSON.stringify(szTools),
            houseRules: szHouseRules,
            toneAndExpectations: szTone,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      const libraryMonsterRows = asArr(doc.libraryMonsters);
      for (const lm of libraryMonsterRows) {
        const statblockObj = asRec(lm.statblock);
        tx.insert(campaignLibraryMonsters)
          .values({
            campaignId: cid,
            name: str(lm.name, 'Unnamed Monster'),
            statblockJson: JSON.stringify(statblockObj),
            sourceRuleEntryId: intOrNull(lm.sourceRuleEntryId),
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      const currentLocSrc = intOrNull(campaignSrc.currentLocationId);
      if (currentLocSrc != null) {
        const currentLocationId = locMap.get(currentLocSrc);
        if (currentLocationId != null) {
          tx.update(campaigns).set({ currentLocationId }).where(eq(campaigns.id, cid)).run();
        }
      }

      // Campaign map (issue #236): point at the imported map attachment's fresh id.
      const mapSrc = intOrNull(campaignSrc.mapAttachmentId);
      if (mapSrc != null) {
        const mapAttachmentId = attMap.get(mapSrc);
        if (mapAttachmentId != null) {
          tx.update(campaigns).set({ mapAttachmentId }).where(eq(campaigns.id, cid)).run();
        }
      }

      // AI seat + scribe config (issue #1078): restore from export with counters zeroed.
      if (aiSeatSrc && Object.keys(aiSeatSrc).length > 0) {
        tx.insert(aiDmSeats).values({
          campaignId: cid,
          // #1049: same classification as clone/export, but read through coercers — this side
          // parses untrusted JSON from an uploaded archive, not a typed row.
          ...readPortableAiSeat(aiSeatSrc as Record<string, unknown>, {
            str,
            boolOf,
            intOr,
            // An illegal block falls back to defaults rather than failing the whole archive —
            // but never silently, or the operator has no way to know their style was dropped.
            warn: (field, detail) => importLog.warn(`campaign ${cid}: ${detail} (${field})`),
          }),
          ...freshAiSeatCounters(),
          createdAt: ts,
          updatedAt: ts,
        }).run();
      }
      if (aiScribeConfigSrc && Object.keys(aiScribeConfigSrc).length > 0) {
        tx.insert(aiScribeConfigs).values({
          campaignId: cid,
          postSession: boolOf(aiScribeConfigSrc.postSession),
          cron: boolOf(aiScribeConfigSrc.cron),
          budgetPerRun: Math.max(0, intOr(aiScribeConfigSrc.budgetPerRun, 2000)),
          createdAt: ts,
          updatedAt: ts,
        }).run();
      }

      // Issue #725: fold the importer's dm membership AND the import audit row
      // INTO the same transaction as the entity rows. Previously these ran AFTER
      // the commit, so a failure here (a disabled user, a DB error) left a
      // fully-written campaign that the importer could not even SEE (no member
      // row) and/or a committed import with no audit trail. Now a throw rolls
      // the whole import back — no orphaned, inaccessible campaign.
      //
      // addCreatorAsDmTx is the transaction-aware variant of
      // MembersService.addCreatorAsDm() (same assignableUserTx validation: a
      // missing/disabled user throws, rolling the import back). Dev-auth users
      // skip membership (same rule as create()/clone()).
      if (!user.devRole) {
        const numericId = Number(user.id);
        if (Number.isInteger(numericId)) {
          this.members.addCreatorAsDmTx(tx, cid, numericId, ts);
        }
      }
      // Mirrors AuditService.log()'s insert, inlined so it shares the import's
      // atomic commit boundary (#725). The audit row lands with every entity row
      // or not at all.
      tx.insert(auditLog)
        .values({
          campaignId: cid,
          actor: auditActor(user),
          actorRole: 'dm',
          action: 'campaign.import',
          entityType: 'campaign',
          entityId: cid,
          detail:
            `imported "${name}" from a Campfire export` +
            // Issue #1326 review: record when the import-side equip-invariant
            // enforcement actually changed something, so a DM auditing the import
            // can see why an item they expected to be equipped is not.
            (equipIssuesResolved > 0
              ? ` (auto-unequipped ${equipIssuesResolved} inventory item${equipIssuesResolved === 1 ? '' : 's'} with an invalid or conflicting equip slot)`
              : ''),
          createdAt: ts,
        })
        .run();

      // Re-sync denormalized session stats from the rows actually imported (#841).
      // Publishable modules explicitly reset these to 0 so the module arrives
      // pristine; only recompute when the source document carried real play state
      // (missing fields in older exports, or actual recaps in played-state backups).
      const sessionCountSrc = Number(campaignSrc.sessionCount);
      const latestSessionSrc = Number(campaignSrc.latestSessionNumber);
      const bothExplicitZero =
        !Number.isNaN(sessionCountSrc) &&
        !Number.isNaN(latestSessionSrc) &&
        sessionCountSrc === 0 &&
        latestSessionSrc === 0;
      const hasRecapsInRows = sessionRows.some((s) => s.recap || s.playedAt);
      if (hasRecapsInRows || !bothExplicitZero) {
        this.sessions.recomputeSessionStatsInTx(tx, cid);
      }

      return cid;
    });

    // COMMITTED — every entity row + the dm membership + the audit row are
    // durable together. Now PUBLISH the staged attachment bytes by renaming each
    // staged file into its final uploadsRoot()/<cid>/<id>.<ext> location. A
    // rename is atomic per-file on the same filesystem (staging lives under the
    // same uploadsRoot()/.staging/ tree precisely so this holds). A failure here
    // degrades to the #84 "row-without-file" shape for THAT one file (the GET
    // route 404s it) — it can never leave a half-created campaign, because every
    // row already committed atomically.
    let attachmentsImported = 0;
    let attachmentsFailed = 0;
    const attachmentDetails: ImportAttachmentResult[] = [];
    for (const w of pendingWrites) {
      // finalRelPath was set inside the tx (named by the new row id); skip an
      // entry whose row never made it (e.g. an orphaned staged file).
      if (!w.finalRelPath) continue;
      const finalPath = path.join(uploadsRoot(), w.finalRelPath);
      const attachmentFile = attachmentFiles.find((a) => a.srcId === w.srcId);
      try {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        // rename is atomic on the same fs; fall back to writeBytes if the staged
        // file and final dir somehow aren't on the same volume (defensive — the
        // staging root is under uploadsRoot() so this branch should never fire,
        // but EXDEV must not crash the import post-commit).
        try {
          fs.renameSync(w.stagedPath, finalPath);
        } catch (renameErr) {
          if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
            fs.writeFileSync(finalPath, w.bytes);
            fs.rmSync(w.stagedPath, { force: true });
          } else {
            throw renameErr;
          }
        }
        attachmentsImported += 1;
        // The new attachment id is the final filename's leading integer.
        const rowId = Number.parseInt(path.basename(finalPath), 10);
        attachmentDetails.push({
          id: rowId,
          kind: attachmentFile?.kind ?? 'image',
          filename: attachmentFile?.filename ?? '',
          size: w.bytes.length,
        });
      } catch (err) {
        // Publish failed for this one file — the row is durable, the file is
        // not. This is the tolerated #84 shape (GET 404s the file), NOT a broken
        // import. Count it and continue with the remaining files.
        attachmentsFailed += 1;
        fs.rmSync(w.stagedPath, { force: true });
        // Surface in server logs so an operator can see which file degraded.
        importLog.warn(
          `import publish failed for attachment srcId=${w.srcId} -> ${w.finalRelPath}: ${
            err instanceof Error ? err.message : String(err)
          } (row committed; file will 404 until re-uploaded)`,
        );
      }
    }

    // #1049 review: same gap as clone — the seat row was inserted directly inside the import
    // transaction, so nothing told the in-memory proactive watcher it exists. An archive
    // carrying `proactiveSettings.enabled: true` would otherwise import as ON-but-inert.
    await this.aiDm.syncProactiveWatcher(newId);

    const campaign = await this.getOrThrow(newId);
    return {
      campaign,
      attachmentsImported,
      attachmentsSkipped: 0, // populated by importArchive (which knows the skip count)
      attachmentsFailed,
      attachmentDetails,
      compendiumPreflight,
      compendiumDetachedCount,
    };
    } finally {
      // Always sweep the staging dir, success OR failure. On success the staged
      // files were renamed away (consumed); on failure the tx rolled back and
      // the staged files are orphans. Either way nothing should remain here.
      cleanupStagingDir(stagingDir);
    }
  }

  /**
   * Import a campaign from a ZIP export (issue #236) — the round-trip that finally
   * carries maps and portraits across installs. A mdzip export (GET
   * /campaigns/:id/export?format=mdzip) packs the structured document at campaign.json
   * plus every attachment's bytes under uploads/<id>.<ext>. We read campaign.json as
   * the import document, pull the embedded bytes named by its attachments[] manifest,
   * and hand both to importCampaign — which recreates the rows AND remaps the
   * map/portrait references to the new attachment ids (see that method's doc).
   *
   * The bytes are validated the same way an upload is (magic-byte sniff + size cap):
   * a manifest entry with no file in the zip (a present=false / dangling reference) or
   * bytes that aren't a real png/jpeg/webp are simply skipped, so a hand-tampered or
   * partial archive imports its text without recreating a bogus attachment.
   */
  async importArchive(zipBuffer: Buffer, user: RequestUser, nameOverride?: string): Promise<ImportResult> {
    if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
      throw new BadRequestException('Empty upload — attach a Campfire .zip export.');
    }
    if (zipBuffer.length > MAX_IMPORT_ARCHIVE_BYTES) {
      throw new BadRequestException('Import archive is too large.');
    }

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipBuffer);
    } catch {
      throw new BadRequestException('That file is not a valid zip archive.');
    }

    const manifestFile = zip.file('campaign.json');
    if (!manifestFile) {
      throw new BadRequestException(
        'This zip is not a Campfire export (campaign.json is missing). Re-export with format=mdzip, or import the JSON export instead (text only, no maps/portraits).',
      );
    }

    let doc: unknown;
    try {
      doc = JSON.parse(await manifestFile.async('string'));
    } catch {
      throw new BadRequestException('campaign.json in the archive is not valid JSON.');
    }

    const parsed = CampaignImport.safeParse(doc);
    if (!parsed.success) {
      throw new BadRequestException('campaign.json is not a valid Campfire export document.');
    }
    const input: CampaignImportInput = nameOverride ? { ...parsed.data, name: nameOverride } : parsed.data;

    // Pull the embedded attachment bytes named by the manifest's attachments[] entries.
    // Issue #725: every manifest entry that does NOT yield a usable attachment file
    // (no id, no path, missing from the archive, empty/oversize, or wrong magic bytes)
    // is counted as SKIPPED so the ImportResult can report it — these never had a row
    // inserted, so there is no dangling reference, but the caller deserves to know a
    // map/portrait was dropped.
    const attachmentFiles: ImportAttachmentFile[] = [];
    let attachmentsSkipped = 0;
    for (const a of asArr(asRec(doc).attachments)) {
      const srcId = intOrNull(a.id);
      const archivePath = str(a.file);
      if (srcId == null || !archivePath) {
        attachmentsSkipped += 1;
        continue;
      }
      const entry = zip.file(archivePath);
      if (!entry) {
        attachmentsSkipped += 1; // present=false / dangling — no bytes were shipped
        continue;
      }
      const bytes = await entry.async('nodebuffer');
      if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
        attachmentsSkipped += 1;
        continue;
      }
      // Trust the bytes, not the manifest's declared mime: sniff exactly like an upload,
      // so only genuine png/jpeg/webp are stored (and the on-disk extension is correct).
      const mime = sniffImageMime(bytes);
      if (!mime) {
        attachmentsSkipped += 1;
        continue;
      }
      const checksumSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const declaredChecksum = str(a.checksumSha256);
      if (declaredChecksum && declaredChecksum !== checksumSha256) {
        attachmentsSkipped += 1;
        continue;
      }
      // Archives are untrusted input too. Parse provenance through the same bounded
      // current contract used by uploads/patches so an unsafe URL never becomes a
      // clickable Handouts link after import.
      const metadata = AttachmentMetadata.safeParse({
        title: str(a.title), caption: str(a.caption), altText: str(a.altText), creator: str(a.creator),
        sourceUrl: str(a.sourceUrl), license: str(a.license), rights: str(a.rights), attribution: str(a.attribution),
        checksumSha256: declaredChecksum || null,
      });
      if (!metadata.success) {
        attachmentsSkipped += 1;
        continue;
      }
      attachmentFiles.push({
        srcId,
        kind: str(a.kind, 'image'),
        filename: sanitizeAttachmentFilename(str(a.filename, `attachment-${srcId}`)),
        mime,
        bytes,
        ...metadata.data,
      });
    }

    const result = await this.importCampaign(input, user, attachmentFiles);
    // Fold the preflight skip count into the result (importCampaign only sees the
    // attachments that survived the sniff; the skip count is this layer's to report).
    return { ...result, attachmentsSkipped };
  }

  /**
   * Soft-delete (trash) a campaign (issue #116). This is now the DEFAULT of
   * DELETE /campaigns/:id: instead of the old irreversible hard-cascade + disk wipe
   * (any co-DM one confirm-click away from destroying months of play), we merely
   * stamp `deleted_at`. Every row and the on-disk upload directory survive intact;
   * the campaign just vanishes from normal listings (listForUser filters it) and its
   * GET/summary 404. It is fully restorable via restore(), and only the deliberate
   * second step purge() runs the real cascade + fs.rm. A no-op if already trashed
   * (getOrThrow without includeDeleted 404s a trashed campaign).
   */
  async remove(id: number, user: RequestUser, opts?: { revokeInvites?: boolean }): Promise<void> {
    await this.getOrThrow(id);
    const ts = nowIso();

    // Atomic trash+revoke: suspension, trash stamp, and invite-row deletion
    // commit together so a failed trash never leaves invites permanently gone
    // while the campaign stays live (#857 Bugbot).
    if (opts?.revokeInvites) {
      const { revoked, wasEnabled } = this.db.transaction((tx) => {
        const before = tx
          .select({ publicInvitesEnabled: campaigns.publicInvitesEnabled })
          .from(campaigns)
          .where(eq(campaigns.id, id))
          .limit(1)
          .get();
        tx.update(campaigns)
          .set({ publicInvitesEnabled: false, deletedAt: ts, updatedAt: ts })
          .where(eq(campaigns.id, id))
          .run();
        const deleted = tx
          .delete(campaignInvites)
          .where(eq(campaignInvites.campaignId, id))
          .returning({ id: campaignInvites.id })
          .all();
        return {
          revoked: deleted.length,
          wasEnabled: Boolean(before?.publicInvitesEnabled),
        };
      });
      if (wasEnabled) {
        await this.audit.log({
          actor: auditActor(user),
          actorRole: 'dm',
          action: 'invite.suspend',
          entityType: 'campaign',
          entityId: id,
          campaignId: id,
          detail: JSON.stringify({ reason: 'trash' }),
        });
      }
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'dm',
        action: 'invite.revoke_all',
        entityType: 'campaign',
        entityId: id,
        campaignId: id,
        detail: JSON.stringify({ revoked }),
      });
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'dm',
        action: 'campaign.delete',
        entityType: 'campaign',
        entityId: id,
        campaignId: id,
        detail: 'soft-delete (trashed)',
      });
    } else {
      // Suspend invites before stamping deletedAt so a concurrent preview/accept
      // that races the trash stamp still fails the publicInvitesEnabled gate (#857).
      await this.invites.suspendForCampaign(id, user, 'trash');
      const res = await this.db.update(campaigns).set({ deletedAt: ts, updatedAt: ts }).where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)));
      if (res.changes === 0) return;
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'dm',
        action: 'campaign.delete',
        entityType: 'campaign',
        entityId: id,
        campaignId: id,
        detail: 'soft-delete (trashed)',
      });
    }
    // Issue #1707: this used to live ONLY in the branch above (the `else`), so trashing a
    // campaign with `revokeInvites: true` (its own atomic transaction, returning early) never
    // reached either the SSE teardown or the notification below — an open tab on that
    // campaign kept a live-looking stream (no `campaign.trashed` control frame ever sent) and
    // no member ever got the account-wide signal either. Found while fixing the sibling gap
    // this issue is actually about; both trash paths now share this single tail so they can't
    // diverge again.
    //
    // Issue #867: tear down open SSE / AI narration streams so a stale tab cannot
    // keep receiving ticks for a frozen campaign. Control signal only.
    this.events.emit({ type: 'campaign.trashed', campaignId: id });

    // Issue #1707: the SSE teardown above only reaches a browser that already has THIS
    // campaign's stream open, and even then only a tab that reconnects and observes the
    // resulting 403/404 (see useCampaignEvents.ts for why trash specifically yields 404 for a
    // member, not 403, and how the client now treats that as terminal for this endpoint only).
    // A tab on the dashboard, a different campaign, or /admin gets nothing from that path at
    // all. This is the exact gap #1590/#1634/#1653 closed for role changes and membership
    // revocation, reusing the same account-wide notification backstop — see
    // CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES for why the usual "hide notifications about a
    // trashed campaign" read-side rule has to make an exception for this one type, and
    // notifyCampaign's `bypassBlockFilter` doc for why a member who has blocked the acting DM
    // still needs this signal (it is access-control, not sender content).
    //
    // `existing.name` deliberately NOT interpolated into the title (matches the #1653/Codex
    // hardening of `removed_from_campaign`, `members.service.ts#remove`): campaign names are
    // DM-editable, and this signal bypasses the #597 block filter by design, so including
    // actor-controlled text here would hand a blocked DM one unblockable channel to put
    // abusive content in front of a member who specifically blocked them to avoid it. The
    // notice stays generic; the cache invalidation is what matters.
    await this.notifications.notifyCampaign(
      id,
      user,
      {
        type: 'campaign_trashed',
        title: 'A campaign you were in was deleted',
        entityType: 'campaign',
        entityId: id,
      },
      { bypassBlockFilter: true },
    );
  }

  /**
   * Restore a trashed campaign (issue #116) — clears `deleted_at` so it returns to
   * normal listings with every child row + upload intact. 404 if the campaign
   * doesn't exist or isn't actually trashed (restoring a live campaign is a no-op error).
   *
   * Issue #867: the UPDATE is predicated on `deleted_at IS NOT NULL` so a concurrent
   * purge that commits first leaves restore as 404 (never resurrects a wiped row).
   */
  async restore(id: number, user: RequestUser): Promise<Campaign> {
    const [row] = await this.db
      .update(campaigns)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(and(eq(campaigns.id, id), isNotNull(campaigns.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException(`Campaign ${id} is not in the trash`);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'campaign.restore',
      entityType: 'campaign',
      entityId: id,
      campaignId: id,
    });
    return toDomain(row);
  }

  /**
   * Permanently purge a trashed campaign (issue #116 / #867) — the deliberate,
   * irreversible second step. Refused unless `deletedAt IS NOT NULL` and the caller
   * supplied `{ confirm: "PURGE" }`. Full cascade delete across EVERY campaign-scoped
   * table (issue #235). A concurrent restore that clears deletedAt first makes the
   * in-transaction gate fail closed (404). Retains a sanitized server-level tombstone
   * plus a campaignId-null admin audit row so purge evidence survives membership loss.
   */
  async purge(id: number, user: RequestUser, body: CampaignPurge): Promise<FsDeletionOutcome> {
    if (body.confirm !== CAMPAIGN_PURGE_CONFIRM_TOKEN) {
      throw new BadRequestException(
        `Purge is destructive — resend with the confirmation token "${CAMPAIGN_PURGE_CONFIRM_TOKEN}" in the "confirm" field`,
      );
    }

    const existing = await this.getOrThrow(id, { includeDeleted: true });
    if (existing.deletedAt == null) {
      throw new NotFoundException(`Campaign ${id} is not in the trash`);
    }

    const actor = auditActor(user);
    const requestedAt = nowIso();
    const campaignNameHash = crypto.createHash('sha256').update(existing.name).digest('hex');
    const [tombstone] = await this.db
      .insert(campaignPurgeTombstones)
      .values({
        campaignId: id,
        campaignNameHash,
        actor,
        status: 'requested',
        detail: '',
        requestedAt,
        completedAt: null,
      })
      .returning();

    const auditCtx = {
      scope: 'campaign_purge' as const,
      auditPrefix: 'campaign.purge',
      actor,
      actorRole: 'dm' as const,
      campaignId: id,
      entityType: 'campaign',
      entityId: id,
    };
    await this.fsDeletion.auditRequested(auditCtx);

    const campaignUploadsDir = path.join(uploadsRoot(), String(id));
    const plannedFsCleanup = await this.fsDeletion.reserveUploadPaths([campaignUploadsDir], auditCtx);


    // This hand-rolled cascade is the ONLY teardown mechanism on databases created
    // before FK enforcement shipped (issue #69) — SQLite cannot ALTER-ADD a foreign
    // key, so a pre-#69 DB carries no constraints and a bare `DELETE FROM campaigns`
    // would orphan every child. On a fresh DB the declared ON DELETE CASCADE would
    // handle all of this anyway (these explicit deletes are then FK-redundant no-ops,
    // fired before the parent rows they'd cascade from), but we must not RELY on that:
    // the list below therefore covers EVERY table that hangs off a campaign — directly
    // via campaign_id or transitively via a parent id (issue #235). When you add a new
    // campaign-scoped table, add it here too, and extend the db-cascades orphan test.
    //
    // audit_log is deliberately excluded (it must outlive the campaign — see bootstrap.sql).
    // campaign_purge_tombstones is also excluded (server-level evidence, issue #867).
    // The user/auth/oauth/rule-pack graphs are not campaign-scoped and are left untouched.

    // Two-hop children keyed off a parent id, not campaign_id — collect the parent ids
    // up front (same pattern as questIds/encounterIds before this change).
    const questIds = (await this.db.select({ id: quests.id }).from(quests).where(eq(quests.campaignId, id))).map((r) => r.id);
    const encounterIds = (await this.db.select({ id: encounters.id }).from(encounters).where(eq(encounters.campaignId, id))).map((r) => r.id);
    const sessionIds = (await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, id))).map((r) => r.id);
    const scheduledSessionIds = (
      await this.db.select({ id: scheduledSessions.id }).from(scheduledSessions).where(eq(scheduledSessions.campaignId, id))
    ).map((r) => r.id);
    const storyBeatIds = (await this.db.select({ id: storyBeats.id }).from(storyBeats).where(eq(storyBeats.campaignId, id))).map((r) => r.id);
    // #588: series_exceptions hangs off session_series, not off campaign_id.
    const seriesIds = (
      await this.db.select({ id: sessionSeries.id }).from(sessionSeries).where(eq(sessionSeries.campaignId, id))
    ).map((r) => r.id);

    try {
      this.db.transaction((tx) => {
        // Atomic trash gate (issue #867): refuse if a concurrent restore cleared
        // deletedAt (or the row is already gone). Checked inside the same transaction
        // that destroys children so restore-vs-purge cannot interleave mid-cascade.
        const stillTrashed = tx
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(and(eq(campaigns.id, id), isNotNull(campaigns.deletedAt)))
          .limit(1)
          .all();
        if (stillTrashed.length === 0) {
          throw new NotFoundException(`Campaign ${id} is not in the trash`);
        }

        // ---- two-hop children first (keyed off a parent id, no campaign_id of their own).
        // Guard the empty case: `inArray(col, [])` is a degenerate/invalid IN clause and
        // there is nothing to delete anyway.
        if (questIds.length > 0) {
          tx.delete(questObjectives).where(inArray(questObjectives.questId, questIds)).run();
        }
        if (encounterIds.length > 0) {
          tx.delete(combatants).where(inArray(combatants.encounterId, encounterIds)).run();
          tx.delete(encounterEvents).where(inArray(encounterEvents.encounterId, encounterIds)).run();
        }
        if (sessionIds.length > 0) {
          tx.delete(sessionAttendees).where(inArray(sessionAttendees.sessionId, sessionIds)).run();
        }
        if (scheduledSessionIds.length > 0) {
          tx.delete(sessionRsvps).where(inArray(sessionRsvps.scheduledSessionId, scheduledSessionIds)).run();
        }
        if (seriesIds.length > 0) {
          tx.delete(seriesExceptions).where(inArray(seriesExceptions.seriesId, seriesIds)).run();
        }
        if (storyBeatIds.length > 0) {
          tx.delete(storyBranches).where(inArray(storyBranches.beatId, storyBeatIds)).run();
        }

        // ---- everything keyed directly off campaign_id.
        // Issue #585 — campaign module install/lineage rows and their per-artifact
        // baselines/snapshots. Deleted BEFORE the entities they reference so the
        // hand-rolled cascade leaves no orphaned baseline behind on a pre-#69 DB.
        tx.delete(campaignModuleSnapshots).where(eq(campaignModuleSnapshots.campaignId, id)).run();
        tx.delete(campaignModuleArtifacts).where(eq(campaignModuleArtifacts.campaignId, id)).run();
        tx.delete(campaignModuleInstalls).where(eq(campaignModuleInstalls.campaignId, id)).run();
        tx.delete(quests).where(eq(quests.campaignId, id)).run();
        tx.delete(storyBeats).where(eq(storyBeats.campaignId, id)).run();
        tx.delete(storyArcs).where(eq(storyArcs.campaignId, id)).run();
        tx.delete(timelineEvents).where(eq(timelineEvents.campaignId, id)).run();
        tx.delete(timelineCalendars).where(eq(timelineCalendars.campaignId, id)).run();
        tx.delete(sessionZero).where(eq(sessionZero.campaignId, id)).run();
        tx.delete(participantSupportPreferences).where(eq(participantSupportPreferences.campaignId, id)).run();
        tx.delete(encounters).where(eq(encounters.campaignId, id)).run();
        tx.delete(npcs).where(eq(npcs.campaignId, id)).run();
        tx.delete(factions).where(eq(factions.campaignId, id)).run();
        tx.delete(locations).where(eq(locations.campaignId, id)).run();
        tx.delete(characters).where(eq(characters.campaignId, id)).run();
        tx.delete(notes).where(eq(notes.campaignId, id)).run();
        tx.delete(comments).where(eq(comments.campaignId, id)).run();
        tx.delete(entityRevisions).where(eq(entityRevisions.campaignId, id)).run();
        tx.delete(sessionShares).where(eq(sessionShares.campaignId, id)).run();
        tx.delete(castSessions).where(eq(castSessions.campaignId, id)).run();
        tx.delete(sessions).where(eq(sessions.campaignId, id)).run();
        tx.delete(scheduledSessions).where(eq(scheduledSessions.campaignId, id)).run();
        // #588: after the occurrences, so the series has no live children left.
        // Venues/rooms are install-level shared resources and are deliberately
        // NOT touched — purging a campaign must not remove a room other campaigns
        // are booked into.
        tx.delete(sessionSeries).where(eq(sessionSeries.campaignId, id)).run();
        tx.delete(proposals).where(eq(proposals.campaignId, id)).run();
        tx.delete(campaignGuestDmGrants).where(eq(campaignGuestDmGrants.campaignId, id)).run();
        tx.delete(campaignMembers).where(eq(campaignMembers.campaignId, id)).run();
        tx.delete(campaignInvites).where(eq(campaignInvites.campaignId, id)).run();
        tx.delete(apiTokens).where(eq(apiTokens.campaignId, id)).run();
        tx.delete(attachments).where(eq(attachments.campaignId, id)).run();
        tx.delete(diceRolls).where(eq(diceRolls.campaignId, id)).run();
        tx.delete(notifications).where(eq(notifications.campaignId, id)).run();
        tx.delete(inventoryItems).where(eq(inventoryItems.campaignId, id)).run();
        tx.delete(partyTreasury).where(eq(partyTreasury.campaignId, id)).run();
        tx.delete(aiDriverControlState).where(eq(aiDriverControlState.campaignId, id)).run();
        // #599 — the table safety hold row. Explicit like every other campaign-scoped table:
        // legacy databases predate the FK cascade, so purge cannot rely on it.
        tx.delete(tableSafetyHolds).where(eq(tableSafetyHolds.campaignId, id)).run();
        tx.delete(aiDmSeats).where(eq(aiDmSeats.campaignId, id)).run();

        tx.delete(campaigns).where(eq(campaigns.id, id)).run();
      });
    } catch (err) {
      const completedAt = nowIso();
      const detail = err instanceof Error ? err.message : String(err);
      await this.db
        .update(campaignPurgeTombstones)
        .set({ status: 'failed', detail: detail.slice(0, 500), completedAt })
        .where(eq(campaignPurgeTombstones.id, tombstone.id));
      await this.audit.log({
        actor,
        actorRole: 'dm',
        action: 'campaign.purge',
        entityType: 'campaign',
        entityId: id,
        campaignId: null,
        detail: JSON.stringify({
          tombstoneId: tombstone.id,
          campaignId: id,
          campaignNameHash,
          status: 'failed',
          requestedAt,
          completedAt,
        }),
      });
      throw err;
    }

    await this.fsDeletion.auditMetadataComplete(auditCtx);

    let outcome;
    let fsDetail = '';
    try {
      outcome = await this.fsDeletion.completeReservedUploadPaths(plannedFsCleanup, auditCtx);
    } catch (err) {
      fsDetail = err instanceof Error ? err.message : String(err);
      const completedAt = nowIso();
      await this.audit.log({
        actor,
        actorRole: 'dm',
        action: 'campaign.purge',
        entityType: 'campaign',
        entityId: id,
        campaignId: null,
        detail: JSON.stringify({
          tombstoneId: tombstone.id,
          campaignId: id,
          campaignNameHash,
          status: 'failed',
          requestedAt,
          completedAt,
          fsError: fsDetail.slice(0, 500),
        }),
      });
      await this.db
        .update(campaignPurgeTombstones)
        .set({ status: 'failed', detail: fsDetail.slice(0, 500), completedAt })
        .where(eq(campaignPurgeTombstones.id, tombstone.id));
      throw err;
    }

    const completedAt = nowIso();
    // Server-level audit (campaignId null) so the purge remains discoverable after
    // memberships — and therefore GET /campaigns/:id/audit — are gone (issue #867).
    await this.audit.log({
      actor,
      actorRole: 'dm',
      action: 'campaign.purge',
      entityType: 'campaign',
      entityId: id,
      campaignId: null,
      detail: JSON.stringify({
        tombstoneId: tombstone.id,
        campaignId: id,
        campaignNameHash,
        status: 'completed',
        requestedAt,
        completedAt,
      }),
    });
    await this.db
      .update(campaignPurgeTombstones)
      .set({ status: 'completed', completedAt })
      .where(eq(campaignPurgeTombstones.id, tombstone.id));

    return outcome;
  }

  async summary(id: number, user: RequestUser, role: Role): Promise<CampaignSummary> {
    const campaign = await this.getOrThrow(id);

    // Issue #602: `inventoryCount` and `commentCount` are plain integers, and the
    // dashboard re-reads this projection on a timer — so they are counted in SQL rather
    // than by loading every inventory item and every comment body only to take `.length`.
    // Both counters keep the predicates (and, for comments, the anchor-visibility
    // redaction) their list counterparts applied, so the numbers are unchanged; the rows
    // simply never leave SQLite.
    //
    // Measured capacity (better-sqlite3, one campaign, mean of 5 runs):
    //   inventory  5k rows: 48.1ms -> 1.0ms      20k rows: 346.6ms ->  3.7ms
    //   comments   5k rows: 244.8ms -> 55.4ms    20k rows: 656.0ms -> 31.1ms
    // So at 20k/20k these two calls alone were costing ~1.0s of CPU per summary — and
    // the dashboard re-reads this projection on a timer, per open tab. The cost shape
    // changed, not just the constant: inventory is now a single indexed aggregate, and
    // the comment count scales with the number of DISTINCT commented entities (one
    // visibility check each) rather than with the number of comments, which is why 20k
    // comments over the same 50 anchors is no dearer than 5k.
    //
    // NOT addressed here: the nine remaining full-collection loads below. `timeline`
    // in particular is still unbounded (`listEvents` has no LIMIT, unlike the
    // `listEventsPage` beside it), and bounding it would change a payload that MCP and
    // the AI driver also read — a contract decision, not a hot-path cleanup.
    const [questList, npcList, locationList, characterList, partyRoster, sessionList, encounterDigest, timelineList, treasury, inventoryCount, commentCount, scheduleNow] =
      await Promise.all([
        this.quests.listForCampaignWithObjectives(id, role),
        this.npcs.listForCampaign(id, role),
        this.locations.listForCampaign(id, role),
        this.characters.listForCampaign(id, user, role),
        this.characters.partyRosterForCampaign(id),
        this.sessions.listForCampaign(id, role),
        this.encounters.digestForCampaign(id, role),
        // Newer systems (issue #257): each applies its own role redaction (timeline strips
        // dmSecret + drops hidden for non-DM; comments inherit anchor-entity visibility).
        this.timeline.listEvents(id, role),
        this.inventory.getTreasury(id),
        this.inventory.countForCampaign(id),
        this.comments.countForCampaign(id, role),
        // Issue #818: keep the in-progress game night separate from the later upcoming one.
        this.scheduling.currentAndNextForCampaign(id, role),
      ]);

    const currentLocation = campaign.currentLocationId
      ? (locationList.find((l) => l.id === campaign.currentLocationId) ?? null)
      : null;

    // issue #71: count in SQL instead of loading every note row (incl. bodies) into
    // JS just to count the open inbox items.
    const [{ value: openInboxCount }] = await this.db
      .select({ value: count() })
      .from(notes)
      .where(and(eq(notes.campaignId, id), eq(notes.kind, 'inbox'), eq(notes.resolved, false), notDeleted(notes.deletedAt)));

    return {
      campaign,
      currentLocation,
      quests: questList,
      npcs: npcList,
      locations: locationList,
      characters: characterList,
      party: partyRoster,
      sessions: sessionList,
      encounters: encounterDigest,
      timeline: timelineList,
      treasury: { cp: treasury.cp, sp: treasury.sp, ep: treasury.ep, gp: treasury.gp, pp: treasury.pp },
      inventoryCount,
      commentCount,
      inProgressSession: scheduleNow.inProgressSession,
      nextSession: scheduleNow.nextSession,
      openInboxCount,
    };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import JSZip from 'jszip';
import type { z } from 'zod';
import { CampaignClone, CampaignCreate, CampaignImport, CampaignUpdate } from '@campfire/schema';
import type { Campaign, CampaignSummary, Role } from '@campfire/schema';
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
  apiTokens,
  attachments,
  rulePacks,
  storyArcs,
  storyBeats,
  storyBranches,
  timelineEvents,
  timelineCalendars,
  sessionZero,
  factions,
  sessionAttendees,
  sessionShares,
  scheduledSessions,
  sessionRsvps,
  comments,
  entityRevisions,
  campaignInvites,
  diceRolls,
  notifications,
  inventoryItems,
  partyTreasury,
  aiDmSeats,
  encounterEvents,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { AuditService } from '../audit/audit.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { CharactersService } from '../characters/characters.service';
import { SessionsService } from '../sessions/sessions.service';
import { EncountersService } from '../encounters/encounters.service';
import { RoleResolver } from '../membership/role-resolver.service';
import { MembersService } from '../membership/members.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { ALLOWED_MIME_TO_EXT, MAX_UPLOAD_BYTES, sniffImageMime } from '../attachments/attachments.service';

/** Mirrors AttachmentsService's private helper — see modules/attachments/attachments.service.ts. */
function uploadsRoot(): string {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data');
  return path.join(dataDir, 'uploads');
}

/** Generous cap on an uploaded import archive: several full-size (8MB) maps + text. */
const MAX_IMPORT_ARCHIVE_BYTES = 128 * 1024 * 1024;

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
const realOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOf = (v: unknown): boolean => v === true;
/** Serialize a JSON-ish export field (object/array) back to the TEXT the column stores. */
const jsonCol = (v: unknown, fallback: string): string => {
  if (v === undefined || v === null) return fallback;
  try {
    return JSON.stringify(v);
  } catch {
    return fallback;
  }
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
    sessionCount: row.sessionCount,
    ruleSystem: row.ruleSystem,
    mapAttachmentId: row.mapAttachmentId,
    storageQuotaBytes: row.storageQuotaBytes ?? null,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly characters: CharactersService,
    private readonly sessions: SessionsService,
    private readonly encounters: EncountersService,
    private readonly roleResolver: RoleResolver,
    private readonly members: MembersService,
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
   * Fetch a campaign by id. By default a trashed campaign is invisible (404), same as
   * a nonexistent one — every normal GET/summary path funnels through here. The
   * restore/purge paths pass `{ includeDeleted: true }` so they can act on a trashed row.
   */
  async getOrThrow(id: number, opts?: { includeDeleted?: boolean }): Promise<Campaign> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row || (!opts?.includeDeleted && row.deletedAt != null)) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }
    return toDomain(row);
  }

  /**
   * A non-empty ruleSystem must name an installed rule pack (rule_packs.slug) — otherwise
   * a campaign could point at a system that doesn't exist, silently breaking anything
   * downstream (Compendium lookups scoped by pack slug) that assumes it resolves.
   * Empty string ('' — "no rule system picked") is always allowed, both on create and
   * when clearing it back via PATCH.
   */
  private async validateRuleSystem(ruleSystem: string | undefined): Promise<void> {
    if (!ruleSystem) return;
    const [pack] = await this.db.select({ id: rulePacks.id }).from(rulePacks).where(eq(rulePacks.slug, ruleSystem)).limit(1);
    if (!pack) {
      throw new BadRequestException(`ruleSystem "${ruleSystem}" does not match any installed rule pack`);
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
      .where(and(eq(attachments.id, attachmentId), eq(attachments.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`mapAttachmentId ${attachmentId} does not exist in this campaign`);
  }

  /** Any authenticated user may create a campaign; creator is auto-inserted as 'dm' (skipped for dev:* users). */
  async create(input: CampaignCreateInput, user: RequestUser): Promise<Campaign> {
    await this.validateRuleSystem(input.ruleSystem);
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
        sessionCount: 0,
        ruleSystem: input.ruleSystem ?? '',
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

  async update(id: number, input: CampaignUpdateInput, user: RequestUser): Promise<Campaign> {
    const existing = await this.getOrThrow(id);
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
    await this.validateRuleSystem(input.ruleSystem);
    await this.validateLocationRef(input.currentLocationId, id);
    await this.validateAttachmentRef(input.mapAttachmentId, id);
    // Assigning a map as the campaign background is an explicit, DM-only act of
    // sharing it with the whole party — the background renders for every member.
    // Attachments now default to DM-only (issue #97), so reveal the newly-wired
    // map here, otherwise players would 404 on the background image they're meant
    // to see. (Clearing the map to null doesn't re-hide — reveal is one-way here.)
    if (input.mapAttachmentId != null) {
      await this.db
        .update(attachments)
        .set({ hidden: false, updatedAt: nowIso() })
        .where(and(eq(attachments.id, input.mapAttachmentId), eq(attachments.campaignId, id)));
    }
    const [row] = await this.db
      .update(campaigns)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(campaigns.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'campaign.update',
      entityType: 'campaign',
      entityId: id,
      campaignId: id,
    });
    return toDomain(row);
  }

  /**
   * Clone a campaign into a brand-new one owned by the caller (issue #17 —
   * campaign templates / cloning). Two modes:
   *
   *  - 'full' (default): faithful duplicate — quests (+objectives), npcs,
   *    locations, characters, sessions, notes and encounters (+combatants),
   *    with every intra-campaign reference (quest parent/giver, npc location,
   *    combatant character, note entity link, campaign currentLocationId)
   *    remapped to the cloned rows' new ids.
   *  - 'template': prep only — quests/npcs/locations copied but play state
   *    stripped: quest statuses reset to 'available', objectives unchecked,
   *    locations back to 'unexplored', and sessions/notes/characters/
   *    encounters/session-count/current-location not copied at all.
   *
   * Never copied in either mode: members (only the caller becomes dm — cloning
   * must not silently grant other users access to the new campaign), api
   * tokens, audit history, proposals, and attachments (their bytes live on
   * disk keyed by campaign id; mapAttachmentId is therefore reset to null).
   * Other members' private notes are also excluded — same visibility rule as
   * GET /notes and the export module: the cloning dm cannot read them, so the
   * clone must not carry them either.
   *
   * All inserts run in one synchronous db.transaction() (better-sqlite3 —
   * same pattern as remove()/RulesService.installOpen5eSrd), so a mid-clone
   * failure never leaves a half-copied campaign behind.
   */
  async clone(id: number, input: CampaignCloneInput, user: RequestUser): Promise<Campaign> {
    const source = await this.getOrThrow(id);
    const template = input.mode === 'template';
    const name = (input.name ?? `${source.name} (copy)`).slice(0, 120);

    // Read everything up front — only the writes need the transaction. Trashed
    // (soft-deleted, #116) entities are excluded so a clone never resurrects them.
    const [locationRows, npcRows, questRows, characterRows, sessionRows, noteRows, encounterRows] = await Promise.all([
      this.db.select().from(locations).where(and(eq(locations.campaignId, id), notDeleted(locations.deletedAt))),
      this.db.select().from(npcs).where(and(eq(npcs.campaignId, id), notDeleted(npcs.deletedAt))),
      this.db.select().from(quests).where(and(eq(quests.campaignId, id), notDeleted(quests.deletedAt))),
      this.db.select().from(characters).where(and(eq(characters.campaignId, id), notDeleted(characters.deletedAt))),
      this.db.select().from(sessions).where(and(eq(sessions.campaignId, id), notDeleted(sessions.deletedAt))),
      this.db.select().from(notes).where(and(eq(notes.campaignId, id), notDeleted(notes.deletedAt))),
      this.db.select().from(encounters).where(eq(encounters.campaignId, id)),
    ]);
    const questIds = questRows.map((r) => r.id);
    const objectiveRows = questIds.length
      ? await this.db.select().from(questObjectives).where(inArray(questObjectives.questId, questIds))
      : [];
    const encounterIds = encounterRows.map((r) => r.id);
    const combatantRows = encounterIds.length
      ? await this.db.select().from(combatants).where(inArray(combatants.encounterId, encounterIds))
      : [];

    const ts = nowIso();
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
          sessionCount: template ? 0 : source.sessionCount,
          ruleSystem: source.ruleSystem,
          mapAttachmentId: null, // attachments (on-disk files) are not cloned
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
            body: n.body,
            dmSecret: n.dmSecret,
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

      if (!template) {
        const charMap = new Map<number, number>();
        for (const c of characterRows) {
          const [row] = tx
            .insert(characters)
            .values({
              campaignId: cloneId,
              ownerUserId: c.ownerUserId,
              name: c.name,
              species: c.species,
              className: c.className,
              level: c.level,
              background: c.background,
              stats: c.stats,
              ac: c.ac,
              hpCurrent: c.hpCurrent,
              hpMax: c.hpMax,
              conditions: c.conditions,
              portraitUrl: c.portraitUrl,
              ddbId: c.ddbId,
              notes: c.notes,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          charMap.set(c.id, row.id);
        }

        const sessionMap = new Map<number, number>();
        for (const s of sessionRows) {
          const [row] = tx
            .insert(sessions)
            .values({
              campaignId: cloneId,
              number: s.number,
              title: s.title,
              playedAt: s.playedAt,
              recap: s.recap,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          sessionMap.set(s.id, row.id);
        }

        const entityMaps: Record<string, Map<number, number>> = {
          quest: questMap,
          npc: npcMap,
          location: locMap,
          character: charMap,
          session: sessionMap,
        };
        for (const n of noteRows) {
          // Other members' private notes are invisible to the cloning dm — exclude
          // them (same rule as NotesService.listForCampaign / the export module).
          if (n.visibility === 'private' && n.authorUserId !== user.id) continue;
          let entityType = n.entityType;
          let entityId: number | null = null;
          if (n.entityType === 'campaign') {
            entityId = cloneId;
          } else if (n.entityType != null && n.entityId != null) {
            entityId = entityMaps[n.entityType]?.get(n.entityId) ?? null;
            if (entityId == null) entityType = null; // dangling link in the source — drop it, don't point at a stale id
          }
          tx.insert(notes)
            .values({
              campaignId: cloneId,
              authorUserId: n.authorUserId,
              authorName: n.authorName,
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
            .run();
        }

        for (const e of encounterRows) {
          const [row] = tx
            .insert(encounters)
            .values({
              campaignId: cloneId,
              name: e.name,
              status: e.status,
              round: e.round,
              turnIndex: e.turnIndex,
              endedAt: e.endedAt,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .all();
          for (const c of combatantRows) {
            if (c.encounterId !== e.id) continue;
            tx.insert(combatants)
              .values({
                encounterId: row.id,
                kind: c.kind,
                characterId: c.characterId != null ? (charMap.get(c.characterId) ?? null) : null,
                name: c.name,
                initiative: c.initiative,
                initMod: c.initMod,
                hpCurrent: c.hpCurrent,
                hpMax: c.hpMax,
                conditions: c.conditions,
                ruleEntryId: c.ruleEntryId, // compendium entries are server-global — no remap needed
                sortOrder: c.sortOrder,
              })
              .run();
          }
        }

        if (source.currentLocationId != null) {
          const currentLocationId = locMap.get(source.currentLocationId);
          if (currentLocationId != null) {
            tx.update(campaigns).set({ currentLocationId }).where(eq(campaigns.id, cloneId)).run();
          }
        }
      }

      return cloneId;
    });

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
   * All writes run in one synchronous db.transaction() (better-sqlite3), so a
   * mid-import failure never leaves a half-created campaign behind.
   */
  async importCampaign(
    input: CampaignImportInput,
    user: RequestUser,
    attachmentFiles: ImportAttachmentFile[] = [],
  ): Promise<Campaign> {
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

    const locationRows = asArr(doc.locations);
    const npcRows = asArr(doc.npcs);
    const questRows = asArr(doc.quests);
    const characterRows = asArr(doc.characters);
    const sessionRows = asArr(doc.sessions);
    const noteRows = asArr(doc.notes);
    const encounterRows = asArr(doc.encounters);
    // Issue #266: entity types the export used to drop wholesale — now recreated with
    // fresh ids and intra-campaign refs remapped (npc→faction, beat→arc, branch→beat).
    const factionRows = asArr(doc.factions);
    const storyArcRows = asArr(doc.storyArcs);
    const timelineEventRows = asArr(doc.timelineEvents);
    const inventoryRows = asArr(doc.inventory);
    const timelineCalendarSrc = asRec(doc.timelineCalendar);
    const sessionZeroSrc = asRec(doc.sessionZero);
    const treasurySrc = asRec(doc.treasury);

    const importerId = String(user.id);
    const ts = nowIso();

    // Attachment bytes are written to disk AFTER the transaction commits (a DB
    // rollback can't un-write a file, so we defer the fs writes until the rows are
    // durable). srcAttachmentId -> new attachment id, populated inside the tx.
    const pendingWrites: { filePath: string; bytes: Buffer }[] = [];
    const attMap = new Map<number, number>();
    /** Rewrite a source portraitUrl (…/attachments/<srcId>/file) to point at the freshly imported attachment. */
    const remapPortraitUrl = (url: unknown): string | null => {
      if (typeof url !== 'string') return null;
      const m = url.match(/\/attachments\/(\d+)\/file(?:[?#].*)?$/);
      if (!m) return null;
      const newId = attMap.get(Number(m[1]));
      return newId != null ? `/api/v1/attachments/${newId}/file` : null;
    };

    const newId = this.db.transaction((tx) => {
      const [campaignRow] = tx
        .insert(campaigns)
        .values({
          name,
          description: str(campaignSrc.description),
          status: 'active', // imported campaigns start editable even if the source was archived
          currentLocationId: null, // remapped below
          dangerLevel: str(campaignSrc.dangerLevel, 'low'),
          sessionCount: Math.max(0, intOr(campaignSrc.sessionCount, 0)),
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
            // Secure default (#97): maps/images land DM-only, portraits stay player-visible.
            hidden: a.kind !== 'portrait',
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        attMap.set(a.srcId, row.id);
        const ext = ALLOWED_MIME_TO_EXT[a.mime] ?? 'bin';
        pendingWrites.push({ filePath: path.join(uploadsRoot(), String(cid), `${row.id}.${ext}`), bytes: a.bytes });
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
            hidden: boolOf(f.hidden),
            reputation: intOr(f.reputation, 0),
            standing: str(f.standing, 'neutral'),
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
            hidden: boolOf(n.hidden),
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
            hidden: boolOf(q.hidden),
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
            hpCurrent: intOr(c.hpCurrent, 10),
            hpMax: intOr(c.hpMax, 10),
            conditions: jsonCol(c.conditions, '[]'),
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
      for (const item of inventoryRows) {
        const ownerType = str(item.ownerType, 'party') === 'character' ? 'character' : 'party';
        const charSrc = intOrNull(item.characterId);
        const mappedChar = charSrc != null ? (charMap.get(charSrc) ?? null) : null;
        const resolvedOwner = ownerType === 'character' && mappedChar != null ? 'character' : 'party';
        tx.insert(inventoryItems)
          .values({
            campaignId: cid,
            ownerType: resolvedOwner,
            characterId: resolvedOwner === 'character' ? mappedChar : null,
            name: str(item.name, 'Item'),
            qty: intOr(item.qty, 1),
            notes: str(item.notes),
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

      const entityMaps: Record<string, Map<number, number>> = {
        quest: questMap,
        npc: npcMap,
        location: locMap,
        character: charMap,
        session: sessionMap,
      };
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
        tx.insert(notes)
          .values({
            campaignId: cid,
            authorUserId: importerId, // author ids are per-install — the importer owns imported notes
            authorName: str(n.authorName),
            kind: str(n.kind, 'note'),
            visibility: str(n.visibility, 'private'),
            entityType,
            entityId,
            body: str(n.body),
            resolved: boolOf(n.resolved),
            resolvedNote: str(n.resolvedNote),
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      for (const e of encounterRows) {
        const [row] = tx
          .insert(encounters)
          .values({
            campaignId: cid,
            name: str(e.name, 'Encounter'),
            status: str(e.status, 'preparing'),
            round: intOr(e.round, 0),
            turnIndex: intOr(e.turnIndex, 0),
            currentCombatantId: null, // remapped below once combatants have fresh ids
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
            fog: e.fog == null ? null : jsonCol(e.fog, ''),
            endedAt: typeof e.endedAt === 'string' ? e.endedAt : null,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        // Map each source combatant id to its fresh id so the encounter's current-turn
        // pointer (identity-based, issue #49) can be remapped.
        const combatantIdMap = new Map<number, number>();
        for (const c of asArr(e.combatants)) {
          const cSrcId = intOrNull(c.id);
          const charSrc = intOrNull(c.characterId);
          const [cRow] = tx
            .insert(combatants)
            .values({
              encounterId: row.id,
              kind: str(c.kind, 'monster'),
              characterId: charSrc != null ? (charMap.get(charSrc) ?? null) : null,
              name: str(c.name, 'Combatant'),
              initiative: intOrNull(c.initiative),
              initMod: intOr(c.initMod, 0),
              hpCurrent: intOr(c.hpCurrent, 10),
              hpMax: intOr(c.hpMax, 10),
              conditions: jsonCol(c.conditions, '[]'),
              ruleEntryId: intOrNull(c.ruleEntryId), // compendium is server-global — best-effort, may dangle
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
            hidden: boolOf(ev.hidden),
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

      return cid;
    });

    // Rows are durable — now write each imported attachment's bytes to disk under the
    // new campaign's uploads dir. A failed write leaves a row-without-file (the #84
    // tolerated shape: the GET route 404s that one file), never a broken import.
    for (const w of pendingWrites) {
      try {
        fs.mkdirSync(path.dirname(w.filePath), { recursive: true });
        fs.writeFileSync(w.filePath, w.bytes);
      } catch {
        /* best-effort — the DB row is the source of truth; a missing file is handled by #84 */
      }
    }

    // Same membership rule as create()/clone(): the caller becomes the new campaign's dm.
    if (!user.devRole) {
      const numericId = Number(user.id);
      if (Number.isInteger(numericId)) {
        await this.members.addCreatorAsDm(newId, numericId);
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'campaign.import',
      entityType: 'campaign',
      entityId: newId,
      campaignId: newId,
      detail: `imported "${name}" from a Campfire export`,
    });
    return this.getOrThrow(newId);
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
  async importArchive(zipBuffer: Buffer, user: RequestUser, nameOverride?: string): Promise<Campaign> {
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
    const attachmentFiles: ImportAttachmentFile[] = [];
    for (const a of asArr(asRec(doc).attachments)) {
      const srcId = intOrNull(a.id);
      const archivePath = str(a.file);
      if (srcId == null || !archivePath) continue;
      const entry = zip.file(archivePath);
      if (!entry) continue; // present=false / dangling — no bytes were shipped
      const bytes = await entry.async('nodebuffer');
      if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) continue;
      // Trust the bytes, not the manifest's declared mime: sniff exactly like an upload,
      // so only genuine png/jpeg/webp are stored (and the on-disk extension is correct).
      const mime = sniffImageMime(bytes);
      if (!mime) continue;
      attachmentFiles.push({
        srcId,
        kind: str(a.kind, 'image'),
        filename: str(a.filename, `attachment-${srcId}`).slice(0, 255),
        mime,
        bytes,
      });
    }

    return this.importCampaign(input, user, attachmentFiles);
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
  async remove(id: number, user: RequestUser): Promise<void> {
    await this.getOrThrow(id);
    await this.db.update(campaigns).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(campaigns.id, id));
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

  /**
   * Restore a trashed campaign (issue #116) — clears `deleted_at` so it returns to
   * normal listings with every child row + upload intact. 404 if the campaign
   * doesn't exist or isn't actually trashed (restoring a live campaign is a no-op error).
   */
  async restore(id: number, user: RequestUser): Promise<Campaign> {
    const existing = await this.getOrThrow(id, { includeDeleted: true });
    if (existing.deletedAt == null) throw new NotFoundException(`Campaign ${id} is not in the trash`);
    const [row] = await this.db
      .update(campaigns)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(eq(campaigns.id, id))
      .returning();
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
   * Permanently purge a campaign (issue #116) — the deliberate, irreversible second
   * step that the old one-click DELETE used to be. Full cascade delete across EVERY
   * campaign-scoped table (issue #235): a pre-#69 DB carries no FK constraints (SQLite
   * can't ALTER-ADD one) so this hand cascade is its ONLY teardown, and it previously
   * covered only ~12 of the ~30 child tables — leaving story_arcs/beats/branches,
   * timeline_events/calendars, session_zero, factions, session_shares/attendees,
   * scheduled_sessions/rsvps, comments, entity_revisions, campaign_invites, dice_rolls,
   * notifications, inventory_items, party_treasury, ai_dm_seats and encounter_events
   * orphaned. The list is now complete (see the in-body comment + the db-cascades test).
   * All DB rows are removed in one db.transaction() (better-sqlite3 synchronous transaction
   * API — same pattern as QuestsService.remove()/RulesService.uninstall()), with the
   * campaigns row cleared last so a mid-transaction failure never leaves an
   * orphaned-but-still-"deleted"-looking campaign.
   * The on-disk upload directory is removed after the transaction commits (best-effort,
   * mirroring AttachmentsService.remove()'s fs.rm — the DB is the source of truth for what
   * exists; a stray directory is harmless, but we still try synchronously here since this is
   * a rarer, heavier operation than a single attachment delete). Purge acts on live OR
   * trashed campaigns (includeDeleted) so the disk wipe can only ever run through here.
   */
  async purge(id: number, user: RequestUser): Promise<void> {
    await this.getOrThrow(id, { includeDeleted: true });

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

    this.db.transaction((tx) => {
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
      if (storyBeatIds.length > 0) {
        tx.delete(storyBranches).where(inArray(storyBranches.beatId, storyBeatIds)).run();
      }

      // ---- everything keyed directly off campaign_id.
      tx.delete(quests).where(eq(quests.campaignId, id)).run();
      tx.delete(storyBeats).where(eq(storyBeats.campaignId, id)).run();
      tx.delete(storyArcs).where(eq(storyArcs.campaignId, id)).run();
      tx.delete(timelineEvents).where(eq(timelineEvents.campaignId, id)).run();
      tx.delete(timelineCalendars).where(eq(timelineCalendars.campaignId, id)).run();
      tx.delete(sessionZero).where(eq(sessionZero.campaignId, id)).run();
      tx.delete(encounters).where(eq(encounters.campaignId, id)).run();
      tx.delete(npcs).where(eq(npcs.campaignId, id)).run();
      tx.delete(factions).where(eq(factions.campaignId, id)).run();
      tx.delete(locations).where(eq(locations.campaignId, id)).run();
      tx.delete(characters).where(eq(characters.campaignId, id)).run();
      tx.delete(notes).where(eq(notes.campaignId, id)).run();
      tx.delete(comments).where(eq(comments.campaignId, id)).run();
      tx.delete(entityRevisions).where(eq(entityRevisions.campaignId, id)).run();
      tx.delete(sessionShares).where(eq(sessionShares.campaignId, id)).run();
      tx.delete(sessions).where(eq(sessions.campaignId, id)).run();
      tx.delete(scheduledSessions).where(eq(scheduledSessions.campaignId, id)).run();
      tx.delete(proposals).where(eq(proposals.campaignId, id)).run();
      tx.delete(campaignMembers).where(eq(campaignMembers.campaignId, id)).run();
      tx.delete(campaignInvites).where(eq(campaignInvites.campaignId, id)).run();
      tx.delete(apiTokens).where(eq(apiTokens.campaignId, id)).run();
      tx.delete(attachments).where(eq(attachments.campaignId, id)).run();
      tx.delete(diceRolls).where(eq(diceRolls.campaignId, id)).run();
      tx.delete(notifications).where(eq(notifications.campaignId, id)).run();
      tx.delete(inventoryItems).where(eq(inventoryItems.campaignId, id)).run();
      tx.delete(partyTreasury).where(eq(partyTreasury.campaignId, id)).run();
      tx.delete(aiDmSeats).where(eq(aiDmSeats.campaignId, id)).run();

      tx.delete(campaigns).where(eq(campaigns.id, id)).run();
    });

    // Best-effort: remove the on-disk upload directory for this campaign. The DB rows
    // are already gone (source of truth), so a failure here just leaves an orphaned
    // directory — logged-free, matching AttachmentsService.remove()'s best-effort fs.rm.
    const campaignUploadsDir = path.join(uploadsRoot(), String(id));
    fs.rm(campaignUploadsDir, { recursive: true, force: true }, () => {
      /* best-effort — DB rows are already gone; a stray directory is harmless */
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'campaign.purge',
      entityType: 'campaign',
      entityId: id,
      campaignId: id,
    });
  }

  async summary(id: number, role: Role): Promise<CampaignSummary> {
    const campaign = await this.getOrThrow(id);

    const [questList, npcList, locationList, characterList, sessionList, encounterDigest] = await Promise.all([
      this.quests.listForCampaignWithObjectives(id, role),
      this.npcs.listForCampaign(id, role),
      this.locations.listForCampaign(id, role),
      this.characters.listForCampaign(id, role),
      this.sessions.listForCampaign(id, role),
      this.encounters.digestForCampaign(id, role),
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
      sessions: sessionList,
      encounters: encounterDigest,
      openInboxCount,
    };
  }
}

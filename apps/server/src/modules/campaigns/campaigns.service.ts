import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { CampaignClone, CampaignCreate, CampaignUpdate } from '@campfire/schema';
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
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { CharactersService } from '../characters/characters.service';
import { SessionsService } from '../sessions/sessions.service';
import { RoleResolver } from '../membership/role-resolver.service';
import { MembersService } from '../membership/members.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

/** Mirrors AttachmentsService's private helper — see modules/attachments/attachments.service.ts. */
function uploadsRoot(): string {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data');
  return path.join(dataDir, 'uploads');
}

type CampaignCreateInput = z.infer<typeof CampaignCreate>;
type CampaignUpdateInput = z.infer<typeof CampaignUpdate>;
type CampaignCloneInput = z.infer<typeof CampaignClone>;

function toDomain(row: typeof campaigns.$inferSelect): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as Campaign['status'],
    currentLocationId: row.currentLocationId,
    dangerLevel: row.dangerLevel as Campaign['dangerLevel'],
    sessionCount: row.sessionCount,
    ruleSystem: row.ruleSystem,
    mapAttachmentId: row.mapAttachmentId,
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
    private readonly roleResolver: RoleResolver,
    private readonly members: MembersService,
  ) {}

  /** Dev-auth (dev:*) users see all campaigns; everyone else — server admins included (issue #9) — only campaigns they're a member of. */
  async listForUser(user: RequestUser): Promise<Campaign[]> {
    const accessible = await this.roleResolver.accessibleCampaignIds(user);
    const rows = await this.db.select().from(campaigns);
    if (accessible === 'all') return rows.map(toDomain);
    const allowed = new Set(accessible);
    return rows.filter((r) => allowed.has(r.id)).map(toDomain);
  }

  async getOrThrow(id: number): Promise<Campaign> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Campaign ${id} not found`);
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

    // Read everything up front — only the writes need the transaction.
    const [locationRows, npcRows, questRows, characterRows, sessionRows, noteRows, encounterRows] = await Promise.all([
      this.db.select().from(locations).where(eq(locations.campaignId, id)),
      this.db.select().from(npcs).where(eq(npcs.campaignId, id)),
      this.db.select().from(quests).where(eq(quests.campaignId, id)),
      this.db.select().from(characters).where(eq(characters.campaignId, id)),
      this.db.select().from(sessions).where(eq(sessions.campaignId, id)),
      this.db.select().from(notes).where(eq(notes.campaignId, id)),
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
      const locMap = new Map<number, number>();
      for (const l of locationRows) {
        const [row] = tx
          .insert(locations)
          .values({
            campaignId: cloneId,
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
   * Full cascade delete — campaigns.service used to only delete the single
   * campaigns row, orphaning every child table (quests, npcs, locations,
   * characters, encounters+combatants, notes, proposals, campaign_members,
   * api_tokens) plus attachment rows AND their on-disk files. All DB rows are
   * removed in one db.transaction() (better-sqlite3 synchronous transaction
   * API — same pattern as QuestsService.remove()/RulesService.uninstall()),
   * with the campaigns row cleared last so a mid-transaction failure never
   * leaves an orphaned-but-still-"deleted"-looking campaign. The on-disk
   * upload directory is removed after the transaction commits (best-effort,
   * mirroring AttachmentsService.remove()'s fs.rm — the DB is the source of
   * truth for what exists; a stray directory is harmless, but we still try
   * synchronously here since this is a rarer, heavier operation than a
   * single attachment delete).
   */
  async remove(id: number, user: RequestUser): Promise<void> {
    await this.getOrThrow(id);

    // Every quest in this campaign — objectives cascade off quest ids, not campaignId directly.
    const questRows = await this.db.select({ id: quests.id }).from(quests).where(eq(quests.campaignId, id));
    const questIds = questRows.map((r) => r.id);

    // Every encounter in this campaign — combatants cascade off encounter ids.
    const encounterRows = await this.db.select({ id: encounters.id }).from(encounters).where(eq(encounters.campaignId, id));
    const encounterIds = encounterRows.map((r) => r.id);

    this.db.transaction((tx) => {
      for (const questId of questIds) {
        tx.delete(questObjectives).where(eq(questObjectives.questId, questId)).run();
      }
      tx.delete(quests).where(eq(quests.campaignId, id)).run();

      for (const encounterId of encounterIds) {
        tx.delete(combatants).where(eq(combatants.encounterId, encounterId)).run();
      }
      tx.delete(encounters).where(eq(encounters.campaignId, id)).run();

      tx.delete(npcs).where(eq(npcs.campaignId, id)).run();
      tx.delete(locations).where(eq(locations.campaignId, id)).run();
      tx.delete(characters).where(eq(characters.campaignId, id)).run();
      tx.delete(notes).where(eq(notes.campaignId, id)).run();
      tx.delete(sessions).where(eq(sessions.campaignId, id)).run();
      tx.delete(proposals).where(eq(proposals.campaignId, id)).run();
      tx.delete(campaignMembers).where(eq(campaignMembers.campaignId, id)).run();
      tx.delete(apiTokens).where(eq(apiTokens.campaignId, id)).run();
      tx.delete(attachments).where(eq(attachments.campaignId, id)).run();

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
      action: 'campaign.delete',
      entityType: 'campaign',
      entityId: id,
      campaignId: id,
    });
  }

  async summary(id: number, role: Role): Promise<CampaignSummary> {
    const campaign = await this.getOrThrow(id);

    const [questList, npcList, locationList, characterList, sessionList] = await Promise.all([
      this.quests.listForCampaignWithObjectives(id, role),
      this.npcs.listForCampaign(id, role),
      this.locations.listForCampaign(id, role),
      this.characters.listForCampaign(id, role),
      this.sessions.listForCampaign(id, role),
    ]);

    const currentLocation = campaign.currentLocationId
      ? (locationList.find((l) => l.id === campaign.currentLocationId) ?? null)
      : null;

    // issue #71: count in SQL instead of loading every note row (incl. bodies) into
    // JS just to count the open inbox items.
    const [{ value: openInboxCount }] = await this.db
      .select({ value: count() })
      .from(notes)
      .where(and(eq(notes.campaignId, id), eq(notes.kind, 'inbox'), eq(notes.resolved, false)));

    return {
      campaign,
      currentLocation,
      quests: questList,
      npcs: npcList,
      locations: locationList,
      characters: characterList,
      sessions: sessionList,
      openInboxCount,
    };
  }
}

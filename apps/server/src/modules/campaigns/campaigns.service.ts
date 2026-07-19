import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CampaignCreate, CampaignUpdate } from '@campfire/schema';
import type { Campaign, CampaignSummary, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaigns,
  notes,
  quests,
  questObjectives,
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

  /** Admins (incl. dev:* users) see all campaigns; everyone else only campaigns they're a member of. */
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

  /** Any authenticated user may create a campaign; creator is auto-inserted as 'dm' (skipped for dev:* users). */
  async create(input: CampaignCreateInput, user: RequestUser): Promise<Campaign> {
    await this.validateRuleSystem(input.ruleSystem);
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
    await this.getOrThrow(id);
    await this.validateRuleSystem(input.ruleSystem);
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
      this.characters.listForCampaign(id),
      this.sessions.listForCampaign(id),
    ]);

    const currentLocation = campaign.currentLocationId
      ? (locationList.find((l) => l.id === campaign.currentLocationId) ?? null)
      : null;

    const openInboxRows = await this.db
      .select()
      .from(notes)
      .where(eq(notes.campaignId, id));
    const openInboxCount = openInboxRows.filter((n) => n.kind === 'inbox' && !n.resolved).length;

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

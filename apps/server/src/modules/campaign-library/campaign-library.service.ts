import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  CampaignLibraryMonster,
  CampaignLibraryMonsterCreate,
  CampaignLibraryMonsterUpdate,
  CombatantStatblock,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignLibraryMonsters } from '../../db/schema';
import { fromJsonText, toJsonText } from '../../common/json';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

function toDomain(row: typeof campaignLibraryMonsters.$inferSelect): CampaignLibraryMonster {
  return CampaignLibraryMonster.parse({
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    statblock: CombatantStatblock.parse(fromJsonText(row.statblockJson, {})),
    sourceRuleEntryId: row.sourceRuleEntryId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

@Injectable()
export class CampaignLibraryService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForCampaign(campaignId: number): Promise<CampaignLibraryMonster[]> {
    const rows = await this.db
      .select()
      .from(campaignLibraryMonsters)
      .where(eq(campaignLibraryMonsters.campaignId, campaignId))
      .orderBy(campaignLibraryMonsters.name);
    return rows.map(toDomain);
  }

  async getRowOrThrow(id: number, campaignId?: number) {
    const [row] = await this.db.select().from(campaignLibraryMonsters).where(eq(campaignLibraryMonsters.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Library monster ${id} not found`);
    if (campaignId !== undefined && row.campaignId !== campaignId) {
      throw new NotFoundException(`Library monster ${id} not found in campaign ${campaignId}`);
    }
    return row;
  }

  async getOrThrow(id: number, campaignId?: number): Promise<CampaignLibraryMonster> {
    return toDomain(await this.getRowOrThrow(id, campaignId));
  }

  async create(campaignId: number, input: CampaignLibraryMonsterCreate, user: RequestUser, role: Role): Promise<CampaignLibraryMonster> {
    const statblock = CombatantStatblock.parse(input.statblock);
    const ts = nowIso();
    const [row] = await this.db
      .insert(campaignLibraryMonsters)
      .values({
        campaignId,
        name: input.name.trim(),
        statblockJson: toJsonText(statblock),
        sourceRuleEntryId: input.sourceRuleEntryId ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign_library_monster.create',
      entityType: 'campaign_library_monster',
      entityId: row.id,
      campaignId,
      detail: input.name,
    });
    return toDomain(row);
  }

  async update(id: number, input: CampaignLibraryMonsterUpdate, user: RequestUser, role: Role, campaignId: number): Promise<CampaignLibraryMonster> {
    const existing = await this.getRowOrThrow(id, campaignId);
    const patch: Partial<typeof campaignLibraryMonsters.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.statblock !== undefined) patch.statblockJson = toJsonText(CombatantStatblock.parse(input.statblock));
    const [row] = await this.db.update(campaignLibraryMonsters).set(patch).where(eq(campaignLibraryMonsters.id, existing.id)).returning().all();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign_library_monster.update',
      entityType: 'campaign_library_monster',
      entityId: id,
      campaignId,
      detail: row.name,
    });
    return toDomain(row);
  }

  async remove(id: number, user: RequestUser, role: Role, campaignId: number): Promise<void> {
    const existing = await this.getRowOrThrow(id, campaignId);
    await this.db.delete(campaignLibraryMonsters).where(eq(campaignLibraryMonsters.id, existing.id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign_library_monster.delete',
      entityType: 'campaign_library_monster',
      entityId: id,
      campaignId,
      detail: existing.name,
    });
  }

  /** Clone a library entry (or compendium-derived snapshot) under a new name. */
  async clone(id: number, name: string, user: RequestUser, role: Role, campaignId: number): Promise<CampaignLibraryMonster> {
    const source = await this.getOrThrow(id, campaignId);
    return this.create(
      campaignId,
      { name: name.trim(), statblock: source.statblock, sourceRuleEntryId: source.sourceRuleEntryId ?? undefined },
      user,
      role,
    );
  }

  /** Save a combatant's inline statblock into the campaign library. */
  async saveFromStatblock(
    campaignId: number,
    name: string,
    statblock: CombatantStatblock,
    user: RequestUser,
    role: Role,
    sourceRuleEntryId?: number | null,
  ): Promise<CampaignLibraryMonster> {
    if (!name.trim()) throw new BadRequestException('A library monster needs a name.');
    return this.create(
      campaignId,
      {
        name: name.trim(),
        statblock: CombatantStatblock.parse(statblock),
        ...(sourceRuleEntryId != null ? { sourceRuleEntryId } : {}),
      },
      user,
      role,
    );
  }
}

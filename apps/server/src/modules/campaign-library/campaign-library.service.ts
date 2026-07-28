import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  CampaignLibraryMonster,
  CampaignLibraryMonsterCreate,
  CampaignLibraryMonsterUpdate,
  CampaignLibraryTag, CampaignLibraryTagCreate, CampaignLibraryTagUpdate,
  CampaignLibraryCollection, CampaignLibraryCollectionCreate, CampaignLibraryCollectionUpdate,
  CombatantStatblock,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignLibraryCollections, campaignLibraryMonsters, campaignLibraryTags } from '../../db/schema';
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

  private tag(row: typeof campaignLibraryTags.$inferSelect): CampaignLibraryTag { return CampaignLibraryTag.parse({ ...row, aliases: fromJsonText(row.aliasesJson, []), parentTagId: row.parentTagId }); }
  private collection(row: typeof campaignLibraryCollections.$inferSelect): CampaignLibraryCollection { return CampaignLibraryCollection.parse({ ...row, aliases: fromJsonText(row.aliasesJson, []), parentCollectionId: row.parentCollectionId }); }

  async listTags(campaignId: number): Promise<CampaignLibraryTag[]> { return (await this.db.select().from(campaignLibraryTags).where(eq(campaignLibraryTags.campaignId, campaignId)).orderBy(campaignLibraryTags.name)).map((r) => this.tag(r)); }
  async listCollections(campaignId: number): Promise<CampaignLibraryCollection[]> { return (await this.db.select().from(campaignLibraryCollections).where(eq(campaignLibraryCollections.campaignId, campaignId)).orderBy(campaignLibraryCollections.name)).map((r) => this.collection(r)); }

  private async assertParent(table: typeof campaignLibraryTags | typeof campaignLibraryCollections, campaignId: number, parentId: number | null | undefined, selfId?: number) {
    if (parentId == null) return;
    if (parentId === selfId) throw new BadRequestException('A taxonomy entry cannot parent itself');
    const parentColumn = table === campaignLibraryTags ? campaignLibraryTags.parentTagId : campaignLibraryCollections.parentCollectionId;
    const [parent] = await this.db.select().from(table).where(and(eq(table.id, parentId), eq(table.campaignId, campaignId))).limit(1);
    if (!parent) throw new BadRequestException('Parent must exist in this campaign');
    let cursor: number | null = parentId;
    while (cursor != null) { if (cursor === selfId) throw new BadRequestException('Parent would create a cycle'); const [row] = await this.db.select({ parentId: parentColumn }).from(table).where(eq(table.id, cursor)).limit(1); cursor = row?.parentId ?? null; }
  }

  async createTag(campaignId: number, input: CampaignLibraryTagCreate): Promise<CampaignLibraryTag> {
    await this.assertParent(campaignLibraryTags, campaignId, input.parentTagId); const ts = nowIso();
    const [row] = await this.db.insert(campaignLibraryTags).values({ campaignId, name: input.name.trim(), aliasesJson: toJsonText(input.aliases ?? []), color: input.color ?? '#64748b', description: input.description ?? '', parentTagId: input.parentTagId ?? null, createdAt: ts, updatedAt: ts }).returning().all(); return this.tag(row);
  }
  async createCollection(campaignId: number, input: CampaignLibraryCollectionCreate): Promise<CampaignLibraryCollection> {
    await this.assertParent(campaignLibraryCollections, campaignId, input.parentCollectionId); const ts = nowIso();
    const [row] = await this.db.insert(campaignLibraryCollections).values({ campaignId, name: input.name.trim(), aliasesJson: toJsonText(input.aliases ?? []), color: input.color ?? '#64748b', description: input.description ?? '', parentCollectionId: input.parentCollectionId ?? null, createdAt: ts, updatedAt: ts }).returning().all(); return this.collection(row);
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
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('A library monster needs a name.');
    const source = await this.getOrThrow(id, campaignId);
    return this.create(
      campaignId,
      { name: trimmed, statblock: source.statblock, sourceRuleEntryId: source.sourceRuleEntryId ?? undefined },
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

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  CampaignLibraryMonster,
  CampaignLibraryMonsterCreate,
  CampaignLibraryMonsterUpdate,
  CampaignLibraryTag, CampaignLibraryTagCreate, CampaignLibraryTagUpdate,
  CampaignLibraryCollection, CampaignLibraryCollectionCreate, CampaignLibraryCollectionUpdate,
  CombatantStatblock,
  LibrarySearchQuery,
  LibrarySearchPage,
  type LibraryEntitySummary,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaignLibraryCollections, campaignLibraryEntityTaxonomy, campaignLibraryMonsters, campaignLibraryTags, encounters, factions, inventoryItems, locations, npcs, quests, timelineEvents } from '../../db/schema';
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

  private async tagRowOrThrow(campaignId: number, id: number) {
    const [row] = await this.db.select().from(campaignLibraryTags).where(and(eq(campaignLibraryTags.id, id), eq(campaignLibraryTags.campaignId, campaignId))).limit(1);
    if (!row) throw new NotFoundException(`Tag ${id} not found in campaign ${campaignId}`);
    return row;
  }

  private async collectionRowOrThrow(campaignId: number, id: number) {
    const [row] = await this.db.select().from(campaignLibraryCollections).where(and(eq(campaignLibraryCollections.id, id), eq(campaignLibraryCollections.campaignId, campaignId))).limit(1);
    if (!row) throw new NotFoundException(`Collection ${id} not found in campaign ${campaignId}`);
    return row;
  }

  async updateTag(campaignId: number, id: number, input: CampaignLibraryTagUpdate): Promise<CampaignLibraryTag> {
    await this.tagRowOrThrow(campaignId, id);
    if (input.parentTagId !== undefined) await this.assertParent(campaignLibraryTags, campaignId, input.parentTagId, id);
    const patch: Partial<typeof campaignLibraryTags.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.aliases !== undefined) patch.aliasesJson = toJsonText(input.aliases);
    if (input.color !== undefined) patch.color = input.color;
    if (input.description !== undefined) patch.description = input.description;
    if (input.parentTagId !== undefined) patch.parentTagId = input.parentTagId;
    const [row] = await this.db.update(campaignLibraryTags).set(patch).where(and(eq(campaignLibraryTags.id, id), eq(campaignLibraryTags.campaignId, campaignId))).returning().all();
    return this.tag(row);
  }

  async updateCollection(campaignId: number, id: number, input: CampaignLibraryCollectionUpdate): Promise<CampaignLibraryCollection> {
    await this.collectionRowOrThrow(campaignId, id);
    if (input.parentCollectionId !== undefined) await this.assertParent(campaignLibraryCollections, campaignId, input.parentCollectionId, id);
    const patch: Partial<typeof campaignLibraryCollections.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.aliases !== undefined) patch.aliasesJson = toJsonText(input.aliases);
    if (input.color !== undefined) patch.color = input.color;
    if (input.description !== undefined) patch.description = input.description;
    if (input.parentCollectionId !== undefined) patch.parentCollectionId = input.parentCollectionId;
    const [row] = await this.db.update(campaignLibraryCollections).set(patch).where(and(eq(campaignLibraryCollections.id, id), eq(campaignLibraryCollections.campaignId, campaignId))).returning().all();
    return this.collection(row);
  }

  /** Delete is intentionally destructive in alpha: taxonomy references are removed, children become roots. */
  async removeTag(campaignId: number, id: number): Promise<void> {
    await this.tagRowOrThrow(campaignId, id);
    this.db.transaction((tx) => {
      tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.tagId, id))).run();
      tx.update(campaignLibraryTags).set({ parentTagId: null, updatedAt: nowIso() }).where(and(eq(campaignLibraryTags.campaignId, campaignId), eq(campaignLibraryTags.parentTagId, id))).run();
      tx.delete(campaignLibraryTags).where(and(eq(campaignLibraryTags.id, id), eq(campaignLibraryTags.campaignId, campaignId))).run();
    });
  }

  async removeCollection(campaignId: number, id: number): Promise<void> {
    await this.collectionRowOrThrow(campaignId, id);
    this.db.transaction((tx) => {
      tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.collectionId, id))).run();
      tx.update(campaignLibraryCollections).set({ parentCollectionId: null, updatedAt: nowIso() }).where(and(eq(campaignLibraryCollections.campaignId, campaignId), eq(campaignLibraryCollections.parentCollectionId, id))).run();
      tx.delete(campaignLibraryCollections).where(and(eq(campaignLibraryCollections.id, id), eq(campaignLibraryCollections.campaignId, campaignId))).run();
    });
  }

  /**
   * One role-filtered inventory of campaign content.  This intentionally builds a
   * small, explicit projection rather than exposing arbitrary table columns: the
   * manager can never accidentally leak a dmSecret while new entity kinds are added.
   */
  async search(campaignId: number, role: Role, raw: unknown): Promise<LibrarySearchPage> {
    const query = LibrarySearchQuery.parse(raw);
    const isDm = role === 'dm';
    const [questRows, npcRows, locationRows, factionRows, encounterRows, timelineRows, inventoryRows, attachmentRows, monsterRows] = await Promise.all([
      this.db.select().from(quests).where(eq(quests.campaignId, campaignId)), this.db.select().from(npcs).where(eq(npcs.campaignId, campaignId)),
      this.db.select().from(locations).where(eq(locations.campaignId, campaignId)), this.db.select().from(factions).where(eq(factions.campaignId, campaignId)),
      this.db.select().from(encounters).where(eq(encounters.campaignId, campaignId)), this.db.select().from(timelineEvents).where(eq(timelineEvents.campaignId, campaignId)),
      this.db.select().from(inventoryItems).where(eq(inventoryItems.campaignId, campaignId)), this.db.select().from(attachments).where(eq(attachments.campaignId, campaignId)),
      this.db.select().from(campaignLibraryMonsters).where(eq(campaignLibraryMonsters.campaignId, campaignId)),
    ]);
    let items: LibraryEntitySummary[] = [
      ...questRows.filter((r) => !r.deletedAt && (isDm || !r.hidden)).map((r) => ({ entityType: 'quest' as const, entityId: r.id, name: r.title, description: r.body, visibility: r.hidden ? 'hidden' : 'public', status: r.status, owner: null, tags: [], collections: [] })),
      ...npcRows.filter((r) => !r.deletedAt && (isDm || !r.hidden)).map((r) => ({ entityType: 'npc' as const, entityId: r.id, name: r.name, description: r.body, visibility: r.hidden ? 'hidden' : 'public', status: r.disposition, owner: null, tags: [], collections: [] })),
      ...locationRows.filter((r) => !r.deletedAt).map((r) => ({ entityType: 'location' as const, entityId: r.id, name: r.name, description: r.body, visibility: 'public', status: r.status, owner: null, tags: [], collections: [] })),
      ...factionRows.filter((r) => !r.deletedAt && (isDm || !r.hidden)).map((r) => ({ entityType: 'faction' as const, entityId: r.id, name: r.name, description: r.body, visibility: r.hidden ? 'hidden' : 'public', status: r.standing, owner: null, tags: [], collections: [] })),
      ...encounterRows.filter((r) => !r.deletedAt && (isDm || !r.hidden)).map((r) => ({ entityType: 'encounter' as const, entityId: r.id, name: r.name, description: '', visibility: r.hidden ? 'hidden' : 'public', status: r.status, owner: null, tags: [], collections: [] })),
      ...timelineRows.filter((r) => !r.deletedAt && (isDm || !r.hidden)).map((r) => ({ entityType: 'timeline_event' as const, entityId: r.id, name: r.title, description: r.body, visibility: r.hidden ? 'hidden' : 'public', status: null, owner: null, tags: [], collections: [] })),
      ...inventoryRows.filter((r) => !r.deletedAt).map((r) => ({ entityType: 'inventory_item' as const, entityId: r.id, name: r.name, description: r.notes, visibility: 'public', status: null, owner: r.ownerType === 'party' ? 'party' : `character:${r.characterId}`, tags: [], collections: [] })),
      ...attachmentRows.filter((r) => r.state === 'committed' && (isDm || !r.hidden)).map((r) => ({ entityType: 'attachment' as const, entityId: r.id, name: r.filename, description: r.mime, visibility: r.hidden ? 'hidden' : 'public', status: r.kind, owner: r.uploaderUserId, tags: [], collections: [] })),
      ...monsterRows.map((r) => ({ entityType: 'campaign_library_monster' as const, entityId: r.id, name: r.name, description: '', visibility: 'public', status: null, owner: null, tags: [], collections: [] })),
    ];
    const links = await this.db.select().from(campaignLibraryEntityTaxonomy).where(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId));
    const [tags, collections] = await Promise.all([this.listTags(campaignId), this.listCollections(campaignId)]);
    const tagsById = new Map(tags.map((tag) => [tag.id, tag])); const collectionsById = new Map(collections.map((collection) => [collection.id, collection]));
    const byEntity = new Map<string, typeof links>();
    for (const link of links) { const key = `${link.entityType}:${link.entityId}`; byEntity.set(key, [...(byEntity.get(key) ?? []), link]); }
    items = items.map((item) => {
      const entityLinks = byEntity.get(`${item.entityType}:${item.entityId}`) ?? [];
      return { ...item, tags: entityLinks.flatMap((link) => link.tagId == null ? [] : [tagsById.get(link.tagId)]).filter((x): x is CampaignLibraryTag => Boolean(x)), collections: entityLinks.flatMap((link) => link.collectionId == null ? [] : [collectionsById.get(link.collectionId)]).filter((x): x is CampaignLibraryCollection => Boolean(x)) };
    });
    const needle = query.q?.toLocaleLowerCase();
    if (needle) items = items.filter((item) => [item.name, item.description, ...item.tags.flatMap((tag) => [tag.name, ...tag.aliases]), ...item.collections.flatMap((collection) => [collection.name, ...collection.aliases])].join(' ').toLocaleLowerCase().includes(needle));
    if (query.type) items = items.filter((item) => item.entityType === query.type);
    if (query.tagId) items = items.filter((item) => item.tags.some((tag) => tag.id === query.tagId));
    if (query.collectionId) items = items.filter((item) => item.collections.some((collection) => collection.id === query.collectionId));
    if (query.visibility) items = items.filter((item) => item.visibility === query.visibility);
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.owner) items = items.filter((item) => item.owner === query.owner);
    items.sort((a, b) => a.name.localeCompare(b.name) || a.entityType.localeCompare(b.entityType) || a.entityId - b.entityId);
    const count = <T extends string | number>(values: T[], label: (value: T) => string) => [...new Map(values.map((value) => [value, (values.filter((entry) => entry === value).length)])).entries()].map(([id, total]) => ({ id, label: label(id), count: total }));
    return LibrarySearchPage.parse({ items: items.slice(query.offset, query.offset + query.limit), total: items.length, limit: query.limit, offset: query.offset, facets: { types: count(items.map((item) => item.entityType), (type) => type), tags: tags.map((tag) => ({ id: tag.id, label: tag.name, count: items.filter((item) => item.tags.some((value) => value.id === tag.id)).length })).filter((facet) => facet.count > 0), collections: collections.map((collection) => ({ id: collection.id, label: collection.name, count: items.filter((item) => item.collections.some((value) => value.id === collection.id)).length })).filter((facet) => facet.count > 0), visibility: count(items.map((item) => item.visibility ?? 'public'), (value) => value), status: count(items.flatMap((item) => item.status == null ? [] : [item.status]), (value) => value) } });
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

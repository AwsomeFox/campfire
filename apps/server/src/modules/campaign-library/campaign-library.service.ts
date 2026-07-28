import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CampaignLibraryMonster,
  CampaignLibraryMonsterCreate,
  CampaignLibraryMonsterUpdate,
  CampaignLibraryTag, CampaignLibraryTagCreate, CampaignLibraryTagUpdate,
  CampaignLibraryCollection, CampaignLibraryCollectionCreate, CampaignLibraryCollectionUpdate,
  CombatantStatblock,
  LibrarySearchQuery,
  LibrarySearchPage,
  LibraryBulkRequest, LibraryBulkResult,
  QuestStatus, FactionStanding, LocationStatus,
  type LibraryEntitySummary,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, auditLog, campaignLibraryBulkOperations, campaignLibraryCollections, campaignLibraryEntityTaxonomy, campaignLibraryMonsters, campaignLibraryTags, characters, encounters, factions, inventoryItems, locations, npcs, quests, timelineEvents } from '../../db/schema';
import { fromJsonText, toJsonText } from '../../common/json';
import { nowIso } from '../../common/time';
import { getRequestId } from '../../common/request-context';
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

  async bulk(campaignId: number, raw: unknown, user: RequestUser, role: Role): Promise<LibraryBulkResult> {
    const request = LibraryBulkRequest.parse(raw);
    switch (request.operation) {
      case 'set_visibility': case 'set_status': case 'move_inventory_owner': case 'archive': case 'restore':
        return this.bulkEntityFields(campaignId, request, user, role);
    }
    if (!['add_tag', 'remove_tag', 'add_collection', 'remove_collection', 'move_collection'].includes(request.operation)) throw new BadRequestException(`Bulk operation ${request.operation} is not yet supported for these entity types`);
    const isTag = request.operation === 'add_tag' || request.operation === 'remove_tag';
    if (!('taxonomyId' in request)) throw new BadRequestException('Bulk operation needs a taxonomyId');
    const taxonomyId = request.taxonomyId;
    const ts = nowIso(); let operationId = 0;
    this.db.transaction((tx) => {
      // Everything is validated under the same lock/transaction as the write.  In
      // particular, a later bad target cannot leave an earlier target modified.
      const taxonomyTable = isTag ? 'campaign_library_tags' : 'campaign_library_collections';
      if (!tx.get(sql`select id from ${sql.raw(taxonomyTable)} where id=${taxonomyId} and campaign_id=${campaignId}`)) throw new NotFoundException('Taxonomy entry not found in this campaign');
      for (const target of request.targets) {
        const entry = ({ quest: 'quests', npc: 'npcs', location: 'locations', faction: 'factions', encounter: 'encounters', timeline_event: 'timeline_events', inventory_item: 'inventory_items', attachment: 'attachments', campaign_library_monster: 'campaign_library_monsters' } as const)[target.entityType];
        if (!tx.get(sql`select id from ${sql.raw(entry)} where id=${target.entityId} and campaign_id=${campaignId}`)) throw new NotFoundException(`${target.entityType} ${target.entityId} not found in this campaign`);
      }
      const targetKeys = new Set(request.targets.map((target) => `${target.entityType}:${target.entityId}`));
      const TaxonomyJournalRow = z.object({ id: z.number().int(), campaignId: z.number().int(), entityType: z.string(), entityId: z.number().int(), tagId: z.number().int().nullable(), collectionId: z.number().int().nullable(), createdAt: z.string() }).strict();
      const relevant = tx.all(sql`select id, campaign_id as campaignId, entity_type as entityType, entity_id as entityId, tag_id as tagId, collection_id as collectionId, created_at as createdAt from campaign_library_entity_taxonomy where campaign_id=${campaignId}`)
        .map((row) => TaxonomyJournalRow.parse(row)).filter((row) => targetKeys.has(`${row.entityType}:${row.entityId}`));
      for (const target of request.targets) {
        const predicate = and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityType, target.entityType), eq(campaignLibraryEntityTaxonomy.entityId, target.entityId), isTag ? eq(campaignLibraryEntityTaxonomy.tagId, taxonomyId) : eq(campaignLibraryEntityTaxonomy.collectionId, taxonomyId));
        if (request.operation === 'add_tag' || request.operation === 'add_collection' || request.operation === 'move_collection') {
          // A move replaces the target's entire collection membership, not merely
          // a duplicate of the destination collection.
          if (request.operation === 'move_collection') tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityType, target.entityType), eq(campaignLibraryEntityTaxonomy.entityId, target.entityId), isNull(campaignLibraryEntityTaxonomy.tagId))).run();
          tx.insert(campaignLibraryEntityTaxonomy).values({ campaignId, entityType: target.entityType, entityId: target.entityId, tagId: isTag ? taxonomyId : null, collectionId: isTag ? null : taxonomyId, createdAt: ts }).onConflictDoNothing().run();
        } else tx.delete(campaignLibraryEntityTaxonomy).where(predicate).run();
      }
      const inserted = tx.insert(campaignLibraryBulkOperations).values({ campaignId, actor: auditActor(user), operation: request.operation, beforeJson: toJsonText(relevant), afterJson: toJsonText(request), inverseJson: toJsonText(relevant), createdAt: ts }).returning({ id: campaignLibraryBulkOperations.id }).get(); operationId = inserted.id;
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.bulk', entityType: 'campaign_library_bulk_operation', entityId: operationId, detail: request.operation, requestId: getRequestId() ?? null, createdAt: ts }).run();
    });
    return { operationId, applied: request.targets.length, undoAvailable: true };
  }

  /** Non-taxonomy mutations journal precisely the one column they own.  Undo uses
   * updated_at as a CAS fence so it never overwrites a subsequent editor's change. */
  private bulkEntityFields(campaignId: number, request: Exclude<LibraryBulkRequest, { taxonomyId: number }>, user: RequestUser, role: Role): LibraryBulkResult {
    const ts = nowIso();
    const result = this.db.transaction((tx) => {
      const config = request.operation === 'set_visibility'
        ? { allowed: new Set(['quest', 'npc', 'location', 'faction', 'encounter', 'timeline_event', 'attachment']), field: 'hidden' }
        : request.operation === 'set_status'
          ? { allowed: new Set(['quest', 'npc', 'location', 'faction']), field: 'status' }
          : request.operation === 'move_inventory_owner'
            ? { allowed: new Set(['inventory_item']), field: 'owner' }
            : { allowed: new Set(['quest', 'npc', 'location', 'faction', 'timeline_event', 'inventory_item']), field: 'deleted_at' };
      const table = (type: string) => ({ quest: 'quests', npc: 'npcs', location: 'locations', faction: 'factions', encounter: 'encounters', timeline_event: 'timeline_events', inventory_item: 'inventory_items', attachment: 'attachments' } as Record<string, string>)[type];
      const snapshots: Array<{ entityType: string; entityId: number; value: unknown }> = [];
      if (request.operation === 'move_inventory_owner' && request.ownerType === 'character' && !tx.get(sql`select id from characters where id=${request.characterId!} and campaign_id=${campaignId}`)) throw new BadRequestException('Character owner must belong to this campaign');
      for (const target of request.targets) {
        if (!config.allowed.has(target.entityType)) throw new BadRequestException(`${request.operation} is not supported for ${target.entityType}`);
        const name = table(target.entityType);
        if (request.operation === 'set_status') {
          if (target.entityType === 'npc') {
            if (request.status.length > 40) throw new BadRequestException('NPC disposition cannot exceed 40 characters');
          } else {
            const validator = target.entityType === 'quest' ? QuestStatus : target.entityType === 'faction' ? FactionStanding : LocationStatus;
            if (!validator.safeParse(request.status).success) throw new BadRequestException(`${request.status} is not a valid ${target.entityType} status`);
          }
        }
        const field = request.operation === 'set_status' ? (target.entityType === 'npc' ? 'disposition' : target.entityType === 'faction' ? 'standing' : 'status') : request.operation === 'set_visibility' && target.entityType === 'location' ? 'status' : config.field;
        const row = request.operation === 'move_inventory_owner'
          ? tx.get(sql`select owner_type as ownerType, character_id as characterId from ${sql.raw(name)} where id=${target.entityId} and campaign_id=${campaignId}`)
          : tx.get(sql`select ${sql.raw(field)} as value from ${sql.raw(name)} where id=${target.entityId} and campaign_id=${campaignId}`);
        if (!row) throw new NotFoundException(`${target.entityType} ${target.entityId} not found in this campaign`);
        snapshots.push({ entityType: target.entityType, entityId: target.entityId, value: row });
      }
      for (const target of request.targets) {
        const name = table(target.entityType);
        if (request.operation === 'set_visibility') {
          // Locations use progression state as their whole-entity secrecy marker.
          // Revealing keeps any progressed state, while a fresh unexplored location
          // becomes explored rather than inventing a parallel hidden flag.
          if (target.entityType === 'location') {
            if (request.visibility === 'hidden') tx.run(sql`update locations set status='unexplored', updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`);
            else tx.run(sql`update locations set status=case when status='unexplored' then 'explored' else status end, updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`);
          }
          else tx.run(sql`update ${sql.raw(name)} set hidden=${request.visibility === 'hidden' ? 1 : 0}, updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`);
        }
        else if (request.operation === 'set_status') {
          const field = target.entityType === 'npc' ? 'disposition' : target.entityType === 'faction' ? 'standing' : 'status';
          tx.run(sql`update ${sql.raw(name)} set ${sql.raw(field)}=${request.status}, updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`);
        } else if (request.operation === 'move_inventory_owner') tx.run(sql`update inventory_items set owner_type=${request.ownerType}, character_id=${request.characterId ?? null}, updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`);
        else tx.run(sql`update ${sql.raw(name)} set deleted_at=${request.operation === 'archive' ? ts : null}, updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`);
      }
      const inserted = tx.insert(campaignLibraryBulkOperations).values({ campaignId, actor: auditActor(user), operation: request.operation, beforeJson: toJsonText({ kind: 'field', snapshots }), afterJson: toJsonText(request), inverseJson: toJsonText({ kind: 'field', snapshots }), createdAt: ts }).returning({ id: campaignLibraryBulkOperations.id }).get();
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.bulk', entityType: 'campaign_library_bulk_operation', entityId: inserted.id, detail: request.operation, requestId: getRequestId() ?? null, createdAt: ts }).run();
      return inserted.id;
    });
    return { operationId: result, applied: request.targets.length, undoAvailable: true };
  }

  async undoBulk(campaignId: number, operationId: number, user: RequestUser, role: Role) {
    const JournalRows = z.array(z.object({ id: z.number().int(), campaignId: z.number().int(), entityType: z.string(), entityId: z.number().int(), tagId: z.number().int().nullable(), collectionId: z.number().int().nullable(), createdAt: z.string() }).strict());
    return this.db.transaction((tx) => {
      const operation = tx.select().from(campaignLibraryBulkOperations).where(and(eq(campaignLibraryBulkOperations.id, operationId), eq(campaignLibraryBulkOperations.campaignId, campaignId))).get();
      if (!operation) throw new NotFoundException(`Bulk operation ${operationId} not found`);
      // Claim before inverse writes; this gives concurrent callers exactly one winner.
      const claimed = tx.update(campaignLibraryBulkOperations).set({ undoneAt: nowIso(), undoneBy: auditActor(user) }).where(and(eq(campaignLibraryBulkOperations.id, operationId), eq(campaignLibraryBulkOperations.campaignId, campaignId), isNull(campaignLibraryBulkOperations.undoneAt))).run();
      if (claimed.changes === 0) return { operationId, undone: true, alreadyUndone: true };
      const request = LibraryBulkRequest.parse(JSON.parse(operation.afterJson));
      if (!('taxonomyId' in request)) {
        const FieldJournal = z.object({ kind: z.literal('field'), snapshots: z.array(z.object({ entityType: z.string(), entityId: z.number().int(), value: z.unknown() }).strict()) }).strict();
        const journal = FieldJournal.parse(JSON.parse(operation.beforeJson));
        const table = (type: string) => ({ quest: 'quests', npc: 'npcs', location: 'locations', faction: 'factions', encounter: 'encounters', timeline_event: 'timeline_events', inventory_item: 'inventory_items', attachment: 'attachments' } as Record<string, string>)[type];
        for (const row of journal.snapshots) {
          const name = table(row.entityType);
          const value = z.record(z.string(), z.unknown()).parse(row.value);
          const scalar = z.object({ value: z.union([z.string(), z.number(), z.null()]) }).parse(value);
          if (request.operation === 'set_visibility') {
            const before = z.object({ value: z.union([z.string(), z.number()]) }).parse(value).value;
            const after = row.entityType === 'location' ? (request.visibility === 'hidden' ? 'unexplored' : before === 'unexplored' ? 'explored' : before) : request.visibility === 'hidden' ? 1 : 0;
            const field = row.entityType === 'location' ? 'status' : 'hidden';
            if (!tx.get(sql`select id from ${sql.raw(name)} where id=${row.entityId} and campaign_id=${campaignId} and ${sql.raw(field)}=${after}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            tx.run(sql`update ${sql.raw(name)} set ${sql.raw(field)}=${before}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
          }
          else if (request.operation === 'set_status') {
            const field = row.entityType === 'npc' ? 'disposition' : row.entityType === 'faction' ? 'standing' : 'status';
            if (!tx.get(sql`select id from ${sql.raw(name)} where id=${row.entityId} and campaign_id=${campaignId} and ${sql.raw(field)}=${request.status}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            tx.run(sql`update ${sql.raw(name)} set ${sql.raw(field)}=${scalar.value}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
          } else if (request.operation === 'move_inventory_owner') {
            const before = z.object({ ownerType: z.string(), characterId: z.number().int().nullable() }).parse(value);
            if (!tx.get(sql`select id from inventory_items where id=${row.entityId} and campaign_id=${campaignId} and owner_type=${request.ownerType} and character_id is ${request.characterId ?? null}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            tx.run(sql`update inventory_items set owner_type=${before.ownerType}, character_id=${before.characterId}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
          } else {
            const after = request.operation === 'archive' ? operation.createdAt : null;
            if (!tx.get(sql`select id from ${sql.raw(name)} where id=${row.entityId} and campaign_id=${campaignId} and deleted_at is ${after}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            tx.run(sql`update ${sql.raw(name)} set deleted_at=${scalar.value}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
          }
        }
        tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.bulk.undo', entityType: 'campaign_library_bulk_operation', entityId: operationId, detail: operation.operation, requestId: getRequestId() ?? null, createdAt: nowIso() }).run();
        return { operationId, undone: true, alreadyUndone: false };
      }
      const rows = JournalRows.parse(JSON.parse(operation.beforeJson));
      const isTag = request.operation === 'add_tag' || request.operation === 'remove_tag';
      for (const target of request.targets) {
        // Undo only the dimension this operation touched.  A tag or collection a
        // collaborator added later is never deleted by an older undo.
        if (request.operation === 'move_collection') tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityType, target.entityType), eq(campaignLibraryEntityTaxonomy.entityId, target.entityId), eq(campaignLibraryEntityTaxonomy.collectionId, request.taxonomyId))).run();
        else tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityType, target.entityType), eq(campaignLibraryEntityTaxonomy.entityId, target.entityId), isTag ? eq(campaignLibraryEntityTaxonomy.tagId, request.taxonomyId) : eq(campaignLibraryEntityTaxonomy.collectionId, request.taxonomyId))).run();
      }
      for (const row of rows) tx.insert(campaignLibraryEntityTaxonomy).values({ campaignId: row.campaignId, entityType: row.entityType, entityId: row.entityId, tagId: row.tagId, collectionId: row.collectionId, createdAt: row.createdAt }).onConflictDoNothing().run();
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.bulk.undo', entityType: 'campaign_library_bulk_operation', entityId: operationId, detail: operation.operation, requestId: getRequestId() ?? null, createdAt: nowIso() }).run();
      return { operationId, undone: true, alreadyUndone: false };
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
      // Locations use `unexplored` as their entity-level DM-only state; unlike a
      // dmSecret field it must be withheld wholesale from non-DMs.
      ...locationRows.filter((r) => !r.deletedAt && (isDm || r.status !== 'unexplored')).map((r) => ({ entityType: 'location' as const, entityId: r.id, name: r.name, description: r.body, visibility: r.status === 'unexplored' ? 'hidden' : 'public', status: r.status, owner: null, tags: [], collections: [] })),
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

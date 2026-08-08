import { BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
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
  CampaignLibraryTemplate, CampaignLibraryTemplateSave, CampaignLibraryTemplateInstantiate,
  EncounterTemplateRoster, defaultCombatantStatblock, TokenSize,
  LibraryEntityType,
  type LibraryEntitySummary,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, auditLog, campaignLibraryBulkOperations, campaignLibraryCollections, campaignLibraryEntityTaxonomy, campaignLibraryMonsters, campaignLibraryTags, campaignLibraryTemplates, campaigns, combatants, encounters, factions, inventoryItems, locations, npcs, quests, timelineEvents } from '../../db/schema';
import { fromJsonText, toJsonText } from '../../common/json';
import { nowIso } from '../../common/time';
import { getRequestId } from '../../common/request-context';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { CampaignEventsService } from '../events/campaign-events.service';

type LibraryTransaction = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type TemplateRef = { key: string; table: string; attachmentCommitted?: boolean };
const SOFT_DELETABLE_TEMPLATE_TABLES = new Set(['characters', 'quests', 'npcs', 'locations', 'factions', 'sessions', 'encounters', 'timeline_events', 'inventory_items']);

function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed/i.test(message);
}

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
    private readonly events: CampaignEventsService,
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

  async createTag(campaignId: number, input: CampaignLibraryTagCreate, user: RequestUser, role: Role): Promise<CampaignLibraryTag> {
    await this.assertParent(campaignLibraryTags, campaignId, input.parentTagId); const ts = nowIso();
    try {
      const [row] = await this.db.insert(campaignLibraryTags).values({ campaignId, name: input.name.trim(), aliasesJson: toJsonText(input.aliases ?? []), color: input.color ?? '#64748b', description: input.description ?? '', parentTagId: input.parentTagId ?? null, createdAt: ts, updatedAt: ts }).returning().all();
      await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'campaign_library.tag.create', entityType: 'campaign_library_tag', entityId: row.id, campaignId, detail: input.name.trim() });
      return this.tag(row);
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ConflictException('A tag with that name already exists in this campaign.');
      throw err;
    }
  }
  async createCollection(campaignId: number, input: CampaignLibraryCollectionCreate, user: RequestUser, role: Role): Promise<CampaignLibraryCollection> {
    await this.assertParent(campaignLibraryCollections, campaignId, input.parentCollectionId); const ts = nowIso();
    try {
      const [row] = await this.db.insert(campaignLibraryCollections).values({ campaignId, name: input.name.trim(), aliasesJson: toJsonText(input.aliases ?? []), color: input.color ?? '#64748b', description: input.description ?? '', parentCollectionId: input.parentCollectionId ?? null, createdAt: ts, updatedAt: ts }).returning().all();
      await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'campaign_library.collection.create', entityType: 'campaign_library_collection', entityId: row.id, campaignId, detail: input.name.trim() });
      return this.collection(row);
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ConflictException('A collection with that name already exists in this campaign.');
      throw err;
    }
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

  async updateTag(campaignId: number, id: number, input: CampaignLibraryTagUpdate, user: RequestUser, role: Role): Promise<CampaignLibraryTag> {
    await this.tagRowOrThrow(campaignId, id);
    if (input.parentTagId !== undefined) await this.assertParent(campaignLibraryTags, campaignId, input.parentTagId, id);
    const patch: Partial<typeof campaignLibraryTags.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.aliases !== undefined) patch.aliasesJson = toJsonText(input.aliases);
    if (input.color !== undefined) patch.color = input.color;
    if (input.description !== undefined) patch.description = input.description;
    if (input.parentTagId !== undefined) patch.parentTagId = input.parentTagId;
    try {
      const [row] = await this.db.update(campaignLibraryTags).set(patch).where(and(eq(campaignLibraryTags.id, id), eq(campaignLibraryTags.campaignId, campaignId))).returning().all();
      await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'campaign_library.tag.update', entityType: 'campaign_library_tag', entityId: id, campaignId, detail: row.name });
      return this.tag(row);
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ConflictException('A tag with that name already exists in this campaign.');
      throw err;
    }
  }

  async updateCollection(campaignId: number, id: number, input: CampaignLibraryCollectionUpdate, user: RequestUser, role: Role): Promise<CampaignLibraryCollection> {
    await this.collectionRowOrThrow(campaignId, id);
    if (input.parentCollectionId !== undefined) await this.assertParent(campaignLibraryCollections, campaignId, input.parentCollectionId, id);
    const patch: Partial<typeof campaignLibraryCollections.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.aliases !== undefined) patch.aliasesJson = toJsonText(input.aliases);
    if (input.color !== undefined) patch.color = input.color;
    if (input.description !== undefined) patch.description = input.description;
    if (input.parentCollectionId !== undefined) patch.parentCollectionId = input.parentCollectionId;
    try {
      const [row] = await this.db.update(campaignLibraryCollections).set(patch).where(and(eq(campaignLibraryCollections.id, id), eq(campaignLibraryCollections.campaignId, campaignId))).returning().all();
      await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'campaign_library.collection.update', entityType: 'campaign_library_collection', entityId: id, campaignId, detail: row.name });
      return this.collection(row);
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ConflictException('A collection with that name already exists in this campaign.');
      throw err;
    }
  }

  /** Delete is intentionally destructive in alpha: taxonomy references are removed, children become roots. */
  async removeTag(campaignId: number, id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.tagRowOrThrow(campaignId, id);
    this.db.transaction((tx) => {
      tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.tagId, id))).run();
      tx.update(campaignLibraryTags).set({ parentTagId: null, updatedAt: nowIso() }).where(and(eq(campaignLibraryTags.campaignId, campaignId), eq(campaignLibraryTags.parentTagId, id))).run();
      tx.delete(campaignLibraryTags).where(and(eq(campaignLibraryTags.id, id), eq(campaignLibraryTags.campaignId, campaignId))).run();
    });
    await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'campaign_library.tag.delete', entityType: 'campaign_library_tag', entityId: id, campaignId, detail: existing.name });
  }

  async removeCollection(campaignId: number, id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.collectionRowOrThrow(campaignId, id);
    this.db.transaction((tx) => {
      tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.collectionId, id))).run();
      tx.update(campaignLibraryCollections).set({ parentCollectionId: null, updatedAt: nowIso() }).where(and(eq(campaignLibraryCollections.campaignId, campaignId), eq(campaignLibraryCollections.parentCollectionId, id))).run();
      tx.delete(campaignLibraryCollections).where(and(eq(campaignLibraryCollections.id, id), eq(campaignLibraryCollections.campaignId, campaignId))).run();
    });
    await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'campaign_library.collection.delete', entityType: 'campaign_library_collection', entityId: id, campaignId, detail: existing.name });
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
    // Issue #1901 review (chatgpt-codex-connector P2): a bulk move/archive that clears an
    // equipped, action-granting item's equip state changes the owning character's merged
    // usable-action list exactly like the single-item PATCH does (InventoryService.update),
    // but this transactional path never emitted the invalidation — an already-open encounter
    // card or /turn query stayed stale until an unrelated refetch. Collected here (escapes the
    // synchronous transaction closure) and emitted once the transaction has committed.
    const affectedCharacterIds = new Set<number>();
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
      const locationCurrentTargets = request.operation === 'set_status' && request.status === 'current'
        ? request.targets.filter((target) => target.entityType === 'location')
        : [];
      if (locationCurrentTargets.length > 1) throw new BadRequestException('Only one location can be set to current at a time');
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
        // Issue #1326 review (Codex/coordinator): equip state must round-trip through
        // undo the same way move_inventory_owner/archive/restore already round-trip
        // owner/deletion — so both snapshot branches also capture equipped/equip_slot/
        // equipped_action for inventory_item targets (harmless — and always present —
        // for every other entity type's plain scalar snapshot, since inventory_items is
        // the only table with these columns). All three travel together per
        // CLEARED_EQUIP_STATE's rule: a partial snapshot (equip flags without the
        // granted action, or vice versa) is exactly the half-clear this PR's review kept
        // finding on other paths.
        const row = request.operation === 'move_inventory_owner'
          ? tx.get(
              sql`select owner_type as ownerType, character_id as characterId, equipped as equipped, equip_slot as equipSlot, equipped_action as equippedAction, equipped_action_source as equippedActionSource from ${sql.raw(name)} where id=${target.entityId} and campaign_id=${campaignId}`,
            )
          : target.entityType === 'inventory_item'
            ? tx.get(
                sql`select ${sql.raw(field)} as value, owner_type as ownerType, character_id as characterId, equipped as equipped, equip_slot as equipSlot, equipped_action as equippedAction, equipped_action_source as equippedActionSource from ${sql.raw(name)} where id=${target.entityId} and campaign_id=${campaignId}`,
              )
            : tx.get(sql`select ${sql.raw(field)} as value from ${sql.raw(name)} where id=${target.entityId} and campaign_id=${campaignId}`);
        if (!row) throw new NotFoundException(`${target.entityType} ${target.entityId} not found in this campaign`);
        snapshots.push({ entityType: target.entityType, entityId: target.entityId, value: row });
      }
      // Mirror LocationsService.discover: at most one current location, plus the
      // campaign pointer. Demotions are journaled so undo can restore both.
      let locationPromotion: { previousCurrentLocationId: number | null; demoted: Array<{ entityId: number; previousStatus: string }> } | undefined;
      if (locationCurrentTargets.length === 1) {
        const promotedId = locationCurrentTargets[0].entityId;
        const campaign = tx.select({ currentLocationId: campaigns.currentLocationId }).from(campaigns).where(eq(campaigns.id, campaignId)).get();
        const demoted = tx.all(sql`select id as entityId, status as previousStatus from locations where campaign_id=${campaignId} and status='current' and id!=${promotedId} and deleted_at is null`)
          .map((row) => z.object({ entityId: z.number().int(), previousStatus: z.string() }).parse(row));
        for (const row of demoted) tx.run(sql`update locations set status='explored', updated_at=${ts} where id=${row.entityId} and campaign_id=${campaignId}`);
        locationPromotion = { previousCurrentLocationId: campaign?.currentLocationId ?? null, demoted };
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
        } else if (request.operation === 'move_inventory_owner') {
          // Issue #1326 review (Codex/Devin/coordinator): this bulk move has no equip
          // fields of its own (LibraryBulkRequest carries only ownerType/characterId
          // here), so — the CLEARED_EQUIP_STATE rule InventoryService.update's move
          // branch also enforces — a bulk owner change ALWAYS clears equipped, equip_slot,
          // AND equipped_action together (unconditional: nothing in this request could
          // re-establish any of the three for the new owner). Left unguarded, this
          // bypassed the single-item PATCH's fix entirely: a bulk move to another
          // character silently armed them with the item's equippedAction (or could 409 a
          // legitimate future equip via a stale duplicate-slot row), a bulk move to the
          // party stash could leave equipped=1 on a party-owned row (invalid per
          // `update()`), and — the read-side half of the same bug — a previously-redacted
          // character-private action became visible campaign-wide the moment the item
          // reached the party stash, since `redactEquippedActions` never checks a party
          // item's equippedAction at all.
          const snapshot = snapshots.find((s) => s.entityType === target.entityType && s.entityId === target.entityId);
          if (!snapshot) throw new InternalServerErrorException('move snapshot missing for target');
          const before = z
            .object({
              ownerType: z.string(),
              characterId: z.number().int().nullable(),
              equipped: z.number().int().optional(),
            })
            .parse(snapshot.value);
          const moved = before.ownerType !== request.ownerType || before.characterId !== (request.characterId ?? null);
          if (moved) {
            tx.run(
              sql`update inventory_items set owner_type=${request.ownerType}, character_id=${request.characterId ?? null}, equipped=0, equip_slot=NULL, equipped_action=NULL, equipped_action_source=NULL, updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`,
            );
            // Issue #1901 review (chatgpt-codex-connector P2): the previous owner just lost
            // this item's merged action (if any) — invalidate their cached actions/turn
            // payload. The new owner never gains equip state through this path (always
            // cleared above), so only the FORMER character owner needs the signal.
            if (before.ownerType === 'character' && before.characterId != null && before.equipped === 1) {
              affectedCharacterIds.add(before.characterId);
            }
          } else {
            // No-op owner re-assignment: keep equip state intact, but bump updated_at so
            // the post-operation version fence still matches for undo.
            tx.run(sql`update inventory_items set updated_at=${ts} where id=${target.entityId} and campaign_id=${campaignId}`);
          }
        } else {
          // Issue #1326 review (coordinator): mirrors InventoryService.remove() — an
          // inventory item archived through the bulk tool must clear equipped/equipSlot
          // so a replacement can claim the slot, but equipped_action is inert while
          // equipped is false and should round-trip (the snapshot preserves it).
          const clearEquipOnArchive = request.operation === 'archive' && target.entityType === 'inventory_item';
          const archiveSnapshot = clearEquipOnArchive
            ? z
                .object({
                  ownerType: z.string(),
                  characterId: z.number().int().nullable().optional(),
                  equipped: z.number().int().optional(),
                })
                .parse(snapshots.find((s) => s.entityType === target.entityType && s.entityId === target.entityId)?.value)
            : null;
          const archiveClearAction = archiveSnapshot ? archiveSnapshot.ownerType !== 'character' : false;
          // Issue #1901 review (chatgpt-codex-connector P2): archiving an equipped
          // character-owned item drops it out of the merged action list the same way
          // unequipping does (equippedItemActionRows only reads equipped=true rows) —
          // invalidate the owner's cached actions/turn payload.
          if (archiveSnapshot && archiveSnapshot.ownerType === 'character' && archiveSnapshot.characterId != null && archiveSnapshot.equipped === 1) {
            affectedCharacterIds.add(archiveSnapshot.characterId);
          }
          tx.run(
            sql`update ${sql.raw(name)} set deleted_at=${request.operation === 'archive' ? ts : null}, updated_at=${ts}${clearEquipOnArchive ? sql`, equipped=0, equip_slot=NULL${archiveClearAction ? sql`, equipped_action=NULL, equipped_action_source=NULL` : sql``}` : sql``} where id=${target.entityId} and campaign_id=${campaignId}`,
          );
        }
      }
      if (locationPromotion && locationCurrentTargets[0]) {
        tx.update(campaigns).set({ currentLocationId: locationCurrentTargets[0].entityId, updatedAt: ts }).where(eq(campaigns.id, campaignId)).run();
      }
      const afterVersions = request.targets.map((target) => ({ entityType: target.entityType, entityId: target.entityId, updatedAt: ts }));
      const journal = { kind: 'field' as const, snapshots, afterVersions, ...(locationPromotion ? { locationPromotion } : {}) };
      const inserted = tx.insert(campaignLibraryBulkOperations).values({ campaignId, actor: auditActor(user), operation: request.operation, beforeJson: toJsonText(journal), afterJson: toJsonText(request), inverseJson: toJsonText(journal), createdAt: ts }).returning({ id: campaignLibraryBulkOperations.id }).get();
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.bulk', entityType: 'campaign_library_bulk_operation', entityId: inserted.id, detail: request.operation, requestId: getRequestId() ?? null, createdAt: ts }).run();
      return inserted.id;
    });
    for (const characterId of affectedCharacterIds) {
      this.events.emit({ type: 'character.updated', campaignId, characterId, userId: user.id });
    }
    return { operationId: result, applied: request.targets.length, undoAvailable: true };
  }

  async undoBulk(campaignId: number, operationId: number, user: RequestUser, role: Role) {
    const JournalRows = z.array(z.object({ id: z.number().int(), campaignId: z.number().int(), entityType: z.string(), entityId: z.number().int(), tagId: z.number().int().nullable(), collectionId: z.number().int().nullable(), createdAt: z.string() }).strict());
    // Issue #1901 review (chatgpt-codex-connector P2): undo can restore an equipped,
    // action-granting item's equip state onto a character — same invalidation gap as
    // bulkEntityFields above. Collected here so it escapes the transaction closure and is
    // emitted once the transaction has committed.
    const affectedCharacterIds = new Set<number>();
    const result = this.db.transaction((tx) => {
      const operation = tx.select().from(campaignLibraryBulkOperations).where(and(eq(campaignLibraryBulkOperations.id, operationId), eq(campaignLibraryBulkOperations.campaignId, campaignId))).get();
      if (!operation) throw new NotFoundException(`Bulk operation ${operationId} not found`);
      // Claim before inverse writes; this gives concurrent callers exactly one winner.
      const claimed = tx.update(campaignLibraryBulkOperations).set({ undoneAt: nowIso(), undoneBy: auditActor(user) }).where(and(eq(campaignLibraryBulkOperations.id, operationId), eq(campaignLibraryBulkOperations.campaignId, campaignId), isNull(campaignLibraryBulkOperations.undoneAt))).run();
      if (claimed.changes === 0) return { operationId, undone: true, alreadyUndone: true };
      const request = LibraryBulkRequest.parse(JSON.parse(operation.afterJson));
      if (!('taxonomyId' in request)) {
        const FieldJournal = z.object({
          kind: z.literal('field'),
          snapshots: z.array(z.object({ entityType: z.string(), entityId: z.number().int(), value: z.unknown() }).strict()),
          afterVersions: z.array(z.object({ entityType: z.string(), entityId: z.number().int(), updatedAt: z.string() }).strict()).optional(),
          locationPromotion: z.object({
            previousCurrentLocationId: z.number().int().nullable(),
            demoted: z.array(z.object({ entityId: z.number().int(), previousStatus: z.string() }).strict()),
          }).strict().optional(),
        }).strict();
        const journal = FieldJournal.parse(JSON.parse(operation.beforeJson));
        const table = (type: string) => ({ quest: 'quests', npc: 'npcs', location: 'locations', faction: 'factions', encounter: 'encounters', timeline_event: 'timeline_events', inventory_item: 'inventory_items', attachment: 'attachments' } as Record<string, string>)[type];
        const versionFence = (row: { entityType: string; entityId: number }) => {
          const version = journal.afterVersions?.find((entry) => entry.entityType === row.entityType && entry.entityId === row.entityId)?.updatedAt;
          return version == null ? sql`` : sql` and updated_at=${version}`;
        };
        for (const row of journal.snapshots) {
          const name = table(row.entityType);
          const value = z.record(z.string(), z.unknown()).parse(row.value);
          if (request.operation === 'set_visibility') {
            const before = z.object({ value: z.union([z.string(), z.number()]) }).parse(value).value;
            const after = row.entityType === 'location' ? (request.visibility === 'hidden' ? 'unexplored' : before === 'unexplored' ? 'explored' : before) : request.visibility === 'hidden' ? 1 : 0;
            const field = row.entityType === 'location' ? 'status' : 'hidden';
            if (!tx.get(sql`select id from ${sql.raw(name)} where id=${row.entityId} and campaign_id=${campaignId} and ${sql.raw(field)}=${after}${versionFence(row)}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            tx.run(sql`update ${sql.raw(name)} set ${sql.raw(field)}=${before}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
          }
          else if (request.operation === 'set_status') {
            const scalar = z.object({ value: z.string() }).parse(value);
            const field = row.entityType === 'npc' ? 'disposition' : row.entityType === 'faction' ? 'standing' : 'status';
            if (!tx.get(sql`select id from ${sql.raw(name)} where id=${row.entityId} and campaign_id=${campaignId} and ${sql.raw(field)}=${request.status}${versionFence(row)}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            tx.run(sql`update ${sql.raw(name)} set ${sql.raw(field)}=${scalar.value}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
          } else if (request.operation === 'move_inventory_owner') {
            // Issue #1326 review (coordinator, upgrade compatibility): equipped/equipSlot
            // are OPTIONAL here, not required — a bulk move recorded by the PRE-#1326
            // binary never had these keys in its snapshot at all. Requiring them would
            // make undoBulk() throw on every such pre-upgrade journal row, permanently
            // blocking a legitimate undo. Missing means "recorded before equip state
            // existed", which is correctly read as `equipped: undefined` (!== 1, so
            // `canRestoreEquip` below is false) and `equipSlot: undefined` — never
            // migrate the stored rows to backfill this; the tolerant read is sufficient
            // and strictly safer (an old journal row is simply data, never re-validated
            // against today's business rules beyond what's read here).
            const before = z
              .object({
                ownerType: z.string(),
                characterId: z.number().int().nullable(),
                equipped: z.number().int().optional(),
                equipSlot: z.string().nullable().optional(),
                equippedAction: z.string().nullable().optional(),
                equippedActionSource: z.string().nullable().optional(),
              })
              .parse(value);
            if (!tx.get(sql`select id from inventory_items where id=${row.entityId} and campaign_id=${campaignId} and owner_type=${request.ownerType} and character_id is ${request.characterId ?? null}${versionFence(row)}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            // Issue #1326 review (Codex/coordinator): restore the pre-move equip triple —
            // equipped, equipSlot, AND equippedAction together (CLEARED_EQUIP_STATE's
            // rule) — but only when it is safe: the item can only be equipped on a
            // character owner, and only if no OTHER item has since claimed that slot on
            // that character. A conflict here is surfaced the same way the single-item
            // PATCH surfaces it: reject, rather than silently dropping the equip,
            // displacing the incumbent, or restoring the triple only halfway.
            const canRestoreEquip = before.equipped === 1 && before.ownerType === 'character' && before.characterId != null && before.equipSlot != null;
            if (canRestoreEquip && this.inventoryEquipSlotConflict(tx, campaignId, before.characterId!, before.equipSlot!, row.entityId)) {
              throw new ConflictException('Undo would re-equip this item into a slot another item now occupies; unequip that item first.');
            }
            // Issue #1326 review: an unequipped-but-authored item can legitimately carry
            // an equippedAction, so the snapshot's action should round-trip with the
            // owner. Only party-stash destinations must remain action-free.
            const restoreEquippedAction = before.ownerType === 'character' ? (before.equippedAction ?? null) : null;
            tx.run(
              sql`update inventory_items set owner_type=${before.ownerType}, character_id=${before.characterId}, equipped=${canRestoreEquip ? 1 : 0}, equip_slot=${canRestoreEquip ? before.equipSlot : null}, equipped_action=${restoreEquippedAction}, equipped_action_source=${restoreEquippedAction ? (before.equippedActionSource ?? null) : null}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`,
            );
            // Issue #1901 review (chatgpt-codex-connector P2): the restored character gains
            // this item's action back into their merged list — invalidate their cache.
            if (canRestoreEquip) affectedCharacterIds.add(before.characterId!);
          } else {
            const scalar = z
              .object({
                value: z.string().nullable(),
                ownerType: z.string().optional(),
                characterId: z.number().int().nullable().optional(),
                equipped: z.number().int().optional(),
                equipSlot: z.string().nullable().optional(),
                equippedAction: z.string().nullable().optional(),
                equippedActionSource: z.string().nullable().optional(),
              })
              .parse(value);
            const after = request.operation === 'archive' ? operation.createdAt : null;
            if (!tx.get(sql`select id from ${sql.raw(name)} where id=${row.entityId} and campaign_id=${campaignId} and deleted_at is ${after}${versionFence(row)}`)) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            if (row.entityType === 'inventory_item' && request.operation === 'restore') {
              // Undoing a RESTORE re-archives the item. Its equip state was already
              // cleared when the original archive ran (mirrors InventoryService.remove()),
              // so there is nothing to restore here — just clear equipped/equipSlot.
              // equipped_action is inert while equipped is false, but must still be kept
              // only on character owners; party-stash items must never carry a private
              // character action, even in the trash.
              const owner = z
                .object({ ownerType: z.string(), characterId: z.number().int().nullable() })
                .parse(tx.get(sql`select owner_type as ownerType, character_id as characterId from inventory_items where id=${row.entityId} and campaign_id=${campaignId}`));
              const keepEquippedAction = owner.ownerType === 'character' ? (scalar.equippedAction ?? null) : null;
              tx.run(sql`update inventory_items set deleted_at=${scalar.value}, equipped=0, equip_slot=NULL, equipped_action=${keepEquippedAction}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
              // Issue #1901 review (chatgpt-codex-connector P2): re-archiving may drop this
              // item's action back out of the owner's merged list — invalidate their cache
              // whenever the owner is a character (harmless extra invalidation if the item
              // wasn't actually equipped going in; missing it is the real defect).
              if (owner.ownerType === 'character' && owner.characterId != null) affectedCharacterIds.add(owner.characterId);
            } else if (row.entityType === 'inventory_item' && request.operation === 'archive') {
              // Undoing an ARCHIVE un-deletes the item AND restores its pre-archive equip
              // triple — subject to the same slot-safety check as the move-owner undo
              // above. equippedAction is inert while equipped is false, but must still be
              // kept only on character owners; party-stash items must never carry a private
              // character action.
              const owner = z
                .object({ ownerType: z.string(), characterId: z.number().int().nullable() })
                .parse(tx.get(sql`select owner_type as ownerType, character_id as characterId from inventory_items where id=${row.entityId} and campaign_id=${campaignId}`));
              const canRestoreEquip = scalar.equipped === 1 && owner.ownerType === 'character' && owner.characterId != null && scalar.equipSlot != null;
              if (canRestoreEquip && this.inventoryEquipSlotConflict(tx, campaignId, owner.characterId!, scalar.equipSlot!, row.entityId)) {
                throw new ConflictException('Undo would re-equip this item into a slot another item now occupies; unequip that item first.');
              }
              const keepEquippedAction = owner.ownerType === 'character' ? (scalar.equippedAction ?? null) : null;
              tx.run(
                sql`update inventory_items set deleted_at=${scalar.value}, equipped=${canRestoreEquip ? 1 : 0}, equip_slot=${canRestoreEquip ? scalar.equipSlot : null}, equipped_action=${keepEquippedAction}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`,
              );
              // Issue #1901 review (chatgpt-codex-connector P2): undoing the archive can
              // restore this item's action into the owner's merged list.
              if (canRestoreEquip && owner.characterId != null) affectedCharacterIds.add(owner.characterId);
            } else {
              tx.run(sql`update ${sql.raw(name)} set deleted_at=${scalar.value}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
            }
          }
        }
        if (journal.locationPromotion) {
          const promoted = request.targets.find((target) => target.entityType === 'location');
          if (!promoted) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
          if (!tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.currentLocationId, promoted.entityId))).get()) {
            throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
          }
          for (const row of journal.locationPromotion.demoted) {
            if (!tx.get(sql`select id from locations where id=${row.entityId} and campaign_id=${campaignId} and status='explored'`)) {
              throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
            }
            tx.run(sql`update locations set status=${row.previousStatus}, updated_at=${nowIso()} where id=${row.entityId} and campaign_id=${campaignId}`);
          }
          tx.update(campaigns).set({ currentLocationId: journal.locationPromotion.previousCurrentLocationId, updatedAt: nowIso() }).where(eq(campaigns.id, campaignId)).run();
        }
        tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.bulk.undo', entityType: 'campaign_library_bulk_operation', entityId: operationId, detail: operation.operation, requestId: getRequestId() ?? null, createdAt: nowIso() }).run();
        return { operationId, undone: true, alreadyUndone: false };
      }
      const rows = JournalRows.parse(JSON.parse(operation.beforeJson));
      const isTag = request.operation === 'add_tag' || request.operation === 'remove_tag';
      // Conflict fence: post-op membership must still match what this operation left
      // behind, so a no-op (or later collaborator edit) cannot erase newer work.
      for (const target of request.targets) {
        const predicate = and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityType, target.entityType), eq(campaignLibraryEntityTaxonomy.entityId, target.entityId), isTag ? eq(campaignLibraryEntityTaxonomy.tagId, request.taxonomyId) : eq(campaignLibraryEntityTaxonomy.collectionId, request.taxonomyId));
        const linked = !!tx.select({ id: campaignLibraryEntityTaxonomy.id }).from(campaignLibraryEntityTaxonomy).where(predicate).get();
        const expectLinked = request.operation === 'add_tag' || request.operation === 'add_collection' || request.operation === 'move_collection';
        if (linked !== expectLinked) throw new ConflictException('A target changed after this bulk operation; undo would overwrite it');
      }
      for (const target of request.targets) {
        // Undo only the dimension this operation touched.  A tag or collection a
        // collaborator added later is never deleted by an older undo.
        if (request.operation === 'move_collection') tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityType, target.entityType), eq(campaignLibraryEntityTaxonomy.entityId, target.entityId), eq(campaignLibraryEntityTaxonomy.collectionId, request.taxonomyId))).run();
        else tx.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityType, target.entityType), eq(campaignLibraryEntityTaxonomy.entityId, target.entityId), isTag ? eq(campaignLibraryEntityTaxonomy.tagId, request.taxonomyId) : eq(campaignLibraryEntityTaxonomy.collectionId, request.taxonomyId))).run();
      }
      // Restore only the mutated dimension. Re-inserting every pre-op membership
      // would resurrect unrelated links a collaborator removed after the bulk edit.
      const restoreRows = rows.filter((row) => {
        if (request.operation === 'move_collection') return row.collectionId != null;
        if (isTag) return row.tagId === request.taxonomyId;
        return row.collectionId === request.taxonomyId;
      });
      for (const row of restoreRows) tx.insert(campaignLibraryEntityTaxonomy).values({ campaignId: row.campaignId, entityType: row.entityType, entityId: row.entityId, tagId: row.tagId, collectionId: row.collectionId, createdAt: row.createdAt }).onConflictDoNothing().run();
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.bulk.undo', entityType: 'campaign_library_bulk_operation', entityId: operationId, detail: operation.operation, requestId: getRequestId() ?? null, createdAt: nowIso() }).run();
      return { operationId, undone: true, alreadyUndone: false };
    });
    for (const characterId of affectedCharacterIds) {
      this.events.emit({ type: 'character.updated', campaignId, characterId, userId: user.id });
    }
    return result;
  }

  /**
   * One role-filtered inventory of campaign content.  This intentionally builds a
   * small, explicit projection rather than exposing arbitrary table columns: the
   * manager can never accidentally leak a dmSecret while new entity kinds are added.
   *
   * Role/visibility/soft-delete filters and column projection are pushed into SQL so
   * each request materializes only the summary fields for rows the caller may see —
   * never full entity rows (dmSecret, encounter map state, monster statblocks, …).
   * Faceting across the polymorphic union still happens in-process after that
   * projection; a later SQL facet rewrite can replace that without changing the API.
   */
  async search(campaignId: number, role: Role, raw: unknown): Promise<LibrarySearchPage> {
    const query = LibrarySearchQuery.parse(raw);
    const isDm = role === 'dm';
    const [questRows, npcRows, locationRows, factionRows, encounterRows, timelineRows, inventoryRows, attachmentRows, monsterRows] = await Promise.all([
      this.db.select({ id: quests.id, title: quests.title, body: quests.body, status: quests.status, hidden: quests.hidden })
        .from(quests).where(and(eq(quests.campaignId, campaignId), isNull(quests.deletedAt), ...(isDm ? [] : [eq(quests.hidden, false)]))),
      this.db.select({ id: npcs.id, name: npcs.name, body: npcs.body, disposition: npcs.disposition, hidden: npcs.hidden })
        .from(npcs).where(and(eq(npcs.campaignId, campaignId), isNull(npcs.deletedAt), ...(isDm ? [] : [eq(npcs.hidden, false)]))),
      // Locations use `unexplored` as their entity-level DM-only state; unlike a
      // dmSecret field it must be withheld wholesale from non-DMs.
      this.db.select({ id: locations.id, name: locations.name, body: locations.body, status: locations.status })
        .from(locations).where(and(eq(locations.campaignId, campaignId), isNull(locations.deletedAt), ...(isDm ? [] : [ne(locations.status, 'unexplored')]))),
      this.db.select({ id: factions.id, name: factions.name, body: factions.body, standing: factions.standing, hidden: factions.hidden })
        .from(factions).where(and(eq(factions.campaignId, campaignId), isNull(factions.deletedAt), ...(isDm ? [] : [eq(factions.hidden, false)]))),
      this.db.select({ id: encounters.id, name: encounters.name, status: encounters.status, hidden: encounters.hidden })
        .from(encounters).where(and(eq(encounters.campaignId, campaignId), isNull(encounters.deletedAt), ...(isDm ? [] : [eq(encounters.hidden, false)]))),
      this.db.select({ id: timelineEvents.id, title: timelineEvents.title, body: timelineEvents.body, hidden: timelineEvents.hidden })
        .from(timelineEvents).where(and(eq(timelineEvents.campaignId, campaignId), isNull(timelineEvents.deletedAt), ...(isDm ? [] : [eq(timelineEvents.hidden, false)]))),
      this.db.select({ id: inventoryItems.id, name: inventoryItems.name, notes: inventoryItems.notes, ownerType: inventoryItems.ownerType, characterId: inventoryItems.characterId })
        .from(inventoryItems).where(and(eq(inventoryItems.campaignId, campaignId), isNull(inventoryItems.deletedAt))),
      this.db.select({ id: attachments.id, filename: attachments.filename, mime: attachments.mime, kind: attachments.kind, hidden: attachments.hidden, uploaderUserId: attachments.uploaderUserId })
        .from(attachments).where(and(eq(attachments.campaignId, campaignId), eq(attachments.state, 'committed'), ...(isDm ? [] : [eq(attachments.hidden, false)]))),
      this.db.select({ id: campaignLibraryMonsters.id, name: campaignLibraryMonsters.name })
        .from(campaignLibraryMonsters).where(eq(campaignLibraryMonsters.campaignId, campaignId)),
    ]);
    let items: LibraryEntitySummary[] = [
      ...questRows.map((r) => ({ entityType: 'quest' as const, entityId: r.id, name: r.title, description: r.body, visibility: r.hidden ? 'hidden' as const : 'public' as const, status: r.status, owner: null, tags: [], collections: [] })),
      ...npcRows.map((r) => ({ entityType: 'npc' as const, entityId: r.id, name: r.name, description: r.body, visibility: r.hidden ? 'hidden' as const : 'public' as const, status: r.disposition, owner: null, tags: [], collections: [] })),
      ...locationRows.map((r) => ({ entityType: 'location' as const, entityId: r.id, name: r.name, description: r.body, visibility: r.status === 'unexplored' ? 'hidden' as const : 'public' as const, status: r.status, owner: null, tags: [], collections: [] })),
      ...factionRows.map((r) => ({ entityType: 'faction' as const, entityId: r.id, name: r.name, description: r.body, visibility: r.hidden ? 'hidden' as const : 'public' as const, status: r.standing, owner: null, tags: [], collections: [] })),
      ...encounterRows.map((r) => ({ entityType: 'encounter' as const, entityId: r.id, name: r.name, description: '', visibility: r.hidden ? 'hidden' as const : 'public' as const, status: r.status, owner: null, tags: [], collections: [] })),
      ...timelineRows.map((r) => ({ entityType: 'timeline_event' as const, entityId: r.id, name: r.title, description: r.body, visibility: r.hidden ? 'hidden' as const : 'public' as const, status: null, owner: null, tags: [], collections: [] })),
      ...inventoryRows.map((r) => ({ entityType: 'inventory_item' as const, entityId: r.id, name: r.name, description: r.notes, visibility: 'public' as const, status: null, owner: r.ownerType === 'party' ? 'party' : `character:${r.characterId}`, tags: [], collections: [] })),
      ...attachmentRows.map((r) => ({ entityType: 'attachment' as const, entityId: r.id, name: r.filename, description: r.mime, visibility: r.hidden ? 'hidden' as const : 'public' as const, status: r.kind, owner: r.uploaderUserId, tags: [], collections: [] })),
      ...monsterRows.map((r) => ({ entityType: 'campaign_library_monster' as const, entityId: r.id, name: r.name, description: '', visibility: 'public' as const, status: null, owner: null, tags: [], collections: [] })),
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
    // Each facet is counted with every active filter except its own dimension, so
    // clients can switch filters without first clearing the current selection.
    const matches = (item: LibraryEntitySummary, except: 'type' | 'tag' | 'collection' | 'visibility' | 'status' | 'owner' | null) =>
      (except === 'type' || !query.type || item.entityType === query.type)
      && (except === 'tag' || !query.tagId || item.tags.some((tag) => tag.id === query.tagId))
      && (except === 'collection' || !query.collectionId || item.collections.some((collection) => collection.id === query.collectionId))
      && (except === 'visibility' || !query.visibility || item.visibility === query.visibility)
      && (except === 'status' || !query.status || item.status === query.status)
      && (except === 'owner' || !query.owner || item.owner === query.owner);
    const count = <T extends string | number>(values: T[], label: (value: T) => string) => [...new Map(values.map((value) => [value, (values.filter((entry) => entry === value).length)])).entries()].map(([id, total]) => ({ id, label: label(id), count: total }));
    const forTypes = items.filter((item) => matches(item, 'type'));
    const forTags = items.filter((item) => matches(item, 'tag'));
    const forCollections = items.filter((item) => matches(item, 'collection'));
    const forVisibility = items.filter((item) => matches(item, 'visibility'));
    const forStatus = items.filter((item) => matches(item, 'status'));
    items = items.filter((item) => matches(item, null));
    items.sort((a, b) => a.name.localeCompare(b.name) || a.entityType.localeCompare(b.entityType) || a.entityId - b.entityId);
    return LibrarySearchPage.parse({
      items: items.slice(query.offset, query.offset + query.limit),
      total: items.length,
      limit: query.limit,
      offset: query.offset,
      facets: {
        types: count(forTypes.map((item) => item.entityType), (type) => type),
        tags: tags.map((tag) => ({ id: tag.id, label: tag.name, count: forTags.filter((item) => item.tags.some((value) => value.id === tag.id)).length })).filter((facet) => facet.count > 0),
        collections: collections.map((collection) => ({ id: collection.id, label: collection.name, count: forCollections.filter((item) => item.collections.some((value) => value.id === collection.id)).length })).filter((facet) => facet.count > 0),
        visibility: count(forVisibility.map((item) => item.visibility ?? 'public'), (value) => value),
        status: count(forStatus.flatMap((item) => item.status == null ? [] : [item.status]), (value) => value),
      },
    });
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

  /**
   * The library is deliberately a current-format feature: a template is a small,
   * explicit create payload, not a serialized database row or a versioned backup.
   * Keeping the field lists here makes adding an entity an intentional reviewable
   * decision and prevents ids, tombstones and encounter play state leaking through.
   */
  private readonly templateAdapters: Record<Exclude<LibraryEntityType, 'attachment'>, { table: string; fields: readonly string[]; refs: Record<string, TemplateRef> }> = {
    quest: { table: 'quests', fields: ['parent_id', 'title', 'body', 'status', 'giver_npc_id', 'reward', 'dm_secret', 'hidden', 'sort_order'], refs: { parent_id: { key: 'parentId', table: 'quests' }, giver_npc_id: { key: 'giverNpcId', table: 'npcs' } } },
    npc: { table: 'npcs', fields: ['name', 'role', 'disposition', 'location_id', 'faction_id', 'body', 'dm_secret', 'portrait_url', 'icon_slug', 'hidden'], refs: { location_id: { key: 'locationId', table: 'locations' }, faction_id: { key: 'factionId', table: 'factions' } } },
    location: { table: 'locations', fields: ['parent_id', 'name', 'kind', 'status', 'map_x', 'map_y', 'body', 'dm_secret', 'portrait_url'], refs: { parent_id: { key: 'parentId', table: 'locations' } } },
    faction: { table: 'factions', fields: ['name', 'kind', 'body', 'goals', 'dm_secret', 'hidden', 'reputation', 'standing', 'portrait_url'], refs: {} },
    timeline_event: { table: 'timeline_events', fields: ['title', 'in_world_date', 'body', 'era', 'sort_index', 'dm_secret', 'hidden'], refs: {} },
    inventory_item: { table: 'inventory_items', fields: ['owner_type', 'character_id', 'name', 'qty', 'notes', 'icon_slug'], refs: { character_id: { key: 'characterId', table: 'characters' } } },
    campaign_library_monster: { table: 'campaign_library_monsters', fields: ['name', 'statblock_json', 'source_rule_entry_id'], refs: { source_rule_entry_id: { key: 'sourceRuleEntryId', table: 'rule_entries' } } },
    // Encounters snapshot map/grid geometry and roster composition (non-character/non-NPC combatant
    // statblocks and counts). Play state — runtime initiative, damage, temp HP, conditions, death state,
    // turn pointer, active effects, and token positions — is stripped on save, and PCs/NPCs join through existing runtime flows.
    encounter: { table: 'encounters', fields: ['name', 'location_id', 'quest_id', 'session_id', 'map_attachment_id', 'grid_size', 'grid_scale', 'grid_unit', 'grid_snap', 'fog', 'grid_type', 'hex_orientation', 'aoe', 'grid_offset_x', 'grid_offset_y', 'grid_cell_height', 'grid_rotation', 'grid_opacity', 'hidden'], refs: { location_id: { key: 'locationId', table: 'locations' }, quest_id: { key: 'questId', table: 'quests' }, session_id: { key: 'sessionId', table: 'sessions' }, map_attachment_id: { key: 'mapAttachmentId', table: 'attachments', attachmentCommitted: true } } },
  };

  private buildEncounterTemplateRoster(rawCombatants: Array<Record<string, unknown>>): z.infer<typeof EncounterTemplateRoster> {
    const valid = rawCombatants.filter((c) => c.character_id == null && c.npc_id == null && c.kind !== 'character');
    const groups: Array<{
      kind: 'character' | 'monster' | 'npc';
      name: string;
      baseName: string;
      statblock: CombatantStatblock | null;
      hpMax: number;
      initMod: number;
      tokenSize: TokenSize;
      sortOrder: number;
      count: number;
    }> = [];

    for (const c of valid) {
      const rawName = String(c.name ?? '');
      const baseName = rawName.replace(/\s+\d+$/, '').trim() || rawName;
      const kind = (c.kind as 'monster' | 'npc') ?? 'monster';
      const hpMax = Number(c.hp_max ?? c.hpMax ?? 0);
      const initMod = Number(c.init_mod ?? c.initMod ?? 0);
      const tokenSize = (String(c.token_size ?? c.tokenSize ?? 'medium')) as TokenSize;
      const sortOrder = Number(c.sort_order ?? c.sortOrder ?? 0);
      const statblockText = (c.statblock_json ?? c.statblockJson) as string | null;
      let statblock: CombatantStatblock | null = null;
      if (statblockText) {
        const parsed = CombatantStatblock.safeParse(fromJsonText(statblockText, null));
        if (parsed.success) statblock = parsed.data;
      }

      const match = groups.find((g) =>
        g.kind === kind &&
        g.baseName === baseName &&
        g.hpMax === hpMax &&
        g.initMod === initMod &&
        g.tokenSize === tokenSize &&
        JSON.stringify(g.statblock) === JSON.stringify(statblock)
      );

      if (match) {
        match.count += 1;
      } else {
        groups.push({
          kind,
          name: rawName,
          baseName,
          statblock,
          hpMax,
          initMod,
          tokenSize,
          sortOrder,
          count: 1,
        });
      }
    }

    const rosterEntries = groups.map((g) => ({
      kind: g.kind,
      name: g.count > 1 ? g.baseName : g.name,
      statblock: g.statblock,
      hpMax: g.hpMax,
      initMod: g.initMod,
      tokenSize: g.tokenSize,
      sortOrder: g.sortOrder,
      count: g.count,
    }));

    return EncounterTemplateRoster.parse(rosterEntries);
  }

  private templateRow(row: typeof campaignLibraryTemplates.$inferSelect): z.infer<typeof CampaignLibraryTemplate> {
    return CampaignLibraryTemplate.parse({ id: row.id, campaignId: row.campaignId, entityType: row.entityType, name: row.name, description: row.description, snapshot: fromJsonText(row.snapshotJson, {}), sourceEntityId: row.sourceEntityId, archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
  }

  private adapter(type: LibraryEntityType) {
    if (type === 'attachment') throw new BadRequestException('Attachment templates are unsupported because attachment bytes cannot be safely templated');
    return this.templateAdapters[type];
  }

  private templateSource(tx: LibraryTransaction, table: string, entityId: number, campaignId: number) {
    return SOFT_DELETABLE_TEMPLATE_TABLES.has(table)
      ? tx.get(sql`select * from ${sql.raw(table)} where id=${entityId} and campaign_id=${campaignId} and deleted_at is null`) as Record<string, unknown> | undefined
      : tx.get(sql`select * from ${sql.raw(table)} where id=${entityId} and campaign_id=${campaignId}`) as Record<string, unknown> | undefined;
  }

  private assertTemplateRefs(tx: LibraryTransaction, campaignId: number, adapter: { refs: Record<string, TemplateRef> }, snapshot: Record<string, unknown>) {
    for (const [field, ref] of Object.entries(adapter.refs)) {
      const value = snapshot[field];
      if (value == null) continue;
      if (!Number.isInteger(value)) throw new BadRequestException(`${ref.key} must be an integer id`);
      // Rule entries are globally scoped on this branch.  Do not assume #741's
      // campaign-owned compendium migration exists here.
      const valid = ref.table === 'rule_entries'
        ? tx.get(sql`select id from rule_entries where id=${value as number}`)
        : ref.attachmentCommitted
          ? tx.get(sql`select id from attachments where id=${value as number} and campaign_id=${campaignId} and state='committed'`)
          : SOFT_DELETABLE_TEMPLATE_TABLES.has(ref.table)
            ? tx.get(sql`select id from ${sql.raw(ref.table)} where id=${value as number} and campaign_id=${campaignId} and deleted_at is null`)
            : tx.get(sql`select id from ${sql.raw(ref.table)} where id=${value as number} and campaign_id=${campaignId}`);
      if (!valid) {
        throw new BadRequestException(`${ref.key} must reference a valid entity in this campaign`);
      }
    }
  }

  private createFromSnapshot(tx: LibraryTransaction, campaignId: number, type: Exclude<LibraryEntityType, 'attachment'>, snapshot: Record<string, unknown>, name?: string, refs: Record<string, number> = {}) {
    const adapter = this.adapter(type);
    const values: Record<string, unknown> = { ...snapshot };
    for (const [key, value] of Object.entries(refs)) {
      const entry = Object.entries(adapter.refs).find(([, ref]) => ref.key === key);
      if (!entry) throw new BadRequestException(`Unknown template reference override: ${key}`);
      values[entry[0]] = value;
    }
    if (name) values[type === 'quest' || type === 'timeline_event' ? 'title' : 'name'] = name;
    // `current` is campaign play-state, not template content. Reset it so copies
    // cannot violate LocationsService.discover's single-current invariant.
    if (type === 'location' && values.status === 'current') values.status = 'explored';
    if (type === 'inventory_item') this.assertInventoryOwner(values);
    this.assertTemplateRefs(tx, campaignId, adapter, values);
    const ts = nowIso();
    const fields = ['campaign_id', ...adapter.fields, 'created_at', 'updated_at'];
    const args = [campaignId, ...adapter.fields.map((field) => values[field] ?? null), ts, ts];
    const row = tx.get(sql`insert into ${sql.raw(adapter.table)} (${sql.join(fields.map((field) => sql.raw(field)), sql`, `)}) values (${sql.join(args.map((value) => sql`${value}`), sql`, `)}) returning id`);
    if (!row) throw new BadRequestException('Template instantiation failed');
    const newId = (row as { id: number }).id;

    if (type === 'encounter' && snapshot.roster !== undefined) {
      const parsedRoster = EncounterTemplateRoster.safeParse(snapshot.roster);
      if (!parsedRoster.success) {
        throw new BadRequestException(`Invalid encounter template roster: ${parsedRoster.error.message}`);
      }
      let currentSortOrder = 0;
      for (const entry of parsedRoster.data) {
        const count = Math.max(1, entry.count ?? 1);
        const names = count > 1 ? Array.from({ length: count }, (_, i) => `${entry.name} ${i + 1}`) : [entry.name];
        const itemSortOrder = Math.max(currentSortOrder, entry.sortOrder ?? 0);
        for (let i = 0; i < names.length; i++) {
          const cName = names[i];
            const statblockJson = entry.statblock
              ? toJsonText(entry.statblock)
              : entry.kind === 'monster'
                ? toJsonText(defaultCombatantStatblock())
                : null;
            tx.insert(combatants).values({
              encounterId: newId,
              kind: entry.kind,
              name: cName,
              initMod: entry.initMod ?? 0,
              hpCurrent: entry.hpMax,
              hpMax: entry.hpMax,
              tokenSize: entry.tokenSize ?? 'medium',
              sortOrder: itemSortOrder + i,
              statblockJson,
              hpTemp: 0,
              deathState: 'none',
              deathSaveSuccesses: 0,
              deathSaveFailures: 0,
              conditions: '[]',
              conditionInstances: null,
            }).run();
          }
          currentSortOrder = itemSortOrder + names.length;
        }
      }

    return newId;
  }

  private assertInventoryOwner(values: Record<string, unknown>) {
    const ownerType = values.owner_type;
    const characterId = values.character_id;
    if (ownerType === 'party') {
      if (characterId != null) throw new BadRequestException('Party-owned inventory templates cannot set a characterId.');
      return;
    }
    if (ownerType === 'character') {
      if (!Number.isInteger(characterId)) throw new BadRequestException('Character-owned inventory templates require a characterId.');
      return;
    }
    throw new BadRequestException('Inventory templates must be party-owned or character-owned.');
  }

  /**
   * Issue #1326 review (Codex): whether re-equipping `excludeId` into `slot` on
   * `characterId` would collide with another currently-equipped item — the exact
   * invariant `InventoryService.update` enforces (409 INVENTORY_SLOT_CONFLICT), reused
   * here so undoBulk can decide whether restoring a snapshotted equip is safe.
   */
  private inventoryEquipSlotConflict(tx: LibraryTransaction, campaignId: number, characterId: number, slot: string, excludeId: number): boolean {
    return !!tx.get(
      sql`select id from inventory_items where campaign_id=${campaignId} and character_id=${characterId} and equipped=1 and deleted_at is null and lower(equip_slot)=lower(${slot}) and id!=${excludeId}`,
    );
  }

  async listTemplates(campaignId: number, includeArchived = false): Promise<Array<z.infer<typeof CampaignLibraryTemplate>>> {
    const rows = await this.db.select().from(campaignLibraryTemplates).where(includeArchived ? eq(campaignLibraryTemplates.campaignId, campaignId) : and(eq(campaignLibraryTemplates.campaignId, campaignId), isNull(campaignLibraryTemplates.archivedAt))).orderBy(campaignLibraryTemplates.name);
    return rows.map((row) => this.templateRow(row));
  }

  async saveTemplate(campaignId: number, raw: unknown, user: RequestUser, role: Role): Promise<z.infer<typeof CampaignLibraryTemplate>> {
    const input = CampaignLibraryTemplateSave.parse(raw);
    const adapter = this.adapter(input.entityType);
    const ts = nowIso();
    const result = this.db.transaction((tx) => {
      const source = this.templateSource(tx, adapter.table, input.entityId, campaignId);
      if (!source) throw new NotFoundException(`${input.entityType} ${input.entityId} not found in this campaign`);
      const snapshot = Object.fromEntries(adapter.fields.map((field) => [field, source[field]]));
      if (input.entityType === 'location' && snapshot.status === 'current') snapshot.status = 'explored';
      if (input.entityType === 'encounter') {
        const rawCombatants = tx.all(
          sql`select * from combatants where encounter_id=${input.entityId} order by sort_order asc, id asc`
        ) as Array<Record<string, unknown>>;
        snapshot.roster = this.buildEncounterTemplateRoster(rawCombatants);
      }
      this.assertTemplateRefs(tx, campaignId, adapter, snapshot);
      const row = tx.insert(campaignLibraryTemplates).values({ campaignId, entityType: input.entityType, name: input.name.trim(), description: input.description, snapshotJson: toJsonText(snapshot), sourceEntityId: input.entityId, createdAt: ts, updatedAt: ts }).returning().get();
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.template.save', entityType: 'campaign_library_template', entityId: row.id, detail: input.entityType, requestId: getRequestId() ?? null, createdAt: ts }).run();
      return row;
    });
    return this.templateRow(result);
  }

  async instantiateTemplate(campaignId: number, templateId: number, raw: unknown, user: RequestUser, role: Role) {
    const input = CampaignLibraryTemplateInstantiate.parse(raw);
    const ts = nowIso();
    return this.db.transaction((tx) => {
      const template = tx.select().from(campaignLibraryTemplates).where(and(eq(campaignLibraryTemplates.id, templateId), eq(campaignLibraryTemplates.campaignId, campaignId), isNull(campaignLibraryTemplates.archivedAt))).get();
      if (!template) throw new NotFoundException(`Active template ${templateId} not found in this campaign`);
      const type = LibraryEntityType.safeParse(template.entityType);
      if (!type.success || type.data === 'attachment') throw new BadRequestException('Template has an unsupported entity type');
      const snapshot = z.record(z.string(), z.unknown()).parse(fromJsonText(template.snapshotJson, {}));
      const id = this.createFromSnapshot(tx, campaignId, type.data, snapshot, input.name, input.refs);
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.template.instantiate', entityType: type.data, entityId: id, detail: template.name, requestId: getRequestId() ?? null, createdAt: ts }).run();
      return { entityType: type.data, entityId: id };
    });
  }

  async duplicateEntity(campaignId: number, type: LibraryEntityType, entityId: number, raw: unknown, user: RequestUser, role: Role) {
    const input = CampaignLibraryTemplateInstantiate.parse(raw);
    const adapter = this.adapter(type);
    const ts = nowIso();
    return this.db.transaction((tx) => {
      const source = this.templateSource(tx, adapter.table, entityId, campaignId);
      if (!source) throw new NotFoundException(`${type} ${entityId} not found in this campaign`);
      const snapshot = Object.fromEntries(adapter.fields.map((field) => [field, source[field]]));
      if (type === 'encounter') {
        const rawCombatants = tx.all(
          sql`select * from combatants where encounter_id=${entityId} order by sort_order asc, id asc`
        ) as Array<Record<string, unknown>>;
        snapshot.roster = this.buildEncounterTemplateRoster(rawCombatants);
      }
      const id = this.createFromSnapshot(tx, campaignId, type as Exclude<LibraryEntityType, 'attachment'>, snapshot, input.name, input.refs);
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.entity.duplicate', entityType: type, entityId: id, detail: String(entityId), requestId: getRequestId() ?? null, createdAt: ts }).run();
      return { entityType: type, entityId: id };
    });
  }

  async archiveTemplate(campaignId: number, templateId: number, user: RequestUser, role: Role) {
    const ts = nowIso();
    return this.db.transaction((tx) => {
      const changed = tx.update(campaignLibraryTemplates).set({ archivedAt: ts, updatedAt: ts }).where(and(eq(campaignLibraryTemplates.id, templateId), eq(campaignLibraryTemplates.campaignId, campaignId), isNull(campaignLibraryTemplates.archivedAt))).run();
      if (changed.changes === 0) throw new NotFoundException(`Active template ${templateId} not found in this campaign`);
      tx.insert(auditLog).values({ campaignId, actor: auditActor(user), actorRole: role, action: 'campaign_library.template.archive', entityType: 'campaign_library_template', entityId: templateId, detail: '', requestId: getRequestId() ?? null, createdAt: ts }).run();
      return { ok: true };
    });
  }
}

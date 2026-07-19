import { BadRequestException, Inject, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { QuestCreate, QuestUpdate, QuestStatusPatch, ObjectiveCreate, ObjectivePatch } from '@campfire/schema';
import type { Quest, QuestObjective, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { quests, questObjectives, npcs } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type QuestCreateInput = z.infer<typeof QuestCreate>;
type QuestUpdateInput = z.infer<typeof QuestUpdate>;
type QuestStatusPatchInput = z.infer<typeof QuestStatusPatch>;
type ObjectiveCreateInput = z.infer<typeof ObjectiveCreate>;
type ObjectivePatchInput = z.infer<typeof ObjectivePatch>;

function toDomain(row: typeof quests.$inferSelect): Quest {
  return {
    id: row.id,
    campaignId: row.campaignId,
    parentId: row.parentId,
    title: row.title,
    body: row.body,
    status: row.status as Quest['status'],
    giverNpcId: row.giverNpcId,
    reward: row.reward,
    dmSecret: row.dmSecret,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function objectiveToDomain(row: typeof questObjectives.$inferSelect): QuestObjective {
  return {
    id: row.id,
    questId: row.questId,
    text: row.text,
    done: row.done,
    sortOrder: row.sortOrder,
  };
}

@Injectable()
export class QuestsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForCampaign(campaignId: number, role: Role): Promise<Quest[]> {
    const rows = await this.db.select().from(quests).where(eq(quests.campaignId, campaignId));
    return redactSecrets(rows.map(toDomain), role);
  }

  async listForCampaignByStatus(campaignId: number, status: string | undefined, role: Role): Promise<Quest[]> {
    const all = await this.listForCampaign(campaignId, role);
    return status ? all.filter((q) => q.status === status) : all;
  }

  async listForCampaignWithObjectives(campaignId: number, role: Role) {
    return this.embedObjectives(await this.listForCampaign(campaignId, role));
  }

  /**
   * Same shape as the summary endpoint's quest list (each quest embeds its
   * objectives) — the quest board in the design needs objectives inline, so
   * this reuses the summary's embed pattern rather than duplicating it.
   */
  async listForCampaignByStatusWithObjectives(campaignId: number, status: string | undefined, role: Role) {
    return this.embedObjectives(await this.listForCampaignByStatus(campaignId, status, role));
  }

  private async embedObjectives(questList: Quest[]) {
    const results = [];
    for (const q of questList) {
      const objectives = await this.objectivesForQuest(q.id);
      results.push({ ...q, objectives });
    }
    return results;
  }

  private async objectivesForQuest(questId: number): Promise<QuestObjective[]> {
    const rows = await this.db
      .select()
      .from(questObjectives)
      .where(eq(questObjectives.questId, questId))
      .orderBy(questObjectives.sortOrder);
    return rows.map(objectiveToDomain);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(quests).where(eq(quests.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Quest ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Quest> {
    const row = await this.getRowOrThrow(id);
    return redactSecret(toDomain(row), role);
  }

  async getWithObjectivesOrThrow(id: number, role: Role) {
    const quest = await this.getOrThrow(id, role);
    const objectives = await this.objectivesForQuest(id);
    return { ...quest, objectives };
  }

  /**
   * parentId (self-referencing quests.id) and giverNpcId (npcs.id) are FK-shaped fields
   * that previously accepted any integer with no existence/campaign check — a nonexistent
   * id, or another campaign's quest/npc id, would silently pass through. `excludeQuestId`
   * (update only) additionally rejects a quest naming itself as its own parent.
   */
  private async validateParentRef(parentId: number | null | undefined, campaignId: number, excludeQuestId?: number): Promise<void> {
    if (parentId == null) return;
    if (excludeQuestId != null && parentId === excludeQuestId) {
      throw new BadRequestException('A quest cannot be its own parent');
    }
    const [row] = await this.db
      .select({ id: quests.id })
      .from(quests)
      .where(and(eq(quests.id, parentId), eq(quests.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`parentId ${parentId} does not exist in this campaign`);
  }

  private async validateGiverNpcRef(giverNpcId: number | null | undefined, campaignId: number): Promise<void> {
    if (giverNpcId == null) return;
    const [row] = await this.db
      .select({ id: npcs.id })
      .from(npcs)
      .where(and(eq(npcs.id, giverNpcId), eq(npcs.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`giverNpcId ${giverNpcId} does not exist in this campaign`);
  }

  async create(campaignId: number, input: QuestCreateInput, user: RequestUser, role: Role): Promise<Quest> {
    await this.validateParentRef(input.parentId, campaignId);
    await this.validateGiverNpcRef(input.giverNpcId, campaignId);
    const ts = nowIso();
    const [row] = await this.db
      .insert(quests)
      .values({
        campaignId,
        parentId: input.parentId ?? null,
        title: input.title,
        body: input.body ?? '',
        status: input.status ?? 'available',
        giverNpcId: input.giverNpcId ?? null,
        reward: input.reward ?? '',
        dmSecret: input.dmSecret ?? '',
        sortOrder: input.sortOrder ?? 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.create',
      entityType: 'quest',
      entityId: row.id,
      campaignId,
    });
    return redactSecret(toDomain(row), role);
  }

  async update(id: number, input: QuestUpdateInput, user: RequestUser, role: Role): Promise<Quest> {
    const existing = await this.getRowOrThrow(id);
    await this.validateParentRef(input.parentId, existing.campaignId, id);
    await this.validateGiverNpcRef(input.giverNpcId, existing.campaignId);
    const [row] = await this.db
      .update(quests)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(quests.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.update',
      entityType: 'quest',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return redactSecret(toDomain(row), role);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    // Promote any subquests to top level (parentId=null) in the same
    // transaction as the delete, so a quest's children never dangle on a
    // deleted parentId — mirrors how the design's quest board expects
    // orphaned subquests to resurface as top-level quests, not vanish.
    this.db.transaction((tx) => {
      tx.update(quests).set({ parentId: null, updatedAt: nowIso() }).where(eq(quests.parentId, id)).run();
      tx.delete(questObjectives).where(eq(questObjectives.questId, id)).run();
      tx.delete(quests).where(eq(quests.id, id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.delete',
      entityType: 'quest',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }

  async setStatus(id: number, patch: QuestStatusPatchInput, user: RequestUser, role: Role): Promise<Quest> {
    const existing = await this.getRowOrThrow(id);
    const [row] = await this.db
      .update(quests)
      .set({ status: patch.status, updatedAt: nowIso() })
      .where(eq(quests.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.status',
      entityType: 'quest',
      entityId: id,
      campaignId: existing.campaignId,
      detail: patch.status,
    });
    return redactSecret(toDomain(row), role);
  }

  async addObjective(questId: number, input: ObjectiveCreateInput, user: RequestUser, role: Role): Promise<QuestObjective> {
    const quest = await this.getRowOrThrow(questId);
    const [row] = await this.db
      .insert(questObjectives)
      .values({
        questId,
        text: input.text,
        done: false,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.objective.create',
      entityType: 'quest_objective',
      entityId: row.id,
      campaignId: quest.campaignId,
    });
    return objectiveToDomain(row);
  }

  async patchObjective(
    questId: number,
    objectiveId: number,
    patch: ObjectivePatchInput,
    user: RequestUser,
    role: Role,
  ): Promise<QuestObjective> {
    const quest = await this.getRowOrThrow(questId);
    const [existing] = await this.db
      .select()
      .from(questObjectives)
      .where(and(eq(questObjectives.id, objectiveId), eq(questObjectives.questId, questId)))
      .limit(1);
    if (!existing) throw new NotFoundException(`Objective ${objectiveId} not found`);

    // player+ may toggle `done`; only dm may change text/sortOrder
    const wantsTextOrOrder = patch.text !== undefined || patch.sortOrder !== undefined;
    if (wantsTextOrOrder && role !== 'dm') {
      throw new ForbiddenException('Only dm may change objective text/sortOrder');
    }

    const update: Partial<typeof questObjectives.$inferInsert> = {};
    if (patch.done !== undefined) update.done = patch.done;
    if (patch.text !== undefined) update.text = patch.text;
    if (patch.sortOrder !== undefined) update.sortOrder = patch.sortOrder;

    const [row] = await this.db
      .update(questObjectives)
      .set(update)
      .where(eq(questObjectives.id, objectiveId))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.objective.update',
      entityType: 'quest_objective',
      entityId: objectiveId,
      campaignId: quest.campaignId,
    });
    return objectiveToDomain(row);
  }

  async removeObjective(questId: number, objectiveId: number, user: RequestUser, role: Role): Promise<void> {
    const quest = await this.getRowOrThrow(questId);
    // Verify the objective actually belongs to THIS quest before deleting — the DELETE's
    // own WHERE clause already scopes on questId (so it can never touch another quest's
    // row), but without this existence check it silently no-ops and reports success (200)
    // when called with a mismatched (questId, objectiveId) pair, e.g. objective's real
    // parent is a different quest. 404, matching patchObjective's behavior above.
    const [existing] = await this.db
      .select()
      .from(questObjectives)
      .where(and(eq(questObjectives.id, objectiveId), eq(questObjectives.questId, questId)))
      .limit(1);
    if (!existing) throw new NotFoundException(`Objective ${objectiveId} not found`);

    await this.db
      .delete(questObjectives)
      .where(and(eq(questObjectives.id, objectiveId), eq(questObjectives.questId, questId)));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.objective.delete',
      entityType: 'quest_objective',
      entityId: objectiveId,
      campaignId: quest.campaignId,
    });
  }
}

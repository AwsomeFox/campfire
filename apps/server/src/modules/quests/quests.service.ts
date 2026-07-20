import { BadRequestException, Inject, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { and, asc, eq, inArray, max } from 'drizzle-orm';
import type { z } from 'zod';
import { QuestCreate, QuestUpdate, QuestStatusPatch, ObjectiveCreate, ObjectivePatch, ObjectiveReorder } from '@campfire/schema';
import type { Quest, QuestObjective, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { quests, questObjectives, npcs, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets, filterHidden, isVisibleTo } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type QuestCreateInput = z.infer<typeof QuestCreate>;
type QuestUpdateInput = z.infer<typeof QuestUpdate>;
type QuestStatusPatchInput = z.infer<typeof QuestStatusPatch>;
type ObjectiveCreateInput = z.infer<typeof ObjectiveCreate>;
type ObjectivePatchInput = z.infer<typeof ObjectivePatch>;
type ObjectiveReorderInput = z.infer<typeof ObjectiveReorder>;

export function toDomain(row: typeof quests.$inferSelect): Quest {
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
    hidden: row.hidden,
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
    private readonly revisions: RevisionsService,
  ) {}

  async listForCampaign(campaignId: number, role: Role): Promise<Quest[]> {
    // Order by sortOrder (then id as a stable tiebreaker) so the quest board and
    // every other reader honor the DM-controlled ordering — previously this was
    // rowid order and quest.sortOrder was a silent no-op (#100). A flat sort is
    // enough for the two-level board: the UI groups by parentId while preserving
    // this array order, so siblings within each parent group stay sorted too.
    const rows = await this.db
      .select()
      .from(quests)
      .where(eq(quests.campaignId, campaignId))
      .orderBy(asc(quests.sortOrder), asc(quests.id));
    // Drop hidden quests wholesale for non-DM BEFORE redacting dmSecret (issue #42).
    return redactSecrets(filterHidden(rows.map(toDomain), role), role);
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

  /**
   * The reference instant for "what changed since last session" (#66): the most
   * recent session's date, taken as max(playedAt ?? createdAt) across the
   * campaign's sessions. playedAt (the night it was played) is the natural anchor;
   * we fall back to createdAt when a session has no recorded date so a dateless
   * log still moves the marker rather than being skipped. Returns null when the
   * campaign has no sessions — there's then nothing to diff against.
   */
  private async latestSessionDate(campaignId: number): Promise<string | null> {
    const rows = await this.db
      .select({ playedAt: sessions.playedAt, createdAt: sessions.createdAt })
      .from(sessions)
      .where(eq(sessions.campaignId, campaignId));
    let latest: string | null = null;
    for (const r of rows) {
      const ref = r.playedAt ?? r.createdAt;
      if (ref && (latest == null || ref > latest)) latest = ref;
    }
    return latest;
  }

  /**
   * Quests touched since a reference instant (#66) — the data behind the Quests
   * "what changed since last session" indicator. `since` defaults to the campaign's
   * latest session date but may be overridden (e.g. the player's last visit).
   * A quest counts as changed when its updatedAt is at/after `since`; ISO-8601
   * strings compare lexicographically, and a date-only `since` (YYYY-MM-DD) is a
   * prefix of any same-day timestamp, so a same-day edit still registers. Reuses
   * listForCampaign so hidden-filtering, dmSecret redaction and board ordering all
   * carry over. When there's no session to diff against (`since` null), nothing is
   * reported changed rather than flagging every quest.
   */
  async changesSince(campaignId: number, sinceParam: string | undefined, role: Role): Promise<{ since: string | null; quests: Quest[] }> {
    const since = sinceParam && sinceParam.trim() !== '' ? sinceParam : await this.latestSessionDate(campaignId);
    const all = await this.listForCampaign(campaignId, role);
    const changed = since == null ? [] : all.filter((q) => q.updatedAt >= since);
    return { since, quests: changed };
  }

  /**
   * Embed each quest's objectives WITHOUT an N+1 (#72): the previous version ran
   * one objectives query per quest — O(quests) round-trips on the single most-called
   * aggregate (summary + quest board). Now a single `WHERE quest_id IN (...)` pulls
   * every objective for the whole list, and we group in JS by questId. The global
   * ORDER BY (sortOrder, id) preserves each quest's per-objective ordering because
   * grouping keeps the rows' relative order — identical output to the old per-quest
   * `objectivesForQuest` query, just batched.
   */
  private async embedObjectives(questList: Quest[]) {
    if (questList.length === 0) return [];
    const questIds = questList.map((q) => q.id);
    const rows = await this.db
      .select()
      .from(questObjectives)
      .where(inArray(questObjectives.questId, questIds))
      .orderBy(asc(questObjectives.sortOrder), asc(questObjectives.id));
    const byQuest = new Map<number, QuestObjective[]>();
    for (const row of rows) {
      const objective = objectiveToDomain(row);
      const bucket = byQuest.get(objective.questId);
      if (bucket) bucket.push(objective);
      else byQuest.set(objective.questId, [objective]);
    }
    return questList.map((q) => ({ ...q, objectives: byQuest.get(q.id) ?? [] }));
  }

  private async objectivesForQuest(questId: number): Promise<QuestObjective[]> {
    const rows = await this.db
      .select()
      .from(questObjectives)
      .where(eq(questObjectives.questId, questId))
      .orderBy(asc(questObjectives.sortOrder), asc(questObjectives.id));
    return rows.map(objectiveToDomain);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(quests).where(eq(quests.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Quest ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Quest> {
    const row = await this.getRowOrThrow(id);
    const quest = toDomain(row);
    // A hidden quest must be indistinguishable from a nonexistent one for non-DM —
    // 404 (not 403), so its very existence isn't leaked (issue #42).
    if (!isVisibleTo(quest, role)) throw new NotFoundException(`Quest ${id} not found`);
    return redactSecret(quest, role);
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
    // Reject cycles: setting quest `excludeQuestId`'s parent to `parentId` must not
    // make the quest its own ancestor (#95). Walk parentId's ancestor chain upward;
    // if we reach the quest being updated, the edge would close a loop and both
    // quests would fall off the board (neither is a root). Create has no id yet, so
    // it can never form a cycle — this only runs on update (excludeQuestId set).
    if (excludeQuestId != null) {
      await this.assertNoAncestorCycle(parentId, excludeQuestId, campaignId);
    }
  }

  /**
   * Walk the parent chain starting at `startParentId`. Throws 400 if it reaches
   * `questId` (the quest being reparented) — that would create a cycle. A local
   * `seen` set guards against looping forever on pre-existing cyclic legacy rows
   * that don't involve `questId`.
   */
  private async assertNoAncestorCycle(startParentId: number, questId: number, campaignId: number): Promise<void> {
    let cursor: number | null = startParentId;
    const seen = new Set<number>();
    while (cursor != null) {
      if (cursor === questId) {
        throw new BadRequestException('parentId would create a cycle: a quest cannot be its own ancestor');
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const [row]: { parentId: number | null }[] = await this.db
        .select({ parentId: quests.parentId })
        .from(quests)
        .where(and(eq(quests.id, cursor), eq(quests.campaignId, campaignId)))
        .limit(1);
      cursor = row?.parentId ?? null;
    }
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
        hidden: input.hidden ?? false,
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

  async update(
    id: number,
    input: QuestUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<Quest> {
    const existing = await this.getRowOrThrow(id);
    // Optimistic concurrency (#157): 409 on a stale expectedUpdatedAt before any write.
    this.revisions.assertNotStale(existing, opts?.expectedUpdatedAt);
    await this.validateParentRef(input.parentId, existing.campaignId, id);
    await this.validateGiverNpcRef(input.giverNpcId, existing.campaignId);
    // Snapshot the PRIOR body into revision history when it changes (#157).
    if (input.body !== undefined && input.body !== existing.body) {
      await this.revisions.record({
        entityType: 'quest',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.body,
        user,
      });
    }
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
      // #161: record the changed fields so the audit log is a real delta channel
      // (empty detail before). Matches the characters/encounters/members convention.
      detail: JSON.stringify(input),
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
    // Drop this quest's prose revisions (polymorphic soft ref, no FK cascade — #157).
    await this.revisions.removeForEntity('quest', id);
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
    // Append to the end by default: new objectives get max(sortOrder)+1 so they
    // land last instead of all defaulting to 0 and colliding at the top (#100).
    // An explicit sortOrder still wins if the caller provides one.
    let sortOrder = input.sortOrder;
    if (sortOrder == null) {
      const [agg] = await this.db
        .select({ maxSort: max(questObjectives.sortOrder) })
        .from(questObjectives)
        .where(eq(questObjectives.questId, questId));
      sortOrder = agg?.maxSort == null ? 0 : agg.maxSort + 1;
    }
    const [row] = await this.db
      .insert(questObjectives)
      .values({
        questId,
        text: input.text,
        done: false,
        sortOrder,
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

  /**
   * Reorder a quest's objectives in one atomic call (#100). `objectiveIds` must be
   * a permutation of exactly this quest's current objective ids — sortOrder is then
   * reassigned by array index. Rejects (400) any id that isn't this quest's, any
   * duplicate, or a partial list, so a stale/foreign id can't silently corrupt order.
   */
  async reorderObjectives(
    questId: number,
    input: ObjectiveReorderInput,
    user: RequestUser,
    role: Role,
  ): Promise<QuestObjective[]> {
    const quest = await this.getRowOrThrow(questId);
    const existing = await this.db
      .select({ id: questObjectives.id })
      .from(questObjectives)
      .where(eq(questObjectives.questId, questId));
    const existingIds = new Set(existing.map((o) => o.id));
    const provided = input.objectiveIds;
    const uniqueProvided = new Set(provided);
    if (
      provided.length !== existing.length ||
      uniqueProvided.size !== provided.length ||
      provided.some((id) => !existingIds.has(id))
    ) {
      throw new BadRequestException("objectiveIds must be a permutation of this quest's objective ids");
    }

    this.db.transaction((tx) => {
      provided.forEach((id, idx) => {
        tx.update(questObjectives)
          .set({ sortOrder: idx })
          .where(and(eq(questObjectives.id, id), eq(questObjectives.questId, questId)))
          .run();
      });
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'quest.objective.reorder',
      entityType: 'quest',
      entityId: questId,
      campaignId: quest.campaignId,
    });
    return this.objectivesForQuest(questId);
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

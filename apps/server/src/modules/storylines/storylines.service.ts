import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, max } from 'drizzle-orm';
import type { z } from 'zod';
import {
  StoryArcCreate,
  StoryArcUpdate,
  StoryArcStatusPatch,
  StoryBeatCreate,
  StoryBeatUpdate,
  StoryBeatStatusPatch,
  StoryBranchCreate,
} from '@campfire/schema';
import type { StoryArc, StoryBeat, StoryBranch, StoryBeatWithBranches, StoryArcWithBeats, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { storyArcs, storyBeats, storyBranches } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type StoryArcCreateInput = z.infer<typeof StoryArcCreate>;
type StoryArcUpdateInput = z.infer<typeof StoryArcUpdate>;
type StoryArcStatusPatchInput = z.infer<typeof StoryArcStatusPatch>;
type StoryBeatCreateInput = z.infer<typeof StoryBeatCreate>;
type StoryBeatUpdateInput = z.infer<typeof StoryBeatUpdate>;
type StoryBeatStatusPatchInput = z.infer<typeof StoryBeatStatusPatch>;
type StoryBranchCreateInput = z.infer<typeof StoryBranchCreate>;

function arcToDomain(row: typeof storyArcs.$inferSelect): StoryArc {
  return {
    id: row.id,
    campaignId: row.campaignId,
    title: row.title,
    summary: row.summary,
    status: row.status as StoryArc['status'],
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function beatToDomain(row: typeof storyBeats.$inferSelect): StoryBeat {
  return {
    id: row.id,
    campaignId: row.campaignId,
    arcId: row.arcId,
    title: row.title,
    body: row.body,
    status: row.status as StoryBeat['status'],
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function branchToDomain(row: typeof storyBranches.$inferSelect): StoryBranch {
  return {
    id: row.id,
    beatId: row.beatId,
    toBeatId: row.toBeatId,
    label: row.label,
    sortOrder: row.sortOrder,
  };
}

/**
 * Storylines (issue #27): a DM-only branching arc/beat planner. Every method here
 * is reached only through routes/tools that already asserted `dm` role, so no
 * redaction/hidden-filtering is needed — the whole surface is DM prep content and
 * is never exposed to players. The service still owns referential integrity:
 * beats belong to exactly one arc (same campaign), and a branch's endpoints must
 * both be beats in the SAME campaign as the source beat.
 */
@Injectable()
export class StorylinesService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  // ---------- arcs ----------

  async listArcs(campaignId: number): Promise<StoryArc[]> {
    const rows = await this.db
      .select()
      .from(storyArcs)
      .where(eq(storyArcs.campaignId, campaignId))
      .orderBy(asc(storyArcs.sortOrder), asc(storyArcs.id));
    return rows.map(arcToDomain);
  }

  async listArcsWithBeats(campaignId: number): Promise<StoryArcWithBeats[]> {
    const arcs = await this.listArcs(campaignId);
    const result: StoryArcWithBeats[] = [];
    for (const arc of arcs) {
      result.push({ ...arc, beats: await this.beatsForArc(arc.id) });
    }
    return result;
  }

  async getArcRowOrThrow(id: number) {
    const [row] = await this.db.select().from(storyArcs).where(eq(storyArcs.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Story arc ${id} not found`);
    return row;
  }

  async getArcWithBeatsOrThrow(id: number): Promise<StoryArcWithBeats> {
    const row = await this.getArcRowOrThrow(id);
    return { ...arcToDomain(row), beats: await this.beatsForArc(id) };
  }

  async createArc(campaignId: number, input: StoryArcCreateInput, user: RequestUser, role: Role): Promise<StoryArc> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(storyArcs)
      .values({
        campaignId,
        title: input.title,
        summary: input.summary ?? '',
        status: input.status ?? 'planned',
        sortOrder: input.sortOrder ?? 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.arc.create',
      entityType: 'story_arc',
      entityId: row.id,
      campaignId,
    });
    return arcToDomain(row);
  }

  async updateArc(id: number, input: StoryArcUpdateInput, user: RequestUser, role: Role): Promise<StoryArc> {
    const existing = await this.getArcRowOrThrow(id);
    const [row] = await this.db
      .update(storyArcs)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(storyArcs.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.arc.update',
      entityType: 'story_arc',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return arcToDomain(row);
  }

  async setArcStatus(id: number, patch: StoryArcStatusPatchInput, user: RequestUser, role: Role): Promise<StoryArc> {
    const existing = await this.getArcRowOrThrow(id);
    const [row] = await this.db
      .update(storyArcs)
      .set({ status: patch.status, updatedAt: nowIso() })
      .where(eq(storyArcs.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.arc.status',
      entityType: 'story_arc',
      entityId: id,
      campaignId: existing.campaignId,
      detail: patch.status,
    });
    return arcToDomain(row);
  }

  async removeArc(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getArcRowOrThrow(id);
    // Deleting an arc removes its beats and every branch touching those beats — in
    // one transaction so nothing dangles. A branch is deleted when EITHER endpoint
    // (its source beat OR its target beat) is one of this arc's beats.
    this.db.transaction((tx) => {
      const beatRows = tx.select({ id: storyBeats.id }).from(storyBeats).where(eq(storyBeats.arcId, id)).all();
      const beatIds = beatRows.map((b) => b.id);
      if (beatIds.length > 0) {
        tx.delete(storyBranches).where(inArray(storyBranches.beatId, beatIds)).run();
        tx.delete(storyBranches).where(inArray(storyBranches.toBeatId, beatIds)).run();
      }
      tx.delete(storyBeats).where(eq(storyBeats.arcId, id)).run();
      tx.delete(storyArcs).where(eq(storyArcs.id, id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.arc.delete',
      entityType: 'story_arc',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }

  // ---------- beats ----------

  private async beatsForArc(arcId: number): Promise<StoryBeatWithBranches[]> {
    const rows = await this.db
      .select()
      .from(storyBeats)
      .where(eq(storyBeats.arcId, arcId))
      .orderBy(asc(storyBeats.sortOrder), asc(storyBeats.id));
    const result: StoryBeatWithBranches[] = [];
    for (const row of rows) {
      result.push({ ...beatToDomain(row), branches: await this.branchesForBeat(row.id) });
    }
    return result;
  }

  async getBeatRowOrThrow(id: number) {
    const [row] = await this.db.select().from(storyBeats).where(eq(storyBeats.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Story beat ${id} not found`);
    return row;
  }

  async getBeatWithBranchesOrThrow(id: number): Promise<StoryBeatWithBranches> {
    const row = await this.getBeatRowOrThrow(id);
    return { ...beatToDomain(row), branches: await this.branchesForBeat(id) };
  }

  async addBeat(arcId: number, input: StoryBeatCreateInput, user: RequestUser, role: Role): Promise<StoryBeat> {
    const arc = await this.getArcRowOrThrow(arcId);
    // Append to the end by default so new beats don't all collide at sortOrder 0.
    let sortOrder = input.sortOrder;
    if (sortOrder == null) {
      const [agg] = await this.db
        .select({ maxSort: max(storyBeats.sortOrder) })
        .from(storyBeats)
        .where(eq(storyBeats.arcId, arcId));
      sortOrder = agg?.maxSort == null ? 0 : agg.maxSort + 1;
    }
    const ts = nowIso();
    const [row] = await this.db
      .insert(storyBeats)
      .values({
        campaignId: arc.campaignId,
        arcId,
        title: input.title,
        body: input.body ?? '',
        status: input.status ?? 'planned',
        sortOrder,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.beat.create',
      entityType: 'story_beat',
      entityId: row.id,
      campaignId: arc.campaignId,
    });
    return beatToDomain(row);
  }

  async updateBeat(id: number, input: StoryBeatUpdateInput, user: RequestUser, role: Role): Promise<StoryBeat> {
    const existing = await this.getBeatRowOrThrow(id);
    const [row] = await this.db
      .update(storyBeats)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(storyBeats.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.beat.update',
      entityType: 'story_beat',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return beatToDomain(row);
  }

  async setBeatStatus(id: number, patch: StoryBeatStatusPatchInput, user: RequestUser, role: Role): Promise<StoryBeat> {
    const existing = await this.getBeatRowOrThrow(id);
    const [row] = await this.db
      .update(storyBeats)
      .set({ status: patch.status, updatedAt: nowIso() })
      .where(eq(storyBeats.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.beat.status',
      entityType: 'story_beat',
      entityId: id,
      campaignId: existing.campaignId,
      detail: patch.status,
    });
    return beatToDomain(row);
  }

  async removeBeat(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getBeatRowOrThrow(id);
    // Remove the beat and any branch pointing at OR out of it, so no branch dangles.
    this.db.transaction((tx) => {
      tx.delete(storyBranches).where(eq(storyBranches.beatId, id)).run();
      tx.delete(storyBranches).where(eq(storyBranches.toBeatId, id)).run();
      tx.delete(storyBeats).where(eq(storyBeats.id, id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.beat.delete',
      entityType: 'story_beat',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }

  // ---------- branches ----------

  private async branchesForBeat(beatId: number): Promise<StoryBranch[]> {
    const rows = await this.db
      .select()
      .from(storyBranches)
      .where(eq(storyBranches.beatId, beatId))
      .orderBy(asc(storyBranches.sortOrder), asc(storyBranches.id));
    return rows.map(branchToDomain);
  }

  /**
   * Add a branch (labelled next-option) to a beat. `toBeatId`, when provided, must
   * be a beat in the SAME campaign as the source beat — cross-campaign or
   * nonexistent targets are rejected (400) rather than silently stored, so the
   * planner graph can never point outside its own campaign.
   */
  async addBranch(beatId: number, input: StoryBranchCreateInput, user: RequestUser, role: Role): Promise<StoryBranch> {
    const beat = await this.getBeatRowOrThrow(beatId);
    if (input.toBeatId != null) {
      const [target] = await this.db
        .select({ id: storyBeats.id })
        .from(storyBeats)
        .where(and(eq(storyBeats.id, input.toBeatId), eq(storyBeats.campaignId, beat.campaignId)))
        .limit(1);
      if (!target) {
        throw new BadRequestException(`toBeatId ${input.toBeatId} does not exist in this campaign`);
      }
    }
    let sortOrder = input.sortOrder;
    if (sortOrder == null) {
      const [agg] = await this.db
        .select({ maxSort: max(storyBranches.sortOrder) })
        .from(storyBranches)
        .where(eq(storyBranches.beatId, beatId));
      sortOrder = agg?.maxSort == null ? 0 : agg.maxSort + 1;
    }
    const [row] = await this.db
      .insert(storyBranches)
      .values({
        beatId,
        toBeatId: input.toBeatId ?? null,
        label: input.label,
        sortOrder,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.branch.create',
      entityType: 'story_branch',
      entityId: row.id,
      campaignId: beat.campaignId,
    });
    return branchToDomain(row);
  }

  async removeBranch(beatId: number, branchId: number, user: RequestUser, role: Role): Promise<void> {
    const beat = await this.getBeatRowOrThrow(beatId);
    const [existing] = await this.db
      .select()
      .from(storyBranches)
      .where(and(eq(storyBranches.id, branchId), eq(storyBranches.beatId, beatId)))
      .limit(1);
    if (!existing) throw new NotFoundException(`Branch ${branchId} not found`);
    await this.db
      .delete(storyBranches)
      .where(and(eq(storyBranches.id, branchId), eq(storyBranches.beatId, beatId)));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.branch.delete',
      entityType: 'story_branch',
      entityId: branchId,
      campaignId: beat.campaignId,
    });
  }
}

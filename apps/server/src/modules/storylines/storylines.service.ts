import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import crypto from 'node:crypto';
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
  StoryBranchUpdate,
} from '@campfire/schema';
import type { StoryArc, StoryBeat, StoryBranch, StoryBeatWithBranches, StoryArcWithBeats, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { storyArcs, storyBeats, storyBranches, sessions, quests, encounters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { nextUpdatedAt, staleWrite } from '../../common/stale-write';
import { AuditService } from '../audit/audit.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type StoryArcCreateInput = z.infer<typeof StoryArcCreate>;
type StoryArcUpdateInput = z.infer<typeof StoryArcUpdate>;
type StoryArcStatusPatchInput = z.infer<typeof StoryArcStatusPatch>;
type StoryBeatCreateInput = z.infer<typeof StoryBeatCreate>;
type StoryBeatUpdateInput = z.infer<typeof StoryBeatUpdate>;
type StoryBeatStatusPatchInput = z.infer<typeof StoryBeatStatusPatch>;
type StoryBranchCreateInput = z.infer<typeof StoryBranchCreate>;
type StoryBranchUpdateInput = z.infer<typeof StoryBranchUpdate>;
type StorylineTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type StorylineReader = DrizzleDb | StorylineTx;
type StorylineUpdateOptions = {
  expectedUpdatedAt?: string;
  /** Rewrite-context hash captured when the proposal was generated. */
  expectedContextHash?: string;
  /** Revision authorship may differ from the human who approves and audits a proposal. */
  revisionUser?: RequestUser;
};

/** Signals that a proposal's storyline dependencies changed before its atomic write. */
export class StorylineRewriteContextChangedError extends Error {
  constructor() {
    super('Storyline rewrite context changed before the update could be applied');
    this.name = 'StorylineRewriteContextChangedError';
  }
}

/** Keep multi-beat arc context useful without letting 50k prose fields multiply unboundedly. */
const ARC_BEAT_BODY_CONTEXT_CHARS = 2_000;

type LinkedPlayContext = {
  sessions: Map<number, Pick<typeof sessions.$inferSelect, 'id' | 'number' | 'title'>>;
  quests: Map<number, Pick<typeof quests.$inferSelect, 'id' | 'title' | 'status'>>;
  encounters: Map<number, Pick<typeof encounters.$inferSelect, 'id' | 'name' | 'status'>>;
};

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
    // Optional links to the play record this beat corresponds to (issue #264).
    sessionId: row.sessionId,
    questId: row.questId,
    encounterId: row.encounterId,
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
 * A cascade gets an ISO-8601 marker in a namespace that ordinary soft deletes
 * (which use `nowIso()`'s millisecond precision) cannot produce.  Keeping the
 * marker in `deletedAt` preserves the existing schema while allowing restore to
 * distinguish a cascade from an independently deleted beat in the same
 * millisecond.  The arc id makes markers for concurrent cascades distinct too.
 */
function arcCascadeDeletedAt(arcId: number): string {
  return nowIso().replace('Z', `${String(arcId).padStart(12, '0')}Z`);
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
    private readonly revisions: RevisionsService,
  ) {}

  // ---------- arcs ----------

  async listArcs(campaignId: number): Promise<StoryArc[]> {
    const rows = await this.db
      .select()
      .from(storyArcs)
      .where(and(eq(storyArcs.campaignId, campaignId), notDeleted(storyArcs.deletedAt)))
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

  async getArcRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(storyArcs).where(eq(storyArcs.id, id)).limit(1);
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Story arc ${id} not found`);
    return row;
  }

  async getArcWithBeatsOrThrow(id: number): Promise<StoryArcWithBeats> {
    const row = await this.getArcRowOrThrow(id);
    return { ...arcToDomain(row), beats: await this.beatsForArc(id) };
  }

  /**
   * Build the authoritative context used for storyline rewrites. Keeping this in the
   * domain service lets generation and proposal approval hash the exact same shape,
   * including child beats, branches, and linked play-record labels.
   */
  getRewriteContext(campaignId: number, target: 'arc' | 'beat', entityId: number) {
    return this.getRewriteContextInDb(this.db, campaignId, target, entityId);
  }

  /** Synchronous so approval can compare this hash and mutate inside one SQLite transaction. */
  private getRewriteContextInDb(
    db: StorylineReader,
    campaignId: number,
    target: 'arc' | 'beat',
    entityId: number,
  ) {
    if (target === 'arc') {
      const arcRow = db
        .select()
        .from(storyArcs)
        .where(and(eq(storyArcs.id, entityId), notDeleted(storyArcs.deletedAt)))
        .get();
      if (!arcRow) throw new NotFoundException(`Story arc ${entityId} not found`);
      const arc = arcToDomain(arcRow);
      if (arc.campaignId !== campaignId) {
        throw new BadRequestException(`Story arc ${entityId} does not belong to this campaign`);
      }
      const beatRows = db
        .select()
        .from(storyBeats)
        .where(and(eq(storyBeats.arcId, entityId), notDeleted(storyBeats.deletedAt)))
        .orderBy(asc(storyBeats.sortOrder), asc(storyBeats.id))
        .all();
      const beats = this.beatsWithBranchesInDb(db, beatRows);
      const linkedPlay = this.loadLinkedPlayContextInDb(db, beats, campaignId);
      const providerContext = {
        target: 'arc' as const,
        arc: {
          id: arc.id,
          title: arc.title,
          summary: arc.summary,
          status: arc.status,
          beats: beats.map((beat) =>
            this.storyBeatRewriteContext(beat, linkedPlay, ARC_BEAT_BODY_CONTEXT_CHARS),
          ),
        },
      };
      return {
        providerContext,
        contextHash: this.rewriteContextHash(providerContext),
        baseSnapshot: {
          id: arc.id,
          campaignId: arc.campaignId,
          title: arc.title,
          summary: arc.summary,
          status: arc.status,
          sortOrder: arc.sortOrder,
          createdAt: arc.createdAt,
          updatedAt: arc.updatedAt,
        },
      };
    }

    const beatRow = db
      .select()
      .from(storyBeats)
      .where(and(eq(storyBeats.id, entityId), notDeleted(storyBeats.deletedAt)))
      .get();
    if (!beatRow) throw new NotFoundException(`Story beat ${entityId} not found`);
    const beat = this.beatsWithBranchesInDb(db, [beatRow])[0];
    if (beat.campaignId !== campaignId) {
      throw new BadRequestException(`Story beat ${entityId} does not belong to this campaign`);
    }
    const arcRow = db
      .select()
      .from(storyArcs)
      .where(and(eq(storyArcs.id, beat.arcId), notDeleted(storyArcs.deletedAt)))
      .get();
    if (!arcRow) throw new NotFoundException(`Story arc ${beat.arcId} not found`);
    if (arcRow.campaignId !== campaignId) {
      throw new BadRequestException(`Story beat ${entityId} does not belong to this campaign`);
    }
    const linkedPlay = this.loadLinkedPlayContextInDb(db, [beat], campaignId);
    const providerContext = {
      target: 'beat' as const,
      arc: { id: arcRow.id, title: arcRow.title, summary: arcRow.summary, status: arcRow.status },
      beat: this.storyBeatRewriteContext(beat, linkedPlay),
    };
    return {
      providerContext,
      contextHash: this.rewriteContextHash(providerContext),
      baseSnapshot: {
        id: beat.id,
        campaignId: beat.campaignId,
        arcId: beat.arcId,
        title: beat.title,
        body: beat.body,
        status: beat.status,
        sortOrder: beat.sortOrder,
        sessionId: beat.sessionId,
        questId: beat.questId,
        encounterId: beat.encounterId,
        createdAt: beat.createdAt,
        updatedAt: beat.updatedAt,
      },
    };
  }

  private beatsWithBranchesInDb(
    db: StorylineReader,
    beatRows: Array<typeof storyBeats.$inferSelect>,
  ): StoryBeatWithBranches[] {
    const beatIds = beatRows.map((beat) => beat.id);
    const branchRows = beatIds.length === 0
      ? []
      : db
          .select()
          .from(storyBranches)
          .where(inArray(storyBranches.beatId, beatIds))
          .orderBy(asc(storyBranches.sortOrder), asc(storyBranches.id))
          .all();
    const branchesByBeat = new Map<number, StoryBranch[]>();
    for (const branchRow of branchRows) {
      const branches = branchesByBeat.get(branchRow.beatId) ?? [];
      branches.push(branchToDomain(branchRow));
      branchesByBeat.set(branchRow.beatId, branches);
    }
    return beatRows.map((beatRow) => ({
      ...beatToDomain(beatRow),
      branches: branchesByBeat.get(beatRow.id) ?? [],
    }));
  }

  /** Resolve all live linked play records in at most one query per table. */
  private loadLinkedPlayContextInDb(
    db: StorylineReader,
    beats: StoryBeatWithBranches[],
    campaignId: number,
  ): LinkedPlayContext {
    const sessionIds = [...new Set(beats.flatMap((beat) => beat.sessionId == null ? [] : [beat.sessionId]))];
    const questIds = [...new Set(beats.flatMap((beat) => beat.questId == null ? [] : [beat.questId]))];
    const encounterIds = [...new Set(beats.flatMap((beat) => beat.encounterId == null ? [] : [beat.encounterId]))];
    const sessionRows = sessionIds.length === 0
      ? []
      : db
          .select({ id: sessions.id, number: sessions.number, title: sessions.title })
          .from(sessions)
          .where(and(
            eq(sessions.campaignId, campaignId),
            inArray(sessions.id, sessionIds),
            notDeleted(sessions.deletedAt),
          ))
          .all();
    const questRows = questIds.length === 0
      ? []
      : db
          .select({ id: quests.id, title: quests.title, status: quests.status })
          .from(quests)
          .where(and(
            eq(quests.campaignId, campaignId),
            inArray(quests.id, questIds),
            notDeleted(quests.deletedAt),
          ))
          .all();
    const encounterRows = encounterIds.length === 0
      ? []
      : db
          .select({ id: encounters.id, name: encounters.name, status: encounters.status })
          .from(encounters)
          .where(and(
            eq(encounters.campaignId, campaignId),
            inArray(encounters.id, encounterIds),
            notDeleted(encounters.deletedAt),
          ))
          .all();
    return {
      sessions: new Map(sessionRows.map((row) => [row.id, row])),
      quests: new Map(questRows.map((row) => [row.id, row])),
      encounters: new Map(encounterRows.map((row) => [row.id, row])),
    };
  }

  private storyBeatRewriteContext(
    beat: StoryBeatWithBranches,
    linkedPlay: LinkedPlayContext,
    bodyLimit?: number,
  ) {
    const bodyTruncated = bodyLimit != null && beat.body.length > bodyLimit;
    const truncationNotice = '\n[truncated for arc rewrite context]';
    const body = bodyTruncated
      ? `${beat.body.slice(0, Math.max(0, bodyLimit - truncationNotice.length))}${truncationNotice}`
      : beat.body;
    return {
      id: beat.id,
      title: beat.title,
      body,
      ...(bodyTruncated ? { bodyTruncated: true } : {}),
      status: beat.status,
      branches: beat.branches.map((branch) => ({
        id: branch.id,
        label: branch.label,
        toBeatId: branch.toBeatId,
        sortOrder: branch.sortOrder,
      })),
      linkedPlayRecords: {
        session: beat.sessionId == null ? null : linkedPlay.sessions.get(beat.sessionId) ?? null,
        quest: beat.questId == null ? null : linkedPlay.quests.get(beat.questId) ?? null,
        encounter: beat.encounterId == null ? null : linkedPlay.encounters.get(beat.encounterId) ?? null,
      },
    };
  }

  private rewriteContextHash(providerContext: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(providerContext)).digest('hex');
  }

  async createArc(campaignId: number, input: StoryArcCreateInput, user: RequestUser, role: Role): Promise<StoryArc> {
    const ts = nowIso();
    const row = this.db.transaction((tx) => {
      const row = tx
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
        .returning()
        .get();
      this.revisions.commitProseVersionInTx(tx, {
        entityType: 'story_arc',
        entityId: row.id,
        campaignId,
        priorProse: '',
        nextProse: row.summary,
        user,
        ts,
      });
      this.audit.logInTx(tx, {
        actor: auditActor(user),
        actorRole: role,
        action: 'storyline.arc.create',
        entityType: 'story_arc',
        entityId: row.id,
        campaignId,
      });
      return row;
    }, { behavior: 'immediate' });
    return arcToDomain(row);
  }

  async updateArc(
    id: number,
    input: StoryArcUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: StorylineUpdateOptions,
  ): Promise<StoryArc> {
    const row = this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(storyArcs)
        .where(and(eq(storyArcs.id, id), notDeleted(storyArcs.deletedAt)))
        .get();
      if (!existing) throw new NotFoundException(`Story arc ${id} not found`);
      if (opts?.expectedContextHash) {
        const current = this.getRewriteContextInDb(tx, existing.campaignId, 'arc', id);
        if (current.contextHash !== opts.expectedContextHash) {
          throw new StorylineRewriteContextChangedError();
        }
      }
      const row = tx
        .update(storyArcs)
        .set({ ...input, updatedAt: nextUpdatedAt(existing.updatedAt) })
        .where(
          opts?.expectedUpdatedAt
            ? and(eq(storyArcs.id, id), eq(storyArcs.updatedAt, opts.expectedUpdatedAt))
            : eq(storyArcs.id, id),
        )
        .returning()
        .get();
      if (!row) throw staleWrite(opts?.expectedUpdatedAt, existing.updatedAt);
      if (input.summary !== undefined && input.summary !== existing.summary) {
        this.revisions.commitProseVersionInTx(tx, {
          entityType: 'story_arc',
          entityId: id,
          campaignId: existing.campaignId,
          priorProse: existing.summary,
          nextProse: input.summary,
          user: opts?.revisionUser ?? user,
        });
      }
      this.audit.logInTx(tx, {
        actor: auditActor(user),
        actorRole: role,
        action: 'storyline.arc.update',
        entityType: 'story_arc',
        entityId: id,
        campaignId: existing.campaignId,
      });
      return row;
    }, { behavior: 'immediate' });
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
    const ts = arcCascadeDeletedAt(id);
    // Soft-delete (issue #701): stamp the arc and every beat in one transaction so
    // topology (branches) and prose revisions survive for restore. Only beats live at
    // this moment receive the cascade timestamp, which is the restoration marker.
    this.db.transaction((tx) => {
      tx.update(storyBeats)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(and(eq(storyBeats.arcId, id), notDeleted(storyBeats.deletedAt)))
        .run();
      tx.update(storyArcs).set({ deletedAt: ts, updatedAt: ts }).where(eq(storyArcs.id, id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.arc.delete',
      entityType: 'story_arc',
      entityId: id,
      campaignId: existing.campaignId,
      detail: 'soft-delete (trashed)',
    });
  }

  /** Restore a trashed arc and only the beats soft-deleted by its cascade (issue #701). */
  async restoreArc(id: number, user: RequestUser, role: Role): Promise<StoryArcWithBeats> {
    const existing = await this.getArcRowOrThrow(id, true);
    const ts = nowIso();
    this.db.transaction((tx) => {
      // The arc may have been restored and trashed again after the outer lookup.
      // Re-read its cascade marker inside this synchronous transaction so we restore
      // the beats from the same deletion that we clear on the arc.
      const current = tx
        .select({ deletedAt: storyArcs.deletedAt })
        .from(storyArcs)
        .where(eq(storyArcs.id, id))
        .get();
      if (!current || current.deletedAt == null) throw new NotFoundException(`Story arc ${id} is not in the trash`);
      const cascadeDeletedAt = current.deletedAt;
      tx.update(storyArcs)
        .set({ deletedAt: null, updatedAt: ts })
        .where(and(eq(storyArcs.id, id), eq(storyArcs.deletedAt, cascadeDeletedAt)))
        .run();
      tx.update(storyBeats)
        .set({ deletedAt: null, updatedAt: ts })
        .where(and(eq(storyBeats.arcId, id), eq(storyBeats.deletedAt, cascadeDeletedAt)))
        .run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.arc.restore',
      entityType: 'story_arc',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return this.getArcWithBeatsOrThrow(id);
  }

  // ---------- beats ----------

  /**
   * Guard that a play-record link target (session/quest/encounter) exists in the SAME
   * campaign as the beat (issue #264) — mirrors EncountersService.assertEntityInCampaign
   * (issue #126). A cross-campaign or nonexistent ref is rejected (400) rather than stored,
   * so a beat can never point at play records outside its own campaign.
   */
  private async assertEntityInCampaign(kind: 'session' | 'quest' | 'encounter', id: number, campaignId: number): Promise<void> {
    const table = kind === 'session' ? sessions : kind === 'quest' ? quests : encounters;
    const deletedCol = kind === 'encounter' ? encounters.deletedAt : kind === 'session' ? sessions.deletedAt : quests.deletedAt;
    const [row] = await this.db
      .select({ campaignId: table.campaignId, deletedAt: deletedCol })
      .from(table)
      .where(and(eq(table.id, id), notDeleted(deletedCol)))
      .limit(1);
    if (!row || row.campaignId !== campaignId) {
      throw new BadRequestException(`${kind} ${id} does not exist in this campaign`);
    }
  }

  private async beatsForArc(arcId: number, includeDeleted = false): Promise<StoryBeatWithBranches[]> {
    const rows = await this.db
      .select()
      .from(storyBeats)
      .where(
        includeDeleted
          ? eq(storyBeats.arcId, arcId)
          : and(eq(storyBeats.arcId, arcId), notDeleted(storyBeats.deletedAt)),
      )
      .orderBy(asc(storyBeats.sortOrder), asc(storyBeats.id));
    const result: StoryBeatWithBranches[] = [];
    for (const row of rows) {
      result.push({ ...beatToDomain(row), branches: await this.branchesForBeat(row.id) });
    }
    return result;
  }

  async getBeatRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(storyBeats).where(eq(storyBeats.id, id)).limit(1);
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Story beat ${id} not found`);
    return row;
  }

  async getBeatWithBranchesOrThrow(id: number): Promise<StoryBeatWithBranches> {
    const row = await this.getBeatRowOrThrow(id);
    return { ...beatToDomain(row), branches: await this.branchesForBeat(id) };
  }

  async addBeat(arcId: number, input: StoryBeatCreateInput, user: RequestUser, role: Role): Promise<StoryBeat> {
    const arc = await this.getArcRowOrThrow(arcId);
    // Validate any play-record links belong to the same campaign as the arc (issue #264).
    if (input.sessionId != null) await this.assertEntityInCampaign('session', input.sessionId, arc.campaignId);
    if (input.questId != null) await this.assertEntityInCampaign('quest', input.questId, arc.campaignId);
    if (input.encounterId != null) await this.assertEntityInCampaign('encounter', input.encounterId, arc.campaignId);
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
        // Optional play-record links (issue #264). undefined -> null.
        sessionId: input.sessionId ?? null,
        questId: input.questId ?? null,
        encounterId: input.encounterId ?? null,
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

  async updateBeat(
    id: number,
    input: StoryBeatUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: StorylineUpdateOptions,
  ): Promise<StoryBeat> {
    const preflight = await this.getBeatRowOrThrow(id);
    // Validate any play-record links being SET (non-null) belong to the beat's campaign
    // (issue #264). `null` clears a link; an omitted field leaves it unchanged.
    if (input.sessionId != null) await this.assertEntityInCampaign('session', input.sessionId, preflight.campaignId);
    if (input.questId != null) await this.assertEntityInCampaign('quest', input.questId, preflight.campaignId);
    if (input.encounterId != null) await this.assertEntityInCampaign('encounter', input.encounterId, preflight.campaignId);
    const row = this.db.transaction((tx) => {
      const currentExisting = tx
        .select()
        .from(storyBeats)
        .where(and(eq(storyBeats.id, id), notDeleted(storyBeats.deletedAt)))
        .get();
      if (!currentExisting) throw new NotFoundException(`Story beat ${id} not found`);
      if (opts?.expectedContextHash) {
        const current = this.getRewriteContextInDb(tx, currentExisting.campaignId, 'beat', id);
        if (current.contextHash !== opts.expectedContextHash) {
          throw new StorylineRewriteContextChangedError();
        }
      }
      const row = tx
        .update(storyBeats)
        .set({ ...input, updatedAt: nextUpdatedAt(currentExisting.updatedAt) })
        .where(
          opts?.expectedUpdatedAt
            ? and(eq(storyBeats.id, id), eq(storyBeats.updatedAt, opts.expectedUpdatedAt))
            : eq(storyBeats.id, id),
        )
        .returning()
        .get();
      if (!row) throw staleWrite(opts?.expectedUpdatedAt, currentExisting.updatedAt);
      if (input.body !== undefined && input.body !== currentExisting.body) {
        this.revisions.commitProseVersionInTx(tx, {
          entityType: 'story_beat',
          entityId: id,
          campaignId: currentExisting.campaignId,
          priorProse: currentExisting.body,
          nextProse: input.body,
          user: opts?.revisionUser ?? user,
        });
      }
      this.audit.logInTx(tx, {
        actor: auditActor(user),
        actorRole: role,
        action: 'storyline.beat.update',
        entityType: 'story_beat',
        entityId: id,
        campaignId: currentExisting.campaignId,
      });
      return row;
    }, { behavior: 'immediate' });
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
    await this.db.update(storyBeats).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(storyBeats.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.beat.delete',
      entityType: 'story_beat',
      entityId: id,
      campaignId: existing.campaignId,
      detail: 'soft-delete (trashed)',
    });
  }

  /** Restore a trashed beat (issue #701). Refused while its parent arc is still trashed. */
  async restoreBeat(id: number, user: RequestUser, role: Role): Promise<StoryBeat> {
    const existing = await this.getBeatRowOrThrow(id, true);
    if (existing.deletedAt == null) throw new NotFoundException(`Story beat ${id} is not in the trash`);
    const arc = await this.getArcRowOrThrow(existing.arcId, true);
    if (arc.deletedAt != null) {
      throw new ConflictException('Restore the parent arc first — its beats are trashed together.');
    }
    const [row] = await this.db
      .update(storyBeats)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(eq(storyBeats.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.beat.restore',
      entityType: 'story_beat',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return beatToDomain(row);
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
        .where(and(eq(storyBeats.id, input.toBeatId), eq(storyBeats.campaignId, beat.campaignId), notDeleted(storyBeats.deletedAt)))
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

  /**
   * Update a branch's label, target beat, or sort order. `toBeatId` may be set to
   * `null` to clear the target; omitted fields are left unchanged. The target, when
   * provided (non-null), must be a beat in the same campaign as the source.
   */
  async updateBranch(
    beatId: number,
    branchId: number,
    input: StoryBranchUpdateInput,
    user: RequestUser,
    role: Role,
  ): Promise<StoryBranch> {
    const beat = await this.getBeatRowOrThrow(beatId);
    const [existing] = await this.db
      .select()
      .from(storyBranches)
      .where(and(eq(storyBranches.id, branchId), eq(storyBranches.beatId, beatId)))
      .limit(1);
    if (!existing) throw new NotFoundException(`Branch ${branchId} not found`);
    if (input.toBeatId != null) {
      const [target] = await this.db
        .select({ id: storyBeats.id })
        .from(storyBeats)
        .where(and(eq(storyBeats.id, input.toBeatId), eq(storyBeats.campaignId, beat.campaignId), notDeleted(storyBeats.deletedAt)))
        .limit(1);
      if (!target) {
        throw new BadRequestException(`toBeatId ${input.toBeatId} does not exist in this campaign`);
      }
    }
    const set: { label?: string; toBeatId?: number | null; sortOrder?: number } = {};
    if (input.label !== undefined) set.label = input.label;
    if (input.toBeatId !== undefined) set.toBeatId = input.toBeatId;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    if (Object.keys(set).length === 0) {
      // No fields to update — return the existing row unchanged instead of
      // issuing an empty UPDATE, which some drivers reject as invalid SQL.
      return branchToDomain(existing);
    }
    const [row] = await this.db
      .update(storyBranches)
      .set(set)
      .where(and(eq(storyBranches.id, branchId), eq(storyBranches.beatId, beatId)))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'storyline.branch.update',
      entityType: 'story_branch',
      entityId: branchId,
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

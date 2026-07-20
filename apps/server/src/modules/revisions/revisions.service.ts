import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { EntityRevision, Role, RevisionEntityType } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { entityRevisions, locations, npcs, quests, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';

/**
 * Prose revision history + optimistic-concurrency guard (issue #157).
 *
 * Two cooperating tiers protect the prose entities most at risk of a blind
 * last-write-wins clobber (a co-DM polishing a recap while a connected AI over MCP
 * saves its own edit):
 *
 *  1. `assertNotStale` — the optimistic-concurrency check every prose service calls
 *     at the top of its update() when the caller supplied an `expectedUpdatedAt`.
 *  2. `record` / `listForEntity` / `restore` — the revision history: the owning
 *     service snapshots the PRIOR prose here on every committed change, the history
 *     is listable, and any prior snapshot can be re-applied (itself recorded).
 *
 * The four supported entity types share a single prose column each: sessions.recap
 * and quests/npcs/locations.body. `restore` writes that column DIRECTLY (never back
 * through the owning service) so this module has no dependency on any entity service
 * — the recording direction is one-way (entity service → RevisionsService), so there
 * is no cycle. A restore skips entity-specific side effects (e.g. recap_posted
 * notifications) on purpose: re-applying old text is not a fresh post.
 */

/** The prose field snapshotted/restored for each supported entity type. */
const PROSE_FIELD: Record<RevisionEntityType, 'recap' | 'body'> = {
  session: 'recap',
  quest: 'body',
  npc: 'body',
  location: 'body',
};

@Injectable()
export class RevisionsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Optimistic-concurrency guard (tier 1). When `expectedUpdatedAt` is supplied and it
   * no longer matches the row's current `updatedAt` — someone else saved since the
   * caller loaded it — reject with 409 instead of overwriting. Omitted => no-op, so
   * every existing caller (and any client that doesn't opt in) is unaffected.
   */
  assertNotStale(existing: { updatedAt: string }, expectedUpdatedAt: string | undefined): void {
    if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
      throw new ConflictException({
        code: 'STALE_WRITE',
        message:
          'This was changed by someone else since you loaded it — saving now would erase their edit. ' +
          'Reload to get the latest version, reapply your changes, then save again.',
        expectedUpdatedAt,
        currentUpdatedAt: existing.updatedAt,
      });
    }
  }

  /** The prose field name for an entity type (public so callers can key their snapshots). */
  proseField(entityType: RevisionEntityType): 'recap' | 'body' {
    return PROSE_FIELD[entityType];
  }

  private toDomain(row: typeof entityRevisions.$inferSelect): EntityRevision {
    return {
      id: row.id,
      campaignId: row.campaignId,
      entityType: row.entityType as RevisionEntityType,
      entityId: row.entityId,
      snapshot: fromJsonText<Record<string, string>>(row.snapshot, {}),
      authorUserId: row.authorUserId,
      authorName: row.authorName,
      createdAt: row.createdAt,
    };
  }

  /**
   * Snapshot an entity's PRIOR prose as a new revision. Called by the owning service
   * from inside its update() BEFORE the write, only when the prose actually changes —
   * so history is bounded to committed edits (never one row per keystroke), and an
   * unchanged save records nothing. `priorProse` is the value being overwritten.
   */
  async record(params: {
    entityType: RevisionEntityType;
    entityId: number;
    campaignId: number;
    priorProse: string;
    user: RequestUser;
  }): Promise<void> {
    const field = PROSE_FIELD[params.entityType];
    await this.db.insert(entityRevisions).values({
      campaignId: params.campaignId,
      entityType: params.entityType,
      entityId: params.entityId,
      snapshot: toJsonText({ [field]: params.priorProse }),
      authorUserId: params.user.id,
      authorName: params.user.name,
      createdAt: nowIso(),
    });
  }

  /** Delete every revision for one entity — called by the owning service's remove() so a single entity delete leaves no orphan. */
  async removeForEntity(entityType: RevisionEntityType, entityId: number): Promise<void> {
    await this.db
      .delete(entityRevisions)
      .where(and(eq(entityRevisions.entityType, entityType), eq(entityRevisions.entityId, entityId)));
  }

  /** An entity's revisions, newest-first. */
  async listForEntity(entityType: RevisionEntityType, entityId: number): Promise<EntityRevision[]> {
    const rows = await this.db
      .select()
      .from(entityRevisions)
      .where(and(eq(entityRevisions.entityType, entityType), eq(entityRevisions.entityId, entityId)))
      .orderBy(desc(entityRevisions.id));
    return rows.map((r) => this.toDomain(r));
  }

  /** Load the current prose + campaignId + updatedAt for a target entity, or null if it's gone. */
  private async loadTarget(
    entityType: RevisionEntityType,
    entityId: number,
  ): Promise<{ campaignId: number; prose: string; updatedAt: string } | null> {
    switch (entityType) {
      case 'session': {
        const [row] = await this.db.select().from(sessions).where(eq(sessions.id, entityId)).limit(1);
        return row ? { campaignId: row.campaignId, prose: row.recap, updatedAt: row.updatedAt } : null;
      }
      case 'quest': {
        const [row] = await this.db.select().from(quests).where(eq(quests.id, entityId)).limit(1);
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
      case 'npc': {
        const [row] = await this.db.select().from(npcs).where(eq(npcs.id, entityId)).limit(1);
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
      case 'location': {
        const [row] = await this.db.select().from(locations).where(eq(locations.id, entityId)).limit(1);
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
    }
  }

  /** Write an entity's prose column back and bump updatedAt. */
  private async writeProse(entityType: RevisionEntityType, entityId: number, prose: string, ts: string): Promise<void> {
    switch (entityType) {
      case 'session':
        await this.db.update(sessions).set({ recap: prose, updatedAt: ts }).where(eq(sessions.id, entityId));
        return;
      case 'quest':
        await this.db.update(quests).set({ body: prose, updatedAt: ts }).where(eq(quests.id, entityId));
        return;
      case 'npc':
        await this.db.update(npcs).set({ body: prose, updatedAt: ts }).where(eq(npcs.id, entityId));
        return;
      case 'location':
        await this.db.update(locations).set({ body: prose, updatedAt: ts }).where(eq(locations.id, entityId));
        return;
    }
  }

  /** The current campaignId for an entity (for the controller's access check), or throws 404 if it's gone. */
  async campaignIdForEntityOrThrow(entityType: RevisionEntityType, entityId: number): Promise<number> {
    const target = await this.loadTarget(entityType, entityId);
    if (!target) throw new NotFoundException(`${entityType} ${entityId} not found`);
    return target.campaignId;
  }

  /**
   * Restore a prior revision: snapshot the CURRENT prose (so the restore is itself
   * undoable), re-apply the revision's snapshot to the live entity as a new update, and
   * record the restore in the audit log. The revision must belong to the named entity
   * (a mismatched or foreign id 404s). Returns the fresh revision list.
   */
  async restore(
    entityType: RevisionEntityType,
    entityId: number,
    revisionId: number,
    user: RequestUser,
    role: Role,
  ): Promise<{ entityType: RevisionEntityType; entityId: number; updatedAt: string; revisions: EntityRevision[] }> {
    const [revision] = await this.db.select().from(entityRevisions).where(eq(entityRevisions.id, revisionId)).limit(1);
    if (!revision || revision.entityType !== entityType || revision.entityId !== entityId) {
      throw new NotFoundException(`Revision ${revisionId} not found for ${entityType} ${entityId}`);
    }
    const target = await this.loadTarget(entityType, entityId);
    if (!target) throw new NotFoundException(`${entityType} ${entityId} not found`);

    const field = PROSE_FIELD[entityType];
    const snapshot = fromJsonText<Record<string, string>>(revision.snapshot, {});
    const restoredProse = snapshot[field] ?? '';

    const ts = nowIso();
    // Capture the current content as a new revision FIRST so restore is reversible, then
    // re-apply the old snapshot. Only record when it actually differs — a restore-to-same
    // is a no-op that shouldn't grow history.
    if (target.prose !== restoredProse) {
      await this.record({ entityType, entityId, campaignId: target.campaignId, priorProse: target.prose, user });
    }
    await this.writeProse(entityType, entityId, restoredProse, ts);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: `${entityType}.revision.restore`,
      entityType,
      entityId,
      campaignId: target.campaignId,
      detail: JSON.stringify({ restoredFromRevisionId: revisionId }),
    });

    return { entityType, entityId, updatedAt: ts, revisions: await this.listForEntity(entityType, entityId) };
  }
}

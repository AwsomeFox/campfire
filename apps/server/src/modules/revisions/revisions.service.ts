import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { EntityRevision, RevisionAuthorSource, Role, RevisionEntityType } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  auditLog,
  entityRevisions,
  factions,
  locations,
  notes,
  npcs,
  quests,
  sessions,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

/**
 * Prose revision history + optimistic-concurrency guard (issue #157 / #813 / #513).
 *
 * Two cooperating tiers protect the prose entities most at risk of a blind
 * last-write-wins clobber (a co-DM polishing a recap while a connected AI over MCP
 * saves its own edit):
 *
 *  1. `assertNotStale` — the optimistic-concurrency check every prose service calls
 *     at the top of its update() when the caller supplied an `expectedUpdatedAt`.
 *  2. `commitProseVersion` / `listForEntity` / `restore` — immutable version history:
 *     each committed prose write opens a version tip attributed to the writer; the
 *     previous tip is closed with the replacing actor/time. History listings omit
 *     the live tip. Any prior version can be re-applied (itself recorded as a new
 *     tip linked via `restoredFromRevisionId`).
 *
 * The six supported entity types share a single prose column each: sessions.recap
 * and quests/npcs/locations/factions/notes.body. `restore` writes that column DIRECTLY
 * (never back through the owning service) so this module has no dependency on any
 * entity service — the recording direction is one-way (entity service → RevisionsService),
 * so there is no cycle. A restore skips entity-specific side effects (e.g. recap_posted
 * notifications) on purpose: re-applying old text is not a fresh post.
 *
 * Restore itself is one synchronous better-sqlite3 transaction (issue #513): the
 * pre-restore snapshot, entity prose update, new revision tip, and audit row either
 * all commit or all roll back. Concurrent restore/edit uses the same `expectedUpdatedAt`
 * version guard as prose PATCH.
 */

/** The prose field snapshotted/restored for each supported entity type. */
const PROSE_FIELD: Record<RevisionEntityType, 'recap' | 'body'> = {
  session: 'recap',
  quest: 'body',
  npc: 'body',
  location: 'body',
  faction: 'body',
  note: 'body',
};

const AUTHOR_SOURCES = new Set<RevisionAuthorSource>(['human', 'ai', 'tool']);

/** better-sqlite3 transaction handle or the root db — both expose sync `.all()`/`.run()`. */
type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

function asAuthorSource(value: string | null | undefined): RevisionAuthorSource {
  return value && AUTHOR_SOURCES.has(value as RevisionAuthorSource)
    ? (value as RevisionAuthorSource)
    : 'human';
}

/**
 * Resolve human / AI / tool provenance for a revision actor (issue #813).
 * AI seats carry `proposalAttribution` (and often a synthetic tokenContext); check
 * AI first so they are not mislabeled as ordinary tool/PAT actors.
 */
export function revisionActorProvenance(user: RequestUser): {
  userId: string;
  name: string;
  source: RevisionAuthorSource;
  sourceDetail: string;
} {
  const aiUserId = user.proposalAttribution?.proposerUserId;
  if (
    (typeof aiUserId === 'string' && aiUserId.startsWith('ai-dm:')) ||
    user.id.startsWith('ai-dm-seat:') ||
    user.id.startsWith('ai-dm:')
  ) {
    return {
      userId: aiUserId && aiUserId.startsWith('ai-dm:') ? aiUserId : user.id,
      name: user.proposalAttribution?.proposer?.trim() || user.name || 'AI Dungeon Master',
      source: 'ai',
      sourceDetail: user.tokenContext?.name ?? '',
    };
  }
  if (user.tokenContext) {
    return {
      userId: user.id,
      name: user.name,
      source: 'tool',
      sourceDetail: user.tokenContext.name,
    };
  }
  return {
    userId: user.id,
    name: user.name,
    source: 'human',
    sourceDetail: '',
  };
}

@Injectable()
export class RevisionsService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

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
      authorSource: asAuthorSource(row.authorSource),
      authorSourceDetail: row.authorSourceDetail,
      createdAt: row.createdAt,
      replacedByUserId: row.replacedByUserId,
      replacedByName: row.replacedByName,
      replacedBySource: asAuthorSource(row.replacedBySource),
      replacedBySourceDetail: row.replacedBySourceDetail,
      replacedAt: row.replacedAt ?? null,
      restoredFromRevisionId: row.restoredFromRevisionId ?? null,
      authorshipKnown: row.authorshipKnown,
    };
  }

  /** Current unreplaced tip for an entity, if one exists. */
  private loadTip(
    db: SyncDb,
    entityType: RevisionEntityType,
    entityId: number,
  ): typeof entityRevisions.$inferSelect | null {
    return (
      db
        .select()
        .from(entityRevisions)
        .where(
          and(
            eq(entityRevisions.entityType, entityType),
            eq(entityRevisions.entityId, entityId),
            isNull(entityRevisions.replacedAt),
          ),
        )
        .orderBy(desc(entityRevisions.id))
        .limit(1)
        .get() ?? null
    );
  }

  /**
   * Synchronous tip-close + tip-open (issue #813). Callers that need atomicity with
   * other writes (restore, #513) pass a transaction handle; ordinary entity updates
   * pass `this.db`.
   */
  private commitProseVersionOn(
    db: SyncDb,
    params: {
      entityType: RevisionEntityType;
      entityId: number;
      campaignId: number;
      priorProse: string;
      nextProse: string;
      user: RequestUser;
      restoredFromRevisionId?: number | null;
      ts?: string;
    },
  ): void {
    if (params.priorProse === params.nextProse) return;

    const field = PROSE_FIELD[params.entityType];
    const ts = params.ts ?? nowIso();
    const actor = revisionActorProvenance(params.user);
    const tip = this.loadTip(db, params.entityType, params.entityId);

    if (tip) {
      db.update(entityRevisions)
        .set({
          replacedByUserId: actor.userId,
          replacedByName: actor.name,
          replacedBySource: actor.source,
          replacedBySourceDetail: actor.sourceDetail,
          replacedAt: ts,
        })
        .where(eq(entityRevisions.id, tip.id))
        .run();
    } else if (params.priorProse !== '') {
      // No tip — prior content's author is unknowable. Record an honest legacy row.
      db.insert(entityRevisions)
        .values({
          campaignId: params.campaignId,
          entityType: params.entityType,
          entityId: params.entityId,
          snapshot: toJsonText({ [field]: params.priorProse }),
          authorUserId: '',
          authorName: '',
          authorSource: 'human',
          authorSourceDetail: '',
          createdAt: '',
          replacedByUserId: actor.userId,
          replacedByName: actor.name,
          replacedBySource: actor.source,
          replacedBySourceDetail: actor.sourceDetail,
          replacedAt: ts,
          restoredFromRevisionId: null,
          authorshipKnown: false,
        })
        .run();
    }

    db.insert(entityRevisions)
      .values({
        campaignId: params.campaignId,
        entityType: params.entityType,
        entityId: params.entityId,
        snapshot: toJsonText({ [field]: params.nextProse }),
        authorUserId: actor.userId,
        authorName: actor.name,
        authorSource: actor.source,
        authorSourceDetail: actor.sourceDetail,
        createdAt: ts,
        replacedByUserId: '',
        replacedByName: '',
        replacedBySource: 'human',
        replacedBySourceDetail: '',
        replacedAt: null,
        restoredFromRevisionId: params.restoredFromRevisionId ?? null,
        authorshipKnown: true,
      })
      .run();
  }

  /**
   * Commit an immutable prose version (issue #813).
   *
   * - Closes the current tip (if any) with the replacing actor/time — that tip already
   *   carries the real version author/createdAt from when it was opened.
   * - When there is no tip but `priorProse` is non-empty (entity existed before tip
   *   tracking, or pre-#813 content), records a legacy closed version with
   *   `authorshipKnown=false` so the UI labels it "Replaced by …".
   * - Opens a new tip for `nextProse` attributed to `user` (human/AI/tool provenance).
   *
   * No-op when prior and next prose are identical. Callers invoke this on create
   * (`priorProse: ''`) and on every committed prose change.
   */
  async commitProseVersion(params: {
    entityType: RevisionEntityType;
    entityId: number;
    campaignId: number;
    priorProse: string;
    nextProse: string;
    user: RequestUser;
    restoredFromRevisionId?: number | null;
  }): Promise<void> {
    this.commitProseVersionOn(this.db, params);
  }

  /**
   * @deprecated Prefer {@link commitProseVersion}. Kept as a thin adapter so any
   * stray caller that only has prior prose still records a legacy closed version
   * and opens an empty tip — not used by production entity services.
   */
  async record(params: {
    entityType: RevisionEntityType;
    entityId: number;
    campaignId: number;
    priorProse: string;
    user: RequestUser;
  }): Promise<void> {
    // Without next prose we cannot open a truthful tip; record prior as legacy-closed only.
    if (params.priorProse === '') return;
    const field = PROSE_FIELD[params.entityType];
    const ts = nowIso();
    const actor = revisionActorProvenance(params.user);
    const tip = this.loadTip(this.db, params.entityType, params.entityId);
    if (tip) {
      this.db
        .update(entityRevisions)
        .set({
          replacedByUserId: actor.userId,
          replacedByName: actor.name,
          replacedBySource: actor.source,
          replacedBySourceDetail: actor.sourceDetail,
          replacedAt: ts,
        })
        .where(eq(entityRevisions.id, tip.id))
        .run();
      return;
    }
    this.db
      .insert(entityRevisions)
      .values({
        campaignId: params.campaignId,
        entityType: params.entityType,
        entityId: params.entityId,
        snapshot: toJsonText({ [field]: params.priorProse }),
        authorUserId: '',
        authorName: '',
        authorSource: 'human',
        authorSourceDetail: '',
        createdAt: '',
        replacedByUserId: actor.userId,
        replacedByName: actor.name,
        replacedBySource: actor.source,
        replacedBySourceDetail: actor.sourceDetail,
        replacedAt: ts,
        restoredFromRevisionId: null,
        authorshipKnown: false,
      })
      .run();
  }

  /** Delete every revision for one entity — called by the owning service's remove() so a single entity delete leaves no orphan. */
  async removeForEntity(entityType: RevisionEntityType, entityId: number): Promise<void> {
    await this.db
      .delete(entityRevisions)
      .where(and(eq(entityRevisions.entityType, entityType), eq(entityRevisions.entityId, entityId)));
  }

  /**
   * An entity's superseded versions, newest-first. Omits the live tip (replacedAt
   * null) — history is prior canon, not the current editor buffer.
   */
  async listForEntity(entityType: RevisionEntityType, entityId: number): Promise<EntityRevision[]> {
    const rows = await this.db
      .select()
      .from(entityRevisions)
      .where(and(eq(entityRevisions.entityType, entityType), eq(entityRevisions.entityId, entityId)))
      .orderBy(desc(entityRevisions.id));
    return rows.filter((r) => r.replacedAt != null).map((r) => this.toDomain(r));
  }

  /** Every revision row for a campaign (including live tips) — used by export/import (#813). */
  async listForCampaign(campaignId: number): Promise<EntityRevision[]> {
    const rows = await this.db
      .select()
      .from(entityRevisions)
      .where(eq(entityRevisions.campaignId, campaignId))
      .orderBy(asc(entityRevisions.id));
    return rows.map((r) => this.toDomain(r));
  }

  /** Load the current prose + campaignId + updatedAt for a target entity, or null if it's gone. */
  private loadTarget(
    db: SyncDb,
    entityType: RevisionEntityType,
    entityId: number,
  ): { campaignId: number; prose: string; updatedAt: string } | null {
    switch (entityType) {
      case 'session': {
        const row = db.select().from(sessions).where(eq(sessions.id, entityId)).limit(1).get();
        return row ? { campaignId: row.campaignId, prose: row.recap, updatedAt: row.updatedAt } : null;
      }
      case 'quest': {
        const row = db.select().from(quests).where(eq(quests.id, entityId)).limit(1).get();
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
      case 'npc': {
        const row = db.select().from(npcs).where(eq(npcs.id, entityId)).limit(1).get();
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
      case 'location': {
        const row = db.select().from(locations).where(eq(locations.id, entityId)).limit(1).get();
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
      case 'faction': {
        const row = db.select().from(factions).where(eq(factions.id, entityId)).limit(1).get();
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
      case 'note': {
        const row = db.select().from(notes).where(eq(notes.id, entityId)).limit(1).get();
        return row ? { campaignId: row.campaignId, prose: row.body, updatedAt: row.updatedAt } : null;
      }
    }
  }

  /**
   * A note's access-relevant fields, for the RevisionsController's per-note visibility gate
   * (notes don't share the uniform dm-only edit path of the world-building entities). A
   * trashed note (soft-deleted, #116) reads as gone — same as its normal GET — so its
   * history/restore is unreachable while it sits in the Trash. Returns null when absent.
   */
  async loadNoteAccess(
    entityId: number,
  ): Promise<{ campaignId: number; authorUserId: string; visibility: string; recipientUserId: string | null } | null> {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, entityId)).limit(1);
    if (!row || row.deletedAt != null) return null;
    return {
      campaignId: row.campaignId,
      authorUserId: row.authorUserId,
      visibility: row.visibility,
      recipientUserId: row.recipientUserId ?? null,
    };
  }

  /**
   * Write an entity's prose column back and bump updatedAt, compare-and-swapping on
   * `expectedUpdatedAt`. Returns false when the row was concurrently changed (0 rows).
   */
  private writeProseCas(
    db: SyncDb,
    entityType: RevisionEntityType,
    entityId: number,
    prose: string,
    ts: string,
    expectedUpdatedAt: string,
  ): boolean {
    const changesOf = (result: unknown): number =>
      (result as { changes?: number }).changes ?? 0;
    switch (entityType) {
      case 'session':
        return (
          changesOf(
            db
              .update(sessions)
              .set({ recap: prose, updatedAt: ts })
              .where(and(eq(sessions.id, entityId), eq(sessions.updatedAt, expectedUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'quest':
        return (
          changesOf(
            db
              .update(quests)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(quests.id, entityId), eq(quests.updatedAt, expectedUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'npc':
        return (
          changesOf(
            db
              .update(npcs)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(npcs.id, entityId), eq(npcs.updatedAt, expectedUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'location':
        return (
          changesOf(
            db
              .update(locations)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(locations.id, entityId), eq(locations.updatedAt, expectedUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'faction':
        return (
          changesOf(
            db
              .update(factions)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(factions.id, entityId), eq(factions.updatedAt, expectedUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'note':
        return (
          changesOf(
            db
              .update(notes)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(notes.id, entityId), eq(notes.updatedAt, expectedUpdatedAt)))
              .run(),
          ) > 0
        );
    }
  }

  /** The current campaignId for an entity (for the controller's access check), or throws 404 if it's gone. */
  async campaignIdForEntityOrThrow(entityType: RevisionEntityType, entityId: number): Promise<number> {
    const target = this.loadTarget(this.db, entityType, entityId);
    if (!target) throw new NotFoundException(`${entityType} ${entityId} not found`);
    return target.campaignId;
  }

  /**
   * Restore a prior revision: close the current tip (so the restore is itself
   * undoable), re-apply the revision's snapshot as a new tip attributed to the
   * restorer and linked via `restoredFromRevisionId`, and record the restore in
   * the audit log. The revision must belong to the named entity (a mismatched or
   * foreign id 404s). Returns the fresh revision list (superseded versions only).
   *
   * Snapshot, entity prose update, new revision tip, and audit commit in one
   * synchronous better-sqlite3 transaction (issue #513). Optional `expectedUpdatedAt`
   * uses the same STALE_WRITE guard as prose PATCH; the prose write also CAS-updates
   * on the live row's updatedAt so a concurrent edit cannot interleave mid-restore.
   */
  async restore(
    entityType: RevisionEntityType,
    entityId: number,
    revisionId: number,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<{ entityType: RevisionEntityType; entityId: number; updatedAt: string; revisions: EntityRevision[] }> {
    const revision = this.db
      .select()
      .from(entityRevisions)
      .where(eq(entityRevisions.id, revisionId))
      .limit(1)
      .get();
    if (!revision || revision.entityType !== entityType || revision.entityId !== entityId) {
      throw new NotFoundException(`Revision ${revisionId} not found for ${entityType} ${entityId}`);
    }

    const field = PROSE_FIELD[entityType];
    const snapshot = fromJsonText<Record<string, string>>(revision.snapshot, {});
    const restoredProse = snapshot[field] ?? '';
    const ts = nowIso();

    // better-sqlite3 serializes this synchronous callback: tip close, tip open, prose
    // CAS, and audit either all land or all roll back. A throw (including 409) aborts.
    this.db.transaction((tx) => {
      const target = this.loadTarget(tx, entityType, entityId);
      if (!target) throw new NotFoundException(`${entityType} ${entityId} not found`);
      this.assertNotStale(target, opts?.expectedUpdatedAt);

      // Capture the current content as a closed version FIRST so restore is reversible, then
      // open a new tip for the restored prose. Only record when it actually differs — a
      // restore-to-same is a no-op that shouldn't grow history.
      if (target.prose !== restoredProse) {
        this.commitProseVersionOn(tx, {
          entityType,
          entityId,
          campaignId: target.campaignId,
          priorProse: target.prose,
          nextProse: restoredProse,
          user,
          restoredFromRevisionId: revisionId,
          ts,
        });
      }

      if (!this.writeProseCas(tx, entityType, entityId, restoredProse, ts, target.updatedAt)) {
        // Row moved between the in-tx read and the CAS write (should be rare under
        // better-sqlite3's write lock); surface the same STALE_WRITE shape as PATCH.
        throw new ConflictException({
          code: 'STALE_WRITE',
          message:
            'This was changed by someone else since you loaded it — restoring now would erase their edit. ' +
            'Reload to get the latest version, then restore again.',
          expectedUpdatedAt: opts?.expectedUpdatedAt ?? target.updatedAt,
          currentUpdatedAt: this.loadTarget(tx, entityType, entityId)?.updatedAt ?? target.updatedAt,
        });
      }

      tx.insert(auditLog)
        .values({
          campaignId: target.campaignId,
          actor: auditActor(user),
          actorRole: role,
          action: `${entityType}.revision.restore`,
          entityType,
          entityId,
          detail: JSON.stringify({ restoredFromRevisionId: revisionId }),
          createdAt: ts,
        })
        .run();
    });

    return { entityType, entityId, updatedAt: ts, revisions: await this.listForEntity(entityType, entityId) };
  }
}

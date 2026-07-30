import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { EntityRevision, RevisionAuthorSource, Role, RevisionEntityType } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  auditLog,
  comments,
  entityRevisions,
  factions,
  locations,
  notes,
  npcs,
  quests,
  scheduledSessions,
  sessionZero,
  sessions,
  storyBeats,
  timelineCalendars,
  timelineEvents,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { nextUpdatedAt } from '../../common/stale-write';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { ModerationService, type ModerationTx } from '../moderation/moderation.service';

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
 * Issue #601 adds the one exception that direct write makes necessary: because a
 * restore bypasses CommentsService/NotesService, it also bypasses their pre-mutation
 * abuse-evidence hooks, so this service injects ModerationService and fires the hook
 * itself. ModerationService depends on neither this service nor any entity service
 * (its two visibility rules live in `common/`), so the edge stays acyclic. The same
 * dependency enforces the quarantine gate on reading and restoring history.
 *
 * Restore itself is one synchronous better-sqlite3 transaction (issue #513): the
 * pre-restore snapshot, entity prose update, new revision tip, and audit row either
 * all commit or all roll back. Concurrent restore/edit uses the same `expectedUpdatedAt`
 * version guard as prose PATCH.
 */

/** The prose field snapshotted/restored for each supported entity type. */
type ProseField = 'recap' | 'body' | 'note' | 'notes';
const PROSE_FIELD: Record<RevisionEntityType, ProseField> = {
  session: 'recap',
  quest: 'body',
  npc: 'body',
  location: 'body',
  faction: 'body',
  note: 'body',
  timeline_event: 'body',
  timeline_calendar: 'note',
  scheduled_session: 'notes',
  comment: 'body',
  story_beat: 'body',
  session_zero: 'body',
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
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    // Issue #601: a restore mutates the live prose, so it must trip the same
    // pre-mutation evidence hook as an ordinary edit. The dependency runs one way
    // (revisions -> moderation); ModerationService never injects this service back.
    private readonly moderation: ModerationService,
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
  proseField(entityType: RevisionEntityType): ProseField {
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
          replacedByImported: false,
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
          // Author/time of prior prose is unknowable; stamp createdAt with the close
          // time so clients never parse an empty date string.
          createdAt: ts,
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
   * Commit a prose version as part of a caller-owned synchronous transaction.
   * Use this when a prose edit has additional guards or related writes that
   * must either all commit or all roll back with the version history.
   */
  commitProseVersionInTx(
    tx: SyncDb,
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
    this.commitProseVersionOn(tx, params);
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
          replacedByImported: false,
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
        // Author/time of prior prose is unknowable; stamp createdAt with the close
        // time so clients never parse an empty date string.
        createdAt: ts,
        replacedByUserId: actor.userId,
        replacedByName: actor.name,
        replacedByImported: false,
        replacedBySource: actor.source,
        replacedBySourceDetail: actor.sourceDetail,
        replacedAt: ts,
        restoredFromRevisionId: null,
        authorshipKnown: false,
      })
      .run();
  }

  /** Record a structured prior snapshot (Session Zero safety charter — issue #881). */
  async recordSnapshot(params: {
    entityType: RevisionEntityType;
    entityId: number;
    campaignId: number;
    snapshot: Record<string, unknown>;
    user: RequestUser;
  }): Promise<void> {
    const ts = nowIso();
    const actor = revisionActorProvenance(params.user);
    // Prior Session Zero content has no author provenance on the entity row — attribute
    // only the replacing editor and mark authorshipKnown=false (issue #881).
    this.db
      .insert(entityRevisions)
      .values({
        campaignId: params.campaignId,
        entityType: params.entityType,
        entityId: params.entityId,
        snapshot: toJsonText(params.snapshot),
        authorUserId: '',
        authorName: '',
        authorSource: 'human',
        authorSourceDetail: '',
        createdAt: ts,
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
   * Issue #601 — moderation quarantine is a gate on PROSE, and a revision is prose.
   *
   * Quarantine is enforced on the live row (CommentsService.toDomain swaps the body
   * for a placeholder; NotesService drops the row from every read), but revision
   * history is a wholly separate table reached through a wholly separate controller.
   * Without this guard a DM could `GET /revisions/comment/:id` and read the exact
   * words they had just withheld, and — worse — `POST .../restore` would write a
   * pre-quarantine revision back into the live row, lifting the quarantine through a
   * route that never touches CommentsService.assertNotQuarantined. The comment's own
   * `assertNotQuarantined` guards only the paths that go through that service.
   *
   * Placed on the two RevisionsService chokepoints rather than in the controller so
   * every caller inherits it, including CommentsService.listRevisions.
   *
   * Takes its own reader so `restore` can run it a second time INSIDE its write
   * transaction, against the row the prose write will actually touch. Called only
   * before the transaction, it would be a check on a row read earlier — and a
   * quarantine landing in that window would not stop the restore from putting the
   * withheld prose straight back into the live row, which is the whole reason this
   * guard exists. Reads are synchronous under better-sqlite3, so one method serves
   * both the pre-flight (fail fast) and the in-transaction (binding) call.
   */
  private assertTargetNotQuarantined(
    reader: SyncDb,
    entityType: RevisionEntityType,
    entityId: number,
  ): void {
    if (entityType === 'comment') {
      const row = reader
        .select({ quarantinedAt: comments.quarantinedAt })
        .from(comments)
        .where(eq(comments.id, entityId))
        .limit(1)
        .get();
      if (row?.quarantinedAt != null) {
        // 403, matching CommentsService: the author wrote it and the placeholder
        // already tells every reader it is under review, so a 404 would buy no
        // privacy and only confuse.
        throw new ForbiddenException(
          'This comment is withheld pending moderation review; its revision history is unavailable.',
        );
      }
      return;
    }
    if (entityType === 'note') {
      const row = reader
        .select({ quarantinedAt: notes.quarantinedAt })
        .from(notes)
        .where(eq(notes.id, entityId))
        .limit(1)
        .get();
      // 404, matching NotesService.getRow: a quarantined note reads as nonexistent
      // on every path, so its history must not confirm otherwise.
      if (row?.quarantinedAt != null) throw new NotFoundException(`note ${entityId} not found`);
    }
  }

  /**
   * Pre-mutation abuse-evidence capture for a restore (issue #601). A no-op unless the
   * target is a comment or note that some unresolved report already names — the same
   * "only snapshot what is needed" bound the CommentsService/NotesService hooks apply.
   */
  private snapshotModeratedTargetTx(tx: ModerationTx, entityType: RevisionEntityType, entityId: number): void {
    if (entityType === 'comment') {
      const [row] = tx.select().from(comments).where(eq(comments.id, entityId)).limit(1).all();
      if (row) this.moderation.snapshotCommentIfWatched(tx, row, 'pre_edit');
      return;
    }
    if (entityType === 'note') {
      const [row] = tx.select().from(notes).where(eq(notes.id, entityId)).limit(1).all();
      if (row) this.moderation.snapshotNoteIfWatched(tx, row, 'pre_edit');
    }
  }

  /**
   * An entity's superseded versions, newest-first. Omits the live tip (replacedAt
   * null) — history is prior canon, not the current editor buffer.
   */
  async listForEntity(entityType: RevisionEntityType, entityId: number): Promise<EntityRevision[]> {
    this.assertTargetNotQuarantined(this.db, entityType, entityId);
    const rows = await this.db
      .select()
      .from(entityRevisions)
      .where(and(eq(entityRevisions.entityType, entityType), eq(entityRevisions.entityId, entityId)))
      .orderBy(desc(entityRevisions.id));
    return rows.filter((r) => r.replacedAt != null).map((r) => this.toDomain(r));
  }

  /**
   * Every revision row for a campaign (including live tips) — used by export/import (#813).
   *
   * Issue #601: revisions belonging to a QUARANTINED comment or note are omitted.
   * Unlike listForEntity this path takes no entity id to guard, and it is what the
   * campaign export ships — both the JSON payload and the per-revision markdown files
   * in the ZIP. Because a live tip's snapshot holds the entity's CURRENT prose, an
   * unfiltered export would carry the exact body the quarantine withholds, verbatim,
   * for any comment or note that had ever been edited. Dropping the rows rather than
   * blanking them keeps the export a faithful record of what is readable.
   */
  async listForCampaign(campaignId: number): Promise<EntityRevision[]> {
    const [rows, quarantinedComments, quarantinedNotes] = await Promise.all([
      this.db
        .select()
        .from(entityRevisions)
        .where(eq(entityRevisions.campaignId, campaignId))
        .orderBy(asc(entityRevisions.id)),
      this.db
        .select({ id: comments.id })
        .from(comments)
        .where(and(eq(comments.campaignId, campaignId), isNotNull(comments.quarantinedAt))),
      this.db
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.campaignId, campaignId), isNotNull(notes.quarantinedAt))),
    ]);
    const withheldComments = new Set(quarantinedComments.map((r) => r.id));
    const withheldNotes = new Set(quarantinedNotes.map((r) => r.id));
    return rows
      .filter(
        (r) =>
          !(r.entityType === 'comment' && withheldComments.has(r.entityId))
          && !(r.entityType === 'note' && withheldNotes.has(r.entityId)),
      )
      .map((r) => this.toDomain(r));
  }

  /** Load the current prose + campaignId + updatedAt for a target entity, or null if it's gone. */
  private loadTarget(
    db: SyncDb,
    entityType: RevisionEntityType,
    entityId: number,
  ): { campaignId: number; prose: string; updatedAt: string } | null {
    // Per-type loaders keep table/column wiring in one place when new prose entities land.
    const loaders: Record<
      RevisionEntityType,
      () => { campaignId: number; prose: string; updatedAt: string } | null
    > = {
      session: () => {
        const row = db
          .select({ campaignId: sessions.campaignId, prose: sessions.recap, updatedAt: sessions.updatedAt })
          .from(sessions)
          .where(eq(sessions.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      quest: () => {
        const row = db
          .select({ campaignId: quests.campaignId, prose: quests.body, updatedAt: quests.updatedAt })
          .from(quests)
          .where(eq(quests.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      npc: () => {
        const row = db
          .select({ campaignId: npcs.campaignId, prose: npcs.body, updatedAt: npcs.updatedAt })
          .from(npcs)
          .where(eq(npcs.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      location: () => {
        const row = db
          .select({ campaignId: locations.campaignId, prose: locations.body, updatedAt: locations.updatedAt })
          .from(locations)
          .where(eq(locations.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      faction: () => {
        const row = db
          .select({ campaignId: factions.campaignId, prose: factions.body, updatedAt: factions.updatedAt })
          .from(factions)
          .where(eq(factions.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      note: () => {
        const row = db
          .select({ campaignId: notes.campaignId, prose: notes.body, updatedAt: notes.updatedAt })
          .from(notes)
          .where(eq(notes.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      timeline_event: () => {
        const row = db
          .select({ campaignId: timelineEvents.campaignId, prose: timelineEvents.body, updatedAt: timelineEvents.updatedAt })
          .from(timelineEvents)
          .where(eq(timelineEvents.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      timeline_calendar: () => {
        const row = db
          .select({ campaignId: timelineCalendars.campaignId, prose: timelineCalendars.note, updatedAt: timelineCalendars.updatedAt })
          .from(timelineCalendars)
          .where(eq(timelineCalendars.campaignId, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      scheduled_session: () => {
        const row = db
          .select({ campaignId: scheduledSessions.campaignId, prose: scheduledSessions.notes, updatedAt: scheduledSessions.updatedAt })
          .from(scheduledSessions)
          .where(eq(scheduledSessions.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      session_zero: () => {
        const row = db
          .select({ campaignId: sessionZero.campaignId, prose: sessionZero.houseRules, updatedAt: sessionZero.updatedAt })
          .from(sessionZero)
          .where(eq(sessionZero.campaignId, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      comment: () => {
        const row = db
          .select({ campaignId: comments.campaignId, prose: comments.body, updatedAt: comments.updatedAt })
          .from(comments)
          .where(eq(comments.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
      story_beat: () => {
        const row = db
          .select({ campaignId: storyBeats.campaignId, prose: storyBeats.body, updatedAt: storyBeats.updatedAt })
          .from(storyBeats)
          .where(eq(storyBeats.id, entityId))
          .limit(1)
          .get();
        return row ?? null;
      },
    };
    return loaders[entityType]();
  }

  /**
   * A note's access-relevant fields, for the RevisionsController's per-note visibility gate
   * (notes don't share the uniform dm-only edit path of the world-building entities). A
   * trashed note (soft-deleted, #116) reads as gone — same as its normal GET — so its
   * history/restore is unreachable while it sits in the Trash. Returns null when absent.
   *
   * A QUARANTINED note (issue #601) reads as gone for the same reason and more
   * urgently: `canSee` deliberately knows nothing about quarantine, so without this
   * the generic /revisions route would hand the withheld prose back to the author,
   * the whisper recipient and every DM, and let the author restore a prior revision
   * straight into the live row — bypassing NotesService entirely.
   */
  async loadNoteAccess(
    entityId: number,
  ): Promise<{ campaignId: number; authorUserId: string; visibility: string; recipientUserId: string | null } | null> {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, entityId)).limit(1);
    if (!row || row.deletedAt != null || row.quarantinedAt != null) return null;
    return {
      campaignId: row.campaignId,
      authorUserId: row.authorUserId,
      visibility: row.visibility,
      recipientUserId: row.recipientUserId ?? null,
    };
  }

  /**
   * Write an entity's prose column back and bump updatedAt, compare-and-swapping on
   * `currentUpdatedAt` (the version read inside the current transaction — not the
   * caller's optimistic-concurrency token). Returns false when the row was
   * concurrently changed (0 rows).
   *
   * `proseChanged` says whether this write actually alters the stored prose. The
   * caller knows — it has just compared the two — and no arm can re-derive it,
   * because the CAS write is the only read-modify-write in play. Arms whose
   * entity publishes its prose OUTSIDE the app need it: a column write is not
   * automatically a published revision, and a restore-to-same must not announce
   * one. Every other arm ignores it, which is correct: their prose has no
   * external subscribers to announce anything to.
   */
  private writeProseCas(
    db: SyncDb,
    entityType: RevisionEntityType,
    entityId: number,
    prose: string,
    ts: string,
    currentUpdatedAt: string,
    proseChanged: boolean,
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
              .where(and(eq(sessions.id, entityId), eq(sessions.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'quest':
        return (
          changesOf(
            db
              .update(quests)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(quests.id, entityId), eq(quests.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'npc':
        return (
          changesOf(
            db
              .update(npcs)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(npcs.id, entityId), eq(npcs.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'location':
        return (
          changesOf(
            db
              .update(locations)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(locations.id, entityId), eq(locations.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'faction':
        return (
          changesOf(
            db
              .update(factions)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(factions.id, entityId), eq(factions.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'note':
        return (
          changesOf(
            db
              .update(notes)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(notes.id, entityId), eq(notes.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'timeline_event':
        return (
          changesOf(
            db
              .update(timelineEvents)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(timelineEvents.id, entityId), eq(timelineEvents.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'timeline_calendar':
        return (
          changesOf(
            db
              .update(timelineCalendars)
              .set({ note: prose, updatedAt: ts })
              .where(and(eq(timelineCalendars.campaignId, entityId), eq(timelineCalendars.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'scheduled_session':
        // #588 coupled this arm to a PUBLISHED artifact: a scheduled session's
        // `notes` is emitted as the VEVENT DESCRIPTION in the ICS feed, so
        // restoring an older revision changes what subscribers should see. RFC
        // 5545 §3.8.7.4 lets a client ignore a revision that does not carry a
        // higher SEQUENCE, so without this bump a calendar app kept showing the
        // pre-restore description indefinitely — LAST-MODIFIED alone only moved
        // the lenient clients. Bumped in the SAME statement as the write, under
        // the same CAS predicate, so a restore can never publish content without
        // the sequence that makes it visible, nor a sequence without content.
        //
        // Read-modify-write in SQL rather than `existing.icsSequence + 1`: this
        // method never read the row, and re-reading it here would reintroduce
        // the gap the CAS exists to close.
        //
        // Guarded on a real change for the rule stated in SchedulingService.update
        // and in the series fan-out: a no-op must not push a fresh SEQUENCE to
        // every subscriber. Restoring the revision that is already live is a
        // no-op by definition.
        return (
          changesOf(
            db
              .update(scheduledSessions)
              .set({
                notes: prose,
                updatedAt: ts,
                ...(proseChanged ? { icsSequence: sql`${scheduledSessions.icsSequence} + 1` } : {}),
              })
              .where(and(eq(scheduledSessions.id, entityId), eq(scheduledSessions.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'comment':
        return (
          changesOf(
            db
              .update(comments)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(comments.id, entityId), eq(comments.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'story_beat':
        return (
          changesOf(
            db
              .update(storyBeats)
              .set({ body: prose, updatedAt: ts })
              .where(and(eq(storyBeats.id, entityId), eq(storyBeats.updatedAt, currentUpdatedAt)))
              .run(),
          ) > 0
        );
      case 'session_zero':
        return false;
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
    // Issue #601 — restoring a pre-quarantine revision would put the withheld prose
    // straight back into the live row. See assertTargetNotQuarantined. This is the
    // fail-fast pre-flight; the binding check is the identical call inside the write
    // transaction below, against the row the prose write actually touches.
    this.assertTargetNotQuarantined(this.db, entityType, entityId);
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
      if (entityType === 'session_zero') {
        const current = tx
          .select()
          .from(sessionZero)
          .where(eq(sessionZero.campaignId, entityId))
          .limit(1)
          .get();
        if (!current) throw new NotFoundException(`session_zero ${entityId} not found`);
        this.assertNotStale(current, opts?.expectedUpdatedAt);
        const structured = fromJsonText<Record<string, unknown>>(revision.snapshot, {});
        const currentSnapshot = {
          lines: fromJsonText<string[]>(current.lines, []),
          veils: fromJsonText<string[]>(current.veils, []),
          safetyTools: fromJsonText<string[]>(current.safetyTools, []),
          houseRules: current.houseRules,
          toneAndExpectations: current.toneAndExpectations,
        };
        const restoredSnapshot = {
          lines: Array.isArray(structured.lines) ? structured.lines.filter((value): value is string => typeof value === 'string') : [],
          veils: Array.isArray(structured.veils) ? structured.veils.filter((value): value is string => typeof value === 'string') : [],
          safetyTools: Array.isArray(structured.safetyTools)
            ? structured.safetyTools.filter((value): value is string => typeof value === 'string')
            : [],
          houseRules: typeof structured.houseRules === 'string' ? structured.houseRules : '',
          toneAndExpectations: typeof structured.toneAndExpectations === 'string' ? structured.toneAndExpectations : '',
        };
        if (JSON.stringify(currentSnapshot) !== JSON.stringify(restoredSnapshot)) {
          const actor = revisionActorProvenance(user);
          tx.insert(entityRevisions)
            .values({
              campaignId: current.campaignId,
              entityType,
              entityId,
              snapshot: toJsonText(currentSnapshot),
              authorUserId: actor.userId,
              authorName: actor.name,
              authorSource: actor.source,
              authorSourceDetail: actor.sourceDetail,
              createdAt: ts,
              replacedByUserId: actor.userId,
              replacedByName: actor.name,
              replacedBySource: actor.source,
              replacedBySourceDetail: actor.sourceDetail,
              replacedAt: ts,
              restoredFromRevisionId: null,
              authorshipKnown: true,
            })
            .run();
        }
        const nextUpdated = nextUpdatedAt(current.updatedAt);
        const changed =
          tx
            .update(sessionZero)
            .set({
              lines: toJsonText(restoredSnapshot.lines),
              veils: toJsonText(restoredSnapshot.veils),
              safetyTools: toJsonText(restoredSnapshot.safetyTools),
              houseRules: restoredSnapshot.houseRules,
              toneAndExpectations: restoredSnapshot.toneAndExpectations,
              updatedAt: nextUpdated,
            })
            .where(and(eq(sessionZero.campaignId, entityId), eq(sessionZero.updatedAt, current.updatedAt)))
            .run().changes ?? 0;
        if (changed === 0) {
          throw new ConflictException({
            code: 'STALE_WRITE',
            message:
              'This was changed by someone else since you loaded it — restoring now would erase their edit. ' +
              'Reload to get the latest version, then restore again.',
            expectedUpdatedAt: current.updatedAt,
            currentUpdatedAt: tx.select().from(sessionZero).where(eq(sessionZero.campaignId, entityId)).limit(1).get()?.updatedAt ?? current.updatedAt,
          });
        }
        tx.insert(auditLog)
          .values({
            campaignId: current.campaignId,
            actor: auditActor(user),
            actorRole: role,
            action: `${entityType}.revision.restore`,
            entityType,
            entityId,
            detail: JSON.stringify({ restoredFromRevisionId: revisionId }),
            createdAt: nextUpdated,
          })
          .run();
        return;
      }

      const target = this.loadTarget(tx, entityType, entityId);
      if (!target) throw new NotFoundException(`${entityType} ${entityId} not found`);
      // Issue #601 — the binding quarantine check: same gate as the pre-flight above,
      // but reading inside this transaction so a quarantine that landed in between
      // still stops the restore rather than merely preceding it. Throwing here rolls
      // the whole restore back, evidence snapshot included.
      this.assertTargetNotQuarantined(tx, entityType, entityId);
      this.assertNotStale(target, opts?.expectedUpdatedAt);

      // Issue #601 — a restore REWRITES the live prose, so for a comment or note it is
      // a mutation like any other and must trip the same pre-mutation evidence hook.
      // Without this, restore is the one edit path that escapes it: CommentsService and
      // NotesService capture on update/remove, but a restore reaches writeProseCas
      // through this service without passing through either. That would leave a hole in
      // the guarantee snapshotCommentIfWatched states plainly — that once an incident is
      // open, no further mutation of its subject goes unrecorded. Captured inside this
      // same synchronous transaction, so it carries the identical race guarantee.
      this.snapshotModeratedTargetTx(tx, entityType, entityId);

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

      // CAS baseline is the in-tx read (`target.updatedAt`), not the caller's token —
      // assertNotStale already validated opts.expectedUpdatedAt against that baseline.
      const casBaseline = target.updatedAt;
      if (!this.writeProseCas(tx, entityType, entityId, restoredProse, ts, casBaseline, target.prose !== restoredProse)) {
        // Row moved between the in-tx read and the CAS write (should be rare under
        // better-sqlite3's write lock); surface the same STALE_WRITE shape as PATCH.
        throw new ConflictException({
          code: 'STALE_WRITE',
          message:
            'This was changed by someone else since you loaded it — restoring now would erase their edit. ' +
            'Reload to get the latest version, then restore again.',
          expectedUpdatedAt: casBaseline,
          currentUpdatedAt: this.loadTarget(tx, entityType, entityId)?.updatedAt ?? casBaseline,
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

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { CommentCreate, CommentUpdate, EntityType } from '@campfire/schema';
import type { Comment, Role, PageParams } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns, characters, comments, encounters, factions, locations, npcs, quests, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { historicalAvatarAttachmentId, safeHistoricalAvatarUrl } from '../../common/avatar-url';
import { notDeleted } from '../../common/soft-delete';
import { isVisibleTo } from '../../common/redact';
import { applyPage } from '../../common/pagination';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, excerpt } from '../notifications/notifications.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type CommentCreateInput = z.infer<typeof CommentCreate>;
type CommentUpdateInput = z.infer<typeof CommentUpdate>;
type EntityTypeValue = z.infer<typeof EntityType>;

/**
 * Body shown in place of the real content for a tombstoned comment (issue #503).
 * Neutral copy: doesn't name the author or the moderator by design (a reader who
 * already saw the body shouldn't learn who yanked it from the placeholder alone;
 * the audit log and the author themselves already know). Replies stay visible.
 */
const TOMBSTONE_BODY = '[deleted]';

/**
 * Map a DB row to the API shape. A tombstoned comment (deletedAt set) keeps its
 * id/parent/author metadata and threading position but has its body redacted to a
 * neutral placeholder — so the row stays in list/get responses (replies anchor to
 * it via parentId) without leaking the original prose. updatedAt is NOT bumped on
 * tombstone (it records content edits, not lifecycle), so the placeholder sits at
 * the original timestamp.
 */
function toDomain(row: typeof comments.$inferSelect): Comment {
  const tombstoned = row.deletedAt != null;
  return {
    id: row.id,
    campaignId: row.campaignId,
    entityType: row.entityType as EntityTypeValue,
    entityId: row.entityId,
    parentId: row.parentId,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    body: tombstoned ? TOMBSTONE_BODY : row.body,
    inCharacter: row.inCharacter,
    characterId: row.characterId,
    characterName: row.characterName,
    characterAvatarUrl: row.characterAvatarUrl,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    // Editor provenance (issue #783): null on a comment only ever self-edited;
    // stamped ONLY when a non-author (a DM moderating) rewrote the body, so the
    // UI can honestly render "edited by DM Y" without overwriting the author.
    editedAt: row.editedAt,
    editedBy: row.editedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Threaded discussion layer (issue #123). Comments are the shared, cross-session
 * surface notes never were: every comment anchors to a campaign entity and — once
 * you can SEE that entity — is visible to ALL campaign members (no per-comment
 * visibility). One level of threading via `parentId`. Author-or-DM may edit/delete.
 *
 * A thread is only as secret as the entity it hangs off (issue #230, re: #123): a
 * comment on a HIDDEN quest/npc/faction (or an unexplored location) would otherwise
 * leak that the secret entity exists — and its discussion — to any member who lists
 * by (entityType, entityId). So every read/write path first resolves the anchored
 * entity and applies the entity's OWN visibility rule (issue #42), 404-ing exactly
 * as the entity's own GET does. See `assertAnchorVisible`.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Anchored-entity secrecy gate (issue #230). Before listing/posting on
   * (entityType, entityId) — and before editing/deleting a comment anchored to one —
   * the caller must be able to SEE that entity. We resolve it within THIS campaign and
   * apply the SAME rule the entity's own GET uses (issue #42): a hidden quest/npc/
   * faction or an unexplored location is 404 for a non-DM, indistinguishable from a
   * nonexistent one — so a thread can never leak that a secret entity exists (or expose
   * its comments). Types with no entity-level secrecy (session, character, campaign,
   * encounter) are visible to any member; a nonexistent, trashed, or foreign-campaign
   * anchor 404s for everyone (a comment can only hang off a live entity in its own
   * campaign). The 404 message is uniform so a hidden entity is byte-for-byte a missing one.
   */
  /**
   * Boolean form of {@link assertAnchorVisible} used by campaign-wide reads
   * (search). Returns false where assert would 404, so a hidden-entity thread is
   * silently dropped from an aggregate list instead of throwing.
   */
  private async isAnchorVisible(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    role: Role,
  ): Promise<boolean> {
    try {
      await this.assertAnchorVisible(campaignId, entityType, entityId, role);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every comment in the campaign the caller may SEE — flattened across all
   * threads — for campaign-wide search (issue #265). A comment inherits its
   * anchor entity's visibility (issue #230): comments on a hidden quest/npc/
   * faction or an unexplored location are dropped for non-DM, so search can never
   * leak a secret entity's discussion. Anchor visibility is resolved once per
   * distinct (entityType, entityId) to keep this a bounded number of checks.
   */
  async listForCampaign(campaignId: number, role: Role): Promise<Comment[]> {
    const rows = await this.db
      .select()
      .from(comments)
      .where(eq(comments.campaignId, campaignId))
      .orderBy(asc(comments.id));
    const visibleAnchor = new Map<string, boolean>();
    const out: Comment[] = [];
    for (const row of rows) {
      const entityType = row.entityType as EntityTypeValue;
      const key = `${entityType}:${row.entityId}`;
      let visible = visibleAnchor.get(key);
      if (visible === undefined) {
        visible = await this.isAnchorVisible(campaignId, entityType, row.entityId, role);
        visibleAnchor.set(key, visible);
      }
      if (visible) out.push(toDomain(row));
    }
    return out;
  }

  private async assertAnchorVisible(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    role: Role,
  ): Promise<void> {
    const notFound = () => new NotFoundException(`${entityType} ${entityId} not found`);
    switch (entityType) {
      case 'quest': {
        const [row] = await this.db
          .select({ hidden: quests.hidden })
          .from(quests)
          .where(and(eq(quests.id, entityId), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)))
          .limit(1);
        if (!row || !isVisibleTo(row, role)) throw notFound();
        return;
      }
      case 'npc': {
        const [row] = await this.db
          .select({ hidden: npcs.hidden })
          .from(npcs)
          .where(and(eq(npcs.id, entityId), eq(npcs.campaignId, campaignId), notDeleted(npcs.deletedAt)))
          .limit(1);
        if (!row || !isVisibleTo(row, role)) throw notFound();
        return;
      }
      case 'faction': {
        const [row] = await this.db
          .select({ hidden: factions.hidden })
          .from(factions)
          .where(and(eq(factions.id, entityId), eq(factions.campaignId, campaignId)))
          .limit(1);
        if (!row || !isVisibleTo(row, role)) throw notFound();
        return;
      }
      case 'location': {
        const [row] = await this.db
          .select({ status: locations.status })
          .from(locations)
          .where(and(eq(locations.id, entityId), eq(locations.campaignId, campaignId), notDeleted(locations.deletedAt)))
          .limit(1);
        // Unexplored → hidden from non-DM (mirrors LocationsService.isHiddenFrom, issue #42).
        if (!row || (role !== 'dm' && row.status === 'unexplored')) throw notFound();
        return;
      }
      case 'session': {
        const [row] = await this.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.id, entityId), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
          .limit(1);
        if (!row) throw notFound();
        return;
      }
      case 'character': {
        const [row] = await this.db
          .select({ id: characters.id })
          .from(characters)
          .where(and(eq(characters.id, entityId), eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)))
          .limit(1);
        if (!row) throw notFound();
        return;
      }
      case 'encounter': {
        const [row] = await this.db
          .select({ id: encounters.id })
          .from(encounters)
          .where(and(eq(encounters.id, entityId), eq(encounters.campaignId, campaignId)))
          .limit(1);
        if (!row) throw notFound();
        return;
      }
      case 'campaign': {
        // A comment can only anchor to its OWN campaign; a foreign campaign id 404s.
        if (entityId !== campaignId) throw notFound();
        const [row] = await this.db
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(and(eq(campaigns.id, campaignId), notDeleted(campaigns.deletedAt)))
          .limit(1);
        if (!row) throw notFound();
        return;
      }
    }
  }

  /**
   * List a thread: every comment on one (entityType, entityId) within the
   * campaign, oldest-first (id asc) so replies read naturally under their
   * parent. Threading is reconstructed on the client from parentId; the server
   * returns the flat, chronologically-ordered set.
   */
  async listForEntity(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    role: Role,
    page?: PageParams,
  ): Promise<Comment[]> {
    // A non-DM must not even learn a hidden entity's thread exists (issue #230).
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    let query = this.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.campaignId, campaignId),
          eq(comments.entityType, entityType),
          eq(comments.entityId, entityId),
        ),
      )
      .orderBy(asc(comments.id))
      .$dynamic();
    query = applyPage(query, page);
    const rows = await query;
    return rows.map(toDomain);
  }

  async getRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(comments).where(eq(comments.id, id)).limit(1);
    // A tombstoned comment reads as nonexistent to normal callers. Callers that
    // intentionally operate on the tombstoned row pass includeDeleted=true:
    // getOrThrow (serves the [deleted] placeholder so replies' parent resolves),
    // remove/restore (operate on the tombstone), and resolveParent (a reply to a
    // tombstoned root must still anchor — the thread topology is the whole point
    // of preserving the row). 404 (not 403) mirrors the secrecy convention so a
    // non-author learns nothing about a removed comment.
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Comment ${id} not found`);
    return row;
  }

  /**
   * GET by id 404s (not 403) for a comment on an entity the caller can't see (issue #230).
   * A tombstoned comment is served to everyone who can see the anchor entity (as a
   * redacted placeholder) — it must stay reachable so replies' parent pointer
   * resolves and the thread doesn't break. GET /comments/:id on a tombstoned root
   * therefore returns the placeholder rather than 404.
   */
  async getOrThrow(id: number, role: Role): Promise<Comment> {
    const row = await this.getRowOrThrow(id, true);
    await this.assertAnchorVisible(row.campaignId, row.entityType as EntityTypeValue, row.entityId, role);
    return toDomain(row);
  }

  /**
   * A reply's parent must be a real comment on the SAME entity in the SAME
   * campaign — this both keeps threads coherent and stops a parentId from
   * pointing across campaigns. Only one level of nesting is meaningful, so a
   * reply-to-a-reply re-anchors to the top-level ancestor.
   */
  private async resolveParent(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    parentId: number,
  ): Promise<number> {
    // A reply may anchor to a tombstoned root — that is the entire point of
    // tombstoning rather than hard-deleting (issue #503): the row stays so
    // replies keep their parent. So resolve the parent with includeDeleted=true;
    // the web UI still threads replies under a [deleted] placeholder.
    const parent = await this.getRowOrThrow(parentId, true);
    if (
      parent.campaignId !== campaignId ||
      parent.entityType !== entityType ||
      parent.entityId !== entityId
    ) {
      throw new BadRequestException('parentId must reference a comment on the same entity');
    }
    return parent.parentId ?? parent.id;
  }

  /**
   * Resolve and snapshot an in-character speaker. The selected character must be
   * live, belong to this campaign, and be owned by the authenticated account — DM
   * status never grants impersonation rights. Missing/cross-campaign/removed ids
   * share a 404 so the request cannot probe another campaign's roster; a visible
   * but differently-owned character is a 403.
   *
   * The returned name/avatar are copied once and never recomputed. Attachment
   * portraits are retained only when they resolve to a visible portrait in this
   * campaign; remote portraits must pass the HTTPS-only sanitizer.
   */
  private async resolveCharacterAttribution(
    campaignId: number,
    input: CommentCreateInput,
    user: RequestUser,
  ): Promise<{ characterId: number | null; characterName: string | null; characterAvatarUrl: string | null }> {
    if (!input.inCharacter) {
      if (input.characterId != null) {
        throw new BadRequestException('characterId may only be supplied for an in-character comment');
      }
      return { characterId: null, characterName: null, characterAvatarUrl: null };
    }
    if (input.characterId == null) {
      throw new BadRequestException('characterId is required for an in-character comment');
    }

    const [character] = await this.db
      .select({
        id: characters.id,
        ownerUserId: characters.ownerUserId,
        name: characters.name,
        portraitUrl: characters.portraitUrl,
      })
      .from(characters)
      .where(
        and(
          eq(characters.id, input.characterId),
          eq(characters.campaignId, campaignId),
          notDeleted(characters.deletedAt),
        ),
      )
      .limit(1);
    if (!character) throw new NotFoundException(`Character ${input.characterId} not found`);
    if (character.ownerUserId !== user.id) {
      throw new ForbiddenException('You may only post in character as a character you own');
    }

    const label = (character.name.trim() || `Character ${character.id}`).slice(0, 120);
    let avatarUrl = safeHistoricalAvatarUrl(character.portraitUrl);
    const attachmentId = avatarUrl ? historicalAvatarAttachmentId(avatarUrl) : null;
    if (attachmentId != null) {
      const [attachment] = await this.db
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          and(
            eq(attachments.id, attachmentId),
            eq(attachments.campaignId, campaignId),
            eq(attachments.kind, 'portrait'),
            eq(attachments.hidden, false),
          ),
        )
        .limit(1);
      if (!attachment) avatarUrl = null;
    }

    return { characterId: character.id, characterName: label, characterAvatarUrl: avatarUrl };
  }

  async create(campaignId: number, input: CommentCreateInput, user: RequestUser, role: Role): Promise<Comment> {
    const entityType = input.entityType as EntityTypeValue;
    const entityId = input.entityId;
    // Can't post on a thread you can't see — hidden/secret entities 404 (issue #230).
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    let parentId: number | null = null;
    if (input.parentId != null) {
      parentId = await this.resolveParent(campaignId, entityType, entityId, input.parentId);
    }
    const attribution = await this.resolveCharacterAttribution(campaignId, input, user);

    const ts = nowIso();
    const [row] = await this.db
      .insert(comments)
      .values({
        campaignId,
        entityType,
        entityId,
        parentId,
        authorUserId: user.id,
        authorName: user.name,
        body: input.body,
        inCharacter: input.inCharacter ?? false,
        ...attribution,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.create',
      entityType: 'comment',
      entityId: row.id,
      campaignId,
    });
    await this.notifyThreadParticipants(row, user);
    return toDomain(row);
  }

  /**
   * author-or-DM. A DM editing another member's comment is a moderation path we
   * still allow (issue #783), but it must NOT silently rewrite the body under the
   * original author's identity — that would forge text the player never wrote. So
   * when the editor is NOT the original author we stamp edited_at/edited_by
   * (distinct from the author of record) and record a moderator-edit audit row,
   * leaving author_user_id / author_name untouched. The UI then renders "Author: X
   * (edited by DM Y)"; a self-edit just bumps updated_at like before.
   */
  async update(id: number, input: CommentUpdateInput, user: RequestUser, role: Role): Promise<Comment> {
    const existing = await this.getRowOrThrow(id);
    // A comment on an entity the caller can no longer see is, to them, nonexistent (issue #230).
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may edit this comment');
    }
    // editor !== author is the trust-relevant case (a DM rewording a player's
    // prose). A self-edit is just an ordinary content edit — it leaves the editor
    // provenance columns untouched, the way updated_at already drives the UI's
    // generic "edited" badge.
    const moderatorEdit = existing.authorUserId !== user.id;
    if (input.inCharacter !== undefined && input.inCharacter !== existing.inCharacter) {
      throw new BadRequestException('In-character attribution is immutable after posting');
    }
    // Persona attribution is immutable, so an empty payload or an inCharacter-only
    // echo must not bump updatedAt / stamp editedAt as if the body changed.
    if (input.body === undefined) {
      throw new BadRequestException('Comment update must include a body change');
    }
    if (input.body === existing.body) {
      throw new BadRequestException('Comment update must change the body');
    }
    const ts = nowIso();
    const patch: Partial<typeof comments.$inferInsert> = { updatedAt: ts, body: input.body };
    if (moderatorEdit) {
      patch.editedAt = ts;
      patch.editedBy = auditActor(user);
    }

    const [row] = await this.db.update(comments).set(patch).where(eq(comments.id, id)).returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.update',
      entityType: 'comment',
      entityId: id,
      campaignId: existing.campaignId,
      // Lets an incident reviewer tell a self-edit from a DM-moderated rewrite:
      // the audit actor/role already show WHO, but this makes the moderator-edit
      // case greppable alongside the edited_by row provenance.
      detail: moderatorEdit ? 'moderator edit (author preserved, editor recorded)' : '',
    });
    return toDomain(row);
  }

  /**
   * author-or-DM. Tombstones the comment (issue #503): sets deleted_at + deleted_by
   * and redacts the body in responses, but does NOT remove the row — replies keep
   * their parent pointer and the thread topology stays intact. This is the safe
   * default chosen over a DM-moderated cascade: deleting a root that OTHER members
   * have replied to must never destroy their content, and the tombstone is reversible
   * via {@link restore}. The same tombstone semantics apply to a reply (uniform,
   * always-reversible lifecycle) — there is no hard-delete path through the API, so
   * an author can never accidentally destroy content that threads off their post.
   * A row is only truly removed by a campaign purge (the DB-level CASCADE).
   *
   * Idempotent on a tombstoned row: deleting an already-tombstoned comment re-stamps
   * deleted_at/deleted_by (a DM moderating after an author's soft-delete, say) but
   * does not 404 and does not touch replies.
   */
  async remove(id: number, user: RequestUser, role: Role): Promise<Comment> {
    const existing = await this.getRowOrThrow(id, true);
    // A comment on an entity the caller can no longer see is, to them, nonexistent (issue #230).
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may delete this comment');
    }
    const ts = nowIso();
    const [row] = await this.db
      .update(comments)
      .set({ deletedAt: ts, deletedBy: auditActor(user) })
      .where(eq(comments.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.delete',
      entityType: 'comment',
      entityId: id,
      campaignId: existing.campaignId,
      detail: 'soft-delete (tombstoned; replies preserved)',
    });
    // Tell anyone who replied to this root that the context above them changed, so
    // their reply doesn't read as a non-sequitur under a now-redacted parent.
    await this.notifyTombstone(existing, user);
    // Return the tombstoned comment (redacted to a [deleted] placeholder by
    // toDomain) so the endpoint is self-describing and matches its OpenAPI shape;
    // clients don't need a follow-up GET to see the deletion took effect.
    return toDomain(row);
  }

  /**
   * Undo a tombstone (issue #503). Author or DM; clears deleted_at/deleted_by and
   * returns the comment with its original body. 404 if the comment isn't currently
   * tombstoned. Mirrors the notes restore() authorization (author or DM) so a DM
   * can reverse a moderation and the author can reverse their own soft-delete.
   */
  async restore(id: number, user: RequestUser, role: Role): Promise<Comment> {
    const existing = await this.getRowOrThrow(id, true);
    if (existing.deletedAt == null) throw new NotFoundException(`Comment ${id} is not tombstoned`);
    // A comment on an entity the caller can no longer see is, to them, nonexistent (issue #230).
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may restore this comment');
    }
    // Restore is a LIFECYCLE event, not a content edit — do not bump updatedAt.
    // The web UI shows an "edited" badge when updatedAt !== createdAt, so bumping
    // here would falsely mark a restored comment as edited. Provenance of the
    // tombstone (who deleted it, when) is preserved in the audit log, not on the
    // row (deletedAt/deletedBy are cleared so the comment reads as live again).
    const [row] = await this.db
      .update(comments)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(comments.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.restore',
      entityType: 'comment',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return toDomain(row);
  }

  /**
   * Fan-out on a new comment: notify every OTHER member who has already posted
   * on the same entity thread (the people following this discussion), plus the
   * author of the parent comment when this is a reply. Best-effort, like every
   * other notify* emitter — a notification failure never fails the post.
   */
  private async notifyThreadParticipants(row: typeof comments.$inferSelect, user: RequestUser): Promise<void> {
    const siblings = await this.db
      .select({ authorUserId: comments.authorUserId })
      .from(comments)
      .where(
        and(
          eq(comments.campaignId, row.campaignId),
          eq(comments.entityType, row.entityType),
          eq(comments.entityId, row.entityId),
        ),
      );
    const recipients = new Set<number>();
    for (const sibling of siblings) {
      const authorId = Number(sibling.authorUserId);
      if (Number.isInteger(authorId) && authorId > 0 && String(authorId) !== user.id) {
        recipients.add(authorId);
      }
    }
    for (const recipient of recipients) {
      await this.notifications.notifyUser(recipient, row.campaignId, user, {
        type: 'comment_reply',
        title: `${user.name || 'Someone'} posted on a ${row.entityType} discussion`,
        body: excerpt(row.body),
        entityType: row.entityType as EntityTypeValue,
        entityId: row.entityId,
        actorName: user.name,
      });
    }
  }

  /**
   * Fan-out when a root is tombstoned (issue #503): the AUTHORS of its direct
   * replies are told the comment above theirs was deleted, so their reply doesn't
   * silently sit under a redacted placeholder with no explanation. Only a ROOT
   * deletion changes the context of replies (a reply deletion has no children), so
   * this is a no-op for reply deletions. The tombstoned comment's own author is the
   * actor and is skipped (they pulled the trigger; they don't need a notification).
   * Best-effort — a notification failure never fails the delete.
   *
   * Reuses the `comment_reply` notification type (rather than introducing a new
   * enum value) so this stays additive and doesn't churn the NotificationType
   * schema; the title/body copy distinguishes a tombstone from a new reply.
   */
  private async notifyTombstone(row: typeof comments.$inferSelect, user: RequestUser): Promise<void> {
    if (row.parentId !== null) return; // only a root deletion changes replies' context.
    const replies = await this.db
      .select({ authorUserId: comments.authorUserId })
      .from(comments)
      .where(
        and(
          eq(comments.parentId, row.id),
          eq(comments.campaignId, row.campaignId),
          isNull(comments.deletedAt),
          ne(comments.authorUserId, user.id),
        ),
      );
    const recipients = new Set<number>();
    for (const reply of replies) {
      const authorId = Number(reply.authorUserId);
      if (Number.isInteger(authorId) && authorId > 0) recipients.add(authorId);
    }
    for (const recipient of recipients) {
      await this.notifications.notifyUser(recipient, row.campaignId, user, {
        type: 'comment_reply',
        title: `A comment you replied to was deleted`,
        body: `The discussion on this ${row.entityType} lost its top comment; your reply is preserved.`,
        entityType: row.entityType as EntityTypeValue,
        entityId: row.entityId,
        actorName: user.name,
      });
    }
  }
}

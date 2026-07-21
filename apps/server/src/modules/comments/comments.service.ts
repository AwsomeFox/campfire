import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CommentCreate, CommentUpdate, EntityType } from '@campfire/schema';
import type { Comment, Role, PageParams } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, characters, comments, encounters, factions, locations, npcs, quests, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
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

function toDomain(row: typeof comments.$inferSelect): Comment {
  return {
    id: row.id,
    campaignId: row.campaignId,
    entityType: row.entityType as EntityTypeValue,
    entityId: row.entityId,
    parentId: row.parentId,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    body: row.body,
    inCharacter: row.inCharacter,
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

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Comment ${id} not found`);
    return row;
  }

  /** GET by id 404s (not 403) for a comment on an entity the caller can't see (issue #230). */
  async getOrThrow(id: number, role: Role): Promise<Comment> {
    const row = await this.getRowOrThrow(id);
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
    const parent = await this.getRowOrThrow(parentId);
    if (
      parent.campaignId !== campaignId ||
      parent.entityType !== entityType ||
      parent.entityId !== entityId
    ) {
      throw new BadRequestException('parentId must reference a comment on the same entity');
    }
    return parent.parentId ?? parent.id;
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

  /** author-or-DM */
  async update(id: number, input: CommentUpdateInput, user: RequestUser, role: Role): Promise<Comment> {
    const existing = await this.getRowOrThrow(id);
    // A comment on an entity the caller can no longer see is, to them, nonexistent (issue #230).
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may edit this comment');
    }
    const patch: Partial<typeof comments.$inferInsert> = { updatedAt: nowIso() };
    if (input.body !== undefined) patch.body = input.body;
    if (input.inCharacter !== undefined) patch.inCharacter = input.inCharacter;

    const [row] = await this.db.update(comments).set(patch).where(eq(comments.id, id)).returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.update',
      entityType: 'comment',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return toDomain(row);
  }

  /** author-or-DM; deleting a top-level comment cascades to its direct replies */
  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    // A comment on an entity the caller can no longer see is, to them, nonexistent (issue #230).
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may delete this comment');
    }
    await this.db.delete(comments).where(eq(comments.id, id));
    // A dangling reply (parent gone) would render orphaned; remove the subtree.
    if (existing.parentId === null) {
      await this.db.delete(comments).where(eq(comments.parentId, id));
    }
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.delete',
      entityType: 'comment',
      entityId: id,
      campaignId: existing.campaignId,
    });
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
}

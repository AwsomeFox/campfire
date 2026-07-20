import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CommentCreate, CommentUpdate, EntityType } from '@campfire/schema';
import type { Comment, Role, PageParams } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { comments } from '../../db/schema';
import { nowIso } from '../../common/time';
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
 * surface notes never were: every comment anchors to a campaign entity and is
 * visible to ALL campaign members (no per-comment visibility). One level of
 * threading via `parentId`. Author-or-DM may edit/delete.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

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
    page?: PageParams,
  ): Promise<Comment[]> {
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

  async getOrThrow(id: number): Promise<Comment> {
    return toDomain(await this.getRowOrThrow(id));
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

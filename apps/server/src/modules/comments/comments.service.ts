import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { CommentCreate, CommentUpdate, EntityType } from '@campfire/schema';
import type { Comment, CommentReplyPage, CommentThread, CommentThreadPage, Role, PageParams } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, characters, comments, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { historicalAvatarAttachmentId, safeHistoricalAvatarUrl } from '../../common/avatar-url';
import { notDeleted } from '../../common/soft-delete';
import { applyPage } from '../../common/pagination';
import {
  clampCommentsReplyLimit,
  clampCommentsThreadLimit,
  decodeCommentsReplyCursor,
  decodeCommentsRootCursor,
  encodeCommentsCursor,
} from './comments-pagination';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, excerpt } from '../notifications/notifications.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { nextUpdatedAt, staleWrite } from '../../common/stale-write';
import { RevisionsService } from '../revisions/revisions.service';
import { assertAnchorVisible as assertAnchorVisibleShared } from '../../common/anchor-visibility';
import { assertMayInteract } from '../../common/interactive-capability';
import { ModerationService, QUARANTINE_BODY } from '../moderation/moderation.service';

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
 *
 * Moderation quarantine (issue #601) redacts the same way, with a DIFFERENT
 * placeholder and a higher precedence: a quarantined comment reads as withheld for
 * EVERY caller — its author, and the DM who quarantined it, included. There is no
 * role that reads the original prose back through this function; the only path to
 * it is the separately-gated, always-audited evidence endpoint. This function is
 * the single chokepoint every comment read path funnels through, which is what
 * makes "quarantine actually withholds the content" enforceable in one place
 * rather than at each of a dozen call sites.
 */
function toDomain(row: typeof comments.$inferSelect): Comment {
  const base = toDomainRaw(row);
  // Quarantine takes precedence over the tombstone placeholder: if a comment is
  // both removed and under review, "withheld pending moderation review" is the
  // more accurate statement of why nobody can read it.
  return row.quarantinedAt != null ? { ...base, body: QUARANTINE_BODY } : base;
}

function toDomainRaw(row: typeof comments.$inferSelect): Comment {
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
    // Moderation quarantine (issue #601). Surfaced deliberately: a reader who sees
    // a placeholder deserves to know whether the author withdrew the post or a
    // moderator withheld it. It carries no information about WHO reported it or WHY.
    quarantinedAt: row.quarantinedAt,
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
    private readonly revisions: RevisionsService,
    // Issue #601: pre-mutation abuse-evidence capture + mute enforcement. The
    // dependency runs one way (comments -> moderation); ModerationService never
    // injects this service back, which is why the anchor-visibility rule below now
    // lives in common/ where both can reach it.
    private readonly moderation: ModerationService,
  ) {}

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
  async listForCampaign(
    campaignId: number,
    role: Role,
    opts: { authorUserId?: string } = {},
  ): Promise<Comment[]> {
    const rows = await this.db
      .select()
      .from(comments)
      .where(
        opts.authorUserId
          ? and(eq(comments.campaignId, campaignId), eq(comments.authorUserId, opts.authorUserId))
          : eq(comments.campaignId, campaignId),
      )
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

  /**
   * How many comments in this campaign the caller may SEE — without loading a single
   * comment body (issue #602).
   *
   * The campaign summary wanted only `.length` of {@link listForCampaign}, which meant
   * selecting every comment row in the campaign (bodies included) and walking them in
   * JS, on a projection the dashboard re-reads on a timer. Counting is grouped per
   * anchor in SQL instead, so the work scales with the number of distinct commented
   * entities rather than with the number of comments.
   *
   * Redaction is preserved exactly, not approximated: a comment inherits its anchor
   * entity's visibility (issue #230), so each distinct anchor is resolved through the
   * SAME {@link isAnchorVisible} check the list uses, and only visible anchors
   * contribute their count. That is also the same number of visibility queries the list
   * performed — it already memoised per distinct anchor — so this removes the row scan
   * without adding round-trips.
   *
   * The predicate is `campaignId` alone, matching {@link listForCampaign} exactly. Note
   * that comments DO carry a `deletedAt` tombstone (issue #503) and neither method filters
   * on it, so a tombstoned comment still counts. That is preserved rather than endorsed:
   * it keeps `commentCount` at the number the summary already reported. If tombstones
   * should be excluded, both methods need to change together.
   */
  async countForCampaign(campaignId: number, role: Role): Promise<number> {
    const groups = await this.db
      .select({
        entityType: comments.entityType,
        entityId: comments.entityId,
        value: count(),
      })
      .from(comments)
      .where(eq(comments.campaignId, campaignId))
      .groupBy(comments.entityType, comments.entityId);

    let total = 0;
    for (const group of groups) {
      const visible = await this.isAnchorVisible(campaignId, group.entityType as EntityTypeValue, group.entityId, role);
      if (visible) total += group.value;
    }
    return total;
  }

  /**
   * Thin delegate onto the shared rule in `common/anchor-visibility.ts`. The body
   * moved there verbatim for issue #601 so the moderation module can apply the
   * IDENTICAL check when authorizing "may this reporter report this comment" —
   * reporting must never become a probe for hidden entities — without depending on
   * this service (which now depends on ModerationService). Behaviour is unchanged.
   */
  private async assertAnchorVisible(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    role: Role,
  ): Promise<void> {
    return assertAnchorVisibleShared(this.db, campaignId, entityType, entityId, role);
  }

  /**
   * List a thread: every comment on one (entityType, entityId) within the
   * campaign, oldest-first (id asc) so replies read naturally under their
   * parent. Threading is reconstructed on the client from parentId; the server
   * returns the flat, chronologically-ordered set.
   *
   * Retained for MCP / legacy offset paging — REST uses {@link listThreadsForEntity}.
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

  private entityAnchorWhere(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
  ) {
    return and(
      eq(comments.campaignId, campaignId),
      eq(comments.entityType, entityType),
      eq(comments.entityId, entityId),
    )!;
  }

  /**
   * Paginated discussion for one entity by root thread (issue #609). Each item
   * is a root comment plus a bounded oldest-first reply preview so flat row paging
   * can never orphan replies from their parent. Continue root pages with `cursor`;
   * load additional replies per root via {@link listRepliesForRoot}.
   */
  async listThreadsForEntity(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    role: Role,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CommentThreadPage> {
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    const limit = clampCommentsThreadLimit(opts.limit);
    const previewLimit = clampCommentsReplyLimit(undefined, true);
    const cursor = decodeCommentsRootCursor(opts.cursor);
    const anchor = this.entityAnchorWhere(campaignId, entityType, entityId);

    const [rootCountRow, commentCountRow] = await Promise.all([
      this.db.select({ value: count() }).from(comments).where(and(anchor, isNull(comments.parentId))),
      this.db.select({ value: count() }).from(comments).where(anchor),
    ]);
    const total = rootCountRow[0]?.value ?? 0;
    const totalComments = commentCountRow[0]?.value ?? 0;

    const rootConds = cursor ? and(anchor, isNull(comments.parentId), gt(comments.id, cursor.i)) : and(anchor, isNull(comments.parentId));
    const rootRows = await this.db
      .select()
      .from(comments)
      .where(rootConds)
      .orderBy(asc(comments.id))
      .limit(limit + 1);

    const hasMore = rootRows.length > limit;
    const pageRoots = hasMore ? rootRows.slice(0, limit) : rootRows;
    const items = await this.buildThreadPreviews(pageRoots, anchor, previewLimit);

    const lastRoot = pageRoots[pageRoots.length - 1];
    const nextCursor =
      hasMore && lastRoot ? encodeCommentsCursor({ v: 1, m: 'root', i: lastRoot.id }) : null;
    return { items, total, totalComments, hasMore, nextCursor, limit };
  }

  private async buildThreadPreviews(
    rootRows: (typeof comments.$inferSelect)[],
    anchor: ReturnType<CommentsService['entityAnchorWhere']>,
    previewLimit: number,
  ): Promise<CommentThread[]> {
    if (rootRows.length === 0) return [];
    const rootIds = rootRows.map((row) => row.id);
    const previewCap = previewLimit + 1;

    const [countRows, replyRows] = await Promise.all([
      this.db
        .select({ parentId: comments.parentId, value: count() })
        .from(comments)
        .where(and(anchor, inArray(comments.parentId, rootIds)))
        .groupBy(comments.parentId),
      this.db
        .select()
        .from(comments)
        .where(and(anchor, inArray(comments.parentId, rootIds)))
        .orderBy(asc(comments.parentId), asc(comments.id)),
    ]);

    const countByParent = new Map(countRows.map((row) => [row.parentId!, row.value]));
    const previewsByParent = new Map<number, (typeof comments.$inferSelect)[]>();
    for (const row of replyRows) {
      const parentId = row.parentId!;
      let bucket = previewsByParent.get(parentId);
      if (!bucket) {
        bucket = [];
        previewsByParent.set(parentId, bucket);
      }
      if (bucket.length < previewCap) bucket.push(row);
    }

    return rootRows.map((rootRow) => {
      const replyCount = countByParent.get(rootRow.id) ?? 0;
      const previewRows = previewsByParent.get(rootRow.id) ?? [];
      const replyHasMore = previewRows.length > previewLimit;
      const previewReplies = replyHasMore ? previewRows.slice(0, previewLimit) : previewRows;
      const lastPreview = previewReplies[previewReplies.length - 1];
      return {
        root: toDomain(rootRow),
        replies: previewReplies.map(toDomain),
        replyCount,
        replyHasMore,
        replyNextCursor:
          replyHasMore && lastPreview
            ? encodeCommentsCursor({ v: 1, m: 'reply', r: rootRow.id, i: lastPreview.id })
            : null,
      };
    });
  }

  /**
   * Additional replies for one root thread (issue #609). Oldest-first; continue
   * with `cursor` from a previous `nextCursor` / inline `replyNextCursor`.
   */
  async listRepliesForRoot(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    rootId: number,
    role: Role,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CommentReplyPage> {
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    const root = await this.getRowOrThrow(rootId, true);
    if (
      root.parentId !== null ||
      root.campaignId !== campaignId ||
      root.entityType !== entityType ||
      root.entityId !== entityId
    ) {
      throw new NotFoundException(`Comment ${rootId} not found`);
    }

    const limit = clampCommentsReplyLimit(opts.limit);
    const cursor = decodeCommentsReplyCursor(opts.cursor, rootId);
    const anchor = this.entityAnchorWhere(campaignId, entityType, entityId);
    const replyWhere = and(anchor, eq(comments.parentId, rootId));
    const pageWhere = cursor ? and(replyWhere, gt(comments.id, cursor.i)) : replyWhere;

    const [replyCountRow, fetched] = await Promise.all([
      this.db.select({ value: count() }).from(comments).where(replyWhere),
      this.db
        .select()
        .from(comments)
        .where(pageWhere)
        .orderBy(asc(comments.id))
        .limit(limit + 1),
    ]);
    const replyCount = replyCountRow[0]?.value ?? 0;
    const hasMore = fetched.length > limit;
    const pageRows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCommentsCursor({ v: 1, m: 'reply', r: rootId, i: last.id }) : null;
    return {
      rootId,
      items: pageRows.map(toDomain),
      replyCount,
      hasMore,
      nextCursor,
      limit,
    };
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
    // Issue #601: a moderation mute has to actually stop the muted member posting,
    // or the DM queue's `mute` verb is theatre. Checked before any other work so a
    // muted member's request does no writes at all.
    await this.moderation.assertNotMuted(campaignId, user);
    // Issue #597: a comment is read by everyone who can see the thread, so it needs an
    // INTERACTIVE seat — a viewer is read-only unless a DM granted the interactive-guest
    // capability. Enforced in the service rather than the controller because MCP's
    // `post_comment` tool reaches this method directly; a controller-only gate would
    // leave the agent surface wide open, which is exactly the kind of second door this
    // issue is about. Checked before the anchor-visibility probe so a read-only seat
    // cannot use the 403-vs-404 difference to test whether a secret entity exists.
    await assertMayInteract(this.db, user, campaignId, role, 'post comments');
    // Can't post on a thread you can't see — hidden/secret entities 404 (issue #230).
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    let parentId: number | null = null;
    if (input.parentId != null) {
      parentId = await this.resolveParent(campaignId, entityType, entityId, input.parentId);
    }
    const attribution = await this.resolveCharacterAttribution(campaignId, input, user);

    const ts = nowIso();
    const accountId = Number.parseInt(user.id, 10);
    const row = this.db.transaction((tx) => {
      const current = Number.isInteger(accountId)
        ? tx
            .select({ displayName: users.displayName, username: users.username })
            .from(users)
            .where(eq(users.id, accountId))
            .limit(1)
            .get()
        : undefined;
      return tx
        .insert(comments)
        .values({
          campaignId,
          entityType,
          entityId,
          parentId,
          authorUserId: user.id,
          authorName: current ? (current.displayName || current.username) : (Number.isInteger(accountId) && accountId > 0 ? 'Deleted user' : user.name),
          body: input.body,
          inCharacter: input.inCharacter ?? false,
          ...attribution,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
    });

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
  async update(
    id: number,
    input: CommentUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<Comment> {
    const existing = await this.getRowOrThrow(id);
    // A comment on an entity the caller can no longer see is, to them, nonexistent (issue #230).
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may edit this comment');
    }
    // Issue #597: an edit publishes new words to the same readers a new comment would,
    // so it needs the same interactive seat. Without this a member demoted to viewer
    // keeps a live broadcast channel through the comments they wrote earlier.
    await assertMayInteract(this.db, user, existing.campaignId, role, 'edit comments');
    this.assertNotQuarantined(existing);
    const moderatorEdit = existing.authorUserId !== user.id;
    if (input.inCharacter !== undefined && input.inCharacter !== existing.inCharacter) {
      throw new BadRequestException('In-character attribution is immutable after posting');
    }
    if (input.body === undefined) {
      throw new BadRequestException('Comment update must include a body change');
    }
    if (input.body === existing.body) {
      throw new BadRequestException('Comment update must change the body');
    }
    const ts = nextUpdatedAt(existing.updatedAt);
    const patch: Partial<typeof comments.$inferInsert> = { updatedAt: ts, body: input.body };
    if (moderatorEdit) {
      patch.editedAt = ts;
      patch.editedBy = auditActor(user);
    }

    // Issue #601: capture the pre-edit abuse-evidence snapshot INSIDE the same
    // transaction as the write, reading the row as it exists in that transaction —
    // not the `existing` row fetched above. If a snapshot were taken outside this
    // window, a concurrent delete or a second edit could land between the read and
    // the write and the evidence would record content that is not what was actually
    // overwritten. better-sqlite3 is synchronous and SQLite serializes write
    // transactions, so nothing can interleave here. The capture is a no-op unless
    // an unresolved report already names this comment (see snapshotCommentIfWatched
    // for why we do not snapshot every edit).
    //
    // Everything the write is conditional on is therefore ALSO decided in here,
    // against `current`, in this order and for these reasons:
    //
    //  1. Quarantine. `assertNotQuarantined(existing)` above runs against a row read
    //     before the transaction opened. A DM who quarantines this comment in the
    //     window between that read and this write would not actually have stopped
    //     the edit — the very race quarantine exists to win (the subject rewriting
    //     the words under an open report). Re-checked here so the gate and the write
    //     observe the same row. The pre-transaction check is kept because it fails
    //     fast, before any of the validation work above; this one is what binds.
    //  2. Staleness. Decided BEFORE the snapshot, not by letting the CAS in the
    //     WHERE clause come up empty afterwards: a rejected stale write commits no
    //     edit, so recording a `pre_edit` snapshot for it would file evidence of a
    //     mutation that never happened. Evidence is only worth having if the trail
    //     matches what the content actually did, so the capture belongs strictly on
    //     the path that commits. Throwing here also rolls the transaction back, so
    //     even a snapshot taken by some future reordering could not survive.
    const updated = this.db.transaction((tx) => {
      const [current] = tx.select().from(comments).where(eq(comments.id, id)).limit(1).all();
      if (!current) return undefined;
      this.assertNotQuarantined(current);
      if (opts?.expectedUpdatedAt && current.updatedAt !== opts.expectedUpdatedAt) {
        throw staleWrite(opts.expectedUpdatedAt, current.updatedAt);
      }
      this.moderation.snapshotCommentIfWatched(tx, current, 'pre_edit');
      const rows = tx
        .update(comments)
        .set(patch)
        .where(
          opts?.expectedUpdatedAt
            ? and(eq(comments.id, id), eq(comments.updatedAt, opts.expectedUpdatedAt))
            : eq(comments.id, id),
        )
        .returning()
        .all();
      return rows[0];
    });
    // Reached only when the row vanished entirely between the two reads (a campaign
    // purge's CASCADE): getRowOrThrow 404s. The staleWrite fallback is kept as a
    // belt-and-braces for a CAS that somehow came up empty without the in-transaction
    // check firing; it should be unreachable now that staleness is decided above.
    if (!updated) {
      const current = await this.getRowOrThrow(id);
      throw staleWrite(opts?.expectedUpdatedAt, current.updatedAt);
    }
    const row = updated;
    await this.revisions.commitProseVersion({
      entityType: 'comment',
      entityId: id,
      campaignId: existing.campaignId,
      priorProse: existing.body,
      nextProse: input.body,
      user,
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.update',
      entityType: 'comment',
      entityId: id,
      campaignId: existing.campaignId,
      detail: moderatorEdit ? 'moderator edit (author preserved, editor recorded)' : '',
    });
    return toDomain(row);
  }

  /**
   * Issue #601: a quarantined comment is frozen to its author. Reads still resolve
   * (to the placeholder), but every ordinary MUTATION is refused, for two reasons:
   *
   *  1. Editing a quarantined comment would commit its withheld body into
   *     entity_revisions (#157), where the author and any DM can read it back —
   *     quietly undoing the withholding through the revision history side door.
   *  2. A quarantine is a moderation decision about specific words. Letting the
   *     author rewrite or delete them out from under an open report turns the DM's
   *     "hold this while I review it" into "the subject controls the evidence".
   *
   * 403 rather than 404 here on purpose: unlike the secrecy 404s elsewhere in this
   * service, the author already knows the comment exists — they wrote it, and the
   * placeholder tells them it is under review. Pretending it vanished would be a
   * worse experience with no privacy gain. Only the moderation queue lifts this.
   */
  private assertNotQuarantined(row: typeof comments.$inferSelect): void {
    if (row.quarantinedAt != null) {
      throw new ForbiddenException('This comment is withheld pending moderation review and cannot be changed.');
    }
  }

  async listRevisions(id: number, user: RequestUser, role: Role) {
    const existing = await this.getRowOrThrow(id);
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may view this comment history');
    }
    return this.revisions.listForEntity('comment', id);
  }

  async restoreRevision(id: number, revisionId: number, user: RequestUser, role: Role) {
    const existing = await this.getRowOrThrow(id);
    await this.assertAnchorVisible(existing.campaignId, existing.entityType as EntityTypeValue, existing.entityId, role);
    if (existing.authorUserId !== user.id && role !== 'dm') {
      throw new ForbiddenException('Only the author or a DM may restore this comment history');
    }
    this.assertNotQuarantined(existing);
    return this.revisions.restore('comment', id, revisionId, user, role);
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
    this.assertNotQuarantined(existing);
    const ts = nowIso();
    // Issue #601: same atomic snapshot-then-mutate as update(). Deleting is the
    // sharper case — an abuser racing a victim's report must not be able to remove
    // the message between the report reading it and the report recording it. The row
    // is re-read inside the transaction and snapshotted there, so the evidence is
    // whatever the delete is about to hide, captured in the same exclusive window.
    //
    // The quarantine gate is re-applied against that same in-transaction row: the
    // `assertNotQuarantined(existing)` above read the comment before the transaction
    // opened, so on its own it would let a delete through that a DM quarantined in
    // between — handing the subject of an open report exactly the "remove the
    // evidence" move the quarantine was taken to prevent.
    const row = this.db.transaction((tx) => {
      const [current] = tx.select().from(comments).where(eq(comments.id, id)).limit(1).all();
      if (!current) throw new NotFoundException(`Comment ${id} not found`);
      this.assertNotQuarantined(current);
      this.moderation.snapshotCommentIfWatched(tx, current, 'pre_delete');
      const rows = tx
        .update(comments)
        .set({ deletedAt: ts, deletedBy: auditActor(user) })
        .where(eq(comments.id, id))
        .returning()
        .all();
      return rows[0];
    });
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
    this.assertNotQuarantined(existing);
    // Restore is a LIFECYCLE event, not a content edit — do not bump updatedAt.
    // The web UI shows an "edited" badge when updatedAt !== createdAt, so bumping
    // here would falsely mark a restored comment as edited. Provenance of the
    // tombstone (who deleted it, when) is preserved in the audit log, not on the
    // row (deletedAt/deletedBy are cleared so the comment reads as live again).
    //
    // Issue #601: the gate and the write share one transaction, for the same reason
    // as update()/remove(). Restore is the one that would hurt most if it slipped —
    // it puts a withheld comment back into everyone's view, so a quarantine landing
    // between the pre-read above and this write would be undone by the very request
    // it was meant to stop. Both the tombstone precondition and the quarantine check
    // are re-decided here against the row the write will actually touch.
    const row = this.db.transaction((tx) => {
      const [current] = tx.select().from(comments).where(eq(comments.id, id)).limit(1).all();
      if (!current) throw new NotFoundException(`Comment ${id} not found`);
      if (current.deletedAt == null) throw new NotFoundException(`Comment ${id} is not tombstoned`);
      this.assertNotQuarantined(current);
      const rows = tx
        .update(comments)
        .set({ deletedAt: null, deletedBy: null })
        .where(eq(comments.id, id))
        .returning()
        .all();
      return rows[0];
    });
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
        commentId: row.id,
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
        commentId: row.id,
        actorName: user.name,
      });
    }
  }
}

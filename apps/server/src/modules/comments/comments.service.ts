import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, max, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { CommentCreate, CommentUpdate, EntityType } from '@campfire/schema';
import type {
  Comment,
  CommentInboxItem,
  CommentInboxPage,
  CommentReplyPage,
  CommentThread,
  CommentThreadPage,
  CommentThreadState,
  CommentUnreadSummary,
  CommentUnreadSummaryEntry,
  Role,
  PageParams,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  attachments,
  campaignMembers,
  campaigns,
  characters,
  commentThreadState,
  comments,
  factions,
  locations,
  npcs,
  quests,
  sessionAttendees,
  sessions,
  users,
} from '../../db/schema';
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

/** A drizzle handle usable for writes — either the top-level db or a transaction tx. */
type WriteDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

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
    await this.afterCommentCreated(row, user);
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
   * Fan-out + auto-subscription on a new comment (issue #829). Replaces the pre-#829
   * recipient rule ("everyone who already posted on this thread"): the recipient set
   * is now the thread's explicit WATCHERS, which the auto-subscribe rules populate.
   *
   *   1. The author/replier is auto-subscribed (`watching`) — they are now following
   *      the discussion.
   *   2. On a thread's FIRST post, the intended audience is auto-subscribed too: a
   *      `session` thread reaches that session's attendees (their character owners)
   *      plus the campaign's facilitators (DMs); any other anchor reaches the
   *      facilitators. This is a deliberately bounded set — never a campaign
   *      broadcast — and is exactly the audience the pre-#829 rule could not reach
   *      (a brand-new thread had zero prior authors).
   *   3. Fan-out then notifies every WATCHING, non-muted member of the thread
   *      (minus the author, minus anyone who can no longer SEE the anchor, minus
   *      anyone who blocked the actor — the block filter runs in dispatch). A mute
   *      wins over a watch at this step, never at the subscribe step, so un-muting
   *      restores notification without re-subscribing.
   *
   * Best-effort, like every other notify* emitter — a notification failure never
   * fails the post. Subscriptions are written synchronously here (cheap upserts on
   * the unique per-user-anchor index) so the watching set is current before fan-out.
   */
  private async afterCommentCreated(row: typeof comments.$inferSelect, user: RequestUser): Promise<void> {
    const entityType = row.entityType as EntityTypeValue;
    const authorId = Number(row.authorUserId);
    const authorNumeric = Number.isInteger(authorId) && authorId > 0 ? authorId : null;

    // (1) Auto-subscribe the author. Dev/PAT authors (non-numeric ids) have no users
    // row and cannot hold thread state, matching the numeric-recipient fan-out rule.
    if (authorNumeric !== null) {
      this.upsertWatching(this.db, row.campaignId, authorNumeric, entityType, row.entityId);
    }

    // (2) First post? The anchor had no comments before this one, so the thread's
    // intended audience has not been subscribed yet.
    const priorRow = await this.db
      .select({ value: count() })
      .from(comments)
      .where(
        and(
          eq(comments.campaignId, row.campaignId),
          eq(comments.entityType, row.entityType),
          eq(comments.entityId, row.entityId),
          ne(comments.id, row.id),
        ),
      );
    const isFirstPost = (priorRow[0]?.value ?? 0) === 0;
    if (isFirstPost) {
      const audience = await this.computeFirstPostAudience(row.campaignId, entityType, row.entityId, authorNumeric);
      for (const audienceUserId of audience) {
        this.upsertWatching(this.db, row.campaignId, audienceUserId, entityType, row.entityId);
      }
    }

    // (3) Fan out to watchers.
    await this.notifyWatchers(row, user, authorNumeric);
  }

  /**
   * Idempotent upsert of a `watching` thread-state row. On conflict it only sets
   * `watching = true` and bumps `updated_at` — it never touches `muted` (a member's
   * explicit mute is honored at fan-out, not silently cleared by an auto-subscribe)
   * and never moves `last_read_comment_id` backward. Safe to call on either the
   * top-level handle or a transaction `tx` (the comment write path is not itself
   * transactional with this upsert, but the signature accepts both for symmetry).
   */
  private upsertWatching(
    db: WriteDb,
    campaignId: number,
    userId: number,
    entityType: EntityTypeValue,
    entityId: number,
  ): void {
    const ts = nowIso();
    db.insert(commentThreadState)
      .values({
        campaignId,
        userId,
        entityType,
        entityId,
        watching: true,
        muted: false,
        lastReadCommentId: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [
          commentThreadState.userId,
          commentThreadState.campaignId,
          commentThreadState.entityType,
          commentThreadState.entityId,
        ],
        set: { watching: true, updatedAt: ts },
      })
      .run();
  }

  /**
   * The bounded audience for a thread's first post (issue #829): session attendees
   * (their character owners) plus facilitators (DMs) for a `session` anchor, just
   * facilitators for any other anchor. Numeric user ids only; the author is excluded
   * (they get no notification for their own post).
   */
  private async computeFirstPostAudience(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    excludeUserId: number | null,
  ): Promise<number[]> {
    const audience = new Set<number>();
    if (entityType === 'session') {
      const attendees = await this.db
        .select({ ownerUserId: characters.ownerUserId })
        .from(sessionAttendees)
        .innerJoin(characters, eq(characters.id, sessionAttendees.characterId))
        .where(
          and(
            eq(sessionAttendees.sessionId, entityId),
            eq(characters.campaignId, campaignId),
            notDeleted(characters.deletedAt),
          ),
        );
      for (const a of attendees) {
        const owner = Number(a.ownerUserId);
        if (Number.isInteger(owner) && owner > 0) audience.add(owner);
      }
    }
    // Facilitators (DMs) oversee every thread in their campaign.
    const dms = await this.db
      .select({ userId: campaignMembers.userId })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, 'dm')));
    for (const d of dms) audience.add(d.userId);
    if (excludeUserId !== null) audience.delete(excludeUserId);
    return [...audience];
  }

  /**
   * Notify the thread's watchers of a new comment. Recipients are the thread's
   * `watching && !muted` members (minus the author); no further recipient-side
   * filtering is applied here, matching the pre-#829 fan-out contract that the
   * browser-push suite pins: the in-app notification ROW is durable across a
   * membership change (a removed member keeps the row; their browser push is
   * rechecked at delivery time by the push service), and the safety block /
   * thread-mute / category-preference filters all run inside {@link dispatch}.
   * First-post secrecy stays bounded because the auto-subscribe rules only ever
   * subscribe members who could already see the anchor (the author/replier passed
   * the anchor-visibility gate to post, and the first-post audience is attendees +
   * facilitators for a session or facilitators otherwise). A notification failure
   * for one recipient never fails the post.
   */
  private async notifyWatchers(
    row: typeof comments.$inferSelect,
    user: RequestUser,
    authorNumeric: number | null,
  ): Promise<void> {
    const entityType = row.entityType as EntityTypeValue;
    const watching = await this.db
      .select({ userId: commentThreadState.userId, muted: commentThreadState.muted })
      .from(commentThreadState)
      .where(
        and(
          eq(commentThreadState.campaignId, row.campaignId),
          eq(commentThreadState.entityType, row.entityType),
          eq(commentThreadState.entityId, row.entityId),
          eq(commentThreadState.watching, true),
        ),
      );
    const recipients = watching
      .filter((w) => !w.muted)
      .map((w) => w.userId)
      .filter((id) => authorNumeric === null || id !== authorNumeric);
    if (recipients.length === 0) return;


    for (const recipient of recipients) {
      await this.notifications.notifyUser(recipient, row.campaignId, user, {
        type: 'comment_reply',
        title: `${user.name || 'Someone'} posted on a ${row.entityType} discussion`,
        body: excerpt(row.body),
        entityType,
        entityId: row.entityId,
        commentId: row.id,
        actorName: user.name,
      });
    }
  }

  /**
   * The caller's per-thread subscription + read state (issue #829). Membership AND
   * anchor visibility are enforced: a thread on a hidden entity 404s for a non-DM
   * exactly as the entity's own GET does, so the state endpoint cannot probe a
   * secret anchor. `unreadCount` counts only live comments after the read cursor,
   * excluding the caller's own posts.
   */
  async getThreadState(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    user: RequestUser,
    role: Role,
  ): Promise<CommentThreadState> {
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    const userId = Number(user.id);
    const numeric = Number.isInteger(userId) && userId > 0;
    const state = numeric
      ? (await this.db
          .select()
          .from(commentThreadState)
          .where(
            and(
              eq(commentThreadState.userId, userId),
              eq(commentThreadState.campaignId, campaignId),
              eq(commentThreadState.entityType, entityType),
              eq(commentThreadState.entityId, entityId),
            ),
          )
          .limit(1))[0]
      : undefined;
    const unreadCount = numeric ? await this.countUnread(campaignId, userId, entityType, entityId) : 0;
    return {
      campaignId,
      entityType,
      entityId,
      watching: state?.watching ?? false,
      muted: state?.muted ?? false,
      lastReadCommentId: state?.lastReadCommentId ?? null,
      unreadCount,
      updatedAt: state?.updatedAt ?? null,
    };
  }

  /**
   * PUT the per-thread Watch/Mute controls (issue #829). Only the provided field is
   * changed; the other and the read cursor are preserved. A real (numeric) member
   * seat is required — DEV/PAT identities cannot hold subscription state. Audited.
   */
  async setThreadState(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    user: RequestUser,
    role: Role,
    input: { watching?: boolean; muted?: boolean },
  ): Promise<CommentThreadState> {
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    const userId = Number(user.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ForbiddenException('Sign in with a member account to manage discussion subscriptions');
    }
    const ts = nowIso();
    const set: Partial<typeof commentThreadState.$inferInsert> = { updatedAt: ts };
    if (input.watching !== undefined) set.watching = input.watching;
    if (input.muted !== undefined) set.muted = input.muted;
    this.db
      .insert(commentThreadState)
      .values({
        campaignId,
        userId,
        entityType,
        entityId,
        watching: input.watching ?? false,
        muted: input.muted ?? false,
        lastReadCommentId: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [
          commentThreadState.userId,
          commentThreadState.campaignId,
          commentThreadState.entityType,
          commentThreadState.entityId,
        ],
        set,
      })
      .run();
    const detail = [
      input.watching !== undefined ? `watching=${input.watching}` : null,
      input.muted !== undefined ? `muted=${input.muted}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join(' ');
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'comment.thread_state',
      entityType: 'comment',
      entityId,
      campaignId,
      detail,
    });
    return this.getThreadState(campaignId, entityType, entityId, user, role);
  }

  /**
   * Advance the per-thread read cursor (issue #829). `commentId` (a live comment on
   * this anchor) moves the cursor there; omit it to mark the thread read up to its
   * latest live comment. The cursor is monotonic — marking an OLDER comment read
   * never moves it backward, so unread state is retained until genuinely read.
   * Deep-linking lands the member on the exact comment; this is what clears it.
   */
  async markThreadRead(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
    user: RequestUser,
    role: Role,
    commentId?: number | null,
  ): Promise<CommentThreadState> {
    await this.assertAnchorVisible(campaignId, entityType, entityId, role);
    const userId = Number(user.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ForbiddenException('Sign in with a member account to track read state');
    }
    let cursor: number;
    if (commentId != null) {
      const target = await this.getRowOrThrow(commentId, true);
      if (
        target.campaignId !== campaignId ||
        target.entityType !== entityType ||
        target.entityId !== entityId
      ) {
        throw new NotFoundException(`Comment ${commentId} not found`);
      }
      cursor = target.id;
    } else {
      const [last] = await this.db
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(
            eq(comments.campaignId, campaignId),
            eq(comments.entityType, entityType),
            eq(comments.entityId, entityId),
            isNull(comments.deletedAt),
          ),
        )
        .orderBy(desc(comments.id))
        .limit(1);
      cursor = last?.id ?? 0;
    }
    // Advance the cursor monotonically: never move it backward, so marking an
    // OLDER comment read cannot un-read newer ones. Computed in JS rather than via
    // SQLite's scalar `max()` because `max(NULL, x)` returns NULL in SQLite — which
    // would silently drop a fresh cursor to NULL whenever the member had no prior
    // read state (the common case for a first read).
    const [existing] = await this.db
      .select({ lastReadCommentId: commentThreadState.lastReadCommentId })
      .from(commentThreadState)
      .where(
        and(
          eq(commentThreadState.userId, userId),
          eq(commentThreadState.campaignId, campaignId),
          eq(commentThreadState.entityType, entityType),
          eq(commentThreadState.entityId, entityId),
        ),
      )
      .limit(1);
    const nextCursor = Math.max(existing?.lastReadCommentId ?? 0, cursor);
    const ts = nowIso();
    this.db
      .insert(commentThreadState)
      .values({
        campaignId,
        userId,
        entityType,
        entityId,
        watching: false,
        muted: false,
        lastReadCommentId: nextCursor,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [
          commentThreadState.userId,
          commentThreadState.campaignId,
          commentThreadState.entityType,
          commentThreadState.entityId,
        ],
        set: { lastReadCommentId: nextCursor, updatedAt: ts },
      })
      .run();
    return this.getThreadState(campaignId, entityType, entityId, user, role);
  }

  /**
   * Per-anchor unread counts for the caller (issue #829), driving session-card badges
   * and the inbox. Only anchors the caller may see are included (hidden quest/npc/
   * faction threads and unexplored locations are dropped), muted threads are skipped,
   * and the caller's own posts never count as unread. Pass `entityType` to scope
   * (e.g. session cards). Only entries with `unreadCount > 0` are returned.
   */
  async unreadSummary(
    campaignId: number,
    user: RequestUser,
    role: Role,
    entityType?: EntityTypeValue,
  ): Promise<CommentUnreadSummary> {
    const userId = Number(user.id);
    if (!Number.isInteger(userId) || userId <= 0) return { items: [] };
    const stateRows = await this.db
      .select()
      .from(commentThreadState)
      .where(and(eq(commentThreadState.userId, userId), eq(commentThreadState.campaignId, campaignId)));
    const stateByAnchor = new Map<string, (typeof stateRows)[number]>(
      stateRows.map((s) => [`${s.entityType}:${s.entityId}`, s] as const),
    );
    // Distinct anchors with live comments the caller did not author.
    const groups = await this.db
      .select({ entityType: comments.entityType, entityId: comments.entityId })
      .from(comments)
      .where(
        and(
          eq(comments.campaignId, campaignId),
          ne(comments.authorUserId, String(userId)),
          isNull(comments.deletedAt),
        ),
      )
      .groupBy(comments.entityType, comments.entityId);
    const items: CommentUnreadSummaryEntry[] = [];
    const visibleAnchor = new Map<string, boolean>();
    for (const group of groups) {
      const anchorType = group.entityType as EntityTypeValue;
      if (entityType && anchorType !== entityType) continue;
      const key = `${anchorType}:${group.entityId}`;
      const state = stateByAnchor.get(key);
      if (state?.muted) continue; // muted: opted out of unread surfacing for this thread.
      let visible = visibleAnchor.get(key);
      if (visible === undefined) {
        visible = await this.isAnchorVisible(campaignId, anchorType, group.entityId, role);
        visibleAnchor.set(key, visible);
      }
      if (!visible) continue;
      const cursor = state?.lastReadCommentId ?? 0;
      const [countRow] = await this.db
        .select({ value: count() })
        .from(comments)
        .where(
          and(
            eq(comments.campaignId, campaignId),
            eq(comments.entityType, anchorType),
            eq(comments.entityId, group.entityId),
            ne(comments.authorUserId, String(userId)),
            isNull(comments.deletedAt),
            gt(comments.id, cursor),
          ),
        );
      const unreadCount = countRow?.value ?? 0;
      if (unreadCount > 0) {
        items.push({
          entityType: anchorType,
          entityId: group.entityId,
          watching: state?.watching ?? false,
          muted: false,
          unreadCount,
          lastReadCommentId: state?.lastReadCommentId ?? null,
        });
      }
    }
    return { items };
  }

  /**
   * Campaign-wide discussion inbox (issue #829): the caller's WATCHING threads that
   * have unread comments, with a resolved entity name and the most recent live
   * comment for sort/preview. Sorted newest-first. Hidden anchors the caller cannot
   * see are dropped. Each item deep-links to its latest comment via `entityHref`.
   */
  async inbox(campaignId: number, user: RequestUser, role: Role): Promise<CommentInboxPage> {
    const userId = Number(user.id);
    if (!Number.isInteger(userId) || userId <= 0) return { items: [] };
    const stateRows = await this.db
      .select()
      .from(commentThreadState)
      .where(
        and(
          eq(commentThreadState.userId, userId),
          eq(commentThreadState.campaignId, campaignId),
          eq(commentThreadState.watching, true),
          eq(commentThreadState.muted, false),
        ),
      );
    const items: CommentInboxItem[] = [];
    const visibleAnchor = new Map<string, boolean>();
    for (const state of stateRows) {
      const anchorType = state.entityType as EntityTypeValue;
      const key = `${anchorType}:${state.entityId}`;
      let visible = visibleAnchor.get(key);
      if (visible === undefined) {
        visible = await this.isAnchorVisible(campaignId, anchorType, state.entityId, role);
        visibleAnchor.set(key, visible);
      }
      if (!visible) continue;
      const [agg] = await this.db
        .select({ unread: count(), lastId: max(comments.id), lastAt: max(comments.createdAt) })
        .from(comments)
        .where(
          and(
            eq(comments.campaignId, campaignId),
            eq(comments.entityType, anchorType),
            eq(comments.entityId, state.entityId),
            ne(comments.authorUserId, String(userId)),
            isNull(comments.deletedAt),
          ),
        );
      const totalUnread = agg?.unread ?? 0;
      if (totalUnread === 0) continue;
      // `unreadCount` is the count AFTER the caller's read cursor (what the badge
      // shows); `totalUnread` (above) is the cheap guard that skips fully-read threads
      // before the per-cursor countUnread round-trip.
      const unreadCount = await this.countUnread(campaignId, userId, anchorType, state.entityId);
      if (unreadCount === 0) continue;
      items.push({
        campaignId,
        entityType: anchorType,
        entityId: state.entityId,
        entityName: await this.resolveAnchorName(campaignId, anchorType, state.entityId),
        watching: true,
        unreadCount,
        lastCommentId: agg?.lastId ?? null,
        lastCommentAt: agg?.lastAt ?? null,
      });
    }
    items.sort((a, b) => (b.lastCommentAt ?? '').localeCompare(a.lastCommentAt ?? ''));
    return { items };
  }

  /** Live comments after the caller's read cursor on one anchor (own posts excluded). */
  private async countUnread(
    campaignId: number,
    userId: number,
    entityType: EntityTypeValue,
    entityId: number,
  ): Promise<number> {
    const [state] = await this.db
      .select({ lastReadCommentId: commentThreadState.lastReadCommentId })
      .from(commentThreadState)
      .where(
        and(
          eq(commentThreadState.userId, userId),
          eq(commentThreadState.campaignId, campaignId),
          eq(commentThreadState.entityType, entityType),
          eq(commentThreadState.entityId, entityId),
        ),
      )
      .limit(1);
    const cursor = state?.lastReadCommentId ?? 0;
    const [row] = await this.db
      .select({ value: count() })
      .from(comments)
      .where(
        and(
          eq(comments.campaignId, campaignId),
          eq(comments.entityType, entityType),
          eq(comments.entityId, entityId),
          ne(comments.authorUserId, String(userId)),
          isNull(comments.deletedAt),
          gt(comments.id, cursor),
        ),
      );
    return row?.value ?? 0;
  }

  /**
   * Display name of an anchored entity (issue #829 inbox), resolved at read time so
   * renames stay current. Null when the entity no longer exists. Covers every
   * anchorable EntityType; types with no name column fall back to null.
   */
  private async resolveAnchorName(
    campaignId: number,
    entityType: EntityTypeValue,
    entityId: number,
  ): Promise<string | null> {
    switch (entityType) {
      case 'session': {
        const [r] = await this.db
          .select({ title: sessions.title })
          .from(sessions)
          .where(and(eq(sessions.id, entityId), eq(sessions.campaignId, campaignId)))
          .limit(1);
        return r?.title || null;
      }
      case 'quest': {
        const [r] = await this.db.select({ title: quests.title }).from(quests).where(and(eq(quests.id, entityId), eq(quests.campaignId, campaignId))).limit(1);
        return r?.title || null;
      }
      case 'npc': {
        const [r] = await this.db.select({ name: npcs.name }).from(npcs).where(and(eq(npcs.id, entityId), eq(npcs.campaignId, campaignId))).limit(1);
        return r?.name || null;
      }
      case 'location': {
        const [r] = await this.db.select({ name: locations.name }).from(locations).where(and(eq(locations.id, entityId), eq(locations.campaignId, campaignId))).limit(1);
        return r?.name || null;
      }
      case 'character': {
        const [r] = await this.db.select({ name: characters.name }).from(characters).where(and(eq(characters.id, entityId), eq(characters.campaignId, campaignId))).limit(1);
        return r?.name || null;
      }
      case 'faction': {
        const [r] = await this.db.select({ name: factions.name }).from(factions).where(and(eq(factions.id, entityId), eq(factions.campaignId, campaignId))).limit(1);
        return r?.name || null;
      }
      case 'campaign': {
        const [r] = await this.db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
        return r?.name || null;
      }
      default:
        return null;
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

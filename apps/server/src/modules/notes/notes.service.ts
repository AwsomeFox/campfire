import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  NoteCreate,
  NoteUpdate,
  InboxCreate,
  InboxResolve,
  EntityType,
  NOTES_LIST_MAX_LIMIT,
} from '@campfire/schema';
import type { Note, NoteListPage, NoteVisibility, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  auditLog,
  campaignMembers,
  campaigns,
  characters,
  encounters,
  factions,
  locations,
  notes,
  notifications,
  npcs,
  quests,
  sessions,
  users,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { canSee } from '../../common/note-visibility';
import { assertMayInteract, noteVisibilityIsOutbound } from '../../common/interactive-capability';
import { blockedTargetsOf } from '../../common/safety-controls';
import { foldForSearch, foldedIncludes } from '../../common/text-search';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, excerpt } from '../notifications/notifications.service';
import { RevisionsService } from '../revisions/revisions.service';
import { ModerationService } from '../moderation/moderation.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import {
  clampNotesListLimit,
  decodeNotesCursor,
  encodeNotesCursor,
  type NotesIdCursor,
  type NotesUpdatedCursor,
} from './notes-pagination';

type NoteCreateInput = z.infer<typeof NoteCreate>;
type NoteUpdateInput = z.infer<typeof NoteUpdate>;
type InboxCreateInput = z.infer<typeof InboxCreate>;
type InboxResolveInput = z.infer<typeof InboxResolve>;
type EntityTypeValue = z.infer<typeof EntityType>;

function toDomain(
  row: typeof notes.$inferSelect,
  entityName: string | null = null,
  recipientName: string | null = null,
): Note {
  return {
    id: row.id,
    campaignId: row.campaignId,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    kind: row.kind as Note['kind'],
    visibility: row.visibility as Note['visibility'],
    entityType: row.entityType as EntityTypeValue | null,
    entityId: row.entityId,
    entityName,
    recipientUserId: row.recipientUserId ?? null,
    recipientName,
    body: row.body,
    resolved: row.resolved,
    resolvedNote: row.resolvedNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Pull a row's resolved entity name out of a `${entityType}:${entityId}` -> name map. */
function entityNameFor(
  row: { entityType: string | null; entityId: number | null },
  names: Map<string, string>,
): string | null {
  if (!row.entityType || row.entityId == null) return null;
  return names.get(`${row.entityType}:${row.entityId}`) ?? null;
}

/**
 * Note visibility (issue #127). The rule itself moved to `common/note-visibility.ts`
 * for issue #601 — the moderation module must apply the IDENTICAL check when
 * authorizing "may this reporter report this whisper", and importing it from here
 * would close a circular module edge (NotesService now depends on ModerationService
 * for pre-mutation evidence capture). Re-exported so every existing importer
 * (RevisionsController, the MCP tools) is untouched.
 */
export { canSee } from '../../common/note-visibility';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly revisions: RevisionsService,
    // Issue #601: pre-mutation abuse-evidence capture + mute enforcement, and the
    // quarantine path that finally lets a DM withhold an abusive whisper. The
    // dependency runs one way (notes -> moderation).
    private readonly moderation: ModerationService,
  ) {}

  /** Resolve a stale in-flight request's public attribution without changing its audit identity. */
  private async currentAttributionUser(user: RequestUser): Promise<RequestUser> {
    const id = Number(user.id);
    if (!Number.isInteger(id) || id <= 0) return user;
    const [current] = await this.db
      .select({ displayName: users.displayName, username: users.username })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return { ...user, name: current ? (current.displayName || current.username) : 'Deleted user' };
  }

  /**
   * note_reply fan-out for a newly created SHARED note attached to an entity:
   * notify the other members who already wrote a shared note on that same
   * entity (the closest thing this data model has to a thread), but only those
   * who can actually SEE the new note — party_shared is visible to everyone,
   * dm_shared only to dm-role members. Private notes never notify anyone.
   */
  private async notifyThreadAuthors(row: typeof notes.$inferSelect, user: RequestUser): Promise<void> {
    // Whispers are single-recipient and MUST NOT fan out to entity-thread siblings —
    // a sibling who wrote a shared note on the same entity is usually NOT the whisper
    // target, and this notification would leak the whisper body to them. The whisper's
    // own recipient is notified separately (notifyWhisperRecipient). issue #127.
    if (row.visibility === 'private' || row.visibility === 'whisper' || !row.entityType || !row.entityId) return;
    const siblings = await this.db
      .select({ authorUserId: notes.authorUserId, visibility: notes.visibility })
      .from(notes)
      .where(
        and(
          eq(notes.campaignId, row.campaignId),
          eq(notes.kind, 'note'),
          eq(notes.entityType, row.entityType),
          eq(notes.entityId, row.entityId),
          notDeleted(notes.deletedAt),
        ),
      );
    const roles = await this.notifications.memberRoles(row.campaignId);
    const recipients = new Set<number>();
    for (const sibling of siblings) {
      if (sibling.visibility === 'private') continue; // they weren't part of the shared thread
      const authorId = Number(sibling.authorUserId);
      if (!Number.isInteger(authorId) || String(authorId) === user.id) continue;
      const memberRole = roles.get(authorId);
      if (!memberRole) continue; // no longer a member
      if (row.visibility === 'dm_shared' && memberRole !== 'dm') continue; // can't see the new note
      recipients.add(authorId);
    }
    for (const recipient of recipients) {
      await this.notifications.notifyUser(recipient, row.campaignId, user, {
        type: 'note_reply',
        title: `${user.name || 'Someone'} added a note on a ${row.entityType} you commented on`,
        body: excerpt(row.body),
        entityType: row.entityType as EntityTypeValue,
        entityId: row.entityId,
        actorName: user.name,
      });
    }
  }

  /**
   * A note shared up to the DM (dm_shared) should genuinely reach the DM — the My
   * Notes copy promises "shared-with-DM notes appear in the DM's scribe view", but
   * without this the note only sat silently under the DM's "Shared with me" with no
   * signal (issue #105). Notify every dm-role member (except the author, in case a
   * dm shares their own note) so it surfaces in their notification bell with an
   * unread badge. Anchored notes deep-link to the entity; unanchored ones land on
   * the notes page. Best-effort, like every other notify* emitter.
   */
  private async notifyDmsOfSharedNote(row: typeof notes.$inferSelect, user: RequestUser): Promise<void> {
    if (row.visibility !== 'dm_shared') return;
    const roles = await this.notifications.memberRoles(row.campaignId);
    for (const [memberId, memberRole] of roles) {
      if (memberRole !== 'dm' || String(memberId) === user.id) continue;
      await this.notifications.notifyUser(memberId, row.campaignId, user, {
        type: 'note_shared',
        title: `${user.name || 'Someone'} shared a note with you`,
        body: excerpt(row.body),
        entityType: (row.entityType as EntityTypeValue | null) ?? null,
        entityId: row.entityId,
        actorName: user.name,
      });
    }
  }

  /**
   * A note shared to the whole party (party_shared) should reach everyone (issue #263):
   * previously a fresh party_shared note pinged nobody unless it happened to land on an
   * entity where others had already written shared notes (notifyThreadAuthors). Broadcast
   * to every campaign member except the author (notifyCampaign's own skip), so a shared
   * note surfaces in each member's bell. Uses note_shared (the same "a note was shared"
   * signal as dm_shared); anchored notes carry the entity link. Best-effort.
   */
  private async notifyPartyOfSharedNote(row: typeof notes.$inferSelect, user: RequestUser): Promise<void> {
    if (row.visibility !== 'party_shared') return;
    await this.notifications.notifyCampaign(row.campaignId, user, {
      type: 'note_shared',
      title: `${user.name || 'Someone'} shared a note with the party`,
      body: excerpt(row.body),
      entityType: (row.entityType as EntityTypeValue | null) ?? null,
      entityId: row.entityId,
      actorName: user.name,
    });
  }

  /**
   * A whisper reaches exactly one member — tell them, so the per-player secret channel
   * actually pings (mirrors notifyDmsOfSharedNote for dm_shared). Best-effort; skipped
   * for DEV_AUTH dev:<name> recipients (no users row) by notifyUser's numeric guard.
   * issue #127.
   */
  private async notifyWhisperRecipient(row: typeof notes.$inferSelect, user: RequestUser): Promise<void> {
    if (row.visibility !== 'whisper' || !row.recipientUserId) return;
    await this.notifications.notifyUser(row.recipientUserId, row.campaignId, user, {
      type: 'note_shared',
      title: `${user.name || 'Someone'} whispered a note to you`,
      body: excerpt(row.body),
      entityType: (row.entityType as EntityTypeValue | null) ?? null,
      entityId: row.entityId,
      actorName: user.name,
    });
  }

  /**
   * A member posted to the DM scribe inbox (issue #832) — every current dm-role member
   * except the author should get a bell item. entityId is the inbox note row for a
   * deep-link; the UI routes inbox_submitted to /inbox?inbox=:id. Best-effort.
   */
  private async notifyDmsOfInboxSubmission(row: typeof notes.$inferSelect, user: RequestUser): Promise<void> {
    if (row.kind !== 'inbox') return;
    try {
      const roles = await this.notifications.memberRoles(row.campaignId);
      for (const [memberId, memberRole] of roles) {
        if (memberRole !== 'dm' || String(memberId) === user.id) continue;
        await this.notifications.notifyUser(memberId, row.campaignId, user, {
          type: 'inbox_submitted',
          title: `${user.name || 'A member'} sent a note to your inbox`,
          body: excerpt(row.body),
          entityType: null,
          entityId: row.id,
          actorName: user.name,
        });
      }
    } catch (err) {
      // notifyUser swallows per-row insert errors; this catch covers memberRoles /
      // iteration failures only (issue #832).
      this.logger.warn(
        `inbox_submitted DM role lookup failed for note ${row.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Validate + normalize the (visibility, recipientUserId) pair for a create/update.
   * Returns the recipient id to persist: the validated target for a `whisper`, or null
   * for every other visibility (a stray recipient on a non-whisper note is dropped, not
   * stored). A whisper with no recipient, or a recipient who isn't a campaign member,
   * is rejected — a whisper must always land on a real member. issue #127.
   */
  private async resolveWhisperTarget(
    campaignId: number,
    visibility: string,
    recipientUserId: string | null | undefined,
  ): Promise<string | null> {
    if (visibility !== 'whisper') return null;
    const target = (recipientUserId ?? '').trim();
    if (!target) throw new BadRequestException('A whisper note requires a recipient (recipientUserId).');
    const member = await this.lookupMember(campaignId, target);
    if (!member) throw new BadRequestException('Whisper recipient must be a member of this campaign.');
    return target;
  }

  /**
   * Look up a campaign member by the note-identity user id (String(users.id), or
   * dev:<name> under DEV_AUTH). Returns the display label, or null when the id is not a
   * member of this campaign. DEV_AUTH synthetic users have no members/users rows, so
   * they're accepted by their header name (that path is non-production only).
   */
  private async lookupMember(campaignId: number, userId: string): Promise<{ name: string } | null> {
    if (userId.startsWith('dev:')) return { name: userId.slice(4) || userId };
    const numeric = Number(userId);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    const [row] = await this.db
      .select({ displayName: users.displayName, username: users.username })
      .from(campaignMembers)
      .innerJoin(users, eq(campaignMembers.userId, users.id))
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, numeric)))
      .limit(1);
    if (!row) return null;
    return { name: row.displayName || row.username || String(numeric) };
  }

  /**
   * Resolve display names for the whisper recipients of the given rows, so reads can
   * show "Whispered to Rogue" instead of a bare id. Batched over the numeric ids;
   * dev:<name> ids derive their label from the header name. Same read-time,
   * never-stored shape as resolveEntityNames.
   */
  private async resolveRecipientNames(
    rows: Array<{ visibility: string; recipientUserId: string | null }>,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const numericIds: number[] = [];
    for (const r of rows) {
      if (r.visibility !== 'whisper' || !r.recipientUserId) continue;
      const id = r.recipientUserId;
      if (names.has(id)) continue;
      if (id.startsWith('dev:')) {
        names.set(id, id.slice(4) || id);
      } else {
        const n = Number(id);
        if (Number.isInteger(n) && n > 0) numericIds.push(n);
      }
    }
    if (numericIds.length) {
      const found = await this.db
        .select({ id: users.id, displayName: users.displayName, username: users.username })
        .from(users)
        .where(inArray(users.id, numericIds));
      for (const u of found) names.set(String(u.id), u.displayName || u.username || String(u.id));
    }
    return names;
  }

  /** Recipient display name for a single row (null unless it's a whisper with a resolvable target). */
  private recipientNameFor(
    row: { visibility: string; recipientUserId: string | null },
    names: Map<string, string>,
  ): string | null {
    if (row.visibility !== 'whisper' || !row.recipientUserId) return null;
    return names.get(row.recipientUserId) ?? null;
  }

  /**
   * List notes visible to `user` in a campaign (issue #608).
   *
   * Returns a bounded newest-first page (`items` / `total` / `hasMore` / `nextCursor`)
   * — never an unbounded array. Default page size is 50; pass `cursor` from a previous
   * `nextCursor` to continue. Filters (`entityType`/`entityId`/`mine`/`visibility`/`q`)
   * apply before paging so search and chips stay correct under load-more.
   */
  async listForCampaign(
    campaignId: number,
    user: RequestUser,
    role: Role,
    filters: {
      entityType?: string;
      entityId?: number;
      mine?: boolean;
      visibility?: NoteVisibility;
      q?: string;
      limit?: number;
      cursor?: string;
      /**
       * Internal-only: set false to skip the per-page COUNT(*) when a caller walks every
       * page for the full item set (search/export) and never reads `total`. Not wired to
       * any HTTP/MCP query param — `total` stays accurate for real paginated consumers.
       */
      countTotal?: boolean;
    } = {},
  ): Promise<NoteListPage> {
    const limit = clampNotesListLimit(filters.limit);
    const cursor = decodeNotesCursor(filters.cursor, 'id') as NotesIdCursor | undefined;

    // Visibility is pushed into SQL (was a JS post-filter, issue #71) so the page
    // covers the ACTUALLY-visible rows: party_shared to everyone, own notes always,
    // dm_shared additionally to a dm, and a whisper to its recipient (+ any dm). Mirrors
    // canSee() exactly — a non-target, non-dm member never even loads a whisper row.
    const visibility: SQL[] = [eq(notes.visibility, 'party_shared'), eq(notes.authorUserId, user.id)];
    if (role === 'dm') visibility.push(eq(notes.visibility, 'dm_shared'));
    visibility.push(and(eq(notes.visibility, 'whisper'), eq(notes.recipientUserId, user.id))!);
    if (role === 'dm') visibility.push(eq(notes.visibility, 'whisper'));

    // notDeleted(quarantinedAt) (issue #601): a quarantined note/whisper is dropped
    // from every normal read exactly like a trashed one — including for its own
    // author and, for a whisper, its recipient. Withholding it from the target is
    // the entire point: the DM has judged the content abusive, and "the victim can
    // still read it" is not a moderation outcome. It stays reachable only through
    // the separately-gated moderation evidence path.
    const conds: SQL[] = [
      eq(notes.campaignId, campaignId),
      eq(notes.kind, 'note'),
      notDeleted(notes.deletedAt),
      notDeleted(notes.quarantinedAt),
      or(...visibility)!,
    ];
    if (filters.entityType) conds.push(eq(notes.entityType, filters.entityType));
    if (filters.entityId !== undefined) conds.push(eq(notes.entityId, filters.entityId));
    if (filters.mine) conds.push(eq(notes.authorUserId, user.id));
    if (filters.visibility) conds.push(eq(notes.visibility, filters.visibility));

    // Issue #597: a personal BLOCK hides the blocked member's notes — including any
    // whisper they aimed at the blocker — from the blocker's reads. Applied on the
    // READER's side only: the blocked author's own write still succeeds and their own
    // reads are unchanged, so nothing about the block is observable from their side.
    // The row is not deleted and stays fully visible to the DM and to the moderation
    // evidence path, because a blocked whisper is exactly the material a safeguarding
    // review needs. Empty for almost every caller, so this costs one indexed lookup.
    const blockedAuthors = await blockedTargetsOf(this.db, user.id, campaignId);
    if (blockedAuthors.size > 0) {
      conds.push(notInArray(notes.authorUserId, [...blockedAuthors]));
    }

    // Free-text search (issue #65 / #624). The needle is folded with the shared helper
    // (NFKC + fixed-locale case fold). SQLite `lower()` is ASCII-only and cannot see
    // ß→ss / İ / accent case folds, so `q` is fold-matched in JS.
    //
    // To keep the documented "filters apply before paging" guarantee correct at any size
    // (#608), the scan walks the COMPLETE filtered set in keyset batches — not a truncated
    // newest-N window that would make `total` wrong and strand older matches. Each row is
    // matched against its body OR its anchored entity name (resolved per batch, bounded
    // queries) so an entity-name search still surfaces its notes; only matched rows are kept.
    const SEARCH_SCAN_BATCH = 1_000;
    const search = filters.q?.trim() ? foldForSearch(filters.q.trim()) : '';

    let visible: Array<typeof notes.$inferSelect>;
    let total: number;

    if (search) {
      const matched: Array<typeof notes.$inferSelect> = [];
      let scanId: number | undefined;
      for (;;) {
        const batchConds = scanId !== undefined ? [...conds, lt(notes.id, scanId)] : conds;
        const batch = await this.db
          .select()
          .from(notes)
          .where(and(...batchConds))
          .orderBy(desc(notes.id))
          .limit(SEARCH_SCAN_BATCH);
        if (batch.length === 0) break;
        const batchNames = await this.resolveEntityNames(campaignId, batch);
        for (const r of batch) {
          const name = entityNameFor(r, batchNames);
          if (foldedIncludes(r.body, search) || (name ? foldedIncludes(name, search) : false)) {
            matched.push(r);
          }
        }
        scanId = batch[batch.length - 1]!.id;
        if (batch.length < SEARCH_SCAN_BATCH) break;
      }
      total = matched.length;
      const afterCursor = cursor ? matched.filter((r) => r.id < cursor.i) : matched;
      visible = afterCursor.slice(0, limit + 1);
    } else {
      const keyset = cursor ? lt(notes.id, cursor.i) : undefined;
      const pageConds = keyset ? [...conds, keyset] : conds;
      const countQuery: Promise<{ value: number }[]> =
        filters.countTotal === false
          ? Promise.resolve([{ value: 0 }])
          : this.db.select({ value: count() }).from(notes).where(and(...conds));
      const [countRows, fetched] = await Promise.all([
        countQuery,
        this.db.select().from(notes).where(and(...pageConds)).orderBy(desc(notes.id)).limit(limit + 1),
      ]);
      total = countRows[0]?.value ?? 0;
      visible = fetched;
    }

    const hasMore = visible.length > limit;
    const pageRows = hasMore ? visible.slice(0, limit) : visible;
    const names = await this.resolveEntityNames(campaignId, pageRows);
    const recipientNames = await this.resolveRecipientNames(pageRows);
    const items = pageRows.map((r) => toDomain(r, entityNameFor(r, names), this.recipientNameFor(r, recipientNames)));
    const last = pageRows[pageRows.length - 1];
    // Always present, `null` when exhausted — a stable REST/MCP contract (issue #608),
    // rather than omitting the key (which JSON does for `undefined`).
    const nextCursor =
      hasMore && last ? encodeNotesCursor({ v: 1, m: 'id', i: last.id }) : null;
    return { items, total, hasMore, nextCursor, limit };
  }

  /**
   * Walk every page of {@link listForCampaign} for internal full-set readers
   * (campaign search #64, export). Not exposed over HTTP/MCP.
   */
  async listAllForCampaign(
    campaignId: number,
    user: RequestUser,
    role: Role,
    filters: {
      entityType?: string;
      entityId?: number;
      mine?: boolean;
      visibility?: NoteVisibility;
      q?: string;
    } = {},
  ): Promise<Note[]> {
    const out: Note[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listForCampaign(campaignId, user, role, {
        ...filters,
        limit: NOTES_LIST_MAX_LIMIT,
        cursor,
        countTotal: false,
      });
      out.push(...page.items);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /**
   * Resolve display names for the entities the given note rows are anchored to, so
   * list views can show "The Sunken Crypt" instead of "Quest #12". Batched per entity
   * type; lookups are scoped to `campaignId` so a note pointing at another campaign's
   * entity never leaks that entity's name. Deleted/foreign entities are simply absent
   * from the map (the note then carries entityName: null).
   */
  private async resolveEntityNames(
    campaignId: number,
    rows: Array<{ entityType: string | null; entityId: number | null }>,
  ): Promise<Map<string, string>> {
    const idsByType = new Map<EntityTypeValue, Set<number>>();
    for (const r of rows) {
      if (!r.entityType || r.entityId == null) continue;
      const type = r.entityType as EntityTypeValue;
      const set = idsByType.get(type) ?? new Set<number>();
      set.add(r.entityId);
      idsByType.set(type, set);
    }

    const names = new Map<string, string>();
    for (const [type, idSet] of idsByType) {
      for (const { id, name } of await this.lookupEntityNames(campaignId, type, [...idSet])) {
        names.set(`${type}:${id}`, name);
      }
    }
    return names;
  }

  private async lookupEntityNames(
    campaignId: number,
    type: EntityTypeValue,
    ids: number[],
  ): Promise<Array<{ id: number; name: string }>> {
    // A trashed (soft-deleted, #116) target resolves to no name — same as a hard-deleted
    // one did — so an anchored note shows entityName: null while its target is in the trash.
    switch (type) {
      case 'quest':
        return this.db
          .select({ id: quests.id, name: quests.title })
          .from(quests)
          .where(and(eq(quests.campaignId, campaignId), inArray(quests.id, ids), notDeleted(quests.deletedAt)));
      case 'npc':
        return this.db
          .select({ id: npcs.id, name: npcs.name })
          .from(npcs)
          .where(and(eq(npcs.campaignId, campaignId), inArray(npcs.id, ids), notDeleted(npcs.deletedAt)));
      case 'location':
        return this.db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(and(eq(locations.campaignId, campaignId), inArray(locations.id, ids), notDeleted(locations.deletedAt)));
      case 'character':
        return this.db
          .select({ id: characters.id, name: characters.name })
          .from(characters)
          .where(and(eq(characters.campaignId, campaignId), inArray(characters.id, ids), notDeleted(characters.deletedAt)));
      case 'session': {
        const rows = await this.db
          .select({ id: sessions.id, title: sessions.title, number: sessions.number })
          .from(sessions)
          .where(and(eq(sessions.campaignId, campaignId), inArray(sessions.id, ids), notDeleted(sessions.deletedAt)));
        return rows.map((r) => ({ id: r.id, name: r.title || `Session ${r.number}` }));
      }
      case 'campaign':
        // A note can only anchor to its own campaign; ignore foreign campaign ids.
        return this.db
          .select({ id: campaigns.id, name: campaigns.name })
          .from(campaigns)
          .where(and(eq(campaigns.id, campaignId), inArray(campaigns.id, ids)));
      case 'encounter':
        // Encounters can be pinned by a note (issue #126) — resolve their display names.
        return this.db
          .select({ id: encounters.id, name: encounters.name })
          .from(encounters)
          .where(and(eq(encounters.campaignId, campaignId), inArray(encounters.id, ids), notDeleted(encounters.deletedAt)));
      case 'faction':
        // Factions can be pinned by a note (issue #221) — resolve their display names.
        return this.db
          .select({ id: factions.id, name: factions.name })
          .from(factions)
          .where(and(eq(factions.campaignId, campaignId), inArray(factions.id, ids), notDeleted(factions.deletedAt)));
    }
  }

  /** toDomain + entityName/recipientName resolution for a single row (get/create/update responses). */
  private async toDomainWithEntityName(row: typeof notes.$inferSelect): Promise<Note> {
    const names = await this.resolveEntityNames(row.campaignId, [row]);
    const recipientNames = await this.resolveRecipientNames([row]);
    return toDomain(row, entityNameFor(row, names), this.recipientNameFor(row, recipientNames));
  }

  async getRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id)).limit(1);
    // A trashed note (soft-deleted, #116) reads as nonexistent unless includeDeleted (restore).
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Note ${id} not found`);
    // A QUARANTINED note (issue #601) reads as nonexistent to every caller on every
    // path, including restore — only the moderation queue may lift a quarantine, so
    // there is deliberately no includeDeleted-style escape hatch here. Without this,
    // an author could restore their own quarantined note straight back into view.
    if (row.quarantinedAt != null) throw new NotFoundException(`Note ${id} not found`);
    return row;
  }

  /** GET by id 404s (not 403) for hidden notes. */
  async getOrThrow(id: number, user: RequestUser, role: Role): Promise<Note> {
    const row = await this.getRowOrThrow(id);
    if (!canSee(row, user, role)) throw new NotFoundException(`Note ${id} not found`);
    // Issue #597: a note by someone this reader blocks reads as nonexistent to them,
    // matching the list filter, so a direct id fetch is not a way around the block. Same
    // 404 the visibility rule uses — the reader already knows they blocked this person,
    // and the AUTHOR never sees this path at all, so nothing is disclosed either way.
    // Deliberately not applied in `canSee`: the moderation module authorizes reports
    // through that predicate, and a blocked whisper must stay reportable.
    if (row.authorUserId !== user.id && (await blockedTargetsOf(this.db, user.id, row.campaignId)).has(row.authorUserId)) {
      throw new NotFoundException(`Note ${id} not found`);
    }
    return this.toDomainWithEntityName(row);
  }

  async create(campaignId: number, input: NoteCreateInput, user: RequestUser, role: Role): Promise<Note> {
    // Issue #601: a moderation mute must actually stop the muted member posting —
    // including via a whisper, which is exactly the channel a muted harasser would
    // reach for next. Checked first so a muted request does no writes at all.
    await this.moderation.assertNotMuted(campaignId, user);
    const ts = nowIso();
    const visibility = input.visibility ?? 'private';
    // Issue #597: the read-only boundary is drawn at "does this reach anyone else".
    // A viewer keeping private notes is the Viewer seat working as intended; a viewer
    // whispering a member, or broadcasting to the party, is the bug this issue closes.
    // Checked here rather than in the controller because the answer depends on the
    // resolved visibility, and checked BEFORE resolveWhisperTarget so a read-only seat
    // cannot use the whisper-target validation as a roster oracle.
    if (noteVisibilityIsOutbound(visibility)) {
      await assertMayInteract(this.db, user, campaignId, role, 'share, whisper, or send notes to other members');
    }
    const recipientUserId = await this.resolveWhisperTarget(campaignId, visibility, input.recipientUserId);
    const row = this.db.transaction((tx) => {
      const current = tx
        .select({ displayName: users.displayName, username: users.username })
        .from(users)
        .where(eq(users.id, Number(user.id)))
        .limit(1)
        .get();
      return tx
        .insert(notes)
        .values({
        campaignId,
        authorUserId: user.id,
        authorName: current ? (current.displayName || current.username) : 'Deleted user',
        kind: 'note',
        visibility,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        recipientUserId,
        body: input.body,
        resolved: false,
        resolvedNote: '',
        createdAt: ts,
        updatedAt: ts,
        })
        .returning()
        .get();
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'note.create',
      entityType: 'note',
      entityId: row.id,
      campaignId,
    });
    // Initial prose tip so the first overwrite keeps real authorship (#813).
    if (row.body !== '') {
      const revisionAuthor = await this.currentAttributionUser(user);
      await this.revisions.commitProseVersion({
        entityType: 'note',
        entityId: row.id,
        campaignId,
        priorProse: '',
        nextProse: row.body,
        user: revisionAuthor,
      });
    }
    const notificationActor = await this.currentAttributionUser(user);
    await this.notifyThreadAuthors(row, notificationActor);
    await this.notifyDmsOfSharedNote(row, notificationActor);
    await this.notifyPartyOfSharedNote(row, notificationActor);
    await this.notifyWhisperRecipient(row, notificationActor);
    return this.toDomainWithEntityName(row);
  }

  /** author only; dm may NOT edit others' notes */
  async update(
    id: number,
    input: NoteUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<Note> {
    const existing = await this.getRowOrThrow(id);
    if (!canSee(existing, user, role)) throw new NotFoundException(`Note ${id} not found`);
    if (existing.authorUserId !== user.id) {
      throw new ForbiddenException('Only the author may edit this note');
    }
    // Optimistic concurrency (#157): a co-author's stale save 409s instead of clobbering.
    this.revisions.assertNotStale(existing, opts?.expectedUpdatedAt);

    // Recompute the whisper target from the RESULTING visibility + recipient: switching
    // away from whisper clears the recipient, switching into whisper (or re-targeting)
    // re-validates it against campaign membership. issue #127.
    const finalVisibility = input.visibility ?? existing.visibility;
    // Issue #597: gate on the RESULTING visibility, which is why this check lives here
    // and not in the controller. A read-only viewer may keep editing their own private
    // notes; the moment the patch would make one reach someone else — a new outbound
    // visibility, or a body edit to an already-outbound note — the interactive seat is
    // required. The `existing` case matters for a member demoted from player to viewer,
    // who otherwise keeps a live broadcast channel through notes they wrote earlier.
    if (noteVisibilityIsOutbound(finalVisibility, existing.kind)) {
      await assertMayInteract(
        this.db,
        user,
        existing.campaignId,
        role,
        'share, whisper, or send notes to other members',
      );
    }
    const finalRecipientRaw = 'recipientUserId' in input ? input.recipientUserId : existing.recipientUserId;
    const recipientUserId = await this.resolveWhisperTarget(existing.campaignId, finalVisibility, finalRecipientRaw);

    // Issue #601: capture the pre-edit abuse-evidence snapshot INSIDE the write
    // transaction, from the row as it exists there — not from `existing`, read
    // earlier. A snapshot taken outside this window could be beaten by a concurrent
    // delete and record content that is not what the edit actually overwrote.
    // better-sqlite3 is synchronous and SQLite serializes write transactions, so no
    // other writer can interleave. No-op unless an unresolved report names this note.
    //
    // The visibility gate is re-applied here too. `getRowOrThrow` above 404s a
    // quarantined or trashed note, but it read the row BEFORE this transaction
    // opened: a DM who quarantines the note in that window would not actually have
    // stopped the edit, which for a whisper under an open report is exactly the
    // "subject rewrites the words" move quarantine exists to block. Re-checked
    // against the row the write will touch, and matching getRowOrThrow's error
    // exactly — a quarantined note reads as nonexistent on every path, so this
    // refusal must not be the one place that confirms it is there.
    const row = this.db.transaction((tx) => {
      const [current] = tx.select().from(notes).where(eq(notes.id, id)).limit(1).all();
      if (!current || current.deletedAt != null || current.quarantinedAt != null) {
        throw new NotFoundException(`Note ${id} not found`);
      }
      this.moderation.snapshotNoteIfWatched(tx, current, 'pre_edit');
      const rows = tx
        .update(notes)
        .set({ ...input, recipientUserId, updatedAt: nowIso() })
        .where(eq(notes.id, id))
        .returning()
        .all();
      return rows[0];
    });

    // Commit an immutable prose version when the body changes (#157/#233/#813) — #157
    // cited notes.service by line as the prose being destroyed, so a clobbered note is
    // recoverable. The revision-read/restore endpoints are gated on the note's OWN
    // visibility + author (RevisionsController), never a blanket dm-gate, so history is
    // no redaction back-door. Mirrors the quests/npcs/locations commit-on-change pattern.
    //
    // Ordered AFTER the write transaction (as CommentsService.update already does) so
    // an edit the transaction REFUSES — a stale save, or the quarantine re-check above
    // — leaves no revision behind. A version tip recording prose that was never stored
    // is the same defect as an evidence snapshot for an edit that never happened.
    if (input.body !== undefined && input.body !== existing.body) {
      await this.revisions.commitProseVersion({
        entityType: 'note',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.body,
        nextProse: input.body,
        user,
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'note.update',
      entityType: 'note',
      entityId: id,
      campaignId: existing.campaignId,
    });
    // Notify the DM only on the transition into dm_shared (a private/party note the
    // author just shared up), not on every body edit of an already-shared note.
    if (row.visibility === 'dm_shared' && existing.visibility !== 'dm_shared') {
      await this.notifyDmsOfSharedNote(row, user);
    }
    // Broadcast to the party only on the transition INTO party_shared (#263), not on
    // every body edit of an already-shared note — mirrors the dm_shared guard above.
    if (row.visibility === 'party_shared' && existing.visibility !== 'party_shared') {
      await this.notifyPartyOfSharedNote(row, user);
    }
    // Ping the whisper target on the transition into whisper or a change of recipient
    // (not on every body edit of an already-whispered note). issue #127.
    if (
      row.visibility === 'whisper' &&
      (existing.visibility !== 'whisper' || existing.recipientUserId !== row.recipientUserId)
    ) {
      await this.notifyWhisperRecipient(row, user);
    }
    return this.toDomainWithEntityName(row);
  }

  /**
   * Soft-delete (trash) a note (issue #116) — reversible. Only the author may delete
   * (unchanged). We stamp `deleted_at` instead of removing the row: the note vanishes
   * from every read but survives for restore(). Same author-only gate applies to restore.
   */
  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    if (!canSee(existing, user, role)) throw new NotFoundException(`Note ${id} not found`);
    if (existing.authorUserId !== user.id) {
      throw new ForbiddenException('Only the author may delete this note');
    }
    // Issue #601: same atomic snapshot-then-mutate as update(). This is the sharper
    // case — an abuser racing a victim's report must not be able to delete the
    // whisper between the report reading it and the report recording it. The
    // quarantine/trash gate that `getRowOrThrow` applied to a pre-transaction read is
    // re-applied here against the row this write will touch, so a quarantine landing
    // in that window actually stops the delete instead of merely preceding it.
    const ts = nowIso();
    this.db.transaction((tx) => {
      const [current] = tx.select().from(notes).where(eq(notes.id, id)).limit(1).all();
      if (!current || current.deletedAt != null || current.quarantinedAt != null) {
        throw new NotFoundException(`Note ${id} not found`);
      }
      this.moderation.snapshotNoteIfWatched(tx, current, 'pre_delete');
      tx.update(notes).set({ deletedAt: ts, updatedAt: ts }).where(eq(notes.id, id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'note.delete',
      entityType: 'note',
      entityId: id,
      campaignId: existing.campaignId,
      detail: 'soft-delete (trashed)',
    });
  }

  /**
   * Restore a trashed note (issue #116) — clears `deleted_at`. Only the author may
   * restore. 404 if the note isn't in the trash.
   */
  async restore(id: number, user: RequestUser, role: Role): Promise<Note> {
    const existing = await this.getRowOrThrow(id, true);
    if (existing.deletedAt == null) throw new NotFoundException(`Note ${id} is not in the trash`);
    if (existing.authorUserId !== user.id) {
      throw new ForbiddenException('Only the author may restore this note');
    }
    // Issue #601: gate and write in one transaction, as in update()/remove(). Restore
    // is the sharpest of the three — it puts a withheld note back into view — so a
    // quarantine that landed after the `getRowOrThrow` above would otherwise be undone
    // by the very request it was taken to stop. 404, matching getRowOrThrow.
    const row = this.db.transaction((tx) => {
      const [current] = tx.select().from(notes).where(eq(notes.id, id)).limit(1).all();
      if (!current || current.quarantinedAt != null) throw new NotFoundException(`Note ${id} not found`);
      if (current.deletedAt == null) throw new NotFoundException(`Note ${id} is not in the trash`);
      const rows = tx
        .update(notes)
        .set({ deletedAt: null, updatedAt: nowIso() })
        .where(eq(notes.id, id))
        .returning()
        .all();
      return rows[0];
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'note.restore',
      entityType: 'note',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return this.toDomainWithEntityName(row);
  }

  /**
   * ANY role incl. viewer may post inbox items. `authorName` is always the authenticated
   * caller's own displayName/username — a client-supplied `input.authorName` (if the DTO
   * ever grows one) is intentionally ignored here, not trusted, since every inbox post
   * requires a real `requireMember()`-checked session/token (there's no anonymous path
   * that would need a caller-supplied display name in the first place).
   */
  async createInbox(campaignId: number, input: InboxCreateInput, user: RequestUser, role: Role): Promise<Note> {
    // Issue #597: an inbox submission is dm_shared and notifies every DM, so it is
    // outbound content and needs an interactive seat. Enforced here rather than only in
    // the controller because MCP's `submit_inbox_item` tool calls this method directly.
    await assertMayInteract(this.db, user, campaignId, role, 'post to the DM inbox');
    // Issue #601 parity with create(): a moderation silence must stop inbox posts too,
    // or the DM's own inbox becomes the one channel a silenced member can still use.
    await this.moderation.assertNotMuted(campaignId, user);
    const ts = nowIso();
    const row = this.db.transaction((tx) => {
      const current = tx
        .select({ displayName: users.displayName, username: users.username })
        .from(users)
        .where(eq(users.id, Number(user.id)))
        .limit(1)
        .get();
      return tx
        .insert(notes)
        .values({
        campaignId,
        authorUserId: user.id,
        authorName: current ? (current.displayName || current.username) : 'Deleted user',
        kind: 'inbox',
        visibility: 'dm_shared',
        entityType: null,
        entityId: null,
        body: input.body,
        resolved: false,
        resolvedNote: '',
        createdAt: ts,
        updatedAt: ts,
        })
        .returning()
        .get();
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'inbox.create',
      entityType: 'note',
      entityId: row.id,
      campaignId,
    });
    // Out-of-band: inbox create must not wait on DM fan-out latency (issue #832).
    // Errors are swallowed inside notifyDmsOfInboxSubmission.
    void this.currentAttributionUser(user)
      .then((notificationActor) => this.notifyDmsOfInboxSubmission(row, notificationActor))
      .catch(() => undefined);
    return toDomain(row);
  }

  /**
   * DM inbox items (issue #608). Defaults to open (unresolved) items; pass
   * `resolved: true` for the resolved history.
   *
   * Returns a bounded newest-first page — never an unbounded array. Open items
   * order by id desc; resolved history by updatedAt desc, id desc (stable under
   * same-timestamp ties). Continue with `cursor` from a previous `nextCursor`.
   */
  async listInbox(
    campaignId: number,
    resolved = false,
    opts: { limit?: number; cursor?: string; countTotal?: boolean } = {},
  ): Promise<NoteListPage> {
    const limit = clampNotesListLimit(opts.limit);
    // Internal full-walkers (scribe/recap) pass countTotal:false — they never read `total`,
    // so skip the per-page COUNT(*) scan. Real paginated consumers keep an accurate total.
    const countFor = (conds: SQL[]): Promise<{ value: number }[]> =>
      opts.countTotal === false
        ? Promise.resolve([{ value: 0 }])
        : this.db.select({ value: count() }).from(notes).where(and(...conds));
    const baseConds = [
      eq(notes.campaignId, campaignId),
      eq(notes.kind, 'inbox'),
      eq(notes.resolved, resolved),
      notDeleted(notes.deletedAt),
      // Quarantined inbox submissions are withheld from the DM inbox too (#601) —
      // the queue is where a moderated one is handled, not the ordinary inbox.
      notDeleted(notes.quarantinedAt),
    ];

    if (resolved) {
      const cursor = decodeNotesCursor(opts.cursor, 'updated') as NotesUpdatedCursor | undefined;
      const keyset = cursor
        ? sql`(${notes.updatedAt} < ${cursor.u} OR (${notes.updatedAt} = ${cursor.u} AND ${notes.id} < ${cursor.i}))`
        : undefined;
      const conds = keyset ? [...baseConds, keyset] : baseConds;
      const [countRows, fetched] = await Promise.all([
        countFor(baseConds),
        this.db.select().from(notes).where(and(...conds)).orderBy(desc(notes.updatedAt), desc(notes.id)).limit(limit + 1),
      ]);
      const total = countRows[0]?.value ?? 0;
      const hasMore = fetched.length > limit;
      const rows = hasMore ? fetched.slice(0, limit) : fetched;
      const last = rows[rows.length - 1];
      const nextCursor =
        hasMore && last ? encodeNotesCursor({ v: 1, m: 'updated', u: last.updatedAt, i: last.id }) : null;
      return { items: rows.map((r) => toDomain(r)), total, hasMore, nextCursor, limit };
    }

    const cursor = decodeNotesCursor(opts.cursor, 'id') as NotesIdCursor | undefined;
    const keyset = cursor ? lt(notes.id, cursor.i) : undefined;
    const conds = keyset ? [...baseConds, keyset] : baseConds;
    const [countRows, fetched] = await Promise.all([
      countFor(baseConds),
      this.db.select().from(notes).where(and(...conds)).orderBy(desc(notes.id)).limit(limit + 1),
    ]);
    const total = countRows[0]?.value ?? 0;
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeNotesCursor({ v: 1, m: 'id', i: last.id }) : null;
    return { items: rows.map((r) => toDomain(r)), total, hasMore, nextCursor, limit };
  }

  /**
   * Walk every page of {@link listInbox} for internal full-set readers
   * (scribe / draft_session_recap). Not exposed over HTTP/MCP.
   */
  async listAllInbox(campaignId: number, resolved = false): Promise<Note[]> {
    const out: Note[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listInbox(campaignId, resolved, {
        limit: NOTES_LIST_MAX_LIMIT,
        cursor,
        countTotal: false,
      });
      out.push(...page.items);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /**
   * Resolving may link the entity the item became (entityType/entityId) — shown
   * in the resolved-history view. The link is soft (not FK-validated), same as
   * regular note entity anchors.
   *
   * The canonical terminal result is the tuple (resolvedNote, entityType,
   * entityId). Repeating that exact tuple is idempotent and returns the stored
   * row; requesting a different tuple after resolution is a deterministic 409.
   * The unresolved -> resolved compare-and-set, audit row, and real submitter
   * notification share one synchronous better-sqlite3 transaction, so competing
   * DMs and retries can produce exactly one transition and one set of effects.
   */
  async resolveInbox(id: number, input: InboxResolveInput, user: RequestUser, role: Role): Promise<Note> {
    const existing = await this.getRowOrThrow(id);
    if (existing.kind !== 'inbox') throw new NotFoundException(`Inbox item ${id} not found`);
    const terminal = {
      resolvedNote: input.resolvedNote ?? '',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    };
    const ts = nowIso();

    const outcome = this.db.transaction((tx) => {
      const [row] = tx
        .update(notes)
        .set({ resolved: true, ...terminal, updatedAt: ts })
        .where(and(eq(notes.id, id), eq(notes.kind, 'inbox'), eq(notes.resolved, false), notDeleted(notes.deletedAt)))
        .returning()
        .all();

      if (!row) {
        const [current] = tx.select().from(notes).where(eq(notes.id, id)).limit(1).all();
        return { transitioned: false as const, row: current };
      }

      tx.insert(auditLog)
        .values({
          campaignId: row.campaignId,
          actor: auditActor(user),
          actorRole: role,
          action: 'inbox.resolve',
          entityType: 'note',
          entityId: id,
          detail: '',
          createdAt: ts,
        })
        .run();

      // Keep NotificationsService.notifyUser's existing semantics: synthetic
      // DEV_AUTH identities have no users row, and an actor is never notified
      // about their own action. Real submitters receive the reply atomically.
      const recipient = Number(row.authorUserId);
      if (Number.isInteger(recipient) && recipient > 0 && String(recipient) !== user.id) {
        // Authored-history attribution survives account deletion. Only insert
        // when the real user row still exists, matching notifyUser's former
        // best-effort behavior without letting a notification FK abort canon.
        const recipientExists = tx.select({ id: users.id }).from(users).where(eq(users.id, recipient)).limit(1).get();
        if (recipientExists) {
          try {
            tx.insert(notifications)
              .values({
                userId: recipient,
                campaignId: row.campaignId,
                type: 'note_reply',
                title: `${user.name || 'The DM'} resolved your inbox note`,
                body: row.resolvedNote ? excerpt(row.resolvedNote) : excerpt(row.body),
                entityType: null,
                entityId: null,
                actorName: user.name,
                readAt: null,
                createdAt: ts,
              })
              .run();
          } catch {
            // Match NotificationsService.notifyUser: notification delivery is
            // best-effort and must never roll back the canonical terminal
            // transition or its audit record.
          }
        }
      }

      return { transitioned: true as const, row };
    });

    const row = outcome.row;
    if (!row || row.kind !== 'inbox' || row.deletedAt != null) {
      throw new NotFoundException(`Inbox item ${id} not found`);
    }
    if (!outcome.transitioned) {
      const identical =
        row.resolved &&
        row.resolvedNote === terminal.resolvedNote &&
        row.entityType === terminal.entityType &&
        row.entityId === terminal.entityId;
      if (!identical) {
        throw new ConflictException(`Inbox item ${id} already has a different terminal result`);
      }
    }
    return toDomain(row);
  }
}

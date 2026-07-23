import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { NoteCreate, NoteUpdate, InboxCreate, InboxResolve, EntityType } from '@campfire/schema';
import type { Note, Role, PageParams } from '@campfire/schema';
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
import { applyPage } from '../../common/pagination';
import { foldForSearch, foldedIncludes } from '../../common/text-search';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, excerpt } from '../notifications/notifications.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

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
 * Can `user` see this note? private -> author only; dm_shared -> author+dm;
 * party_shared -> everyone; whisper -> author + the single targeted recipient + any
 * DM (oversight, so the whisper still enters the campaign record — issue #127). A
 * non-target, non-DM member must NEVER see a whisper, and this is the single
 * server-side chokepoint every read path (GET, list, MCP) funnels through.
 */
export function canSee(
  note: { authorUserId: string; visibility: string; recipientUserId?: string | null },
  user: RequestUser,
  role: Role,
): boolean {
  if (note.visibility === 'party_shared') return true;
  if (note.authorUserId === user.id) return true;
  if (note.visibility === 'dm_shared' && role === 'dm') return true;
  if (note.visibility === 'whisper') {
    if (note.recipientUserId === user.id) return true;
    if (role === 'dm') return true;
  }
  return false;
}

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly revisions: RevisionsService,
  ) {}

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
      this.logger.warn(
        `inbox_submitted notification fan-out failed for note ${row.id}: ${err instanceof Error ? err.message : err}`,
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

  async listForCampaign(
    campaignId: number,
    user: RequestUser,
    role: Role,
    filters: { entityType?: string; entityId?: number; mine?: boolean; q?: string; limit?: number; offset?: number },
  ): Promise<Note[]> {
    // Visibility is pushed into SQL (was a JS post-filter, issue #71) so limit/offset
    // page over the ACTUALLY-visible rows: party_shared to everyone, own notes always,
    // dm_shared additionally to a dm, and a whisper to its recipient (+ any dm). Mirrors
    // canSee() exactly — a non-target, non-dm member never even loads a whisper row.
    const visibility: SQL[] = [eq(notes.visibility, 'party_shared'), eq(notes.authorUserId, user.id)];
    if (role === 'dm') visibility.push(eq(notes.visibility, 'dm_shared'));
    visibility.push(and(eq(notes.visibility, 'whisper'), eq(notes.recipientUserId, user.id))!);
    if (role === 'dm') visibility.push(eq(notes.visibility, 'whisper'));

    const conds: SQL[] = [eq(notes.campaignId, campaignId), eq(notes.kind, 'note'), notDeleted(notes.deletedAt), or(...visibility)!];
    if (filters.entityType) conds.push(eq(notes.entityType, filters.entityType));
    if (filters.entityId !== undefined) conds.push(eq(notes.entityId, filters.entityId));
    if (filters.mine) conds.push(eq(notes.authorUserId, user.id));
    // Free-text search over note bodies (issue #65 / #624). Needle is folded with the
    // shared helper (NFKC + fixed-locale case fold). SQLite `lower()` is ASCII-only and
    // cannot see ß→ss / İ / accent case folds, so when `q` is set we fold-match in JS
    // then apply limit/offset — paging stays correct (#71) without relying on SQL lower().
    // Campaign-wide search (#64) loads notes without `q` and matches in memory the same way.
    const search = filters.q?.trim() ? foldForSearch(filters.q.trim()) : '';

    const page: PageParams = { limit: filters.limit, offset: filters.offset };
    let query = this.db
      .select()
      .from(notes)
      .where(and(...conds))
      .orderBy(asc(notes.id)) // deterministic order for stable paging (insertion order)
      .$dynamic();

    let visible: Array<typeof notes.$inferSelect>;
    if (search) {
      const all = await query;
      const matched = all.filter((r) => foldedIncludes(r.body, search));
      const offset = page.offset ?? 0;
      visible = page.limit !== undefined ? matched.slice(offset, offset + page.limit) : matched.slice(offset);
    } else {
      query = applyPage(query, page);
      visible = await query;
    }

    const names = await this.resolveEntityNames(campaignId, visible);
    const recipientNames = await this.resolveRecipientNames(visible);
    return visible.map((r) => toDomain(r, entityNameFor(r, names), this.recipientNameFor(r, recipientNames)));
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
          .where(and(eq(encounters.campaignId, campaignId), inArray(encounters.id, ids)));
      case 'faction':
        // Factions can be pinned by a note (issue #221) — resolve their display names.
        return this.db
          .select({ id: factions.id, name: factions.name })
          .from(factions)
          .where(and(eq(factions.campaignId, campaignId), inArray(factions.id, ids)));
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
    return row;
  }

  /** GET by id 404s (not 403) for hidden notes. */
  async getOrThrow(id: number, user: RequestUser, role: Role): Promise<Note> {
    const row = await this.getRowOrThrow(id);
    if (!canSee(row, user, role)) throw new NotFoundException(`Note ${id} not found`);
    return this.toDomainWithEntityName(row);
  }

  async create(campaignId: number, input: NoteCreateInput, user: RequestUser, role: Role): Promise<Note> {
    const ts = nowIso();
    const visibility = input.visibility ?? 'private';
    const recipientUserId = await this.resolveWhisperTarget(campaignId, visibility, input.recipientUserId);
    const [row] = await this.db
      .insert(notes)
      .values({
        campaignId,
        authorUserId: user.id,
        authorName: user.name,
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
      .returning();

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
      await this.revisions.commitProseVersion({
        entityType: 'note',
        entityId: row.id,
        campaignId,
        priorProse: '',
        nextProse: row.body,
        user,
      });
    }
    await this.notifyThreadAuthors(row, user);
    await this.notifyDmsOfSharedNote(row, user);
    await this.notifyPartyOfSharedNote(row, user);
    await this.notifyWhisperRecipient(row, user);
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

    // Commit an immutable prose version when the body changes (#157/#233/#813) — #157
    // cited notes.service by line as the prose being destroyed, so a clobbered note is
    // recoverable. The revision-read/restore endpoints are gated on the note's OWN
    // visibility + author (RevisionsController), never a blanket dm-gate, so history is
    // no redaction back-door. Mirrors the quests/npcs/locations commit-on-change pattern.
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

    // Recompute the whisper target from the RESULTING visibility + recipient: switching
    // away from whisper clears the recipient, switching into whisper (or re-targeting)
    // re-validates it against campaign membership. issue #127.
    const finalVisibility = input.visibility ?? existing.visibility;
    const finalRecipientRaw = 'recipientUserId' in input ? input.recipientUserId : existing.recipientUserId;
    const recipientUserId = await this.resolveWhisperTarget(existing.campaignId, finalVisibility, finalRecipientRaw);

    const [row] = await this.db
      .update(notes)
      .set({ ...input, recipientUserId, updatedAt: nowIso() })
      .where(eq(notes.id, id))
      .returning();

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
    await this.db.update(notes).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(notes.id, id));
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
    const [row] = await this.db
      .update(notes)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(eq(notes.id, id))
      .returning();
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
    const ts = nowIso();
    const [row] = await this.db
      .insert(notes)
      .values({
        campaignId,
        authorUserId: user.id,
        authorName: user.name,
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
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'inbox.create',
      entityType: 'note',
      entityId: row.id,
      campaignId,
    });
    await this.notifyDmsOfInboxSubmission(row, user);
    return toDomain(row);
  }

  /**
   * dm; inbox items. Defaults to open (unresolved) items; pass `resolved: true`
   * for the resolved history (newest resolution first).
   */
  async listInbox(campaignId: number, resolved = false, page?: PageParams): Promise<Note[]> {
    // Ordering pushed into SQL (was a JS sort) so limit/offset page correctly:
    // resolved history is newest-resolution-first (updatedAt desc); the open list
    // keeps insertion order (id asc). issue #71.
    let q = this.db
      .select()
      .from(notes)
      .where(and(eq(notes.campaignId, campaignId), eq(notes.kind, 'inbox'), eq(notes.resolved, resolved), notDeleted(notes.deletedAt)))
      .orderBy(resolved ? desc(notes.updatedAt) : asc(notes.id))
      .$dynamic();
    q = applyPage(q, page);
    const rows = await q;
    return rows.map((r) => toDomain(r));
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

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { NoteCreate, NoteUpdate, InboxCreate, InboxResolve, EntityType } from '@campfire/schema';
import type { Note, Role, PageParams } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, campaigns, characters, encounters, locations, notes, npcs, quests, sessions, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { applyPage } from '../../common/pagination';
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
function canSee(
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

    const conds: SQL[] = [eq(notes.campaignId, campaignId), eq(notes.kind, 'note'), or(...visibility)!];
    if (filters.entityType) conds.push(eq(notes.entityType, filters.entityType));
    if (filters.entityId !== undefined) conds.push(eq(notes.entityId, filters.entityId));
    if (filters.mine) conds.push(eq(notes.authorUserId, user.id));
    // Free-text search over note bodies (issue #65) — case-insensitive substring match,
    // pushed into SQL so it composes correctly with limit/offset paging (#71) rather than
    // filtering only the current page. Scoped to NOTES only (campaign-wide search is #64).
    const search = filters.q?.trim().toLowerCase();
    if (search) conds.push(sql`lower(${notes.body}) like ${'%' + search + '%'}`);

    const page: PageParams = { limit: filters.limit, offset: filters.offset };
    let query = this.db
      .select()
      .from(notes)
      .where(and(...conds))
      .orderBy(asc(notes.id)) // deterministic order for stable paging (insertion order)
      .$dynamic();
    query = applyPage(query, page);
    const visible = await query;

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
    switch (type) {
      case 'quest':
        return this.db
          .select({ id: quests.id, name: quests.title })
          .from(quests)
          .where(and(eq(quests.campaignId, campaignId), inArray(quests.id, ids)));
      case 'npc':
        return this.db
          .select({ id: npcs.id, name: npcs.name })
          .from(npcs)
          .where(and(eq(npcs.campaignId, campaignId), inArray(npcs.id, ids)));
      case 'location':
        return this.db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(and(eq(locations.campaignId, campaignId), inArray(locations.id, ids)));
      case 'character':
        return this.db
          .select({ id: characters.id, name: characters.name })
          .from(characters)
          .where(and(eq(characters.campaignId, campaignId), inArray(characters.id, ids)));
      case 'session': {
        const rows = await this.db
          .select({ id: sessions.id, title: sessions.title, number: sessions.number })
          .from(sessions)
          .where(and(eq(sessions.campaignId, campaignId), inArray(sessions.id, ids)));
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
    }
  }

  /** toDomain + entityName/recipientName resolution for a single row (get/create/update responses). */
  private async toDomainWithEntityName(row: typeof notes.$inferSelect): Promise<Note> {
    const names = await this.resolveEntityNames(row.campaignId, [row]);
    const recipientNames = await this.resolveRecipientNames([row]);
    return toDomain(row, entityNameFor(row, names), this.recipientNameFor(row, recipientNames));
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Note ${id} not found`);
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
    await this.notifyThreadAuthors(row, user);
    await this.notifyDmsOfSharedNote(row, user);
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
    // Notes get the concurrency guard but NOT the revision-history layer — their per-note
    // visibility/author-only model makes a generic revision endpoint a redaction hazard.
    this.revisions.assertNotStale(existing, opts?.expectedUpdatedAt);

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

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    if (!canSee(existing, user, role)) throw new NotFoundException(`Note ${id} not found`);
    if (existing.authorUserId !== user.id) {
      throw new ForbiddenException('Only the author may delete this note');
    }
    await this.db.delete(notes).where(eq(notes.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'note.delete',
      entityType: 'note',
      entityId: id,
      campaignId: existing.campaignId,
    });
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
      .where(and(eq(notes.campaignId, campaignId), eq(notes.kind, 'inbox'), eq(notes.resolved, resolved)))
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
   */
  async resolveInbox(id: number, input: InboxResolveInput, user: RequestUser, role: Role): Promise<Note> {
    const existing = await this.getRowOrThrow(id);
    if (existing.kind !== 'inbox') throw new NotFoundException(`Inbox item ${id} not found`);

    const [row] = await this.db
      .update(notes)
      .set({
        resolved: true,
        resolvedNote: input.resolvedNote ?? '',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        updatedAt: nowIso(),
      })
      .where(eq(notes.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'inbox.resolve',
      entityType: 'note',
      entityId: id,
      campaignId: existing.campaignId,
    });

    // The DM answering an inbox item is the "reply" the submitter is waiting on.
    await this.notifications.notifyUser(existing.authorUserId, existing.campaignId, user, {
      type: 'note_reply',
      title: `${user.name || 'The DM'} resolved your inbox note`,
      body: row.resolvedNote ? excerpt(row.resolvedNote) : excerpt(existing.body),
      actorName: user.name,
    });
    return toDomain(row);
  }
}

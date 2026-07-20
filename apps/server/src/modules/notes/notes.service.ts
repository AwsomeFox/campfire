import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { NoteCreate, NoteUpdate, InboxCreate, InboxResolve, EntityType } from '@campfire/schema';
import type { Note, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, characters, locations, notes, npcs, quests, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type NoteCreateInput = z.infer<typeof NoteCreate>;
type NoteUpdateInput = z.infer<typeof NoteUpdate>;
type InboxCreateInput = z.infer<typeof InboxCreate>;
type InboxResolveInput = z.infer<typeof InboxResolve>;
type EntityTypeValue = z.infer<typeof EntityType>;

function toDomain(row: typeof notes.$inferSelect, entityName: string | null = null): Note {
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

/** Can `user` see this note? private -> author only; dm_shared -> author+dm; party_shared -> everyone. */
function canSee(note: { authorUserId: string; visibility: string }, user: RequestUser, role: Role): boolean {
  if (note.visibility === 'party_shared') return true;
  if (note.authorUserId === user.id) return true;
  if (note.visibility === 'dm_shared' && role === 'dm') return true;
  return false;
}

@Injectable()
export class NotesService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForCampaign(
    campaignId: number,
    user: RequestUser,
    role: Role,
    filters: { entityType?: string; entityId?: number; mine?: boolean },
  ): Promise<Note[]> {
    const rows = await this.db.select().from(notes).where(eq(notes.campaignId, campaignId));
    let visible = rows.filter((r) => canSee(r, user, role) && r.kind === 'note');

    if (filters.entityType) visible = visible.filter((r) => r.entityType === filters.entityType);
    if (filters.entityId !== undefined) visible = visible.filter((r) => r.entityId === filters.entityId);
    if (filters.mine) visible = visible.filter((r) => r.authorUserId === user.id);

    const names = await this.resolveEntityNames(campaignId, visible);
    return visible.map((r) => toDomain(r, entityNameFor(r, names)));
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
    }
  }

  /** toDomain + entityName resolution for a single row (get/create/update responses). */
  private async toDomainWithEntityName(row: typeof notes.$inferSelect): Promise<Note> {
    const names = await this.resolveEntityNames(row.campaignId, [row]);
    return toDomain(row, entityNameFor(row, names));
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
    const [row] = await this.db
      .insert(notes)
      .values({
        campaignId,
        authorUserId: user.id,
        authorName: user.name,
        kind: 'note',
        visibility: input.visibility ?? 'private',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
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
    return this.toDomainWithEntityName(row);
  }

  /** author only; dm may NOT edit others' notes */
  async update(id: number, input: NoteUpdateInput, user: RequestUser, role: Role): Promise<Note> {
    const existing = await this.getRowOrThrow(id);
    if (!canSee(existing, user, role)) throw new NotFoundException(`Note ${id} not found`);
    if (existing.authorUserId !== user.id) {
      throw new ForbiddenException('Only the author may edit this note');
    }

    const [row] = await this.db
      .update(notes)
      .set({ ...input, updatedAt: nowIso() })
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

  /** dm; open (unresolved) inbox items */
  async listInbox(campaignId: number): Promise<Note[]> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.campaignId, campaignId), eq(notes.kind, 'inbox'), eq(notes.resolved, false)));
    return rows.map((r) => toDomain(r));
  }

  async resolveInbox(id: number, input: InboxResolveInput, user: RequestUser, role: Role): Promise<Note> {
    const existing = await this.getRowOrThrow(id);
    if (existing.kind !== 'inbox') throw new NotFoundException(`Inbox item ${id} not found`);

    const [row] = await this.db
      .update(notes)
      .set({ resolved: true, resolvedNote: input.resolvedNote ?? '', updatedAt: nowIso() })
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
    return toDomain(row);
  }
}

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { NoteCreate, NoteUpdate, InboxCreate, InboxResolve, EntityType } from '@campfire/schema';
import type { Note, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { notes } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type NoteCreateInput = z.infer<typeof NoteCreate>;
type NoteUpdateInput = z.infer<typeof NoteUpdate>;
type InboxCreateInput = z.infer<typeof InboxCreate>;
type InboxResolveInput = z.infer<typeof InboxResolve>;
type EntityTypeValue = z.infer<typeof EntityType>;

function toDomain(row: typeof notes.$inferSelect): Note {
  return {
    id: row.id,
    campaignId: row.campaignId,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    kind: row.kind as Note['kind'],
    visibility: row.visibility as Note['visibility'],
    entityType: row.entityType as EntityTypeValue | null,
    entityId: row.entityId,
    body: row.body,
    resolved: row.resolved,
    resolvedNote: row.resolvedNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

    return visible.map(toDomain);
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
    return toDomain(row);
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
    return toDomain(row);
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
    return toDomain(row);
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

  /** ANY role incl. viewer may post inbox items. */
  async createInbox(campaignId: number, input: InboxCreateInput, user: RequestUser, role: Role): Promise<Note> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(notes)
      .values({
        campaignId,
        authorUserId: user.id,
        authorName: input.authorName ?? user.name,
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
    return rows.map(toDomain);
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

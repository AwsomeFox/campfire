import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CharacterCreate, CharacterUpdate, HpPatch, ConditionsPatch } from '@campfire/schema';
import type { Character, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { characters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type CharacterCreateInput = z.infer<typeof CharacterCreate>;
type CharacterUpdateInput = z.infer<typeof CharacterUpdate>;
type HpPatchInput = z.infer<typeof HpPatch>;
type ConditionsPatchInput = z.infer<typeof ConditionsPatch>;

function toDomain(row: typeof characters.$inferSelect): Character {
  return {
    id: row.id,
    campaignId: row.campaignId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    species: row.species,
    className: row.className,
    level: row.level,
    background: row.background,
    stats: fromJsonText<Record<string, number>>(row.stats, {}),
    ac: row.ac,
    hpCurrent: row.hpCurrent,
    hpMax: row.hpMax,
    conditions: fromJsonText<string[]>(row.conditions, []),
    portraitUrl: row.portraitUrl,
    ddbId: row.ddbId,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class CharactersService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForCampaign(campaignId: number): Promise<Character[]> {
    const rows = await this.db.select().from(characters).where(eq(characters.campaignId, campaignId));
    return rows.map(toDomain);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(characters).where(eq(characters.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Character ${id} not found`);
    return row;
  }

  async getOrThrow(id: number): Promise<Character> {
    const row = await this.getRowOrThrow(id);
    return toDomain(row);
  }

  /** dm or owner may write; others 403 */
  assertCanWrite(row: { ownerUserId: string | null }, user: RequestUser, role: Role): void {
    if (role === 'dm') return;
    if (row.ownerUserId && row.ownerUserId === user.id) return;
    throw new ForbiddenException('Only dm or the owning player may modify this character');
  }

  async create(campaignId: number, input: CharacterCreateInput, user: RequestUser, role: Role): Promise<Character> {
    const ts = nowIso();
    // player creates own -> ownerUserId=user.id; dm may set ownerUserId explicitly
    const ownerUserId = role === 'dm' ? (input.ownerUserId ?? null) : user.id;

    const [row] = await this.db
      .insert(characters)
      .values({
        campaignId,
        ownerUserId,
        name: input.name,
        species: input.species ?? '',
        className: input.className ?? '',
        level: input.level ?? 1,
        background: input.background ?? '',
        stats: toJsonText(input.stats ?? {}),
        ac: input.ac ?? null,
        hpCurrent: input.hpCurrent ?? 10,
        hpMax: input.hpMax ?? 10,
        conditions: toJsonText(input.conditions ?? []),
        portraitUrl: input.portraitUrl ?? null,
        ddbId: input.ddbId ?? null,
        notes: input.notes ?? '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.create',
      entityType: 'character',
      entityId: row.id,
      campaignId,
    });
    return toDomain(row);
  }

  async update(id: number, input: CharacterUpdateInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    const update: Partial<typeof characters.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) update.name = input.name;
    if (input.species !== undefined) update.species = input.species;
    if (input.className !== undefined) update.className = input.className;
    if (input.level !== undefined) update.level = input.level;
    if (input.background !== undefined) update.background = input.background;
    if (input.stats !== undefined) update.stats = toJsonText(input.stats);
    if (input.ac !== undefined) update.ac = input.ac;
    if (input.hpCurrent !== undefined) update.hpCurrent = input.hpCurrent;
    if (input.hpMax !== undefined) update.hpMax = input.hpMax;
    if (input.conditions !== undefined) update.conditions = toJsonText(input.conditions);
    if (input.portraitUrl !== undefined) update.portraitUrl = input.portraitUrl;
    if (input.ddbId !== undefined) update.ddbId = input.ddbId;
    if (input.notes !== undefined) update.notes = input.notes;
    // Only dm may reassign ownership
    if (input.ownerUserId !== undefined && role === 'dm') update.ownerUserId = input.ownerUserId;

    const [row] = await this.db.update(characters).set(update).where(eq(characters.id, id)).returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.update',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return toDomain(row);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    // Deletion is a canon write -> dm only, enforced at controller
    await this.db.delete(characters).where(eq(characters.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.delete',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }

  async patchHp(id: number, patch: HpPatchInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    const hpMax = existing.hpMax;
    let hpCurrent: number;
    if ('delta' in patch) {
      hpCurrent = existing.hpCurrent + patch.delta;
    } else {
      hpCurrent = patch.set;
    }
    hpCurrent = Math.max(0, Math.min(hpMax, hpCurrent));

    const [row] = await this.db
      .update(characters)
      .set({ hpCurrent, updatedAt: nowIso() })
      .where(eq(characters.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.hp',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(patch),
    });
    return toDomain(row);
  }

  async patchConditions(id: number, patch: ConditionsPatchInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    const current = new Set(fromJsonText<string[]>(existing.conditions, []));
    for (const c of patch.remove ?? []) current.delete(c);
    for (const c of patch.add ?? []) current.add(c);

    const [row] = await this.db
      .update(characters)
      .set({ conditions: toJsonText([...current]), updatedAt: nowIso() })
      .where(eq(characters.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.conditions',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(patch),
    });
    return toDomain(row);
  }
}

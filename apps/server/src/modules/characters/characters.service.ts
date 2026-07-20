import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CharacterCreate, CharacterUpdate, HpPatch, ConditionsPatch, XpPatch, XpAward, LevelUp } from '@campfire/schema';
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
type XpPatchInput = z.infer<typeof XpPatch>;
type XpAwardInput = z.infer<typeof XpAward>;
type LevelUpInput = z.infer<typeof LevelUp>;

function toDomain(row: typeof characters.$inferSelect): Character {
  return {
    id: row.id,
    campaignId: row.campaignId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    species: row.species,
    className: row.className,
    level: row.level,
    xp: row.xp,
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
        xp: input.xp ?? 0,
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
    if (input.xp !== undefined) update.xp = input.xp;
    if (input.background !== undefined) update.background = input.background;
    if (input.stats !== undefined) update.stats = toJsonText(input.stats);
    if (input.ac !== undefined) update.ac = input.ac;
    if (input.hpMax !== undefined) update.hpMax = input.hpMax;
    // Clamp to [0, finalHpMax] whenever either hp field is touched — mirrors patchHp's
    // clamp (and the combatant equivalent). Without this, PATCHing hpMax below the
    // standing hpCurrent (or hpCurrent above hpMax) would write an out-of-range value
    // verbatim, unlike every other HP-writing path in the app.
    if (input.hpCurrent !== undefined || input.hpMax !== undefined) {
      const finalHpMax = input.hpMax !== undefined ? input.hpMax : existing.hpMax;
      const rawHpCurrent = input.hpCurrent !== undefined ? input.hpCurrent : existing.hpCurrent;
      update.hpCurrent = Math.max(0, Math.min(finalHpMax, rawHpCurrent));
    }
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

  async patchXp(id: number, patch: XpPatchInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    // Mirrors patchHp: { delta } is relative, { set } absolute; XP never goes negative.
    let xp: number;
    if ('delta' in patch) {
      xp = existing.xp + patch.delta;
    } else {
      xp = patch.set;
    }
    xp = Math.max(0, xp);

    const [row] = await this.db
      .update(characters)
      .set({ xp, updatedAt: nowIso() })
      .where(eq(characters.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.xp',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(patch),
    });
    return toDomain(row);
  }

  /** DM party award: add `amount` XP to every campaign character (or just `characterIds`). Role gate (dm) enforced at controller. */
  async awardXp(campaignId: number, award: XpAwardInput, user: RequestUser, role: Role): Promise<Character[]> {
    const rows = await this.db.select().from(characters).where(eq(characters.campaignId, campaignId));
    let targets = rows;
    if (award.characterIds) {
      const wanted = new Set(award.characterIds);
      targets = rows.filter((r) => wanted.has(r.id));
      const foundIds = new Set(targets.map((r) => r.id));
      const missing = award.characterIds.filter((cid) => !foundIds.has(cid));
      if (missing.length > 0) {
        throw new BadRequestException(`Characters not in campaign ${campaignId}: ${missing.join(', ')}`);
      }
    }
    if (targets.length === 0) throw new BadRequestException('No characters to award XP to');

    const ts = nowIso();
    const updated: Character[] = [];
    for (const target of targets) {
      const [row] = await this.db
        .update(characters)
        .set({ xp: Math.max(0, target.xp + award.amount), updatedAt: ts })
        .where(eq(characters.id, target.id))
        .returning();
      updated.push(toDomain(row));
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.xp_award',
      entityType: 'character',
      entityId: targets[0].id,
      campaignId,
      detail: JSON.stringify({ amount: award.amount, characterIds: targets.map((t) => t.id) }),
    });
    return updated;
  }

  /**
   * Guided level-up: +1 level (never past 20), optionally raising hpMax; the
   * hit points gained are added to hpCurrent too (existing damage is kept),
   * then clamped to [0, newHpMax] like every other HP-writing path.
   * Deliberately not gated on XP thresholds — milestone campaigns level
   * without XP; the web UI surfaces the threshold advisory instead.
   */
  async levelUp(id: number, input: LevelUpInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);
    if (existing.level >= 20) throw new BadRequestException('Already at level 20 — there is no level 21');

    const update: Partial<typeof characters.$inferInsert> = { level: existing.level + 1, updatedAt: nowIso() };
    if (input.hpMax !== undefined) {
      const gained = input.hpMax - existing.hpMax;
      update.hpMax = input.hpMax;
      update.hpCurrent = Math.max(0, Math.min(input.hpMax, existing.hpCurrent + Math.max(0, gained)));
    }

    const [row] = await this.db.update(characters).set(update).where(eq(characters.id, id)).returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.levelup',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify({ level: row.level, ...(input.hpMax !== undefined ? { hpMax: input.hpMax } : {}) }),
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

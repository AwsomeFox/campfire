import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { CharacterCreate, CharacterUpdate, HpPatch, ConditionsPatch, SpellSlotPatch, XpPatch, XpAward, LevelUp, normalizeStats } from '@campfire/schema';
import type { Character, CharacterAction, Role, SkillRank, SpellSlotLevel } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { characters, combatants, encounters, campaignMembers } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { redactSecret, redactSecrets } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { parseDdbId, fetchDdbCharacter, mapDdbCharacter, type DdbFetch } from './ddb-importer';
import type { DdbCharacterImport } from '@campfire/schema';

type CharacterCreateInput = z.infer<typeof CharacterCreate>;
type CharacterUpdateInput = z.infer<typeof CharacterUpdate>;
type HpPatchInput = z.infer<typeof HpPatch>;
type ConditionsPatchInput = z.infer<typeof ConditionsPatch>;
type SpellSlotPatchInput = z.infer<typeof SpellSlotPatch>;
type XpPatchInput = z.infer<typeof XpPatch>;
type XpAwardInput = z.infer<typeof XpAward>;
type LevelUpInput = z.infer<typeof LevelUp>;

/**
 * Sane bounds for the two numeric combat fields, shared by every character write
 * path (create/update/patchHp/levelUp) so they can't drift (issue #112). Previously
 * `create()` alone wrote `hpCurrent`/`ac` verbatim while `update`/`patchHp`/combatant
 * HP all clamped, letting a create request persist e.g. hpCurrent:99999 or ac:-50.
 */
export const AC_MIN = 0;
export const AC_MAX = 40; // unarmored 10-ish through the highest achievable armor class

/** Clamp hpCurrent into [0, hpMax] — the invariant every HP-writing path enforces. */
export function clampHpCurrent(hpCurrent: number, hpMax: number): number {
  return Math.max(0, Math.min(hpMax, hpCurrent));
}

/** Bound AC into [AC_MIN, AC_MAX]; null (AC unset) passes through untouched. */
export function clampAc(ac: number | null | undefined): number | null {
  if (ac === null || ac === undefined) return null;
  return Math.max(AC_MIN, Math.min(AC_MAX, ac));
}

export function toDomain(row: typeof characters.$inferSelect): Character {
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
    // Fold to canonical uppercase keys so existing rows written with lowercase keys
    // (schema permits any case) still resolve on the sheet / initiative engine (issue #48).
    stats: normalizeStats(fromJsonText<Record<string, number>>(row.stats, {})),
    ac: row.ac,
    hpCurrent: row.hpCurrent,
    hpMax: row.hpMax,
    conditions: fromJsonText<string[]>(row.conditions, []),
    saveProficiencies: fromJsonText<Character['saveProficiencies']>(row.saveProficiencies, []),
    skills: fromJsonText<Record<string, SkillRank>>(row.skills, {}),
    actions: fromJsonText<CharacterAction[]>(row.actions, []),
    spellSlots: fromJsonText<Record<string, SpellSlotLevel>>(row.spellSlots, {}),
    portraitUrl: row.portraitUrl,
    ddbId: row.ddbId,
    notes: row.notes,
    dmSecret: row.dmSecret,
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

  async listForCampaign(campaignId: number, role: Role): Promise<Character[]> {
    const rows = await this.db.select().from(characters).where(eq(characters.campaignId, campaignId));
    return redactSecrets(rows.map(toDomain), role);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(characters).where(eq(characters.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Character ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Character> {
    const row = await this.getRowOrThrow(id);
    return redactSecret(toDomain(row), role);
  }

  /** dm or owner may write; others 403 */
  assertCanWrite(row: { ownerUserId: string | null }, user: RequestUser, role: Role): void {
    if (role === 'dm') return;
    if (row.ownerUserId && row.ownerUserId === user.id) return;
    throw new ForbiddenException('Only dm or the owning player may modify this character');
  }

  /**
   * Mirror a character's HP into the combatant rows that link back to it in any
   * still-live (not 'ended') encounter (issue #50). Combatant HP and character HP
   * were previously dual sources of truth with only one-way sync (combatant→character
   * at edit time and on end()), so a player healing on their sheet mid-fight had that
   * healing silently reverted when the DM ended the encounter — the stale combatant
   * row won. This closes the loop the other direction. Ended encounters are left
   * untouched (their combatant rows are a historical snapshot). hpCurrent is clamped
   * to the combatant's (possibly just-raised) hpMax, matching every other HP path.
   */
  private async syncActiveCombatants(characterId: number, hpCurrent: number, hpMax?: number): Promise<void> {
    const rows = await this.db
      .select({ combatant: combatants })
      .from(combatants)
      .innerJoin(encounters, eq(combatants.encounterId, encounters.id))
      .where(and(eq(combatants.characterId, characterId), ne(encounters.status, 'ended')));

    for (const { combatant } of rows) {
      const nextMax = hpMax ?? combatant.hpMax;
      const nextCurrent = clampHpCurrent(hpCurrent, nextMax);
      await this.db
        .update(combatants)
        .set({ hpCurrent: nextCurrent, hpMax: nextMax })
        .where(eq(combatants.id, combatant.id));
    }
  }

  /**
   * Import a character from a PUBLIC D&D Beyond sheet (issue #18). Resolves the numeric
   * character id from either `ddbId` or a character/share `url`, fetches the public
   * character-service JSON (unofficial, read-only — no auth, no private data), maps it to a
   * CharacterCreate, and creates it via the normal create() path so ownership, clamps and
   * audit all apply uniformly. Private/not-found sheets surface as clean 400/404 errors from
   * fetchDdbCharacter.
   *
   * The character-service base URL is read from `DDB_CHARACTER_SERVICE_BASE_URL` when set
   * (an e2e test points this at an in-process fake server, mirroring the Open5e `url`
   * override); otherwise the live service is used. `fetchImpl` is injectable for the same
   * reason. Neither is exposed on the API surface.
   */
  async importFromDdb(
    campaignId: number,
    input: DdbCharacterImport,
    user: RequestUser,
    role: Role,
    fetchImpl?: DdbFetch,
  ): Promise<Character> {
    const ddbId = parseDdbId(input.ddbId?.trim() || input.url?.trim() || '');
    const baseUrl = process.env.DDB_CHARACTER_SERVICE_BASE_URL || undefined;
    const data = await fetchDdbCharacter(ddbId, baseUrl, fetchImpl);
    const create = mapDdbCharacter(data);
    // The mapper never returns a ddbId that disagrees with the requested id, but pin the
    // source id we actually fetched so the stored ddbId is authoritative even if the sheet's
    // own `data.id` was absent.
    create.ddbId = ddbId;
    return this.create(campaignId, create, user, role);
  }

  async create(campaignId: number, input: CharacterCreateInput, user: RequestUser, role: Role): Promise<Character> {
    const ts = nowIso();
    // player creates own -> ownerUserId=user.id; dm may set ownerUserId explicitly
    const ownerUserId = role === 'dm' ? (input.ownerUserId ?? null) : user.id;

    // Clamp hpCurrent/ac at create time too — mirrors update/patchHp/combatant HP so an
    // out-of-range create (hpCurrent:99999, ac:-50) can't persist verbatim (issue #112).
    const hpMax = input.hpMax ?? 10;
    const hpCurrent = clampHpCurrent(input.hpCurrent ?? 10, hpMax);

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
        stats: toJsonText(normalizeStats(input.stats ?? {})),
        ac: clampAc(input.ac ?? null),
        hpCurrent,
        hpMax,
        conditions: toJsonText(input.conditions ?? []),
        saveProficiencies: toJsonText(input.saveProficiencies ?? []),
        skills: toJsonText(input.skills ?? {}),
        actions: toJsonText(input.actions ?? []),
        spellSlots: toJsonText(input.spellSlots ?? {}),
        portraitUrl: input.portraitUrl ?? null,
        ddbId: input.ddbId ?? null,
        notes: input.notes ?? '',
        // Only dm may seed the DM-only secret — a player creating their own
        // character can't smuggle content into a field they can never read back.
        dmSecret: role === 'dm' ? (input.dmSecret ?? '') : '',
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
    return redactSecret(toDomain(row), role);
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
    if (input.stats !== undefined) update.stats = toJsonText(normalizeStats(input.stats));
    if (input.ac !== undefined) update.ac = clampAc(input.ac);
    if (input.hpMax !== undefined) update.hpMax = input.hpMax;
    // Clamp to [0, finalHpMax] whenever either hp field is touched — mirrors patchHp's
    // clamp (and the combatant equivalent). Without this, PATCHing hpMax below the
    // standing hpCurrent (or hpCurrent above hpMax) would write an out-of-range value
    // verbatim, unlike every other HP-writing path in the app.
    if (input.hpCurrent !== undefined || input.hpMax !== undefined) {
      const finalHpMax = input.hpMax !== undefined ? input.hpMax : existing.hpMax;
      const rawHpCurrent = input.hpCurrent !== undefined ? input.hpCurrent : existing.hpCurrent;
      update.hpCurrent = clampHpCurrent(rawHpCurrent, finalHpMax);
    }
    if (input.conditions !== undefined) update.conditions = toJsonText(input.conditions);
    if (input.saveProficiencies !== undefined) update.saveProficiencies = toJsonText(input.saveProficiencies);
    if (input.skills !== undefined) update.skills = toJsonText(input.skills);
    if (input.actions !== undefined) update.actions = toJsonText(input.actions);
    // Clamp each level's `used` to [0, max] whenever slot maxima are rewritten —
    // mirrors the hpCurrent/hpMax clamp above and patchSpellSlots' clamp, so a
    // PATCH can never leave more slots spent than exist.
    if (input.spellSlots !== undefined) {
      const clamped: Record<string, SpellSlotLevel> = {};
      for (const [level, slot] of Object.entries(input.spellSlots)) {
        clamped[level] = { max: slot.max, used: Math.max(0, Math.min(slot.max, slot.used)) };
      }
      update.spellSlots = toJsonText(clamped);
    }
    if (input.portraitUrl !== undefined) update.portraitUrl = input.portraitUrl;
    if (input.ddbId !== undefined) update.ddbId = input.ddbId;
    if (input.notes !== undefined) update.notes = input.notes;
    // Only dm may reassign ownership
    if (input.ownerUserId !== undefined && role === 'dm') update.ownerUserId = input.ownerUserId;
    // Only dm may write the DM-only secret — the owning player can PATCH the rest
    // of the sheet, but this field is invisible to them (redacted on every read),
    // so a non-dm write is silently ignored, same as ownerUserId above.
    if (input.dmSecret !== undefined && role === 'dm') update.dmSecret = input.dmSecret;

    const [row] = await this.db.update(characters).set(update).where(eq(characters.id, id)).returning();

    // Mirror HP/hpMax edits (e.g. a mid-session level-up) into any live encounter's
    // combatant row (issue #50).
    if (input.hpCurrent !== undefined || input.hpMax !== undefined) {
      await this.syncActiveCombatants(id, row.hpCurrent, row.hpMax);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.update',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return redactSecret(toDomain(row), role);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    // Deletion is a canon write -> dm only, enforced at controller.
    // Unlink inbound references in the same transaction as the delete so nothing dangles
    // on a deleted character: the member's characterId link (campaignMembers.characterId,
    // whose denormalized join would otherwise point at a ghost) and any combatant row
    // (combatants.characterId — the combatant stays in the fight, just no longer HP-synced).
    this.db.transaction((tx) => {
      tx.update(campaignMembers).set({ characterId: null, updatedAt: nowIso() }).where(eq(campaignMembers.characterId, id)).run();
      tx.update(combatants).set({ characterId: null }).where(eq(combatants.characterId, id)).run();
      tx.delete(characters).where(eq(characters.id, id)).run();
    });
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
    hpCurrent = clampHpCurrent(hpCurrent, hpMax);

    const [row] = await this.db
      .update(characters)
      .set({ hpCurrent, updatedAt: nowIso() })
      .where(eq(characters.id, id))
      .returning();

    // Keep any live encounter's combatant row in sync (issue #50).
    await this.syncActiveCombatants(id, hpCurrent);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.hp',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(patch),
    });
    return redactSecret(toDomain(row), role);
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
      update.hpCurrent = clampHpCurrent(existing.hpCurrent + Math.max(0, gained), input.hpMax);
    }

    const [row] = await this.db.update(characters).set(update).where(eq(characters.id, id)).returning();

    // A mid-session level-up that raises hpMax should reflect on the combat tracker too (issue #50).
    if (input.hpMax !== undefined) {
      await this.syncActiveCombatants(id, row.hpCurrent, row.hpMax);
    }

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
    return redactSecret(toDomain(row), role);
  }

  /** Spend (+delta) or restore (-delta) slots at one spell level; `used` is clamped to [0, max]. */
  async patchSpellSlots(id: number, patch: SpellSlotPatchInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    const slots = fromJsonText<Record<string, SpellSlotLevel>>(existing.spellSlots, {});
    const key = String(patch.level);
    const slot = slots[key];
    if (!slot || slot.max <= 0) {
      throw new BadRequestException(`No spell slots at level ${patch.level} — set the level's max via PATCH spellSlots first`);
    }
    slots[key] = { max: slot.max, used: Math.max(0, Math.min(slot.max, slot.used + patch.delta)) };

    const [row] = await this.db
      .update(characters)
      .set({ spellSlots: toJsonText(slots), updatedAt: nowIso() })
      .where(eq(characters.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.spellSlots',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(patch),
    });
    return toDomain(row);
  }
}

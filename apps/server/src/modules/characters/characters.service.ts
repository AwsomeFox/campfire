import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { CharacterCreate, CharacterUpdate, HpPatch, ConditionsPatch, SpellSlotPatch, XpPatch, XpAward, LevelUp, normalizeStats, ruleSystemAdapter, ddbImportSupported } from '@campfire/schema';
import type { Character, CharacterAction, Role, SkillRank, SpellSlotLevel } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { auditLog, campaigns, characters, combatants, encounters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { fromJsonText, toJsonText } from '../../common/json';
import { redactSecret, redactSecrets } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { RevisionsService } from '../revisions/revisions.service';
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
    status: row.status as Character['status'],
    // Fold to canonical uppercase keys so existing rows written with lowercase keys
    // (schema permits any case) still resolve on the sheet / initiative engine (issue #48).
    stats: normalizeStats(fromJsonText<Record<string, number>>(row.stats, {})),
    ac: row.ac,
    hpCurrent: row.hpCurrent,
    hpMax: row.hpMax,
    // Issue #711: persistent echo of the combat death/temp-HP subsystem. The
    // encounter tracker is the source of truth during a fight; on /end these
    // fields are reconciled back onto the sheet so a dead PC stays dead and a
    // stable PC keeps its unconscious state between sessions.
    hpTemp: row.hpTemp,
    deathState: row.deathState as Character['deathState'],
    deathSaveSuccesses: row.deathSaveSuccesses,
    deathSaveFailures: row.deathSaveFailures,
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
    // Shared optimistic-concurrency guard (issue #157). Characters only consume the
    // `assertNotStale` tier here — the prose revision-history tier (record/list/restore)
    // does not apply, since a character sheet has no single prose column the way
    // quests/npcs/locations/sessions do. The CAS invariant alone closes the issue's
    // headline failure: a stale full-snapshot save can no longer silently clobber a
    // fresher edit (a live HP/level change, a DM-secret edit) from another tab/device.
    private readonly revisions: RevisionsService,
    // Thin SSE invalidation for run-session inline character cards (issue #421).
    private readonly events: CampaignEventsService,
  ) {}

  /** Issue #421: id-only sheet invalidation so encounter clients refetch without an encounterId. */
  private emitCharacterUpdated(campaignId: number, characterId: number, userId: string): void {
    this.events.emit({ type: 'character.updated', campaignId, characterId, userId });
  }

  async listForCampaign(campaignId: number, role: Role): Promise<Character[]> {
    const rows = await this.db.select().from(characters).where(and(eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)));
    return redactSecrets(rows.map(toDomain), role);
  }

  async getRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(characters).where(eq(characters.id, id)).limit(1);
    // A trashed character (soft-deleted, #116) reads as nonexistent unless includeDeleted (restore).
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Character ${id} not found`);
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
   * Resolve the campaign's RuleSystemAdapter (issue #535). `levelUp` reads the adapter's
   * `maxLevel` so the ceiling is sourced from the rule system (5e=20, 13th Age=10, an uncapped
   * OSR/Open Legend game=Infinity) instead of a hardcoded 5e `20`. Same resolution pattern as
   * the encounters service; falls back to the 5e adapter for an unrecognized/empty slug, so every
   * existing campaign keeps exactly the level-20 cap it had before.
   */
  private async adapterForCampaign(campaignId: number) {
    const [row] = await this.db
      .select({ ruleSystem: campaigns.ruleSystem })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    return ruleSystemAdapter(row?.ruleSystem);
  }

  /**
   * When a campaign has `dmControlsProgression` enabled (issue #270), XP awards and
   * level-ups are DM-only — a non-DM (even a character's owning player) is rejected.
   * When the flag is off (the default), this is a no-op and any owner may self-progress,
   * preserving the original behavior. Only called on the XP/level write paths.
   */
  private async assertProgressionAllowed(campaignId: number, role: Role): Promise<void> {
    if (role === 'dm') return;
    const [row] = await this.db
      .select({ dmControlsProgression: campaigns.dmControlsProgression })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (row?.dmControlsProgression) {
      throw new ForbiddenException('This campaign restricts XP awards and level-ups to the DM');
    }
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
  private async syncActiveCombatants(
    characterId: number,
    hpCurrent: number,
    hpMax?: number,
    opts?: { campaignId?: number },
  ): Promise<void> {
    const rows = await this.db
      .select({ combatant: combatants, campaignId: encounters.campaignId, encounterId: encounters.id })
      .from(combatants)
      .innerJoin(encounters, eq(combatants.encounterId, encounters.id))
      .where(and(eq(combatants.characterId, characterId), ne(encounters.status, 'ended')));

    const touchedEncounterIds = new Set<number>();
    let campaignId = opts?.campaignId;
    // Issue #466: when the sheet mirrors into a live combatant, stamp the sheet's
    // current updatedAt as the CAS token so a later re-end knows this sync.
    const [sheetMeta] = await this.db
      .select({ updatedAt: characters.updatedAt })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    const sheetSyncedUpdatedAt = sheetMeta?.updatedAt;
    for (const { combatant, campaignId: encCampaignId, encounterId } of rows) {
      const nextMax = hpMax ?? combatant.hpMax;
      const nextCurrent = clampHpCurrent(hpCurrent, nextMax);
      await this.db
        .update(combatants)
        .set({
          hpCurrent: nextCurrent,
          hpMax: nextMax,
          ...(sheetSyncedUpdatedAt != null ? { sheetSyncedUpdatedAt } : {}),
        })
        .where(eq(combatants.id, combatant.id));
      touchedEncounterIds.add(encounterId);
      campaignId ??= encCampaignId;
    }
    // Sheet HP mirrored into a live fight — push encounter.updated so trackers refresh
    // without waiting for the poll (pairs with character.updated for the inline card).
    if (campaignId != null) {
      for (const encounterId of touchedEncounterIds) {
        this.emitEncounterUpdatedIfVisible(campaignId, encounterId);
      }
    }
  }

  /**
   * Emit `encounter.updated` only while the encounter is still player-visible, so a
   * sheet HP/condition sync into a HIDDEN live encounter cannot leak that encounter's
   * existence onto the shared campaign SSE stream (#754). Mirrors
   * EncountersService.emitEncounterEvent's re-read-at-emit visibility gate, applied at
   * this producer too so every encounter-event path shares the same posture.
   */
  private emitEncounterUpdatedIfVisible(campaignId: number, encounterId: number): void {
    const current = this.db
      .select({ hidden: encounters.hidden })
      .from(encounters)
      .where(eq(encounters.id, encounterId))
      .get();
    // Fail closed (#754): if the row can't be read (e.g. deleted concurrently) treat
    // it as not-visible and skip — an "unknown" encounter must not re-introduce an
    // existence leak, and the signal is useless once the row is gone.
    if (!current || Boolean(current.hidden)) return;
    this.events.emit({ type: 'encounter.updated', campaignId, encounterId });
  }

  /**
   * Mirror a character's conditions into linked combatants in still-live encounters
   * (issue #486). Pair of EncountersService's combatant→sheet write-through: a sheet
   * `set_character_conditions` / patchConditions / PATCH conditions must show up on
   * the run-session tracker. Ended encounters keep their historical snapshot.
   * Overwrites the combatant's conditions array wholesale (last sheet write wins);
   * see EncountersService.updateCombatant for the full overlap-window contract.
   */
  private async syncActiveCombatantConditions(
    characterId: number,
    conditionsJson: string,
    opts?: { campaignId?: number },
  ): Promise<void> {
    const rows = await this.db
      .select({ combatant: combatants, campaignId: encounters.campaignId, encounterId: encounters.id })
      .from(combatants)
      .innerJoin(encounters, eq(combatants.encounterId, encounters.id))
      .where(and(eq(combatants.characterId, characterId), ne(encounters.status, 'ended')));

    const touchedEncounterIds = new Set<number>();
    let campaignId = opts?.campaignId;
    const [sheetMeta] = await this.db
      .select({ updatedAt: characters.updatedAt })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    const sheetSyncedUpdatedAt = sheetMeta?.updatedAt;
    for (const { combatant, campaignId: encCampaignId, encounterId } of rows) {
      await this.db
        .update(combatants)
        .set({
          conditions: conditionsJson,
          ...(sheetSyncedUpdatedAt != null ? { sheetSyncedUpdatedAt } : {}),
        })
        .where(eq(combatants.id, combatant.id));
      touchedEncounterIds.add(encounterId);
      campaignId ??= encCampaignId;
    }
    if (campaignId != null) {
      for (const encounterId of touchedEncounterIds) {
        this.emitEncounterUpdatedIfVisible(campaignId, encounterId);
      }
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
   * System compatibility (issue #714): a DDB sheet is a D&D-5e character (5e abilities, AC/HP
   * math, conditions, skills/saves), so importing it into a campaign running a different
   * system (Pathfinder, OSR, 13th Age, Open Legend) or a homebrew campaign with no explicit
   * pack would silently produce a character whose numbers belong to another game. The import
   * is therefore gated on `ddbImportSupported(ruleSystem)` — only an explicitly-5e campaign
   * is accepted. This runs BEFORE the DDB fetch so an incompatible campaign never reaches the
   * network, and it rejects a direct-API request that bypasses the (hiding) UI affordance.
   * When a non-5e system is supported in the future it will go through a field-by-field
   * conversion preview first (the issue calls that out explicitly); until then, reject.
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
    // System gate before any network/parse work — incompatible campaigns never reach DDB.
    const [campaign] = await this.db
      .select({ ruleSystem: campaigns.ruleSystem })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (!ddbImportSupported(campaign?.ruleSystem)) {
      throw new BadRequestException(
        "D&D Beyond import is only available for D&D 5e campaigns. " +
          'Switch the campaign’s rule system to the D&D 5e SRD, or create the character manually.',
      );
    }
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
        status: input.status ?? 'active',
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
    this.emitCharacterUpdated(campaignId, row.id, user.id);
    return redactSecret(toDomain(row), role);
  }

  /**
   * dm or the owning player may write; other players get 403. Only fields present in
   * `input` are written (a field-level patch, not a full-snapshot replace), and
   * dmSecret/ownerUserId narrow further to dm-only.
   *
   * Optimistic concurrency (issue #746): a character sheet is the classic blind
   * last-write-wins clobber victim — two tabs (or a player tab + a DM tab, or a
   * connected AI over MCP) both load the sheet, one applies a live HP/level change
   * or a DM-secret edit, and the other's stale full-snapshot save silently restores
   * the old HP max, level, status, or ability scores. Mirroring the quests/npcs/
   * locations/sessions/encounters CAS invariant (#157/#532), when the caller
   * supplies an `expectedUpdatedAt` that no longer matches the row's current
   * `updatedAt` the write is rejected with 409 Conflict before any mutation — so the
   * stale client can refetch and reapply instead of destroying the fresher edit.
   * Omitted => unconditional write (unchanged back-compat for any client that hasn't
   * opted in, including the proposal-applied path which never sends a guard).
   */
  async update(
    id: number,
    input: CharacterUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    // Optimistic concurrency (#746): 409 on a stale expectedUpdatedAt before any write.
    this.revisions.assertNotStale(existing, opts?.expectedUpdatedAt);
    this.assertCanWrite(existing, user, role);
    // Editing xp/level through the general PATCH is progression too — gate it the same
    // way as patchXp/levelUp so dmControlsProgression can't be bypassed here (issue #270).
    if (input.xp !== undefined || input.level !== undefined) {
      await this.assertProgressionAllowed(existing.campaignId, role);
    }

    const update: Partial<typeof characters.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) update.name = input.name;
    if (input.species !== undefined) update.species = input.species;
    if (input.className !== undefined) update.className = input.className;
    if (input.level !== undefined) update.level = input.level;
    if (input.xp !== undefined) update.xp = input.xp;
    if (input.background !== undefined) update.background = input.background;
    if (input.status !== undefined) update.status = input.status;
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
      await this.syncActiveCombatants(id, row.hpCurrent, row.hpMax, { campaignId: existing.campaignId });
    }
    // Issue #486: PATCH conditions must also land on the live tracker.
    if (input.conditions !== undefined) {
      await this.syncActiveCombatantConditions(id, row.conditions, { campaignId: existing.campaignId });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.update',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
    return redactSecret(toDomain(row), role);
  }

  /**
   * Soft-delete (trash) a character (issue #116) — reversible. dm or the owning player
   * may delete (issue #129, unchanged). We only stamp `deleted_at`: the character vanishes
   * from normal reads but survives for restore(). Unlike the old hard delete we deliberately
   * DON'T null the member's characterId link or detach live combatants — those are
   * irreversible mutations; they simply reference a now-hidden character until restore.
   */
  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);
    await this.db.update(characters).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(characters.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.delete',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: 'soft-delete (trashed)',
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
  }

  /** Restore a trashed character (issue #116) — clears `deleted_at`. dm/owner gate; 404 if not trashed. */
  async restore(id: number, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id, true);
    if (existing.deletedAt == null) throw new NotFoundException(`Character ${id} is not in the trash`);
    this.assertCanWrite(existing, user, role);
    const [row] = await this.db
      .update(characters)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(eq(characters.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.restore',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
    return redactSecret(toDomain(row), role);
  }

  async patchHp(id: number, patch: HpPatchInput, user: RequestUser, role: Role): Promise<Character> {
    // Read the latest committed value, apply the relative/absolute patch, and write it
    // back in one synchronous better-sqlite3 transaction. Keeping every operation in
    // the callback makes concurrent deltas compose instead of both computing from the
    // same pre-await row (issue #653; mirrors patchTreasury).
    let row!: typeof characters.$inferSelect;
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(characters).where(eq(characters.id, id)).limit(1).all();
      if (!fresh || fresh.deletedAt !== null) throw new NotFoundException(`Character ${id} not found`);
      this.assertCanWrite(fresh, user, role);

      const requested = 'delta' in patch ? fresh.hpCurrent + patch.delta : patch.set;
      const hpCurrent = clampHpCurrent(requested, fresh.hpMax);
      // Issue #711: make recovery/revival transitions explicit on the sheet, the
      // same way the combat engine does. Healing a downed character above 0 HP
      // revives them (deathState -> 'none', death-save counters reset); dropping
      // a healthy character to 0 HP from a sheet edit puts them 'dying'. This
      // keeps the persistent death-state echo self-consistent when a DM/player
      // adjusts HP outside an encounter instead of leaving a stale 'dead' flag
      // on a healed character or a stale 'none' on a freshly-dropped one.
      const hpSet: Partial<typeof characters.$inferInsert> = { hpCurrent, updatedAt: nowIso() };
      if (hpCurrent > 0 && fresh.deathState !== 'none') {
        hpSet.deathState = 'none';
        hpSet.deathSaveSuccesses = 0;
        hpSet.deathSaveFailures = 0;
        // A revived character is no longer 'dead' on the lifecycle either —
        // matches the encounter /end reconciliation (issue #711). Without this,
        // a DM healing a dead PC on the sheet would leave them excluded from
        // the next encounter's auto-add despite being alive again.
        if (fresh.status === 'dead') hpSet.status = 'active';
      } else if (hpCurrent === 0 && fresh.hpCurrent > 0 && fresh.deathState === 'none') {
        hpSet.deathState = 'dying';
        hpSet.deathSaveSuccesses = 0;
        hpSet.deathSaveFailures = 0;
      }
      const [updated] = tx
        .update(characters)
        .set(hpSet)
        .where(eq(characters.id, id))
        .returning()
        .all();
      row = updated;
    });

    // The transaction has committed before linked combatants are synchronized. Use the
    // exact row returned by that commit so the mirror and response agree.
    await this.syncActiveCombatants(id, row.hpCurrent, undefined, { campaignId: row.campaignId });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.hp',
      entityType: 'character',
      entityId: id,
      campaignId: row.campaignId,
      detail: JSON.stringify(patch),
    });
    this.emitCharacterUpdated(row.campaignId, id, user.id);
    return redactSecret(toDomain(row), role);
  }

  async patchXp(id: number, patch: XpPatchInput, user: RequestUser, role: Role): Promise<Character> {
    // Same atomic read+compute+write contract as HP. The progression policy lookup is
    // synchronous in the same callback too, preserving the existing gate without an
    // await between the character read and its update.
    let row!: typeof characters.$inferSelect;
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(characters).where(eq(characters.id, id)).limit(1).all();
      if (!fresh || fresh.deletedAt !== null) throw new NotFoundException(`Character ${id} not found`);
      this.assertCanWrite(fresh, user, role);
      if (role !== 'dm') {
        const [campaign] = tx
          .select({ dmControlsProgression: campaigns.dmControlsProgression })
          .from(campaigns)
          .where(eq(campaigns.id, fresh.campaignId))
          .limit(1)
          .all();
        if (campaign?.dmControlsProgression) {
          throw new ForbiddenException('This campaign restricts XP awards and level-ups to the DM');
        }
      }

      // Mirrors patchHp: { delta } is relative, { set } absolute; XP never goes negative.
      const requested = 'delta' in patch ? fresh.xp + patch.delta : patch.set;
      const [updated] = tx
        .update(characters)
        .set({ xp: Math.max(0, requested), updatedAt: nowIso() })
        .where(eq(characters.id, id))
        .returning()
        .all();
      row = updated;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.xp',
      entityType: 'character',
      entityId: id,
      campaignId: row.campaignId,
      detail: JSON.stringify(patch),
    });
    this.emitCharacterUpdated(row.campaignId, id, user.id);
    return toDomain(row);
  }

  /**
   * DM party award. With no explicit ids, only active characters are recipients.
   * Non-active recipients require both an explicit selection and the
   * includeNonActive opt-in so an archived career cannot be changed accidentally.
   *
   * Target resolution, status validation, XP increments, and the audit snapshot all
   * run in one synchronous better-sqlite3 transaction. Reading each current XP value
   * inside that transaction prevents concurrent awards from losing an increment, and
   * a failed audit insert rolls the character updates back with it.
   */
  async awardXp(campaignId: number, award: XpAwardInput, user: RequestUser, role: Role): Promise<Character[]> {
    const ts = nowIso();
    const updated = this.db.transaction((tx) => {
      if (award.includeNonActive && !award.characterIds) {
        throw new BadRequestException('includeNonActive requires explicit characterIds');
      }
      const roster = tx
        .select()
        .from(characters)
        .where(and(eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)))
        .all();

      let targets: typeof roster;
      if (award.characterIds) {
        const byId = new Map(roster.map((row) => [row.id, row]));
        const missing = award.characterIds.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new BadRequestException(`Characters not in campaign ${campaignId}: ${missing.join(', ')}`);
        }
        // Preserve the caller's explicit order in the response and audit snapshot.
        targets = award.characterIds.map((id) => byId.get(id)!);
      } else {
        targets = roster.filter((row) => row.status === 'active');
      }

      const nonActive = targets.filter((row) => row.status !== 'active');
      if (nonActive.length > 0 && !award.includeNonActive) {
        throw new BadRequestException(
          `Explicit includeNonActive opt-in required for: ${nonActive.map((row) => `${row.id} (${row.status})`).join(', ')}`,
        );
      }
      if (targets.length === 0) {
        throw new BadRequestException(
          award.characterIds ? 'No characters to award XP to' : 'No active characters to award XP to',
        );
      }

      const changed = targets.map((target) => {
        const [row] = tx
          .update(characters)
          .set({ xp: sql`${characters.xp} + ${award.amount}`, updatedAt: ts })
          .where(eq(characters.id, target.id))
          .returning()
          .all();
        return row;
      });

      tx.insert(auditLog)
        .values({
          actor: auditActor(user),
          actorRole: role,
          action: 'character.xp_award',
          entityType: 'character',
          entityId: targets[0].id,
          campaignId,
          detail: JSON.stringify({
            amount: award.amount,
            recipients: targets.map((target, index) => ({
              characterId: target.id,
              name: target.name,
              status: target.status,
              xpBefore: target.xp,
              xpAfter: changed[index].xp,
            })),
          }),
          createdAt: ts,
        })
        .run();

      return changed.map(toDomain);
    });
    for (const character of updated) {
      this.emitCharacterUpdated(campaignId, character.id, user.id);
    }
    return updated;
  }

  /**
   * Guided level-up: +1 level (never past the rule system's cap), optionally raising hpMax;
   * the hit points gained are added to hpCurrent too (existing damage is kept), then clamped to
   * [0, newHpMax] like every other HP-writing path. Deliberately not gated on XP thresholds —
   * milestone campaigns level without XP; the web UI surfaces the threshold advisory instead.
   *
   * The cap is read from the campaign's RuleSystemAdapter (`adapter.maxLevel`, issue #535), so
   * 5e stays capped at 20, 13th Age caps at 10, and an uncapped system (Open Legend, an OSR
   * retroclone) reports `Infinity` and never rejects on the cap. Previously the 5e `20` was
   * hardcoded here, which wrongly capped every non-5e campaign at level 20.
   */
  async levelUp(id: number, input: LevelUpInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);
    await this.assertProgressionAllowed(existing.campaignId, role);
    const maxLevel = (await this.adapterForCampaign(existing.campaignId)).maxLevel;
    if (existing.level >= maxLevel) {
      // Name the system's actual ceiling in the message (e.g. "level 20" for 5e, "level 10"
      // for 13th Age). An Infinity cap (Open Legend, OSR retroclones) never reaches this branch.
      throw new BadRequestException(
        Number.isFinite(maxLevel)
          ? `Already at level ${maxLevel} — there is no level ${maxLevel + 1}`
          : 'Already at the maximum level for this rule system',
      );
    }

    const update: Partial<typeof characters.$inferInsert> = { level: existing.level + 1, updatedAt: nowIso() };
    if (input.hpMax !== undefined) {
      const gained = input.hpMax - existing.hpMax;
      update.hpMax = input.hpMax;
      update.hpCurrent = clampHpCurrent(existing.hpCurrent + Math.max(0, gained), input.hpMax);
    }

    const [row] = await this.db.update(characters).set(update).where(eq(characters.id, id)).returning();

    // A mid-session level-up that raises hpMax should reflect on the combat tracker too (issue #50).
    if (input.hpMax !== undefined) {
      await this.syncActiveCombatants(id, row.hpCurrent, row.hpMax, { campaignId: existing.campaignId });
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
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
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

    // Issue #486: sheet → live combatant so the run-session tracker shows Poisoned
    // the moment it is applied on the sheet (or via MCP set_character_conditions).
    await this.syncActiveCombatantConditions(id, row.conditions, { campaignId: existing.campaignId });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.conditions',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(patch),
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
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
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
    return toDomain(row);
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  CharacterCreate,
  CharacterUpdate,
  PartyCharacter,
  HpPatch,
  ConditionsPatch,
  SpellSlotPatch,
  XpPatch,
  XpAward,
  LevelUp,
  MAX_LEVEL,
  normalizeStats,
  ruleSystemAdapter,
  hpModelForAdapter,
  ddbImportSupported,
  resolveCharacterCreateStatus,
  // Issue #415: adapter-owned roll catalog — the single authoritative source for check math.
  checkCatalogForAdapter,
  findCheckInCatalog,
  checkRollExpr,
  formatCheckBreakdown,
  sortCheckCatalog,
  pf2eDegreeOfSuccess,
  // #1039 — the single definition of "how many slots remain" and when a spend must fail.
  applySpellSlotDelta,
  spellSlotsRemaining,
  // Rest mechanics (#1041): the pure planner. Nothing here rolls its own dice or touches the
  // database — the service plans, validates the WHOLE party, then writes once.
  describeRestForLog,
  planPartyRest,
  planPartyCustomRecovery,
  type PartyRecoveryRequest,
  type RestAdapter,
  type RestCharacterState,
  type RestConditionState,
  type RestKind,
  // #422/#1578 — the adapter-owned resource vocabulary (standard pools + the character's own
  // custom ones), so the surface never hardcodes one system's resource names.
  resourceVocabularyForAdapter,
  // #1643 — the adapter-owned leveled condition track (5e Exhaustion; PF2e has none).
  ConditionLevelPatch,
  leveledConditionTrackFor,
  STARFINDER_ADAPTER_ID,
} from '@campfire/schema';
import type {
  Character,
  ConditionInstance,
  CharacterAction,
  CharacterResource,
  Role,
  SkillRank,
  SpellSlotLevel,
  RollCheckDefinition,
  CheckRollRequest,
  CheckRollResponse,
  CheckRequest,
  CheckRequestCreate,
  CheckRequestResolution,
  AdapterResourceDef,
  DdbCharacterImport,
  ResourcePatch,
} from '@campfire/schema';
import { rollDice } from '../../common/dice';
import { RollsService } from '../rolls/rolls.service';
import { DB, type DrizzleDb } from '../../db/db.module';
import { auditLog, campaigns, characters, checkRequests, combatants, encounters, partyRestBatches } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { fromJsonText, toJsonText } from '../../common/json';
import {
  conditionWriteSetFromNames,
  conditionWriteSetMergingSheetStacks,
  legacyConditionInstance,
  readConditionInstances,
  sheetConditionWriteSetFromInstances,
  sheetConditionWriteSetFromNames,
} from '../../common/conditions';
import { redactSecret, redactSecrets } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { RevisionsService } from '../revisions/revisions.service';
// Issue #1479: assertCharacterWritable resolves campaign membership itself, so both the
// REST controller and every MCP tool that rolls/writes as a character can share ONE
// authority decision instead of hand-copying `requireMember`/`requireRole` at each site.
import { CampaignAccessService } from '../membership/campaign-access.service';
import { auditActor, roleAtLeast } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { parseDdbId, fetchDdbCharacter, mapDdbCharacter, type DdbFetch } from './ddb-importer';

type CharacterCreateInput = z.infer<typeof CharacterCreate>;
type SyncDb = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type CharacterUpdateInput = z.infer<typeof CharacterUpdate>;
type HpPatchInput = z.infer<typeof HpPatch>;
/** Stable object serialization for idempotency identity; object key order never changes the intent. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`; }
  return JSON.stringify(value);
}
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

/** Clamp a death-save success/failure tally into [0, 3] — the 5e death-save bound (issue #1492). */
export function clampDeathSaveCount(count: number): number {
  return Math.max(0, Math.min(3, count));
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
    eac: row.eac,
    kac: row.kac,
    hpCurrent: row.hpCurrent,
    hpMax: row.hpMax,
    spCurrent: row.spCurrent,
    spMax: row.spMax,
    rpCurrent: row.rpCurrent,
    rpMax: row.rpMax,
    // Issue #711: persistent echo of the combat death/temp-HP subsystem. The
    // encounter tracker is the source of truth during a fight; on /end these
    // fields are reconciled back onto the sheet so a dead PC stays dead and a
    // stable PC keeps its unconscious state between sessions.
    hpTemp: row.hpTemp,
    deathState: row.deathState as Character['deathState'],
    deathSaveSuccesses: row.deathSaveSuccesses,
    deathSaveFailures: row.deathSaveFailures,
    conditions: fromJsonText<string[]>(row.conditions, []),
    // Issue #1643: structured instances (so a client can read a leveled condition's
    // `stacks`, e.g. 5e Exhaustion), union-on-read same as the combatant side —
    // materialises a bare legacy name with no instance yet into one (stacks: 1).
    conditionInstances: readConditionInstances(row.conditionInstances, row.conditions),
    saveProficiencies: fromJsonText<Character['saveProficiencies']>(row.saveProficiencies, []),
    skills: fromJsonText<Record<string, SkillRank>>(row.skills, {}),
    actions: fromJsonText<CharacterAction[]>(row.actions, []),
    spellSlots: fromJsonText<Record<string, SpellSlotLevel>>(row.spellSlots, {}),
    resources: fromJsonText<Record<string, CharacterResource>>(row.resources, {}),
    portraitUrl: row.portraitUrl,
    ddbId: row.ddbId,
    notes: row.notes,
    dmSecret: row.dmSecret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Per-character outcome of a party rest (#1041). Counts + rolls, so a table can audit it. */
export interface RestPartyCharacterResult {
  characterId: number;
  name: string;
  hpBefore: number;
  hpAfter: number;
  hitDiceSpent: number;
  hitDiceRolls: number[];
  hitDiceRecovered: number;
  spellSlotLevelsRecovered: string[];
  resourcesRecovered: string[];
  conditionsCleared: string[];
  conditionsKept: string[];
  /** Conditions whose `stacks` the rest reduced by one rather than clearing (issue #1641). */
  conditionsDecremented: { name: string; stacksBefore: number; stacksAfter: number }[];
  logLine: string;
}

/** The result of one atomic party rest (#1041). */
export interface RestPartyResult {
  kind: RestKind;
  ruleSystem: string;
  characters: RestPartyCharacterResult[];
}
export interface PartyRecoveryApplyResult { batchId: number; kind: RestKind | 'custom'; ruleSystem: string; characterIds: number[]; }

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
    // Persistence for the shared dice log (issue #415): a catalog check roll lands in the
    // same feed as a manual /roll, so DM and players see one authoritative result.
    private readonly rolls: RollsService,
    // Issue #1479: assertCharacterWritable's membership half — the same service the
    // controller already uses, injected here so the seam can live in one place.
    private readonly access: CampaignAccessService,
  ) {}

  /** Issue #421: id-only sheet invalidation so encounter clients refetch without an encounterId. */
  private emitCharacterUpdated(campaignId: number, characterId: number, userId: string): void {
    this.events.emit({ type: 'character.updated', campaignId, characterId, userId });
  }

  /**
   * List only sheets the caller may read in full. Character sheets include private
   * mechanical state (actions, resources, and slots), so non-DMs receive their own
   * sheets only; UI filtering is not an authorization boundary.
   */
  async listForCampaign(campaignId: number, user: RequestUser, role: Role): Promise<Character[]> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(
        role === 'dm'
          ? and(eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt))
          : and(eq(characters.campaignId, campaignId), eq(characters.ownerUserId, user.id), notDeleted(characters.deletedAt)),
      );
    return redactSecrets(rows.map(toDomain), role);
  }

  /**
   * Return the table-safe roster used by campaign aggregates and cast displays.
   * This query is intentionally an explicit column allowlist rather than a redacted
   * `Character` row: it never loads private sheet mechanics or DM-only material.
   */
  async partyRosterForCampaign(campaignId: number): Promise<PartyCharacter[]> {
    const rows = await this.db
      .select({
        id: characters.id,
        name: characters.name,
        species: characters.species,
        className: characters.className,
        level: characters.level,
        status: characters.status,
        ac: characters.ac,
        hpCurrent: characters.hpCurrent,
        hpMax: characters.hpMax,
        conditions: characters.conditions,
        portraitUrl: characters.portraitUrl,
      })
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)));
    return rows.map((row) => PartyCharacter.parse({ ...row, conditions: fromJsonText<string[]>(row.conditions, []) }));
  }

  /**
   * Export-only read: {@link listForCampaign}'s rows, each carrying its resolved
   * `conditionInstances` (issue #1555 half B / #1667).
   *
   * `conditionInstances` is deliberately NOT on the public `Character` schema — the
   * general sheet API only exposes the legacy `conditions` name list, the same way it
   * did before #1047 added the structured column, so this does not widen
   * `CharacterCreate`/`CharacterUpdate` or any MCP tool's input shape. It is
   * EXPORT-SCOPED structured game state (the sheet-scoped counterpart to
   * `combatant.conditionInstances`, which IS public), attached only to the object this
   * method returns so `export-profiles.ts`'s `PLAYED_STATE_FIELDS.character` allowlist
   * has something to actually project. `readConditionInstances` is the same
   * union-on-read helper every other reader of this pair uses (common/conditions.ts),
   * so a legacy character with a NULL `condition_instances` column still exports a
   * faithful (bare, metadata-free) instance for every name in `conditions` rather than
   * an empty list.
   */
  async listForExport(campaignId: number, role: Role): Promise<Array<Character & { conditionInstances: ConditionInstance[] }>> {
    const rows = await this.db.select().from(characters).where(and(eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)));
    const withInstances = rows.map((row) => ({
      ...toDomain(row),
      conditionInstances: readConditionInstances(row.conditionInstances, row.conditions),
    }));
    return redactSecrets(withInstances, role);
  }

  async getRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(characters).where(eq(characters.id, id)).limit(1);
    // A trashed character (soft-deleted, #116) reads as nonexistent unless includeDeleted (restore).
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Character ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, user: RequestUser, role: Role): Promise<Character> {
    const row = await this.getRowOrThrow(id);
    if (role !== 'dm' && row.ownerUserId !== user.id) {
      throw new ForbiddenException('You may only view your own character sheet.');
    }
    return redactSecret(toDomain(row), role);
  }

  /**
   * Resolve the shared full-sheet read boundary for derived sheet data. Roll catalogs
   * and resource vocabularies expose private stats/mechanics, so membership alone is
   * insufficient even when the caller learned an id from the safe party roster.
   */
  async assertCharacterReadable(
    characterId: number,
    user: RequestUser,
  ): Promise<{ row: typeof characters.$inferSelect; role: Role }> {
    const row = await this.getRowOrThrow(characterId);
    const role = await this.access.requireMember(user, row.campaignId);
    if (role !== 'dm' && row.ownerUserId !== user.id) {
      throw new ForbiddenException('You may only view your own character sheet.');
    }
    return { row, role };
  }

  /** dm or owner may write; others 403 */
  assertCanWrite(row: { ownerUserId: string | null }, user: RequestUser, role: Role): void {
    if (role === 'dm') return;
    if (row.ownerUserId && String(row.ownerUserId) === String(user.id)) return;
    throw new ForbiddenException('Only dm or the owning player may modify this character');
  }

  /**
   * Issue #1479: the single seam for "may this caller roll/write as this character",
   * shared by the REST controller AND both MCP tools that mutate the shared dice log on
   * a character's behalf (`roll_check`, `saving_throw`). Each of those call sites used to
   * hand-roll its own membership check via `requireMember(..., { write: true })` — which
   * only asserts the CAMPAIGN accepts writes, not that the CALLER has write authority — so
   * a viewer (or a player who does not own the target character) could roll a check for
   * any character in the campaign and inject arbitrary text into the shared, persisted
   * dice log under that character's name. This resolves PLAYER-OR-ABOVE campaign
   * membership (viewers are rejected outright) and then narrows to dm-or-owner via
   * `assertCanWrite`, so a member who does not own the target character still gets a 403.
   */
  async assertCharacterWritable(
    characterId: number,
    user: RequestUser,
  ): Promise<{ row: typeof characters.$inferSelect; role: Role }> {
    const row = await this.getRowOrThrow(characterId);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    this.assertCanWrite(row, user, role);
    return { row, role };
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
   * Issue #415: the roll catalog for a character — every rollable check (ability checks,
   * skills incl. unproficient, saves, initiative) with an authoritative modifier and a
   * transparent breakdown, sourced from the campaign's RuleSystemAdapter. Favorites first.
   * The catalog derives authoritative private sheet mechanics (level/stats/saves/skills),
   * so callers must pass {@link assertCharacterReadable} before reaching this method.
   */
  async listChecks(id: number): Promise<RollCheckDefinition[]> {
    const row = await this.getRowOrThrow(id);
    const adapter = await this.adapterForCampaign(row.campaignId);
    return sortCheckCatalog(checkCatalogForAdapter(adapter, toDomain(row)));
  }

  /**
   * Issue #415: resolve and roll a catalog check server-side. The SERVER computes the
   * modifier + dice expression from the adapter catalog (the client only names a checkId and
   * a roll mode), rolls with the shared crypto roller, records the result to the campaign
   * dice log with a transparent breakdown label, and — for a system that reports degrees of
   * success (PF2e) with a DC — returns the degree. This is the same authoritative math the
   * character sheet and encounter card render, so no surface can drift.
   */
  async rollCheck(id: number, input: CheckRollRequest, user: RequestUser, role: Role): Promise<CheckRollResponse> {
    const row = await this.getRowOrThrow(id);
    // Issue #1479: this was the one write path in this file that skipped the dm-or-owner
    // gate every other character mutation asserts. Kept HERE (not only at the callers'
    // shared `assertCharacterWritable` seam) so `rollCheck` is safe against any future
    // caller too — same defense-in-depth pattern as `resolveCheckRequest` above.
    this.assertCanWrite(row, user, role);
    const adapter = await this.adapterForCampaign(row.campaignId);
    const character = toDomain(row);
    const def = findCheckInCatalog(adapter, character, input.checkId);
    if (!def) throw new NotFoundException(`No rollable check "${input.checkId}" for character ${id}`);

    const mode = input.mode ?? 'flat';
    const expr = checkRollExpr(def, mode);
    const result = rollDice(expr);
    const breakdownText = formatCheckBreakdown(def);
    // The dice-log label carries the label + transparent breakdown, so the shared feed and
    // the combat log show how the number was reached without any hidden-data leak. When a DM
    // attached consequence text (issue #415), it rides on the persisted label too — not just
    // the audit detail — so the shared dice log shows the stakes, matching the documented
    // "recorded with the roll" contract. Public copy only (no hidden-data leak).
    result.label =
      `${character.name} · ${def.label} (${breakdownText})` + (input.consequence ? ` — ${input.consequence}` : '');
    if (typeof input.dc === 'number') {
      result.dc = input.dc;
      result.success = result.total >= input.dc;
    }
    const persisted = await this.rolls.record(row.campaignId, result, user);

    // Degrees of success: PF2e steps a nat-20 up / nat-1 down. The natural die face is the
    // kept d20 (advantage/disadvantage) or the sole d20 of a flat roll.
    let degree: CheckRollResponse['degree'];
    if (def.supportsDegrees && typeof input.dc === 'number') {
      const naturalRoll = result.kept?.[0] ?? result.rolls[0];
      degree = pf2eDegreeOfSuccess(result.total, input.dc, naturalRoll);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'dice.roll',
      entityType: 'character',
      entityId: id,
      campaignId: row.campaignId,
      detail:
        `${result.label}: ${result.expr} = ${result.total}` +
        (result.dc != null ? ` vs DC ${result.dc} (${result.success ? 'success' : 'fail'}${degree ? `, ${degree}` : ''})` : '') +
        (input.consequence ? ` — consequence: ${input.consequence}` : ''),
    });

    return {
      check: {
        id: def.id,
        label: def.label,
        category: def.category,
        ability: def.ability,
        proficiency: def.proficiency,
        modifier: def.modifier,
        breakdown: def.breakdown.map((b) => ({ label: b.label, value: b.value })),
        breakdownText,
        ...(def.incomplete ? { incomplete: true } : {}),
      },
      mode,
      roll: persisted,
      ...(degree ? { degree } : {}),
    };
  }

  // ---------- DM-initiated check requests (issue #415) ----------
  // The interactive "DM asks selected players to roll a check/save" loop. A DM creates one
  // request per target character; the targeted player reads their pending request(s) over a
  // permission-checked REST read, rolls ONCE via the same rollCheck() path (dice log + audit +
  // breakdown/degree), and the row is marked resolved. The SSE ticks stay thin (ids only).

  private toCheckRequestDomain(row: typeof checkRequests.$inferSelect, characterName: string): CheckRequest {
    return {
      id: row.id,
      campaignId: row.campaignId,
      characterId: row.characterId,
      characterName,
      encounterId: row.encounterId ?? null,
      checkId: row.checkId,
      checkLabel: row.checkLabel,
      mode: row.mode as CheckRequest['mode'],
      dc: row.dc ?? null,
      consequence: row.consequence ? row.consequence : null,
      status: row.status as CheckRequest['status'],
      requestedByUserId: row.requestedByUserId,
      requestedByName: row.requestedByName,
      rollId: row.rollId ?? null,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt ?? null,
    };
  }

  /**
   * DM asks one or more target characters to roll `checkId` (issue #415). Validates the check
   * exists in EACH target's adapter-owned catalog (so a request can never name a check the sheet
   * can't roll), persists one row per character, and emits a thin `check.requested` tick per row
   * so each targeted player's client refetches and shows the prompt. Controller gates this to dm.
   */
  async requestChecks(campaignId: number, input: CheckRequestCreate, user: RequestUser, role: Role): Promise<CheckRequest[]> {
    const adapter = await this.adapterForCampaign(campaignId);
    const mode = input.mode ?? 'flat';
    const ts = nowIso();
    const created: CheckRequest[] = [];
    for (const characterId of input.characterIds) {
      const charRow = await this.getRowOrThrow(characterId);
      if (charRow.campaignId !== campaignId) {
        throw new BadRequestException(`Character ${characterId} is not in campaign ${campaignId}`);
      }
      const def = findCheckInCatalog(adapter, toDomain(charRow), input.checkId);
      if (!def) throw new NotFoundException(`No rollable check "${input.checkId}" for character ${characterId}`);
      const [row] = await this.db
        .insert(checkRequests)
        .values({
          campaignId,
          characterId,
          encounterId: input.encounterId ?? null,
          checkId: input.checkId,
          checkLabel: def.label,
          mode,
          dc: input.dc ?? null,
          consequence: input.consequence ?? '',
          status: 'pending',
          requestedByUserId: user.id,
          requestedByName: user.name ?? '',
          rollId: null,
          createdAt: ts,
          resolvedAt: null,
        })
        .returning();
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'check.request',
        entityType: 'character',
        entityId: characterId,
        campaignId,
        detail:
          `Requested ${def.label}` +
          (input.dc != null ? ` vs DC ${input.dc}` : '') +
          (input.consequence ? ` — consequence: ${input.consequence}` : ''),
      });
      this.events.emit({ type: 'check.requested', campaignId, requestId: row.id, characterId, userId: user.id });
      created.push(this.toCheckRequestDomain(row, charRow.name));
    }
    return created;
  }

  /**
   * List check requests visible to the caller (issue #415). The DM sees every request in the
   * campaign; a non-DM sees only requests targeting a character they OWN (the targeted player).
   * Optional `status` filter ('pending' | 'resolved'). Newest first.
   */
  async listCheckRequests(
    campaignId: number,
    user: RequestUser,
    role: Role,
    opts: { status?: CheckRequest['status'] } = {},
  ): Promise<CheckRequest[]> {
    // Visibility is pushed into the WHERE clause rather than filtered in memory (issue #415):
    // the DM sees every request in the campaign; a non-DM sees only requests targeting a
    // character they OWN. This scales with the caller's slice, not the whole campaign.
    const conditions = [eq(checkRequests.campaignId, campaignId)];
    if (opts.status) conditions.push(eq(checkRequests.status, opts.status));
    if (role !== 'dm') conditions.push(eq(characters.ownerUserId, user.id));
    const rows = await this.db
      .select({ req: checkRequests, characterName: characters.name })
      .from(checkRequests)
      .innerJoin(characters, eq(checkRequests.characterId, characters.id))
      .where(and(...conditions))
      .orderBy(desc(checkRequests.id));
    return rows.map((r) => this.toCheckRequestDomain(r.req, r.characterName));
  }

  private async getCheckRequestRowOrThrow(id: number) {
    const [row] = await this.db.select().from(checkRequests).where(eq(checkRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Check request ${id} not found`);
    return row;
  }

  /** The campaign a check request belongs to — so the controller can gate membership before resolving. */
  async campaignIdForCheckRequest(id: number): Promise<number> {
    const row = await this.getCheckRequestRowOrThrow(id);
    return row.campaignId;
  }

  /**
   * The targeted player (owner of the character) — or the DM — answers a pending check request
   * by rolling ONCE (issue #415). Reuses rollCheck() so the roll lands in the shared dice log
   * with a transparent breakdown, is audited, and returns the degree of success where the
   * system reports it. The DM's consequence text + DC ride through to the roll. The request is
   * then marked resolved (idempotency: a second attempt on a resolved row is a 400), and a thin
   * `check.resolved` tick lets the DM's client drop the pending row.
   */
  async resolveCheckRequest(id: number, user: RequestUser, role: Role): Promise<CheckRequestResolution> {
    const req = await this.getCheckRequestRowOrThrow(id);
    const charRow = await this.getRowOrThrow(req.characterId);
    // Issue #1636 defense in depth: `assertCanWrite` below is dm-or-owner, and
    // `ownerUserId` is untouched by a role change, so a member demoted from player to
    // viewer who owns this character would still pass it. The floor is placed HERE
    // rather than inside `assertCanWrite` itself, because that helper is shared by
    // roughly a dozen other call sites in this file (sheet field writes, HP, inventory,
    // etc.) that were not part of this issue's audit — widening its contract would be a
    // larger change than #1636 asks for. The REST/MCP callers already gate on
    // requireRole('player'); this keeps the service safe on its own too.
    if (!roleAtLeast(role, 'player')) {
      throw new ForbiddenException('Viewers may not answer check requests.');
    }
    // dm-or-owner may answer — same gate as writing the sheet.
    this.assertCanWrite(charRow, user, role);
    // Atomically CLAIM the request (pending -> resolved) BEFORE rolling so the "roll once"
    // invariant survives a race (DM + player double-click, retries): the conditional UPDATE
    // flips the row only if it is still pending, and exactly one racing caller gets a returned
    // row. A caller that loses the race (or a repeat on an already-answered row) gets a 400.
    const [claimed] = await this.db
      .update(checkRequests)
      .set({ status: 'resolved', resolvedAt: nowIso() })
      .where(and(eq(checkRequests.id, id), eq(checkRequests.status, 'pending')))
      .returning();
    if (!claimed) {
      throw new BadRequestException('This check request has already been answered');
    }
    // The claim guarantees this rolls at most once; link the resulting roll id back onto the row.
    const result = await this.rollCheck(
      req.characterId,
      {
        checkId: req.checkId,
        mode: (req.mode as CheckRollRequest['mode']) ?? 'flat',
        ...(req.dc != null ? { dc: req.dc } : {}),
        ...(req.consequence ? { consequence: req.consequence } : {}),
      },
      user,
      role,
    );
    const [updated] = await this.db
      .update(checkRequests)
      .set({ rollId: result.roll.id })
      .where(eq(checkRequests.id, id))
      .returning();
    this.events.emit({ type: 'check.resolved', campaignId: req.campaignId, requestId: id, characterId: req.characterId, userId: user.id });
    return { request: this.toCheckRequestDomain(updated, charRow.name), result };
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
   * Reject an absolute `level` above the campaign's adapter cap (issue #1492). `levelUp`
   * already honors `adapter.maxLevel` (5e=20, 13th Age=10, an uncapped system=Infinity), but
   * the general create()/update() PATCH paths could previously write any level that passed the
   * (now widened) schema bound, bypassing the per-system ceiling the DM sees in `levelUp`.
   * An `Infinity` cap (Open Legend, OSR retroclones) never rejects. Naming the cap in the
   * message matches `levelUp`'s rejection, so the two surfaces read identically.
   */
  private static assertLevelWithinCap(level: number, maxLevel: number): void {
    if (level > maxLevel) {
      throw new BadRequestException(
        Number.isFinite(maxLevel)
          ? `Level ${level} is above this rule system's cap of ${maxLevel}`
          : `Level ${level} is above this rule system's cap`,
      );
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
    opts?: {
      campaignId?: number;
      spCurrent?: number;
      spMax?: number;
      rpCurrent?: number;
      rpMax?: number;
      deathState?: string;
      deathSaveSuccesses?: number;
      deathSaveFailures?: number;
      hpTemp?: number;
    },
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
    // Keep the mirrored combatant write and its optimistic-concurrency revision in one
    // transaction. An undo removal uses that revision to decide whether it may exactly
    // restore a turn pointer, so exposing the sheet write before its revision would let an
    // undo incorrectly treat the encounter as unchanged.
    this.db.transaction((tx) => {
      for (const { combatant, campaignId: encCampaignId, encounterId } of rows) {
        const nextMax = hpMax ?? combatant.hpMax;
        const nextCurrent = clampHpCurrent(hpCurrent, nextMax);
        const updatePayload: Partial<typeof combatants.$inferInsert> = {
          hpCurrent: nextCurrent,
          hpMax: nextMax,
          ...(sheetSyncedUpdatedAt != null ? { sheetSyncedUpdatedAt } : {}),
        };
        if (opts?.spCurrent !== undefined) updatePayload.spCurrent = opts.spCurrent;
        if (opts?.spMax !== undefined) updatePayload.spMax = opts.spMax;
        if (opts?.rpCurrent !== undefined) updatePayload.rpCurrent = opts.rpCurrent;
        if (opts?.rpMax !== undefined) updatePayload.rpMax = opts.rpMax;
        // Issue #1492: mirror the full death/temp-HP slice a sheet PATCH can now write, so
        // reviving a downed PC mid-encounter (`deathState: 'none', deathSaveFailures: 0`)
        // keeps the live tracker consistent. Without this, the combatant keeps the stale
        // 'dead'/'dying' state after HP is mirrored, and /end's CAS write-back (which treats
        // the combatant slice as authoritative) silently reverts the revive onto the sheet.
        if (opts?.deathState !== undefined) updatePayload.deathState = opts.deathState;
        if (opts?.deathSaveSuccesses !== undefined) updatePayload.deathSaveSuccesses = opts.deathSaveSuccesses;
        if (opts?.deathSaveFailures !== undefined) updatePayload.deathSaveFailures = opts.deathSaveFailures;
        if (opts?.hpTemp !== undefined) updatePayload.hpTemp = opts.hpTemp;
        const mirrored = tx.update(combatants)
          .set(updatePayload)
          .where(eq(combatants.id, combatant.id))
          .run();
        // The candidate roster was read before this transaction. A concurrent removal
        // can therefore make this UPDATE a no-op; do not manufacture an encounter
        // revision for a combatant that was never mirrored. Undo uses this revision to
        // distinguish a real post-removal write from an unchanged removal window.
        if (mirrored.changes > 0) {
          touchedEncounterIds.add(encounterId);
          campaignId ??= encCampaignId;
        }
      }
      // Sheet HP mirrored into a live fight — push encounter.updated so trackers refresh
      // without waiting for the poll (pairs with character.updated for the inline card).
      for (const encounterId of touchedEncounterIds) {
        tx.update(encounters)
          .set({ combatantStateVersion: sql`${encounters.combatantStateVersion} + 1` })
          .where(and(eq(encounters.id, encounterId), eq(encounters.status, 'running')))
          .run();
      }
    });
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
    opts?: {
      campaignId?: number;
      /**
       * When set, the sheet already computed authoritative instances (including stacks).
       * Use stack-merging write so a level change (issue #1643) lands on the live tracker
       * instead of name-reconcile preserving stale stacks / inventing stacks: 1.
       */
      conditionInstancesJson?: string | null;
    },
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
    const sheetInstances =
      opts?.conditionInstancesJson !== undefined
        ? readConditionInstances(opts.conditionInstancesJson, conditionsJson)
        : null;
    // The condition mirror shares the same removal-undo revision guard as HP sync.
    this.db.transaction((tx) => {
      for (const { combatant, campaignId: encCampaignId, encounterId } of rows) {
        const mirrored = tx.update(combatants)
          .set({
            // Reconcile the structured copy too, or a sheet-side REMOVAL leaves its instance
            // behind and the next tracker write derives the condition straight back (#423 ×
            // #486). See common/conditions.ts.
            ...(sheetInstances != null
              ? conditionWriteSetMergingSheetStacks(sheetInstances, combatant.conditionInstances)
              : conditionWriteSetFromNames(
                  fromJsonText<string[]>(conditionsJson, []),
                  combatant.conditionInstances,
                )),
            ...(sheetSyncedUpdatedAt != null ? { sheetSyncedUpdatedAt } : {}),
          })
          .where(eq(combatants.id, combatant.id))
          .run();
        // As with HP sync, only a linked row that still exists warrants a new
        // encounter revision. The initial roster read can race a combatant removal.
        if (mirrored.changes > 0) {
          touchedEncounterIds.add(encounterId);
          campaignId ??= encCampaignId;
        }
      }
      for (const encounterId of touchedEncounterIds) {
        tx.update(encounters)
          .set({ combatantStateVersion: sql`${encounters.combatantStateVersion} + 1` })
          .where(and(eq(encounters.id, encounterId), eq(encounters.status, 'running')))
          .run();
      }
    });
    if (campaignId != null) {
      for (const encounterId of touchedEncounterIds) {
        this.emitEncounterUpdatedIfVisible(campaignId, encounterId);
      }
    }
  }

  /**
   * The party-recovery path needs the sheet and tracker copies to be one unit of
   * work.  The ordinary sync helpers are deliberately async/post-write for the
   * interactive patch paths; these small synchronous twins are for the single
   * recovery transaction only.  They return encounter ids so SSE can be emitted
   * after commit (never from a transaction that might roll back).
   */
  private syncRecoveryCombatantsInTx(tx: SyncDb, campaignId: number, characterId: number, hpCurrent: number, hpTemp: number, deathState: string, deathSaveSuccesses: number, deathSaveFailures: number, sheetInstances: readonly ConditionInstance[], sheetUpdatedAt: string): number[] {
    const rows = tx.select({ combatant: combatants, encounterId: encounters.id })
      .from(combatants).innerJoin(encounters, eq(combatants.encounterId, encounters.id))
      .where(and(eq(encounters.campaignId, campaignId), eq(combatants.characterId, characterId), eq(encounters.status, 'running'), notDeleted(encounters.deletedAt))).all();
    for (const { combatant } of rows) {
      tx.update(combatants).set({
        hpCurrent: clampHpCurrent(hpCurrent, combatant.hpMax), hpTemp, deathState, deathSaveSuccesses, deathSaveFailures,
        ...conditionWriteSetMergingSheetStacks(sheetInstances, combatant.conditionInstances),
        sheetSyncedUpdatedAt: sheetUpdatedAt,
      }).where(eq(combatants.id, combatant.id)).run();
    }
    for (const encounterId of new Set(rows.map((row) => row.encounterId))) {
      tx.update(encounters)
        .set({ combatantStateVersion: sql`${encounters.combatantStateVersion} + 1` })
        .where(and(eq(encounters.id, encounterId), eq(encounters.status, 'running')))
        .run();
    }
    return rows.map((row) => row.encounterId);
  }

  private recoveryConditionInstances(after: readonly RestConditionState[], priorJson: string | null, priorNamesJson: string): ConditionInstance[] {
    const prior = new Map(readConditionInstances(priorJson, priorNamesJson).map((instance) => [instance.name.trim().toLowerCase(), instance]));
    return after.flatMap((condition) => {
      const existing = prior.get(condition.name.trim().toLowerCase());
      const base = existing ?? legacyConditionInstance(condition.name);
      return base ? [{ ...base, stacks: condition.stacks }] : [];
    });
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

    const adapter = await this.adapterForCampaign(campaignId);
    const status = resolveCharacterCreateStatus(input, adapter);
    const isDraft = status === 'draft';
    // Issue #1492: enforce the adapter's level cap on the create path too, not just levelUp —
    // otherwise a direct POST bypasses the per-system ceiling (5e=20, 13th Age=10, …) that the
    // DM sees in levelUp. An Infinity cap (Open Legend, OSR) never rejects.
    if (input.level !== undefined) {
      CharactersService.assertLevelWithinCap(input.level, adapter.maxLevel);
    }

    // Clamp hpCurrent/ac at create time too — mirrors update/patchHp/combatant HP so an
    // out-of-range create (hpCurrent:99999, ac:-50) can't persist verbatim (issue #112).
    // Draft sheets start at 0 HP until the player fills them in (issue #719); non-drafts
    // without explicit HP keep the legacy 10/10 default for API back-compat.
    const hpMax = input.hpMax ?? (isDraft ? 0 : 10);
    const hpCurrent = clampHpCurrent(input.hpCurrent ?? (isDraft ? 0 : hpMax), Math.max(0, hpMax));
    // Issue #1492: write the death/temp-HP subsystem and bounded resources on CREATE too, not
    // just update(). CharacterCreate spreads these as valid optional keys, and MCP
    // upsert_character's create branch (mcp-tools.ts) parses CharacterCreate and lands here, so
    // a DM/AI creating a character with a starting death state or resource pool must not get a
    // 201 back while the row keeps schema defaults. Same clamps/validation as update(): hpTemp
    // >= 0, death saves in [0, 3], resources overspend rejected (#1039).
    const hpTemp = input.hpTemp !== undefined ? Math.max(0, input.hpTemp) : 0;
    const deathState = input.deathState ?? 'none';
    const deathSaveSuccesses =
      input.deathSaveSuccesses !== undefined ? clampDeathSaveCount(input.deathSaveSuccesses) : 0;
    const deathSaveFailures =
      input.deathSaveFailures !== undefined ? clampDeathSaveCount(input.deathSaveFailures) : 0;
    if (input.resources !== undefined) {
      for (const [key, resource] of Object.entries(input.resources)) {
        if (resource.used < 0 || resource.used > resource.max) {
          throw new BadRequestException(
            `Resource '${key}' overspend/overrestore: used (${resource.used}) must be in [0, max (${resource.max})]`,
          );
        }
      }
    }
    const resources = toJsonText(input.resources ?? {});

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
        status,
        stats: toJsonText(normalizeStats(input.stats ?? {})),
        ac: clampAc(input.ac ?? null),
        eac: clampAc(input.eac ?? null),
        kac: clampAc(input.kac ?? null),
        hpCurrent,
        hpMax,
        hpTemp,
        deathState,
        deathSaveSuccesses,
        deathSaveFailures,
        spCurrent: input.spCurrent ?? 0,
        spMax: input.spMax ?? 0,
        rpCurrent: input.rpCurrent ?? 0,
        rpMax: input.rpMax ?? 0,
        resources,
        ...sheetConditionWriteSetFromNames(input.conditions ?? [], null),
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
    // Issue #1492: enforce the adapter's level cap on the PATCH path too, not just levelUp.
    // `levelUp` already honors `adapter.maxLevel` (5e=20, 13th Age=10, …), but a direct PATCH
    // could otherwise write any level the (widened) schema bound allows, bypassing the ceiling.
    // Only an INCREASE above the cap is rejected: a sheet editor resends the current level on
    // every save, so a character already over the cap after a rule-system downgrade (5e → 13th
    // Age, cap 10) must still be editable for unrelated fields (name/notes). The character can't
    // be pushed HIGHER past the cap, and levelUp's own cap check still applies. An Infinity cap
    // (Open Legend, OSR) never rejects.
    if (input.level !== undefined && input.level > existing.level) {
      CharactersService.assertLevelWithinCap(input.level, (await this.adapterForCampaign(existing.campaignId)).maxLevel);
    }

    const update: Partial<typeof characters.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) update.name = input.name;
    if (input.species !== undefined) update.species = input.species;
    if (input.className !== undefined) update.className = input.className;
    if (input.level !== undefined) update.level = input.level;
    if (input.xp !== undefined) update.xp = input.xp;
    if (input.background !== undefined) update.background = input.background;
    if (input.status !== undefined) update.status = input.status;
    if (input.stats !== undefined) {
      update.stats = toJsonText({
        ...normalizeStats(fromJsonText<Record<string, number>>(existing.stats, {})),
        ...normalizeStats(input.stats),
      });
    }
    if (input.ac !== undefined) update.ac = clampAc(input.ac);
    if (input.eac !== undefined) update.eac = clampAc(input.eac);
    if (input.kac !== undefined) update.kac = clampAc(input.kac);
    if (input.hpMax !== undefined) update.hpMax = input.hpMax;
    if (input.spCurrent !== undefined) update.spCurrent = input.spCurrent;
    if (input.spMax !== undefined) update.spMax = input.spMax;
    if (input.rpCurrent !== undefined) update.rpCurrent = input.rpCurrent;
    if (input.rpMax !== undefined) update.rpMax = input.rpMax;
    // Clamp to [0, finalHpMax] whenever either hp field is touched — mirrors patchHp's
    // clamp (and the combatant equivalent). Without this, PATCHing hpMax below the
    // standing hpCurrent (or hpCurrent above hpMax) would write an out-of-range value
    // verbatim, unlike every other HP-writing path in the app.
    if (input.hpCurrent !== undefined || input.hpMax !== undefined) {
      const finalHpMax = input.hpMax !== undefined ? input.hpMax : existing.hpMax;
      const rawHpCurrent = input.hpCurrent !== undefined ? input.hpCurrent : existing.hpCurrent;
      update.hpCurrent = clampHpCurrent(rawHpCurrent, finalHpMax);
    }
    // Issue #1492: the death/temp-HP subsystem and bounded resources are valid CharacterUpdate
    // keys (the schema accepts them and MCP advertises them), but the field-copy block below
    // previously had NO references to them, so a PATCH that set them returned 200 and silently
    // dropped the change — a DM reviving a dead PC (`deathState: 'none', deathSaveFailures: 0`)
    // believed it worked while the row kept the old dead/dying state. Write them now, with the
    // same clamps every other write path uses (hpTemp >= 0, death saves in [0, 3]). The
    // encounter tracker stays the source of truth during a fight; on /end these reconcile back,
    // so a manual sheet PATCH is the out-of-combat path that was missing.
    if (input.hpTemp !== undefined) update.hpTemp = Math.max(0, input.hpTemp);
    if (input.deathState !== undefined) {
      update.deathState = input.deathState;
      // Synchronize the lifecycle status on a definitive death transition, matching patchHp
      // (issue #711) and the encounter /end reconciliation exactly:
      //   - `deathState: 'dead'` -> lifecycle status `'dead'` (so a sheet declaring a PC dead
      //     excludes them from future encounter auto-add, which selects only `active` PCs).
      //   - `deathState: 'none'` + positive HP on a previously-`dead` PC -> `'active'` (the
      //     revive). HP > 0 is required, matching /end's `revived = !dead && hpCurrent > 0`: a
      //     0-HP character cleared to `none` (e.g. a death-save reset) is not "alive" and must
      //     not become auto-addable. `dying`/`stable` carry no lifecycle flip — the death STATE
      //     lives in deathState, not status.
      // The auto-flip is GATED on `input.status === undefined` so an explicit caller choice
      // (e.g. reviving to `retired`/`inactive`) is never silently overwritten.
      if (input.status === undefined) {
        const finalHpCurrent = update.hpCurrent !== undefined ? update.hpCurrent : existing.hpCurrent;
        if (input.deathState === 'dead') {
          update.status = 'dead';
        } else if (input.deathState === 'none' && finalHpCurrent > 0 && existing.status === 'dead') {
          update.status = 'active';
        }
      }
    }
    // #1503 — death-save counters are a 5e construct. A sheet PATCH on a campaign whose adapter
    // has no death saves must not persist them (and then mirror them onto a live combatant),
    // matching EncountersService.updateCombatant's up-front rejection. existing.campaignId is
    // already in hand, so the adapter lookup is cheap. deathState itself stays writable — a DM
    // may legitimately mark a PC dead/dying on any system; only the 5e 3-success/3-failure
    // counters are gated.
    if (input.deathSaveSuccesses !== undefined || input.deathSaveFailures !== undefined) {
      const [deathCampaign] = this.db
        .select({ ruleSystem: campaigns.ruleSystem })
        .from(campaigns)
        .where(eq(campaigns.id, existing.campaignId))
        .limit(1)
        .all();
      const adapter = ruleSystemAdapter(deathCampaign?.ruleSystem);
      if (!hpModelForAdapter(adapter).deathSaves) {
        throw new BadRequestException(`Death saves are not supported for the ${adapter.id} ruleset`);
      }
    }
    if (input.deathSaveSuccesses !== undefined) {
      update.deathSaveSuccesses = clampDeathSaveCount(input.deathSaveSuccesses);
    }
    if (input.deathSaveFailures !== undefined) {
      update.deathSaveFailures = clampDeathSaveCount(input.deathSaveFailures);
    }
    // Reject a pool whose `used` is outside [0, max] rather than silently clamping it —
    // the dedicated POST :id/resources path throws on exactly this condition (issue #1039:
    // "spending a resource you do not have must fail loudly"), so an AI/caller cannot report
    // a successful spend that was never applied. The general PATCH shares that contract: a
    // silent clamp would return 200 after persisting a different pool than requested. A
    // negative `used` (over-restore) is rejected for the mirror reason.
    //
    // MERGE, not wholesale replace: the supplied pools are overlaid on the existing map AND each
    // supplied pool is field-merged over its existing entry, so a caller (notably MCP
    // `upsert_character`, which advertises `resources` as optional) that sends only one pool — or
    // only some fields of one pool (e.g. just `used`) — updates it without erasing the others or
    // the touched pool's `name`/`recharge` metadata. This matches the `stats` merge above and the
    // dedicated POST :id/resources path's single-pool-adjust semantic; the fields that ARE genuine
    // full-snapshot replaces (`skills`/`actions`/`spellSlots`) are documented as such, but
    // `resources` pools carry per-pool config the caller would not want to re-send on every edit.
    if (input.resources !== undefined) {
      for (const [key, resource] of Object.entries(input.resources)) {
        if (resource.used < 0 || resource.used > resource.max) {
          throw new BadRequestException(
            `Resource '${key}' overspend/overrestore: used (${resource.used}) must be in [0, max (${resource.max})]`,
          );
        }
      }
      const existingResources = fromJsonText<Record<string, CharacterResource>>(existing.resources, {});
      const merged: Record<string, CharacterResource> = { ...existingResources };
      // NOTE: `CharacterResource.used` carries a zod `.default(0)`, so a caller who omits `used`
      // on a supplied pool (e.g. a rename-only `{ ki: { max: 5, name: 'Renamed' } }`) has it
      // materialized to `0` by CharacterUpdate.parse BEFORE reaching this merge. The field-level
      // spread then writes that `0` over the existing `used`. A caller changing a pool MUST
      // therefore re-send `used` to preserve its current spend (the same "send the value you
      // want" contract the dedicated POST :id/resources path implies). A presence-preserving
      // partial-pool schema would fix this but is a larger schema change tracked separately.
      for (const [key, supplied] of Object.entries(input.resources)) {
        merged[key] = { ...(existingResources[key] ?? { max: supplied.max, used: 0 }), ...supplied };
      }
      update.resources = toJsonText(merged);
    }
    if (input.conditions !== undefined) {
      Object.assign(update, sheetConditionWriteSetFromNames(input.conditions, existing.conditionInstances));
    }
    if (input.saveProficiencies !== undefined) update.saveProficiencies = toJsonText(input.saveProficiencies);
    if (input.skills !== undefined) update.skills = toJsonText(input.skills);
    if (input.actions !== undefined) update.actions = toJsonText(input.actions);
    // Reject a level whose `used` is outside [0, max] rather than silently clamping it —
    // matches the resources branch above and the dedicated POST :id/spell-slots path
    // (issue #1039: an overspend must fail loudly, not report success for a different
    // write than requested). The general PATCH shares that spend-honesty contract.
    if (input.spellSlots !== undefined) {
      for (const [level, slot] of Object.entries(input.spellSlots)) {
        if (slot.used < 0 || slot.used > slot.max) {
          throw new BadRequestException(
            `Spell slot level ${level} overspend/overrestore: used (${slot.used}) must be in [0, max (${slot.max})]`,
          );
        }
      }
      update.spellSlots = toJsonText(input.spellSlots);
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
    // combatant row (issue #50). Issue #1492: a PATCH that writes the death/temp-HP slice
    // (a DM reviving a downed PC mid-fight) must mirror that slice into the live combatant
    // too, or /end's CAS write-back would treat the stale combatant slice as authoritative
    // and silently revert the revive. Thread the just-written row's slice so the tracker
    // (and the subsequent reconciliation) sees the same death state as the sheet.
    if (
      input.hpCurrent !== undefined ||
      input.hpMax !== undefined ||
      input.deathState !== undefined ||
      input.deathSaveSuccesses !== undefined ||
      input.deathSaveFailures !== undefined ||
      input.hpTemp !== undefined ||
      input.spCurrent !== undefined ||
      input.spMax !== undefined ||
      input.rpCurrent !== undefined ||
      input.rpMax !== undefined
    ) {
      // Only mirror hpMax when this PATCH actually supplied it; otherwise pass
      // undefined so a death-slice edit (deathState/death-saves/hpTemp) preserves
      // a DM-adjusted, encounter-local combatant hpMax that EncountersService
      // deliberately never writes back to the sheet (review on #1492). Each
      // death-slice field is threaded only when its input key was supplied too,
      // so an HP-only edit cannot push the sheet's stale deathState/death-saves/
      // hpTemp onto a live combatant (Devin review on #1492) — the combatant row
      // is authoritative during a fight and only reconciled on /end.
      await this.syncActiveCombatants(id, row.hpCurrent, input.hpMax !== undefined ? row.hpMax : undefined, {
        campaignId: existing.campaignId,
        ...(input.deathState !== undefined ? { deathState: row.deathState } : {}),
        ...(input.deathSaveSuccesses !== undefined ? { deathSaveSuccesses: row.deathSaveSuccesses } : {}),
        ...(input.deathSaveFailures !== undefined ? { deathSaveFailures: row.deathSaveFailures } : {}),
        ...(input.hpTemp !== undefined ? { hpTemp: row.hpTemp } : {}),
        ...(input.spCurrent !== undefined ? { spCurrent: row.spCurrent } : {}),
        ...(input.spMax !== undefined ? { spMax: row.spMax } : {}),
        ...(input.rpCurrent !== undefined ? { rpCurrent: row.rpCurrent } : {}),
        ...(input.rpMax !== undefined ? { rpMax: row.rpMax } : {}),
      });
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

      // #1503 — route the death model through the campaign's adapter so a system without 5e
      // death saves (Starfinder, PF2e, OSR, …) matches the combat engine: a character dropped
      // to 0 HP is simply "down", never auto-flagged 'dying' by a rule they don't use.
      const [deathCampaign] = tx
        .select({ ruleSystem: campaigns.ruleSystem })
        .from(campaigns)
        .where(eq(campaigns.id, fresh.campaignId))
        .limit(1)
        .all();
      const hpModel = hpModelForAdapter(ruleSystemAdapter(deathCampaign?.ruleSystem));
      const deathSavesSupported = hpModel.deathSaves;

      const requested = 'delta' in patch ? fresh.hpCurrent + patch.delta : patch.set;
      const hpCurrent = clampHpCurrent(requested, fresh.hpMax);
      // Issue #711: make recovery/revival transitions explicit on the sheet, the
      // same way the combat engine does. Healing a downed character above 0 HP
      // revives them (deathState -> 'none', death-save counters reset); dropping
      // a healthy character to 0 HP from a sheet edit puts them 'dying' — but only
      // for a system with 5e death saves (issue #1503): a system without them leaves
      // the character 'none' at 0 HP, matching applyCombatantHp. This keeps the
      // persistent death-state echo self-consistent when a DM/player adjusts HP
      // outside an encounter instead of leaving a stale 'dead' flag on a healed
      // character or a stale 'none' on a freshly-dropped one.
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
        // Systems with 5e death saves flag a freshly-dropped character 'dying' with a cleared
        // 3-success/3-failure tracker (issue #1503). A system with no downed concept at all
        // (PF2e/OSR/…) leaves deathState 'none'. A system that models its own dying state without
        // 5e death saves (Starfinder, hpModel.dyingAtZeroHp) is flagged 'dying' too — without the
        // counters — so the sheet agrees with applyCombatantHp and the Starfinder damage path
        // (Devin review #1812).
        if (deathSavesSupported) {
          hpSet.deathState = 'dying';
          hpSet.deathSaveSuccesses = 0;
          hpSet.deathSaveFailures = 0;
        } else if (hpModel.dyingAtZeroHp) {
          hpSet.deathState = 'dying';
        }
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

  /**
   * Starfinder-style stamina/night rest (SP/RP + HP-equal-to-level).
   *
   * #1041 NOTE — this method also accepted `'short'` and `'long'` and quietly treated them as
   * aliases for `'stamina'` / `'night'`. For a 5e table that meant `POST /characters/:id/rest
   * {"kind":"long"}` performed a SILENT PARTIAL rest: no spell slots, no class resources, no
   * conditions, and HP healed by level rather than to full. That is worse than the feature
   * being absent, because it looks like it worked.
   *
   * The two 5e-meaning words now delegate to the real rest engine ({@link restParty}), so one
   * endpoint no longer means two different things depending on which word you typed. The
   * Starfinder cadences keep their exact previous behaviour — that is a genuinely different
   * mechanic (it SPENDS a Resolve Point), not a worse spelling of a short rest.
   */
  async rest(id: number, restType: 'stamina' | 'night' | 'short' | 'long', user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);
    const adapter = await this.adapterForCampaign(existing.campaignId);

    if (restType === 'short' || restType === 'long' || (restType === 'night' && adapter.id !== STARFINDER_ADAPTER_ID)) {
      const kind: RestKind = restType === 'short' ? 'short' : 'long';
      await this.restParty(existing.campaignId, kind, [id], {}, user, role);
      return redactSecret(toDomain(await this.getRowOrThrow(id)), role);
    }

    const isStaminaRest = restType === 'stamina';
    let row!: typeof characters.$inferSelect;
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(characters).where(eq(characters.id, id)).limit(1).all();
      if (!fresh || fresh.deletedAt !== null) throw new NotFoundException(`Character ${id} not found`);

      if (isStaminaRest) {
        if (fresh.rpCurrent < 1) {
          throw new BadRequestException('Cannot take a Stamina Rest: requires at least 1 Resolve Point.');
        }
        const [updated] = tx
          .update(characters)
          .set({
            rpCurrent: Math.max(0, fresh.rpCurrent - 1),
            spCurrent: fresh.spMax,
            updatedAt: nowIso(),
          })
          .where(eq(characters.id, id))
          .returning()
          .all();
        row = updated;
      } else {
        const hpHealed = Math.min(fresh.hpMax - fresh.hpCurrent, Math.max(1, fresh.level));
        const [updated] = tx
          .update(characters)
          .set({
            spCurrent: fresh.spMax,
            rpCurrent: fresh.rpMax,
            hpCurrent: Math.min(fresh.hpMax, fresh.hpCurrent + hpHealed),
            deathState: fresh.hpCurrent + hpHealed > 0 ? 'none' : fresh.deathState,
            updatedAt: nowIso(),
          })
          .where(eq(characters.id, id))
          .returning()
          .all();
        row = updated;
      }
    });

    await this.syncActiveCombatants(id, row.hpCurrent, undefined, {
      campaignId: row.campaignId,
      spCurrent: row.spCurrent,
      spMax: row.spMax,
      rpCurrent: row.rpCurrent,
      rpMax: row.rpMax,
      deathState: row.deathState,
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.rest',
      entityType: 'character',
      entityId: id,
      campaignId: row.campaignId,
      detail: restType,
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
    return redactSecret(toDomain(row), role);
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
    return redactSecrets(updated, role);
  }

  /**
   * Guided level-up: +1 level (never past the rule system's cap), optionally raising hpMax;
   * the hit points gained are added to hpCurrent too (existing damage is kept), then clamped to
   * [0, newHpMax] like every other HP-writing path. Deliberately not gated on XP thresholds —
   * milestone campaigns level without XP; the web UI surfaces the threshold advisory instead.
   *
   * The cap is read from the campaign's RuleSystemAdapter (`adapter.maxLevel`, issue #535), so
   * 5e stays capped at 20, 13th Age caps at 10, and an uncapped system (Open Legend, an OSR
   * retroclone) reports `Infinity` and never rejects on the adapter cap. The shared schema's
   * own `MAX_LEVEL` ceiling still applies though (issue #1492): without it, an Infinity-cap
   * campaign leveling a level-99 PC to 100 would write a row the schema then rejects on the
   * next save — re-bricking the sheet exactly the way the old hardcoded 20 did. The effective
   * ceiling is therefore `min(adapter.maxLevel, MAX_LEVEL)`, so an uncapped system stops at
   * `MAX_LEVEL` and the per-system cap (20/10/…) stays authoritative for every bounded one.
   */
  async levelUp(id: number, input: LevelUpInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);
    await this.assertProgressionAllowed(existing.campaignId, role);
    const adapterMaxLevel = (await this.adapterForCampaign(existing.campaignId)).maxLevel;
    const maxLevel = Math.min(adapterMaxLevel, MAX_LEVEL);
    if (existing.level >= maxLevel) {
      // Name the effective ceiling in the message (e.g. "level 20" for 5e, "level 10" for
      // 13th Age, "level 99" for an uncapped system bumping the shared schema bound).
      throw new BadRequestException(`Already at level ${maxLevel} — there is no level ${maxLevel + 1}`);
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
    return redactSecret(toDomain(row), role);
  }

  async patchConditions(id: number, patch: ConditionsPatchInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    const current = new Set(fromJsonText<string[]>(existing.conditions, []));
    for (const c of patch.remove ?? []) current.delete(c);
    for (const c of patch.add ?? []) current.add(c);

    const [row] = await this.db
      .update(characters)
      .set({ ...sheetConditionWriteSetFromNames([...current], existing.conditionInstances), updatedAt: nowIso() })
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

  /**
   * Raise or lower the LEVEL of a leveled condition track (issue #1643) — e.g. 5e
   * Exhaustion — on a character sheet. `patchConditions` above only adds/removes a bare
   * name and PRESERVES whatever `stacks` an existing instance already has; there was no
   * path anywhere (REST, MCP, or the general character PATCH) that actually moved
   * `stacks`, on a character rather than a combatant. This is that path.
   *
   * Rule-system aware by construction: `patch.name` must match the CURRENT campaign
   * adapter's declared track (`leveledConditionTrackFor`), so a PF2e campaign (which
   * declares none) 400s on every call rather than silently accepting an arbitrary name at
   * an arbitrary cap — there is nothing here for it to level.
   *
   * Same delta/level-are-alternatives, never-a-silent-clamp shape as {@link adjustResource}
   * (#1039): `level` sets the level absolutely (applied first when both are sent), `delta`
   * adjusts relative to the CURRENT level, and a result outside [0, track.max] is a 400.
   * Level 0 removes the condition entirely — `ConditionInstance.stacks` itself requires
   * `stacks >= 1`, so "zero" has no on-disk representation as an instance.
   *
   * CONCURRENCY. The read of current stacks, the decision, and the write happen inside ONE
   * `this.db.transaction`, re-reading the row inside it (same pattern as adjustResource /
   * patchSpellSlots). Without that, two concurrent `delta: 1` calls both read level N and
   * both write N+1, losing an exhaustion increment.
   */
  async adjustConditionLevel(id: number, patch: ConditionLevelPatch, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    const adapter = await this.adapterForCampaign(existing.campaignId);
    const track = leveledConditionTrackFor(adapter.id);
    const wantedName = patch.name.trim();
    if (!track || track.name.toLowerCase() !== wantedName.toLowerCase()) {
      throw new BadRequestException(
        `'${wantedName}' is not a leveled condition track for this campaign's rule system (${adapter.label})`,
      );
    }

    const trackKey = track.name.toLowerCase();
    let currentLevel = 0;
    let nextLevel = 0;
    /**
     * #1073 / #1039 — READ, DECIDE AND WRITE IN ONE SYNCHRONOUS TRANSACTION.
     *
     * `existing` above still serves the permission check (not order-sensitive). The stacks
     * snapshot that the race turns on is re-read inside `tx`, matching adjustResource.
     */
    const row = this.db.transaction((tx) => {
      const fresh = tx.select().from(characters).where(eq(characters.id, id)).get();
      if (!fresh || fresh.deletedAt !== null) throw new NotFoundException(`Character ${id} not found`);

      const priorInstances = readConditionInstances(fresh.conditionInstances, fresh.conditions);
      const currentInstance = priorInstances.find((i) => i.name.trim().toLowerCase() === trackKey);
      currentLevel = currentInstance?.stacks ?? 0;
      nextLevel = patch.level !== undefined ? patch.level : currentLevel;
      if (patch.delta !== undefined) nextLevel += patch.delta;

      // Deliberately an ERROR, never a clamp (#1039): the same "never silently under- or
      // over-report a resource change" rule as adjustResource/patchSpellSlots. A clamp here
      // would let an AI narrate a 7th exhaustion level (or a -1'th) that never actually
      // landed on the sheet.
      if (nextLevel < 0 || nextLevel > track.max) {
        throw new BadRequestException(`${track.name} level (${nextLevel}) must be in [0, ${track.max}]`);
      }
      if (!currentInstance && nextLevel > 0 && priorInstances.length >= 50) {
        throw new BadRequestException(`${track.name} cannot be added because the character already has 50 condition instances`);
      }

      const nextInstances =
        nextLevel === 0
          ? priorInstances.filter((i) => i.name.trim().toLowerCase() !== trackKey)
          : currentInstance
            ? priorInstances.map((i) => (i === currentInstance ? { ...i, stacks: nextLevel } : i))
            : // `legacyConditionInstance` only returns null for an empty name; `track.name`
              // is always a non-empty constant ('Exhaustion'), so this cannot actually be null.
              [...priorInstances, { ...legacyConditionInstance(track.name)!, stacks: nextLevel }];
      const [written] = tx
        .update(characters)
        .set({ ...sheetConditionWriteSetFromInstances(nextInstances), updatedAt: nowIso() })
        .where(eq(characters.id, id))
        .returning()
        .all();
      return written;
    });

    // Issue #486 / #1643: sheet → live combatant with structured instances so stacks land
    // on the tracker (name-only reconcile would preserve stale stacks / invent stacks: 1).
    await this.syncActiveCombatantConditions(id, row.conditions, {
      campaignId: existing.campaignId,
      conditionInstancesJson: row.conditionInstances,
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.conditionLevel',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify({ name: track.name, from: currentLevel, to: nextLevel }),
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
    return redactSecret(toDomain(row), role);
  }

  /**
   * Spend (+delta) or restore (-delta) slots at one spell level (#1039).
   *
   * BEHAVIOUR CHANGE: an overspend now FAILS instead of clamping. Previously, casting at a
   * level with `used === max` returned 201 with an unchanged sheet — a confusing no-op for a
   * human clicking a pip, and the unlimited-casting hole for the AI DM, which reads a success
   * and narrates the spell as cast. Its sibling `adjustResource` (#422, thirty lines below)
   * has always thrown on the same condition; this brings the two into agreement, and the safe
   * one was not previously the one guarding spells.
   *
   * Restores still clamp at zero. See the asymmetry note in packages/schema/src/spell-slots.ts:
   * a restore cannot invent a slot, and `used = 0` is the state a long rest produces anyway.
   *
   * CONCURRENCY. The read, the decision, and the write happen inside ONE
   * `this.db.transaction`, and the row is RE-READ inside it rather than reusing the row fetched
   * for the permission check. better-sqlite3 runs a transaction synchronously to completion
   * with no JS yield, so two concurrent casts on the same character cannot interleave between
   * the read and the write within this process — the same single-process argument
   * `AiDmTranscriptService` documents for its `MAX(seq) + 1` allocation. The previous shape
   * (`getRowOrThrow` … `await db.update`) had an `await` between read and write, so two casts
   * resolving in the same turn silently lost one deduction, which is the same unlimited-casting
   * abuse arriving through the back door.
   *
   * A SQL-side `json_set` delta was the alternative. It was rejected because it cannot express
   * "fail when insufficient" in one statement — it would have to clamp, which is the bug.
   */
  async patchSpellSlots(id: number, patch: SpellSlotPatchInput, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    let row!: typeof characters.$inferSelect;
    let outcome!: ReturnType<typeof applySpellSlotDelta>;
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(characters).where(eq(characters.id, id)).limit(1).all();
      if (!fresh || fresh.deletedAt !== null) throw new NotFoundException(`Character ${id} not found`);

      const slots = fromJsonText<Record<string, SpellSlotLevel>>(fresh.spellSlots, {});
      outcome = applySpellSlotDelta(slots, patch.level, patch.delta);
      if (!outcome.ok) {
        // Thrown from INSIDE the transaction so the read is rolled back with the decision —
        // nothing is written on the failure path.
        throw new BadRequestException({
          code: outcome.reason,
          message: outcome.message,
          level: outcome.level,
          remaining: outcome.remaining,
          max: outcome.max,
        });
      }

      const [updated] = tx
        .update(characters)
        .set({ spellSlots: toJsonText(outcome.slots), updatedAt: nowIso() })
        .where(eq(characters.id, id))
        .returning()
        .all();
      row = updated;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.spellSlots',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify({
        ...patch,
        usedBefore: outcome.ok ? outcome.usedBefore : undefined,
        usedAfter: outcome.ok ? outcome.usedAfter : undefined,
        remaining: outcome.ok ? outcome.remaining : undefined,
      }),
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
    return redactSecret(toDomain(row), role);
  }

  /** Slots remaining at one level — read-only, for callers that want to check before spending. */
  async spellSlotsLeft(id: number, level: number): Promise<number> {
    const existing = await this.getRowOrThrow(id);
    return spellSlotsRemaining(fromJsonText<Record<string, SpellSlotLevel>>(existing.spellSlots, {}), level);
  }

  /**
   * The resource vocabulary for a character (issue #422/#1578): the campaign rule system's
   * STANDARD pools (5e `hitDice`/`rage`/`kiPoints`/`inspiration`, PF2e `focusPoints`/`heroPoints`,
   * …) plus whatever CUSTOM resources are already on this sheet, sourced from the campaign's
   * RuleSystemAdapter exactly like {@link listChecks} sources the roll catalog. This is how a
   * caller (REST client, MCP tool description, the sheet UI) discovers valid `key`s BEFORE
   * calling {@link adjustResource} — `adjustResource` itself stays open to an arbitrary key so a
   * homebrew resource is never blocked, but nothing should have to hardcode "hitDice, rage,
   * actionSurge, kiPoints" to know what a 5e character can have.
   */
  async listResourceVocabulary(id: number): Promise<AdapterResourceDef[]> {
    const row = await this.getRowOrThrow(id);
    const adapter = await this.adapterForCampaign(row.campaignId);
    return resourceVocabularyForAdapter(adapter, toDomain(row));
  }

  /** Spend, restore, or configure a bounded character resource (issue #422). */
  async adjustResource(id: number, patch: ResourcePatch, user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    /**
     * #1073 — READ, DECIDE AND WRITE IN ONE SYNCHRONOUS TRANSACTION.
     *
     * This used to read the row, compute the new `used` across an `await`, and write it back.
     * Two concurrent spends of the same resource both read `used: 0`, both decide `1`, and the
     * second write lands on the first: one spend is FREE. For a resource whose whole purpose is
     * that you pay for a reroll, a lost update is not a rounding error — it is the AI narrating
     * a reroll nobody paid for, which is the #1039 failure mode exactly.
     *
     * The row is re-read INSIDE the transaction (`tx`), not reused from the `existing` snapshot
     * above, because that snapshot is precisely the stale value the race turns on. `existing`
     * still serves the permission check, which is not order-sensitive. better-sqlite3 runs the
     * transaction synchronously to completion with no JS yield, so nothing can interleave.
     */
    const row = this.db.transaction((tx) => {
      const fresh = tx.select().from(characters).where(eq(characters.id, id)).get();
      if (!fresh) throw new NotFoundException(`Character ${id} not found`);

      const resources = fromJsonText<Record<string, { max: number; used: number; name?: string; recharge?: string }>>(fresh.resources, {});
      const current = resources[patch.key] ?? { max: patch.max ?? 1, used: 0, name: patch.name || patch.key, recharge: patch.recharge || 'long-rest' };

      const max = patch.max !== undefined ? Math.min(100, Math.max(0, patch.max)) : current.max;
      let used = patch.used !== undefined ? patch.used : current.used;
      if (patch.delta !== undefined) {
        used += patch.delta;
      }
      // Deliberately an ERROR, never a clamp (#1039): spending a resource you do not have must
      // fail loudly. A silent clamp to the bound would report success for a spend that never
      // happened, and the caller — increasingly an AI narrating the result — would describe an
      // effect it never paid for. Over-restoring is rejected for the mirror reason.
      if (used < 0 || used > max) {
        throw new BadRequestException(`Resource '${patch.key}' overspend/overrestore: resulting used (${used}) must be in [0, max (${max})]`);
      }

      resources[patch.key] = {
        max,
        used,
        name: patch.name ?? current.name ?? patch.key,
        recharge: patch.recharge ?? current.recharge ?? 'long-rest',
      };

      const [written] = tx
        .update(characters)
        .set({ resources: toJsonText(resources), updatedAt: nowIso() })
        .where(eq(characters.id, id))
        .returning()
        .all();
      return written;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.resource',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(patch),
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
    return redactSecret(toDomain(row), role);
  }

  /** Execute a short rest, long rest, or refocus on a character sheet (issue #422). */
  /**
   * Take a short or long rest for one or more characters, ATOMICALLY (issue #1041).
   *
   * Before this existed the AI DM had to set each character's HP, reset each spell-slot level,
   * and clear each condition with its own tool call — dozens of writes with no transaction, so
   * a turn that ran out of steps or hit a policy refusal halfway left the party in a state no
   * single undo reversed.
   *
   * The contract is PLAN-THEN-APPLY, and the split is the whole point:
   *   1. read every character and PLAN the rest purely (no writes);
   *   2. if ANY character's plan failed — dead, unknown hit die, not enough hit dice — reject
   *      the entire call and write nothing. A party rest that healed three and rejected the
   *      fourth is exactly the non-atomic mess this tool exists to remove, reproduced inside it;
   *   3. apply every plan in ONE transaction;
   *   4. audit ONCE for the whole rest, and combat-log one line per character.
   *
   * Note the failure report lists EVERY problem, not just the first: a DM should learn about
   * all of them at once rather than discovering them one rejected call at a time.
   */
  async restParty(
    campaignId: number,
    kind: RestKind,
    characterIds: number[],
    perCharacter: Record<number, { spendHitDice?: number; hitDie?: number }>,
    user: RequestUser,
    role: Role,
  ): Promise<RestPartyResult> {
    if (characterIds.length === 0) {
      throw new BadRequestException('A rest needs at least one character.');
    }
    const adapter = (await this.adapterForCampaign(campaignId)) as unknown as RestAdapter;

    const rows = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    const missing = characterIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`No character ${missing.join(', ')} in campaign ${campaignId}.`);
    }
    // Permission is checked for EVERY character before anything is planned: a player resting
    // "the party" must not quietly rest characters they do not own.
    const targets = characterIds.map((id) => byId.get(id)!);
    for (const row of targets) this.assertCanWrite(row, user, role);

    // Issue #1641: a rest needs each condition's `stacks` (5e Exhaustion's LEVEL), not just its
    // bare name, to be able to decrement rather than clear it — `readConditionInstances` unions
    // the structured `conditionInstances` column with any bare `conditions` name that has no
    // instance yet (pre-#1047 rows), so this is complete even for a character never touched
    // since before that migration.
    const priorInstances = new Map(targets.map((row) => [row.id, readConditionInstances(row.conditionInstances, row.conditions)]));
    const states: RestCharacterState[] = targets.map((row) => ({
      id: row.id,
      name: row.name,
      level: row.level,
      hpCurrent: row.hpCurrent,
      hpMax: row.hpMax,
      hpTemp: row.hpTemp,
      deathState: row.deathState as RestCharacterState['deathState'],
      deathSaveSuccesses: row.deathSaveSuccesses,
      deathSaveFailures: row.deathSaveFailures,
      conditions: priorInstances.get(row.id)!.map((inst): RestConditionState => ({ name: inst.name, stacks: inst.stacks })),
      stats: fromJsonText<Record<string, number>>(row.stats, {}),
      spellSlots: fromJsonText<Record<string, SpellSlotLevel>>(row.spellSlots, {}),
      resources: fromJsonText<Record<string, CharacterResource>>(row.resources, {}),
    }));

    // Dice come from the shared roller, injected — the planner itself is deterministic and the
    // rolls are visible in the result, so a table can audit what a hit die actually rolled.
    const plan = planPartyRest(adapter, states, kind, perCharacter, (sides) => rollDice(`1d${sides}`).total);

    if (plan.failures.length > 0) {
      throw new BadRequestException({
        code: 'rest_not_applicable',
        message: `The ${kind} rest was not applied. ${plan.failures.map((f) => f.detail).join(' ')}`,
        failures: plan.failures,
      });
    }

    // Pre-existing defect fixed here, not introduced by #1641: this write used to set only the
    // legacy `conditions` name column and never touched `conditionInstances`, violating the
    // single-writer invariant documented in common/conditions.ts (its own audit grep —
    // `conditions: toJsonText` outside that file — would have caught it). Concretely: any rest
    // that cleared a condition left a stale instance behind in `conditionInstances`, so the
    // combat tracker / character-sheet level display (#1662) could still show a condition the
    // sheet itself claims is gone. #1641 cannot avoid touching this either way — a decremented
    // `stacks` value has nowhere honest to persist except that same structured column — so it is
    // fixed here rather than left half-migrated a second time.
    const nameKey = (name: string) => name.trim().toLowerCase();
    const at = nowIso();
    // Captured per character so the post-commit mirror loop below can pass the exact
    // instances just written — including any decremented `stacks` — to
    // syncActiveCombatantConditions, rather than recomputing them a second time (or
    // reconciling by name only, which was issue #1670 half B: see that call below).
    const nextInstancesByCharacter = new Map<number, ConditionInstance[]>();
    this.db.transaction((tx) => {
      for (const p of plan.plans) {
        const clearedSet = new Set(p.conditionsCleared.map(nameKey));
        const decrementedStacks = new Map(p.conditionsDecremented.map((d) => [nameKey(d.name), d.stacksAfter]));
        const nextInstances = (priorInstances.get(p.characterId) ?? [])
          .filter((inst) => !clearedSet.has(nameKey(inst.name)))
          .map((inst) => {
            const stacksAfter = decrementedStacks.get(nameKey(inst.name));
            return stacksAfter === undefined ? inst : { ...inst, stacks: stacksAfter };
          });
        nextInstancesByCharacter.set(p.characterId, nextInstances);
        const conditionWriteSet = sheetConditionWriteSetFromInstances(nextInstances);
        tx.update(characters)
          .set({
            hpCurrent: p.hpAfter,
            hpTemp: p.hpTempAfter,
            deathState: p.deathStateAfter,
            deathSaveSuccesses: p.deathSaveSuccessesAfter,
            deathSaveFailures: p.deathSaveFailuresAfter,
            ...conditionWriteSet,
            spellSlots: toJsonText(p.spellSlotsAfter),
            resources: toJsonText(p.resourcesAfter),
            updatedAt: at,
          })
          .where(eq(characters.id, p.characterId))
          .run();
      }
    });

    // Everything below is BEST-EFFORT bookkeeping that runs after the commit. A failed mirror
    // or log line must not roll back a rest the table has already been told about.
    for (const p of plan.plans) {
      // HP/death state and conditions mirror through the two existing seams (#50 / #486), so a
      // rest taken mid-encounter is reflected on the tracker exactly like a sheet edit.
      await this.syncActiveCombatants(p.characterId, p.hpAfter, undefined, {
        campaignId,
        deathState: p.deathStateAfter,
      }).catch(() => undefined);
      // Issue #1670 half B: pass the sheet's just-written instances (with decremented
      // `stacks`), the same way adjustConditionLevel does, so a rest mid-encounter
      // reconciles the linked combatant's LEVEL — not just presence/absence by name.
      // Before this fix a rest that dropped Exhaustion from 3 to 2 left the combat
      // tracker showing 3 until something else rewrote it.
      const restedInstances = nextInstancesByCharacter.get(p.characterId) ?? [];
      await this.syncActiveCombatantConditions(p.characterId, toJsonText(restedInstances.map((c) => c.name)), {
        campaignId,
        conditionInstancesJson: toJsonText(restedInstances),
      }).catch(() => undefined);
    }

    // ONE audit entry for the whole rest, not one per character — the rest is the event.
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: kind === 'long' ? 'character.rest.long' : 'character.rest.short',
      entityType: 'character',
      campaignId,
      detail: JSON.stringify({
        kind,
        ruleSystem: plan.ruleSystem,
        characterIds,
        hitDiceSpent: plan.plans.reduce((n, p) => n + p.hitDiceSpent, 0),
        conditionsCleared: plan.plans.flatMap((p) => p.conditionsCleared),
        conditionsKept: plan.plans.flatMap((p) => p.conditionsKept),
        conditionsDecremented: plan.plans.flatMap((p) => p.conditionsDecremented),
      }),
    });

    for (const p of plan.plans) {
      this.emitCharacterUpdated(campaignId, p.characterId, user.id);
    }

    return {
      kind,
      ruleSystem: plan.ruleSystem,
      characters: plan.plans.map((p) => ({
        characterId: p.characterId,
        name: p.characterName,
        hpBefore: p.hpBefore,
        hpAfter: p.hpAfter,
        hitDiceSpent: p.hitDiceSpent,
        hitDiceRolls: p.hitDiceRolls,
        hitDiceRecovered: p.hitDiceRecovered,
        spellSlotLevelsRecovered: p.spellSlotLevelsRecovered,
        resourcesRecovered: p.resourcesRecovered,
        conditionsCleared: p.conditionsCleared,
        // Surfaced deliberately: the DM must be able to see what a night's sleep did NOT fix
        // without diffing two sheets. See the allowlist rationale in packages/schema/src/rest.ts.
        conditionsKept: p.conditionsKept,
        conditionsDecremented: p.conditionsDecremented,
        logLine: describeRestForLog(p, kind),
      })),
    };
  }

  /**
   * DM-facing, persisted preview for the party-rest panel.  Dice are rolled at
   * preview time and the exact plan is stored, preventing an apply retry from
   * silently rolling a second, different short rest.
   */
  async previewPartyRecovery(campaignId: number, request: PartyRecoveryRequest, user: RequestUser, role: Role) {
    if (!roleAtLeast(role, 'dm')) throw new ForbiddenException('Only a DM can rest the party.');
    const adapter = (await this.adapterForCampaign(campaignId)) as unknown as RestAdapter;
    const rows = await this.db.select().from(characters).where(and(eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = request.characterIds.filter((id) => !byId.has(id));
    if (missing.length) throw new NotFoundException(`No character ${missing.join(', ')} in campaign ${campaignId}.`);
    const targets = request.characterIds.map((id) => byId.get(id)!);
    const states: RestCharacterState[] = targets.map((row) => ({
      id: row.id, name: row.name, level: row.level, hpCurrent: row.hpCurrent, hpMax: row.hpMax, hpTemp: row.hpTemp,
      deathState: row.deathState as RestCharacterState['deathState'], deathSaveSuccesses: row.deathSaveSuccesses,
      deathSaveFailures: row.deathSaveFailures, conditions: readConditionInstances(row.conditionInstances, row.conditions).map((instance): RestConditionState => ({ name: instance.name, stacks: instance.stacks })),
      stats: fromJsonText<Record<string, number>>(row.stats, {}), spellSlots: fromJsonText<Record<string, SpellSlotLevel>>(row.spellSlots, {}),
      resources: fromJsonText<Record<string, CharacterResource>>(row.resources, {}),
    }));
    const options = request.kind === 'short' ? Object.fromEntries(Object.entries(request.perCharacter).map(([id, value]) => [Number(id), value])) : {};
    const plan = request.kind === 'custom'
      ? planPartyCustomRecovery(adapter, states, request.customResourceKeys)
      : planPartyRest(adapter, states, request.kind, options, (sides) => rollDice(`1d${sides}`).total);
    if (request.kind === 'custom' && request.customResourceKeys.some((key) => !states.some((state) => key in state.resources))) {
      throw new BadRequestException('A selected custom resource does not exist on any participant.');
    }
    const previewToken = randomUUID();
    const linked = await this.db.select({ characterId: combatants.characterId }).from(combatants).innerJoin(encounters, eq(combatants.encounterId, encounters.id)).where(and(eq(encounters.campaignId, campaignId), eq(encounters.status, 'running'), notDeleted(encounters.deletedAt)));
    const runningCombatantCharacterIds = [...new Set(linked.map((row) => row.characterId).filter((id): id is number => id != null && request.characterIds.includes(id)))];
    const before = targets.map((row) => ({ id: row.id, updatedAt: row.updatedAt, hpCurrent: row.hpCurrent, hpTemp: row.hpTemp, deathState: row.deathState, deathSaveSuccesses: row.deathSaveSuccesses, deathSaveFailures: row.deathSaveFailures, conditions: row.conditions, conditionInstances: row.conditionInstances, spellSlots: row.spellSlots, resources: row.resources }));
    const fingerprint = createHash('sha256').update(canonicalJson({ actorUserId: user.id, campaignId, request })).digest('hex');
    await this.db.insert(partyRestBatches).values({ campaignId, actorUserId: user.id, previewToken, requestFingerprint: fingerprint, status: 'previewed', beforeJson: toJsonText(before), planJson: toJsonText(plan), createdAt: nowIso() });
    const deltas = plan.plans.map((item) => {
      const state = states.find((candidate) => candidate.id === item.characterId)!;
      return { characterId: item.characterId, name: item.characterName, hp: { before: item.hpBefore, after: item.hpAfter, tempBefore: state.hpTemp, tempAfter: item.hpTempAfter }, deathState: { before: state.deathState, after: item.deathStateAfter }, spellSlots: Object.fromEntries(Object.entries(item.spellSlotsAfter).filter(([key, value]) => state.spellSlots[key]?.used !== value.used).map(([key, value]) => [key, { before: state.spellSlots[key]?.used ?? 0, after: value.used }])), resources: Object.fromEntries(Object.entries(item.resourcesAfter).filter(([key, value]) => state.resources[key]?.used !== value.used).map(([key, value]) => [key, { before: state.resources[key]?.used ?? 0, after: value.used }])), conditionsCleared: item.conditionsCleared, conditionsKept: item.conditionsKept, hitDiceSpent: item.hitDiceSpent, hitDiceRolls: item.hitDiceRolls };
    });
    return { previewToken, request, ruleSystem: plan.ruleSystem, failures: plan.failures, characters: deltas, runningCombatantCharacterIds };
  }

  async applyPartyRecovery(campaignId: number, input: { previewToken: string; idempotencyKey: string; acknowledgeRunningCombatants: boolean }, user: RequestUser, role: Role): Promise<PartyRecoveryApplyResult> {
    if (!roleAtLeast(role, 'dm')) throw new ForbiddenException('Only a DM can rest the party.');
    const [batch] = await this.db.select().from(partyRestBatches).where(and(eq(partyRestBatches.campaignId, campaignId), eq(partyRestBatches.previewToken, input.previewToken))).limit(1);
    if (!batch) throw new NotFoundException('Recovery preview not found.');
    if (batch.actorUserId !== user.id) throw new ForbiddenException('Only the DM who created this recovery preview can apply it.');
    if (batch.status === 'applied' && batch.idempotencyKey === input.idempotencyKey) return fromJsonText<PartyRecoveryApplyResult>(batch.resultJson, { batchId: batch.id, kind: 'long', ruleSystem: '', characterIds: [] });
    if (batch.status !== 'previewed' || (batch.idempotencyKey && batch.idempotencyKey !== input.idempotencyKey)) throw new ConflictException('Recovery preview was already used for another intent.');
    const before = fromJsonText<Array<{ id: number; updatedAt: string; conditions: string; conditionInstances: string | null }>>(batch.beforeJson, []);
    const plan = fromJsonText<{ kind: RestKind | 'custom'; ruleSystem: string; plans: Array<{ characterId: number; characterName: string; hpAfter: number; hpTempAfter: number; deathStateAfter: string; deathSaveSuccessesAfter: number; deathSaveFailuresAfter: number; conditionsAfter: RestConditionState[]; spellSlotsAfter: Record<string, SpellSlotLevel>; resourcesAfter: Record<string, CharacterResource> }> }>(batch.planJson, { kind: 'short', ruleSystem: '', plans: [] });
    const ids = before.map((s) => s.id);
    const linked = await this.db.select({ characterId: combatants.characterId }).from(combatants).innerJoin(encounters, eq(combatants.encounterId, encounters.id)).where(and(eq(encounters.campaignId, campaignId), eq(encounters.status, 'running'), notDeleted(encounters.deletedAt)));
    if (linked.some((row) => row.characterId != null && ids.includes(row.characterId)) && !input.acknowledgeRunningCombatants) throw new ConflictException('A running combatant will be synchronized; acknowledgement is required.');
    const storedPlan = fromJsonText<{ failures?: unknown[] }>(batch.planJson, {});
    if ((storedPlan.failures?.length ?? 0) > 0) throw new BadRequestException('A recovery preview with ineligible participants cannot be applied.');
    const currentAdapter = (await this.adapterForCampaign(campaignId)) as unknown as RestAdapter;
    if (currentAdapter.id !== plan.ruleSystem) throw new ConflictException('Campaign rules changed after this preview; preview recovery again.');
    // An idempotency key belongs to the actor's intent, not a preview token.  A
    // retry after a transport failure may have created a second equivalent preview;
    // replay that result, but never let the same key apply a different intent.
    const [sameKey] = await this.db.select().from(partyRestBatches).where(and(eq(partyRestBatches.campaignId, campaignId), eq(partyRestBatches.actorUserId, user.id), eq(partyRestBatches.idempotencyKey, input.idempotencyKey))).limit(1);
    if (sameKey && sameKey.id !== batch.id) {
      if (sameKey.requestFingerprint !== batch.requestFingerprint) throw new ConflictException('Idempotency key was already used for a different recovery intent.');
      if (sameKey.status === 'applied') return fromJsonText<PartyRecoveryApplyResult>(sameKey.resultJson, { batchId: sameKey.id, kind: 'long', ruleSystem: '', characterIds: [] });
      throw new ConflictException('Idempotency key is already in use by an unfinished recovery.');
    }
    const at = nowIso();
    const touchedEncounterIds = new Set<number>();
    const resultBody: PartyRecoveryApplyResult = { batchId: batch.id, kind: plan.kind, ruleSystem: plan.ruleSystem, characterIds: ids };
    this.db.transaction((tx) => {
      for (const item of plan.plans) {
        const snapshot = before.find((candidate) => candidate.id === item.characterId)!;
        const nextInstances = this.recoveryConditionInstances(item.conditionsAfter, snapshot.conditionInstances, snapshot.conditions);
        const result = tx.update(characters).set({ hpCurrent: item.hpAfter, hpTemp: item.hpTempAfter, deathState: item.deathStateAfter, deathSaveSuccesses: item.deathSaveSuccessesAfter, deathSaveFailures: item.deathSaveFailuresAfter, ...sheetConditionWriteSetFromInstances(nextInstances), spellSlots: toJsonText(item.spellSlotsAfter), resources: toJsonText(item.resourcesAfter), updatedAt: at }).where(and(eq(characters.id, item.characterId), eq(characters.campaignId, campaignId), eq(characters.updatedAt, snapshot.updatedAt))).run();
        if (result.changes !== 1) throw new ConflictException('A participant changed while recovery was applying.');
        for (const encounterId of this.syncRecoveryCombatantsInTx(tx, campaignId, item.characterId, item.hpAfter, item.hpTempAfter, item.deathStateAfter, item.deathSaveSuccessesAfter, item.deathSaveFailuresAfter, nextInstances, at)) touchedEncounterIds.add(encounterId);
      }
      const result = tx.update(partyRestBatches).set({ status: 'applied', idempotencyKey: input.idempotencyKey, afterJson: toJsonText(plan.plans), resultJson: toJsonText(resultBody), appliedAt: at }).where(and(eq(partyRestBatches.id, batch.id), eq(partyRestBatches.status, 'previewed'))).run();
      if (result.changes !== 1) throw new ConflictException('Recovery preview was applied concurrently.');
      this.audit.logInTx(tx, { actor: auditActor(user), actorRole: role, action: 'party.rest.apply', entityType: 'party_rest_batch', entityId: batch.id, campaignId, detail: JSON.stringify({ batchId: batch.id, characterIds: ids, idempotencyKey: input.idempotencyKey, kind: plan.kind }) });
    });
    for (const encounterId of touchedEncounterIds) this.emitEncounterUpdatedIfVisible(campaignId, encounterId);
    this.events.emit({ type: 'party.rest.updated', campaignId, batchId: batch.id, characterIds: ids });
    return resultBody;
  }

  async undoPartyRecovery(campaignId: number, batchId: number, idempotencyKey: string, user: RequestUser, role: Role) {
    if (!roleAtLeast(role, 'dm')) throw new ForbiddenException('Only a DM can undo a party rest.');
    const [batch] = await this.db.select().from(partyRestBatches).where(and(eq(partyRestBatches.campaignId, campaignId), eq(partyRestBatches.id, batchId))).limit(1);
    if (!batch) throw new NotFoundException('Party recovery batch not found.');
    if (batch.actorUserId !== user.id) throw new ForbiddenException('Only the DM who applied this recovery can undo it.');
    if (batch.status === 'undone') {
      if (batch.undoIdempotencyKey === idempotencyKey) return fromJsonText(batch.undoResultJson, { batchId, undone: true, replayed: true });
      throw new ConflictException('This recovery was already undone with a different idempotency key.');
    }
    if (batch.status !== 'applied') throw new ConflictException('Only an applied recovery can be undone.');
    const before = fromJsonText<Array<{ id: number; hpCurrent: number; hpTemp: number; deathState: string; deathSaveSuccesses: number; deathSaveFailures: number; conditions: string; conditionInstances: string | null; spellSlots: string; resources: string }>>(batch.beforeJson, []);
    const after = fromJsonText<Array<{ characterId: number; hpAfter: number; hpTempAfter: number; deathStateAfter: string; deathSaveSuccessesAfter: number; deathSaveFailuresAfter: number; conditionsAfter: RestConditionState[]; spellSlotsAfter: Record<string, SpellSlotLevel>; resourcesAfter: Record<string, CharacterResource> }>>(batch.afterJson, []);
    const at = nowIso();
    const undoResult = { batchId, undone: true };
    const touchedEncounterIds = new Set<number>();
    this.db.transaction((tx) => {
      // An older batch must never undo through a newer overlapping recovery,
      // even when both happened to produce identical sheet values (two long
      // rests are the common case). Batch ids are allocated at preview time,
      // so every later applied recovery has a greater id.
      const later = tx.select({ afterJson: partyRestBatches.afterJson }).from(partyRestBatches)
        .where(and(eq(partyRestBatches.campaignId, campaignId), eq(partyRestBatches.status, 'applied'), sql`${partyRestBatches.id} > ${batchId}`)).all();
      const targetIds = new Set(before.map((snapshot) => snapshot.id));
      if (later.some((row) => fromJsonText<Array<{ characterId: number }>>(row.afterJson, []).some((item) => targetIds.has(item.characterId)))) {
        throw new ConflictException('A later recovery changed a participant; undo the newest recovery first.');
      }
      // Compare the exact recorded after-state *inside* this transaction, then
      // include it in every update predicate.  A concurrent sheet write therefore
      // makes the whole undo roll back instead of resurrecting stale state.
      for (const snapshot of before) {
        const item = after.find((candidate) => candidate.characterId === snapshot.id);
        if (!item) throw new ConflictException('Recovery snapshot is incomplete.');
        const afterInstances = this.recoveryConditionInstances(item.conditionsAfter, snapshot.conditionInstances, snapshot.conditions);
        const result = tx.update(characters).set({ hpCurrent: snapshot.hpCurrent, hpTemp: snapshot.hpTemp, deathState: snapshot.deathState, deathSaveSuccesses: snapshot.deathSaveSuccesses, deathSaveFailures: snapshot.deathSaveFailures, ...sheetConditionWriteSetFromInstances(readConditionInstances(snapshot.conditionInstances, snapshot.conditions)), spellSlots: snapshot.spellSlots, resources: snapshot.resources, updatedAt: at }).where(and(eq(characters.id, snapshot.id), eq(characters.campaignId, campaignId), eq(characters.hpCurrent, item.hpAfter), eq(characters.hpTemp, item.hpTempAfter), eq(characters.deathState, item.deathStateAfter), eq(characters.deathSaveSuccesses, item.deathSaveSuccessesAfter), eq(characters.deathSaveFailures, item.deathSaveFailuresAfter), eq(characters.conditions, toJsonText(afterInstances.map((instance) => instance.name))), eq(characters.conditionInstances, toJsonText(afterInstances)), eq(characters.spellSlots, toJsonText(item.spellSlotsAfter)), eq(characters.resources, toJsonText(item.resourcesAfter)))).run();
        if (result.changes !== 1) throw new ConflictException('A participant changed after this recovery; undo would overwrite it.');
        for (const encounterId of this.syncRecoveryCombatantsInTx(tx, campaignId, snapshot.id, snapshot.hpCurrent, snapshot.hpTemp, snapshot.deathState, snapshot.deathSaveSuccesses, snapshot.deathSaveFailures, readConditionInstances(snapshot.conditionInstances, snapshot.conditions), at)) touchedEncounterIds.add(encounterId);
      }
      const result = tx.update(partyRestBatches).set({ status: 'undone', undoneAt: at, undoIdempotencyKey: idempotencyKey, undoResultJson: toJsonText(undoResult) }).where(and(eq(partyRestBatches.id, batchId), eq(partyRestBatches.status, 'applied'))).run();
      if (result.changes !== 1) throw new ConflictException('Recovery was undone concurrently.');
      this.audit.logInTx(tx, { actor: auditActor(user), actorRole: role, action: 'party.rest.undo', entityType: 'party_rest_batch', entityId: batchId, campaignId, detail: JSON.stringify({ batchId, characterIds: before.map((s) => s.id), idempotencyKey }) });
    });
    for (const encounterId of touchedEncounterIds) this.emitEncounterUpdatedIfVisible(campaignId, encounterId);
    this.events.emit({ type: 'party.rest.updated', campaignId, batchId, characterIds: before.map((snapshot) => snapshot.id) });
    return undoResult;
  }

  /**
   * DEPRECATED (#1041) — kept as a thin adapter over {@link restParty}.
   *
   * This was dead code: it reset spell slots and resources by recharge cadence but ignored HP,
   * temp HP, death saves, and conditions, and nothing but a test ever called it. Its cadence
   * logic now lives in `packages/schema/src/rest.ts`, where it is shared with the real rest
   * path, so the two can no longer drift. `refocus` has no equivalent in the two-kind rest
   * model and is left doing exactly what it did — refilling refocus resources only.
   *
   * Prefer `restParty`. This exists so an existing caller (and its integration spec) keeps
   * working rather than being silently deleted along with the behaviour it pinned.
   */
  async restCharacter(id: number, restType: 'short-rest' | 'long-rest' | 'refocus', user: RequestUser, role: Role): Promise<Character> {
    const existing = await this.getRowOrThrow(id);
    this.assertCanWrite(existing, user, role);

    const slots = fromJsonText<Record<string, SpellSlotLevel>>(existing.spellSlots, {});
    const resources = fromJsonText<Record<string, { max: number; used: number; name?: string; recharge?: string }>>(existing.resources, {});

    if (restType === 'long-rest') {
      for (const key of Object.keys(slots)) {
        slots[key] = { max: slots[key].max, used: 0 };
      }
      for (const key of Object.keys(resources)) {
        const r = resources[key];
        if (!r.recharge || r.recharge === 'long-rest' || r.recharge === 'short-rest' || r.recharge === 'refocus' || r.recharge === 'dawn') {
          r.used = 0;
        }
      }
    } else if (restType === 'short-rest') {
      for (const key of Object.keys(resources)) {
        const r = resources[key];
        if (r.recharge === 'short-rest' || r.recharge === 'refocus') {
          r.used = 0;
        }
      }
    } else if (restType === 'refocus') {
      for (const key of Object.keys(resources)) {
        const r = resources[key];
        if (r.recharge === 'refocus') {
          r.used = 0;
        }
      }
    }

    const [row] = await this.db
      .update(characters)
      .set({ spellSlots: toJsonText(slots), resources: toJsonText(resources), updatedAt: nowIso() })
      .where(eq(characters.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'character.rest',
      entityType: 'character',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify({ restType }),
    });
    this.emitCharacterUpdated(existing.campaignId, id, user.id);
    return redactSecret(toDomain(row), role);
  }
}

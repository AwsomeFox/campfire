import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import { AoeTemplate, CombatantCreate, CombatantUpdate, EncounterCreate, EncounterReopen, EncounterUpdate, FogState, RollRequest, estimateEncounterDifficultyForRuleSystem, isKnownCondition, normalizeStats, parseCr, ruleSystemAdapter } from '@campfire/schema';
import { z as zod } from 'zod';
import type { AoeTemplate as AoeTemplateType, Combatant, DiceRoll, Encounter, EncounterDifficulty, EncounterDigest, EncounterEvent, EncounterEventType, EncounterGenerate, EncounterRollInitiativeResult, EncounterStatus, EncounterSuggestion, EncounterWithCombatants, FogRect, GridType, HpSyncConflict, MapPing, Role, RuleSystemAdapter, TokenSize } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns, characters, combatants, encounterEvents, encounters, locations, npcs, quests, ruleEntries, rulePacks, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { filterHidden, isVisibleTo } from '../../common/redact';
import { fromJsonText, toJsonText } from '../../common/json';
import { fogConcealsPixels, parseFogState } from '../../common/fog';
import { rollDice, rollInitiative } from '../../common/dice';
import { foldForSearch, foldedIncludes } from '../../common/text-search';
import { RollsService } from '../rolls/rolls.service';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import {
  advanceTurn,
  applyCombatantHp,
  crToXp,
  generateEncounterGroup,
  hpBandFor,
  redactEncounterEventsForViewer,
  sortCombatants,
  turnIndexFor,
  UNKNOWN_COMBATANT_LABEL,
} from './encounters.logic';
import type { CombatantHpState, GeneratorCandidate } from './encounters.logic';
import { ATTACHMENT_STATE_COMMITTED } from '../attachments/attachment.constants';
import { AttachmentsService } from '../attachments/attachments.service';
import { canWriteBackHp, hpSyncSliceOf, hpSyncSlicesEqual } from './hp-sync';

type EncounterCreateInput = z.infer<typeof EncounterCreate>;
type EncounterGenerateInput = z.infer<typeof EncounterGenerate>;
type EncounterUpdateInput = z.infer<typeof EncounterUpdate>;
type EncounterReopenInput = z.infer<typeof EncounterReopen>;
type CombatantCreateInput = z.infer<typeof CombatantCreate>;
type CombatantUpdateInput = z.infer<typeof CombatantUpdate>;
type RollRequestInput = z.infer<typeof RollRequest>;

/**
 * better-sqlite3 throws a synchronous Error with `.code` set to one of the
 * SQLITE_CONSTRAINT_* codes on a constraint violation (issue #749). The combatant
 * partial unique indexes (idx_combatants_encounter_character /
 * idx_combatants_encounter_npc) surface a lost concurrent-add race as a UNIQUE
 * violation; this helper detects that so the service can convert it into a
 * deterministic 409 (with the winning combatant id) instead of a raw 500. Mirrors
 * the isUniqueConstraintError helper in rules.service.ts.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed/i.test(message);
}

/** Clamp a 0–100 percent overlay coordinate, mirroring the campaign map's location-pin drag. */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Parse the stored fog JSON back into a FogState (issue #40). Corrupt/legacy text or a
 * shape that no longer validates degrades to null (fully visible) rather than throwing —
 * fog is a display aid, never a reason to fail a whole encounter read.
 */
function parseFog(text: string | null): FogState | null {
  return parseFogState(text);
}

/**
 * Parse the stored AoE-templates JSON back into an AoeTemplate[] (issue #238). Same defensive
 * degrade-to-empty as parseFog: corrupt/legacy text or an entry that no longer validates is
 * dropped rather than failing the whole encounter read — templates are a display aid.
 */
function parseAoe(text: string | null): AoeTemplateType[] {
  if (text == null) return [];
  const parsed = zod.array(AoeTemplate).safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : [];
}

function encounterToDomain(row: typeof encounters.$inferSelect): Encounter {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    status: row.status as EncounterStatus,
    round: row.round,
    turnIndex: row.turnIndex,
    currentCombatantId: row.currentCombatantId,
    locationId: row.locationId,
    questId: row.questId,
    sessionId: row.sessionId,
    mapAttachmentId: row.mapAttachmentId,
    gridSize: row.gridSize,
    gridScale: row.gridScale,
    gridUnit: row.gridUnit,
    gridSnap: row.gridSnap,
    gridType: (row.gridType as GridType) ?? 'square',
    fog: parseFog(row.fog),
    aoe: parseAoe(row.aoe),
    hidden: row.hidden,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function combatantToDomain(row: typeof combatants.$inferSelect): Combatant {
  return {
    id: row.id,
    encounterId: row.encounterId,
    kind: row.kind as Combatant['kind'],
    characterId: row.characterId,
    npcId: row.npcId,
    name: row.name,
    initiative: row.initiative,
    initMod: row.initMod,
    hpCurrent: row.hpCurrent,
    hpMax: row.hpMax,
    hpTemp: row.hpTemp,
    hpBand: null,
    deathState: row.deathState as Combatant['deathState'],
    deathSaveSuccesses: row.deathSaveSuccesses,
    deathSaveFailures: row.deathSaveFailures,
    conditions: fromJsonText<string[]>(row.conditions, []),
    ruleEntryId: row.ruleEntryId,
    sortOrder: row.sortOrder,
    tokenX: row.tokenX,
    tokenY: row.tokenY,
    tokenSize: row.tokenSize as TokenSize,
    tokenHiddenByFog: false,
  };
}

function eventToDomain(row: typeof encounterEvents.$inferSelect): EncounterEvent {
  return {
    id: row.id,
    encounterId: row.encounterId,
    round: row.round,
    type: row.type as EncounterEventType,
    actor: row.actor,
    target: row.target,
    actorId: row.actorId ?? null,
    targetId: row.targetId ?? null,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}

/**
 * Issue #43: non-DM viewers must not see a monster's (or DM-controlled NPC's) exact
 * HP — a player polling the run-session view would otherwise read the boss at an
 * exact `3/150`, a live secrets leak (and the same view a shared screen shows). For
 * monster AND npc combatants we replace hpCurrent/hpMax with a coarse status band and
 * null the exact numbers. Character combatants keep exact HP for everyone: party HP
 * is shared table knowledge and a player already sees their own character sheet.
 */
function redactMonsterHp(c: Combatant): Combatant {
  if ((c.kind !== 'monster' && c.kind !== 'npc') || c.hpCurrent === null || c.hpMax === null) return c;
  // hpTemp is exact-HP information too — null it alongside hpCurrent/hpMax so a
  // temp-HP buffed monster doesn't leak numbers through the redaction.
  return { ...c, hpBand: hpBandFor(c.hpCurrent, c.hpMax), hpCurrent: null, hpMax: null, hpTemp: null };
}

/** True if a combatant's token centre lies inside any revealed fog rectangle (issue #40). */
function tokenInRevealedRegion(c: Combatant, fog: FogState): boolean {
  if (c.tokenX == null || c.tokenY == null) return true; // unplaced — nothing on the map to hide
  const x = c.tokenX;
  const y = c.tokenY;
  return fog.revealed.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

/**
 * Issue #40 fog-of-war redaction: when fog is enabled, a non-DM viewer must not learn the
 * position of any token sitting in an unrevealed region — a player polling the run view would
 * otherwise read exactly where the ambush monster is waiting in the dark. We null tokenX/tokenY
 * on those combatants server-side (the client never receives the coordinates), the same
 * server-side-gate approach as the issue #43 monster-HP band. Tokens inside a revealed
 * rectangle, and unplaced combatants, are returned unchanged.
 *
 * Issue #418: also set `tokenHiddenByFog: true` so the client can show an owner-safe
 * "placed outside the revealed area" state instead of falsely listing the token as
 * Unplaced (and offering a no-op place-at-center action). Coordinates stay null.
 */
function redactTokenInFog(c: Combatant, fog: FogState): Combatant {
  if (tokenInRevealedRegion(c, fog)) return c;
  return { ...c, tokenX: null, tokenY: null, tokenHiddenByFog: true };
}

export type EncounterSearchEntry = {
  id: number;
  campaignId: number;
  name: string;
  locationLabel: string;
  questLabel: string;
  sessionLabel: string;
};

@Injectable()
export class EncountersService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly events: CampaignEventsService,
    private readonly rolls: RollsService,
    private readonly revisions: RevisionsService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  /** Push a thin SSE change signal to everyone watching this campaign (issue #4). */
  private emitEncounterEvent(type: 'encounter.updated' | 'encounter.deleted', campaignId: number, encounterId: number): void {
    this.events.emit({ type, campaignId, encounterId });
  }

  /**
   * Reject a combat write against an 'ended' encounter (issue #163). `end()` was
   * carefully guarded against double-firing, but per-combatant writes (add / update /
   * remove / roll-initiative) never checked status — so after a fight was over any
   * owning player or DM could keep editing the historical record, and every combatant
   * HP patch ALSO rewrote the linked character's live sheet HP through the write-through
   * in updateCombatant, corrupting current HP outside any session context. An ended
   * encounter's combatant rows are a frozen historical snapshot; mutating them is a
   * state conflict (409). Viewing stays allowed (getWithCombatantsOrThrow is untouched),
   * and /reopen is the supported path back to a mutable 'running' encounter.
   */
  private assertMutable(encounterRow: typeof encounters.$inferSelect): void {
    if (encounterRow.status === 'ended') {
      throw new ConflictException(`Encounter ${encounterRow.id} has ended — reopen it before modifying combatants`);
    }
  }

  /**
   * Resolve the single authoritative live encounter for a campaign (issue #744). Returns
   * the active encounter row when there is exactly one 'running' fight — preferring the
   * campaign's `activeEncounterId` pointer (the transactional source of truth) and
   * falling back to a status scan for back-compat with rows written before the pointer
   * column existed / on DBs that haven't run the migration. Returns undefined when no
   * encounter is running. The async variant reads outside any transaction (e.g. from
   * listForCampaign); start/reopen/reopen use the synchronous in-transaction variant
   * below so the assertion + status flip are atomic against concurrent starts.
   */
  private async findLiveEncounter(
    campaignId: number,
  ): Promise<typeof encounters.$inferSelect | undefined> {
    // Prefer the explicit pointer — it is the source of truth once a start/reopen lands.
    const [campaign] = await this.db.select({ activeEncounterId: campaigns.activeEncounterId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (campaign?.activeEncounterId !== null && campaign?.activeEncounterId !== undefined) {
      const [row] = await this.db
        .select()
        .from(encounters)
        .where(and(eq(encounters.id, campaign.activeEncounterId), eq(encounters.campaignId, campaignId)))
        .limit(1);
      if (row && (row.status as EncounterStatus) === 'running') return row;
    }
    // Back-compat scan: a 'running' encounter from before the pointer existed, or a
    // pointer that drifted out of sync (e.g. an older server with no #744 enforcement).
    const rows = await this.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), eq(encounters.status, 'running')));
    return rows[0];
  }

  /**
   * Synchronous in-transaction variant of findLiveEncounter (issue #744). better-sqlite3
   * transactions are synchronous, so the queries here use `.all()` directly. Reading the
   * campaign pointer + the status scan inside the SAME serialized transaction that the
   * caller will flip status in means two concurrent /start calls serialize: the loser's
   * read observes the winner's committed 'running' row and surfaces a 409.
   */
  private findLiveEncounterSync(
    campaignId: number,
    tx: DrizzleDb,
  ): typeof encounters.$inferSelect | undefined {
    const [campaign] = tx
      .select({ activeEncounterId: campaigns.activeEncounterId })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
      .all();
    if (campaign?.activeEncounterId !== null && campaign?.activeEncounterId !== undefined) {
      const [row] = tx
        .select()
        .from(encounters)
        .where(and(eq(encounters.id, campaign.activeEncounterId), eq(encounters.campaignId, campaignId)))
        .limit(1)
        .all();
      if (row && (row.status as EncounterStatus) === 'running') return row;
    }
    const rows = tx
      .select()
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), eq(encounters.status, 'running')))
      .all();
    return rows[0];
  }

  /**
   * Enforce the one-authoritative-live-fight invariant (issue #744) inside the caller's
   * transaction. Throws 409 Conflict — carrying the winning encounter's id + name + a deep
   * link — when a DIFFERENT encounter is already running in this campaign. The winner is
   * whichever live encounter findLiveEncounterSync resolves (the pinned pointer if set,
   * else the first 'running' row). Must run inside the same transaction as the status flip
   * so two concurrent starts serialize and the loser deterministically sees the winner's row.
   */
  private assertNoOtherLiveEncounter(
    campaignId: number,
    encounterId: number,
    tx: DrizzleDb,
  ): void {
    const live = this.findLiveEncounterSync(campaignId, tx);
    if (live && live.id !== encounterId) {
      throw new ConflictException({
        code: 'ENCOUNTER_ALREADY_RUNNING',
        message: `Encounter "${live.name}" is already the live fight for this campaign — end it before starting another.`,
        encounterId: live.id,
        encounterName: live.name,
        deepLink: `/c/${campaignId}/encounters/${live.id}`,
      });
    }
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(encounters).where(eq(encounters.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Encounter ${id} not found`);
    return row;
  }

  /**
   * Lightweight encounter domain mapping for GET /encounters/:id/map.
   * Applies the same hidden-entity gate as getWithCombatantsOrThrow without joining combatants.
   */
  encounterForMapOrThrow(row: typeof encounters.$inferSelect, viewerRole: Role): Encounter {
    if (!isVisibleTo({ hidden: row.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${row.id} not found`);
    }
    return encounterToDomain(row);
  }

  /**
   * Resolve the RuleSystemAdapter for a campaign (issue #70) — the seam the combat math
   * (ability modifiers, DEX-derived initiative, the initiative die, monster statblock
   * fields) routes through instead of inlining 5e constants. Reads `campaigns.ruleSystem`
   * and falls back to the default (5e) adapter, so every existing campaign behaves exactly
   * as before. Adding a second rule system is a new adapter in the registry, not edits here.
   */
  private async adapterForCampaign(campaignId: number): Promise<RuleSystemAdapter> {
    const [row] = await this.db.select({ ruleSystem: campaigns.ruleSystem }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    return ruleSystemAdapter(row?.ruleSystem);
  }

  /**
   * Sort combatants with the campaign ruleset's initiative tiebreak when running
   * (issue #611: 5e DEX-desc, PF2e preserved roll order, …). Non-running statuses
   * ignore the adapter (sortOrder only) — callers should still avoid fetching the
   * adapter when status is not `running`.
   */
  private sortCombatantsWithAdapter(
    rows: Combatant[],
    status: EncounterStatus,
    adapter: RuleSystemAdapter,
  ): Combatant[] {
    if (status !== 'running') return sortCombatants(rows, status);
    return sortCombatants(rows, status, (a, b) => adapter.initiativeTiebreak(a, b));
  }

  async listCombatantRows(encounterId: number) {
    return this.db.select().from(combatants).where(eq(combatants.encounterId, encounterId));
  }

  /**
   * Re-read the single combatant that holds a given character/NPC identity in an
   * encounter (issue #749). Used ONLY by the race-loser branch of addCombatant:
   * when a concurrent add beats our SELECT-then-INSERT probe and the partial
   * unique index rejects our INSERT, we re-read the winner so the 409 body can
   * carry its id deterministically. Exactly one row can match (the partial unique
   * index guarantees it), so `.limit(1)` is belt-and-suspenders. `characterId`
   * and `npcId` are never both set on the same combatant, so selecting one
   * predicate based on which id is non-null is safe (no OR is needed).
   */
  private async findExistingIdentityCombatant(
    encounterId: number,
    characterId: number | null,
    npcId: number | null,
  ): Promise<typeof combatants.$inferSelect | undefined> {
    const where =
      characterId !== null
        ? and(eq(combatants.encounterId, encounterId), eq(combatants.characterId, characterId))
        : npcId !== null
          ? and(eq(combatants.encounterId, encounterId), eq(combatants.npcId, npcId))
          : undefined;
    if (!where) return undefined;
    const [row] = await this.db.select().from(combatants).where(where).limit(1);
    return row;
  }

  /**
   * Resolve the actor name to attribute a combat-log HP/death event to (issue #620).
   * Resolution order:
   *   1. an explicit numeric `actorId` from the patch (the apply-damage caller naming
   *      the attacker directly);
   *   2. the running encounter's current-turn combatant (the default attacker) — only
   *      when `actorId` was omitted (`undefined`);
   *   3. null — fall back to the original target-only phrasing.
   * Tri-state `actorId` contract:
   *   - omitted / `undefined` → try current-turn fallback;
   *   - `null` → opt out of attribution entirely (no current-turn fallback);
   *   - number → use that combatant (self-damage collapses; unknown id falls back).
   * Returns null (no attribution) when:
   *   - the caller sent `actorId: null` to suppress attribution;
   *   - the resolved combatant IS the target (self-damage, or the monster on its own
   *     turn), because the existing log phrasing ("Ember took 8 damage") reads better
   *     than the attributed form ("Ember: took 8 damage") when the actor and target
   *     collapse to the same name;
   *   - the explicit actorId references a combatant that no longer exists in this
   *     encounter (a stale client) — dropped (and the current-turn fallback retried)
   *     rather than 400ing, so a stale client can still apply damage without a second
   *     round-trip and the log still attributes to the most-likely attacker.
   */
  private async resolveCombatLogActor(
    encounterId: number,
    actorId: number | null | undefined,
    currentCombatantId: number | null,
    targetCombatantId: number,
  ): Promise<{ id: number; name: string } | null> {
    // Explicit null = "do not attribute" (used by a11y e2e and callers that want the
    // legacy target-only phrasing). Distinct from omitted/undefined, which falls back
    // to the current-turn combatant.
    if (actorId === null) return null;

    // An explicitly-provided numeric actorId is authoritative: respect it (including
    // the actor==target self-damage case, which collapses to no attribution). Only when
    // it is absent OR fails to resolve (a stale client referencing a removed combatant)
    // do we fall back to the current-turn combatant, so a bogus id still lands the
    // damage and attributes to the most plausible attacker.
    if (actorId !== undefined) {
      if (actorId === targetCombatantId) return null; // explicit self-attribution
      const [explicit] = await this.db
        .select({ id: combatants.id, name: combatants.name })
        .from(combatants)
        .where(and(eq(combatants.id, actorId), eq(combatants.encounterId, encounterId)))
        .limit(1);
      if (explicit?.name) return { id: explicit.id, name: explicit.name };
      // explicit id didn't resolve — fall through to the current-turn fallback.
    }
    if (currentCombatantId === null || currentCombatantId === targetCombatantId) return null;
    const [current] = await this.db
      .select({ id: combatants.id, name: combatants.name })
      .from(combatants)
      .where(and(eq(combatants.id, currentCombatantId), eq(combatants.encounterId, encounterId)))
      .limit(1);
    return current?.name ? { id: current.id, name: current.name } : null;
  }

  /**
   * Persist one combat-log event (issue #61). Called from the combat mutations (HP
   * damage/heal, condition add/remove, death, turn/round) so the run view can show a
   * scrollable history that survives reload. `detail` must never carry a monster's
   * exact HP total — only deltas — and must not interpolate combatant names (issue
   * #869) so listing can redact actor/target without prose bypassing the mask.
   */
  private async appendEvent(
    encounterId: number,
    round: number,
    type: EncounterEventType,
    fields: {
      actor?: string | null;
      target?: string | null;
      actorId?: number | null;
      targetId?: number | null;
      detail?: string;
    },
  ): Promise<void> {
    await this.db.insert(encounterEvents).values({
      encounterId,
      round,
      type,
      actor: fields.actor ?? null,
      target: fields.target ?? null,
      actorId: fields.actorId ?? null,
      targetId: fields.targetId ?? null,
      detail: fields.detail ?? '',
      createdAt: nowIso(),
    });
  }

  /**
   * Lists an encounter's persisted combat log in chronological (insertion) order —
   * issue #61 / #869. Hidden encounters 404 for non-DMs (parity with roster/
   * difficulty). For non-DMs, actor/target names (and any name-bearing detail) are
   * projected from CURRENT hidden-NPC visibility so a later reveal unmasks
   * historical lines; stable actorId/targetId are always returned.
   */
  /**
   * DM-view batch fetch of events for many encounters in ONE query, keyed by encounterId
   * (empty array when an encounter has no events). Avoids the N+1 of calling listEvents()
   * per encounter on the campaign-export path (issue #863). No viewer redaction — callers
   * are DM-scoped (full campaign export).
   */
  async listEventsForEncounters(encounterIds: number[]): Promise<Map<number, EncounterEvent[]>> {
    const result = new Map<number, EncounterEvent[]>();
    for (const id of encounterIds) result.set(id, []);
    if (encounterIds.length === 0) return result;
    const rows = await this.db
      .select()
      .from(encounterEvents)
      .where(inArray(encounterEvents.encounterId, encounterIds))
      .orderBy(encounterEvents.id);
    for (const row of rows) {
      const list = result.get(row.encounterId);
      if (list) list.push(eventToDomain(row));
      else result.set(row.encounterId, [eventToDomain(row)]);
    }
    return result;
  }

  async listEvents(encounterId: number, viewerRole?: Role): Promise<EncounterEvent[]> {
    const row = await this.getRowOrThrow(encounterId);
    if (viewerRole !== undefined && !isVisibleTo({ hidden: row.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const rows = await this.db
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, encounterId))
      .orderBy(encounterEvents.id);
    const events = rows.map(eventToDomain);
    if (viewerRole === undefined || viewerRole === 'dm' || events.length === 0) {
      return events;
    }

    const combatantRows = await this.listCombatantRows(encounterId);
    const linkedNpcIds = combatantRows.map((c) => c.npcId).filter((n): n is number => n !== null);
    const hiddenNpcIds = new Set<number>();
    if (linkedNpcIds.length > 0) {
      const hiddenRows = await this.db
        .select({ id: npcs.id })
        .from(npcs)
        .where(and(inArray(npcs.id, linkedNpcIds), eq(npcs.hidden, true)));
      for (const r of hiddenRows) hiddenNpcIds.add(r.id);
    }
    return redactEncounterEventsForViewer(
      events,
      combatantRows.map((c) => ({ id: c.id, name: c.name, npcId: c.npcId })),
      hiddenNpcIds,
    );
  }

  /**
   * Redact `questId`, `locationId`, and `sessionId` to `null` on encounter domain objects
   * (or digests) when viewed by a non-DM and the linked entity is hidden, unexplored, or deleted.
   */
  private async redactHiddenLinkedEntities<T extends { questId: number | null; locationId: number | null; sessionId: number | null }>(
    items: T[],
    campaignId: number,
    viewerRole?: Role,
  ): Promise<T[]> {
    if (viewerRole === undefined || viewerRole === 'dm' || items.length === 0) {
      return items;
    }

    const questIds = Array.from(new Set(items.map((i) => i.questId).filter((id): id is number => id !== null)));
    const locationIds = Array.from(new Set(items.map((i) => i.locationId).filter((id): id is number => id !== null)));
    const sessionIds = Array.from(new Set(items.map((i) => i.sessionId).filter((id): id is number => id !== null)));

    const hiddenQuestIds = new Set<number>();
    if (questIds.length > 0) {
      const questRows = await this.db
        .select({ id: quests.id, hidden: quests.hidden, deletedAt: quests.deletedAt })
        .from(quests)
        .where(and(inArray(quests.id, questIds), eq(quests.campaignId, campaignId)));
      const foundIds = new Set(questRows.map((q) => q.id));
      for (const id of questIds) {
        if (!foundIds.has(id)) hiddenQuestIds.add(id);
      }
      for (const q of questRows) {
        if (q.hidden || q.deletedAt !== null) {
          hiddenQuestIds.add(q.id);
        }
      }
    }

    const hiddenLocationIds = new Set<number>();
    if (locationIds.length > 0) {
      const locRows = await this.db
        .select({ id: locations.id, status: locations.status, deletedAt: locations.deletedAt })
        .from(locations)
        .where(and(inArray(locations.id, locationIds), eq(locations.campaignId, campaignId)));
      const foundIds = new Set(locRows.map((l) => l.id));
      for (const id of locationIds) {
        if (!foundIds.has(id)) hiddenLocationIds.add(id);
      }
      for (const l of locRows) {
        if (l.status === 'unexplored' || l.deletedAt !== null) {
          hiddenLocationIds.add(l.id);
        }
      }
    }

    const hiddenSessionIds = new Set<number>();
    if (sessionIds.length > 0) {
      const sessRows = await this.db
        .select({ id: sessions.id, deletedAt: sessions.deletedAt })
        .from(sessions)
        .where(and(inArray(sessions.id, sessionIds), eq(sessions.campaignId, campaignId)));
      const foundIds = new Set(sessRows.map((s) => s.id));
      for (const id of sessionIds) {
        if (!foundIds.has(id)) hiddenSessionIds.add(id);
      }
      for (const s of sessRows) {
        if (s.deletedAt !== null) {
          hiddenSessionIds.add(s.id);
        }
      }
    }

    if (hiddenQuestIds.size === 0 && hiddenLocationIds.size === 0 && hiddenSessionIds.size === 0) {
      return items;
    }

    return items.map((item) => {
      const qId = item.questId !== null && hiddenQuestIds.has(item.questId) ? null : item.questId;
      const lId = item.locationId !== null && hiddenLocationIds.has(item.locationId) ? null : item.locationId;
      const sId = item.sessionId !== null && hiddenSessionIds.has(item.sessionId) ? null : item.sessionId;
      if (qId === item.questId && lId === item.locationId && sId === item.sessionId) {
        return item;
      }
      return {
        ...item,
        questId: qId,
        locationId: lId,
        sessionId: sId,
      };
    });
  }

  /**
   * `viewerRole` drives entity-level secrecy (issue #262): a hidden encounter is a DM's
   * prepared, not-yet-sprung fight and is dropped WHOLESALE for a non-DM viewer — mirroring
   * how QuestsService/NpcsService filter hidden rows. Omit `viewerRole` (or pass `dm`) only
   * for DM-facing callers (e.g. the full-backup export), which must see hidden encounters.
   */
  async listForCampaign(campaignId: number, status?: EncounterStatus, viewerRole?: Role): Promise<Encounter[]> {
    const conditions = [eq(encounters.campaignId, campaignId), status ? eq(encounters.status, status) : undefined].filter(
      (c): c is NonNullable<typeof c> => c !== undefined,
    );
    const rows = await this.db
      .select()
      .from(encounters)
      .where(conditions.length > 1 ? and(...conditions) : conditions[0]);
    let list = rows.map(encounterToDomain);
    // Drop hidden encounters wholesale for a non-DM viewer (issue #262). undefined role
    // (DM-facing callers) is never filtered.
    const visible = viewerRole === undefined ? list : filterHidden(list, viewerRole);
    // One authoritative live fight (issue #744): when listing 'running' encounters, pin
    // the campaign's activeEncounterId to the front so consumers (Dashboard / Player
    // Display / AI Table) that take the first result follow the authoritative fight rather
    // than an arbitrary DB ordering. With the Start/Reopen transactional guard there is at
    // most one running encounter anyway; this is the deterministic tiebreaker for any
    // legacy drift and a no-op otherwise.
    if (status === 'running' && visible.length > 1) {
      const activeId = await this.findLiveEncounter(campaignId);
      if (activeId) {
        list = visible.sort((a, b) => {
          if (a.id === activeId.id) return -1;
          if (b.id === activeId.id) return 1;
          return 0;
        });
      } else {
        list = visible;
      }
    } else {
      list = visible;
    }
    return this.redactHiddenLinkedEntities(list, campaignId, viewerRole);
  }

  async searchForCampaign(campaignId: number, role: Role, needle: string, limit: number): Promise<EncounterSearchEntry[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    // SearchService passes an already-folded needle; fold again for idempotent callers (#624).
    const folded = foldForSearch(needle.trim());
    if (!folded) return [];
    const questLabel = role === 'dm'
      ? sql<string>`coalesce(${quests.title}, '')`
      : sql<string>`case when ${quests.hidden} = 0 then coalesce(${quests.title}, '') else '' end`;
    const locationLabel = role === 'dm'
      ? sql<string>`coalesce(${locations.name}, '')`
      : sql<string>`case when ${locations.status} <> 'unexplored' then coalesce(${locations.name}, '') else '' end`;
    const sessionLabel = sql<string>`case
      when ${sessions.id} is null then ''
      when length(trim(coalesce(${sessions.title}, ''))) > 0 then ${sessions.title}
      else 'Session ' || ${sessions.number}
    end`;

    // Load role-visible rows, then fold-match in JS. SQLite lower()/instr is ASCII-only
    // and would miss ß→ss / accent / İ haystacks even for ASCII needles (#624).
    const rows = await this.db
      .select({
        id: encounters.id,
        campaignId: encounters.campaignId,
        name: encounters.name,
        locationLabel,
        questLabel,
        sessionLabel,
      })
      .from(encounters)
      .leftJoin(
        locations,
        and(
          eq(locations.id, encounters.locationId),
          eq(locations.campaignId, campaignId),
          notDeleted(locations.deletedAt),
        ),
      )
      .leftJoin(
        quests,
        and(eq(quests.id, encounters.questId), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)),
      )
      .leftJoin(
        sessions,
        and(eq(sessions.id, encounters.sessionId), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)),
      )
      .where(and(
        eq(encounters.campaignId, campaignId),
        role === 'dm' ? undefined : eq(encounters.hidden, false),
      ))
      .orderBy(encounters.id);

    return rows
      .filter(
        (r) =>
          foldedIncludes(r.name, folded)
          || foldedIncludes(r.locationLabel ?? '', folded)
          || foldedIncludes(r.questLabel ?? '', folded)
          || foldedIncludes(r.sessionLabel ?? '', folded),
      )
      .slice(0, boundedLimit);
  }


  /**
   * `viewerRole` drives issue #43 redaction: anyone below `dm` (player/viewer)
   * gets monster HP replaced with a coarse band. Omit it (or pass `dm`) only for
   * DM-facing returns — the DM always sees exact HP.
   */
  async getWithCombatantsOrThrow(id: number, viewerRole?: Role): Promise<EncounterWithCombatants> {
    const row = await this.getRowOrThrow(id);
    // Entity-level secrecy (issue #262): a hidden encounter (DM prep) must be
    // indistinguishable from a nonexistent one for a non-DM — 404 (not 403), so its
    // very existence + roster aren't leaked. Mirrors QuestsService.getOrThrow. undefined
    // role (DM-facing callers like the export) always sees it.
    if (viewerRole !== undefined && !isVisibleTo({ hidden: row.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${id} not found`);
    }
    const combatantRows = await this.listCombatantRows(id);
    const status = row.status as EncounterStatus;
    // Initiative tiebreak only affects running order — skip the campaign/adapter
    // lookup for preparing/ended reads (hot path; issue #611 review).
    let list: Combatant[];
    if (status === 'running') {
      const adapter = await this.adapterForCampaign(row.campaignId);
      list = this.sortCombatantsWithAdapter(combatantRows.map(combatantToDomain), status, adapter);
    } else {
      list = sortCombatants(combatantRows.map(combatantToDomain), status);
    }
    if (viewerRole !== undefined && viewerRole !== 'dm') {
      list = list.map(redactMonsterHp);
      // Hidden-NPC identity (issue #374): HP is banded by redactMonsterHp, but a combatant
      // linked to a HIDDEN NPC still leaked that NPC's identity to non-DMs via `npcId` + the
      // borrowed name. Hidden NPCs are dropped wholesale from every other non-DM surface, so
      // here we sever the identity link (null npcId) and mask the name — the token still shows
      // in initiative (its position matters to play) but not who it is.
      const linkedNpcIds = list.map((c) => c.npcId).filter((n): n is number => n !== null);
      if (linkedNpcIds.length > 0) {
        const hiddenRows = await this.db
          .select({ id: npcs.id })
          .from(npcs)
          .where(and(inArray(npcs.id, linkedNpcIds), eq(npcs.hidden, true)));
        const hiddenIds = new Set(hiddenRows.map((r) => r.id));
        if (hiddenIds.size > 0) {
          list = list.map((c) =>
            c.npcId !== null && hiddenIds.has(c.npcId) ? { ...c, npcId: null, name: UNKNOWN_COMBATANT_LABEL } : c,
          );
        }
      }
      // Fog of war (issue #40 / #463): withhold the position of any token in an
      // unrevealed region. Encounter JSON still degrades invalid fog to `null` for
      // the fog field itself, but token coordinates must fail closed the same way
      // the map-byte path does — otherwise a corrupt fog row would leak monster
      // positions while the image stayed fully masked. Sibling fog protection is
      // mirrored here too: when another encounter still conceals the shared map,
      // this fight's tokens must not float on a fully masked board.
      const fog = parseFog(row.fog);
      const invalidFog = row.fog !== null && fog === null;
      // Sibling protection applies whenever THIS encounter does not itself conceal
      // pixels — including fog enabled but fully revealed (no rectangles masked).
      const ownFogConceals = !invalidFog && fogConcealsPixels(fog);
      const siblingProtects =
        !invalidFog &&
        !ownFogConceals &&
        row.mapAttachmentId != null &&
        (await this.attachmentsService.isFogProtectedEncounterMap(row.mapAttachmentId, row.campaignId));
      if (invalidFog || siblingProtects) {
        const concealAll: FogState = { enabled: true, revealed: [] };
        list = list.map((c) => redactTokenInFog(c, concealAll));
      } else if (fog?.enabled) {
        list = list.map((c) => redactTokenInFog(c, fog));
      }
    }
    // Issue #466: when an ended fight's sheet HP diverged from the combatant snapshot,
    // surface conflicts so the DM can choose a resync direction before /reopen. DM-only
    // (and undefined-role internal callers); players never see the CAS preview.
    const hpSyncConflicts =
      status === 'ended' && (viewerRole === undefined || viewerRole === 'dm')
        ? await this.collectHpSyncConflicts(combatantRows)
        : undefined;
    const domain = encounterToDomain(row);
    const [redactedDomain] = await this.redactHiddenLinkedEntities([domain], row.campaignId, viewerRole);
    return {
      ...redactedDomain,
      combatants: list,
      ...(hpSyncConflicts && hpSyncConflicts.length > 0 ? { hpSyncConflicts } : {}),
    };
  }

  /**
   * Issue #466: compare each character combatant's snapshot against the live sheet.
   * A conflict is any divergent HP/death slice — the DM must pick keep_combatant or
   * pull_sheet before reopen can proceed.
   */
  private async collectHpSyncConflicts(
    combatantRows: Array<typeof combatants.$inferSelect>,
  ): Promise<HpSyncConflict[]> {
    const characterCombatants = combatantRows.filter((r) => r.kind === 'character' && r.characterId != null);
    if (characterCombatants.length === 0) return [];
    const characterIds = characterCombatants.map((r) => r.characterId!);
    const sheetRows = await this.db.select().from(characters).where(inArray(characters.id, characterIds));
    const sheetById = new Map(sheetRows.map((c) => [c.id, c]));
    const conflicts: HpSyncConflict[] = [];
    for (const row of characterCombatants) {
      const sheet = sheetById.get(row.characterId!);
      if (!sheet) continue;
      const combatantSlice = hpSyncSliceOf(row);
      const sheetSlice = hpSyncSliceOf(sheet);
      if (hpSyncSlicesEqual(combatantSlice, sheetSlice)) continue;
      conflicts.push({
        combatantId: row.id,
        characterId: sheet.id,
        name: row.name,
        combatant: combatantSlice,
        sheet: { ...sheetSlice, updatedAt: sheet.updatedAt },
      });
    }
    return conflicts;
  }

  async getCombatantRowOrThrow(encounterId: number, combatantId: number) {
    const [row] = await this.db
      .select()
      .from(combatants)
      .where(and(eq(combatants.id, combatantId), eq(combatants.encounterId, encounterId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
    return row;
  }

  /**
   * mapAttachmentId is an FK-shaped field (issue #39) — mirror CampaignsService's
   * validateAttachmentRef: the attachment must exist AND belong to THIS encounter's
   * campaign, so another campaign's attachment id can't be smuggled in. null clears it.
   */
  private async validateAttachmentRef(attachmentId: number | null | undefined, campaignId: number): Promise<void> {
    if (attachmentId == null) return;
    const [row] = await this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.campaignId, campaignId),
          eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException(`mapAttachmentId ${attachmentId} does not exist in this campaign`);
  }

  /**
   * DM-only: edit an encounter's name, its location/quest/session links (issue #126), and/or
   * its battle map (issue #39). Only fields present in `input` are written; `null` clears a
   * link/map. A linked location/quest/session must belong to THIS campaign (404).
   *
   * Attaching a battle map does NOT reveal the attachment (issue #259): a fogged encounter
   * map must stay hidden (DM-only) as a *handout* so it never surfaces raw on the player
   * Handouts card, defeating fog-of-war. The fogged encounter canvas still renders it for
   * players — the file route (GET /attachments/:id/file) serves an encounter's map to non-DM
   * even while hidden (see AttachmentsService.isEncounterMap).
   *
   * Optimistic concurrency (issue #532): live combat is the highest-contention entity (the
   * same encounter open across multiple DM devices — a laptop + a tablet at the table), so it
   * enforces the same `expectedUpdatedAt` CAS invariant as quests/npcs/locations/sessions. A
   * stale tab's save (its `expectedUpdatedAt` no longer matches the row's current `updatedAt`)
   * 409s before any write rather than silently clobbering the fresher edit — the classic
   * "lost fog/grid edit looks like the map reverted" failure. Omitted => unconditional write
   * (unchanged back-compat for any client that hasn't opted in).
   */
  async updateEncounter(
    encounterId: number,
    input: EncounterUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    // Optimistic concurrency (#532): 409 on a stale expectedUpdatedAt before any write.
    this.revisions.assertNotStale(encounterRow, opts?.expectedUpdatedAt);

    const set: Partial<typeof encounters.$inferInsert> = {};
    const changedPredicates: SQL[] = [];
    if (input.name !== undefined && input.name !== encounterRow.name) {
      set.name = input.name;
      changedPredicates.push(sql`${encounters.name} IS NOT ${input.name}`);
    }
    if (input.locationId !== undefined) {
      if (input.locationId !== null) await this.assertEntityInCampaign('location', input.locationId, encounterRow.campaignId);
      if (input.locationId !== encounterRow.locationId) {
        set.locationId = input.locationId;
        changedPredicates.push(sql`${encounters.locationId} IS NOT ${input.locationId}`);
      }
    }
    if (input.questId !== undefined) {
      if (input.questId !== null) await this.assertEntityInCampaign('quest', input.questId, encounterRow.campaignId);
      if (input.questId !== encounterRow.questId) {
        set.questId = input.questId;
        changedPredicates.push(sql`${encounters.questId} IS NOT ${input.questId}`);
      }
    }
    if (input.sessionId !== undefined) {
      if (input.sessionId !== null) await this.assertEntityInCampaign('session', input.sessionId, encounterRow.campaignId);
      if (input.sessionId !== encounterRow.sessionId) {
        set.sessionId = input.sessionId;
        changedPredicates.push(sql`${encounters.sessionId} IS NOT ${input.sessionId}`);
      }
    }
    if (input.mapAttachmentId !== undefined) {
      // Do NOT flip the attachment to hidden=false here (issue #259). A battle map must stay
      // hidden as a handout so it isn't exposed raw on the player Handouts card; the fogged
      // canvas still gets it via the file route's encounter-map exception.
      await this.validateAttachmentRef(input.mapAttachmentId, encounterRow.campaignId);
      if (input.mapAttachmentId !== encounterRow.mapAttachmentId) {
        set.mapAttachmentId = input.mapAttachmentId;
        changedPredicates.push(sql`${encounters.mapAttachmentId} IS NOT ${input.mapAttachmentId}`);
      }
    }
    // VTT grid config (issue #40, phase 2). Each field is independently settable/clearable.
    if (input.gridSize !== undefined && input.gridSize !== encounterRow.gridSize) {
      set.gridSize = input.gridSize;
      changedPredicates.push(sql`${encounters.gridSize} IS NOT ${input.gridSize}`);
    }
    if (input.gridScale !== undefined && input.gridScale !== encounterRow.gridScale) {
      set.gridScale = input.gridScale;
      changedPredicates.push(sql`${encounters.gridScale} IS NOT ${input.gridScale}`);
    }
    if (input.gridUnit !== undefined && input.gridUnit !== encounterRow.gridUnit) {
      set.gridUnit = input.gridUnit;
      changedPredicates.push(sql`${encounters.gridUnit} IS NOT ${input.gridUnit}`);
    }
    if (input.gridSnap !== undefined && input.gridSnap !== encounterRow.gridSnap) {
      set.gridSnap = input.gridSnap;
      changedPredicates.push(sql`${encounters.gridSnap} IS NOT ${input.gridSnap ? 1 : 0}`);
    }
    if (input.gridType !== undefined && input.gridType !== (encounterRow.gridType ?? 'square')) {
      set.gridType = input.gridType;
      changedPredicates.push(sql`${encounters.gridType} IS NOT ${input.gridType}`);
    }
    // Fog of war (issue #40, phase 3). Stored as JSON text; null clears it entirely.
    if (input.fog !== undefined && !isDeepStrictEqual(input.fog, parseFog(encounterRow.fog))) {
      const fog = input.fog === null ? null : toJsonText(input.fog);
      set.fog = fog;
      changedPredicates.push(sql`${encounters.fog} IS NOT ${fog}`);
    }
    // Shared AoE templates (issue #238). Stored as JSON text; an empty array clears them.
    if (input.aoe !== undefined && !isDeepStrictEqual(input.aoe, parseAoe(encounterRow.aoe))) {
      const aoe = toJsonText(input.aoe);
      set.aoe = aoe;
      changedPredicates.push(sql`${encounters.aoe} IS NOT ${aoe}`);
    }
    // Entity-level secrecy (issue #262) — DM-only (this whole endpoint requires dm). true
    // hides the encounter's roster + difficulty from non-DM reads; the DM reveals by
    // patching hidden back to false.
    if (input.hidden !== undefined && input.hidden !== encounterRow.hidden) {
      set.hidden = input.hidden;
      changedPredicates.push(sql`${encounters.hidden} IS NOT ${input.hidden ? 1 : 0}`);
    }

    if (changedPredicates.length === 0) {
      return this.getWithCombatantsOrThrow(encounterId, role);
    }

    set.updatedAt = nowIso();
    // The null-safe predicates make the semantic no-op check atomic. Two clients may both
    // observe missing defaults, but after the first write the second UPDATE changes zero rows
    // and therefore produces no duplicate audit entry or SSE invalidation (#865).
    const result = await this.db
      .update(encounters)
      .set(set)
      .where(and(eq(encounters.id, encounterId), or(...changedPredicates)));
    const rowsChanged = (result as unknown as { changes?: number }).changes ?? 0;
    if (rowsChanged === 0) {
      return this.getWithCombatantsOrThrow(encounterId, role);
    }

    // If this update activates fog over a map that had previously been revealed as
    // a handout, restage the raw attachment immediately. The raw-file route also
    // checks fog dynamically (defense in depth), so even a failure here cannot leak
    // source pixels; this keeps the attachment metadata/UI consistent as well.
    let effectiveMapId = input.mapAttachmentId !== undefined ? input.mapAttachmentId : encounterRow.mapAttachmentId;
    const effectiveFog = input.fog !== undefined ? input.fog : parseFog(encounterRow.fog);
    if (effectiveMapId != null && fogConcealsPixels(effectiveFog)) {
      // Reusing the campaign region-map attachment as a fogged battle map would
      // block players from GET /attachments/:id/file (RegionMap has no fog-safe
      // alternate). Clone the bytes onto a dedicated battle-map row and retarget
      // this encounter so the shared campaign background stays player-visible.
      const [campaign] = await this.db
        .select({ mapAttachmentId: campaigns.mapAttachmentId })
        .from(campaigns)
        .where(eq(campaigns.id, encounterRow.campaignId))
        .limit(1);
      if (campaign?.mapAttachmentId === effectiveMapId) {
        const clone = await this.attachmentsService.duplicate(effectiveMapId, user, role, {
          filenamePrefix: 'battle-',
        });
        await this.db
          .update(encounters)
          .set({ mapAttachmentId: clone.id, updatedAt: nowIso() })
          .where(eq(encounters.id, encounterId));
        effectiveMapId = clone.id;
      }

      const attachment = await this.attachmentsService.getRowOrThrow(effectiveMapId);
      // Only hide attachments that belong to this encounter's campaign — never
      // side-effect another campaign's row if a stale/cross-campaign id slipped through.
      if (attachment.campaignId === encounterRow.campaignId && !attachment.hidden) {
        await this.attachmentsService.setHidden(effectiveMapId, true, user, role);
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.update',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      detail: JSON.stringify(input),
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  /**
   * DM-only: reveal one rectangular region of the fog-of-war mask (issue #40, phase 3). Reads
   * the current fog state, enables fog if it wasn't already, appends the rectangle (capped so
   * the JSON blob stays bounded), and persists via updateEncounter — so the same audit trail,
   * SSE `encounter.updated` signal (other clients refetch live), and player-side token
   * redaction all apply. Exposed over MCP as `reveal_map_region` so an AI DM can light the
   * board a region at a time without round-tripping the whole mask.
   */
  async revealFogRegion(encounterId: number, rect: FogRect, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const row = await this.getRowOrThrow(encounterId);
    const current = parseFog(row.fog) ?? { enabled: true, revealed: [] };
    const next: FogState = { enabled: true, revealed: [...current.revealed, rect].slice(-500) };
    return this.updateEncounter(encounterId, { fog: next }, user, role);
  }

  /**
   * Broadcast a transient battle-map ping (issue #238). Unlike fog/AoE this persists nothing —
   * it rides the campaign event stream as a one-shot `encounter.ping` signal every open client
   * renders briefly and lets fade. Any writing member may drop one (a live table gesture, not
   * DM-gated); the caller-side controller asserts membership. Hidden encounters are
   * non-enumerating 404s for non-DMs (issue #869 — parity with roster/events/difficulty).
   * The ping location is a coordinate the sender chose, so there is no secret to leak
   * (contrast the id-only updated/deleted signals). Returns nothing meaningful — the effect
   * is the emitted event.
   */
  pingMap(
    encounterId: number,
    campaignId: number,
    ping: MapPing,
    viewerRole?: Role,
    /** Encounter.hidden from the caller's already-fetched row (issue #869). */
    hidden = false,
  ): void {
    if (viewerRole !== undefined && !isVisibleTo({ hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    this.events.emit({ type: 'encounter.ping', campaignId, encounterId, ping });
  }

  /**
   * Creates the encounter (preparing) and auto-adds every ACTIVE campaign character as a
   * combatant (issue #115 — non-active PCs are skipped).
   *
   * Issue #864: every non-null location/quest/session link is validated against THIS
   * campaign before any insert, audit, or SSE. Missing and foreign targets share one
   * non-enumerating 404. The encounter row + auto-added combatants commit in a single
   * transaction so a mid-create failure never leaves partial rows. REST, MCP,
   * generate?commit, and AI/proposal creates all funnel through this method.
   */
  async create(campaignId: number, input: EncounterCreateInput, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    // Validate links BEFORE any write so a bad target never produces an encounter row,
    // combatants, audit entry, or SSE event (issue #864).
    if (input.locationId != null) await this.assertEntityInCampaign('location', input.locationId, campaignId);
    if (input.questId != null) await this.assertEntityInCampaign('quest', input.questId, campaignId);
    if (input.sessionId != null) await this.assertEntityInCampaign('session', input.sessionId, campaignId);

    const ts = nowIso();

    // Auto-add only ACTIVE characters (issue #115). Dead/retired/inactive PCs stay on
    // the roster but are skipped here, so a long campaign's fallen and replaced
    // characters stop being force-conscripted into every new fight. The DM can still
    // add any of them manually via addCombatant. Legacy pre-migration rows all default
    // to 'active', preserving prior behavior.
    const partyRows = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), eq(characters.status, 'active'), notDeleted(characters.deletedAt)));
    // Resolve the adapter outside the write transaction — it is a pure campaign lookup
    // and must not sit between the encounter INSERT and the combatant INSERT.
    const adapter = partyRows.length > 0 ? await this.adapterForCampaign(campaignId) : null;

    // Encounter + party combatants land in ONE synchronous transaction (issue #864 /
    // better-sqlite3) so a mid-create failure never leaves a fight without its party
    // (or combatants without a parent). Audit/SSE fire only after commit.
    const encounterRow = this.db.transaction((tx) => {
      const [row] = tx
        .insert(encounters)
        .values({
          campaignId,
          name: input.name,
          status: 'preparing',
          round: 0,
          turnIndex: 0,
          // Optional where/why/when links (issue #126). undefined -> null.
          locationId: input.locationId ?? null,
          questId: input.questId ?? null,
          sessionId: input.sessionId ?? null,
          // Entity-level secrecy (issue #262): start hidden (DM prep) when requested.
          hidden: input.hidden ?? false,
          endedAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();

      // Auto-add the whole party in ONE multi-row INSERT (#72) rather than one INSERT
      // per character — the row values (including the sequential sortOrder) are computed
      // in JS and handed to a single `.values([...])`. Behavior is identical to the old
      // per-row loop; only the round-trip count changes (N -> 1).
      if (partyRows.length > 0 && adapter) {
        const combatantValues = partyRows.map((character, index) => {
          const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
          // Pass character level so PF2e (and similar) can include the proficiency/level
          // term on the Perception/WIS initiative fallback (issue #491). 5e ignores it.
          const initMod = adapter.initiativeModifier(stats, 'score', character.level);
          // Issue #711: seed the combatant's death/temp-HP slice from the persistent
          // sheet so a stable-but-unconscious PC (carried over from a prior fight via
          // /end reconciliation) re-enters the next encounter still down, not silently
          // revived. Defaults hold for pre-#711 sheets (alive + temp-less).
          return {
            encounterId: row.id,
            kind: 'character' as const,
            characterId: character.id,
            name: character.name,
            initiative: null,
            initMod,
            hpCurrent: character.hpCurrent,
            hpMax: character.hpMax,
            hpTemp: character.hpTemp,
            deathState: character.deathState,
            deathSaveSuccesses: character.deathSaveSuccesses,
            deathSaveFailures: character.deathSaveFailures,
            // Issue #466: stamp the sheet CAS token at open so a later re-end can detect
            // intervening sheet edits made while the encounter was ended.
            sheetSyncedUpdatedAt: character.updatedAt,
            // Issue #486: seed tracker conditions from the sheet so Poisoned (etc.)
            // applied before combat is already visible in the run-session roster.
            // Merge semantics for the overlap window: see sync comment on updateCombatant.
            conditions: character.conditions,
            ruleEntryId: null,
            sortOrder: index,
          };
        });
        tx.insert(combatants).values(combatantValues).run();
      }
      return row;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.create',
      entityType: 'encounter',
      entityId: encounterRow.id,
      campaignId,
      detail: `${partyRows.length} party member(s) auto-added`,
    });

    this.emitEncounterEvent('encounter.updated', campaignId, encounterRow.id);

    return this.getWithCombatantsOrThrow(encounterRow.id, role);
  }

  /**
   * Guard that a link target exists in the same campaign as the encounter (issues #126 /
   * #864). Missing and foreign (other-campaign) targets share one non-enumerating 404 —
   * the response never reveals whether the id exists elsewhere.
   */
  private async assertEntityInCampaign(kind: 'location' | 'quest' | 'session', id: number, campaignId: number): Promise<void> {
    const table = kind === 'location' ? locations : kind === 'quest' ? quests : sessions;
    const [row] = await this.db
      .select({ campaignId: table.campaignId })
      .from(table)
      .where(and(eq(table.id, id), eq(table.campaignId, campaignId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException(`${kind} not found`);
    }
  }

  /**
   * Compute a read-only difficulty estimate for an encounter (issues #58 + #429). Pulls the
   * PC levels from character-combatants and monster CRs from linked rule entries, then
   * asks the campaign's RuleSystemAdapter to own the math/labels/support status. Homebrew
   * and non-5e systems return an explicit unsupported result; manual enemies with no CR/XP
   * return unknown ("Unknown—add XP/CR") instead of a misleading Trivial band.
   */
  async getDifficulty(encounterId: number, viewerRole?: Role): Promise<EncounterDifficulty> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    // Entity-level secrecy (issue #262): a hidden encounter's difficulty (monsterCount +
    // adjustedXp) is DM-only prep — deny a non-DM the same way the roster read does (404, so
    // existence isn't leaked). undefined role is DM-facing and always allowed.
    if (viewerRole !== undefined && !isVisibleTo({ hidden: encounterRow.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const [campaignRow] = await this.db
      .select({ ruleSystem: campaigns.ruleSystem })
      .from(campaigns)
      .where(eq(campaigns.id, encounterRow.campaignId))
      .limit(1);
    const ruleSystem = campaignRow?.ruleSystem ?? null;
    const adapter = ruleSystemAdapter(ruleSystem);
    const combatantRows = await this.listCombatantRows(encounterId);

    // Party levels: from each character-combatant's linked character sheet.
    const characterIds = combatantRows
      .filter((c) => c.kind === 'character' && c.characterId !== null)
      .map((c) => c.characterId as number);
    const levelById = new Map<number, number>();
    if (characterIds.length > 0) {
      const charRows = await this.db
        .select({ id: characters.id, level: characters.level })
        .from(characters)
        .where(inArray(characters.id, characterIds));
      for (const r of charRows) levelById.set(r.id, r.level);
    }
    const partyLevels = characterIds.map((id) => levelById.get(id) ?? 1);

    // Monster CRs: from each monster-combatant's linked rule entry statblock. A monster
    // combatant with no ruleEntryId (or an entry lacking a CR) contributes a null CR
    // rather than being dropped, so missing data can surface as unknown (issue #429).
    const monsterCombatants = combatantRows.filter((c) => c.kind === 'monster');
    const ruleEntryIds = monsterCombatants.map((c) => c.ruleEntryId).filter((id): id is number => id !== null);
    const crById = new Map<number, number | null>();
    if (ruleEntryIds.length > 0) {
      const entryRows = await this.db
        .select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson })
        .from(ruleEntries)
        .where(inArray(ruleEntries.id, ruleEntryIds));
      for (const r of entryRows) {
        const data = fromJsonText<Record<string, unknown>>(r.dataJson, {});
        // Statblock CR field mapping comes from the adapter (issue #70), not inline field names.
        crById.set(r.id, parseCr(adapter.mapStatblock(data).challengeRating));
      }
    }
    const monsterCrs = monsterCombatants.map((c) => (c.ruleEntryId !== null ? (crById.get(c.ruleEntryId) ?? null) : null));

    return estimateEncounterDifficultyForRuleSystem(ruleSystem, {
      partyLevels,
      monsterChallengeRatings: monsterCrs,
    });
  }

  /**
   * Resolve the party's PC levels for a generation (issue #304): the explicit `party`
   * override when given, otherwise the campaign's ACTIVE characters' sheet levels (issue
   * #115 — dead/retired PCs don't set the budget). Empty when a fresh campaign has no PCs,
   * which the generator handles (it can only produce `trivial` against an empty party).
   */
  private async resolvePartyLevels(campaignId: number, explicit?: number[]): Promise<number[]> {
    if (explicit && explicit.length > 0) return explicit;
    const rows = await this.db
      .select({ level: characters.level })
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), eq(characters.status, 'active'), notDeleted(characters.deletedAt)));
    return rows.map((r) => r.level);
  }

  /**
   * Load the compendium monsters a generation may pick from (issue #304), scored for the
   * 5e budget math. Reads rule_entries of type 'monster' (installed packs only — that's all
   * rule_entries ever contains), maps each statblock via the campaign's RuleSystemAdapter
   * (#70) to a CR/HP, computes per-monster XP from the #58 CR→XP table, and applies the
   * optional creature-type / environment / CR-range / pack filters. Never persists.
   */
  private async loadMonsterCandidates(
    adapter: RuleSystemAdapter,
    filters: EncounterGenerateInput['filters'],
  ): Promise<GeneratorCandidate[]> {
    // Optional single-pack scoping: resolve the slug to a pack id, or short-circuit to no
    // candidates if the slug isn't installed (mirrors RulesService.search's pack filter).
    let packId: number | undefined;
    if (filters?.packSlug) {
      const [pack] = await this.db.select({ id: rulePacks.id }).from(rulePacks).where(eq(rulePacks.slug, filters.packSlug)).limit(1);
      if (!pack) return [];
      packId = pack.id;
    }

    const where = packId !== undefined ? and(eq(ruleEntries.type, 'monster'), eq(ruleEntries.packId, packId)) : eq(ruleEntries.type, 'monster');
    const rows = await this.db.select({ id: ruleEntries.id, name: ruleEntries.name, dataJson: ruleEntries.dataJson }).from(ruleEntries).where(where);

    const typeNeedle = filters?.creatureType?.trim().toLowerCase();
    const envNeedle = filters?.environment?.trim().toLowerCase();

    const candidates: GeneratorCandidate[] = [];
    for (const row of rows) {
      const data = fromJsonText<Record<string, unknown>>(row.dataJson, {});
      const mapped = adapter.mapStatblock(data);
      const cr = parseCr(mapped.challengeRating);

      // CR-range filter: a monster with an unparseable CR is excluded when either bound is set.
      if (filters?.minCr !== undefined || filters?.maxCr !== undefined) {
        if (cr === null) continue;
        if (filters.minCr !== undefined && cr < filters.minCr) continue;
        if (filters.maxCr !== undefined && cr > filters.maxCr) continue;
      }
      // Creature-type substring filter (e.g. "undead", "dragon").
      if (typeNeedle) {
        const t = typeof mapped.creatureType === 'string' ? mapped.creatureType.toLowerCase() : '';
        if (!t.includes(typeNeedle)) continue;
      }
      // Environment substring filter — best-effort over the raw statblock's environments,
      // which the canonical MonsterStatblockData doesn't carry (Open5e ships `environments`).
      if (envNeedle) {
        const raw = (data.environments ?? data.environment) as unknown;
        const envs = Array.isArray(raw) ? raw.map((e) => String(e).toLowerCase()) : typeof raw === 'string' ? [raw.toLowerCase()] : [];
        if (!envs.some((e) => e.includes(envNeedle))) continue;
      }

      candidates.push({ ruleEntryId: row.id, name: row.name, cr, xp: crToXp(cr), hpMax: adapter.monsterHitPoints(data) });
    }
    return candidates;
  }

  /**
   * Generate (but do NOT persist) a balanced monster group for a party + target difficulty
   * (issue #304). Read-only "suggestion": assembles a group from the installed compendium
   * to hit the requested #58 band, deterministic by `seed`. Any campaign member (or AI) may
   * preview — committing is the separate create write path (create + addCombatant), so
   * write-mode (#158)/proposals (#124)/secrecy (#262) all apply there, not here.
   *
   * `viewerRole` is accepted for parity with the other reads but a suggestion is derived
   * data over the shared compendium — there's no hidden per-encounter row to redact yet
   * (the encounter doesn't exist until commit).
   */
  async generateEncounter(campaignId: number, input: EncounterGenerateInput, _viewerRole?: Role): Promise<EncounterSuggestion> {
    const adapter = await this.adapterForCampaign(campaignId);
    const partyLevels = await this.resolvePartyLevels(campaignId, input.party);
    const candidates = await this.loadMonsterCandidates(adapter, input.filters);

    // Mint a seed when the caller didn't supply one, so the result is reproducible: the
    // returned seed round-trips back through `seed` to rebuild the identical group.
    const seed = input.seed ?? Math.floor(Math.random() * 0xffffffff);
    const maxCount = input.count ?? 12;

    const result = generateEncounterGroup({
      partyLevels,
      targetBand: input.difficulty,
      candidates,
      shape: input.shape,
      maxCount,
      seed,
    });

    return {
      combatants: result.picks.map((p) => ({ ruleEntryId: p.ruleEntryId, name: p.name, cr: p.cr, xp: p.xp, hpMax: p.hpMax, count: p.count })),
      targetBand: input.difficulty,
      difficulty: result.difficulty,
      totalXp: result.difficulty.adjustedXp,
      shape: result.shape,
      seed: result.seed,
      matchedBand: result.matchedBand,
    };
  }

  /**
   * Convenience commit path for POST .../generate?commit=true (issue #304): run the
   * read-only generator, then persist the suggestion as a real encounter through the normal
   * write path — create() (auto-adds the party) followed by addCombatant() per monster line
   * (each with its `count`). The caller (controller) has already passed the dm + write-mode
   * guard, so this stays behind the same authz as any other encounter write. Created hidden
   * (DM-only prep, #262) and `preparing` by default, so nothing leaks to players pre-spring.
   * Returns the created encounter with its combatants plus the suggestion that seeded it.
   */
  async generateAndCreateEncounter(
    campaignId: number,
    input: EncounterGenerateInput,
    user: RequestUser,
    role: Role,
  ): Promise<{ encounter: EncounterWithCombatants; suggestion: EncounterSuggestion }> {
    const suggestion = await this.generateEncounter(campaignId, input, role);

    const name = input.name ?? `Generated ${input.difficulty} encounter`;
    const encounter = await this.create(
      campaignId,
      {
        name,
        locationId: input.locationId ?? undefined,
        questId: input.questId ?? undefined,
        // Default hidden (DM prep, #262) unless the caller explicitly opts out.
        hidden: input.hidden ?? true,
      },
      user,
      role,
    );

    for (const line of suggestion.combatants) {
      await this.addCombatant(encounter.id, { kind: 'monster', ruleEntryId: line.ruleEntryId, count: line.count }, user, role);
    }

    const withCombatants = await this.getWithCombatantsOrThrow(encounter.id, role);
    return { encounter: withCombatants, suggestion };
  }

  /**
   * Compact per-encounter digest for the campaign summary (issue #126) — enough for an
   * AI recap to see combat happened, where/why/when it was pinned, and a down tally,
   * without loading full combatant rows. One encounters query plus one grouped-count
   * query over combatants, both scoped to the campaign.
   *
   * Issue #625: the tally is split by kind — `downCount` counts only PCs/NPCs who fell
   * (0 HP / dead) and `monstersDefeated` counts dead monsters, so a glance at the summary
   * reflects fallen party members rather than every corpse on the field.
   */
  async digestForCampaign(campaignId: number, viewerRole?: Role): Promise<EncounterDigest[]> {
    const allRows = await this.db.select().from(encounters).where(eq(encounters.campaignId, campaignId));
    // Entity-level secrecy (issue #262): drop hidden encounters from a non-DM's campaign
    // summary, mirroring how quests/npcs are role-filtered in CampaignsService.summary.
    const rows = viewerRole === undefined || viewerRole === 'dm' ? allRows : allRows.filter((r) => !r.hidden);
    if (rows.length === 0) return [];

    const encounterIds = rows.map((r) => r.id);
    // Issue #625: split the down tally by kind. `downCount` reports only PCs/NPCs who
    // fell (the meaningful "who's down" glance); `monstersDefeated` reports dead monsters
    // separately so a pile of goblin corpses no longer inflates the party's casualties.
    const tally = await this.db
      .select({
        encounterId: combatants.encounterId,
        total: sql<number>`COUNT(*)`,
        down: sql<number>`SUM(CASE WHEN ${combatants.kind} != 'monster' AND (${combatants.hpCurrent} <= 0 OR ${combatants.deathState} = 'dead') THEN 1 ELSE 0 END)`,
        monstersDefeated: sql<number>`SUM(CASE WHEN ${combatants.kind} = 'monster' AND (${combatants.hpCurrent} <= 0 OR ${combatants.deathState} = 'dead') THEN 1 ELSE 0 END)`,
      })
      .from(combatants)
      .where(inArray(combatants.encounterId, encounterIds))
      .groupBy(combatants.encounterId);
    const tallyById = new Map(
      tally.map((t) => [t.encounterId, { total: Number(t.total), down: Number(t.down), monstersDefeated: Number(t.monstersDefeated) }]),
    );

    const digests: EncounterDigest[] = rows.map((r) => {
      const t = tallyById.get(r.id) ?? { total: 0, down: 0, monstersDefeated: 0 };
      return {
        id: r.id,
        name: r.name,
        status: r.status as EncounterStatus,
        round: r.round,
        endedAt: r.endedAt,
        locationId: r.locationId,
        questId: r.questId,
        sessionId: r.sessionId,
        combatantCount: t.total,
        downCount: t.down,
        monstersDefeated: t.monstersDefeated,
      };
    });
    return this.redactHiddenLinkedEntities(digests, campaignId, viewerRole);
  }

  /**
   * Adds a combatant. Resolution order for name/hp/initMod when not explicitly given:
   *  - kind='character' + characterId -> pull from the character row
   *  - kind='monster' + ruleEntryId -> try name + hit points from rule_entries.dataJson,
   *    falling back to whatever the caller explicitly provided
   *  - otherwise the caller must provide name + hpMax directly
   * Throws 400 if, after resolution, we still don't have a name or an hpMax.
   */
  async addCombatant(encounterId: number, input: CombatantCreateInput, user: RequestUser, role: Role): Promise<Combatant> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);

    let name = input.name;
    let hpMax = input.hpMax;
    let initMod = input.initMod ?? 0;
    let hpCurrent: number | undefined;
    // Issue #711: the persistent death/temp-HP slice a character carries into
    // combat. Only populated on the kind='character' branch (monsters/NPCs start
    // alive + temp-less); threaded into the INSERT below so a stable/dying PC
    // late-joining a fight doesn't get silently revived.
    let characterHpTemp = 0;
    let characterDeathState = 'none';
    let characterDeathSaveSuccesses = 0;
    let characterDeathSaveFailures = 0;
    let characterSheetUpdatedAt: string | null = null;
    // Issue #486: sheet conditions carried into a late-join character combatant.
    let characterConditions = '[]';
    // NOT pre-seeded from input.ruleEntryId — only set once the row is confirmed to exist
    // below, so a dangling id can never make it into the INSERT (was previously assigned
    // unconditionally here, so a bogus/deleted ruleEntryId silently got stored).
    let ruleEntryId: number | null = null;
    let characterId: number | null = null;
    let npcId: number | null = null;

    // NPC identity link (kind='npc'): validate the NPC belongs to this campaign and use
    // it as the default name. HP/initiative still come from a linked statblock
    // (ruleEntryId, resolved below) or an explicit hpMax — so an NPC can borrow a monster
    // statblock or be tracked with manual HP. Runs alongside (not instead of) the
    // ruleEntryId branch, so an NPC WITH a statblock resolves both.
    if (input.kind === 'npc' && input.npcId !== undefined) {
      // notDeleted (issue #374): a trashed/soft-deleted NPC must not be addable as a combatant.
      const [npc] = await this.db
        .select()
        .from(npcs)
        .where(and(eq(npcs.id, input.npcId), notDeleted(npcs.deletedAt)))
        .limit(1);
      if (!npc) throw new BadRequestException(`NPC ${input.npcId} not found`);
      if (npc.campaignId !== encounterRow.campaignId) {
        throw new NotFoundException(`NPC ${input.npcId} not found in campaign ${encounterRow.campaignId}`);
      }
      // Uniqueness guard — the issue #51 pattern, extended to NPC combatants per #374: an NPC
      // may appear at most once in an encounter. Without this, re-adding the same NPC forks it
      // into two rows that then track HP independently. 409 rather than a silent duplicate.
      // Carries the existing combatant id (issue #749) so a caller can treat the duplicate as
      // an idempotent re-add; the DB partial unique index (idx_combatants_encounter_npc) is the
      // backstop that catches the TOCTOU race where two adds pass this probe simultaneously.
      const [dup] = await this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.encounterId, encounterId), eq(combatants.npcId, npc.id)))
        .limit(1);
      if (dup) {
        throw new ConflictException({
          code: 'COMBATANT_IDENTITY_CONFLICT',
          message: `NPC ${npc.id} is already a combatant in encounter ${encounterId}`,
          combatantId: dup.id,
        });
      }
      npcId = npc.id;
      name = name ?? npc.name;
    }

    if (input.kind === 'character' && input.characterId !== undefined) {
      const [character] = await this.db.select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
      if (!character) throw new BadRequestException(`Character ${input.characterId} not found`);
      // A characterId from a DIFFERENT campaign than this encounter's is not just an
      // invalid input (400) — it's a resource that doesn't exist from this encounter's
      // point of view, so 404, matching how a cross-campaign id 404s elsewhere (e.g.
      // CampaignAccessService's member checks).
      if (character.campaignId !== encounterRow.campaignId) {
        throw new NotFoundException(`Character ${input.characterId} not found in campaign ${encounterRow.campaignId}`);
      }
      // Uniqueness guard (issue #51): a character may appear at most once in an
      // encounter's initiative. Without this the API happily adds the same PC twice
      // (a manual re-add, or racing the create() auto-add) — duplicate rows that
      // then track HP independently and clutter the order. 409 Conflict rather than
      // silently upserting, so the caller learns their add was a no-op. Carries the
      // existing combatant id (issue #749); the DB partial unique index
      // (idx_combatants_encounter_character) backstops the TOCTOU race where two
      // adds pass this probe at once.
      const [dup] = await this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.encounterId, encounterId), eq(combatants.characterId, character.id)))
        .limit(1);
      if (dup) {
        throw new ConflictException({
          code: 'COMBATANT_IDENTITY_CONFLICT',
          message: `Character ${character.id} is already a combatant in encounter ${encounterId}`,
          combatantId: dup.id,
        });
      }
      characterId = character.id;
      name = name ?? character.name;
      hpMax = hpMax ?? character.hpMax;
      hpCurrent = character.hpCurrent;
      // Issue #711: seed the death/temp-HP slice from the persistent sheet so a
      // late-joining stable/dying PC re-enters combat in that state (mirrors the
      // create() auto-add path). Monsters/NPCs below default to alive/temp-less.
      characterHpTemp = character.hpTemp;
      characterDeathState = character.deathState;
      characterDeathSaveSuccesses = character.deathSaveSuccesses;
      characterDeathSaveFailures = character.deathSaveFailures;
      characterSheetUpdatedAt = character.updatedAt;
      // Issue #486: seed from the sheet (same contract as create() auto-add).
      characterConditions = character.conditions;
      if (input.initMod === undefined) {
        const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
        // Character level feeds PF2e trained-Perception proficiency (issue #491).
        initMod = adapter.initiativeModifier(stats, 'score', character.level);
      }
    } else if (input.ruleEntryId !== undefined) {
      // Any explicitly-supplied ruleEntryId (not just kind='monster') must resolve to a
      // real rule_entries row — 400 rather than silently dropping it and inserting a
      // combatant with a dangling reference.
      const [entry] = await this.db.select().from(ruleEntries).where(eq(ruleEntries.id, input.ruleEntryId)).limit(1);
      if (!entry) {
        throw new BadRequestException(`Rule entry ${input.ruleEntryId} not found`);
      }
      ruleEntryId = entry.id;
      name = name ?? entry.name;
      const data = fromJsonText<Record<string, unknown>>(entry.dataJson, {});
      // HP + initiative come from the RuleSystemAdapter's statblock mapping (issue #70) —
      // 5e reads dataJson.hitPoints and derives init from abilityScores.dexterity — rather
      // than inlining those field names here, so a non-5e monster statblock maps its own way.
      if (hpMax === undefined) {
        const hp = adapter.monsterHitPoints(data);
        if (hp !== null) hpMax = hp;
      }
      if (input.initMod === undefined) {
        // Pass abilityRepresentation so PF2e creature modifiers (and Open Legend native
        // attributes) are not score-converted a second time (issue #767).
        const mapped = adapter.mapStatblock(data);
        // Issue #764: when the adapter can distinguish "unavailable" from a genuine +0
        // (PF1e), refuse to invent a silent zero — the DM must supply initMod explicitly.
        if (adapter.initiativeModifierOrNull) {
          const resolved = adapter.initiativeModifierOrNull(
            mapped.abilityScores,
            mapped.abilityRepresentation,
          );
          if (resolved === null) {
            throw new BadRequestException(
              'Unable to resolve initiative for this combatant — provide "initMod" explicitly (statblock has no native Init or DEX)',
            );
          }
          initMod = resolved;
        } else {
          initMod = adapter.initiativeModifier(mapped.abilityScores, mapped.abilityRepresentation);
        }
      }
    }

    if (!name) {
      throw new BadRequestException('Unable to resolve a name for this combatant — provide "name" explicitly');
    }
    if (hpMax === undefined) {
      throw new BadRequestException('Unable to resolve hpMax for this combatant — provide "hpMax" explicitly');
    }
    if (hpCurrent === undefined) hpCurrent = hpMax;

    // Issue #114: `count` adds N identical combatants in one call. Auto-suffix the
    // names "Goblin 1".."Goblin N" so duplicate monsters are distinguishable in the
    // order (the docs' "three goblins" example). count is meaningless for a
    // character add (a PC is unique and uniqueness-guarded above), so it's ignored
    // there — the characterId branch never sets count>1 in practice.
    const count = input.characterId !== undefined || input.npcId !== undefined ? 1 : Math.max(1, input.count ?? 1);
    const names = count > 1 ? Array.from({ length: count }, (_, i) => `${name} ${i + 1}`) : [name];

    // Issue #86: derive sortOrder in SQL (MAX(sort_order)+1) instead of from a
    // stale `existing.length` read — two concurrent adds used to read the same
    // count and insert colliding sortOrders. Sequential awaits (not Promise.all) so
    // each row's MAX(sort_order)+1 subquery observes the prior insert and the batch
    // gets distinct, contiguous orders.
    //
    // Issue #749: the SELECT-then-INSERT duplicate probes above are a TOCTOU race
    // — two concurrent adds of the same character/NPC both observe no existing row
    // and both reach this INSERT. The partial unique indexes
    // (idx_combatants_encounter_character / idx_combatants_encounter_npc) now make
    // the loser's INSERT throw SQLITE_CONSTRAINT_UNIQUE. We catch it and re-read the
    // WINNING combatant so the caller gets a deterministic 409 carrying the existing
    // combatant id, not a generic 500. This fires only for identity adds (character/
    // npc) — a `count>1` monster batch never touches the partial indexes, so the
    // loop never throws there. Throwing here (before audit/event) keeps everything
    // consistent: the WINNING caller owns the single audit entry + SSE signal.
    const insertedRows: (typeof combatants.$inferSelect)[] = [];
    try {
      for (const n of names) {
        const [inserted] = await this.db
          .insert(combatants)
          .values({
            encounterId,
            kind: input.kind,
            characterId,
            npcId,
            name: n,
            initiative: null,
            initMod,
            hpCurrent,
            hpMax,
            // Issue #711: only a character combatant carries the persistent
            // death/temp-HP slice in; monsters/NPCs default to alive/temp-less
            // (the Combatant schema defaults handle the unset monster case).
            ...(characterId !== null
              ? {
                  hpTemp: characterHpTemp,
                  deathState: characterDeathState,
                  deathSaveSuccesses: characterDeathSaveSuccesses,
                  deathSaveFailures: characterDeathSaveFailures,
                  // Issue #466: CAS token for sheet↔combatant HP sync at add time.
                  sheetSyncedUpdatedAt: characterSheetUpdatedAt,
                }
              : {}),
            // Issue #486: character combatants inherit sheet conditions; monsters/NPCs start empty.
            conditions: characterId !== null ? characterConditions : '[]',
            ruleEntryId,
            sortOrder: sql`(SELECT COALESCE(MAX(${combatants.sortOrder}), -1) + 1 FROM ${combatants} WHERE ${combatants.encounterId} = ${encounterId})`,
          })
          .returning();
        insertedRows.push(inserted);
      }
    } catch (err) {
      if (isUniqueConstraintError(err) && (characterId !== null || npcId !== null)) {
        // The race loser: another caller inserted this same identity between our
        // probe and our INSERT. Re-read the winning row so the 409 carries its id
        // (deterministic — exactly one row can match the partial unique index now).
        // If the re-read somehow finds nothing (the winner was rolled back, or the
        // constraint fired for an unrelated reason), rethrow the original
        // SQLITE_CONSTRAINT error so the caller sees the real failure rather than
        // a generic 409 that masks it.
        const winner = await this.findExistingIdentityCombatant(encounterId, characterId, npcId);
        if (winner) {
          throw new ConflictException({
            code: 'COMBATANT_IDENTITY_CONFLICT',
            message: `${characterId !== null ? `Character ${characterId}` : `NPC ${npcId}`} is already a combatant in encounter ${encounterId}`,
            combatantId: winner.id,
          });
        }
      }
      throw err;
    }
    const row = insertedRows[0];

    // Keep the positional turnIndex aligned with the identity pointer after the row
    // count changes (issue #49). A freshly-added combatant has null initiative and so
    // sorts last, so the current actor's index is normally unchanged — but re-deriving
    // it keeps turnIndex correct regardless.
    if (encounterRow.status === 'running') {
      const rows = await this.listCombatantRows(encounterId);
      const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), 'running', adapter);
      const turnIndex = turnIndexFor(sorted, encounterRow.currentCombatantId);
      if (turnIndex !== encounterRow.turnIndex) {
        await this.db.update(encounters).set({ turnIndex, updatedAt: nowIso() }).where(eq(encounters.id, encounterId));
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.combatant.add',
      entityType: 'combatant',
      entityId: row.id,
      campaignId: encounterRow.campaignId,
      detail: insertedRows.length > 1 ? `${name} ×${insertedRows.length}` : name,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return combatantToDomain(row);
  }

  /**
   * dm may change anything (including initiative, and the combatant identity fields
   * name/hpMax/initMod — issue #114). A player may only touch HP-ish fields
   * (hpDelta, hpSet, hpTemp, deathSave counters, add/removeConditions), and only on a
   * combatant whose characterId links to a character THEY own — everything else 403s.
   */
  async updateCombatant(
    encounterId: number,
    combatantId: number,
    patch: CombatantUpdateInput,
    user: RequestUser,
    role: Role,
  ): Promise<Combatant> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const existing = await this.getCombatantRowOrThrow(encounterId, combatantId);

    const isDm = role === 'dm';
    if (!isDm) {
      // Identity + initiative edits are DM-only (issue #114): a player must not be
      // able to rename a combatant or rewrite its hpMax/initMod, only adjust HP.
      if (patch.initiative !== undefined) {
        throw new ForbiddenException('Only dm may set initiative');
      }
      // Combat-log actor attribution is DM-authored (apply-damage UI). A player
      // patching their own combatant must not spoof who dealt the damage/heal.
      if (patch.actorId !== undefined) {
        throw new ForbiddenException('Only dm may set combat log actor');
      }
      if (patch.name !== undefined || patch.hpMax !== undefined || patch.initMod !== undefined || patch.tokenSize !== undefined) {
        throw new ForbiddenException('Only dm may edit a combatant’s name, hpMax, initMod, or tokenSize');
      }
      if (!existing.characterId) {
        throw new ForbiddenException('Only dm may modify this combatant');
      }
      const [character] = await this.db.select().from(characters).where(eq(characters.id, existing.characterId)).limit(1);
      if (!character || character.ownerUserId !== user.id) {
        throw new ForbiddenException('Only dm or the owning player may modify this combatant');
      }
    }

    // Issue #495: non-DM adds must be in the active rule system's condition
    // vocabulary. The wire schema stays free-text (so DMs can mint homebrew /
    // custom labels), but a player cannot inject arbitrary mechanical text into
    // the shared tracker. Matching is case-insensitive; the stored string is
    // still whatever the caller sent. MCP `update_combatant` shares this path.
    if (!isDm && patch.addConditions !== undefined && patch.addConditions.length > 0) {
      const adapter = await this.adapterForCampaign(encounterRow.campaignId);
      const unknown = patch.addConditions.filter((c) => !isKnownCondition(adapter.conditions, c));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Unknown condition(s) for this rule system: ${unknown.map((c) => JSON.stringify(c)).join(', ')}. ` +
            'Players may only add conditions from the active rule vocabulary; the DM may mint custom entries.',
        );
      }
    }

    // Non-HP field writes computed up front (initiative/identity). The HP +
    // death-save fields AND the condition add/remove deltas are computed INSIDE
    // the transaction below off a fresh read, so concurrent damage and concurrent
    // condition changes both compose atomically (issues #86, #747).
    const staticUpdate: Partial<typeof combatants.$inferInsert> = {};

    if (patch.initiative !== undefined && isDm) staticUpdate.initiative = patch.initiative;
    if (patch.name !== undefined && isDm) staticUpdate.name = patch.name;
    if (patch.initMod !== undefined && isDm) staticUpdate.initMod = patch.initMod;
    // Battle-map token position (issue #39). Not DM-gated: the player-write branch above
    // already restricts a non-DM to a combatant linked to a character they own, which is
    // exactly the "a player moves only their own token" rule. Clamp to 0–100 (mirrors the
    // campaign map's pin drag). Each axis is applied independently — a partial update
    // leaves the other coordinate unchanged. An explicit `null` clears the position
    // (unplace, issue #271) — write it straight through rather than clamping, since
    // clampPercent(null) would collapse to 0 and pin the token to a corner.
    if (patch.tokenX !== undefined) staticUpdate.tokenX = patch.tokenX === null ? null : clampPercent(patch.tokenX);
    if (patch.tokenY !== undefined) staticUpdate.tokenY = patch.tokenY === null ? null : clampPercent(patch.tokenY);
    // Token footprint size (issue #40) — DM-only (identity-like), same gate as name/hpMax above.
    if (patch.tokenSize !== undefined && isDm) staticUpdate.tokenSize = patch.tokenSize;

    const hpMaxChanged = patch.hpMax !== undefined && isDm;
    // Any field that flows through the 5e HP/death-save engine (applyCombatantHp).
    const hpFieldsTouched =
      patch.hpDelta !== undefined ||
      patch.hpSet !== undefined ||
      patch.hpTemp !== undefined ||
      patch.deathSaveSuccesses !== undefined ||
      patch.deathSaveFailures !== undefined ||
      patch.deathSaveRoll !== undefined;
    // A recompute is needed if any HP field changed OR hpMax moved (hpCurrent may
    // need re-clamping to a lowered max, and the death state re-derived).
    const recomputeHp = hpFieldsTouched || hpMaxChanged;
    // Condition add/remove deltas — applied INSIDE the transaction below off the
    // fresh row, so two concurrent condition changes (one adds while another
    // removes a different condition) compose instead of the loser's whole-array
    // write silently clobbering the winner's (issue #747, same class as #86/#657).
    const conditionsTouched = patch.addConditions !== undefined || patch.removeConditions !== undefined;

    if (Object.keys(staticUpdate).length === 0 && !recomputeHp && !conditionsTouched) {
      return combatantToDomain(existing);
    }

    // Combatant write + linked-character HP/conditions mirror run in ONE synchronous
    // better-sqlite3 transaction (issue #86): the HP math reads the row's CURRENT
    // committed values inside the transaction (never a stale pre-await read), so two
    // authorized deltas landing near-simultaneously compose instead of clobbering —
    // better-sqlite3 serializes the whole synchronous callback. The mirror then reads
    // the transaction's own result.
    //
    // The character mirror is additionally gated on a still-live (non-'ended')
    // encounter (issue #163). assertMutable() above already rejects an ended encounter
    // outright, so this is defense-in-depth: post-combat combatant rows must never leak
    // back onto the live character sheet even if that guard is ever relaxed.
    //
    // Issue #486 — sheet↔combatant condition merge semantics (overlap window):
    //   • create/addCombatant seeds the combatant from the sheet.
    //   • A tracker write (addConditions/removeConditions) applies set deltas on the
    //     combatant (#747) then overwrites the linked sheet's conditions array.
    //   • A sheet write (CharactersService.patchConditions / PATCH conditions) overwrites
    //     the linked live combatant's conditions array (and stamps the CAS token).
    //   • Last cross-surface write wins as a whole array — there is no 3-way merge.
    //     Concurrent tracker deltas still compose via the in-tx set rebase (#747).
    //   • /end writes combatant conditions back onto the sheet alongside HP.
    //   • MCP `update_combatant` and `set_character_conditions` share these paths.
    const mirrorSheet =
      existing.kind === 'character' &&
      existing.characterId !== null &&
      encounterRow.status !== 'ended' &&
      (recomputeHp || conditionsTouched);
    let row!: typeof combatants.$inferSelect;
    // Captured inside the transaction (off the fresh committed read + the write result)
    // so the combat-log events appended after commit reflect the real before/after HP
    // and death state, even when concurrent deltas composed (issue #61).
    let beforeHp = 0;
    let beforeTemp = 0;
    let beforeDeath = 'none';
    let afterHp = 0;
    let afterTemp = 0;
    let afterDeath = 'none';
    // Condition snapshots captured inside the tx (off the fresh row + the write
    // result) so combat-log events derive from the actual committed before/after
    // state, not a stale pre-await read (issue #747, mirroring the HP snapshots).
    let beforeConditions: Set<string> = new Set();
    let afterConditions: Set<string> = new Set();
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
      beforeHp = fresh.hpCurrent;
      beforeTemp = fresh.hpTemp;
      beforeDeath = fresh.deathState;
      const writeSet: Partial<typeof combatants.$inferInsert> = { ...staticUpdate };
      if (conditionsTouched) {
        // Rebase the add/remove deltas against the FRESH row's conditions (issue
        // #747). A stale whole-array write — derived outside the tx from the
        // pre-await read — let two concurrent callers clobber each other: caller A
        // adds 'poisoned' while caller B removes 'prone', and whichever wrote
        // second replaced the array entirely, dropping the other's change. By
        // reading `fresh.conditions` inside the serialized transaction and applying
        // both deltas as set union/difference, concurrent changes compose — the
        // same read-from-fresh pattern the HP path uses. Retries (re-adding an
        // already-present or re-removing an absent condition) are idempotent: the
        // set ops are no-ops and `afterConditions` equals `beforeConditions`.
        const current = new Set(fromJsonText<string[]>(fresh.conditions, []));
        beforeConditions = new Set(current);
        for (const c of patch.removeConditions ?? []) current.delete(c);
        for (const c of patch.addConditions ?? []) current.add(c);
        afterConditions = new Set(current);
        writeSet.conditions = toJsonText([...current]);
      }
      if (recomputeHp) {
        const effectiveHpMax = hpMaxChanged ? Math.max(1, patch.hpMax!) : fresh.hpMax;
        const state: CombatantHpState = {
          kind: fresh.kind as CombatantHpState['kind'],
          hpCurrent: fresh.hpCurrent,
          hpMax: effectiveHpMax,
          hpTemp: fresh.hpTemp,
          deathState: fresh.deathState as CombatantHpState['deathState'],
          deathSaveSuccesses: fresh.deathSaveSuccesses,
          deathSaveFailures: fresh.deathSaveFailures,
        };
        const result = applyCombatantHp(state, {
          hpDelta: patch.hpDelta,
          hpSet: patch.hpSet,
          hpTemp: patch.hpTemp,
          deathSaveSuccesses: patch.deathSaveSuccesses,
          deathSaveFailures: patch.deathSaveFailures,
          deathSaveRoll: patch.deathSaveRoll,
        });
        if (hpMaxChanged) writeSet.hpMax = effectiveHpMax;
        writeSet.hpCurrent = result.hpCurrent;
        writeSet.hpTemp = result.hpTemp;
        writeSet.deathState = result.deathState;
        writeSet.deathSaveSuccesses = result.deathSaveSuccesses;
        writeSet.deathSaveFailures = result.deathSaveFailures;
      }
      const [updated] = tx.update(combatants).set(writeSet).where(eq(combatants.id, combatantId)).returning().all();
      row = updated;
      afterHp = updated.hpCurrent;
      afterTemp = updated.hpTemp;
      afterDeath = updated.deathState;
      // Re-derive afterConditions from the committed row so combat-log events
      // reflect the actual persisted state even if a future trigger rewrites the
      // column (defense-in-depth; today the write above is the only mutator).
      if (conditionsTouched) {
        afterConditions = new Set(fromJsonText<string[]>(updated.conditions, []));
      }
      if (mirrorSheet) {
        // Issue #711: live-mirror the full combat death/temp-HP slice, not just
        // hpCurrent, so a downed/dead character is reflected on the sheet the
        // moment it happens mid-fight (the same authoritative write-through
        // contract the HP path already uses). The post-/end reconciliation below
        // does the same write once more for the final state; both are idempotent.
        // Issue #486: likewise mirror conditions so a tracker-applied Poisoned
        // lands on the sheet immediately (and survives /end even if that path
        // were skipped). Issue #466: stamp the sheet CAS token on the combatant
        // so a later re-end knows this write-through was the last acknowledged sync.
        const mirroredAt = nowIso();
        const sheetSet: Partial<typeof characters.$inferInsert> = { updatedAt: mirroredAt };
        if (recomputeHp) {
          sheetSet.hpCurrent = updated.hpCurrent;
          sheetSet.hpTemp = updated.hpTemp;
          sheetSet.deathState = updated.deathState;
          sheetSet.deathSaveSuccesses = updated.deathSaveSuccesses;
          sheetSet.deathSaveFailures = updated.deathSaveFailures;
        }
        if (conditionsTouched) {
          sheetSet.conditions = updated.conditions;
        }
        tx.update(characters)
          .set(sheetSet)
          .where(eq(characters.id, existing.characterId!))
          .run();
        tx.update(combatants)
          .set({ sheetSyncedUpdatedAt: mirroredAt })
          .where(eq(combatants.id, combatantId))
          .run();
      }
    });

    // #74: don't audit-log pure HP ticks. A single combat generates hundreds of
    // ±1 HP updates (every hit, heal, temp-hp adjust); auditing each one was the
    // dominant source of unbounded audit_log growth for zero forensic value. We
    // still log the meaningful state changes — conditions, initiative, and the
    // identity edits (rename / hpMax / initMod, issue #114) — which are rare and
    // worth a trail. An update that ONLY touched HP/death-save fields is skipped.
    const changedNonHp =
      conditionsTouched ||
      staticUpdate.initiative !== undefined ||
      staticUpdate.name !== undefined ||
      staticUpdate.initMod !== undefined ||
      hpMaxChanged;
    if (changedNonHp) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.combatant.update',
        entityType: 'combatant',
        entityId: combatantId,
        campaignId: encounterRow.campaignId,
        detail: JSON.stringify(patch),
      });
    }

    // Persistent combat-log events (issue #61). Appended AFTER the write commits — a
    // log-append failure must never roll back a legitimate HP/condition mutation. All
    // phrasing records only deltas (never a monster's exact HP total), so the list
    // endpoint stays member-visible without leaking issue #43's redaction.
    const round = encounterRow.round;
    const targetName = row.name;

    // Issue #620: attribute HP/death events to the attacker so the log reads "Ember hit
    // Goblin 3 for 8" rather than just "Goblin 3 took 8 damage". Resolution order:
    //   1. explicit numeric `actorId` on the patch (the apply-damage caller knows who swung);
    //   2. the running encounter's current-turn combatant (the default attacker) — only
    //      when `actorId` was omitted;
    //   3. nothing — fall back to the original target-only phrasing.
    // Tri-state: omit → current-turn fallback; `actorId: null` → suppress attribution;
    // number → that combatant. The actor is only attached when it differs from the
    // target: self-damage (Ember smiting Ember) or the monster being on its own turn
    // otherwise collapses to "Ember: took 8 damage" — worse than the unattributed
    // "Ember took 8 damage" the existing log produced. An explicit actorId referencing
    // a combatant NOT in this encounter is dropped (the lookup returns null) so a stale
    // client can't pollute the log with a phantom name; it doesn't 400, mirroring how
    // other optional metadata is best-effort rather than fail-loud.
    const actor = await this.resolveCombatLogActor(encounterId, patch.actorId, encounterRow.currentCombatantId, combatantId);
    const actorName = actor?.name ?? null;
    const actorCombatantId = actor?.id ?? null;
    const targetCombatantId = combatantId;

    // HP damage/heal — only when an HP change was actually requested (not a pure temp-HP
    // grant or a death-save toggle). Compare the TOTAL pool (hp + temp) so temp-HP
    // absorption shows as the real change; record only the magnitude.
    if (patch.hpDelta !== undefined || patch.hpSet !== undefined) {
      const poolDelta = afterHp + afterTemp - (beforeHp + beforeTemp);
      if (poolDelta < 0) {
        await this.appendEvent(encounterId, round, 'damage', {
          actor: actorName,
          target: targetName,
          actorId: actorCombatantId,
          targetId: targetCombatantId,
          detail: `took ${-poolDelta} damage`,
        });
      } else if (poolDelta > 0) {
        await this.appendEvent(encounterId, round, 'heal', {
          actor: actorName,
          target: targetName,
          actorId: actorCombatantId,
          targetId: targetCombatantId,
          detail: `healed ${poolDelta} HP`,
        });
      }
    }

    // Death — a character reaching `dead` (3 failed saves / massive damage), or a monster
    // dropping to 0 HP (monsters don't roll saves; 0 HP is simply "down"). Attribute the
    // kill when the attacker is known and distinct (issue #620), so a recap can say who
    // felled the boss rather than only that it dropped.
    if (afterDeath === 'dead' && beforeDeath !== 'dead') {
      await this.appendEvent(encounterId, round, 'death', {
        actor: actorName,
        target: targetName,
        actorId: actorCombatantId,
        targetId: targetCombatantId,
        detail: 'died',
      });
    } else if ((existing.kind === 'monster' || existing.kind === 'npc') && afterHp <= 0 && beforeHp > 0) {
      await this.appendEvent(encounterId, round, 'death', {
        actor: actorName,
        target: targetName,
        actorId: actorCombatantId,
        targetId: targetCombatantId,
        detail: 'dropped to 0 HP',
      });
    }

    // A rolled death save (issue #619) — record the roll + its 5e outcome so the combat
    // log shows the provenance of a sudden two-failure nat 1 or a nat-20 revival. The
    // death event above already fires if the roll killed or the revival shows as HP gain;
    // this line adds the roll itself.
    if (patch.deathSaveRoll !== undefined) {
      const outcome =
        afterDeath === 'dead'
          ? 'failed their last death save'
          : afterDeath === 'stable'
            ? 'stabilized'
            : afterHp > 0
              ? 'revived at 1 HP'
              : patch.deathSaveRoll === 20
                ? 'revived at 1 HP'
                : 'marked a death save';
      await this.appendEvent(encounterId, round, 'roll', {
        target: targetName,
        targetId: targetCombatantId,
        detail: `death save d20 ${patch.deathSaveRoll} — ${outcome}`,
      });
    }

    // Conditions actually changed (adding an already-present, or removing an absent one,
    // is a no-op and not logged). Derived from the committed before/after snapshots
    // captured inside the transaction (issue #747) — NOT the pre-await `existing`
    // read — so a condition that a concurrent writer added/removed between the stale
    // read and the tx is attributed correctly (or recognized as a no-op by this
    // caller). Logging the symmetric difference of the two committed sets means a
    // retry that landed nothing new logs nothing, while a real concurrent change
    // still logs exactly the conditions this caller's delta flipped.
    if (conditionsTouched) {
      for (const c of afterConditions) {
        if (!beforeConditions.has(c)) {
          await this.appendEvent(encounterId, round, 'condition', {
            target: targetName,
            targetId: targetCombatantId,
            detail: `gained ${c}`,
          });
        }
      }
      for (const c of beforeConditions) {
        if (!afterConditions.has(c)) {
          await this.appendEvent(encounterId, round, 'condition', {
            target: targetName,
            targetId: targetCombatantId,
            detail: `cleared ${c}`,
          });
        }
      }
    }

    // Reconcile the turn pointer after an initiative write while combat is running
    // (issue #715). Clearing a combatant's initiative (or rewriting it) re-sorts the
    // running order: a cleared combatant sinks below everyone with a roll (see
    // sortCombatants), and a rewritten value may move it up or down. The current-turn
    // pointer is IDENTITY-based (issue #49) so it stays pointing at the right actor,
    // but the denormalized `turnIndex` is positional and would otherwise drift out of
    // lockstep with the new sort. Re-derive it against the post-write order so clients
    // that key off turnIndex (the highlight ring, the "next turn" target) stay aligned.
    // Clearing the CURRENT actor's own initiative is intentional and does NOT advance
    // the turn — its identity pointer survives, it just slides down the order.
    if (encounterRow.status === 'running' && staticUpdate.initiative !== undefined) {
      const adapter = await this.adapterForCampaign(encounterRow.campaignId);
      const sortedAfter = this.sortCombatantsWithAdapter(
        (await this.listCombatantRows(encounterId)).map(combatantToDomain),
        'running',
        adapter,
      );
      const turnIndex = turnIndexFor(sortedAfter, encounterRow.currentCombatantId);
      await this.db
        .update(encounters)
        .set({ turnIndex, updatedAt: nowIso() })
        .where(eq(encounters.id, encounterId));
    }

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return combatantToDomain(row);
  }

  async removeCombatant(encounterId: number, combatantId: number, user: RequestUser, role: Role): Promise<void> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const existing = await this.getCombatantRowOrThrow(encounterId, combatantId);

    // Decide the new turn pointer BEFORE deleting (issue #49). Removing a combatant
    // whose initiative sorts above the current actor used to shift every later row up
    // a slot, so the positional index silently pointed at the wrong creature; and
    // removing the current combatant itself left the index dangling. With an identity
    // pointer we only need to react when the CURRENT combatant is the one leaving:
    // advance to the next in the sorted order (wrapping to the top if it was last).
    let newCurrentId = encounterRow.currentCombatantId;
    // Round only changes when the removed actor was the LAST in initiative order —
    // removing it wraps the pointer to the top of the NEXT round, exactly as
    // advanceTurn does (issue #528). We track the wrap here and apply it below so the
    // round counter can never desync from the turn pointer mid-combat.
    let wrappedToNextRound = false;
    const runningAdapter =
      encounterRow.status === 'running' ? await this.adapterForCampaign(encounterRow.campaignId) : null;
    if (runningAdapter && encounterRow.currentCombatantId === combatantId) {
      const sorted = this.sortCombatantsWithAdapter(
        (await this.listCombatantRows(encounterId)).map(combatantToDomain),
        'running',
        runningAdapter,
      );
      const idx = sorted.findIndex((c) => c.id === combatantId);
      const remaining = sorted.filter((c) => c.id !== combatantId);
      if (remaining.length === 0) {
        newCurrentId = null;
      } else {
        const next = sorted[idx + 1];
        if (next) {
          newCurrentId = next.id;
        } else {
          // The current actor was last in the (pre-removal) sorted order, so stepping
          // past it wraps to the top of the next round — mirror advanceTurn's wrap+round
          // increment (idx + 1 >= count => round + 1).
          newCurrentId = remaining[0].id;
          wrappedToNextRound = true;
        }
      }
    }

    await this.db.delete(combatants).where(eq(combatants.id, combatantId));

    // Re-derive turnIndex against the post-removal sorted order so it stays in lockstep
    // with the (possibly advanced) identity pointer. The round is bumped in the same
    // UPDATE when the removal wrapped the pointer past the end (issue #528).
    if (runningAdapter) {
      const sortedAfter = this.sortCombatantsWithAdapter(
        (await this.listCombatantRows(encounterId)).map(combatantToDomain),
        'running',
        runningAdapter,
      );
      const turnIndex = turnIndexFor(sortedAfter, newCurrentId);
      const round = wrappedToNextRound ? encounterRow.round + 1 : encounterRow.round;
      await this.db
        .update(encounters)
        .set({ currentCombatantId: newCurrentId, turnIndex, round, updatedAt: nowIso() })
        .where(eq(encounters.id, encounterId));
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.combatant.remove',
      entityType: 'combatant',
      entityId: combatantId,
      campaignId: encounterRow.campaignId,
      detail: existing.name,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);
  }

  /** Rolls d20+initMod for every combatant that doesn't already have an initiative. */
  async rollInitiative(encounterId: number, user: RequestUser, role: Role): Promise<EncounterRollInitiativeResult> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const rows = await this.listCombatantRows(encounterId);

    // Roll each un-set combatant's initiative in JS, then apply them all in ONE
    // case-based UPDATE (#72) instead of one UPDATE per combatant. Combatants that
    // already have an initiative are excluded from the id list, so — exactly as
    // before — only null initiatives are filled and manually-set values are left
    // untouched. No write at all when nothing needs rolling.
    const rolled = rows
      .filter((row) => row.initiative === null)
      .map((row) => ({ id: row.id, initiative: rollInitiative(row.initMod, adapter.initiativeDie) }));

    // Fully-rolled roster (issue #702): nothing to write, nothing meaningful to audit.
    // Bail out before the audit.log / SSE emit so the audit trail and other clients are
    // not disturbed by an empty roll. We still return the current encounter + rolledCount
    // so the caller has a fresh, consistent snapshot.
    if (rolled.length === 0) {
      const snapshot = await this.getWithCombatantsOrThrow(encounterId, role);
      return { ...snapshot, rolledCount: 0 };
    }

    const cases = sql.join(
      rolled.map((r) => sql`WHEN ${r.id} THEN ${r.initiative}`),
      sql` `,
    );
    await this.db
      .update(combatants)
      .set({ initiative: sql`CASE ${combatants.id} ${cases} END` })
      .where(
        inArray(
          combatants.id,
          rolled.map((r) => r.id),
        ),
      );

    // Filling a late joiner's initiative mid-fight (issue #54) re-sorts the order, so
    // keep the positional turnIndex aligned with the (unchanged) identity pointer.
    if (encounterRow.status === 'running') {
      const sorted = this.sortCombatantsWithAdapter(
        (await this.listCombatantRows(encounterId)).map(combatantToDomain),
        'running',
        adapter,
      );
      const turnIndex = turnIndexFor(sorted, encounterRow.currentCombatantId);
      if (turnIndex !== encounterRow.turnIndex) {
        await this.db.update(encounters).set({ turnIndex, updatedAt: nowIso() }).where(eq(encounters.id, encounterId));
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.roll_initiative',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      detail: `${rolled.length}`,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    const snapshot = await this.getWithCombatantsOrThrow(encounterId, role);
    return { ...snapshot, rolledCount: rolled.length };
  }

  async start(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'preparing') {
      // Without this guard, /start on an already-'ended' encounter revives it with a
      // stale endedAt still set (or re-starts a 'running' one, resetting round/turnIndex
      // mid-fight) — status must be 'preparing' to (re)start.
      throw new BadRequestException(`Encounter must be in 'preparing' status to start (currently '${encounterRow.status}')`);
    }
    const rows = await this.listCombatantRows(encounterId);
    if (rows.length === 0) {
      // Without this guard an empty roster passes the (vacuous) initiative check below
      // and Start flips the encounter to 'running' with round=1 and currentCombatantId
      // null — a nonsensical fight with nobody in it that only manual End can clear
      // (issue #469). At least one combatant must exist before Start is meaningful.
      throw new BadRequestException('Cannot start an encounter with no combatants — add at least one combatant first');
    }
    if (rows.some((r) => r.initiative === null)) {
      throw new BadRequestException('All combatants must have initiative rolled before starting the encounter');
    }

    // The first actor is the top of the initiative order — pin it by identity (issue
    // #49), not just position, so later add/remove can't slide the pointer off it.
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), 'running', adapter);
    const currentCombatantId = sorted[0]?.id ?? null;

    // One authoritative live fight per campaign (issue #744): flip status to 'running'
    // AND set the campaign's activeEncounterId in the SAME transaction, after asserting
    // no other encounter is already running. better-sqlite3 transactions serialize writes,
    // so two concurrent /start calls cannot both pass the assertion — the loser's read
    // sees the winner's committed row and surfaces a 409 with the winner's name + link.
    const campaignId = encounterRow.campaignId;
    const ts = nowIso();
    this.db.transaction((tx) => {
      this.assertNoOtherLiveEncounter(campaignId, encounterId, tx);
      tx.update(encounters)
        .set({ status: 'running', round: 1, turnIndex: 0, currentCombatantId, updatedAt: ts })
        .where(eq(encounters.id, encounterId))
        .run();
      tx.update(campaigns).set({ activeEncounterId: encounterId, updatedAt: ts }).where(eq(campaigns.id, campaignId)).run();
    });

    // Seed the combat log with the opening turn (issue #61). Detail stays name-free
    // (issue #869) so listing can redact actor/target without prose leaking identity.
    const first = sorted[0];
    await this.appendEvent(encounterId, 1, 'turn', {
      actor: first?.name ?? null,
      target: first?.name ?? null,
      actorId: first?.id ?? null,
      targetId: first?.id ?? null,
      detail: 'Combat started',
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.start',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId,
    });

    this.emitEncounterEvent('encounter.updated', campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  async nextTurn(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'running') {
      throw new BadRequestException('Encounter is not running');
    }

    // Walk the SERVER-sorted order from the current combatant's identity, not a raw
    // positional index (issue #49). Find where the current actor sits now, step to the
    // next one, and wrap (round+1) past the end. Because the pointer is an id, a mid-
    // fight add/remove that reshuffled positions can't desync who's "current".
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const sorted = this.sortCombatantsWithAdapter(
      (await this.listCombatantRows(encounterId)).map(combatantToDomain),
      'running',
      adapter,
    );
    const { turnIndex, round, currentCombatantId } = advanceTurn(
      sorted,
      encounterRow.currentCombatantId,
      encounterRow.round,
    );

    await this.db
      .update(encounters)
      .set({ turnIndex, round, currentCombatantId, updatedAt: nowIso() })
      .where(eq(encounters.id, encounterId));

    // Combat-log turn marker (issue #61). Names live on actor/target (+ ids); detail
    // stays name-free so #869 redaction cannot be bypassed by prose.
    const current = sorted.find((c) => c.id === currentCombatantId);
    await this.appendEvent(encounterId, round, 'turn', {
      actor: current?.name ?? null,
      target: current?.name ?? null,
      actorId: current?.id ?? null,
      targetId: current?.id ?? null,
      detail: '',
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.next_turn',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      detail: `round ${round}, turn ${turnIndex}`,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  /**
   * Ends the encounter and writes each character-combatant's current HP back onto its
   * character row. Requires status 'running' — without this guard, /end on an already-
   * 'ended' encounter double-fires: it re-writes (harmless but wasteful) HP back onto
   * characters and stomps `endedAt` with a fresh timestamp, silently masking when combat
   * actually ended. The HP write-back + status update run in one db.transaction() (mirrors
   * QuestsService.remove()'s subquest-promotion pattern) so a mid-loop failure can't leave
   * some characters' HP synced and others not while the encounter still shows 'running'.
   *
   * Issue #711: the write-back now persists the FULL combat death/temp-HP slice, not just
   * hpCurrent. The combatant tracker has carried hpTemp/deathState/death-save counters
   * since issue #57; without this reconciliation a dead PC was silently resurrected on
   * sheet read and re-conscripted into the next fight. The dead/stable/dying/temp-HP
   * state travels back onto the character row, and a `dead` combatant additionally flips
   * the character's lifecycle `status` to 'dead' so it is excluded from future auto-add
   * (create() only auto-adds 'active' PCs, issue #115). A revived (hp > 0) character is
   * explicitly kept 'active' here so the death doesn't linger past a real revival —
   * revival is a deliberate transition, never a side effect.
   */
  async end(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'running') {
      throw new BadRequestException(`Encounter must be 'running' to end (currently '${encounterRow.status}')`);
    }
    const rows = await this.listCombatantRows(encounterId);

    // Pre-compute the per-character write-back set inside the loop's planning phase
    // so the transaction body is a tight, sequenced set of writes — same shape as the
    // existing HP-only loop, just richer. The death-state → lifecycle mapping is the
    // one piece of policy: only `dead` flips status; `dying`/`stable` leave it alone
    // (a dying PC is still 'active' once the next encounter starts), and a revived
    // (hp > 0) character is forced back to 'active' if it had been marked dead.
    const characterWrites: Array<{
      combatantId: number;
      characterId: number;
      hpCurrent: number;
      hpTemp: number;
      deathState: string;
      deathSaveSuccesses: number;
      deathSaveFailures: number;
      // Issue #486: conditions travel back with the HP slice on /end.
      conditions: string;
      status: 'active' | 'dead';
      sheetSyncedUpdatedAt: string | null;
    }> = [];
    for (const row of rows) {
      if (row.kind !== 'character' || row.characterId === null) continue;
      const dead = row.deathState === 'dead';
      const revived = !dead && row.hpCurrent > 0;
      // Only flip lifecycle status on a definitive transition: dead -> 'dead', or a
      // previously-dead character back to 'active' once they're healed above 0. A
      // dying/stable character at 0 HP keeps whatever status it had (typically
      // 'active') — the death STATE is carried by deathState, not lifecycle status.
      let nextStatus: 'active' | 'dead' | undefined;
      if (dead) nextStatus = 'dead';
      else if (revived) nextStatus = 'active'; // cleared below if status is already 'active'
      characterWrites.push({
        combatantId: row.id,
        characterId: row.characterId,
        hpCurrent: row.hpCurrent,
        hpTemp: row.hpTemp,
        deathState: row.deathState,
        deathSaveSuccesses: row.deathSaveSuccesses,
        deathSaveFailures: row.deathSaveFailures,
        conditions: row.conditions,
        status: nextStatus ?? 'active',
        sheetSyncedUpdatedAt: row.sheetSyncedUpdatedAt ?? null,
      });
    }

    // Pull the current lifecycle status + HP slice of every affected character so the
    // write-back only touches `status` when it actually changes — avoids a
    // wasteful write AND a misleading audit trail (a no-op status 'flip' would
    // look like a deliberate DM action). Also feeds the issue #466 CAS guard.
    const characterIds = characterWrites.map((w) => w.characterId);
    const priorById = new Map<
      number,
      {
        status: string;
        updatedAt: string;
        hpCurrent: number;
        hpTemp: number;
        deathState: string;
        deathSaveSuccesses: number;
        deathSaveFailures: number;
      }
    >();
    if (characterIds.length > 0) {
      const priorRows = await this.db
        .select({
          id: characters.id,
          status: characters.status,
          updatedAt: characters.updatedAt,
          hpCurrent: characters.hpCurrent,
          hpTemp: characters.hpTemp,
          deathState: characters.deathState,
          deathSaveSuccesses: characters.deathSaveSuccesses,
          deathSaveFailures: characters.deathSaveFailures,
        })
        .from(characters)
        .where(inArray(characters.id, characterIds));
      for (const r of priorRows) priorById.set(r.id, r);
    }

    // Issue #466 safety net: refuse to end when the sheet advanced since the last
    // acknowledged sync AND still differs from the combatant snapshot. The DM must
    // reopen with an explicit resync direction first (or heal the combatant to match).
    const endConflicts: HpSyncConflict[] = [];
    for (const w of characterWrites) {
      const prior = priorById.get(w.characterId);
      if (!prior) continue;
      const combatantSlice = hpSyncSliceOf(w);
      const sheetSlice = hpSyncSliceOf(prior);
      if (
        !canWriteBackHp({
          sheet: { ...sheetSlice, updatedAt: prior.updatedAt },
          combatant: combatantSlice,
          sheetSyncedUpdatedAt: w.sheetSyncedUpdatedAt,
        })
      ) {
        const combatantRow = rows.find((r) => r.id === w.combatantId);
        endConflicts.push({
          combatantId: w.combatantId,
          characterId: w.characterId,
          name: combatantRow?.name ?? `Character ${w.characterId}`,
          combatant: combatantSlice,
          sheet: { ...sheetSlice, updatedAt: prior.updatedAt },
        });
      }
    }
    if (endConflicts.length > 0) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.end_hp_conflict',
        entityType: 'encounter',
        entityId: encounterId,
        campaignId: encounterRow.campaignId,
        detail: JSON.stringify({ conflicts: endConflicts }),
      });
      throw new ConflictException({
        code: 'HP_SYNC_CONFLICT',
        message:
          'Character sheets changed since this encounter last synced HP. Reopen with an explicit resync direction for each conflict before ending again.',
        conflicts: endConflicts,
      });
    }

    const ts = nowIso();
    // Clear the campaign's activeEncounterId iff this encounter IS the active one (issue
    // #744) — done inside the same HP-write-back transaction so a crash mid-end can't leave
    // the pointer dangling at an 'ended' encounter. A third-party ended a non-active fight
    // (legacy drift where the pointer disagreed with status) leaves the pointer untouched.
    // Issue #466: each character UPDATE is compare-and-set on updatedAt when we hold a
    // sync token, so a race that heals the sheet mid-transaction cannot be clobbered.
    this.db.transaction((tx) => {
      for (const w of characterWrites) {
        const prior = priorById.get(w.characterId);
        // Issue #711: write the full combat slice — HP, temp HP, death state, and
        // death-save counters — so the sheet reflects the post-fight truth. The
        // lifecycle status flip is gated on a real change so a stable/dying PC
        // whose status was already 'active' doesn't get a spurious write.
        // Issue #486: also persist tracker conditions back onto the sheet.
        const set: Partial<typeof characters.$inferInsert> = {
          hpCurrent: w.hpCurrent,
          hpTemp: w.hpTemp,
          deathState: w.deathState,
          deathSaveSuccesses: w.deathSaveSuccesses,
          deathSaveFailures: w.deathSaveFailures,
          conditions: w.conditions,
          updatedAt: ts,
        };
        if (prior !== undefined && prior.status !== w.status) {
          set.status = w.status;
        }
        const where =
          w.sheetSyncedUpdatedAt != null
            ? and(eq(characters.id, w.characterId), eq(characters.updatedAt, w.sheetSyncedUpdatedAt))
            : eq(characters.id, w.characterId);
        const result = tx.update(characters).set(set).where(where).run();
        const changes = (result as unknown as { changes?: number }).changes ?? 0;
        if (changes === 0 && w.sheetSyncedUpdatedAt != null) {
          // CAS lost a race — re-read and fail the whole end rather than half-apply.
          const [fresh] = tx
            .select()
            .from(characters)
            .where(eq(characters.id, w.characterId))
            .limit(1)
            .all();
          if (fresh && !hpSyncSlicesEqual(hpSyncSliceOf(fresh), hpSyncSliceOf(w))) {
            throw new ConflictException({
              code: 'HP_SYNC_CONFLICT',
              message:
                'Character sheets changed since this encounter last synced HP. Reopen with an explicit resync direction for each conflict before ending again.',
              conflicts: [
                {
                  combatantId: w.combatantId,
                  characterId: w.characterId,
                  name: rows.find((r) => r.id === w.combatantId)?.name ?? `Character ${w.characterId}`,
                  combatant: hpSyncSliceOf(w),
                  sheet: { ...hpSyncSliceOf(fresh), updatedAt: fresh.updatedAt },
                },
              ],
            });
          }
          // Slices already match (e.g. name-only sheet edit) — bump updatedAt + token.
          if (fresh) {
            tx.update(characters)
              .set({ updatedAt: ts })
              .where(eq(characters.id, w.characterId))
              .run();
          }
        }
        tx.update(combatants)
          .set({ sheetSyncedUpdatedAt: ts })
          .where(eq(combatants.id, w.combatantId))
          .run();
      }
      tx.update(encounters).set({ status: 'ended', endedAt: ts, updatedAt: ts }).where(eq(encounters.id, encounterId)).run();
      const [camp] = tx.select({ activeEncounterId: campaigns.activeEncounterId }).from(campaigns).where(eq(campaigns.id, encounterRow.campaignId)).limit(1).all();
      if (camp?.activeEncounterId === encounterId) {
        tx.update(campaigns).set({ activeEncounterId: null, updatedAt: ts }).where(eq(campaigns.id, encounterRow.campaignId)).run();
      }
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.end',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  /**
   * Reopens an 'ended' encounter back to 'running' (issue #109) — an accidental /end
   * was previously unrecoverable (the ended page offered only Refresh/Delete). Requires
   * status 'ended'; clears endedAt and restores 'running' while PRESERVING round /
   * turnIndex / currentCombatantId when still valid, so combat resumes where it stopped
   * rather than resetting to the top of the order.
   *
   * Issue #489: reopen re-validates the turn pointer against the present roster.
   * Zero combatants → 409. A missing `currentCombatantId` or one whose initiative is
   * now null snaps to the top of the server-sorted running order and emits a combat-
   * log notice. `turnIndex` is always re-derived from that identity pointer.
   *
   * Issue #466: when sheet HP diverged from the combatant snapshot after the previous
   * End, the caller MUST supply a per-conflict `hpResync` direction (`keep_combatant`
   * or `pull_sheet`). Decisions are applied + audited inside the same transaction as
   * the status flip so a crash cannot leave a half-resynced fight.
   *
   * One authoritative live fight (issue #744): the status flip + activeEncounterId write
   * + the no-other-running assertion run in ONE transaction, mirroring start(). A reopen
   * racing another reopen/start serializes and the loser surfaces a 409 with the winner.
   */
  async reopen(
    encounterId: number,
    user: RequestUser,
    role: Role,
    input: EncounterReopenInput = {},
  ): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'ended') {
      throw new BadRequestException(`Encounter must be 'ended' to reopen (currently '${encounterRow.status}')`);
    }

    const combatantRows = await this.listCombatantRows(encounterId);
    // Issue #489: refuse to resume a fight with nobody in it (start has the same
    // guard via #469; reopen previously flipped status and left a null pointer).
    if (combatantRows.length === 0) {
      throw new ConflictException({
        code: 'REOPEN_NO_COMBATANTS',
        message: 'Cannot reopen an encounter with no combatants — add at least one combatant first',
      });
    }

    const conflicts = await this.collectHpSyncConflicts(combatantRows);
    const decisions = new Map((input.hpResync ?? []).map((d) => [d.combatantId, d.direction]));
    if (conflicts.length > 0) {
      const missing = conflicts.filter((c) => !decisions.has(c.combatantId));
      if (missing.length > 0) {
        throw new ConflictException({
          code: 'HP_SYNC_CONFLICT',
          message:
            'Character sheets changed after this encounter ended. Choose keep_combatant or pull_sheet for each conflict before reopening.',
          conflicts,
        });
      }
    }

    // Issue #489: re-derive the turn pointer against the present, initiative-bearing
    // roster before flipping status. A combatant removed (or initiative cleared) while
    // the fight was ended would otherwise leave a stale currentCombatantId until the
    // next /next-turn self-healed via advanceTurn.
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const sorted = this.sortCombatantsWithAdapter(combatantRows.map(combatantToDomain), 'running', adapter);
    const priorCurrentId = encounterRow.currentCombatantId;
    const priorCurrent = priorCurrentId == null ? undefined : sorted.find((c) => c.id === priorCurrentId);
    // Missing id OR present-but-null-initiative both snap to the top of the order
    // and emit a notice (issue #489) — even when that top happens to be the same id.
    const pointerInvalid = priorCurrent == null || priorCurrent.initiative === null;
    const currentCombatantId = pointerInvalid ? (sorted[0]?.id ?? null) : priorCurrentId;
    const turnIndex = turnIndexFor(sorted, currentCombatantId);
    const turnPointerSnapped = pointerInvalid;

    const campaignId = encounterRow.campaignId;
    const ts = nowIso();
    const decisionAudit: Array<{ combatantId: number; characterId: number; direction: string }> = [];
    this.db.transaction((tx) => {
      this.assertNoOtherLiveEncounter(campaignId, encounterId, tx);

      for (const conflict of conflicts) {
        const direction = decisions.get(conflict.combatantId)!;
        decisionAudit.push({
          combatantId: conflict.combatantId,
          characterId: conflict.characterId,
          direction,
        });
        if (direction === 'pull_sheet') {
          // Bring the combatant snapshot up to the live sheet; stamp the CAS token.
          tx.update(combatants)
            .set({
              hpCurrent: conflict.sheet.hpCurrent,
              hpTemp: conflict.sheet.hpTemp,
              deathState: conflict.sheet.deathState,
              deathSaveSuccesses: conflict.sheet.deathSaveSuccesses,
              deathSaveFailures: conflict.sheet.deathSaveFailures,
              sheetSyncedUpdatedAt: conflict.sheet.updatedAt,
            })
            .where(eq(combatants.id, conflict.combatantId))
            .run();
        } else {
          // keep_combatant: leave the snapshot; acknowledge the sheet revision so the
          // next /end may overwrite it deliberately (CAS token = current sheet.updatedAt).
          tx.update(combatants)
            .set({ sheetSyncedUpdatedAt: conflict.sheet.updatedAt })
            .where(eq(combatants.id, conflict.combatantId))
            .run();
        }
      }

      // Refresh CAS tokens for non-conflict character combatants too — their slices
      // already match, but stamping the current sheet.updatedAt keeps the next /end
      // from false-conflicting on an unrelated sheet edit (name/notes) that bumped
      // updatedAt without changing the HP slice.
      const conflictIds = new Set(conflicts.map((c) => c.combatantId));
      for (const row of combatantRows) {
        if (row.kind !== 'character' || row.characterId == null || conflictIds.has(row.id)) continue;
        const [sheet] = tx
          .select({ updatedAt: characters.updatedAt })
          .from(characters)
          .where(eq(characters.id, row.characterId))
          .limit(1)
          .all();
        if (sheet) {
          tx.update(combatants)
            .set({ sheetSyncedUpdatedAt: sheet.updatedAt })
            .where(eq(combatants.id, row.id))
            .run();
        }
      }

      tx.update(encounters)
        .set({
          status: 'running',
          endedAt: null,
          // Issue #489: persist the re-validated pointer with the status flip.
          currentCombatantId,
          turnIndex,
          updatedAt: ts,
        })
        .where(eq(encounters.id, encounterId))
        .run();
      tx.update(campaigns).set({ activeEncounterId: encounterId, updatedAt: ts }).where(eq(campaigns.id, campaignId)).run();
    });

    // Combat-log notice when reopen had to repair a dangling/null-initiative pointer
    // (issue #489). Appended after the status flip commits — a log failure must not
    // roll back a successful reopen.
    if (turnPointerSnapped) {
      const top = sorted.find((c) => c.id === currentCombatantId);
      await this.appendEvent(encounterId, encounterRow.round, 'note', {
        actor: top?.name ?? null,
        target: top?.name ?? null,
        actorId: currentCombatantId,
        targetId: currentCombatantId,
        detail:
          priorCurrentId == null || priorCurrent == null
            ? 'Turn pointer reset to top of order on reopen (previous current combatant missing)'
            : 'Turn pointer reset to top of order on reopen (previous current combatant had no initiative)',
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.reopen',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId,
      detail: JSON.stringify({
        ...(decisionAudit.length > 0 ? { hpResync: decisionAudit } : {}),
        ...(turnPointerSnapped
          ? { turnPointerSnapped: true, previousCombatantId: priorCurrentId, currentCombatantId, turnIndex }
          : { currentCombatantId, turnIndex }),
      }),
    });

    this.emitEncounterEvent('encounter.updated', campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  async remove(encounterId: number, user: RequestUser, role: Role): Promise<void> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    // Delete the combatants, combat-log events, and the encounter row in ONE
    // synchronous better-sqlite3 transaction (issue #272) — mirrors factions.remove /
    // encounters.end. On FK-less (pre-#69, migrated) DBs there's no ON DELETE cascade,
    // so three separately-awaited deletes could half-fail and orphan combatants/events
    // on a vanished encounter; the transaction makes it all-or-nothing.
    //
    // Also null the campaign's activeEncounterId if it pointed here (issue #744) — fresh
    // DBs get this from the declared ON DELETE SET NULL, but pre-migration DBs reproduce
    // the same effect here so the pointer never dangles at a deleted encounter.
    this.db.transaction((tx) => {
      tx.delete(combatants).where(eq(combatants.encounterId, encounterId)).run();
      tx.delete(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).run();
      tx.delete(encounters).where(eq(encounters.id, encounterId)).run();
      const [camp] = tx.select({ activeEncounterId: campaigns.activeEncounterId }).from(campaigns).where(eq(campaigns.id, encounterRow.campaignId)).limit(1).all();
      if (camp?.activeEncounterId === encounterId) {
        tx.update(campaigns).set({ activeEncounterId: null, updatedAt: nowIso() }).where(eq(campaigns.id, encounterRow.campaignId)).run();
      }
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.delete',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
    });

    this.emitEncounterEvent('encounter.deleted', encounterRow.campaignId, encounterId);
  }

  /**
   * Rolls an arbitrary dice expression for a campaign — any member may roll; result is
   * audited AND persisted to the shared per-campaign dice log (issue #35), so every
   * member sees the same roll feed via GET /campaigns/:id/rolls. Returns the persisted
   * DiceRoll — a superset of the old RollResult shape (expr/rolls/total), so existing
   * clients keep working unchanged.
   */
  async rollDiceForCampaign(campaignId: number, input: RollRequestInput, user: RequestUser, role: Role): Promise<DiceRoll> {
    const result = rollDice(input.expr);
    // Optional check context (issue #130): echo the label and compute success server-side
    // so every member's feed shows the same pass/fail, not a client's interpretation.
    const label = input.label?.trim();
    if (label) result.label = label;
    if (typeof input.dc === 'number') {
      result.dc = input.dc;
      result.success = result.total >= input.dc;
    }
    const persisted = await this.rolls.record(campaignId, result, user);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'dice.roll',
      entityType: null,
      entityId: null,
      campaignId,
      detail:
        `${result.label ? `${result.label}: ` : ''}${result.expr} = ${result.total}` +
        (result.dc != null ? ` vs DC ${result.dc} (${result.success ? 'success' : 'fail'})` : ''),
    });

    return persisted;
  }
}

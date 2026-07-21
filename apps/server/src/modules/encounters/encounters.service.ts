import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AoeTemplate, CombatantCreate, CombatantUpdate, EncounterCreate, EncounterUpdate, FogState, RollRequest, normalizeStats, ruleSystemAdapter } from '@campfire/schema';
import { z as zod } from 'zod';
import type { AoeTemplate as AoeTemplateType, Combatant, DiceRoll, Encounter, EncounterDifficulty, EncounterDigest, EncounterEvent, EncounterEventType, EncounterStatus, EncounterWithCombatants, FogRect, GridType, MapPing, Role, RuleSystemAdapter, TokenSize } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns, characters, combatants, encounterEvents, encounters, locations, quests, ruleEntries, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { fromJsonText, toJsonText } from '../../common/json';
import { rollDice, rollInitiative } from '../../common/dice';
import { RollsService } from '../rolls/rolls.service';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { advanceTurn, applyCombatantHp, computeEncounterDifficulty, hpBandFor, parseCr, sortCombatants, turnIndexFor } from './encounters.logic';
import type { CombatantHpState } from './encounters.logic';

type EncounterCreateInput = z.infer<typeof EncounterCreate>;
type EncounterUpdateInput = z.infer<typeof EncounterUpdate>;
type CombatantCreateInput = z.infer<typeof CombatantCreate>;
type CombatantUpdateInput = z.infer<typeof CombatantUpdate>;
type RollRequestInput = z.infer<typeof RollRequest>;

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
  if (text == null) return null;
  const parsed = FogState.safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : null;
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
    detail: row.detail,
    createdAt: row.createdAt,
  };
}

/**
 * Issue #43: non-DM viewers must not see a monster's exact HP — a player polling
 * the run-session view would otherwise read the boss at an exact `3/150`, a live
 * secrets leak (and the same view a shared screen shows). For monster combatants
 * we replace hpCurrent/hpMax with a coarse status band and null the exact numbers.
 * Character combatants keep exact HP for everyone: party HP is shared table
 * knowledge and a player already sees their own character sheet.
 */
function redactMonsterHp(c: Combatant): Combatant {
  if (c.kind !== 'monster' || c.hpCurrent === null || c.hpMax === null) return c;
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
 */
function redactTokenInFog(c: Combatant, fog: FogState): Combatant {
  if (tokenInRevealedRegion(c, fog)) return c;
  return { ...c, tokenX: null, tokenY: null };
}

@Injectable()
export class EncountersService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly events: CampaignEventsService,
    private readonly rolls: RollsService,
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

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(encounters).where(eq(encounters.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Encounter ${id} not found`);
    return row;
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

  async listCombatantRows(encounterId: number) {
    return this.db.select().from(combatants).where(eq(combatants.encounterId, encounterId));
  }

  /**
   * Persist one combat-log event (issue #61). Called from the combat mutations (HP
   * damage/heal, condition add/remove, death, turn/round) so the run view can show a
   * scrollable history that survives reload. `detail` must never carry a monster's
   * exact HP total — only deltas — so the list endpoint can be member-visible without
   * leaking what issue #43 redacts on the combatant rows.
   */
  private async appendEvent(
    encounterId: number,
    round: number,
    type: EncounterEventType,
    fields: { actor?: string | null; target?: string | null; detail?: string },
  ): Promise<void> {
    await this.db.insert(encounterEvents).values({
      encounterId,
      round,
      type,
      actor: fields.actor ?? null,
      target: fields.target ?? null,
      detail: fields.detail ?? '',
      createdAt: nowIso(),
    });
  }

  /**
   * Lists an encounter's persisted combat log in chronological (insertion) order —
   * issue #61. Member-visible: `viewerRole` is accepted for symmetry with the redaction
   * story, but the events are stored already-safe (deltas, never exact monster HP
   * totals), so no per-row redaction is required — a non-DM sees the same trail the DM
   * does, minus nothing that the combatant rows don't already show them.
   */
  async listEvents(encounterId: number, _viewerRole?: Role): Promise<EncounterEvent[]> {
    await this.getRowOrThrow(encounterId); // 404 if the encounter doesn't exist
    const rows = await this.db
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, encounterId))
      .orderBy(encounterEvents.id);
    return rows.map(eventToDomain);
  }

  async listForCampaign(campaignId: number, status?: EncounterStatus): Promise<Encounter[]> {
    const conditions = [eq(encounters.campaignId, campaignId), status ? eq(encounters.status, status) : undefined].filter(
      (c): c is NonNullable<typeof c> => c !== undefined,
    );
    const rows = await this.db
      .select()
      .from(encounters)
      .where(conditions.length > 1 ? and(...conditions) : conditions[0]);
    return rows.map(encounterToDomain);
  }

  /**
   * `viewerRole` drives issue #43 redaction: anyone below `dm` (player/viewer)
   * gets monster HP replaced with a coarse band. Omit it (or pass `dm`) only for
   * DM-facing returns — the DM always sees exact HP.
   */
  async getWithCombatantsOrThrow(id: number, viewerRole?: Role): Promise<EncounterWithCombatants> {
    const row = await this.getRowOrThrow(id);
    const combatantRows = await this.listCombatantRows(id);
    const status = row.status as EncounterStatus;
    let list = sortCombatants(combatantRows.map(combatantToDomain), status);
    if (viewerRole !== undefined && viewerRole !== 'dm') {
      list = list.map(redactMonsterHp);
      // Fog of war (issue #40): withhold the position of any token in an unrevealed region.
      const fog = parseFog(row.fog);
      if (fog?.enabled) list = list.map((c) => redactTokenInFog(c, fog));
    }
    return { ...encounterToDomain(row), combatants: list };
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
      .where(and(eq(attachments.id, attachmentId), eq(attachments.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`mapAttachmentId ${attachmentId} does not exist in this campaign`);
  }

  /**
   * DM-only: edit an encounter's name, its location/quest/session links (issue #126), and/or
   * its battle map (issue #39). Only fields present in `input` are written; `null` clears a
   * link/map. A linked location/quest/session must belong to THIS campaign (404). Setting a
   * battle map reveals the attachment (attachments default DM-only since #97) so every member
   * can see the shared background; clearing to null doesn't re-hide (reveal is one-way).
   */
  async updateEncounter(encounterId: number, input: EncounterUpdateInput, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);

    const set: Partial<typeof encounters.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.locationId !== undefined) {
      if (input.locationId !== null) await this.assertEntityInCampaign('location', input.locationId, encounterRow.campaignId);
      set.locationId = input.locationId;
    }
    if (input.questId !== undefined) {
      if (input.questId !== null) await this.assertEntityInCampaign('quest', input.questId, encounterRow.campaignId);
      set.questId = input.questId;
    }
    if (input.sessionId !== undefined) {
      if (input.sessionId !== null) await this.assertEntityInCampaign('session', input.sessionId, encounterRow.campaignId);
      set.sessionId = input.sessionId;
    }
    if (input.mapAttachmentId !== undefined) {
      await this.validateAttachmentRef(input.mapAttachmentId, encounterRow.campaignId);
      if (input.mapAttachmentId != null) {
        await this.db
          .update(attachments)
          .set({ hidden: false, updatedAt: nowIso() })
          .where(and(eq(attachments.id, input.mapAttachmentId), eq(attachments.campaignId, encounterRow.campaignId)));
      }
      set.mapAttachmentId = input.mapAttachmentId;
    }
    // VTT grid config (issue #40, phase 2). Each field is independently settable/clearable.
    if (input.gridSize !== undefined) set.gridSize = input.gridSize;
    if (input.gridScale !== undefined) set.gridScale = input.gridScale;
    if (input.gridUnit !== undefined) set.gridUnit = input.gridUnit;
    if (input.gridSnap !== undefined) set.gridSnap = input.gridSnap;
    if (input.gridType !== undefined) set.gridType = input.gridType;
    // Fog of war (issue #40, phase 3). Stored as JSON text; null clears it entirely.
    if (input.fog !== undefined) set.fog = input.fog === null ? null : toJsonText(input.fog);
    // Shared AoE templates (issue #238). Stored as JSON text; an empty array clears them.
    if (input.aoe !== undefined) set.aoe = toJsonText(input.aoe);

    if (Object.keys(set).length === 0) {
      return this.getWithCombatantsOrThrow(encounterId, role);
    }

    set.updatedAt = nowIso();
    await this.db.update(encounters).set(set).where(eq(encounters.id, encounterId));

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
   * DM-gated); the caller-side controller asserts membership. The ping location is a coordinate
   * the sender chose, so there is no secret to leak (contrast the id-only updated/deleted
   * signals). Returns nothing meaningful — the effect is the emitted event.
   */
  pingMap(encounterId: number, campaignId: number, ping: MapPing): void {
    this.events.emit({ type: 'encounter.ping', campaignId, encounterId, ping });
  }

  /** Creates the encounter (preparing) and auto-adds every ACTIVE campaign character as a combatant (issue #115 — non-active PCs are skipped). */
  async create(campaignId: number, input: EncounterCreateInput, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const ts = nowIso();
    const [encounterRow] = await this.db
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
        endedAt: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    // Auto-add only ACTIVE characters (issue #115). Dead/retired/inactive PCs stay on
    // the roster but are skipped here, so a long campaign's fallen and replaced
    // characters stop being force-conscripted into every new fight. The DM can still
    // add any of them manually via addCombatant. Legacy pre-migration rows all default
    // to 'active', preserving prior behavior.
    const partyRows = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), eq(characters.status, 'active'), notDeleted(characters.deletedAt)));
    // Auto-add the whole party in ONE multi-row INSERT (#72) rather than one INSERT
    // per character — the row values (including the sequential sortOrder) are computed
    // in JS and handed to a single `.values([...])`. Behavior is identical to the old
    // per-row loop; only the round-trip count changes (N -> 1).
    if (partyRows.length > 0) {
      const adapter = await this.adapterForCampaign(campaignId);
      const combatantValues = partyRows.map((character, index) => {
        const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
        const initMod = adapter.initiativeModifier(stats);
        return {
          encounterId: encounterRow.id,
          kind: 'character' as const,
          characterId: character.id,
          name: character.name,
          initiative: null,
          initMod,
          hpCurrent: character.hpCurrent,
          hpMax: character.hpMax,
          conditions: '[]',
          ruleEntryId: null,
          sortOrder: index,
        };
      });
      await this.db.insert(combatants).values(combatantValues);
    }

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

  /** Guard that a link target exists in the same campaign as the encounter (issue #126). */
  private async assertEntityInCampaign(kind: 'location' | 'quest' | 'session', id: number, campaignId: number): Promise<void> {
    const table = kind === 'location' ? locations : kind === 'quest' ? quests : sessions;
    const [row] = await this.db.select({ campaignId: table.campaignId }).from(table).where(eq(table.id, id)).limit(1);
    if (!row || row.campaignId !== campaignId) {
      throw new NotFoundException(`${kind} ${id} not found in campaign ${campaignId}`);
    }
  }

  /**
   * Compute a read-only 5e difficulty band for an encounter (issue #58). Pulls the PC
   * levels from the character-combatants' linked character sheets and the monster CRs
   * from the monster-combatants' linked rule entries (dataJson.challengeRating), then
   * runs the pure 5e XP-budget math. No new columns — everything is derived on read.
   */
  async getDifficulty(encounterId: number): Promise<EncounterDifficulty> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
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
    // (0 XP) rather than being dropped, so the monster COUNT still drives the multiplier.
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

    return computeEncounterDifficulty(partyLevels, monsterCrs);
  }

  /**
   * Compact per-encounter digest for the campaign summary (issue #126) — enough for an
   * AI recap to see combat happened, where/why/when it was pinned, and a down tally,
   * without loading full combatant rows. One encounters query plus one grouped-count
   * query over combatants, both scoped to the campaign.
   */
  async digestForCampaign(campaignId: number): Promise<EncounterDigest[]> {
    const rows = await this.db.select().from(encounters).where(eq(encounters.campaignId, campaignId));
    if (rows.length === 0) return [];

    const encounterIds = rows.map((r) => r.id);
    const tally = await this.db
      .select({
        encounterId: combatants.encounterId,
        total: sql<number>`COUNT(*)`,
        down: sql<number>`SUM(CASE WHEN ${combatants.hpCurrent} <= 0 OR ${combatants.deathState} = 'dead' THEN 1 ELSE 0 END)`,
      })
      .from(combatants)
      .where(inArray(combatants.encounterId, encounterIds))
      .groupBy(combatants.encounterId);
    const tallyById = new Map(tally.map((t) => [t.encounterId, { total: Number(t.total), down: Number(t.down) }]));

    return rows.map((r) => {
      const t = tallyById.get(r.id) ?? { total: 0, down: 0 };
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
      };
    });
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
    // NOT pre-seeded from input.ruleEntryId — only set once the row is confirmed to exist
    // below, so a dangling id can never make it into the INSERT (was previously assigned
    // unconditionally here, so a bogus/deleted ruleEntryId silently got stored).
    let ruleEntryId: number | null = null;
    let characterId: number | null = null;

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
      // silently upserting, so the caller learns their add was a no-op.
      const [dup] = await this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.encounterId, encounterId), eq(combatants.characterId, character.id)))
        .limit(1);
      if (dup) {
        throw new ConflictException(`Character ${character.id} is already a combatant in encounter ${encounterId}`);
      }
      characterId = character.id;
      name = name ?? character.name;
      hpMax = hpMax ?? character.hpMax;
      hpCurrent = character.hpCurrent;
      if (input.initMod === undefined) {
        const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
        initMod = adapter.initiativeModifier(stats);
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
        initMod = adapter.initiativeModifier(adapter.mapStatblock(data).abilityScores);
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
    const count = input.characterId !== undefined ? 1 : Math.max(1, input.count ?? 1);
    const names = count > 1 ? Array.from({ length: count }, (_, i) => `${name} ${i + 1}`) : [name];

    // Issue #86: derive sortOrder in SQL (MAX(sort_order)+1) instead of from a
    // stale `existing.length` read — two concurrent adds used to read the same
    // count and insert colliding sortOrders. Sequential awaits (not Promise.all) so
    // each row's MAX(sort_order)+1 subquery observes the prior insert and the batch
    // gets distinct, contiguous orders.
    const insertedRows: (typeof combatants.$inferSelect)[] = [];
    for (const n of names) {
      const [inserted] = await this.db
        .insert(combatants)
        .values({
          encounterId,
          kind: input.kind,
          characterId,
          name: n,
          initiative: null,
          initMod,
          hpCurrent,
          hpMax,
          conditions: '[]',
          ruleEntryId,
          sortOrder: sql`(SELECT COALESCE(MAX(${combatants.sortOrder}), -1) + 1 FROM ${combatants} WHERE ${combatants.encounterId} = ${encounterId})`,
        })
        .returning();
      insertedRows.push(inserted);
    }
    const row = insertedRows[0];

    // Keep the positional turnIndex aligned with the identity pointer after the row
    // count changes (issue #49). A freshly-added combatant has null initiative and so
    // sorts last, so the current actor's index is normally unchanged — but re-deriving
    // it keeps turnIndex correct regardless.
    if (encounterRow.status === 'running') {
      const rows = await this.listCombatantRows(encounterId);
      const sorted = sortCombatants(rows.map(combatantToDomain), 'running');
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

    // Non-HP field writes computed up front (conditions/initiative/identity). The
    // HP + death-save fields are computed INSIDE the transaction below off a fresh
    // read, so concurrent damage still composes atomically (issue #86).
    const staticUpdate: Partial<typeof combatants.$inferInsert> = {};

    if (patch.addConditions !== undefined || patch.removeConditions !== undefined) {
      const current = new Set(fromJsonText<string[]>(existing.conditions, []));
      for (const c of patch.removeConditions ?? []) current.delete(c);
      for (const c of patch.addConditions ?? []) current.add(c);
      staticUpdate.conditions = toJsonText([...current]);
    }
    if (patch.initiative !== undefined && isDm) staticUpdate.initiative = patch.initiative;
    if (patch.name !== undefined && isDm) staticUpdate.name = patch.name;
    if (patch.initMod !== undefined && isDm) staticUpdate.initMod = patch.initMod;
    // Battle-map token position (issue #39). Not DM-gated: the player-write branch above
    // already restricts a non-DM to a combatant linked to a character they own, which is
    // exactly the "a player moves only their own token" rule. Clamp to 0–100 (mirrors the
    // campaign map's pin drag). Both coordinates move together. An explicit `null` clears
    // the position (unplace, issue #271) — write it straight through rather than clamping,
    // since clampPercent(null) would collapse to 0 and pin the token to a corner.
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
      patch.deathSaveFailures !== undefined;
    // A recompute is needed if any HP field changed OR hpMax moved (hpCurrent may
    // need re-clamping to a lowered max, and the death state re-derived).
    const recomputeHp = hpFieldsTouched || hpMaxChanged;

    if (Object.keys(staticUpdate).length === 0 && !recomputeHp) {
      return combatantToDomain(existing);
    }

    // Combatant write + linked-character HP mirror run in ONE synchronous
    // better-sqlite3 transaction (issue #86): the HP math reads the row's CURRENT
    // committed values inside the transaction (never a stale pre-await read), so two
    // authorized deltas landing near-simultaneously compose instead of clobbering —
    // better-sqlite3 serializes the whole synchronous callback. The mirror then reads
    // the transaction's own result.
    //
    // The character HP mirror is additionally gated on a still-live (non-'ended')
    // encounter (issue #163). assertMutable() above already rejects an ended encounter
    // outright, so this is defense-in-depth: post-combat combatant rows must never leak
    // back onto the live character sheet even if that guard is ever relaxed.
    const mirrorHp = existing.kind === 'character' && existing.characterId !== null && recomputeHp && encounterRow.status !== 'ended';
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
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
      beforeHp = fresh.hpCurrent;
      beforeTemp = fresh.hpTemp;
      beforeDeath = fresh.deathState;
      const writeSet: Partial<typeof combatants.$inferInsert> = { ...staticUpdate };
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
      if (mirrorHp) {
        tx.update(characters).set({ hpCurrent: updated.hpCurrent, updatedAt: nowIso() }).where(eq(characters.id, existing.characterId!)).run();
      }
    });

    // #74: don't audit-log pure HP ticks. A single combat generates hundreds of
    // ±1 HP updates (every hit, heal, temp-hp adjust); auditing each one was the
    // dominant source of unbounded audit_log growth for zero forensic value. We
    // still log the meaningful state changes — conditions, initiative, and the
    // identity edits (rename / hpMax / initMod, issue #114) — which are rare and
    // worth a trail. An update that ONLY touched HP/death-save fields is skipped.
    const changedNonHp =
      staticUpdate.conditions !== undefined ||
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

    // HP damage/heal — only when an HP change was actually requested (not a pure temp-HP
    // grant or a death-save toggle). Compare the TOTAL pool (hp + temp) so temp-HP
    // absorption shows as the real change; record only the magnitude.
    if (patch.hpDelta !== undefined || patch.hpSet !== undefined) {
      const poolDelta = afterHp + afterTemp - (beforeHp + beforeTemp);
      if (poolDelta < 0) {
        await this.appendEvent(encounterId, round, 'damage', { target: targetName, detail: `took ${-poolDelta} damage` });
      } else if (poolDelta > 0) {
        await this.appendEvent(encounterId, round, 'heal', { target: targetName, detail: `healed ${poolDelta} HP` });
      }
    }

    // Death — a character reaching `dead` (3 failed saves / massive damage), or a monster
    // dropping to 0 HP (monsters don't roll saves; 0 HP is simply "down").
    if (afterDeath === 'dead' && beforeDeath !== 'dead') {
      await this.appendEvent(encounterId, round, 'death', { target: targetName, detail: 'died' });
    } else if (existing.kind === 'monster' && afterHp <= 0 && beforeHp > 0) {
      await this.appendEvent(encounterId, round, 'death', { target: targetName, detail: 'dropped to 0 HP' });
    }

    // Conditions actually changed (adding an already-present, or removing an absent one,
    // is a no-op and not logged).
    const conditionsBefore = new Set(fromJsonText<string[]>(existing.conditions, []));
    for (const c of patch.addConditions ?? []) {
      if (!conditionsBefore.has(c)) await this.appendEvent(encounterId, round, 'condition', { target: targetName, detail: `gained ${c}` });
    }
    for (const c of patch.removeConditions ?? []) {
      if (conditionsBefore.has(c)) await this.appendEvent(encounterId, round, 'condition', { target: targetName, detail: `cleared ${c}` });
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
    if (encounterRow.status === 'running' && encounterRow.currentCombatantId === combatantId) {
      const sorted = sortCombatants((await this.listCombatantRows(encounterId)).map(combatantToDomain), 'running');
      const idx = sorted.findIndex((c) => c.id === combatantId);
      const remaining = sorted.filter((c) => c.id !== combatantId);
      newCurrentId = remaining.length === 0 ? null : (sorted[idx + 1]?.id ?? remaining[0].id);
    }

    await this.db.delete(combatants).where(eq(combatants.id, combatantId));

    // Re-derive turnIndex against the post-removal sorted order so it stays in lockstep
    // with the (possibly advanced) identity pointer.
    if (encounterRow.status === 'running') {
      const sortedAfter = sortCombatants((await this.listCombatantRows(encounterId)).map(combatantToDomain), 'running');
      const turnIndex = turnIndexFor(sortedAfter, newCurrentId);
      await this.db
        .update(encounters)
        .set({ currentCombatantId: newCurrentId, turnIndex, updatedAt: nowIso() })
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
  async rollInitiative(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const rows = await this.listCombatantRows(encounterId);

    // Roll each un-set combatant's initiative in JS, then apply them all in ONE
    // CASE-based UPDATE (#72) instead of one UPDATE per combatant. Combatants that
    // already have an initiative are excluded from the id list, so — exactly as
    // before — only null initiatives are filled and manually-set values are left
    // untouched. No write at all when nothing needs rolling.
    const rolled = rows
      .filter((row) => row.initiative === null)
      .map((row) => ({ id: row.id, initiative: rollInitiative(row.initMod, adapter.initiativeDie) }));
    if (rolled.length > 0) {
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
    }

    // Filling a late joiner's initiative mid-fight (issue #54) re-sorts the order, so
    // keep the positional turnIndex aligned with the (unchanged) identity pointer.
    if (encounterRow.status === 'running') {
      const sorted = sortCombatants((await this.listCombatantRows(encounterId)).map(combatantToDomain), 'running');
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
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId, role);
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
    if (rows.some((r) => r.initiative === null)) {
      throw new BadRequestException('All combatants must have initiative rolled before starting the encounter');
    }

    // The first actor is the top of the initiative order — pin it by identity (issue
    // #49), not just position, so later add/remove can't slide the pointer off it.
    const sorted = sortCombatants(rows.map(combatantToDomain), 'running');
    const currentCombatantId = sorted[0]?.id ?? null;

    await this.db
      .update(encounters)
      .set({ status: 'running', round: 1, turnIndex: 0, currentCombatantId, updatedAt: nowIso() })
      .where(eq(encounters.id, encounterId));

    // Seed the combat log with the opening turn (issue #61).
    const first = sorted[0];
    await this.appendEvent(encounterId, 1, 'turn', {
      actor: first?.name ?? null,
      target: first?.name ?? null,
      detail: first ? `Combat started — ${first.name}'s turn (round 1)` : 'Combat started (round 1)',
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.start',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

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
    const sorted = sortCombatants((await this.listCombatantRows(encounterId)).map(combatantToDomain), 'running');
    const { turnIndex, round, currentCombatantId } = advanceTurn(
      sorted,
      encounterRow.currentCombatantId,
      encounterRow.round,
    );

    await this.db
      .update(encounters)
      .set({ turnIndex, round, currentCombatantId, updatedAt: nowIso() })
      .where(eq(encounters.id, encounterId));

    // Combat-log turn marker (issue #61) — names whose turn it now is, and the round,
    // so the persisted history reads "round 2 — Lyra's turn".
    const current = sorted.find((c) => c.id === currentCombatantId);
    await this.appendEvent(encounterId, round, 'turn', {
      actor: current?.name ?? null,
      target: current?.name ?? null,
      detail: current ? `${current.name}'s turn (round ${round})` : `Round ${round}`,
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
   */
  async end(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'running') {
      throw new BadRequestException(`Encounter must be 'running' to end (currently '${encounterRow.status}')`);
    }
    const rows = await this.listCombatantRows(encounterId);

    const ts = nowIso();
    this.db.transaction((tx) => {
      for (const row of rows) {
        if (row.kind === 'character' && row.characterId !== null) {
          tx.update(characters).set({ hpCurrent: row.hpCurrent, updatedAt: ts }).where(eq(characters.id, row.characterId)).run();
        }
      }
      tx.update(encounters).set({ status: 'ended', endedAt: ts, updatedAt: ts }).where(eq(encounters.id, encounterId)).run();
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
   * turnIndex / currentCombatantId, so combat resumes exactly where it stopped rather
   * than resetting to the top of the order. Combatant HP is untouched by /end (only the
   * write-back onto character sheets happened), so reopening leaves combat state
   * self-consistent. The same HP-writeback caveat applies on the next /end.
   */
  async reopen(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'ended') {
      throw new BadRequestException(`Encounter must be 'ended' to reopen (currently '${encounterRow.status}')`);
    }

    await this.db
      .update(encounters)
      .set({ status: 'running', endedAt: null, updatedAt: nowIso() })
      .where(eq(encounters.id, encounterId));

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.reopen',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  async remove(encounterId: number, user: RequestUser, role: Role): Promise<void> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    await this.db.delete(combatants).where(eq(combatants.encounterId, encounterId));
    await this.db.delete(encounterEvents).where(eq(encounterEvents.encounterId, encounterId));
    await this.db.delete(encounters).where(eq(encounters.id, encounterId));

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

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CombatantCreate, CombatantUpdate, EncounterCreate, RollRequest, normalizeStats } from '@campfire/schema';
import type { Combatant, DiceRoll, Encounter, EncounterStatus, EncounterWithCombatants, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { characters, combatants, encounters, ruleEntries } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { rollDice, rollInitiative } from '../../common/dice';
import { RollsService } from '../rolls/rolls.service';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type EncounterCreateInput = z.infer<typeof EncounterCreate>;
type CombatantCreateInput = z.infer<typeof CombatantCreate>;
type CombatantUpdateInput = z.infer<typeof CombatantUpdate>;
type RollRequestInput = z.infer<typeof RollRequest>;

function encounterToDomain(row: typeof encounters.$inferSelect): Encounter {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    status: row.status as EncounterStatus,
    round: row.round,
    turnIndex: row.turnIndex,
    currentCombatantId: row.currentCombatantId,
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
    conditions: fromJsonText<string[]>(row.conditions, []),
    ruleEntryId: row.ruleEntryId,
    sortOrder: row.sortOrder,
  };
}

/** floor((score - 10) / 2), the standard 5e ability-modifier formula. */
function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** running: initiative desc, nulls last (tie-broken by sortOrder). otherwise: sortOrder asc. */
function sortCombatants(rows: Combatant[], status: EncounterStatus): Combatant[] {
  if (status !== 'running') {
    return [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return [...rows].sort((a, b) => {
    if (a.initiative === null && b.initiative === null) return a.sortOrder - b.sortOrder;
    if (a.initiative === null) return 1;
    if (b.initiative === null) return -1;
    if (a.initiative !== b.initiative) return b.initiative - a.initiative;
    return a.sortOrder - b.sortOrder;
  });
}

/**
 * Position of `currentCombatantId` in the server-sorted running order — the
 * positional `turnIndex` we keep in lockstep with the identity pointer (issue
 * #49) for display/back-compat. 0 when there's no current combatant or it's no
 * longer present (e.g. just removed with an empty encounter).
 */
function turnIndexFor(sorted: Combatant[], currentCombatantId: number | null): number {
  if (currentCombatantId === null) return 0;
  const i = sorted.findIndex((c) => c.id === currentCombatantId);
  return i < 0 ? 0 : i;
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

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(encounters).where(eq(encounters.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Encounter ${id} not found`);
    return row;
  }

  async listCombatantRows(encounterId: number) {
    return this.db.select().from(combatants).where(eq(combatants.encounterId, encounterId));
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

  async getWithCombatantsOrThrow(id: number): Promise<EncounterWithCombatants> {
    const row = await this.getRowOrThrow(id);
    const combatantRows = await this.listCombatantRows(id);
    const status = row.status as EncounterStatus;
    const list = sortCombatants(combatantRows.map(combatantToDomain), status);
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

  /** Creates the encounter (preparing) and auto-adds every campaign character as a combatant. */
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
        endedAt: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const partyRows = await this.db.select().from(characters).where(eq(characters.campaignId, campaignId));
    let sortOrder = 0;
    for (const character of partyRows) {
      const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
      const initMod = typeof stats.DEX === 'number' ? abilityMod(stats.DEX) : 0;
      await this.db.insert(combatants).values({
        encounterId: encounterRow.id,
        kind: 'character',
        characterId: character.id,
        name: character.name,
        initiative: null,
        initMod,
        hpCurrent: character.hpCurrent,
        hpMax: character.hpMax,
        conditions: '[]',
        ruleEntryId: null,
        sortOrder: sortOrder++,
      });
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

    return this.getWithCombatantsOrThrow(encounterRow.id);
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
        initMod = typeof stats.DEX === 'number' ? abilityMod(stats.DEX) : 0;
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
      const hp = data.hitPoints ?? data.hit_points ?? data.hp;
      if (hpMax === undefined && typeof hp === 'number' && hp > 0) hpMax = Math.round(hp);
      // Monster statblocks (open5e-importer.mapCreature) store DEX under
      // dataJson.abilityScores.dexterity — mirror the character path above and derive
      // initMod from it when the caller didn't pass one explicitly, instead of silently
      // leaving every monster combatant at initMod 0 regardless of its actual DEX.
      if (input.initMod === undefined) {
        const abilityScores = data.abilityScores as Record<string, unknown> | undefined;
        const dex = abilityScores?.dexterity;
        if (typeof dex === 'number') initMod = abilityMod(dex);
      }
    }

    if (!name) {
      throw new BadRequestException('Unable to resolve a name for this combatant — provide "name" explicitly');
    }
    if (hpMax === undefined) {
      throw new BadRequestException('Unable to resolve hpMax for this combatant — provide "hpMax" explicitly');
    }
    if (hpCurrent === undefined) hpCurrent = hpMax;

    const existing = await this.listCombatantRows(encounterId);
    const sortOrder = existing.length;

    const [row] = await this.db
      .insert(combatants)
      .values({
        encounterId,
        kind: input.kind,
        characterId,
        name,
        initiative: null,
        initMod,
        hpCurrent,
        hpMax,
        conditions: '[]',
        ruleEntryId,
        sortOrder,
      })
      .returning();

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
      detail: name,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return combatantToDomain(row);
  }

  /**
   * dm may change anything (including initiative). A player may only touch
   * hpDelta/hpSet/addConditions/removeConditions, and only on a combatant
   * whose characterId links to a character THEY own — everything else 403s.
   */
  async updateCombatant(
    encounterId: number,
    combatantId: number,
    patch: CombatantUpdateInput,
    user: RequestUser,
    role: Role,
  ): Promise<Combatant> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    const existing = await this.getCombatantRowOrThrow(encounterId, combatantId);

    if (role !== 'dm') {
      if (patch.initiative !== undefined) {
        throw new ForbiddenException('Only dm may set initiative');
      }
      if (!existing.characterId) {
        throw new ForbiddenException('Only dm may modify this combatant');
      }
      const [character] = await this.db.select().from(characters).where(eq(characters.id, existing.characterId)).limit(1);
      if (!character || character.ownerUserId !== user.id) {
        throw new ForbiddenException('Only dm or the owning player may modify this combatant');
      }
    }

    const update: Partial<typeof combatants.$inferInsert> = {};

    if (patch.hpDelta !== undefined || patch.hpSet !== undefined) {
      let hpCurrent = existing.hpCurrent;
      if (patch.hpDelta !== undefined) hpCurrent += patch.hpDelta;
      if (patch.hpSet !== undefined) hpCurrent = patch.hpSet;
      update.hpCurrent = Math.max(0, Math.min(existing.hpMax, hpCurrent));
    }

    if (patch.addConditions !== undefined || patch.removeConditions !== undefined) {
      const current = new Set(fromJsonText<string[]>(existing.conditions, []));
      for (const c of patch.removeConditions ?? []) current.delete(c);
      for (const c of patch.addConditions ?? []) current.add(c);
      update.conditions = toJsonText([...current]);
    }

    if (patch.initiative !== undefined && role === 'dm') {
      update.initiative = patch.initiative;
    }

    if (Object.keys(update).length === 0) {
      return combatantToDomain(existing);
    }

    const [row] = await this.db.update(combatants).set(update).where(eq(combatants.id, combatantId)).returning();

    // Keep the linked character's HP in sync live too (not just at encounter end), so the
    // character sheet reflects table state while the fight is in progress.
    if (existing.kind === 'character' && existing.characterId !== null && update.hpCurrent !== undefined) {
      await this.db
        .update(characters)
        .set({ hpCurrent: update.hpCurrent, updatedAt: nowIso() })
        .where(eq(characters.id, existing.characterId));
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.combatant.update',
      entityType: 'combatant',
      entityId: combatantId,
      campaignId: encounterRow.campaignId,
      detail: JSON.stringify(patch),
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return combatantToDomain(row);
  }

  async removeCombatant(encounterId: number, combatantId: number, user: RequestUser, role: Role): Promise<void> {
    const encounterRow = await this.getRowOrThrow(encounterId);
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
    const rows = await this.listCombatantRows(encounterId);

    for (const row of rows) {
      if (row.initiative !== null) continue;
      const initiative = rollInitiative(row.initMod);
      await this.db.update(combatants).set({ initiative }).where(eq(combatants.id, row.id));
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

    return this.getWithCombatantsOrThrow(encounterId);
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

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.start',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId);

    return this.getWithCombatantsOrThrow(encounterId);
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
    const count = sorted.length;
    let { turnIndex, round } = encounterRow;
    let currentCombatantId = encounterRow.currentCombatantId;
    if (count === 0) {
      turnIndex = 0;
      currentCombatantId = null;
    } else {
      // Missing/unset pointer (legacy row, or it was just removed) restarts at the top.
      const currentIdx = currentCombatantId === null ? -1 : sorted.findIndex((c) => c.id === currentCombatantId);
      let nextIdx = currentIdx + 1;
      if (nextIdx >= count) {
        nextIdx = 0;
        round += 1;
      }
      turnIndex = nextIdx;
      currentCombatantId = sorted[nextIdx].id;
    }

    await this.db
      .update(encounters)
      .set({ turnIndex, round, currentCombatantId, updatedAt: nowIso() })
      .where(eq(encounters.id, encounterId));

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

    return this.getWithCombatantsOrThrow(encounterId);
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

    return this.getWithCombatantsOrThrow(encounterId);
  }

  async remove(encounterId: number, user: RequestUser, role: Role): Promise<void> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    await this.db.delete(combatants).where(eq(combatants.encounterId, encounterId));
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
    const persisted = await this.rolls.record(campaignId, result, user);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'dice.roll',
      entityType: null,
      entityId: null,
      campaignId,
      detail: `${result.expr} = ${result.total}`,
    });

    return persisted;
  }
}

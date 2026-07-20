import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { abilityMod, advanceTurn, applyCombatantHp, hpBandFor, sortCombatants, turnIndexFor } from './encounters.logic';
import type { CombatantHpState } from './encounters.logic';

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
    hpTemp: row.hpTemp,
    hpBand: null,
    deathState: row.deathState as Combatant['deathState'],
    deathSaveSuccesses: row.deathSaveSuccesses,
    deathSaveFailures: row.deathSaveFailures,
    conditions: fromJsonText<string[]>(row.conditions, []),
    ruleEntryId: row.ruleEntryId,
    sortOrder: row.sortOrder,
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

/** floor((score - 10) / 2), the standard 5e ability-modifier formula. */
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
    // Auto-add the whole party in ONE multi-row INSERT (#72) rather than one INSERT
    // per character — the row values (including the sequential sortOrder) are computed
    // in JS and handed to a single `.values([...])`. Behavior is identical to the old
    // per-row loop; only the round-trip count changes (N -> 1).
    if (partyRows.length > 0) {
      const combatantValues = partyRows.map((character, index) => {
        const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
        const initMod = typeof stats.DEX === 'number' ? abilityMod(stats.DEX) : 0;
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
      if (patch.name !== undefined || patch.hpMax !== undefined || patch.initMod !== undefined) {
        throw new ForbiddenException('Only dm may edit a combatant’s name, hpMax, or initMod');
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
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
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
    const rows = await this.listCombatantRows(encounterId);

    // Roll each un-set combatant's initiative in JS, then apply them all in ONE
    // CASE-based UPDATE (#72) instead of one UPDATE per combatant. Combatants that
    // already have an initiative are excluded from the id list, so — exactly as
    // before — only null initiatives are filled and manually-set values are left
    // untouched. No write at all when nothing needs rolling.
    const rolled = rows
      .filter((row) => row.initiative === null)
      .map((row) => ({ id: row.id, initiative: rollInitiative(row.initMod) }));
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

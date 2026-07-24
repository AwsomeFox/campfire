import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { FactionCreate, FactionUpdate } from '@campfire/schema';
import type { Faction, FactionStanding, FactionWithMembers, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { factions, npcs } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets, filterHidden, isVisibleTo, resolveCreateHidden } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { RevisionsService } from '../revisions/revisions.service';
import { NpcsService } from '../npcs/npcs.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type FactionCreateInput = z.infer<typeof FactionCreate>;
type FactionUpdateInput = z.infer<typeof FactionUpdate>;

export function toDomain(row: typeof factions.$inferSelect): Faction {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    kind: row.kind,
    body: row.body,
    goals: row.goals,
    dmSecret: row.dmSecret,
    hidden: row.hidden,
    reputation: row.reputation,
    standing: row.standing as FactionStanding,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class FactionsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly revisions: RevisionsService,
    private readonly npcs: NpcsService,
  ) {}

  async listForCampaign(campaignId: number, role: Role): Promise<Faction[]> {
    const rows = await this.db.select().from(factions).where(eq(factions.campaignId, campaignId));
    // Drop hidden factions wholesale for non-DM BEFORE redacting dmSecret (issue #42).
    return redactSecrets(filterHidden(rows.map(toDomain), role), role);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(factions).where(eq(factions.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Faction ${id} not found`);
    return row;
  }

  /**
   * #159-style case-insensitive name lookup within one campaign — the basis for real
   * upsert semantics in `upsert_faction`. Returns the oldest match (lowest id) for a
   * stable target if legacy duplicates already exist.
   */
  async findRowByName(campaignId: number, name: string) {
    const [row] = await this.db
      .select()
      .from(factions)
      .where(and(eq(factions.campaignId, campaignId), sql`lower(${factions.name}) = lower(${name})`))
      .orderBy(factions.id)
      .limit(1);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Faction> {
    const row = await this.getRowOrThrow(id);
    const faction = toDomain(row);
    // Hidden faction → 404 for non-DM, so its existence isn't leaked (issue #42).
    if (!isVisibleTo(faction, role)) throw new NotFoundException(`Faction ${id} not found`);
    return redactSecret(faction, role);
  }

  /** A faction plus its member NPCs (role-filtered/redacted). 404s a hidden faction for non-DM. */
  async getWithMembersOrThrow(id: number, role: Role): Promise<FactionWithMembers> {
    const faction = await this.getOrThrow(id, role);
    const members = await this.npcs.listForFaction(id, role);
    return { ...faction, members };
  }

  async create(campaignId: number, input: FactionCreateInput, user: RequestUser, role: Role): Promise<Faction> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(factions)
      .values({
        campaignId,
        name: input.name,
        kind: input.kind ?? '',
        body: input.body ?? '',
        goals: input.goals ?? '',
        dmSecret: input.dmSecret ?? '',
        // Private-by-default prep (#754): omit → DM-only; pass false to reveal at create.
        hidden: resolveCreateHidden(input.hidden),
        reputation: input.reputation ?? 0,
        standing: input.standing ?? 'neutral',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'faction.create',
      entityType: 'faction',
      entityId: row.id,
      campaignId,
    });
    // Initial prose tip so the first overwrite keeps real authorship (#813).
    if (row.body !== '') {
      await this.revisions.commitProseVersion({
        entityType: 'faction',
        entityId: row.id,
        campaignId,
        priorProse: '',
        nextProse: row.body,
        user,
      });
    }
    return redactSecret(toDomain(row), role);
  }

  async update(
    id: number,
    input: FactionUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<Faction> {
    const existing = await this.getRowOrThrow(id);
    // Optimistic concurrency (#157): 409 on a stale expectedUpdatedAt before any write.
    this.revisions.assertNotStale(existing, opts?.expectedUpdatedAt);
    // Commit an immutable prose version when the body changes (#157/#221/#813).
    if (input.body !== undefined && input.body !== existing.body) {
      await this.revisions.commitProseVersion({
        entityType: 'faction',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.body,
        nextProse: input.body,
        user,
      });
    }
    const [row] = await this.db
      .update(factions)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(factions.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'faction.update',
      entityType: 'faction',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify(input),
    });
    return redactSecret(toDomain(row), role);
  }

  /**
   * Reputation control (issue #221) — the AI-scribe entry point ("the party burned the
   * guildhall — drop Guild reputation"). `delta` adjusts the current score (clamped to
   * [-100, 100]); an explicit `reputation` sets it outright; `standing` sets the label.
   * At least one of the three must be present.
   *
   * Concurrency (issue #657): the read, the clamp, and the write all run inside ONE
   * synchronous better-sqlite3 transaction — mirroring patchHp/patchXp (#653) and
   * patchTreasury (#582). The { delta } path is applied as a single atomic
   * `UPDATE ... SET reputation = reputation + ?` (the column on both sides of `+`, so
   * SQLite reads the latest committed value inside statement atomicity — no read-then-write
   * window). Two concurrent +5 adjustments now compose to +10 instead of the second
   * clobbering the first. Audit + revision side-effects fire after the tx commits, so
   * they stay identical to any other faction write (this deliberately does NOT route
   * through `update()`, which would re-introduce the read-modify-write race).
   */
  async adjustReputation(
    id: number,
    input: { delta?: number; reputation?: number; standing?: FactionStanding },
    user: RequestUser,
    role: Role,
  ): Promise<Faction> {
    if (input.delta === undefined && input.reputation === undefined && input.standing === undefined) {
      throw new BadRequestException('Provide at least one of: delta, reputation, standing');
    }
    const ts = nowIso();
    let row!: typeof factions.$inferSelect;
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(factions).where(eq(factions.id, id)).limit(1).all();
      if (!fresh) throw new NotFoundException(`Faction ${id} not found`);

      // { reputation } is an absolute set; { delta } is the primary add/subtract path and
      // is applied atomically as `reputation + ?` so concurrent deltas compose. Clamp to
      // [-100, 100] on the absolute path; the delta path clamps the RESULT (read after the
      // atomic UPDATE via RETURNING) so a delta that would overshoot the bounds still lands
      // at the edge instead of escaping the schema's range.
      const setValues: Record<string, unknown> = { updatedAt: ts };
      if (input.standing !== undefined) setValues.standing = input.standing;

      if (input.reputation !== undefined) {
        setValues.reputation = Math.max(-100, Math.min(100, input.reputation));
      } else if (input.delta !== undefined) {
        // The atomic delta: `reputation = reputation + ?`. SQLite resolves the RHS column
        // to the live row value inside this one statement, so a racing delta can never be
        // computed from a stale read. We re-clamp the RETURNING value below.
        setValues.reputation = sql`${factions.reputation} + ${input.delta}`;
      }

      const [updated] = tx
        .update(factions)
        .set(setValues)
        .where(eq(factions.id, id))
        .returning()
        .all();

      if (input.delta !== undefined) {
        const clamped = Math.max(-100, Math.min(100, updated.reputation));
        if (clamped !== updated.reputation) {
          const [reclamped] = tx
            .update(factions)
            .set({ reputation: clamped, updatedAt: ts })
            .where(eq(factions.id, id))
            .returning()
            .all();
          row = reclamped;
          return;
        }
      }
      row = updated;
    });

    // Audit + revision side-effects mirror `update()` exactly, but fire AFTER the tx
    // commits so a failure here never leaves a half-written reputation. The detail payload
    // records the effective patch shape the caller supplied.
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'faction.update',
      entityType: 'faction',
      entityId: id,
      campaignId: row.campaignId,
      detail: JSON.stringify(input),
    });
    return redactSecret(toDomain(row), role);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    // Null out any NPC pinned to this faction in the same transaction as the delete,
    // so a membership never dangles on a deleted faction. Mirrors NpcsService.remove()'s
    // giverNpcId re-nulling. (Fresh DBs also have ON DELETE SET NULL, but migrated DBs
    // added faction_id without the FK clause — #69 — so do it explicitly.)
    this.db.transaction((tx) => {
      tx.update(npcs).set({ factionId: null, updatedAt: nowIso() }).where(eq(npcs.factionId, id)).run();
      tx.delete(factions).where(eq(factions.id, id)).run();
    });
    // Drop this faction's prose revisions (polymorphic soft ref, no FK cascade — #157).
    await this.revisions.removeForEntity('faction', id);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'faction.delete',
      entityType: 'faction',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }
}

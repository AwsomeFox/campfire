import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { FactionCreate, FactionUpdate } from '@campfire/schema';
import type { Faction, FactionStanding, FactionWithMembers, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { factions, npcs } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets, filterHidden, isVisibleTo } from '../../common/redact';
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
        hidden: input.hidden ?? false,
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
    // Snapshot the PRIOR body into revision history when it changes (#157/#221).
    if (input.body !== undefined && input.body !== existing.body) {
      await this.revisions.record({
        entityType: 'faction',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.body,
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
   * At least one of the three must be present. Routes through `update` so revision/audit
   * behavior is identical to any other write.
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
    const existing = await this.getRowOrThrow(id);
    const patch: FactionUpdateInput = {};
    if (input.reputation !== undefined) {
      patch.reputation = input.reputation;
    } else if (input.delta !== undefined) {
      patch.reputation = Math.max(-100, Math.min(100, existing.reputation + input.delta));
    }
    if (input.standing !== undefined) patch.standing = input.standing;
    return this.update(id, patch, user, role);
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

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { NpcCreate, NpcUpdate } from '@campfire/schema';
import type { Npc, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { npcs, locations, quests } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets, filterHidden, isVisibleTo } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type NpcCreateInput = z.infer<typeof NpcCreate>;
type NpcUpdateInput = z.infer<typeof NpcUpdate>;

export function toDomain(row: typeof npcs.$inferSelect): Npc {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    role: row.role,
    disposition: row.disposition,
    locationId: row.locationId,
    body: row.body,
    dmSecret: row.dmSecret,
    hidden: row.hidden,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class NpcsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly revisions: RevisionsService,
  ) {}

  async listForCampaign(campaignId: number, role: Role): Promise<Npc[]> {
    const rows = await this.db.select().from(npcs).where(eq(npcs.campaignId, campaignId));
    // Drop hidden NPCs wholesale for non-DM BEFORE redacting dmSecret (issue #42).
    return redactSecrets(filterHidden(rows.map(toDomain), role), role);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(npcs).where(eq(npcs.id, id)).limit(1);
    if (!row) throw new NotFoundException(`NPC ${id} not found`);
    return row;
  }

  /**
   * #159: case-insensitive name lookup within one campaign — the basis for real
   * upsert semantics. `upsert_npc` with no id looks here first; a hit updates the
   * existing NPC instead of creating a duplicate, so a scribe's identical re-run
   * (timeout-after-commit, or a re-issued prompt) is idempotent. Scoped to the
   * campaign, so same-named NPCs in different campaigns never collide. Returns the
   * oldest match (lowest id) for a stable target if legacy duplicates already exist.
   */
  async findRowByName(campaignId: number, name: string) {
    const [row] = await this.db
      .select()
      .from(npcs)
      .where(and(eq(npcs.campaignId, campaignId), sql`lower(${npcs.name}) = lower(${name})`))
      .orderBy(npcs.id)
      .limit(1);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Npc> {
    const row = await this.getRowOrThrow(id);
    const npc = toDomain(row);
    // Hidden NPC → 404 for non-DM, so its existence isn't leaked (issue #42).
    if (!isVisibleTo(npc, role)) throw new NotFoundException(`NPC ${id} not found`);
    return redactSecret(npc, role);
  }

  /**
   * locationId (locations.id) is an FK-shaped field that previously accepted any integer
   * with no existence/campaign check — a nonexistent id, or another campaign's location id,
   * would silently pass through and leave the NPC pinned to a place that never resolves.
   * Mirrors campaigns.validateLocationRef / quests.validateGiverNpcRef.
   */
  private async validateLocationRef(locationId: number | null | undefined, campaignId: number): Promise<void> {
    if (locationId == null) return;
    const [row] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`locationId ${locationId} does not exist in this campaign`);
  }

  async create(campaignId: number, input: NpcCreateInput, user: RequestUser, role: Role): Promise<Npc> {
    await this.validateLocationRef(input.locationId, campaignId);
    const ts = nowIso();
    const [row] = await this.db
      .insert(npcs)
      .values({
        campaignId,
        name: input.name,
        role: input.role ?? '',
        disposition: input.disposition ?? 'neutral',
        locationId: input.locationId ?? null,
        body: input.body ?? '',
        dmSecret: input.dmSecret ?? '',
        hidden: input.hidden ?? false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'npc.create',
      entityType: 'npc',
      entityId: row.id,
      campaignId,
    });
    return redactSecret(toDomain(row), role);
  }

  async update(
    id: number,
    input: NpcUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<Npc> {
    const existing = await this.getRowOrThrow(id);
    // Optimistic concurrency (#157): 409 on a stale expectedUpdatedAt before any write.
    this.revisions.assertNotStale(existing, opts?.expectedUpdatedAt);
    await this.validateLocationRef(input.locationId, existing.campaignId);
    // Snapshot the PRIOR body into revision history when it changes (#157).
    if (input.body !== undefined && input.body !== existing.body) {
      await this.revisions.record({
        entityType: 'npc',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.body,
        user,
      });
    }
    const [row] = await this.db
      .update(npcs)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(npcs.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'npc.update',
      entityType: 'npc',
      entityId: id,
      campaignId: existing.campaignId,
      // #161: record the changed fields so the audit log is a real delta channel
      // (empty detail before). Matches the characters/encounters/members convention.
      detail: JSON.stringify(input),
    });
    return redactSecret(toDomain(row), role);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    // Null out any quest that credits this NPC as its giver in the same transaction as
    // the delete, so a quest never dangles on a deleted giverNpcId (the quest UI silently
    // drops a ghost giver line). Mirrors QuestsService.remove()'s subquest re-parenting.
    this.db.transaction((tx) => {
      tx.update(quests).set({ giverNpcId: null, updatedAt: nowIso() }).where(eq(quests.giverNpcId, id)).run();
      tx.delete(npcs).where(eq(npcs.id, id)).run();
    });
    // Drop this NPC's prose revisions (polymorphic soft ref, no FK cascade — #157).
    await this.revisions.removeForEntity('npc', id);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'npc.delete',
      entityType: 'npc',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }
}

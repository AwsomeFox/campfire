import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { NpcCreate, NpcUpdate } from '@campfire/schema';
import type { Npc, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { npcs, locations, quests } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class NpcsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForCampaign(campaignId: number, role: Role): Promise<Npc[]> {
    const rows = await this.db.select().from(npcs).where(eq(npcs.campaignId, campaignId));
    return redactSecrets(rows.map(toDomain), role);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(npcs).where(eq(npcs.id, id)).limit(1);
    if (!row) throw new NotFoundException(`NPC ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Npc> {
    const row = await this.getRowOrThrow(id);
    return redactSecret(toDomain(row), role);
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

  async update(id: number, input: NpcUpdateInput, user: RequestUser, role: Role): Promise<Npc> {
    const existing = await this.getRowOrThrow(id);
    await this.validateLocationRef(input.locationId, existing.campaignId);
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

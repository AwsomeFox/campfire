import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { NpcCreate, NpcUpdate } from '@campfire/schema';
import type { Npc, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { npcs } from '../../db/schema';
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

  async create(campaignId: number, input: NpcCreateInput, user: RequestUser, role: Role): Promise<Npc> {
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
    await this.db.delete(npcs).where(eq(npcs.id, id));
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

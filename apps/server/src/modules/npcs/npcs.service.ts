import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { NpcCreate, NpcUpdate } from '@campfire/schema';
import type { Npc, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { npcs, locations } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
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
    const rows = await this.db.select().from(npcs).where(and(eq(npcs.campaignId, campaignId), notDeleted(npcs.deletedAt)));
    // Drop hidden NPCs wholesale for non-DM BEFORE redacting dmSecret (issue #42).
    return redactSecrets(filterHidden(rows.map(toDomain), role), role);
  }

  async getRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(npcs).where(eq(npcs.id, id)).limit(1);
    // A trashed NPC (soft-deleted, #116) reads as nonexistent unless includeDeleted (restore).
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`NPC ${id} not found`);
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
      .where(and(eq(npcs.campaignId, campaignId), sql`lower(${npcs.name}) = lower(${name})`, notDeleted(npcs.deletedAt)))
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
      .where(and(eq(locations.id, locationId), eq(locations.campaignId, campaignId), notDeleted(locations.deletedAt)))
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

  /**
   * Soft-delete (trash) an NPC (issue #116) — reversible. Only stamps `deleted_at`; the
   * NPC vanishes from normal reads but every row survives for restore(). Unlike the old
   * hard delete we deliberately DON'T null out quests that credit this NPC as giver —
   * that mutation would be irreversible. A quest whose giver is trashed simply shows no
   * giver in the meantime, and re-links on restore.
   */
  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    await this.db.update(npcs).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(npcs.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'npc.delete',
      entityType: 'npc',
      entityId: id,
      campaignId: existing.campaignId,
      detail: 'soft-delete (trashed)',
    });
  }

  /** Restore a trashed NPC (issue #116) — clears `deleted_at`. 404 if it isn't trashed. */
  async restore(id: number, user: RequestUser, role: Role): Promise<Npc> {
    const existing = await this.getRowOrThrow(id, true);
    if (existing.deletedAt == null) throw new NotFoundException(`NPC ${id} is not in the trash`);
    const [row] = await this.db
      .update(npcs)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(eq(npcs.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'npc.restore',
      entityType: 'npc',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return redactSecret(toDomain(row), role);
  }
}

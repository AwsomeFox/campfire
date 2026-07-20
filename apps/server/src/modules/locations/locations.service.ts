import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { LocationCreate, LocationUpdate } from '@campfire/schema';
import type { Location, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { locations, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { redactSecret, redactSecrets } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type LocationCreateInput = z.infer<typeof LocationCreate>;
type LocationUpdateInput = z.infer<typeof LocationUpdate>;

export function toDomain(row: typeof locations.$inferSelect): Location {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    kind: row.kind,
    status: row.status as Location['status'],
    mapX: row.mapX,
    mapY: row.mapY,
    body: row.body,
    dmSecret: row.dmSecret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class LocationsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Entity-level secrecy (issue #42) for locations reconciles with the existing
   * `status` enum rather than adding a separate `hidden` flag: an `unexplored`
   * location is the DM's un-revealed prep and must not appear in any non-DM read.
   * The DM reveals it via the discovery action (status → explored|current).
   */
  private isHiddenFrom(status: string, role: Role): boolean {
    return role !== 'dm' && status === 'unexplored';
  }

  async listForCampaign(campaignId: number, role: Role): Promise<Location[]> {
    const rows = await this.db.select().from(locations).where(eq(locations.campaignId, campaignId));
    const visible = rows.filter((r) => !this.isHiddenFrom(r.status, role));
    return redactSecrets(visible.map(toDomain), role);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(locations).where(eq(locations.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Location ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Location> {
    const row = await this.getRowOrThrow(id);
    // Unexplored location → 404 for non-DM, so its existence isn't leaked (issue #42).
    if (this.isHiddenFrom(row.status, role)) throw new NotFoundException(`Location ${id} not found`);
    return redactSecret(toDomain(row), role);
  }

  async create(campaignId: number, input: LocationCreateInput, user: RequestUser, role: Role): Promise<Location> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(locations)
      .values({
        campaignId,
        name: input.name,
        kind: input.kind ?? '',
        status: input.status ?? 'unexplored',
        mapX: input.mapX ?? null,
        mapY: input.mapY ?? null,
        body: input.body ?? '',
        dmSecret: input.dmSecret ?? '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'location.create',
      entityType: 'location',
      entityId: row.id,
      campaignId,
    });
    return redactSecret(toDomain(row), role);
  }

  async update(id: number, input: LocationUpdateInput, user: RequestUser, role: Role): Promise<Location> {
    const existing = await this.getRowOrThrow(id);
    const [row] = await this.db
      .update(locations)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(locations.id, id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'location.update',
      entityType: 'location',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return redactSecret(toDomain(row), role);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    await this.db.delete(locations).where(eq(locations.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'location.delete',
      entityType: 'location',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }

  /**
   * Set a location's status. When set to 'current', demote any previous
   * 'current' location in the same campaign to 'explored' and set
   * campaign.currentLocationId to this location.
   */
  async discover(id: number, status: Location['status'], user: RequestUser, role: Role): Promise<Location> {
    const existing = await this.getRowOrThrow(id);

    if (status === 'current') {
      const previousCurrent = await this.db
        .select()
        .from(locations)
        .where(and(eq(locations.campaignId, existing.campaignId), eq(locations.status, 'current')));
      for (const prev of previousCurrent) {
        if (prev.id !== id) {
          await this.db
            .update(locations)
            .set({ status: 'explored', updatedAt: nowIso() })
            .where(eq(locations.id, prev.id));
        }
      }
    }

    const [row] = await this.db
      .update(locations)
      .set({ status, updatedAt: nowIso() })
      .where(eq(locations.id, id))
      .returning();

    if (status === 'current') {
      await this.db
        .update(campaigns)
        .set({ currentLocationId: id, updatedAt: nowIso() })
        .where(eq(campaigns.id, existing.campaignId));
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'location.discover',
      entityType: 'location',
      entityId: id,
      campaignId: existing.campaignId,
      detail: status,
    });

    return redactSecret(toDomain(row), role);
  }
}

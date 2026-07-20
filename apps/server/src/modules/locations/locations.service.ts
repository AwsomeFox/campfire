import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { LocationCreate, LocationUpdate } from '@campfire/schema';
import type { Location, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { locations, campaigns, npcs } from '../../db/schema';
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
    parentId: row.parentId,
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

  /**
   * Validate a location's parentId (self-referencing locations.id) for nesting (#99):
   * it must reference an existing location in the SAME campaign, a location cannot be
   * its own parent, and reparenting must not create a cycle. Mirrors the quest parent
   * guard (#95). `excludeLocationId` (update only) rejects self-parenting and cycles;
   * create has no id yet so it can never close a loop.
   */
  private async validateParentRef(
    parentId: number | null | undefined,
    campaignId: number,
    excludeLocationId?: number,
  ): Promise<void> {
    if (parentId == null) return;
    if (excludeLocationId != null && parentId === excludeLocationId) {
      throw new BadRequestException('A location cannot be its own parent');
    }
    const [row] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, parentId), eq(locations.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`parentId ${parentId} does not exist in this campaign`);
    if (excludeLocationId != null) {
      await this.assertNoAncestorCycle(parentId, excludeLocationId, campaignId);
    }
  }

  /**
   * Walk the parent chain starting at `startParentId`. Throws 400 if it reaches
   * `locationId` (the location being reparented) — that would create a cycle where
   * a location becomes its own ancestor. A local `seen` set guards against looping
   * forever on pre-existing cyclic legacy rows that don't involve `locationId`.
   */
  private async assertNoAncestorCycle(startParentId: number, locationId: number, campaignId: number): Promise<void> {
    let cursor: number | null = startParentId;
    const seen = new Set<number>();
    while (cursor != null) {
      if (cursor === locationId) {
        throw new BadRequestException('parentId would create a cycle: a location cannot be its own ancestor');
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const [row]: { parentId: number | null }[] = await this.db
        .select({ parentId: locations.parentId })
        .from(locations)
        .where(and(eq(locations.id, cursor), eq(locations.campaignId, campaignId)))
        .limit(1);
      cursor = row?.parentId ?? null;
    }
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

  /**
   * #159: case-insensitive name lookup within one campaign — the basis for real
   * upsert semantics. `upsert_location` with no id looks here first; a hit updates
   * the existing location instead of creating a duplicate, so a scribe's identical
   * re-run (timeout-after-commit, or a re-issued prompt) is idempotent. Scoped to
   * the campaign, so same-named locations in different campaigns never collide.
   * Returns the oldest match (lowest id) if legacy duplicates already exist.
   */
  async findRowByName(campaignId: number, name: string) {
    const [row] = await this.db
      .select()
      .from(locations)
      .where(and(eq(locations.campaignId, campaignId), sql`lower(${locations.name}) = lower(${name})`))
      .orderBy(locations.id)
      .limit(1);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Location> {
    const row = await this.getRowOrThrow(id);
    // Unexplored location → 404 for non-DM, so its existence isn't leaked (issue #42).
    if (this.isHiddenFrom(row.status, role)) throw new NotFoundException(`Location ${id} not found`);
    return redactSecret(toDomain(row), role);
  }

  async create(campaignId: number, input: LocationCreateInput, user: RequestUser, role: Role): Promise<Location> {
    await this.validateParentRef(input.parentId, campaignId);
    const ts = nowIso();
    const [row] = await this.db
      .insert(locations)
      .values({
        campaignId,
        parentId: input.parentId ?? null,
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
    await this.validateParentRef(input.parentId, existing.campaignId, id);
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
      // #161: record the changed fields so the audit log is a real delta channel
      // (empty detail before). Matches the characters/encounters/members convention.
      detail: JSON.stringify(input),
    });
    return redactSecret(toDomain(row), role);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    // Null out inbound references in the same transaction as the delete so nothing dangles
    // on a deleted location: NPCs pinned here (npcs.locationId), the campaign's
    // currentLocationId, and any child locations (locations.parentId → promoted to
    // top-level, #99, mirroring how QuestsService reparents subquests to root rather
    // than cascading the delete). Mirrors AttachmentsService/QuestsService cascade patterns.
    this.db.transaction((tx) => {
      tx.update(npcs).set({ locationId: null, updatedAt: nowIso() }).where(eq(npcs.locationId, id)).run();
      tx.update(campaigns).set({ currentLocationId: null, updatedAt: nowIso() }).where(eq(campaigns.currentLocationId, id)).run();
      tx.update(locations).set({ parentId: null, updatedAt: nowIso() }).where(eq(locations.parentId, id)).run();
      tx.delete(locations).where(eq(locations.id, id)).run();
    });
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

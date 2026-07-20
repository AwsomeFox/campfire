import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { InventoryItemCreate, InventoryItemUpdate, TreasuryPatch } from '@campfire/schema';
import type { InventoryItem, Treasury, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { inventoryItems, partyTreasury, characters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type InventoryItemCreateInput = z.infer<typeof InventoryItemCreate>;
type InventoryItemUpdateInput = z.infer<typeof InventoryItemUpdate>;
type TreasuryPatchInput = z.infer<typeof TreasuryPatch>;

const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'] as const;

function toDomain(row: typeof inventoryItems.$inferSelect): InventoryItem {
  return {
    id: row.id,
    campaignId: row.campaignId,
    ownerType: row.ownerType as InventoryItem['ownerType'],
    characterId: row.characterId,
    name: row.name,
    qty: row.qty,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function treasuryToDomain(row: typeof partyTreasury.$inferSelect): Treasury {
  return {
    campaignId: row.campaignId,
    cp: row.cp,
    sp: row.sp,
    ep: row.ep,
    gp: row.gp,
    pp: row.pp,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  // ---------- items ----------

  async listForCampaign(campaignId: number): Promise<InventoryItem[]> {
    const rows = await this.db.select().from(inventoryItems).where(eq(inventoryItems.campaignId, campaignId));
    return rows.map(toDomain);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(inventoryItems).where(eq(inventoryItems.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Item ${id} not found`);
    return row;
  }

  async getOrThrow(id: number): Promise<InventoryItem> {
    return toDomain(await this.getRowOrThrow(id));
  }

  /**
   * (ownerType, characterId) consistency + FK check:
   *  - ownerType='character' requires a characterId that exists IN THIS campaign
   *  - ownerType='party' must not carry a characterId
   */
  private async validateOwner(ownerType: 'party' | 'character', characterId: number | null, campaignId: number) {
    if (ownerType === 'party') {
      if (characterId != null) throw new BadRequestException('Party items cannot have a characterId');
      return null;
    }
    if (characterId == null) throw new BadRequestException('ownerType "character" requires characterId');
    const [row] = await this.db
      .select({ id: characters.id, ownerUserId: characters.ownerUserId })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`characterId ${characterId} does not exist in this campaign`);
    return row;
  }

  /**
   * Who may write an item (controller has already required player+):
   *  - dm: anything
   *  - player: the party stash, or items on a character they own
   */
  private async assertCanWriteOwner(
    ownerType: 'party' | 'character',
    characterId: number | null,
    campaignId: number,
    user: RequestUser,
    role: Role,
  ): Promise<void> {
    const character = await this.validateOwner(ownerType, characterId, campaignId);
    if (role === 'dm' || ownerType === 'party') return;
    if (character && character.ownerUserId === user.id) return;
    throw new ForbiddenException('Only dm or the owning player may manage this character\'s items');
  }

  async create(campaignId: number, input: InventoryItemCreateInput, user: RequestUser, role: Role): Promise<InventoryItem> {
    const ownerType = input.ownerType ?? 'party';
    const characterId = input.characterId ?? null;
    await this.assertCanWriteOwner(ownerType, characterId, campaignId, user, role);

    const ts = nowIso();
    const [row] = await this.db
      .insert(inventoryItems)
      .values({
        campaignId,
        ownerType,
        characterId,
        name: input.name,
        qty: input.qty ?? 1,
        notes: input.notes ?? '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'item.create',
      entityType: 'inventory_item',
      entityId: row.id,
      campaignId,
    });
    return toDomain(row);
  }

  async update(id: number, input: InventoryItemUpdateInput, user: RequestUser, role: Role): Promise<InventoryItem> {
    const existing = await this.getRowOrThrow(id);
    // must be allowed to touch the item where it currently lives…
    await this.assertCanWriteOwner(
      existing.ownerType as 'party' | 'character',
      existing.characterId,
      existing.campaignId,
      user,
      role,
    );

    // …and, if the item is being moved, allowed to place it at the destination.
    const finalOwnerType = (input.ownerType ?? existing.ownerType) as 'party' | 'character';
    const finalCharacterId =
      finalOwnerType === 'party'
        ? (input.characterId ?? null) // validateOwner 400s if an explicit characterId is sent with 'party'
        : input.characterId !== undefined
          ? input.characterId
          : existing.characterId;
    const moved = finalOwnerType !== existing.ownerType || finalCharacterId !== existing.characterId;
    if (moved) {
      await this.assertCanWriteOwner(finalOwnerType, finalCharacterId, existing.campaignId, user, role);
    }

    const update: Partial<typeof inventoryItems.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) update.name = input.name;
    if (input.qty !== undefined) update.qty = input.qty;
    if (input.notes !== undefined) update.notes = input.notes;
    if (moved) {
      update.ownerType = finalOwnerType;
      update.characterId = finalOwnerType === 'party' ? null : finalCharacterId;
    }

    const [row] = await this.db.update(inventoryItems).set(update).where(eq(inventoryItems.id, id)).returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'item.update',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return toDomain(row);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    await this.assertCanWriteOwner(
      existing.ownerType as 'party' | 'character',
      existing.characterId,
      existing.campaignId,
      user,
      role,
    );
    await this.db.delete(inventoryItems).where(eq(inventoryItems.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'item.delete',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }

  // ---------- treasury ----------

  /** Lazily creates the campaign's zeroed coin row on first access. */
  async getTreasury(campaignId: number): Promise<Treasury> {
    const [row] = await this.db.select().from(partyTreasury).where(eq(partyTreasury.campaignId, campaignId)).limit(1);
    if (row) return treasuryToDomain(row);
    const [created] = await this.db
      .insert(partyTreasury)
      .values({ campaignId, updatedAt: nowIso() })
      .returning();
    return treasuryToDomain(created);
  }

  async patchTreasury(campaignId: number, patch: TreasuryPatchInput, user: RequestUser, role: Role): Promise<Treasury> {
    const current = await this.getTreasury(campaignId);

    const next: Record<(typeof COINS)[number], number> = { cp: current.cp, sp: current.sp, ep: current.ep, gp: current.gp, pp: current.pp };
    if ('delta' in patch) {
      for (const coin of COINS) {
        const d = patch.delta[coin];
        if (d === undefined) continue;
        const value = next[coin] + d;
        if (value < 0) throw new BadRequestException(`Treasury cannot go negative (${coin}: ${next[coin]} ${d >= 0 ? '+' : ''}${d})`);
        next[coin] = value;
      }
    } else {
      for (const coin of COINS) {
        const v = patch.set[coin];
        if (v !== undefined) next[coin] = v;
      }
    }

    const [row] = await this.db
      .update(partyTreasury)
      .set({ ...next, updatedAt: nowIso() })
      .where(eq(partyTreasury.campaignId, campaignId))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'treasury.update',
      entityType: 'treasury',
      entityId: campaignId,
      campaignId,
      detail: JSON.stringify(patch),
    });
    return treasuryToDomain(row);
  }
}

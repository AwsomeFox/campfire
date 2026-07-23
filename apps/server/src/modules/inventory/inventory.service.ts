import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { InventoryItemCreate, InventoryItemUpdate, TreasuryPatch } from '@campfire/schema';
import type { InventoryItem, Treasury, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { inventoryItems, partyTreasury, characters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type InventoryItemCreateInput = z.infer<typeof InventoryItemCreate>;
type InventoryItemUpdateInput = z.infer<typeof InventoryItemUpdate>;
type TreasuryPatchInput = z.infer<typeof TreasuryPatch>;

type CoinKey = 'cp' | 'sp' | 'ep' | 'gp' | 'pp';

function toDomain(row: typeof inventoryItems.$inferSelect): InventoryItem {
  return {
    id: row.id,
    campaignId: row.campaignId,
    ownerType: row.ownerType as InventoryItem['ownerType'],
    characterId: row.characterId,
    name: row.name,
    qty: row.qty,
    notes: row.notes,
    iconSlug: row.iconSlug,
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
    private readonly events: CampaignEventsService,
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
        iconSlug: input.iconSlug ?? '',
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
    if (input.iconSlug !== undefined) update.iconSlug = input.iconSlug;
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

  /**
   * Lazily creates the campaign's zeroed coin row on first access.
   *
   * Issue #658: a plain read-then-insert races under concurrent first-access —
   * two callers each see `!row`, both INSERT, and the second loses the
   * `campaignId` PRIMARY KEY constraint, surfacing as an unhandled 500. The
   * INSERT therefore carries `onConflictDoNothing({ target: campaignId })`: one
   * call wins the insert, the loser's conflict is silently ignored, and the
   * method re-reads so both callers observe the same single row.
   *
   * The existence probe is split into its own method (`readLazyRow`) so the
   * concurrency regression in db-concurrency.e2e-spec.ts can park both racers
   * between the read and the insert — better-sqlite3 is synchronous, so without
   * that coordination the two HTTP requests never actually race at the SQL
   * layer. Mirrors the `getRowOrThrow` seam used by #653's HP race test.
   */
  async readLazyRow(campaignId: number): Promise<typeof partyTreasury.$inferSelect | undefined> {
    const [row] = await this.db.select().from(partyTreasury).where(eq(partyTreasury.campaignId, campaignId)).limit(1);
    return row;
  }

  async getTreasury(campaignId: number): Promise<Treasury> {
    const row = await this.readLazyRow(campaignId);
    if (row) return treasuryToDomain(row);
    const [created] = await this.db
      .insert(partyTreasury)
      .values({ campaignId, updatedAt: nowIso() })
      .onConflictDoNothing({ target: partyTreasury.campaignId })
      .returning();
    // A losing racer's INSERT RETURNING is empty (the conflict was ignored) —
    // re-read the winning row instead of returning a phantom `undefined`.
    if (created) return treasuryToDomain(created);
    const [winner] = await this.db.select().from(partyTreasury).where(eq(partyTreasury.campaignId, campaignId)).limit(1);
    return treasuryToDomain(winner!);
  }

  async patchTreasury(campaignId: number, patch: TreasuryPatchInput, user: RequestUser, role: Role): Promise<Treasury> {
    // Guarantee the coin row exists (lazy-creates a zeroed row on first access) BEFORE
    // the transaction, so the write below can assume it's present.
    await this.getTreasury(campaignId);

    // Issue #582: the write shapes and their concurrency stories.
    //
    //  - { delta }: the PRIMARY add/spend path. Each denomination is applied as a single
    //    atomic `UPDATE ... SET col = col + :delta` statement (the column is referenced on
    //    both sides of `+`, so SQLite reads the latest committed value inside statement
    //    atomicity — no read-then-write window). Two players spending coin at the same time
    //    can NEVER clobber each other: even on the SAME denomination the two increments
    //    compose. A delta that would drive a denomination negative still 400s: the UPDATE
    //    writes, RETURNING reads the result, the check throws — rolling the transaction back.
    //
    //  - { set }: a full reconciliation (DM correcting totals). Absolute writes are
    //    inherently racy, so a set carries an optional `expectedUpdatedAt` compare-and-swap
    //    token. When present, the UPDATE's WHERE narrows to `updated_at = :expected`, so a
    //    row written by another player in between matches zero rows; we then return the live
    //    values in a 409 so the client can merge. When `expectedUpdatedAt` is absent the set
    //    is allowed (back-compat for pre-CAS callers) but is the risky shape the issue is
    //    about — the web UI now always sends it for full edits.
    //
    // Both paths run inside one synchronous better-sqlite3 transaction so the before-read,
    // the UPDATE, the RETURNING capture, and the updatedAt bump land together (or roll back
    // together if the negativity check throws).
    const isDelta = 'delta' in patch;
    const assignments = isDelta
      ? (Object.entries(patch.delta).filter(([, d]) => d !== undefined) as [CoinKey, number][])
      : (Object.entries(patch.set).filter(([, v]) => v !== undefined) as [CoinKey, number][]);
    if (assignments.length === 0) {
      throw new BadRequestException('Treasury patch must change at least one denomination');
    }
    // Issue #582: an absolute { set } is inherently racy against concurrent deltas, so
    // it MUST carry expectedUpdatedAt (CAS) — without it, a stale form can still clobber
    // another player's concurrent spend, which is exactly the data-loss this PR closes.
    // Deltas are atomic (col = col + ?) and never require CAS. The web editor always
    // sends expectedUpdatedAt on the set path; a 400 here means an un-upgraded caller
    // that should switch to { delta } for add/spend or supply the CAS token to reconcile.
    if (!isDelta && patch.expectedUpdatedAt === undefined) {
      throw new BadRequestException('An absolute { set } requires expectedUpdatedAt (CAS); use { delta } for add/spend');
    }

    const ts = nowIso();
    const expected = !isDelta ? patch.expectedUpdatedAt : undefined;

    // Build the SET clause as a drizzle set-object. For deltas each value is a
    // `sql\`${col} + ${n}\`` fragment — the column name on the left is the live row value.
    // For sets the value is the literal. updatedAt is always bumped.
    const tableCols: Record<CoinKey, ReturnType<typeof sql.raw>> = {
      cp: sql.raw('cp'),
      sp: sql.raw('sp'),
      ep: sql.raw('ep'),
      gp: sql.raw('gp'),
      pp: sql.raw('pp'),
    };
    const setValues: Record<string, unknown> = { updatedAt: ts };
    for (const [coin, n] of assignments) {
      setValues[coin] = isDelta ? sql`${tableCols[coin]} + ${n}` : n;
    }

    // CAS guard: when an absolute set carries an expected timestamp, the WHERE clause pins
    // the update to that exact row version. A mismatched token yields zero updated rows,
    // which we detect via RETURNING and surface as a 409 with the live values.
    const casCondition = expected !== undefined ? sql`${partyTreasury.updatedAt} = ${expected}` : undefined;

    let before: Record<CoinKey, number> = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
    let after: Treasury | null = null;
    let conflict: Treasury | null = null;

    try {
      this.db.transaction((tx) => {
        const [prior] = tx.select().from(partyTreasury).where(eq(partyTreasury.campaignId, campaignId)).limit(1).all();
        before = { cp: prior.cp, sp: prior.sp, ep: prior.ep, gp: prior.gp, pp: prior.pp };

        const updated = tx
          .update(partyTreasury)
          .set(setValues)
          .where(casCondition !== undefined ? and(eq(partyTreasury.campaignId, campaignId), casCondition) : eq(partyTreasury.campaignId, campaignId))
          .returning()
          .all();

        if (updated.length === 0) {
          // CAS mismatch (only reachable on the set path with expectedUpdatedAt): another
          // player wrote between the client's snapshot and this write. Stash the live row
          // for the 409 body, then throw a sentinel to roll the tx back and branch out.
          conflict = treasuryToDomain(prior);
          throw new TreasuryConflictMarker();
        }

        const row = updated[0];
        // Negativity check on the delta path (set values are schema-validated nonnegative
        // upstream). Throwing here rolls the whole transaction back, so a rejected spend
        // leaves the row exactly as the prior read saw it.
        if (isDelta) {
          for (const [coin, d] of assignments) {
            if (row[coin] < 0) {
              throw new BadRequestException(
                `Treasury cannot go negative (${coin}: ${before[coin]} ${d >= 0 ? '+' : ''}${d})`,
              );
            }
          }
        }
        after = treasuryToDomain(row);
      });
    } catch (err) {
      if (err instanceof TreasuryConflictMarker) {
        // Translate the in-tx sentinel into the HTTP 409 carrying the live values.
        throw new ConflictException({
          code: 'TREASURY_CONFLICT',
          message: 'The treasury changed since you last loaded it.',
          current: conflict,
        });
      }
      throw err;
    }

    // Per-denomination before/after + actor — only the denominations this write touched,
    // so an audit reader can reconstruct exactly who moved which coin when (issue #582).
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'treasury.update',
      entityType: 'treasury',
      entityId: campaignId,
      campaignId,
      detail: JSON.stringify({
        actor: { id: user.id, name: user.name, role },
        kind: isDelta ? 'delta' : 'set',
        changes: assignments.map(([coin, n]) => ({
          coin,
          before: before[coin],
          ...(isDelta ? { delta: n } : { setTo: n }),
          after: after![coin],
        })),
        ...(expected !== undefined ? { expectedUpdatedAt: expected } : {}),
      }),
    });

    // Thin invalidation tick so open editors mark themselves stale. Carries the actor's
    // userId (same identity space as RequestUser.id) so a client can both attribute the
    // change ("another player updated the treasury") and ignore the echo of its own write.
    this.events.emit({ type: 'treasury.updated', campaignId, userId: user.id });

    return after!;
  }
}

/**
 * Internal sentinel thrown inside the treasury transaction when the CAS token mismatches.
 * Throwing rolls the (synchronous better-sqlite3) transaction back; the outer try/catch in
 * patchTreasury catches this exact class and translates it into a 409 with the live values.
 * Kept private to this file so the Nest exception layer never sees it directly.
 */
class TreasuryConflictMarker extends Error {
  constructor() {
    super('treasury CAS mismatch');
    this.name = 'TreasuryConflictMarker';
  }
}

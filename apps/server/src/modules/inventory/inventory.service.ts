import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { CharacterAction, CompendiumRef, CompendiumSnapshot, InventoryFromCompendium, InventoryItem, InventoryItemCreate, InventoryItemUpdate, TreasuryPatch } from '@campfire/schema';
import type { Treasury, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { inventoryItems, inventoryQtyIdempotency, partyTreasury, characters, ruleEntries, rulePacks } from '../../db/schema';
import { buildCompendiumRef, buildCompendiumSnapshot, compendiumRefKey, computeRuleEntryContentHash } from '../campaigns/compendium-import';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type InventoryItemCreateInput = z.infer<typeof InventoryItemCreate>;
type InventoryItemUpdateInput = z.infer<typeof InventoryItemUpdate>;
type InventoryFromCompendiumInput = z.infer<typeof InventoryFromCompendium>;
type TreasuryPatchInput = z.infer<typeof TreasuryPatch>;

type CoinKey = 'cp' | 'sp' | 'ep' | 'gp' | 'pp';

/**
 * How long qty idempotency rows are honored before opportunistic prune-on-write
 * drops them (issue #782). Retries after this window may re-apply; keep larger
 * than any realistic lost-response retry, short enough the table stays bounded.
 */
export const INVENTORY_QTY_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bind an idempotency key to one qty operation *and* its accompanying mutable
 * fields so key reuse with a different payload 409s (qty, move, name, notes, icon,
 * equip — issue #1326 review: a combined "spend a charge and equip this" retry must
 * not silently drop a changed equip instruction just because qty/name/etc. match).
 *
 * Issue #1326 review (Devin): the three equip keys are appended ONLY when this
 * request actually touches equip. A request that never touches equip therefore
 * computes the EXACT SAME JSON shape a pre-#1326 binary would have stored (same key
 * order, same fields) — so an in-flight qty retry spanning this upgrade (started
 * before, retried after) still matches its persisted fingerprint and replays, rather
 * than 409ing IDEMPOTENCY_KEY_REUSE just because the fingerprint format grew new
 * fields. A request that DOES touch equip still detects a changed replay: appending
 * a new key where none existed (or changing an existing one) both fail the equality
 * check, which is exactly the reuse-with-a-different-payload case this fingerprint
 * exists to catch.
 */
function qtyFingerprint(input: InventoryItemUpdateInput): string {
  const qtyPart =
    input.qtyDelta !== undefined
      ? `delta:${input.qtyDelta}`
      : `set:${input.qty}@${input.expectedUpdatedAt ?? ''}`;
  // Deterministic JSON with explicit nulls for omitted fields — undefined must
  // not collapse into "absent key" vs "present null" differences across retries.
  const rest: Record<string, unknown> = {
    name: input.name ?? null,
    notes: input.notes ?? null,
    iconSlug: input.iconSlug ?? null,
    ownerType: input.ownerType ?? null,
    characterId: input.characterId ?? null,
  };
  if (input.equipped !== undefined || input.equipSlot !== undefined || input.equippedAction !== undefined) {
    rest.equipped = input.equipped ?? null;
    rest.equipSlot = input.equipSlot ?? null;
    rest.equippedAction = input.equippedAction ?? null;
  }
  const restPart = JSON.stringify(rest);
  return `${qtyPart}|${restPart}`;
}

function sanitizeCompendiumSnapshot(value: unknown): CompendiumSnapshot | null {
  const parsed = CompendiumSnapshot.safeParse(value);
  if (!parsed.success) return null;
  // Keep body/license/source; blank only a non-http(s) external URL.
  if (parsed.data.sourceUrl && !/^https?:\/\//i.test(parsed.data.sourceUrl)) {
    return { ...parsed.data, sourceUrl: '' };
  }
  return parsed.data;
}

function toDomain(row: typeof inventoryItems.$inferSelect): InventoryItem {
  const parsedRef = CompendiumRef.safeParse(row.compendiumRef ? safeJson(row.compendiumRef) : null);
  const ref = parsedRef.success ? parsedRef.data : null;
  const snapshot = row.compendiumSnapshot ? sanitizeCompendiumSnapshot(safeJson(row.compendiumSnapshot)) : null;
  const parsedAction = row.equippedAction ? CharacterAction.safeParse(safeJson(row.equippedAction)) : null;
  return {
    id: row.id,
    campaignId: row.campaignId,
    ownerType: row.ownerType as InventoryItem['ownerType'],
    characterId: row.characterId,
    name: row.name,
    qty: row.qty,
    notes: row.notes,
    iconSlug: row.iconSlug,
    ruleEntryId: row.ruleEntryId ?? null,
    compendiumRef: ref,
    compendiumSnapshot: snapshot,
    compendiumState: InventoryItem.shape.compendiumState.safeParse(row.compendiumState).success ? InventoryItem.shape.compendiumState.parse(row.compendiumState) : null,
    equipped: row.equipped,
    equipSlot: row.equipSlot ?? null,
    equippedAction: parsedAction?.success ? parsedAction.data : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
    deletedBy: row.deletedBy ?? null,
  };
}

function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }

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

  async listForCampaign(campaignId: number, user: RequestUser, role: Role): Promise<InventoryItem[]> {
    const rows = await this.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.campaignId, campaignId), notDeleted(inventoryItems.deletedAt)));
    return this.redactEquippedActions(await this.withCompendiumStates(rows), user, role);
  }

  /**
   * How many live inventory items this campaign has (issue #602).
   *
   * The campaign summary needs only the integer, and the dashboard re-reads that
   * summary on a timer — so loading every item row (name, notes, quantities, the
   * lot) just to take `.length` made the poll's cost scale with the party's loot
   * pile. The predicate is identical to {@link listForCampaign}, so the number is
   * the same one that list would have produced; it just never leaves SQLite.
   */
  async countForCampaign(campaignId: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.campaignId, campaignId), notDeleted(inventoryItems.deletedAt)));
    return row?.value ?? 0;
  }

  async listTrashForCampaign(campaignId: number, user: RequestUser, role: Role): Promise<InventoryItem[]> {
    const rows = await this.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.campaignId, campaignId), isNotNull(inventoryItems.deletedAt)))
      .orderBy(desc(inventoryItems.deletedAt));
    return this.redactEquippedActions(rows.map(toDomain), user, role);
  }

  async getRowOrThrow(id: number, opts?: { includeDeleted?: boolean }) {
    const conditions = [eq(inventoryItems.id, id)];
    if (!opts?.includeDeleted) conditions.push(notDeleted(inventoryItems.deletedAt));
    const [row] = await this.db.select().from(inventoryItems).where(and(...conditions)).limit(1);
    if (!row) throw new NotFoundException(`Item ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, user: RequestUser, role: Role): Promise<InventoryItem> {
    const item = await this.withCompendiumState(await this.getRowOrThrow(id));
    const [redacted] = await this.redactEquippedActions([item], user, role);
    return redacted;
  }

  /**
   * Issue #1326 review (Codex P1): `equippedAction` carries the same `CharacterAction`
   * shape as `Character.actions`, which `CharactersService.listForCampaign` treats as
   * PRIVATE mechanical state — a non-DM only ever sees their OWN character's sheet
   * actions, never another player's (see that method's doc comment). Inventory rows
   * are otherwise visible campaign-wide (name/qty/notes carry no such secrecy — any
   * member can already see the party's and other characters' loot), so this redacts
   * ONLY the one field that inherits the sheet-action precedent: a character-owned
   * item's `equippedAction` is nulled out for any reader who is neither the DM nor
   * that character's owning player. Party-stash items are never redacted — `equipped`
   * can never be true there, and the shared stash has never been private.
   */
  private async redactEquippedActions(items: InventoryItem[], user: RequestUser, role: Role): Promise<InventoryItem[]> {
    if (role === 'dm') return items;
    const characterIds = [
      ...new Set(
        items
          .filter((item) => item.ownerType === 'character' && item.characterId != null && item.equippedAction != null)
          .map((item) => item.characterId as number),
      ),
    ];
    if (characterIds.length === 0) return items;
    const owners = await this.db
      .select({ id: characters.id, ownerUserId: characters.ownerUserId })
      .from(characters)
      .where(inArray(characters.id, characterIds));
    const ownerById = new Map(owners.map((owner) => [owner.id, owner.ownerUserId]));
    return items.map((item) => {
      if (item.ownerType !== 'character' || item.characterId == null || item.equippedAction == null) return item;
      if (ownerById.get(item.characterId) === user.id) return item;
      return { ...item, equippedAction: null };
    });
  }

  /** Compute volatile linked_updated without mutating snapshots or player-owned fields. */
  private async withCompendiumState(row: typeof inventoryItems.$inferSelect): Promise<InventoryItem> {
    const [item] = await this.withCompendiumStates([row]);
    return item;
  }

  /** Batch-resolve rule entries so list endpoints avoid N+1 SELECTs. */
  private async withCompendiumStates(rows: Array<typeof inventoryItems.$inferSelect>): Promise<InventoryItem[]> {
    const items = rows.map(toDomain);
    const linkedIds = [
      ...new Set(
        items
          .filter((item) => item.compendiumRef && item.compendiumState === 'linked' && item.ruleEntryId != null)
          .map((item) => item.ruleEntryId as number),
      ),
    ];
    if (linkedIds.length === 0) return items;
    const entries = await this.db.select().from(ruleEntries).where(inArray(ruleEntries.id, linkedIds));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const item of items) {
      if (!item.compendiumRef || item.compendiumState !== 'linked' || item.ruleEntryId == null) continue;
      const entry = byId.get(item.ruleEntryId);
      // Campaign-private homebrew is only a valid linked source for that campaign.
      const inScope = entry != null && (entry.campaignId == null || entry.campaignId === item.campaignId);
      if (!inScope || computeRuleEntryContentHash(entry) !== item.compendiumRef.contentHash) {
        item.compendiumState = 'linked_updated';
      }
    }
    return items;
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
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Who may write an item (controller has already required player+):
   *  - dm: anything, including items whose character has been deleted
   *  - player: the party stash, or items on a live character they own
   * Returns the resolved character row when relevant, or null for party/deleted owners.
   */
  private async assertCanWriteOwner(
    ownerType: 'party' | 'character',
    characterId: number | null,
    campaignId: number,
    user: RequestUser,
    role: Role,
  ): Promise<{ id: number; ownerUserId: string | null } | null> {
    if (ownerType === 'party') {
      if (characterId != null) throw new BadRequestException('Party items cannot have a characterId');
      return null;
    }
    const character = await this.validateOwner(ownerType, characterId, campaignId);
    if (role === 'dm') return character;
    if (!character) throw new BadRequestException(`characterId ${characterId} does not exist in this campaign`);
    if (character.ownerUserId === user.id) return character;
    throw new ForbiddenException('Only dm or the owning player may manage this character\'s items');
  }

  async create(campaignId: number, input: InventoryItemCreateInput, user: RequestUser, role: Role): Promise<InventoryItem> {
    const ownerType = input.ownerType ?? 'party';
    const characterId = input.characterId ?? null;
    const character = await this.assertCanWriteOwner(ownerType, characterId, campaignId, user, role);
    if (ownerType === 'character' && character == null) {
      throw new BadRequestException(`characterId ${characterId} does not exist in this campaign`);
    }

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

  async acquireFromCompendium(campaignId: number, input: InventoryFromCompendiumInput, user: RequestUser, role: Role): Promise<InventoryItem> {
    const ownerType = input.ownerType ?? 'party';
    const characterId = input.characterId ?? null;
    const character = await this.assertCanWriteOwner(ownerType, characterId, campaignId, user, role);
    if (ownerType === 'character' && character == null) {
      throw new BadRequestException(`characterId ${characterId} does not exist in this campaign`);
    }
    // Accept global pack entries or this campaign's private homebrew only — never
    // leak another campaign's homebrew body/data into a CompendiumSnapshot.
    const [entry] = await this.db
      .select()
      .from(ruleEntries)
      .where(and(eq(ruleEntries.id, input.ruleEntryId), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, campaignId))))
      .limit(1);
    if (!entry || entry.type !== 'item') throw new BadRequestException('ruleEntryId must identify an installed item entry');
    const [pack] = await this.db.select().from(rulePacks).where(eq(rulePacks.id, entry.packId)).limit(1);
    if (!pack) throw new NotFoundException('The rule entry pack is not installed');
    const ref = buildCompendiumRef(entry, pack);
    const snapshot = sanitizeCompendiumSnapshot(buildCompendiumSnapshot(entry));
    if (!snapshot) throw new BadRequestException('ruleEntryId must identify a play-safe item entry');
    const fingerprint = JSON.stringify({ campaignId, ruleEntryId: entry.id, ownerType, characterId, qty: input.qty, notes: input.notes, duplicateMode: input.duplicateMode });
    let row!: typeof inventoryItems.$inferSelect; let replayed = false;
    this.db.transaction((tx) => {
      if (input.idempotencyKey) {
        const [prior] = tx.select().from(inventoryQtyIdempotency).where(eq(inventoryQtyIdempotency.key, input.idempotencyKey)).limit(1).all();
        if (prior) {
          if (prior.userId !== user.id || prior.fingerprint !== fingerprint) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSE' });
          row = JSON.parse(prior.responseJson) as typeof inventoryItems.$inferSelect;
          replayed = true;
          return;
        }
      }
      const candidates = tx.select().from(inventoryItems).where(and(eq(inventoryItems.campaignId, campaignId), eq(inventoryItems.ownerType, ownerType), characterId == null ? isNull(inventoryItems.characterId) : eq(inventoryItems.characterId, characterId), isNull(inventoryItems.deletedAt))).all();
      const existing = candidates.find((candidate) => {
        const candidateRef = CompendiumRef.safeParse(candidate.compendiumRef ? safeJson(candidate.compendiumRef) : null);
        return candidateRef.success && compendiumRefKey(candidateRef.data) === compendiumRefKey(ref);
      });
      if (existing && input.duplicateMode === 'confirm') throw new ConflictException({ code: 'INVENTORY_COMPENDIUM_DUPLICATE', existing: toDomain(existing) });
      const ts = nowIso();
      if (existing && input.duplicateMode === 'increment') {
        [row] = tx.update(inventoryItems).set({ qty: sql`${inventoryItems.qty} + ${input.qty}`, notes: input.notes ? sql`CASE WHEN ${inventoryItems.notes} = '' THEN ${input.notes} ELSE ${inventoryItems.notes} END` : undefined, updatedAt: ts }).where(eq(inventoryItems.id, existing.id)).returning().all();
      } else {
        [row] = tx.insert(inventoryItems).values({ campaignId, ownerType, characterId, name: entry.name, qty: input.qty, notes: input.notes, iconSlug: entry.iconSlug ?? '', ruleEntryId: entry.id, compendiumRef: JSON.stringify(ref), compendiumSnapshot: JSON.stringify(snapshot), compendiumState: 'linked', createdAt: ts, updatedAt: ts }).returning().all();
      }
      if (input.idempotencyKey) tx.insert(inventoryQtyIdempotency).values({ key: input.idempotencyKey, itemId: row.id, userId: user.id, fingerprint, responseJson: JSON.stringify(row), createdAt: ts }).run();
    });
    if (!replayed) await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'item.acquire_compendium', entityType: 'inventory_item', entityId: row.id, campaignId });
    return this.withCompendiumState(row);
  }

  async refreshCompendium(id: number, user: RequestUser, role: Role): Promise<InventoryItem> {
    const existing = await this.getRowOrThrow(id); await this.assertCanWriteOwner(existing.ownerType as 'party' | 'character', existing.characterId, existing.campaignId, user, role);
    if (!existing.ruleEntryId) throw new BadRequestException('This item is detached from the compendium');
    const [entry] = await this.db
      .select()
      .from(ruleEntries)
      .where(and(eq(ruleEntries.id, existing.ruleEntryId), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, existing.campaignId))))
      .limit(1);
    if (!entry || entry.type !== 'item') throw new NotFoundException('The linked source item is unavailable');
    const [pack] = await this.db.select().from(rulePacks).where(eq(rulePacks.id, entry.packId)).limit(1); if (!pack) throw new NotFoundException('The linked source pack is unavailable');
    const snapshot = sanitizeCompendiumSnapshot(buildCompendiumSnapshot(entry));
    if (!snapshot) throw new BadRequestException('The linked source item is not play-safe');
    const [row] = await this.db.update(inventoryItems).set({ compendiumRef: JSON.stringify(buildCompendiumRef(entry, pack)), compendiumSnapshot: JSON.stringify(snapshot), compendiumState: 'linked', updatedAt: nowIso() }).where(eq(inventoryItems.id, id)).returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'item.refresh_compendium',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return this.withCompendiumState(row);
  }

  async setCompendiumState(id: number, state: 'overridden' | 'detached', user: RequestUser, role: Role): Promise<InventoryItem> {
    const existing = await this.getRowOrThrow(id); await this.assertCanWriteOwner(existing.ownerType as 'party' | 'character', existing.characterId, existing.campaignId, user, role);
    if (!existing.compendiumSnapshot) throw new BadRequestException('This item has no compendium snapshot');
    const [row] = await this.db.update(inventoryItems).set({ compendiumState: state, ruleEntryId: state === 'detached' ? null : existing.ruleEntryId, updatedAt: nowIso() }).where(eq(inventoryItems.id, id)).returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'item.compendium_state',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
      detail: state,
    });
    return this.withCompendiumState(row);
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
      const destCharacter = await this.assertCanWriteOwner(finalOwnerType, finalCharacterId, existing.campaignId, user, role);
      if (finalOwnerType === 'character' && destCharacter == null) {
        throw new BadRequestException(`characterId ${finalCharacterId} does not exist in this campaign`);
      }
    }

    // Issue #1326: equip/unequip transition, validated against the FINAL owner (post-move).
    // Field-level checks run here; the slot-conflict check runs inside the transaction
    // below (against the freshly-read row) so two concurrent equips into the same slot
    // serialize through SQLite rather than racing on a pre-transaction snapshot.
    //
    // Review (Codex/Devin): a move to a DIFFERENT owner — party OR another character —
    // must never silently carry the OLD equipped=true forward. Left unguarded, that
    // either raises a bogus 409 against a recipient who never asked to equip anything,
    // or silently arms them with an action they never chose. So on ANY ownership change
    // the item lands UNEQUIPPED unless this SAME request explicitly asks to equip it
    // (equipped:true + equipSlot) for the new owner — never inherited from the old state.
    const equipTouched = input.equipped !== undefined || input.equipSlot !== undefined;
    let nextEquipped = moved ? input.equipped === true : (input.equipped !== undefined ? input.equipped : existing.equipped);
    let nextEquipSlot: string | null = input.equipSlot !== undefined ? input.equipSlot : moved ? null : existing.equipSlot;
    if (finalOwnerType !== 'character') {
      // An explicit request to equip a party-stash item is rejected outright — it is
      // never valid, whether the item was already party-owned or is moving there in
      // this same request.
      if (input.equipped === true) {
        throw new BadRequestException('Only character-owned items may be equipped');
      }
      // Otherwise: moving an item OFF a character (or an already party-owned item)
      // auto-unequips it rather than leaving a dangling equip/slot state — a party
      // item can never legitimately be equipped=true.
      nextEquipped = false;
      nextEquipSlot = null;
    } else if (nextEquipped) {
      const trimmedSlot = typeof nextEquipSlot === 'string' ? nextEquipSlot.trim() : '';
      if (!trimmedSlot) {
        throw new BadRequestException('equipSlot is required to equip an item');
      }
      nextEquipSlot = trimmedSlot;
    } else {
      nextEquipSlot = null;
    }
    const equipWillChange = equipTouched || moved;

    // Issue #782: quantity writes — atomic delta (preferred) or absolute CAS set.
    const hasQtyDelta = input.qtyDelta !== undefined;
    const hasQtySet = input.qty !== undefined;
    if (hasQtyDelta && hasQtySet) {
      throw new BadRequestException('Provide qty or qtyDelta, not both');
    }
    if (hasQtyDelta && !input.idempotencyKey) {
      throw new BadRequestException('qtyDelta requires idempotencyKey');
    }
    // Absolute qty is inherently racy against concurrent +/- — require CAS, mirroring
    // treasury { set } (#582). Use qtyDelta for increments/decrements.
    if (hasQtySet && input.expectedUpdatedAt === undefined) {
      throw new BadRequestException(
        'An absolute qty requires expectedUpdatedAt (CAS); use qtyDelta for +/-',
      );
    }

    const qtyTouch = hasQtyDelta || hasQtySet;
    const idempotencyKey = qtyTouch ? input.idempotencyKey : undefined;
    const fingerprint = qtyTouch ? qtyFingerprint(input) : undefined;

    // Auth checks above may await; the write itself must be one synchronous
    // better-sqlite3 transaction so concurrent qtyDelta compose and idempotent
    // retries observe a single committed apply (issue #782).
    let committed!: InventoryItem;
    let replayed = false;
    let qtyConflict: InventoryItem | null = null;

    try {
      this.db.transaction((tx) => {
        if (idempotencyKey && fingerprint) {
          // Opportunistic TTL prune (issue #782): drop rows older than the replay
          // window so the table cannot grow unbounded. Indexed on created_at.
          const cutoff = new Date(Date.now() - INVENTORY_QTY_IDEMPOTENCY_TTL_MS).toISOString();
          tx.delete(inventoryQtyIdempotency).where(lt(inventoryQtyIdempotency.createdAt, cutoff)).run();

          const [prior] = tx
            .select()
            .from(inventoryQtyIdempotency)
            .where(eq(inventoryQtyIdempotency.key, idempotencyKey))
            .limit(1)
            .all();
          if (prior) {
            if (prior.itemId !== id || prior.fingerprint !== fingerprint || prior.userId !== user.id) {
              throw new ConflictException({
                code: 'IDEMPOTENCY_KEY_REUSE',
                message: 'idempotencyKey was already used for a different inventory quantity action',
              });
            }
            committed = JSON.parse(prior.responseJson) as InventoryItem;
            replayed = true;
            return;
          }
        }

        const [fresh] = tx
          .select()
          .from(inventoryItems)
          .where(and(eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt)))
          .limit(1)
          .all();
        if (!fresh) throw new NotFoundException(`Item ${id} not found`);

        const ts = nowIso();
        const update: Record<string, unknown> = { updatedAt: ts };
        if (input.name !== undefined) update.name = input.name;
        if (input.notes !== undefined) update.notes = input.notes;
        if (input.iconSlug !== undefined) update.iconSlug = input.iconSlug;
        if (moved) {
          update.ownerType = finalOwnerType;
          update.characterId = finalOwnerType === 'party' ? null : finalCharacterId;
        }
        if (input.equippedAction !== undefined) {
          update.equippedAction = input.equippedAction ? JSON.stringify(input.equippedAction) : null;
        }
        if (equipWillChange) {
          if (nextEquipped) {
            // Slot conflict (issue #1326): reject a second equipped item claiming the same
            // (character, slot) pair rather than silently displacing the incumbent. Read
            // inside this transaction so two concurrent equips into the same slot serialize.
            const conflict = tx
              .select({ id: inventoryItems.id, name: inventoryItems.name })
              .from(inventoryItems)
              .where(
                and(
                  eq(inventoryItems.characterId, finalCharacterId as number),
                  eq(inventoryItems.campaignId, existing.campaignId),
                  eq(inventoryItems.equipped, true),
                  isNull(inventoryItems.deletedAt),
                  sql`lower(${inventoryItems.equipSlot}) = lower(${nextEquipSlot})`,
                  ne(inventoryItems.id, id),
                ),
              )
              .limit(1)
              .all();
            if (conflict.length > 0) {
              throw new ConflictException({
                code: 'INVENTORY_SLOT_CONFLICT',
                message: `Slot "${nextEquipSlot}" is already occupied by "${conflict[0].name}" on this character — unequip it first.`,
              });
            }
          }
          update.equipped = nextEquipped;
          update.equipSlot = nextEquipSlot;
        }

        if (hasQtyDelta) {
          // Atomic `qty = qty + ?` — SQLite resolves the RHS column to the live row
          // inside this statement, so two concurrent increments from qty=1 both land
          // (1→2 and 2→3) instead of both writing absolute 2 from a stale snapshot.
          update.qty = sql`${inventoryItems.qty} + ${input.qtyDelta!}`;
        } else if (hasQtySet) {
          update.qty = input.qty!;
        }

        const casCondition =
          hasQtySet && input.expectedUpdatedAt !== undefined
            ? sql`${inventoryItems.updatedAt} = ${input.expectedUpdatedAt}`
            : undefined;

        const updateConditions = [eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt)];
        if (casCondition !== undefined) updateConditions.push(casCondition);

        const updated = tx
          .update(inventoryItems)
          .set(update)
          .where(and(...updateConditions))
          .returning()
          .all();

        if (updated.length === 0) {
          // CAS mismatch on absolute qty: another client wrote between the snapshot
          // and this write. Stash live values for the 409 body, then roll back.
          qtyConflict = toDomain(fresh);
          throw new InventoryQtyConflictMarker();
        }

        const next = updated[0];
        if (hasQtyDelta && next.qty < 0) {
          throw new BadRequestException(
            `Quantity cannot go negative (${fresh.qty} ${input.qtyDelta! >= 0 ? '+' : ''}${input.qtyDelta})`,
          );
        }

        committed = toDomain(next);

        if (idempotencyKey && fingerprint) {
          try {
            tx.insert(inventoryQtyIdempotency)
              .values({
                key: idempotencyKey,
                itemId: id,
                userId: user.id,
                fingerprint,
                // Persist the domain JSON the client already expects from PATCH.
                responseJson: JSON.stringify(committed),
                createdAt: ts,
              })
              .run();
          } catch (insertErr) {
            // Rare: another racer committed the same key between our SELECT and
            // INSERT. Roll back this apply and return their committed response
            // (or 409 if the fingerprint differs).
            const message = insertErr instanceof Error ? insertErr.message : String(insertErr);
            if (!/UNIQUE|unique/i.test(message)) throw insertErr;
            throw new InventoryIdempotencyRaceMarker(idempotencyKey, fingerprint, id, user.id);
          }
        }
      });
    } catch (err) {
      if (err instanceof InventoryQtyConflictMarker) {
        throw new ConflictException({
          code: 'INVENTORY_QTY_CONFLICT',
          message: 'The item quantity changed since you last loaded it.',
          current: qtyConflict,
        });
      }
      if (err instanceof InventoryIdempotencyRaceMarker) {
        const [prior] = await this.db
          .select()
          .from(inventoryQtyIdempotency)
          .where(eq(inventoryQtyIdempotency.key, err.key))
          .limit(1);
        if (
          prior &&
          prior.itemId === err.itemId &&
          prior.fingerprint === err.fingerprint &&
          prior.userId === err.userId
        ) {
          return JSON.parse(prior.responseJson) as InventoryItem;
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSE',
          message: 'idempotencyKey was already used for a different inventory quantity action',
        });
      }
      throw err;
    }

    // Idempotent replay returns the first committed response without re-auditing.
    if (replayed) return committed;

    // Issue #1326: record the equip transition (if any) alongside the existing qty detail
    // rather than a separate audit action — this is still one `item.update` write.
    const equipChanged = existing.equipped !== committed.equipped || existing.equipSlot !== committed.equipSlot;
    const hasDetail = qtyTouch || equipChanged;

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'item.update',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
      detail: hasDetail
        ? JSON.stringify({
            actor: { id: user.id, name: user.name, role },
            ...(qtyTouch
              ? {
                  kind: hasQtyDelta ? 'delta' : 'set',
                  ...(hasQtyDelta ? { qtyDelta: input.qtyDelta } : { qty: input.qty }),
                  after: committed.qty,
                  ...(input.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
                  ...(idempotencyKey ? { idempotencyKey } : {}),
                }
              : {}),
            ...(equipChanged
              ? {
                  equip: {
                    from: { equipped: existing.equipped, equipSlot: existing.equipSlot },
                    to: { equipped: committed.equipped, equipSlot: committed.equipSlot },
                  },
                }
              : {}),
          })
        : undefined,
    });
    return committed;
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<InventoryItem> {
    const existing = await this.getRowOrThrow(id);
    await this.assertCanWriteOwner(
      existing.ownerType as 'party' | 'character',
      existing.characterId,
      existing.campaignId,
      user,
      role,
    );

    const ts = nowIso();
    const actor = auditActor(user);
    const snapshot = {
      name: existing.name,
      qty: existing.qty,
      notes: existing.notes,
      iconSlug: existing.iconSlug,
      ownerType: existing.ownerType,
      characterId: existing.characterId,
      equipped: existing.equipped,
      equipSlot: existing.equipSlot,
    };

    const [row] = await this.db
      .update(inventoryItems)
      // Issue #1326 review (Codex/Devin): trashing an equipped item must clear its equip
      // state, not merely tombstone it. Left untouched, a trashed "worn" row could sit
      // behind a replacement that took its slot, and restore() puts the item back with NO
      // owner/slot validation of its own — so an equipped-and-trashed item reappearing
      // unequipped (frees the slot up front) is what keeps every invariant `update()`
      // enforces (character-only equip, one equipped item per slot) true across a
      // trash/restore round trip without restore() having to re-run that validation.
      .set({ deletedAt: ts, deletedBy: actor, updatedAt: ts, equipped: false, equipSlot: null })
      .where(and(eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt)))
      .returning();
    if (!row) {
      // Another request already tombstoned this item — treat as already deleted
      // rather than overwriting the existing tombstone or logging a duplicate.
      throw new ConflictException('Item is already deleted');
    }

    const domain = toDomain(row);
    await this.audit.log({
      actor,
      actorRole: role,
      action: 'item.delete',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify({ snapshot }),
    });

    return domain;
  }

  /**
   * Restore a soft-deleted inventory item to its original owner. If the original
   * character no longer exists in the campaign, the item falls back to the party
   * stash so restoration always succeeds. Already-restored items are returned
   * as-is without re-auditing, making the operation idempotent.
   */
  async restore(id: number, user: RequestUser, role: Role): Promise<InventoryItem> {
    const existing = await this.getRowOrThrow(id, { includeDeleted: true });

    const actor = auditActor(user);
    await this.assertCanRestore(existing, user, role, actor);

    if (!existing.deletedAt) {
      return toDomain(existing);
    }

    // Verify the original owner still exists; otherwise restore to the party stash.
    let ownerType = existing.ownerType as 'party' | 'character';
    let characterId = existing.characterId;
    let fallback = false;
    if (ownerType === 'character' && characterId != null) {
      const character = await this.validateOwner(ownerType, characterId, existing.campaignId);
      if (!character) {
        ownerType = 'party';
        characterId = null;
        fallback = true;
      }
    }

    const ts = nowIso();
    const [row] = await this.db
      .update(inventoryItems)
      .set({
        ownerType,
        characterId,
        deletedAt: null,
        deletedBy: null,
        updatedAt: ts,
      })
      .where(eq(inventoryItems.id, id))
      .returning();

    const domain = toDomain(row);
    await this.audit.log({
      actor,
      actorRole: role,
      action: 'item.restore',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
      detail: JSON.stringify({
        snapshot: {
          name: existing.name,
          qty: existing.qty,
          notes: existing.notes,
          iconSlug: existing.iconSlug,
          ownerType: existing.ownerType,
          characterId: existing.characterId,
        },
        ...(fallback ? { fallbackToParty: true } : {}),
      }),
    });

    return domain;
  }

  private async assertCanRestore(
    existing: typeof inventoryItems.$inferSelect,
    user: RequestUser,
    role: Role,
    actor: string,
  ): Promise<void> {
    if (role === 'dm') return;
    // The player who deleted it may always undo their own delete.
    if (existing.deletedBy === actor) return;
    // Shared party items are player-writable, so any player may restore them.
    if (existing.ownerType === 'party') return;
    // Character items may be restored by the character's owning player.
    if (existing.ownerType === 'character' && existing.characterId != null) {
      const character = await this.validateOwner(existing.ownerType as 'character', existing.characterId, existing.campaignId);
      if (character && character.ownerUserId === user.id) return;
    }
    throw new ForbiddenException('Only the dm, the deleting player, or the owning player may restore this item');
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
 *
 * Deliberately NOT merged with {@link InventoryQtyConflictMarker}: each CAS path
 * catches a distinct class (`instanceof`) and attaches a different `current` snapshot
 * shape (Treasury vs InventoryItem). A shared generic would save ~6 lines but force a
 * typed payload / dual catch mapping for little gain.
 */
class TreasuryConflictMarker extends Error {
  constructor() {
    super('treasury CAS mismatch');
    this.name = 'TreasuryConflictMarker';
  }
}

/**
 * Internal sentinel for inventory absolute-qty CAS mismatch (issue #782). Same
 * roll-back-then-409 pattern as {@link TreasuryConflictMarker}; kept as a separate
 * class so `instanceof` can discriminate the two CAS flows (see note above).
 */
class InventoryQtyConflictMarker extends Error {
  constructor() {
    super('inventory qty CAS mismatch');
    this.name = 'InventoryQtyConflictMarker';
  }
}

/**
 * Thrown inside the qty transaction when the idempotency-key INSERT loses a
 * UNIQUE race. The outer catch rolls back the duplicate apply and returns the
 * winner's stored response.
 */
class InventoryIdempotencyRaceMarker extends Error {
  constructor(
    readonly key: string,
    readonly fingerprint: string,
    readonly itemId: number,
    readonly userId: string,
  ) {
    super('inventory qty idempotency race');
    this.name = 'InventoryIdempotencyRaceMarker';
  }
}

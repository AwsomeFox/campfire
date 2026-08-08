import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { CharacterAction, CompendiumRef, CompendiumSnapshot, deriveEquippedItemAction, EquippedActionSource, rebuildEditedActionSpec, InventoryFromCompendium, InventoryItem, InventoryItemCreate, InventoryItemUpdate, ruleSystemAdapter, TreasuryPatch } from '@campfire/schema';
import type { HomebrewMechanicsProfile, Treasury, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { fromJsonText } from '../../common/json';
import { campaigns, inventoryItems, inventoryQtyIdempotency, partyTreasury, characters, ruleEntries, rulePacks } from '../../db/schema';
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
 * Issue #1326 review (coordinator) — THE single rule for every write path that can
 * change which character (if any) owns an inventory item: `equipped`, `equipSlot`, and
 * `equippedAction` reset to this "off" triple together, atomically, whenever ownership
 * changes — never a partial clear. Three separate earlier review rounds on this PR each
 * found a DIFFERENT path clearing only equipped/equipSlot and leaving equippedAction
 * behind: bulk `move_inventory_owner`, clone/import's party fallback, and (this one)
 * `InventoryService.update()`'s own move branch. An item left "unworn but pre-armed" is
 * a state normal play can never produce on its own, and — because `equippedAction`
 * visibility is keyed to `ownerType === 'character'` (see `redactEquippedActions`) — it
 * is also a state where a previously-redacted, private character action silently
 * becomes readable (by a new character's owner, or by every campaign member once the
 * item reaches the party stash) the moment ownership changes, with no new secrecy
 * decision made by anyone.
 *
 * Every owner-changing path uses this constant as the base "cleared" state, only
 * overriding a field the SAME write explicitly re-establishes for the new owner:
 *  - `InventoryService.update()`'s move branch (a caller may re-equip in the same PATCH);
 *  - the bulk `move_inventory_owner` write in `CampaignLibraryService` (unconditional —
 *    that request shape carries no equip fields of its own);
 *  - that same bulk operation's `undoBulk()` restore (conditioned on the slot-safety
 *    check already enforced there);
 *  - campaign clone and campaign import's party-fallback branch in `CampaignsService`
 *    (the source character wasn't copied/mapped, so there is no new owner to ask).
 */
export const CLEARED_EQUIP_STATE: {
  readonly equipped: false;
  readonly equipSlot: null;
  readonly equippedAction: null;
  readonly equippedActionSource: null;
} = {
  equipped: false,
  equipSlot: null,
  equippedAction: null,
  // Issue #2097: the provenance travels with the action it describes. Clearing the action
  // but keeping `equippedActionSource` would leave a row claiming an origin for something
  // that no longer exists, and — worse — a stale 'manual' would then block the new owner's
  // item from ever deriving one.
  equippedActionSource: null,
};

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
  // Issue #1901 rework (review: chatgpt-codex-connector P2): `displaceEquipped` changes
  // what a combined qty+equip write is AUTHORIZED to do (unequip another item) without
  // changing qty/equip/equipSlot/equippedAction themselves, so it must be part of the
  // fingerprint too — otherwise replaying the same idempotencyKey with the same
  // quantity/equip values but a flipped `displaceEquipped` would silently return the
  // earlier response instead of raising IDEMPOTENCY_KEY_REUSE for a payload that
  // authorizes something the original request did not.
  if (input.displaceEquipped !== undefined) {
    rest.displaceEquipped = input.displaceEquipped;
  }
  // Issue #1901 review (chatgpt-codex-connector P2 + devin-ai-integration): same rule as
  // `displaceEquipped` above — `expectedConflictingItemId` changes what the write is
  // AUTHORIZED to do (which incumbent it's allowed to displace), so it must be in the
  // fingerprint too. Without this, replaying the same idempotencyKey with identical
  // qty/equip fields but a DIFFERENT confirmed incumbent would silently replay the earlier
  // response instead of re-running the CAS check against the new confirmation.
  if (input.expectedConflictingItemId !== undefined) {
    rest.expectedConflictingItemId = input.expectedConflictingItemId;
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
    equippedActionSource: EquippedActionSource.safeParse(row.equippedActionSource).success
      ? EquippedActionSource.parse(row.equippedActionSource)
      : null,
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
  /**
   * Build the action an item grants while equipped, from its compendium data (issue #2097).
   * Returns null whenever nothing can be derived — not a weapon, no compendium provenance,
   * or a character that has vanished — and never throws: this runs on the equip path, and a
   * malformed compendium row must not be able to fail the equip itself.
   *
   * Reads the LIVE rule entry's data when the item is still linked, falling back to the
   * snapshot captured at acquire time. Both are the same shape; the snapshot is what a
   * detached or since-uninstalled item still has, and using it keeps derivation working
   * for an item whose pack was removed.
   */
  private async deriveActionForEquip(
    existing: typeof inventoryItems.$inferSelect,
    characterId: number,
    /**
     * The item's name AFTER this request lands. Review (chatgpt-codex-connector P2): one PATCH
     * can rename and equip together — reachable from REST and MCP alike — and reading
     * `existing.name` there produced a row with the new name granting an action titled with
     * the old one.
     */
    finalName: string,
  ): Promise<CharacterAction | null> {
    try {
      const character = await this.db
        .select({ stats: characters.stats, level: characters.level })
        .from(characters)
        .where(eq(characters.id, characterId))
        .get();
      if (!character) return null;

      // Review (chatgpt-codex-connector P2): the SNAPSHOT wins, not the live rule entry.
      // The snapshot is the revision this campaign actually accepted at acquire time; when
      // an installed pack updates the entry upstream, `withCompendiumStates` reports the
      // item as `linked_updated` WITHOUT persisting it, and adopting that revision is what
      // the explicit refresh endpoint is for. Reading the live row first would have equipped
      // an item into an attack derived from a revision nobody accepted — while its name and
      // play-safe snapshot still showed the old one. The live entry is the fallback for an
      // item that has no snapshot at all.
      let data: unknown = null;
      if (existing.compendiumSnapshot) {
        const snapshot = sanitizeCompendiumSnapshot(safeJson(existing.compendiumSnapshot));
        if (snapshot?.dataJson) data = safeJson(snapshot.dataJson);
      }
      if (data == null && existing.ruleEntryId != null) {
        const entry = await this.db
          .select({ dataJson: ruleEntries.dataJson })
          .from(ruleEntries)
          .where(eq(ruleEntries.id, existing.ruleEntryId))
          .get();
        if (entry?.dataJson) data = safeJson(entry.dataJson);
      }
      if (data == null) return null;

      const campaign = await this.db
        .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
        .from(campaigns)
        .where(eq(campaigns.id, existing.campaignId))
        .get();
      const adapter = ruleSystemAdapter(
        campaign?.ruleSystem ?? '',
        fromJsonText<HomebrewMechanicsProfile | null>(campaign?.customMechanicsProfile, null),
      );

      return deriveEquippedItemAction({
        itemName: finalName,
        data,
        character: { stats: fromJsonText<Record<string, number>>(character.stats, {}), level: character.level },
        adapter,
      });
    } catch {
      // Equipping is the user's action; deriving is a convenience on top of it. A failure
      // here leaves the item equipped with no granted action — recoverable by hand — rather
      // than failing a write the caller did ask for.
      return null;
    }
  }

  /** Fail-closed redaction of `equippedAction` for a single, already-resolved owner. */
  private redactEquippedActionForOwner(
    item: InventoryItem,
    user: RequestUser,
    role: Role,
    ownerUserId?: string | null,
  ): InventoryItem {
    if (role === 'dm') return item;
    if (item.equippedAction == null) return item;
    // Issue #2097: `equippedActionSource` is nulled alongside the action it describes. A
    // surviving 'derived'/'manual' on a redacted row would announce that this character HAS
    // a granted action — the exact fact the redaction exists to withhold — and would do it
    // for free, without the reader needing to see a single number.
    if (item.ownerType !== 'character' || item.characterId == null) {
      return { ...item, equippedAction: null, equippedActionSource: null };
    }
    if (ownerUserId != null && ownerUserId === user.id) return item;
    return { ...item, equippedAction: null, equippedActionSource: null };
  }

  private async redactEquippedActions(items: InventoryItem[], user: RequestUser, role: Role): Promise<InventoryItem[]> {
    if (role === 'dm') return items;
    const characterIds = [
      ...new Set(
        items
          .filter((item) => item.ownerType === 'character' && item.characterId != null && item.equippedAction != null)
          .map((item) => item.characterId as number),
      ),
    ];
    const owners =
      characterIds.length > 0
        ? await this.db
            .select({ id: characters.id, ownerUserId: characters.ownerUserId })
            .from(characters)
            .where(inArray(characters.id, characterIds))
        : [];
    const ownerById = new Map(owners.map((owner) => [owner.id, owner.ownerUserId]));
    return items.map((item) => {
      if (item.equippedAction == null) return item;
      // Party-stash items should never carry an equippedAction, and a character-owned item
      // without a resolvable owner is treated as fail-closed rather than fail-open.
      // `equippedActionSource` goes with it — see redactEquippedActionForOwner.
      if (item.ownerType !== 'character' || item.characterId == null) {
        return { ...item, equippedAction: null, equippedActionSource: null };
      }
      if (ownerById.get(item.characterId) === user.id) return item;
      return { ...item, equippedAction: null, equippedActionSource: null };
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
    const created = toDomain(row);
    return (await this.redactEquippedActions([created], user, role))[0];
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
    const duplicateOwnerUserId =
      ownerType === 'character' && characterId != null
        ? (
            await this.db
              .select({ ownerUserId: characters.ownerUserId })
              .from(characters)
              .where(eq(characters.id, characterId))
              .get()
          )?.ownerUserId
        : undefined;
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
      if (existing && input.duplicateMode === 'confirm')
        throw new ConflictException({
          code: 'INVENTORY_COMPENDIUM_DUPLICATE',
          existing: this.redactEquippedActionForOwner(toDomain(existing), user, role, duplicateOwnerUserId),
        });
      const ts = nowIso();
      if (existing && input.duplicateMode === 'increment') {
        [row] = tx.update(inventoryItems).set({ qty: sql`${inventoryItems.qty} + ${input.qty}`, notes: input.notes ? sql`CASE WHEN ${inventoryItems.notes} = '' THEN ${input.notes} ELSE ${inventoryItems.notes} END` : undefined, updatedAt: ts }).where(eq(inventoryItems.id, existing.id)).returning().all();
      } else {
        [row] = tx.insert(inventoryItems).values({ campaignId, ownerType, characterId, name: entry.name, qty: input.qty, notes: input.notes, iconSlug: entry.iconSlug ?? '', ruleEntryId: entry.id, compendiumRef: JSON.stringify(ref), compendiumSnapshot: JSON.stringify(snapshot), compendiumState: 'linked', createdAt: ts, updatedAt: ts }).returning().all();
      }
      if (input.idempotencyKey) tx.insert(inventoryQtyIdempotency).values({ key: input.idempotencyKey, itemId: row.id, userId: user.id, fingerprint, responseJson: JSON.stringify(row), createdAt: ts }).run();
    });
    if (!replayed) await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'item.acquire_compendium', entityType: 'inventory_item', entityId: row.id, campaignId });
    const acquired = await this.withCompendiumState(row);
    return (await this.redactEquippedActions([acquired], user, role))[0];
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
    const refreshed = await this.withCompendiumState(row);
    return (await this.redactEquippedActions([refreshed], user, role))[0];
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
    const stateItem = await this.withCompendiumState(row);
    return (await this.redactEquippedActions([stateItem], user, role))[0];
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
      if (input.equippedAction != null) {
        throw new BadRequestException('Only character-owned items may carry an equipped action');
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

    // Resolve the current and final owner's user ids up-front so the transaction can
    // redact `equippedAction` for idempotent/live responses and 409 bodies without
    // issuing an async query inside the synchronous better-sqlite3 transaction.
    const existingOwnerUserId =
      existing.ownerType === 'character' && existing.characterId != null
        ? (
            await this.db
              .select({ ownerUserId: characters.ownerUserId })
              .from(characters)
              .where(eq(characters.id, existing.characterId))
              .get()
          )?.ownerUserId
        : undefined;
    const finalOwnerUserId =
      finalOwnerType === 'character'
        ? (
            await this.db
              .select({ ownerUserId: characters.ownerUserId })
              .from(characters)
              .where(eq(characters.id, finalCharacterId as number))
              .get()
          )?.ownerUserId
        : undefined;

    // Issue #2097: when this PATCH equips a compendium-linked item that has no action yet,
    // build one from its compendium data so an equipped weapon is actually usable in a
    // fight. Resolved HERE, before the transaction, for the same reason the owner ids above
    // are: it needs the owning character's stats/level and the campaign's rule adapter, and
    // the write below is a synchronous better-sqlite3 transaction that cannot await.
    //
    // Equip time rather than acquire time, deliberately: acquire may target the party stash,
    // where an action would be both meaningless and a secrecy problem (a stash item's action
    // is never redaction-checked), and only at equip time is the wielder — and therefore the
    // ability modifiers the attack depends on — known at all.
    //
    // Review (chatgpt-codex-connector P2): a `derived` action is REGENERATED on a later
    // equip, not preserved. It is a snapshot of the wielder's ability modifier and
    // proficiency at the moment it was built, so a character who levels up (or whose STR
    // changes) would otherwise keep attacking with the old numbers forever — the derivation
    // is only honest if it tracks the character it was derived from. `manual` is what stays
    // untouched; that is the promise, and it is the one the editor depends on.
    //
    // `moved` counts as "no action yet" even when the row currently has one: the
    // ownership-change rule (see CLEARED_EQUIP_STATE) discards the old owner's action
    // unconditionally, because it was private to them. Once it is gone there is nothing to
    // overwrite, and a character who hands their sword to someone who equips it should end
    // up in the same state as one who acquired it themselves — not holding an equipped
    // weapon that grants nothing.
    //
    // Review (chatgpt-codex-connector P2, devin): gated on `equipWillChange`, NOT on the
    // final `nextEquipped` state. `nextEquipped` falls back to `existing.equipped` for a
    // request that touches neither equip field, so without this an unrelated PATCH — a
    // qtyDelta, a notes edit — against an already-equipped item would derive an action.
    // That silently undid the Remove-action button (the documented "delete the action,
    // re-equip" reset), and did it without emitting the `character.updated` invalidation
    // that keeps open encounter cards honest, since no equip field actually changed.
    // Resolved up-front for the same reason as the owner ids: the write below is a synchronous
    // better-sqlite3 transaction, and `rebuildEditedActionSpec` needs the campaign's system.
    const campaignRuleSystem =
      input.equippedAction
        ? (
            await this.db
              .select({ ruleSystem: campaigns.ruleSystem })
              .from(campaigns)
              .where(eq(campaigns.id, existing.campaignId))
              .get()
          )?.ruleSystem ?? ''
        : '';

    // Review (chatgpt-codex-connector P2): "should we derive?" is tracked separately from
    // "what did it produce?". A regeneration that yields NOTHING — the accepted snapshot no
    // longer identifies the item as a weapon, say — has to CLEAR the previous derived action
    // rather than leave it standing, or the item goes on granting an attack built from source
    // data that no longer says so. A falsy result used to just skip the branch.
    const shouldDeriveOnEquip =
      equipWillChange &&
      nextEquipped &&
      finalOwnerType === 'character' &&
      input.equippedAction === undefined &&
      (moved || !existing.equippedAction || existing.equippedActionSource === EquippedActionSource.enum.derived);
    const derivedOnEquip = shouldDeriveOnEquip
      ? await this.deriveActionForEquip(existing, finalCharacterId as number, input.name ?? existing.name)
      : null;

    // Auth checks above may await; the write itself must be one synchronous
    // better-sqlite3 transaction so concurrent qtyDelta compose and idempotent
    // retries observe a single committed apply (issue #782).
    let committed!: InventoryItem;
    let replayed = false;
    let qtyConflict: InventoryItem | null = null;
    // Issue #1901 rework (review: devin-ai-integration + chatgpt-codex-connector P2 on
    // PR #1951): populated when `input.displaceEquipped` unequips a slot-conflicting
    // incumbent as part of THIS transaction — audited once the transaction commits (see
    // below). At most one entry (this item has at most one slot conflict), but an array
    // sidesteps TypeScript narrowing a `T | null` local reassigned only inside the
    // transaction closure down to `null` at every read site outside it.
    const displacedIncumbents: Array<{ id: number; name: string; equipSlot: string | null }> = [];

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
        // Issue #1901 review (chatgpt-codex-connector P1) — time-of-check/time-of-use.
        // `existing` and `assertCanWriteOwner` both ran BEFORE this transaction opened (they
        // await, and better-sqlite3 transactions must be synchronous). If a concurrent
        // request moved this item to a DIFFERENT owner in that window, the authorization we
        // just performed was checked against an owner that is no longer current — proceeding
        // would let this write (equip, displaceEquipped, a move) cross a permission boundary
        // the SERVER is supposed to enforce, not merely observe (AGENTS.md). This is sharpest
        // for `displaceEquipped`: without this guard, the slot-conflict query below still runs
        // against the STALE `finalCharacterId`, and the final update targets this item BY ID
        // ALONE — so a caller authorized against character A could end up equipping (and
        // displacing an incumbent for) an item that fresh() shows now belongs to character B.
        // Fail closed on an owner mismatch rather than silently retargeting the write at
        // whatever the current owner happens to be — a lost update surfaced as a 409 is
        // correct here; a silent retarget is not.
        //
        // Review (devin-ai-integration): scoped to when the pre-transaction owner actually
        // FEEDS the write — an equip transition (`equipWillChange`, since the slot-conflict
        // query below is built from the pre-transaction `finalCharacterId`), a move (`moved`,
        // computed from the same stale snapshot), or any non-DM caller (whose
        // `assertCanWriteOwner` result WAS owner-derived — the round-2 character-owner check
        // right below already exempts DM callers the same way). A bare qty/name/notes/iconSlug
        // edit from the DM — who is authorized for every character's items regardless of
        // owner, per `assertCanWriteOwner`'s `role === 'dm'` early return — never depended on
        // this item's owner at all, so it must not 409 just because someone else picked the
        // item up in the same window; a retry would only succeed unchanged.
        if ((equipWillChange || moved || role !== 'dm') && (fresh.ownerType !== existing.ownerType || fresh.characterId !== existing.characterId)) {
          throw new ConflictException({
            code: 'INVENTORY_OWNER_CHANGED',
            message: `Item ${id}'s owner changed after this request was authorized — refetch and retry.`,
          });
        }
        // Issue #1901 review (chatgpt-codex-connector P1, round 2): the check above
        // re-validates the ITEM's owner — but `assertCanWriteOwner` for a non-DM caller
        // also depended on the CHARACTER's `ownerUserId` matching `user.id`, both for the
        // character the item currently lives on (existing.characterId) and, on a move, for
        // the destination character (finalCharacterId). Neither of those is touched by the
        // check above: if the DM reassigns the SAME character to a different player between
        // `assertCanWriteOwner` and this transaction, the item's own ownerType/characterId
        // are unchanged, so that check alone would pass while the authorization it stood on
        // no longer holds. Re-read both characters' `ownerUserId` fresh, inside this same
        // transaction, and fail closed on any mismatch — this is every identity a non-DM
        // caller's authorization depended on, re-validated together, not just the item's.
        // DM callers are exempt: `assertCanWriteOwner` never checked ownerUserId for them.
        if (role !== 'dm') {
          if (existing.ownerType === 'character' && existing.characterId != null) {
            const currentCharacterOwner = tx
              .select({ ownerUserId: characters.ownerUserId })
              .from(characters)
              .where(eq(characters.id, existing.characterId))
              .get();
            if (!currentCharacterOwner || currentCharacterOwner.ownerUserId !== user.id) {
              throw new ConflictException({
                code: 'INVENTORY_OWNER_CHANGED',
                message: `The character owning item ${id} changed hands after this request was authorized — refetch and retry.`,
              });
            }
          }
          if (moved && finalOwnerType === 'character' && finalCharacterId != null) {
            const destinationCharacterOwner = tx
              .select({ ownerUserId: characters.ownerUserId })
              .from(characters)
              .where(eq(characters.id, finalCharacterId))
              .get();
            if (!destinationCharacterOwner || destinationCharacterOwner.ownerUserId !== user.id) {
              throw new ConflictException({
                code: 'INVENTORY_OWNER_CHANGED',
                message: `Destination character ${finalCharacterId} changed hands after this request was authorized — refetch and retry.`,
              });
            }
          }
        }

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
          // Review (chatgpt-codex-connector P1, Copilot): an authored action's structured
          // `spec` is what the resolver ROLLS; `toHit`/`damage` are only what it shows. A
          // caller that edits the numbers while carrying the old spec through — exactly what
          // the web editor's round-trip did — would display the correction and keep rolling
          // the original. Rebuilt here rather than in the web app so the MCP write path gets
          // the same guarantee. A caller supplying its own spec is trusted and untouched.
          const authored = input.equippedAction ? rebuildEditedActionSpec(input.equippedAction, campaignRuleSystem) : null;
          update.equippedAction = authored ? JSON.stringify(authored) : null;
          // Issue #2097: ANY caller-supplied action is a human's, so the row becomes
          // 'manual' and derivation will never regenerate over it again — that promise is
          // what makes the editor safe to use. Clearing the action clears the provenance
          // with it (nothing left to describe), which also re-opens the row to derivation:
          // "delete the action, re-equip" is the deliberate way back to a fresh derivation —
          // and since #2097's review round 3 it is only needed for a MANUAL action, because a
          // `derived` one regenerates on the next equip on its own.
          update.equippedActionSource = input.equippedAction ? EquippedActionSource.enum.manual : null;
        } else if (
          shouldDeriveOnEquip &&
          (moved || !fresh.equippedAction || fresh.equippedActionSource === EquippedActionSource.enum.derived)
        ) {
          // Review (chatgpt-codex-connector P2) — time-of-check/time-of-use, the same class of
          // race this transaction already re-validates authorization against. `derivedOnEquip`
          // was computed BEFORE the transaction opened (it awaits; better-sqlite3 transactions
          // must be synchronous), reading an action-less row. If a concurrent request authored
          // a manual action in that window, writing the derived one here would overwrite it —
          // breaking the one guarantee that makes the editor worth using. Re-checked against
          // `fresh`, the row as it exists inside this transaction — which still allows
          // regenerating a `derived` action, since only `manual` is protected.
          //
          // `moved` is exempt because the ownership-change rule discards the old owner's
          // action in this very write regardless of who authored it, so there is nothing left
          // to protect — see CLEARED_EQUIP_STATE.
          // A null derivation clears both fields — see `shouldDeriveOnEquip`. Only a `derived`
          // (or about-to-be-discarded `moved`) action ever reaches here, so this can never
          // erase a human's work.
          update.equippedAction = derivedOnEquip ? JSON.stringify(derivedOnEquip) : null;
          update.equippedActionSource = derivedOnEquip ? EquippedActionSource.enum.derived : null;
        } else if (moved) {
          // Issue #1326 review (coordinator): THE ownership-change clearing rule —
          // equipped, equipSlot, and equippedAction reset together, atomically, unless
          // THIS SAME write explicitly re-establishes a field for the new owner (handled
          // by the branch above). Left uncleared, a character's private granted action
          // would silently follow the item to its new owner: another character who never
          // chose it, or the public party stash, which is never redaction-checked at all
          // (see `redactEquippedActions`) — turning a previously-private action visible
          // campaign-wide the moment ownership changes. Uses the same CLEARED_EQUIP_STATE
          // every other owner-changing path (bulk move_inventory_owner + its undo, clone,
          // import) treats as the base "off" state for this triple.
          update.equippedAction = CLEARED_EQUIP_STATE.equippedAction;
          update.equippedActionSource = CLEARED_EQUIP_STATE.equippedActionSource;
        }
        if (equipWillChange) {
          if (nextEquipped) {
            // Slot conflict (issue #1326): reject a second equipped item claiming the same
            // (character, slot) pair rather than silently displacing the incumbent. Read
            // inside this transaction so two concurrent equips into the same slot serialize.
            const conflict = tx
              .select({ id: inventoryItems.id, name: inventoryItems.name, equipSlot: inventoryItems.equipSlot })
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
              if (!input.displaceEquipped) {
                throw new ConflictException({
                  code: 'INVENTORY_SLOT_CONFLICT',
                  message: `Slot "${nextEquipSlot}" is already occupied by "${conflict[0].name}" on this character — unequip it first.`,
                  // Issue #1901: the incumbent's id + name + the contested slot, additive to the
                  // existing {code, message} shape, so the web one-tap swap can unequip the
                  // incumbent and retry without re-parsing the human message string.
                  conflictingItemId: conflict[0].id,
                  conflictingItemName: conflict[0].name,
                  equipSlot: nextEquipSlot,
                });
              }
              // Issue #1901 review (chatgpt-codex-connector P2): the caller confirmed
              // displacing a SPECIFIC incumbent (`slotConflict.itemId` on the web one-tap
              // swap, captured from an earlier 409). If a different writer has since
              // unequipped that item and equipped a THIRD item into this same slot, the
              // freshly-read `conflict[0]` here is that third item, not the one the caller
              // confirmed — reject with a fresh 409 (same shape, new incumbent) rather than
              // silently displacing whichever item happens to occupy the slot right now. Read
              // inside the same transaction as the conflict lookup above, so this can't itself
              // race against a concurrent equip into the slot.
              if (input.expectedConflictingItemId !== undefined && conflict[0].id !== input.expectedConflictingItemId) {
                throw new ConflictException({
                  code: 'INVENTORY_SLOT_CONFLICT',
                  message: `Slot "${nextEquipSlot}" is now occupied by "${conflict[0].name}", not the item you confirmed replacing — review and retry.`,
                  conflictingItemId: conflict[0].id,
                  conflictingItemName: conflict[0].name,
                  equipSlot: nextEquipSlot,
                });
              }
              // Issue #1901 rework (review: devin-ai-integration + chatgpt-codex-connector P2):
              // `displaceEquipped` turns the 409 into an atomic swap — the incumbent is
              // unequipped IN THIS SAME transaction rather than requiring the caller to issue
              // an unequip PATCH and then a separate equip PATCH. That two-request sequence
              // (still available for a caller who wants the confirmation step) has a window
              // where the incumbent is off and nothing is on: another writer can claim the
              // slot before the second request lands, or the second request can simply fail
              // over the network, leaving the character wearing neither item. One transaction
              // makes that state unreachable.
              const [displaced] = tx
                .update(inventoryItems)
                .set({ equipped: false, equipSlot: null, updatedAt: ts })
                .where(and(eq(inventoryItems.id, conflict[0].id), isNull(inventoryItems.deletedAt)))
                .returning()
                .all();
              if (displaced) {
                displacedIncumbents.push({ id: displaced.id, name: displaced.name, equipSlot: conflict[0].equipSlot ?? nextEquipSlot });
              }
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
          qtyConflict = this.redactEquippedActionForOwner(toDomain(fresh), user, role, existingOwnerUserId);
          throw new InventoryQtyConflictMarker();
        }

        const next = updated[0];
        if (hasQtyDelta && next.qty < 0) {
          throw new BadRequestException(
            `Quantity cannot go negative (${fresh.qty} ${input.qtyDelta! >= 0 ? '+' : ''}${input.qtyDelta})`,
          );
        }

        committed = this.redactEquippedActionForOwner(toDomain(next), user, role, finalOwnerUserId);

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
    // Issue #1901 rework (review: chatgpt-codex-connector P1 / devin-ai-integration on
    // PR #1951): rewriting or clearing `equippedAction` on an item that stays equipped
    // changes the character's merged combat-action list exactly like an equip/unequip
    // does, but leaves `equipped`/`equipSlot` — and so `equipChanged` — untouched. Gate on
    // `committed.equipped` so an edit to an unequipped item's dormant equippedAction
    // (never part of the merge) doesn't trigger a needless invalidation.
    const equippedActionEdited = input.equippedAction !== undefined && committed.equipped;
    // Issue #1901 rework (review: chatgpt-codex-connector P2): a name-only PATCH on an
    // equipped, action-granting item changes the merged list's DERIVED `source` label
    // (`equipped: <item name>` — see EncountersService.suggestedActionsForCombatant /
    // ActionResolverService.equippedItemActionRows) without touching equipped/equipSlot/
    // equippedAction, so none of the other flags below would catch it. Gated on
    // `committed.equippedAction != null` — renaming a plain (non-action) piece of
    // equipped gear doesn't change anything the merge renders.
    const renamedGrantingItem =
      input.name !== undefined && input.name !== existing.name && committed.equipped && committed.equippedAction != null;
    // Issue #2097: a derivation adds a row to the merged list just as an authored edit does.
    // `equipChanged` covers the ordinary equip, but not a re-assert of the SAME equip state
    // (`PATCH {equipped:true, equipSlot:'main-hand'}` on an item already equipped there),
    // which passes the `equipWillChange` gate, derives, and leaves equipped/equipSlot
    // identical — so without this the character's action list would gain an attack that open
    // encounter cards never hear about.
    // Keyed on the ATTEMPT, not the result: a regeneration that clears a stale action changes
    // the merged list just as much as one that writes a fresh attack. (In the TOCTOU case the
    // branch may not have applied at all, but the concurrent manual write emitted its own
    // invalidation, and this file's standing rule is that an extra invalidation is harmless
    // while a missing one is the real defect.)
    const actionContentChanged = equippedActionEdited || renamedGrantingItem || shouldDeriveOnEquip;

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

    // Issue #1901 rework: `displaceEquipped` unequipped a slot-conflicting incumbent inside
    // the same transaction as this write — audit it as its own `item.update` (its own
    // entityId), same shape as an explicit unequip PATCH would produce.
    for (const displaced of displacedIncumbents) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'item.update',
        entityType: 'inventory_item',
        entityId: displaced.id,
        campaignId: existing.campaignId,
        detail: JSON.stringify({
          actor: { id: user.id, name: user.name, role },
          equip: {
            from: { equipped: true, equipSlot: displaced.equipSlot },
            to: { equipped: false, equipSlot: null },
          },
          displacedBy: id,
        }),
      });
    }

    // Issue #1901: an equip/unequip (or a move that carries/drops equip state), or a rewrite
    // of an already-equipped item's granted action, changes which combat actions a character's
    // encounter card and /turn payload show — signal it the same way a sheet edit does
    // (`character.updated`) so RunSessionPage's existing SSE handler invalidates the cached
    // action list without a new event type. Only characters that were (or are now) the
    // EQUIPPED owner care; an unrelated move or a qty-only write emits nothing.
    if (equipChanged || moved || actionContentChanged) {
      const affected = new Set<number>();
      if (existing.ownerType === 'character' && existing.characterId != null && existing.equipped) {
        affected.add(existing.characterId);
      }
      if (committed.ownerType === 'character' && committed.characterId != null && committed.equipped) {
        affected.add(committed.characterId);
      }
      for (const characterId of affected) {
        this.events.emit({ type: 'character.updated', campaignId: existing.campaignId, characterId, userId: user.id });
      }
    }
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
      // Issue #1326 review (coordinator): trashing an equipped item must clear
      // equipped/equipSlot so a replacement can claim the slot, but equippedAction is
      // inert while equipped is false and should round-trip with the tombstone. Nulled
      // here, the granted action is unrecoverable because the audit snapshot (above)
      // does not record it and restore() does not rewrite it.
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

    // Issue #1901 rework (review: devin-ai-integration on PR #1951): trashing an item that
    // was equipped and carried a granted action drops that action from the owning
    // character's merged combat-action list exactly like an explicit unequip does (the
    // `.set()` above forces `equipped: false` on the tombstoned row) — signal it the same
    // way `update()`'s equip/unequip path does so live encounter screens don't keep
    // offering an action that was just deleted. Gate on `equippedAction != null` so
    // deleting a plain (non-action) piece of gear stays silent, matching `update()`.
    if (existing.ownerType === 'character' && existing.characterId != null && existing.equipped && existing.equippedAction != null) {
      this.events.emit({ type: 'character.updated', campaignId: existing.campaignId, characterId: existing.characterId, userId: user.id });
    }

    return (await this.redactEquippedActions([domain], user, role))[0];
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
      return (await this.redactEquippedActions([toDomain(existing)], user, role))[0];
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
    const restoreUpdate: Record<string, unknown> = {
      ownerType,
      characterId,
      deletedAt: null,
      deletedBy: null,
      updatedAt: ts,
    };
    if (ownerType === 'party') {
      // Party-owned items can never legitimately carry an equipped action. Review
      // (chatgpt-codex-connector P2, devin): the provenance goes with it. This is an
      // owner-changing path like any other, and `redactEquippedActions` short-circuits on a
      // null action — so a surviving 'derived'/'manual' would be published campaign-wide as
      // the origin of an action that no longer exists.
      restoreUpdate.equippedAction = CLEARED_EQUIP_STATE.equippedAction;
      restoreUpdate.equippedActionSource = CLEARED_EQUIP_STATE.equippedActionSource;
    }
    const [row] = await this.db
      .update(inventoryItems)
      .set(restoreUpdate)
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

    return (await this.redactEquippedActions([domain], user, role))[0];
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

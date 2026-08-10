import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { canonicalJson, CharacterAction, CompendiumRef, CompendiumSnapshot, deriveEquippedItemAction, EquippedActionSource, equippedActionHasContent, rebuildEditedActionSpec, InventoryFromCompendium, InventoryItem, InventoryItemCreate, InventoryItemUpdate, ruleSystemAdapter, TreasuryPatch } from '@campfire/schema';
import type { HomebrewMechanicsProfile, RuleSystemAdapter, Treasury, Role } from '@campfire/schema';
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
export const CLEARED_EQUIP_STATE: { readonly equipped: false; readonly equipSlot: null; readonly equippedAction: null } = {
  equipped: false,
  equipSlot: null,
  equippedAction: null,
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
  // Issue #2144: a stored action that says nothing beyond its own name is read as NO action,
  // so derivation runs for it. `update()` no longer writes one, but rows saved before that —
  // the editor's blank draft, saved unchanged — are already out there, each one silently
  // holding its item's derived attack down. Treating them as absent on the way out repairs
  // them where it matters without a migration rewriting anyone's data.
  const storedAction = parsedAction?.success && equippedActionHasContent(parsedAction.data) ? parsedAction.data : null;
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
    equippedAction: storedAction,
    equippedActionSource: storedAction ? EquippedActionSource.enum.manual : null,
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
    return this.resolveEquippedActions(await this.withCompendiumStates(rows), user, role);
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
    return this.resolveEquippedActions(rows.map(toDomain), user, role);
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
    const [redacted] = await this.resolveEquippedActions([item], user, role);
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
  /** The campaign's rule adapter, `customMechanicsProfile` included. */
  private async adapterForCampaign(campaignId: number): Promise<{ adapter: RuleSystemAdapter; mechanics: string }> {
    const campaign = await this.db
      .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .get();
    return {
      adapter: ruleSystemAdapter(
        campaign?.ruleSystem ?? '',
        fromJsonText<HomebrewMechanicsProfile | null>(campaign?.customMechanicsProfile, null),
      ),
      // A canonical fingerprint of the mechanics this adapter was built from, so a write can
      // check they still hold when it commits — see `update()`. Key-sorted, because the stored
      // profile's key order is whatever serialized it.
      mechanics: canonicalJson([campaign?.ruleSystem ?? '', safeJson(campaign?.customMechanicsProfile ?? '')]),
    };
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

  /**
   * Fill in each item's equipped action, then redact what this reader may not see.
   *
   * Issue #2097: a DERIVED action is computed HERE, at read time, from the item's accepted
   * snapshot and its wielder — it is never stored. That is the whole shape of this feature:
   * the value depends on the compendium snapshot, the character's stats and level, the
   * campaign's rule system and the item's name, all owned by different modules and all free
   * to change at any moment. Persisting it meant every one of those writers had to invalidate
   * it, every write had to fence against every input, and every copy in a journal or tombstone
   * needed the same treatment. Computing it on the way out makes staleness unrepresentable.
   *
   * `equippedAction` therefore stores only HUMAN-authored actions, which is the one thing that
   * genuinely needs saving. `equippedActionSource` stays on the API — `manual` for a stored
   * action, `derived` for a computed one — so clients keep the distinction without the server
   * keeping a column.
   */
  private async resolveEquippedActions(items: InventoryItem[], user: RequestUser, role: Role): Promise<InventoryItem[]> {
    // Only an EQUIPPED, character-owned item without an authored action can derive one.
    const derivable = items.filter(
      (item) => item.equipped && item.ownerType === 'character' && item.characterId != null && item.equippedAction == null,
    );
    const characterIds = [
      ...new Set(
        items
          .filter((item) => item.ownerType === 'character' && item.characterId != null)
          .map((item) => item.characterId as number),
      ),
    ];
    const characterRows =
      characterIds.length > 0
        ? await this.db
            .select({
              id: characters.id,
              ownerUserId: characters.ownerUserId,
              stats: characters.stats,
              level: characters.level,
              weaponProficiencies: characters.weaponProficiencies,
            })
            .from(characters)
            .where(inArray(characters.id, characterIds))
        : [];
    const characterById = new Map(characterRows.map((row) => [row.id, row]));

    // Batched, so a full inventory list costs one query per campaign rather than one per item.
    const entryIds = [
      ...new Set(
        derivable
          .filter((item) => !item.compendiumSnapshot && item.ruleEntryId != null)
          .map((item) => item.ruleEntryId as number),
      ),
    ];
    const entryRows =
      entryIds.length > 0
        ? await this.db.select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson }).from(ruleEntries).where(inArray(ruleEntries.id, entryIds))
        : [];
    const entryById = new Map(entryRows.map((row) => [row.id, row.dataJson]));

    const campaignIds = [...new Set(derivable.map((item) => item.campaignId))];
    const adapterByCampaign = new Map<number, RuleSystemAdapter>();
    for (const campaignId of campaignIds) adapterByCampaign.set(campaignId, (await this.adapterForCampaign(campaignId)).adapter);

    const resolved = items.map((item) => {
      if (item.equippedAction != null || !item.equipped || item.ownerType !== 'character' || item.characterId == null) return item;
      const character = characterById.get(item.characterId);
      const adapter = adapterByCampaign.get(item.campaignId);
      if (!character || !adapter) return item;
      // The accepted snapshot is authoritative; the live entry is the fallback for an item
      // that has none. No fence needed either way — this reads and computes in one pass, so
      // there is no window in which the inputs and the result can disagree.
      const dataJson = item.compendiumSnapshot?.dataJson ?? (item.ruleEntryId != null ? entryById.get(item.ruleEntryId) ?? null : null);
      if (!dataJson) return item;
      const action = deriveEquippedItemAction({
        itemName: item.name,
        data: safeJson(dataJson),
        character: {
          stats: fromJsonText<Record<string, number>>(character.stats, {}),
          level: character.level,
          // Issue #2144: the wielder's actual weapon training, which is what replaced this
          // derivation's assumed proficiency.
          weaponProficiencies: fromJsonText<Record<string, string>>(character.weaponProficiencies, {}),
        },
        adapter,
      });
      return action ? { ...item, equippedAction: action, equippedActionSource: EquippedActionSource.enum.derived } : item;
    });

    if (role === 'dm') return resolved;
    return resolved.map((item) => {
      if (item.equippedAction == null) return item;
      // Party-stash items should never carry an equippedAction, and a character-owned item
      // without a resolvable owner is treated as fail-closed rather than fail-open.
      if (item.ownerType !== 'character' || item.characterId == null) {
        return { ...item, equippedAction: null, equippedActionSource: null };
      }
      if (characterById.get(item.characterId)?.ownerUserId === user.id) return item;
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

  /**
   * Non-throwing sibling of {@link assertCanWriteOwner}, for re-checking authorization AFTER
   * an already-authorized write has been applied (issue #2097 review). Same rule, asked as a
   * question instead of asserted: a DM may write anyone's items, a player only their own
   * character's.
   */
  private async canWriteOwner(
    ownerType: 'party' | 'character',
    characterId: number | null,
    campaignId: number,
    user: RequestUser,
    role: Role,
  ): Promise<boolean> {
    if (ownerType === 'party') return characterId == null;
    if (role === 'dm') return true;
    const character = await this.validateOwner(ownerType, characterId, campaignId);
    return !!character && character.ownerUserId === user.id;
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
    return (await this.resolveEquippedActions([created], user, role))[0];
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
    return (await this.resolveEquippedActions([acquired], user, role))[0];
  }

  async refreshCompendium(id: number, user: RequestUser, role: Role): Promise<InventoryItem> {
    const existing = await this.getRowOrThrow(id);
    const authorizedOwner = await this.assertCanWriteOwner(existing.ownerType as 'party' | 'character', existing.characterId, existing.campaignId, user, role);
    if (!existing.ruleEntryId) throw new BadRequestException('This item is detached from the compendium');
    // The wielder's `ownerUserId` as it stood when this request was authorized — but only when
    // it was what authorized the request (issue #2097 review: chatgpt-codex-connector P1). A DM
    // may write any item in the campaign, so reassigning the character underneath them changes
    // nothing about their authority and must not 409 them. For a PLAYER it is the whole basis
    // of the check: reassign the character and the former owner is no longer allowed to touch
    // the snapshot that controls the new owner's derived action.
    const authorizedOwnerUserId = role === 'dm' ? undefined : (authorizedOwner?.ownerUserId ?? null);
    // Read the source and write the snapshot in ONE synchronous better-sqlite3 transaction
    // (issue #2097 review: chatgpt-codex-connector P2). Reading the entry first and updating
    // afterwards leaves a window in which `RulesService.updatePack()` rewrites that entry, so
    // the refresh stores a revision that was already superseded before it landed — and marks
    // it `linked`, which claims the item is current. Nothing here needs to await, so the
    // window can simply be closed rather than fenced against.
    const row = this.db.transaction((tx) => {
      const [entry] = tx
        .select()
        .from(ruleEntries)
        .where(and(eq(ruleEntries.id, existing.ruleEntryId!), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, existing.campaignId))))
        .limit(1)
        .all();
      if (!entry || entry.type !== 'item') throw new NotFoundException('The linked source item is unavailable');
      const [pack] = tx.select().from(rulePacks).where(eq(rulePacks.id, entry.packId)).limit(1).all();
      if (!pack) throw new NotFoundException('The linked source pack is unavailable');
      const snapshot = sanitizeCompendiumSnapshot(buildCompendiumSnapshot(entry));
      if (!snapshot) throw new BadRequestException('The linked source item is not play-safe');
      // Re-check the WIELDER's owner inside the transaction (chatgpt-codex-connector P1). The
      // predicate below fences the item's owner fields, but a DM reassigning the CHARACTER to
      // another player leaves those untouched — `ownerType` and `characterId` are the same row
      // values — while moving the authority this request was granted under.
      if (authorizedOwnerUserId !== undefined && existing.characterId != null) {
        const wielder = tx.select({ ownerUserId: characters.ownerUserId }).from(characters).where(eq(characters.id, existing.characterId)).get();
        if ((wielder?.ownerUserId ?? null) !== authorizedOwnerUserId) {
          throw new ForbiddenException('Only dm or the owning player may manage this character\'s items');
        }
      }
      // A derived action is computed from whatever snapshot the row holds at READ time (see
      // `resolveEquippedActions`), so accepting a revision is now only this snapshot write —
      // there is nothing cached to regenerate or authorize a second time.
      // Fence the write on the owner this request was AUTHORIZED against (issue #2097 review:
      // chatgpt-codex-connector P1). `assertCanWriteOwner` ran before this transaction; if a DM
      // hands the item to another player's character in between, an update keyed on the id
      // alone lets the former owner replace the accepted snapshot — which now immediately
      // changes what the NEW owner's weapon does. The authorization has to hold at the moment
      // of the write, not merely at the moment it was checked.
      const [row] = tx
        .update(inventoryItems)
        .set({
          compendiumRef: JSON.stringify(buildCompendiumRef(entry, pack)),
          compendiumSnapshot: JSON.stringify(snapshot),
          compendiumState: 'linked',
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(inventoryItems.id, id),
            eq(inventoryItems.ownerType, existing.ownerType),
            existing.characterId == null ? isNull(inventoryItems.characterId) : eq(inventoryItems.characterId, existing.characterId),
            // ...and on the SOURCE LINK this refresh resolved (chatgpt-codex-connector P2). A
            // concurrent `setCompendiumState('detached')` nulls `ruleEntryId`; without this the
            // write would relink the row as `linked` while leaving that id null, so the item
            // reported a live link whose next refresh fails as detached. Detaching is a
            // deliberate act — losing the race means refetching, not being silently relinked.
            eq(inventoryItems.ruleEntryId, existing.ruleEntryId!),
          ),
        )
        .returning()
        .all();
      if (!row) throw new ConflictException('This item changed owner or source link while the refresh was in flight; refetch and try again');
      return row;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'item.refresh_compendium',
      entityType: 'inventory_item',
      entityId: id,
      campaignId: existing.campaignId,
    });
    // Issue #2097 review (chatgpt-codex-connector P2): accepting a new revision changes what
    // an equipped weapon derives on the very next read, and `RunSessionPage` refreshes its
    // merged-action cache only on `character.updated` — without this an open encounter card
    // keeps offering the previous revision's attack, which resolving then rejects as changed.
    // Gated on there being no STORED action: a human's action is returned verbatim and a
    // refresh does not touch it.
    //
    // Decided from the COMMITTED row, not the pre-transaction read (chatgpt-codex-connector
    // P2, second round). A concurrent request can equip this item — emitting its own tick —
    // between the read above and this transaction; a stale `existing.equipped` of false then
    // suppressed the refresh's tick, and a client that had already handled the equip would
    // cache an action derived from the snapshot this write just replaced. The owner fence
    // covers who may write; it says nothing about what the row now IS.
    if (row.ownerType === 'character' && row.characterId != null && row.equipped && row.equippedAction == null) {
      this.events.emit({ type: 'character.updated', campaignId: row.campaignId, characterId: row.characterId, userId: user.id });
    }

    const refreshed = await this.withCompendiumState(row);
    return (await this.resolveEquippedActions([refreshed], user, role))[0];
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
    return (await this.resolveEquippedActions([stateItem], user, role))[0];
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

    // Issue #2097: an AUTHORED action is validated and spec-rebuilt against the campaign's
    // own rule system, so the adapter is resolved HERE — the write below is a synchronous
    // better-sqlite3 transaction that cannot await, exactly like the owner ids above.
    const editMechanics = input.equippedAction ? await this.adapterForCampaign(existing.campaignId) : null;
    const campaignRuleSystem = editMechanics?.adapter.id ?? '';
    const campaignDamageTypes = editMechanics?.adapter.damageTypes;

    // Auth checks above may await; the write itself must be one synchronous
    // better-sqlite3 transaction so concurrent qtyDelta compose and idempotent
    // retries observe a single committed apply (issue #782).
    let committed!: InventoryItem;
    /**
     * The item's name as it stood INSIDE the transaction, before this write. The baseline for
     * "did this PATCH actually rename the item?" — see the invalidation below for why the
     * pre-transaction read is the wrong one to ask.
     */
    let nameBeforeWrite = existing.name;
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
        // Issue #2097: with derived actions computed at READ time, this write only decides
        // what happens to a HUMAN-authored one — store it, clear it, or leave it. There is
        // nothing cached to keep current, so none of the fences, revisions, or conflict
        // paths this block used to carry are needed.
        nameBeforeWrite = fresh.name;
        // A submitted action with no mechanics in it is a CLEAR, not an authored row (issue
        // #2144). The web editor opens prefilled with the item's name and five empty fields,
        // so "open it, look, save" produced a valid-but-inert action that displayed nothing
        // and — since only an item with no authored action derives one — took away the attack
        // the weapon had been granting. Storing nothing restores the derived row instead.
        const submittedAction = equippedActionHasContent(input.equippedAction) ? input.equippedAction! : null;
        const actionWrite: 'authored' | 'clear' | 'leave' =
          input.equippedAction !== undefined ? (submittedAction ? 'authored' : 'clear') : moved ? 'clear' : 'leave';

        if (actionWrite === 'authored') {
          // An authored action's structured `spec` is what the resolver ROLLS; `toHit` and
          // `damage` are only what it shows. A caller that edits the numbers while carrying
          // the old spec through — which a REST/MCP round-trip does naturally — would display
          // the correction and keep rolling the original, so a spec that contradicts the
          // fields it arrived with is rebuilt from them. Decided from the REQUEST alone (see
          // `rebuildEditedActionSpec`), which is why nothing is read here to compare against:
          // any such baseline can be overwritten by a concurrent edit between the caller's
          // read and this write, and then a genuinely stale spec looks deliberate.
          // Fence on the mechanics the adapter above was built from (issue #2097 review:
          // chatgpt-codex-connector P2). `adapterForCampaign` awaits, and a campaign PATCH can
          // switch the rule system during that await — the edit would then be validated
          // against the old system's damage vocabulary and expanded by its attack math, and
          // stored as `manual`, which nothing ever regenerates. A derived action would simply
          // recompute under the new system on the next read; an authored one is permanent, so
          // this is the one write on this path that a mechanics change can still spoil.
          const nowMechanics = (() => {
            const campaign = tx
              .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
              .from(campaigns)
              .where(eq(campaigns.id, existing.campaignId))
              .get();
            return canonicalJson([campaign?.ruleSystem ?? '', safeJson(campaign?.customMechanicsProfile ?? '')]);
          })();
          if (nowMechanics !== editMechanics!.mechanics) {
            throw new ConflictException("The campaign's rule system changed while this action was being saved; refetch and try again");
          }
          const authored = rebuildEditedActionSpec(submittedAction!, campaignRuleSystem, campaignDamageTypes);
          update.equippedAction = JSON.stringify(authored);
        } else if (actionWrite === 'clear') {
          update.equippedAction = CLEARED_EQUIP_STATE.equippedAction;
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
          // The stored replay body never contains a derived action — only authored ones
          // reach the row — so re-resolving gives the caller today's derivation rather than
          // the one that was current when the key was first used.
          return (await this.resolveEquippedActions([JSON.parse(prior.responseJson) as InventoryItem], user, role))[0];
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSE',
          message: 'idempotencyKey was already used for a different inventory quantity action',
        });
      }
      throw err;
    }

    // Idempotent replay returns the first committed response without re-auditing.
    if (replayed) return (await this.resolveEquippedActions([committed], user, role))[0];

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
    // equipped item changes the merged list — both the `equipped: <item name>` source label
    // and, for a derived action, its title — without touching equipped/equipSlot/
    // equippedAction, so no other flag here would catch it.
    //
    // Issue #2097: NOT gated on the item actually granting an action. A derived action is
    // computed at read time and never stored, so `committed.equippedAction` is null for
    // exactly the items whose action a rename retitles — gating on it would have skipped the
    // invalidation in the one case it exists for. The cost of an extra invalidation on a
    // renamed non-action item is a refetch; the cost of a missing one is an encounter card
    // offering an action under a name the item no longer has.
    //
    // Compared against the row INSIDE the transaction (chatgpt-codex-connector P2, second
    // round), not the pre-transaction read and not `input.name`. A full-object PATCH that read
    // name A and resends A, landing after a concurrent rename to B, genuinely changes the row
    // back from B to A — but `input.name !== existing.name` is false, because both stale
    // values are A. The only tick emitted was for B, leaving open caches showing a B-titled
    // action the server now derives as A. What matters is whether this write changed the name
    // that is actually stored.
    const renamedGrantingItem = committed.name !== nameBeforeWrite && committed.equipped && committed.ownerType === 'character';
    const actionContentChanged = equippedActionEdited || renamedGrantingItem;

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
    return (await this.resolveEquippedActions([committed], user, role))[0];
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
    // offering an action that was just deleted.
    //
    // Issue #2097 review (chatgpt-codex-connector P2): NOT gated on `equippedAction != null`
    // any more. That column now holds only human-authored actions, so it is null for exactly
    // the compendium weapons whose action is derived — the gate excluded the common case.
    // Deriving here just to decide whether to announce would cost a read per delete to save a
    // refetch; this file's standing rule is that an extra invalidation is harmless while a
    // missing one is the real defect.
    if (existing.ownerType === 'character' && existing.characterId != null && existing.equipped) {
      this.events.emit({ type: 'character.updated', campaignId: existing.campaignId, characterId: existing.characterId, userId: user.id });
    }

    return (await this.resolveEquippedActions([domain], user, role))[0];
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
      return (await this.resolveEquippedActions([toDomain(existing)], user, role))[0];
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
      // Party-owned items can never legitimately carry an equipped action.
      restoreUpdate.equippedAction = CLEARED_EQUIP_STATE.equippedAction;
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

    return (await this.resolveEquippedActions([domain], user, role))[0];
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

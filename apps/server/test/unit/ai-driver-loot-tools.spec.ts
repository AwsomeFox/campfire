import { describe, it, expect } from '@jest/globals';
import {
  isDriverToolAllowed,
  guardDriverLivePlayArgs,
  formatDriverLootCombatLogDetail,
  DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION,
  DRIVER_INVENTORY_GRANT_MAX_QTY,
} from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1021: Verify that the AI Driver can award loot, treasury, and items during live play.
 */
describe('AI Driver loot/treasury tools (#1021)', () => {
  it('adjust_treasury is allowed', () => {
    expect(isDriverToolAllowed({ name: 'adjust_treasury', mutating: true, proposalCapable: false })).toBe(true);
  });

  it('add_inventory_item is allowed', () => {
    expect(isDriverToolAllowed({ name: 'add_inventory_item', mutating: true, proposalCapable: false })).toBe(true);
  });

  it('update_inventory_item is allowed', () => {
    expect(isDriverToolAllowed({ name: 'update_inventory_item', mutating: true, proposalCapable: false })).toBe(true);
  });

  it('award_xp remains allowed (parity check)', () => {
    expect(isDriverToolAllowed({ name: 'award_xp', mutating: true, proposalCapable: false })).toBe(true);
  });

  it('delete_inventory_item is NOT allowed (delete_ prefix blocked even if proposalCapable)', () => {
    expect(isDriverToolAllowed({ name: 'delete_inventory_item', mutating: true, proposalCapable: false })).toBe(false);
    expect(isDriverToolAllowed({ name: 'delete_inventory_item', mutating: true, proposalCapable: true })).toBe(false);
  });

  // Issue #1326 review (coordinator): converted from a denylist (reject qty/ownerType/
  // characterId/non-positive qtyDelta, allow everything else through) to an ALLOWLIST —
  // the denylist shape is exactly how this PR's own equipped/equipSlot/equippedAction
  // fields slipped through unnoticed until review. See #1792 for converting the
  // remaining driver guards the same way.
  it('guardDriverLivePlayArgs enforces an ALLOWLIST on update_inventory_item — qtyDelta or metadata only', () => {
    const session = { driverGeneratedMapIds: [], generateMapCallsThisTurn: 0 };

    // positive qtyDelta is allowed (grant only)
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 2 }, session)).toEqual({
      ok: true,
      args: { itemId: 1, qtyDelta: 2 },
    });

    // itemId + qtyDelta + idempotencyKey together are allowed
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 2, idempotencyKey: 'abc' }, session)).toEqual({
      ok: true,
      args: { itemId: 1, qtyDelta: 2, idempotencyKey: 'abc' },
    });

    // negative qtyDelta is blocked
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: -1 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_reduction',
      message: 'The driver may only increase item quantities via update_inventory_item (qtyDelta must be a positive integer).',
    });

    // zero qtyDelta is blocked (no-op grants are not allowed)
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 0 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_reduction',
      message: 'The driver may only increase item quantities via update_inventory_item (qtyDelta must be a positive integer).',
    });

    // no qty or metadata is blocked
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver must provide a positive qtyDelta or metadata (name/notes/iconSlug) to update_inventory_item.',
    });

    // metadata-only edits are allowed
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, name: 'Longsword +1', notes: 'magic', iconSlug: 'sword' }, session)).toEqual({
      ok: true,
      args: { itemId: 1, name: 'Longsword +1', notes: 'magic', iconSlug: 'sword' },
    });

    // absolute qty (any value) is blocked — use qtyDelta instead
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qty: 5 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon via update_inventory_item. Rejected: qty.',
    });

    // owner moves are blocked
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, ownerType: 'character' }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon via update_inventory_item. Rejected: ownerType.',
    });
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, characterId: 42 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon via update_inventory_item. Rejected: characterId.',
    });

    // Issue #1326 review (Codex/Devin) — the exact exposure this PR introduced: equipping
    // gear and attaching a brand-new attack are both refused, with no dedicated denial
    // branch required for either.
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, equipped: true, equipSlot: 'main-hand' }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon via update_inventory_item. Rejected: equipped, equipSlot.',
    });
    expect(
      guardDriverLivePlayArgs(
        'update_inventory_item',
        { itemId: 1, qtyDelta: 1, equippedAction: { name: 'New Attack', kind: 'melee', toHit: '+5', damage: '1d8', notes: '' } },
        session,
      ),
    ).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon via update_inventory_item. Rejected: equippedAction.',
    });

    // Fail-closed proof: an entirely unknown field the schema has never had is refused
    // too — the allowlist rejects by omission from the allowed set, not by name, so a
    // future schema widening cannot slip through unnoticed the way equip did here.
    expect(
      guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 1, someBrandNewFieldNobodyHasAddedYet: true }, session),
    ).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon via update_inventory_item. Rejected: someBrandNewFieldNobodyHasAddedYet.',
    });
  });

  it('guardDriverLivePlayArgs enforces grant-only bounded deltas on adjust_treasury', () => {
    const session = { driverGeneratedMapIds: [], generateMapCallsThisTurn: 0 };

    expect(guardDriverLivePlayArgs('adjust_treasury', { campaignId: 1, delta: { gp: 50, sp: 10 } }, session)).toEqual({
      ok: true,
      args: { campaignId: 1, delta: { gp: 50, sp: 10 } },
    });

    expect(guardDriverLivePlayArgs('adjust_treasury', { campaignId: 1, delta: { gp: -1 } }, session)).toEqual({
      ok: false,
      code: 'forbidden_treasury_spend',
      message: 'The driver may only grant treasury (positive deltas); spending/reducing treasury requires review.',
    });

    expect(guardDriverLivePlayArgs('adjust_treasury', { campaignId: 1, delta: { gp: 0 } }, session)).toEqual({
      ok: false,
      code: 'forbidden_treasury_spend',
      message: 'The driver may only grant treasury (positive deltas); spending/reducing treasury requires review.',
    });

    expect(
      guardDriverLivePlayArgs(
        'adjust_treasury',
        { campaignId: 1, delta: { gp: DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION + 1 } },
        session,
      ),
    ).toEqual({
      ok: false,
      code: 'forbidden_treasury_grant_limit',
      message: `The driver may grant at most ${DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION} per treasury denomination in one call.`,
    });

    expect(guardDriverLivePlayArgs('adjust_treasury', { campaignId: 1, set: { gp: 999 } }, session)).toEqual({
      ok: false,
      code: 'forbidden_treasury_field',
      message: 'The driver may not use absolute treasury set values; only positive delta grants are allowed.',
    });
  });

  it('#1495: guardDriverLivePlayArgs enforces a grant-only, bounded-qty, party-only guard on add_inventory_item', () => {
    const session = { driverGeneratedMapIds: [], generateMapCallsThisTurn: 0 };

    // default qty (implicit) grant is allowed
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Potion of Healing' }, session)).toEqual({
      ok: true,
      args: { name: 'Potion of Healing' },
    });

    // explicit party-pool grant with a modest qty is allowed
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Rope (50ft)', qty: 2, ownerType: 'party' }, session),
    ).toEqual({
      ok: true,
      args: { name: 'Rope (50ft)', qty: 2, ownerType: 'party' },
    });

    // targeting a specific character (ownerType other than "party") is refused
    expect(
      guardDriverLivePlayArgs(
        'add_inventory_item',
        { name: 'Longsword +1', ownerType: 'character', characterId: 42 },
        session,
      ),
    ).toEqual({
      ok: false,
      code: 'forbidden_inventory_owner',
      message: 'The driver may only grant inventory items to the shared party pool (ownerType must be "party").',
    });

    // characterId alone (without an explicit non-party ownerType) is also refused
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Dagger', characterId: 7 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_owner',
      message: 'The driver may not target a specific character with add_inventory_item; grants go to the party pool.',
    });

    // an excessive qty is rejected
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Gold Coin', qty: 999999 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_grant_limit',
      message: `The driver may grant at most ${DRIVER_INVENTORY_GRANT_MAX_QTY} of an item in one call.`,
    });

    // the boundary qty is allowed, one over it is not
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: DRIVER_INVENTORY_GRANT_MAX_QTY }, session),
    ).toEqual({
      ok: true,
      args: { name: 'Torch', qty: DRIVER_INVENTORY_GRANT_MAX_QTY },
    });
    expect(
      guardDriverLivePlayArgs(
        'add_inventory_item',
        { name: 'Torch', qty: DRIVER_INVENTORY_GRANT_MAX_QTY + 1 },
        session,
      ),
    ).toEqual({
      ok: false,
      code: 'forbidden_inventory_grant_limit',
      message: `The driver may grant at most ${DRIVER_INVENTORY_GRANT_MAX_QTY} of an item in one call.`,
    });

    // zero, negative, and non-integer qty are all rejected
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 0 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_qty',
      message: 'add_inventory_item qty must be a positive integer.',
    });
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: -1 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_qty',
      message: 'add_inventory_item qty must be a positive integer.',
    });
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 1.5 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_qty',
      message: 'add_inventory_item qty must be a positive integer.',
    });
  });

  it('formatDriverLootCombatLogDetail summarizes treasury and inventory grants for the combat log', () => {
    expect(formatDriverLootCombatLogDetail('adjust_treasury', { delta: { gp: 25, sp: 10 } })).toBe(
      'Granted treasury (+25 gp, +10 sp)',
    );
    expect(formatDriverLootCombatLogDetail('add_inventory_item', { name: 'Potion of Healing', qty: 1 })).toBe(
      'Granted item: Potion of Healing ×1',
    );
    expect(formatDriverLootCombatLogDetail('update_inventory_item', { itemId: 9, qtyDelta: 2 })).toBe(
      'Increased party item quantity by +2',
    );
    expect(formatDriverLootCombatLogDetail('roll_dice', { expr: '1d20' })).toBeNull();
  });
});

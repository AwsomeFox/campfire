import { describe, it, expect } from '@jest/globals';
import {
  isDriverToolAllowed,
  guardDriverLivePlayArgs,
  formatDriverLootCombatLogDetail,
  noteDriverEconomyGrant,
  DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION,
  DRIVER_INVENTORY_GRANT_MAX_QTY,
  DRIVER_INVENTORY_SESSION_GRANT_CAP,
  DRIVER_TREASURY_SESSION_GRANT_CAP,
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

  it('guardDriverLivePlayArgs blocks negative/zero qtyDelta, absolute qty, and owner moves on update_inventory_item', () => {
    const session = { driverGeneratedMapIds: [], generateMapCallsThisTurn: 0 };

    // positive qtyDelta is allowed (grant only)
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 2 }, session)).toEqual({
      ok: true,
      args: { itemId: 1, qtyDelta: 2 },
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

    // absolute qty (any value) is blocked — use qtyDelta instead
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qty: 0 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may not set an absolute qty on update_inventory_item; use a positive qtyDelta to grant.',
    });
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qty: 5 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may not set an absolute qty on update_inventory_item; use a positive qtyDelta to grant.',
    });

    // owner moves are blocked
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, ownerType: 'character' }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may not move inventory items between owners (ownerType/characterId are not allowed).',
    });
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, characterId: 42 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may not move inventory items between owners (ownerType/characterId are not allowed).',
    });

    // safe metadata-only update is allowed
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, name: 'Longsword +1', notes: 'magic' }, session)).toEqual({
      ok: true,
      args: { itemId: 1, name: 'Longsword +1', notes: 'magic' },
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

    // a plain grant to the party pool, default qty, is allowed
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Potion of Healing' }, session)).toEqual({
      ok: true,
      args: { name: 'Potion of Healing' },
    });

    // an explicit party-pool grant with a modest qty is allowed
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Rope (50 ft)', ownerType: 'party', qty: 3 }, session),
    ).toEqual({ ok: true, args: { name: 'Rope (50 ft)', ownerType: 'party', qty: 3 } });

    // targeting a specific character is refused under the grant-only guard (#1495 acceptance criterion)
    expect(
      guardDriverLivePlayArgs(
        'add_inventory_item',
        { name: 'Vorpal Sword', ownerType: 'character', characterId: 4 },
        session,
      ),
    ).toEqual({
      ok: false,
      code: 'forbidden_inventory_owner',
      message: 'The driver may only grant inventory items to the shared party pool (ownerType must be "party").',
    });

    // characterId alone (even with default/omitted ownerType) is refused
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Ring', characterId: 4 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_owner',
      message: 'The driver may not target a specific character with add_inventory_item; grants go to the party pool.',
    });

    // an absurd qty is rejected (#1495 — this is the "qty: 999999" scenario from the issue)
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Vorpal Sword', qty: 999_999 }, session),
    ).toEqual({
      ok: false,
      code: 'forbidden_inventory_grant_limit',
      message: `The driver may grant at most ${DRIVER_INVENTORY_GRANT_MAX_QTY} of an item in one call.`,
    });

    // a qty right at the per-call cap is allowed; one over is rejected
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Arrow', qty: DRIVER_INVENTORY_GRANT_MAX_QTY }, session),
    ).toEqual({ ok: true, args: { name: 'Arrow', qty: DRIVER_INVENTORY_GRANT_MAX_QTY } });
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Arrow', qty: DRIVER_INVENTORY_GRANT_MAX_QTY + 1 }, session),
    ).toMatchObject({ ok: false, code: 'forbidden_inventory_grant_limit' });

    // zero/negative/non-integer qty is refused
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Arrow', qty: 0 }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_inventory_qty',
    });
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Arrow', qty: -1 }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_inventory_qty',
    });
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Arrow', qty: 1.5 }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_inventory_qty',
    });
  });

  it('#1495: add_inventory_item and update_inventory_item share a cumulative per-session grant cap', () => {
    const session = {
      driverGeneratedMapIds: [] as number[],
      generateMapCallsThisTurn: 0,
      inventoryGrantQtyTotalThisSession: DRIVER_INVENTORY_SESSION_GRANT_CAP - 5,
    };

    // still 5 qty of room left in the session budget: a grant of 5 fits exactly...
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 5 }, session)).toEqual({
      ok: true,
      args: { name: 'Torch', qty: 5 },
    });
    // ...but one more than that overflows the session cap, even though it is well under the
    // per-call cap on its own.
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 6 }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_inventory_session_cap',
    });
    // update_inventory_item draws on the SAME session budget (#1495) — a qtyDelta that would
    // overflow it is rejected even though the per-call qtyDelta bound has no upper limit.
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 6 }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_inventory_session_cap',
    });
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 5 }, session)).toEqual({
      ok: true,
      args: { itemId: 1, qtyDelta: 5 },
    });
  });

  it('#1495: adjust_treasury enforces a cumulative per-session treasury grant cap regardless of call count', () => {
    const session = {
      driverGeneratedMapIds: [] as number[],
      generateMapCallsThisTurn: 0,
      treasuryGrantTotalThisSession: 0,
    };
    // Simulate many small, individually-legal grants accumulating toward the session cap.
    const perCallGrant = 1_000;
    const callsToFillCap = Math.floor(DRIVER_TREASURY_SESSION_GRANT_CAP / perCallGrant);
    for (let i = 0; i < callsToFillCap; i++) {
      const result = guardDriverLivePlayArgs('adjust_treasury', { delta: { gp: perCallGrant } }, session);
      expect(result.ok).toBe(true);
      noteDriverEconomyGrant(session, 'adjust_treasury', { delta: { gp: perCallGrant } });
    }
    expect(session.treasuryGrantTotalThisSession).toBe(callsToFillCap * perCallGrant);
    // The next call, however small, is rejected once the cumulative session cap is reached —
    // this is the "regardless of call count" requirement: no single call exceeded
    // DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION, yet the sequence is still bounded.
    expect(guardDriverLivePlayArgs('adjust_treasury', { delta: { gp: 1 } }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_treasury_session_cap',
    });
  });

  it('noteDriverEconomyGrant accumulates treasury and inventory grants and ignores non-economy tools', () => {
    const session: { treasuryGrantTotalThisSession?: number; inventoryGrantQtyTotalThisSession?: number } = {};
    noteDriverEconomyGrant(session, 'adjust_treasury', { delta: { gp: 25, sp: 10 } });
    expect(session.treasuryGrantTotalThisSession).toBe(35);
    noteDriverEconomyGrant(session, 'add_inventory_item', { name: 'Potion', qty: 3 });
    expect(session.inventoryGrantQtyTotalThisSession).toBe(3);
    noteDriverEconomyGrant(session, 'update_inventory_item', { itemId: 1, qtyDelta: 2 });
    expect(session.inventoryGrantQtyTotalThisSession).toBe(5);
    // a negative/absent qtyDelta must not decrement or otherwise touch the counter
    noteDriverEconomyGrant(session, 'update_inventory_item', { itemId: 1, qtyDelta: -1 });
    expect(session.inventoryGrantQtyTotalThisSession).toBe(5);
    noteDriverEconomyGrant(session, 'roll_dice', { expr: '1d20' });
    expect(session.treasuryGrantTotalThisSession).toBe(35);
    expect(session.inventoryGrantQtyTotalThisSession).toBe(5);
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

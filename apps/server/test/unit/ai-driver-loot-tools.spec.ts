import { describe, it, expect } from '@jest/globals';
import { isDriverToolAllowed, guardDriverLivePlayArgs } from '../../src/modules/ai-driver/ai-driver.service';

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

  it('guardDriverLivePlayArgs blocks negative qtyDelta or qty <= 0 on update_inventory_item', () => {
    const session = { driverGeneratedMapIds: [], generateMapCallsThisTurn: 0 };
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 2 }, session)).toEqual({
      ok: true,
      args: { itemId: 1, qtyDelta: 2 },
    });
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: -1 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_reduction',
      message: 'The driver may only increase item quantities via update_inventory_item (qtyDelta must be positive).',
    });
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qty: 0 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_reduction',
      message: 'The driver may not reduce an item quantity to 0 or negative via update_inventory_item.',
    });
  });
});

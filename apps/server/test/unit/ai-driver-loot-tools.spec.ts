import { describe, it, expect } from '@jest/globals';
import {
  isDriverToolAllowed,
  guardDriverLivePlayArgs,
  formatDriverLootCombatLogDetail,
  syncAftermathGrantWindow,
  noteDriverEconomyGrant,
  DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION,
  DRIVER_INVENTORY_GRANT_MAX_QTY,
  DRIVER_TREASURY_SESSION_GRANT_CAP,
  DRIVER_INVENTORY_SESSION_GRANT_CAP,
} from '../../src/modules/ai-driver/ai-driver.service';
import { DRIVER_AFTERMATH_WINDOW_MS } from '../../src/modules/ai-driver/driver-tool-policy';

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
      message: 'The driver must provide a positive qtyDelta or metadata (name/notes/iconSlug/weight) to update_inventory_item.',
    });

    // metadata-only edits are allowed
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, name: 'Longsword +1', notes: 'magic', iconSlug: 'sword' }, session)).toEqual({
      ok: true,
      args: { itemId: 1, name: 'Longsword +1', notes: 'magic', iconSlug: 'sword' },
    });

    // Issue #2157: weight is classified as metadata alongside name/notes/iconSlug — a
    // weight-only edit (no qtyDelta) is accepted, not rejected as "nothing to do".
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, weight: 2.5 }, session)).toEqual({
      ok: true,
      args: { itemId: 1, weight: 2.5 },
    });

    // absolute qty (any value) is blocked — use qtyDelta instead
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qty: 5 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon/weight via update_inventory_item. Rejected: qty.',
    });

    // owner moves are blocked
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, ownerType: 'character' }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon/weight via update_inventory_item. Rejected: ownerType.',
    });
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, characterId: 42 }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon/weight via update_inventory_item. Rejected: characterId.',
    });

    // Issue #1326 review (Codex/Devin) — the exact exposure this PR introduced: equipping
    // gear and attaching a brand-new attack are both refused, with no dedicated denial
    // branch required for either.
    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, equipped: true, equipSlot: 'main-hand' }, session)).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon/weight via update_inventory_item. Rejected: equipped, equipSlot.',
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
      message: 'The driver may only grant item quantity or edit name/notes/icon/weight via update_inventory_item. Rejected: equippedAction.',
    });

    // Fail-closed proof: an entirely unknown field the schema has never had is refused
    // too — the allowlist rejects by omission from the allowed set, not by name, so a
    // future schema widening cannot slip through unnoticed the way equip did here.
    expect(
      guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 1, someBrandNewFieldNobodyHasAddedYet: true }, session),
    ).toEqual({
      ok: false,
      code: 'forbidden_inventory_field',
      message: 'The driver may only grant item quantity or edit name/notes/icon/weight via update_inventory_item. Rejected: someBrandNewFieldNobodyHasAddedYet.',
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

    // Issue #2157: weight passes through the same as name/notes/iconSlug — it grants no
    // new authority (no economy value, no character targeting), so it needs no dedicated
    // guard beyond allowlist membership.
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Chainmail', qty: 1, weight: 55.5 }, session),
    ).toEqual({
      ok: true,
      args: { name: 'Chainmail', qty: 1, weight: 55.5 },
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

  it('#1792: rejects newly-widened update_inventory_item fields like equipped / equipSlot / equippedAction', () => {
    const session = { driverGeneratedMapIds: [], generateMapCallsThisTurn: 0 };
    for (const unknownField of ['equipped', 'equipSlot', 'equippedAction']) {
      const result = guardDriverLivePlayArgs(
        'update_inventory_item',
        { itemId: 1, qtyDelta: 1, idempotencyKey: 'test', [unknownField]: true },
        session,
      );
      expect(result.ok).toBe(false);
    }
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

  const grantWindow = (overrides: Partial<{ encounterId: number; endedAt: string; treasuryGranted: number; inventoryQtyGranted: number }> = {}) => ({
    encounterId: 1,
    endedAt: '2026-01-01T00:00:00.000Z',
    treasuryGranted: 0,
    inventoryQtyGranted: 0,
    ...overrides,
  });

  it('#1781 / #1495: add_inventory_item and update_inventory_item share a cumulative grant cap keyed to the aftermath window', () => {
    const session = {
      driverGeneratedMapIds: [] as number[],
      generateMapCallsThisTurn: 0,
      aftermathGrantWindow: grantWindow({ inventoryQtyGranted: DRIVER_INVENTORY_SESSION_GRANT_CAP - 5 }),
    };

    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 5 }, session)).toEqual({
      ok: true,
      args: { name: 'Torch', qty: 5 },
    });

    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 6 }, session)).toEqual({
      ok: false,
      code: 'inventory_grant_cap_exceeded',
      message: `Cumulative inventory grants for this aftermath window cannot exceed ${DRIVER_INVENTORY_SESSION_GRANT_CAP}.`,
    });

    expect(guardDriverLivePlayArgs('update_inventory_item', { itemId: 1, qtyDelta: 6 }, session)).toEqual({
      ok: false,
      code: 'inventory_grant_cap_exceeded',
      message: `Cumulative inventory grants for this aftermath window cannot exceed ${DRIVER_INVENTORY_SESSION_GRANT_CAP}.`,
    });
  });

  it('#1781 / #1495: syncAftermathGrantWindow opens a fresh budget for a DIFFERENT encounter identity even with no observed profile edge', () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const now1 = Date.parse(t1) + 1000;
    const t2 = '2026-01-02T00:00:00.000Z';
    const now2 = Date.parse(t2) + 1000;

    const session = {
      aftermathGrantWindow: grantWindow({
        encounterId: 10,
        endedAt: t1,
        treasuryGranted: DRIVER_TREASURY_SESSION_GRANT_CAP,
        inventoryQtyGranted: DRIVER_INVENTORY_SESSION_GRANT_CAP,
      }),
    };

    syncAftermathGrantWindow(session, { encounterId: 10, endedAt: t1 }, now1);
    expect(session.aftermathGrantWindow).toEqual(
      grantWindow({
        encounterId: 10,
        endedAt: t1,
        treasuryGranted: DRIVER_TREASURY_SESSION_GRANT_CAP,
        inventoryQtyGranted: DRIVER_INVENTORY_SESSION_GRANT_CAP,
      }),
    );

    syncAftermathGrantWindow(session, { encounterId: 11, endedAt: t2 }, now2);
    expect(session.aftermathGrantWindow).toEqual(grantWindow({ encounterId: 11, endedAt: t2 }));
  });

  it('#1781 / #1495: syncAftermathGrantWindow clears aftermath grant window when encounter endedAt is outside DRIVER_AFTERMATH_WINDOW_MS', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const freshEndedAt = new Date(now - 1000).toISOString();
    const expiredEndedAt = new Date(now - (DRIVER_AFTERMATH_WINDOW_MS + 1000)).toISOString();

    const session: { aftermathGrantWindow?: any } = {
      aftermathGrantWindow: grantWindow({
        encounterId: 10,
        endedAt: freshEndedAt,
        treasuryGranted: 500,
        inventoryQtyGranted: 10,
      }),
    };

    // While still in window, sync retains/updates window
    syncAftermathGrantWindow(session, { encounterId: 10, endedAt: freshEndedAt }, now);
    expect(session.aftermathGrantWindow).toBeDefined();

    // When endedAt is beyond DRIVER_AFTERMATH_WINDOW_MS, sync clears aftermathGrantWindow
    syncAftermathGrantWindow(session, { encounterId: 10, endedAt: expiredEndedAt }, now);
    expect(session.aftermathGrantWindow).toBeUndefined();
  });

  it('#1781 / #1495: adjust_treasury enforces a cumulative grant cap regardless of call count', () => {
    const session = {
      driverGeneratedMapIds: [] as number[],
      generateMapCallsThisTurn: 0,
      aftermathGrantWindow: grantWindow(),
    };

    const perCallGrant = 1_000;
    const callsToFillCap = Math.floor(DRIVER_TREASURY_SESSION_GRANT_CAP / perCallGrant);
    for (let i = 0; i < callsToFillCap; i++) {
      const result = guardDriverLivePlayArgs('adjust_treasury', { delta: { gp: perCallGrant } }, session);
      expect(result.ok).toBe(true);
      noteDriverEconomyGrant(session, 'adjust_treasury', { delta: { gp: perCallGrant } });
    }
    expect(session.aftermathGrantWindow.treasuryGranted).toBe(callsToFillCap * perCallGrant);

    expect(guardDriverLivePlayArgs('adjust_treasury', { delta: { gp: 1 } }, session)).toMatchObject({
      ok: false,
      code: 'treasury_grant_cap_exceeded',
    });
  });
});

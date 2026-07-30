import { describe, it, expect } from '@jest/globals';
import {
  isDriverToolAllowed,
  guardDriverLivePlayArgs,
  formatDriverLootCombatLogDetail,
  noteDriverEconomyGrant,
  releaseDriverEconomyGrant,
  syncAftermathGrantWindow,
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

  /** A tracked economy-grant window for a given ended encounter (#1495). */
  const grantWindow = (overrides: Partial<{ encounterId: number; endedAt: string; treasuryGranted: number; inventoryQtyGranted: number }> = {}) => ({
    encounterId: 1,
    endedAt: '2026-01-01T00:00:00.000Z',
    treasuryGranted: 0,
    inventoryQtyGranted: 0,
    ...overrides,
  });

  it('#1495: add_inventory_item and update_inventory_item share a cumulative grant cap keyed to the aftermath window', () => {
    const session = {
      driverGeneratedMapIds: [] as number[],
      generateMapCallsThisTurn: 0,
      aftermathGrantWindow: grantWindow({ inventoryQtyGranted: DRIVER_INVENTORY_SESSION_GRANT_CAP - 5 }),
    };

    // still 5 qty of room left in the window's budget: a grant of 5 fits exactly...
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 5 }, session)).toEqual({
      ok: true,
      args: { name: 'Torch', qty: 5 },
    });
    // ...but one more than that overflows the cap, even though it is well under the per-call
    // cap on its own.
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 6 }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_inventory_session_cap',
    });
    // update_inventory_item draws on the SAME window budget (#1495) — a qtyDelta that would
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

  it('#1495: without a tracked aftermath window (campaign has never had an encounter end), the cumulative cap is inert but per-call caps still apply', () => {
    const session = { driverGeneratedMapIds: [] as number[], generateMapCallsThisTurn: 0, aftermathGrantWindow: null };
    expect(guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: 5 }, session)).toEqual({
      ok: true,
      args: { name: 'Torch', qty: 5 },
    });
    expect(
      guardDriverLivePlayArgs('add_inventory_item', { name: 'Torch', qty: DRIVER_INVENTORY_GRANT_MAX_QTY + 1 }, session),
    ).toMatchObject({ ok: false, code: 'forbidden_inventory_grant_limit' });
  });

  it('#1495: syncAftermathGrantWindow opens a fresh budget for a DIFFERENT encounter identity even with no observed profile edge', () => {
    // Regression for the Codex :3881 finding: if a fight's aftermath spends its allowance and no
    // AI turn runs while that window expires, then a LATER fight ends, an edge-detection reset
    // (only firing on a non-aftermath -> aftermath TRANSITION) would never fire if this session
    // never observed anything but `aftermath` in between. Keying to the actual encounter
    // identity instead closes it: a different id/endedAt is always a fresh window, whether or
    // not any turn ran to see the transition.
    const session = {
      aftermathGrantWindow: grantWindow({
        encounterId: 10,
        endedAt: '2026-01-01T00:00:00.000Z',
        treasuryGranted: DRIVER_TREASURY_SESSION_GRANT_CAP,
        inventoryQtyGranted: DRIVER_INVENTORY_SESSION_GRANT_CAP,
      }),
    };
    // The SAME encounter identity observed again keeps the exhausted totals (still the same
    // window — nothing should reset just because this function ran again).
    syncAftermathGrantWindow(session, { encounterId: 10, endedAt: '2026-01-01T00:00:00.000Z' });
    expect(session.aftermathGrantWindow).toEqual(
      grantWindow({
        encounterId: 10,
        endedAt: '2026-01-01T00:00:00.000Z',
        treasuryGranted: DRIVER_TREASURY_SESSION_GRANT_CAP,
        inventoryQtyGranted: DRIVER_INVENTORY_SESSION_GRANT_CAP,
      }),
    );

    // A LATER fight's identity — a different encounter id — opens a fresh, zeroed budget, with
    // no non-aftermath profile ever having been observed in between.
    syncAftermathGrantWindow(session, { encounterId: 11, endedAt: '2026-01-02T00:00:00.000Z' });
    expect(session.aftermathGrantWindow).toEqual(grantWindow({ encounterId: 11, endedAt: '2026-01-02T00:00:00.000Z' }));
  });

  it('#1495: adjust_treasury enforces a cumulative grant cap regardless of call count', () => {
    const session = {
      driverGeneratedMapIds: [] as number[],
      generateMapCallsThisTurn: 0,
      aftermathGrantWindow: grantWindow(),
    };
    // Simulate many small, individually-legal grants accumulating toward the cap.
    const perCallGrant = 1_000;
    const callsToFillCap = Math.floor(DRIVER_TREASURY_SESSION_GRANT_CAP / perCallGrant);
    for (let i = 0; i < callsToFillCap; i++) {
      const result = guardDriverLivePlayArgs('adjust_treasury', { delta: { gp: perCallGrant } }, session);
      expect(result.ok).toBe(true);
      noteDriverEconomyGrant(session, 'adjust_treasury', { delta: { gp: perCallGrant } });
    }
    expect(session.aftermathGrantWindow.treasuryGranted).toBe(callsToFillCap * perCallGrant);
    // The next call, however small, is rejected once the cumulative cap is reached — this is
    // the "regardless of call count" requirement: no single call exceeded
    // DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION, yet the sequence is still bounded.
    expect(guardDriverLivePlayArgs('adjust_treasury', { delta: { gp: 1 } }, session)).toMatchObject({
      ok: false,
      code: 'forbidden_treasury_session_cap',
    });
  });

  it('#1495: two grants QUEUED in sequence (guard + reserve, one call at a time) cannot both pass against the same stale total', () => {
    // Regression for the Codex :6364 finding: eleven qty:100 grants, each individually legal,
    // would total 1,100 against a 1,000-item cap if nothing accumulated between them. Per the
    // #1495 round-3 redesign, guard-then-reserve now happens at QUEUE time (see
    // executeToolCalls), not at approval — reserving one call at a time inside the single-flight
    // turn loop is what makes concurrently-approved confirmations race-free later (approval only
    // verifies the reservation's window is still current; it never re-runs this check). This
    // test drives that queue-time sequence directly: guard, then reserve, for two grants back to
    // back, proving the second sees the first one's already-recorded total.
    const session = {
      driverGeneratedMapIds: [] as number[],
      generateMapCallsThisTurn: 0,
      aftermathGrantWindow: grantWindow({ inventoryQtyGranted: DRIVER_INVENTORY_SESSION_GRANT_CAP - 100 }),
    };
    const grantArgs = { name: 'Potion of Healing', qty: 100 };

    // First grant queued: exactly fills the remaining budget.
    const first = guardDriverLivePlayArgs('add_inventory_item', grantArgs, session);
    expect(first.ok).toBe(true);
    noteDriverEconomyGrant(session, 'add_inventory_item', grantArgs);
    expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(DRIVER_INVENTORY_SESSION_GRANT_CAP);

    // A second, identical grant queued right after: rejected against the now-updated total — no
    // early return skips this assertion, and the outcome does not depend on any random roll.
    const second = guardDriverLivePlayArgs('add_inventory_item', grantArgs, session);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('forbidden_inventory_session_cap');
  });

  it('noteDriverEconomyGrant accumulates treasury and inventory grants and ignores non-economy tools', () => {
    const session = { aftermathGrantWindow: grantWindow() };
    noteDriverEconomyGrant(session, 'adjust_treasury', { delta: { gp: 25, sp: 10 } });
    expect(session.aftermathGrantWindow.treasuryGranted).toBe(35);
    noteDriverEconomyGrant(session, 'add_inventory_item', { name: 'Potion', qty: 3 });
    expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(3);
    noteDriverEconomyGrant(session, 'update_inventory_item', { itemId: 1, qtyDelta: 2 });
    expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(5);
    // a negative/absent qtyDelta must not decrement or otherwise touch the counter
    noteDriverEconomyGrant(session, 'update_inventory_item', { itemId: 1, qtyDelta: -1 });
    expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(5);
    noteDriverEconomyGrant(session, 'roll_dice', { expr: '1d20' });
    expect(session.aftermathGrantWindow.treasuryGranted).toBe(35);
    expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(5);
  });

  it('noteDriverEconomyGrant is a no-op with no tracked window (nothing to attribute the grant to)', () => {
    const session: { aftermathGrantWindow: ReturnType<typeof grantWindow> | null } = { aftermathGrantWindow: null };
    noteDriverEconomyGrant(session, 'adjust_treasury', { delta: { gp: 25 } });
    expect(session.aftermathGrantWindow).toBeNull();
  });

  describe('releaseDriverEconomyGrant (#1495 — undoing a queue-time reservation on reject/execution failure)', () => {
    it('releases a reservation when the current window still matches the one it was reserved against', () => {
      const session = { aftermathGrantWindow: grantWindow({ encounterId: 5, endedAt: '2026-02-01T00:00:00.000Z', inventoryQtyGranted: 80 }) };
      releaseDriverEconomyGrant(session, 'add_inventory_item', { name: 'Potion', qty: 30 }, { encounterId: 5, endedAt: '2026-02-01T00:00:00.000Z' });
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(50);
    });

    it('is a no-op when the window has since moved on to a different encounter (nothing live to credit back into)', () => {
      // The window was superseded by a LATER fight between reservation and release — releasing
      // into the CURRENT (different) window would incorrectly credit an unrelated fight's budget.
      const session = { aftermathGrantWindow: grantWindow({ encounterId: 11, endedAt: '2026-02-02T00:00:00.000Z', inventoryQtyGranted: 40 }) };
      releaseDriverEconomyGrant(session, 'add_inventory_item', { name: 'Potion', qty: 30 }, { encounterId: 5, endedAt: '2026-02-01T00:00:00.000Z' });
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(40);
    });

    it('is a no-op when nothing was reserved (reservedWindow is undefined)', () => {
      const session = { aftermathGrantWindow: grantWindow({ inventoryQtyGranted: 40 }) };
      releaseDriverEconomyGrant(session, 'add_inventory_item', { name: 'Potion', qty: 30 }, undefined);
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(40);
    });

    it('never releases a window below zero, even if called more than once for the same reservation', () => {
      const session = { aftermathGrantWindow: grantWindow({ encounterId: 5, endedAt: '2026-02-01T00:00:00.000Z', inventoryQtyGranted: 10 }) };
      const window = { encounterId: 5, endedAt: '2026-02-01T00:00:00.000Z' };
      releaseDriverEconomyGrant(session, 'add_inventory_item', { name: 'Potion', qty: 30 }, window);
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(0);
      releaseDriverEconomyGrant(session, 'add_inventory_item', { name: 'Potion', qty: 30 }, window);
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(0);
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

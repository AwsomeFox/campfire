/**
 * End-turn gate priority (issue #1933) — pins which reason wins when a safety hold, the
 * sync gate, and the `dmControlsTurns` setting are true at once, without a browser.
 */
import { expect, test } from '@playwright/test';
import { turnEndGateReason } from '../../src/features/encounters/turnEndGate';

const BASE = {
  canEndTurn: true,
  isYourTurn: true,
  dmControlsTurns: false,
  safetyHoldActive: false,
  syncBlocked: false,
};

test.describe('turnEndGateReason (issue #1933)', () => {
  test('nothing blocking: no reason', () => {
    expect(turnEndGateReason(BASE)).toBeNull();
  });

  test('a safety hold wins over everything else, even when canEndTurn is false too', () => {
    expect(turnEndGateReason({ ...BASE, safetyHoldActive: true })).toBe('safetyHold');
    expect(
      turnEndGateReason({
        ...BASE,
        canEndTurn: false,
        dmControlsTurns: true,
        safetyHoldActive: true,
        syncBlocked: true,
      }),
    ).toBe('safetyHold');
  });

  test('canEndTurn true but the sync gate is blocking: syncBlocked', () => {
    expect(turnEndGateReason({ ...BASE, syncBlocked: true })).toBe('syncBlocked');
  });

  test('a player on their own turn but the DM controls turns: dmControlsTurns', () => {
    expect(
      turnEndGateReason({ ...BASE, canEndTurn: false, isYourTurn: true, dmControlsTurns: true }),
    ).toBe('dmControlsTurns');
  });

  test('canEndTurn false but neither isYourTurn nor dmControlsTurns applies: no reason (unreachable in practice — TurnWorkspace only renders for the DM or the current owner)', () => {
    expect(
      turnEndGateReason({ ...BASE, canEndTurn: false, isYourTurn: false, dmControlsTurns: false }),
    ).toBeNull();
  });

  test('syncBlocked is ignored once canEndTurn is already false for a different reason', () => {
    // dmControlsTurns wins; syncBlocked does not also apply once the button is
    // fundamentally not the player's to press right now.
    expect(
      turnEndGateReason({ ...BASE, canEndTurn: false, dmControlsTurns: true, syncBlocked: true }),
    ).toBe('dmControlsTurns');
  });
});

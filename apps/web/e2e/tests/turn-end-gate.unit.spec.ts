/**
 * End-turn gate priority (issue #1933) — pins which reason wins when a safety hold, the
 * sync gate, and the `dmControlsTurns` setting are true at once, without a browser.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  test('a plain onlooker (not the DM, not this turn\'s owner): no reason — applicability wins over dmControlsTurns', () => {
    // TurnWorkspace renders for every viewer of a running encounter, not only the DM/owner
    // (only its action-economy detail section is owner/DM-gated) — a true onlooker reaches
    // this resolver with both canEndTurn and isYourTurn false.
    expect(
      turnEndGateReason({ ...BASE, canEndTurn: false, isYourTurn: false, dmControlsTurns: false }),
    ).toBeNull();
  });

  test('a plain onlooker during a safety hold STILL gets no reason — applicability must be decided before the hold, or a disabled End-turn button flickers into existence for viewers who never had one', () => {
    expect(
      turnEndGateReason({
        ...BASE,
        canEndTurn: false,
        isYourTurn: false,
        dmControlsTurns: false,
        safetyHoldActive: true,
      }),
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

/**
 * The resolver is pure and knows nothing about in-flight requests, so the busy suppression
 * lives at the adoption site — and a pure test cannot see a component that forgets it
 * (issue #1933 review). `showButton` must keep keying off the UNsuppressed reason, or an
 * in-flight request would make the button vanish for a player who had one.
 */
test.describe('TurnWorkspace adoption (issue #1933)', () => {
  test('the end-turn reason is suppressed while busy, but applicability is not', () => {
    const code = readFileSync(
      resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx'),
      'utf8',
    );
    // Narrow flag on purpose: the broad `busy` also covers unrelated action-economy
    // writes, and suppressing on those would blank a standing dmControlsTurns explanation
    // mid-save (issue #1933 review).
    expect(code).toMatch(/const gateReason = gateReasonKey && !endTurnBusy \? t\(`run\.gate\.\$\{gateReasonKey\}`\) : undefined;/);
    expect(code).not.toMatch(/gateReasonKey && !busy/);
    expect(code).toMatch(/const showButton = turn\.canEndTurn \|\| gateReasonKey != null;/);
  });
});

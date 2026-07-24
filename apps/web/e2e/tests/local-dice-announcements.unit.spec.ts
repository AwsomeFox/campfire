import { expect, test } from '@playwright/test';
import {
  clearLocalDiceAnnouncements,
  rememberLocalDiceAnnouncement,
  takeLocalDiceAnnouncements,
} from '../../src/features/dice/localDiceAnnouncements';
import { advanceDiceRollAnnouncements } from '../../src/features/dice/diceLogAccessibility';
import type { DiceRoll } from '@campfire/schema';

function roll(id: number): DiceRoll {
  return {
    id,
    campaignId: 7,
    expr: '1d20',
    total: 15,
    rolls: [15],
    label: 'Aldra · Athletics',
    kept: undefined,
    dc: undefined,
    success: undefined,
    rollerUserId: 'user:1',
    rollerName: 'DM',
    createdAt: '2026-07-23T00:00:00.000Z',
  };
}

test.describe('local dice announcement dedupe (#590)', () => {
  test('baseline swallows ids already spoken by useRoller without announcing history', () => {
    clearLocalDiceAnnouncements(7);
    rememberLocalDiceAnnouncement(7, 42);
    const localIds = takeLocalDiceAnnouncements(7);
    expect(localIds.has(42)).toBe(true);

    const history = [roll(42), roll(41)];
    const baseline = advanceDiceRollAnnouncements(history, null);
    for (const id of localIds) baseline.cursor.seenRollIds.add(id);
    expect(baseline.appendedRolls).toEqual([]);

    const next = advanceDiceRollAnnouncements([roll(43), ...history], baseline.cursor);
    expect(next.appendedRolls.map((r) => r.id)).toEqual([43]);
  });

  test('merged cursor skips a local id that arrives on a later poll', () => {
    clearLocalDiceAnnouncements(7);
    const baseline = advanceDiceRollAnnouncements([roll(10)], null);
    rememberLocalDiceAnnouncement(7, 11);
    const merged = {
      seenRollIds: new Set([...baseline.cursor.seenRollIds, ...takeLocalDiceAnnouncements(7)]),
    };
    const advanced = advanceDiceRollAnnouncements([roll(11), roll(10)], merged);
    expect(advanced.appendedRolls).toEqual([]);
  });
});

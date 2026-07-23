import { expect, test } from '@playwright/test';
import {
  clearLocalDiceAnnouncements,
  rememberLocalDiceAnnouncement,
  takeLocalDiceAnnouncements,
} from '../../src/features/dice/localDiceAnnouncements';
import { advanceDiceRollAnnouncements } from '../../src/features/dice/diceLogAccessibility';

test.describe('local dice announcement dedupe (#590)', () => {
  test('SharedDiceLog cursor swallows ids already spoken by useRoller', () => {
    clearLocalDiceAnnouncements(7);
    rememberLocalDiceAnnouncement(7, 42);
    const seeded = { seenIds: takeLocalDiceAnnouncements(7) };
    expect(seeded.seenIds.has(42)).toBe(true);
    const advanced = advanceDiceRollAnnouncements(
      [{ id: 42, expr: '1d20', total: 15, label: 'Aldra · Athletics', kept: null, dc: null, success: null, userName: 'DM', createdAt: '2026-07-23T00:00:00.000Z' } as any],
      seeded,
    );
    expect(advanced.appendedRolls).toEqual([]);
  });
});

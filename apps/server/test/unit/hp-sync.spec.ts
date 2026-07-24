import { canWriteBackHp, hpSyncSliceOf, hpSyncSlicesEqual } from '../../src/modules/encounters/hp-sync';

describe('hp-sync helpers (issue #466)', () => {
  const combat = {
    hpCurrent: 5,
    hpTemp: 0,
    deathState: 'none' as const,
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
  };
  const healed = { ...combat, hpCurrent: 20 };

  it('detects equal vs divergent slices', () => {
    expect(hpSyncSlicesEqual(combat, hpSyncSliceOf(combat))).toBe(true);
    expect(hpSyncSlicesEqual(combat, healed)).toBe(false);
  });

  it('allows write-back when slices already match', () => {
    expect(
      canWriteBackHp({
        sheet: { ...healed, updatedAt: 't2' },
        combatant: healed,
        sheetSyncedUpdatedAt: 't1',
      }),
    ).toBe(true);
  });

  it('allows write-back when the CAS token still matches the sheet', () => {
    expect(
      canWriteBackHp({
        sheet: { ...combat, updatedAt: 't1' },
        combatant: combat,
        sheetSyncedUpdatedAt: 't1',
      }),
    ).toBe(true);
    // Token matches even if we are about to overwrite a matching-token sheet with a
    // different combat snapshot (intentional keep_combatant after reopen).
    expect(
      canWriteBackHp({
        sheet: { ...healed, updatedAt: 't2' },
        combatant: combat,
        sheetSyncedUpdatedAt: 't2',
      }),
    ).toBe(true);
  });

  it('allows legacy rows with a null CAS token (first sync after upgrade)', () => {
    expect(
      canWriteBackHp({
        sheet: { ...healed, updatedAt: 't9' },
        combatant: combat,
        sheetSyncedUpdatedAt: null,
      }),
    ).toBe(true);
  });

  it('refuses write-back when the sheet advanced past the CAS token and HP differs', () => {
    expect(
      canWriteBackHp({
        sheet: { ...healed, updatedAt: 't2' },
        combatant: combat,
        sheetSyncedUpdatedAt: 't1',
      }),
    ).toBe(false);
  });
});

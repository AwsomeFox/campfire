/**
 * Issue #466 — reopen/re-end must not silently overwrite newer character-sheet HP.
 *
 * After /end, combatant rows are a historical snapshot while the sheet can still
 * change (heal, rest, another fight). Reopening preserves that snapshot; ending
 * again used to write it back blindly. These helpers compare the combat HP slice
 * against the live sheet and decide whether a CAS write-back is safe.
 */

export type HpSyncDeathState = 'none' | 'dying' | 'stable' | 'dead';

export type HpSyncSlice = {
  hpCurrent: number;
  hpTemp: number;
  deathState: HpSyncDeathState;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
};

export type HpSyncConflict = {
  combatantId: number;
  characterId: number;
  name: string;
  combatant: HpSyncSlice;
  sheet: HpSyncSlice & { updatedAt: string };
};

export type HpResyncDirection = 'keep_combatant' | 'pull_sheet';

export function hpSyncSliceOf(row: {
  hpCurrent: number;
  hpTemp: number;
  deathState: string;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
}): HpSyncSlice {
  return {
    hpCurrent: row.hpCurrent,
    hpTemp: row.hpTemp,
    deathState: row.deathState as HpSyncDeathState,
    deathSaveSuccesses: row.deathSaveSuccesses,
    deathSaveFailures: row.deathSaveFailures,
  };
}

export function hpSyncSlicesEqual(a: HpSyncSlice, b: HpSyncSlice): boolean {
  return (
    a.hpCurrent === b.hpCurrent &&
    a.hpTemp === b.hpTemp &&
    a.deathState === b.deathState &&
    a.deathSaveSuccesses === b.deathSaveSuccesses &&
    a.deathSaveFailures === b.deathSaveFailures
  );
}

/**
 * True when ending may safely write the combatant snapshot onto the sheet:
 * either the slices already match, the combatant still holds the sheet's CAS
 * token from the last sync, or the token was never recorded (legacy row — first
 * end after upgrade is allowed, then the token is stamped).
 */
export function canWriteBackHp(opts: {
  sheet: HpSyncSlice & { updatedAt: string };
  combatant: HpSyncSlice;
  sheetSyncedUpdatedAt: string | null | undefined;
}): boolean {
  if (hpSyncSlicesEqual(opts.sheet, opts.combatant)) return true;
  if (opts.sheetSyncedUpdatedAt == null || opts.sheetSyncedUpdatedAt === '') return true;
  return opts.sheet.updatedAt === opts.sheetSyncedUpdatedAt;
}

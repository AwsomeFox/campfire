/**
 * Encounter DM header lifecycle matrix (issue #420).
 *
 * Preparing used to show End; confirming it 400'd ("must be 'running' to end")
 * and left the dialog stuck. Controls must follow the server status machine.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deleteConfirmCopy,
  dmLifecycleActions,
  isLifecycleConfirmValid,
  type EncounterLifecycleStatus,
} from '../../src/features/encounters/encounterLifecycleActions';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const DM_LIFECYCLE_HEADER = resolve(__dirname, '../../src/features/encounters/DmLifecycleHeader.tsx');

const STATUSES: EncounterLifecycleStatus[] = ['preparing', 'running', 'ended'];

test.describe('encounter lifecycle actions matrix (issue #420)', () => {
  test('End is only allowed while running', () => {
    expect(dmLifecycleActions('preparing').end).toBe(false);
    expect(dmLifecycleActions('running').end).toBe(true);
    expect(dmLifecycleActions('ended').end).toBe(false);
  });

  test('every status/action combination matches the server lifecycle', () => {
    const expected: Record<
      EncounterLifecycleStatus,
      { end: boolean; reopen: boolean; delete: boolean; start: boolean; nextTurn: boolean; undoTurn: boolean; rollInitiative: boolean }
    > = {
      preparing: { end: false, reopen: false, delete: true, start: true, nextTurn: false, undoTurn: false, rollInitiative: true },
      running: { end: true, reopen: false, delete: false, start: false, nextTurn: true, undoTurn: true, rollInitiative: true },
      ended: { end: false, reopen: true, delete: true, start: false, nextTurn: false, undoTurn: false, rollInitiative: false },
    };

    for (const status of STATUSES) {
      expect(dmLifecycleActions(status), status).toEqual(expected[status]);
    }
  });

  test('stale confirmations are invalid when status no longer allows the action', () => {
    expect(isLifecycleConfirmValid('end', 'preparing')).toBe(false);
    expect(isLifecycleConfirmValid('end', 'running')).toBe(true);
    expect(isLifecycleConfirmValid('reopen', 'running')).toBe(false);
    expect(isLifecycleConfirmValid('reopen', 'ended')).toBe(true);
    expect(isLifecycleConfirmValid('delete', 'running')).toBe(false);
    expect(isLifecycleConfirmValid('delete', 'preparing')).toBe(true);
  });

  test('preparing delete/cancel copy states abandon-prep consequences (no sheet write-back)', () => {
    const preparing = deleteConfirmCopy('preparing');
    expect(preparing.title).toMatch(/Cancel/i);
    expect(preparing.body).toMatch(/character sheets/i);
    expect(preparing.body.toLowerCase()).not.toMatch(/irreversible write|hp write/);

    const ended = deleteConfirmCopy('ended');
    expect(ended.title).toMatch(/Delete/i);
    expect(ended.body).toMatch(/Trash/i);
    expect(ended.body).toMatch(/Combatants/i);
  });

  test('the DM lifecycle header renders End from the lifecycle matrix, not status !== ended', () => {
    const runSessionSource = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const lifecycleHeaderSource = readFileSync(DM_LIFECYCLE_HEADER, 'utf8');
    expect(runSessionSource).toMatch(/dmLifecycleActions/);
    expect(lifecycleHeaderSource).toMatch(/export type Props/);
    expect(lifecycleHeaderSource).toMatch(/if \(!canDmWrite\) return null/);
    expect(lifecycleHeaderSource).toMatch(/lifecycle\.end/);
    // The old bug: End for every non-ended state (including preparing).
    expect(lifecycleHeaderSource).not.toMatch(/status\s*!==\s*['"]ended['"]\s*&&\s*\n\s*<Btn[^>]*danger[^>]*>\s*\n\s*End/m);
    expect(lifecycleHeaderSource).not.toMatch(/status !== 'ended' && \(\s*\n\s*<Btn ghost danger[^>]*>\s*End/m);
  });
});

/**
 * Death-save controls: which blocker owns the gate reason (issue #1933 review round 2).
 *
 * `GatedControl` deliberately strips the native `disabled` attribute whenever a reason is
 * present, so the control stays focusable and can announce why it is off. That trade is
 * right for a transient gate the viewer can simply wait out, and wrong for a permanent one:
 * `DeathSavePips` renders for EVERY viewer, and passing the sync-outage reason
 * unconditionally handed a viewer with no edit permission a focusable, `aria-disabled` pip
 * announced as "paused while reconnecting" — when permission, not the outage, is what blocks
 * them, and no amount of waiting will change it. The same applied to the Roll button while a
 * request was already in flight (`busy`).
 *
 * Returning `undefined` in those cases leaves the control natively disabled, which is the
 * honest state: not yours / not right now, with no reason claimed. The click was always
 * swallowed either way — the defect was the misleading state and reason, not a write leak.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { syncGateReason } from '../../src/features/encounters/combat/DeathSaves';

const REASON = 'Paused while reconnecting to live updates.';
const DEATH_SAVES_FILE = resolve(__dirname, '../../src/features/encounters/combat/DeathSaves.tsx');

test.describe('syncGateReason (issue #1933)', () => {
  const base = { canEditPermission: true, busy: false, syncBlocked: true, syncBlockedReason: REASON };

  test('the sync gate is the operative blocker: claim it', () => {
    expect(syncGateReason(base)).toBe(REASON);
  });

  test('no permission: stay natively disabled rather than claim a reconnect', () => {
    expect(syncGateReason({ ...base, canEditPermission: false })).toBeUndefined();
  });

  test('a request already in flight: busy is not a sync outage', () => {
    expect(syncGateReason({ ...base, busy: true })).toBeUndefined();
  });

  test('not sync-blocked at all: no reason', () => {
    expect(syncGateReason({ ...base, syncBlocked: false })).toBeUndefined();
  });

  test('permission outranks the outage even when both are true', () => {
    expect(syncGateReason({ ...base, canEditPermission: false, syncBlocked: true })).toBeUndefined();
  });
});

test.describe('DeathSaves adoption sites (issue #1933)', () => {
  /**
   * The resolver above is only worth anything if both adoption sites actually route through
   * it. A unit test on the pure function cannot see a component that goes back to passing
   * `syncBlockedReason` straight into `GatedControl` — which is exactly how this shipped the
   * first time — so pin the source too.
   */
  test('neither GatedControl takes the raw syncBlockedReason', () => {
    const code = readFileSync(DEATH_SAVES_FILE, 'utf8');

    expect(code).toMatch(/<GatedControl key=\{i\} reason=\{gateReason\}>/);
    expect(code).toMatch(/<GatedControl reason=\{rollGateReason\}>/);
    expect(code).not.toMatch(/<GatedControl[^>]*reason=\{syncBlockedReason\}/);
  });
});

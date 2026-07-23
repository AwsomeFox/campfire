/**
 * Issue #853 — route-bound editors must not mutate the newly navigated target
 * with stale prior record state.
 *
 * DOM-free specs for the shared sequencer + commit/mutation guards used by
 * LocationPage, SessionsPage, and CampaignSettingsPage. Covers rapid A→B,
 * out-of-order commits, B-failure clearing, edit-during-navigation refusal,
 * nested location / session / campaign identity switches, and the invariant
 * that a B mutation payload never carries A's identifiers.
 */
import { expect, test } from '@playwright/test';
import {
  assertMutationTarget,
  decideRouteBoundCommit,
  mutationsEnabledForRoute,
  payloadContainsForeignId,
  recordAfterLoadFailure,
  recordMatchesRoute,
  RouteBoundLoadSequencer,
} from '../../src/lib/routeBoundRecord';

test.describe('RouteBoundLoadSequencer + commit guards (#853)', () => {
  test('rapid A→B: only B\'s generation may commit', () => {
    const sequencer = new RouteBoundLoadSequencer();
    const a = sequencer.begin(101);
    const b = sequencer.begin(202);
    expect(sequencer.isCurrent(a.generation, 101)).toBe(false);
    expect(sequencer.isCurrent(b.generation, 202)).toBe(true);

    const stale = decideRouteBoundCommit(sequencer, a.generation, 101, { id: 101, name: 'A' });
    expect(stale.kind).toBe('ignore');
    if (stale.kind === 'ignore') expect(stale.reason).toBe('stale-generation');

    const fresh = decideRouteBoundCommit(sequencer, b.generation, 202, { id: 202, name: 'B' });
    expect(fresh).toEqual({ kind: 'commit', record: { id: 202, name: 'B' } });
  });

  test('out-of-order: late A response after B begin is ignored', () => {
    const sequencer = new RouteBoundLoadSequencer();
    const a = sequencer.begin(1);
    const b = sequencer.begin(2);
    // A resolves after B started — must not paint.
    expect(decideRouteBoundCommit(sequencer, a.generation, 1, { id: 1 }).kind).toBe('ignore');
    expect(decideRouteBoundCommit(sequencer, b.generation, 2, { id: 2 }).kind).toBe('commit');
  });

  test('identity mismatch: cached/misrouted body for A never commits on B', () => {
    const sequencer = new RouteBoundLoadSequencer();
    const b = sequencer.begin(2);
    const decision = decideRouteBoundCommit(sequencer, b.generation, 2, { id: 1, body: 'A secret' });
    expect(decision.kind).toBe('ignore');
    if (decision.kind === 'ignore') expect(decision.reason).toBe('identity-mismatch');
  });

  test('B-failure clears painted state so prior content is not presented', () => {
    expect(recordAfterLoadFailure({ id: 1, name: 'A' }, 2)).toBeNull();
    expect(recordAfterLoadFailure({ id: 2, name: 'B' }, 2)).toBeNull();
    expect(recordAfterLoadFailure(null, 2)).toBeNull();
  });

  test('edit-during-navigation: mutations blocked until record matches route', () => {
    expect(mutationsEnabledForRoute({ id: 1 }, 2, false)).toBe(false);
    expect(mutationsEnabledForRoute({ id: 2 }, 2, true)).toBe(false);
    expect(mutationsEnabledForRoute(null, 2, true)).toBe(false);
    expect(mutationsEnabledForRoute({ id: 2 }, 2, false)).toBe(true);
    expect(assertMutationTarget(1, 2)).toEqual({ ok: false, reason: 'route-mismatch' });
    expect(assertMutationTarget(null, 2)).toEqual({ ok: false, reason: 'no-record' });
    expect(assertMutationTarget(2, 2)).toEqual({ ok: true });
  });

  test('nested location / session / campaign switches key by entity id', () => {
    // Parent→child location, session list selection, and campaign settings all
    // share the same match helper — the painted id must equal the route id.
    expect(recordMatchesRoute({ id: 10 }, 10)).toBe(true);
    expect(recordMatchesRoute({ id: 10 }, 11)).toBe(false);
    expect(recordMatchesRoute(null, 10)).toBe(false);

    const sequencer = new RouteBoundLoadSequencer();
    const parent = sequencer.begin(10);
    const child = sequencer.begin(11);
    expect(decideRouteBoundCommit(sequencer, parent.generation, 10, { id: 10 }).kind).toBe('ignore');
    expect(decideRouteBoundCommit(sequencer, child.generation, 11, { id: 11 }).kind).toBe('commit');
  });

  test('invalidate aborts in-flight work and rejects late commits', () => {
    const sequencer = new RouteBoundLoadSequencer();
    const a = sequencer.begin(5);
    expect(a.signal.aborted).toBe(false);
    sequencer.invalidate();
    expect(a.signal.aborted).toBe(true);
    expect(sequencer.isCurrent(a.generation, 5)).toBe(false);
  });

  test('no B request/payload may contain A\'s content or identifiers', () => {
    const routeId = 202;
    const foreignId = 101;
    // A mutation body that still carries A's id must be rejected by tests/callers.
    expect(payloadContainsForeignId({ name: 'from A', parentId: foreignId }, foreignId, routeId)).toBe(true);
    expect(payloadContainsForeignId({ name: 'clean', parentId: null }, foreignId, routeId)).toBe(false);
    expect(payloadContainsForeignId({ recap: 'A secret prose', expectedUpdatedAt: 't' }, foreignId, routeId)).toBe(false);
    // When gate refuses the write, callers never send — assertMutationTarget is the guard.
    expect(assertMutationTarget(foreignId, routeId).ok).toBe(false);
  });
});

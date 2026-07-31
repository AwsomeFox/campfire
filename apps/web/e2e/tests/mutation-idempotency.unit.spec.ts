import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  beginReconcile,
  blocksFurtherActions,
  clearReconcile,
  completeReconcile,
  IDLE_RECONCILE,
  isAmbiguousOutcome,
} from '../../src/lib/ambiguousMutation';
import { newOperationId, retryProtectedMutation } from '../../src/lib/keyedMutation';
import { ApiError } from '../../src/lib/api';
import { ApiAmbiguousMutationError } from '../../src/lib/apiTimeouts';

test.describe('mutation idempotency client seam (#580)', () => {
  test('operation ids are unique per call — one per intent, not one per endpoint', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newOperationId()));
    expect(ids.size).toBe(200);
  });

  test('a mutation timeout is ambiguous — the write may have committed', () => {
    expect(isAmbiguousOutcome(new ApiAmbiguousMutationError())).toBe(true);
  });

  test('gateway 502/503/504 are ambiguous; app-produced statuses are not', () => {
    // A proxy giving up says nothing about whether the backend applied the write.
    expect(isAmbiguousOutcome(new ApiError(502, 'bad gateway'))).toBe(true);
    expect(isAmbiguousOutcome(new ApiError(503, 'unavailable'))).toBe(true);
    expect(isAmbiguousOutcome(new ApiError(504, 'gateway timeout'))).toBe(true);
    // These came from the application itself, which means it decided: nothing committed.
    expect(isAmbiguousOutcome(new ApiError(409, 'conflict'))).toBe(false);
    expect(isAmbiguousOutcome(new ApiError(403, 'forbidden'))).toBe(false);
    expect(isAmbiguousOutcome(new ApiError(500, 'boom'))).toBe(false);
  });

  test('a bare network failure is ambiguous — a dropped socket has no status', () => {
    expect(isAmbiguousOutcome(new TypeError('Failed to fetch'))).toBe(true);
  });

  test('retry is refused for 4xx (a reused-key 409 must never be retried)', () => {
    expect(retryProtectedMutation(0, new ApiError(409, 'IDEMPOTENCY_KEY_REUSE'))).toBe(false);
    expect(retryProtectedMutation(0, new ApiError(404, 'gone'))).toBe(false);
  });

  test('retry is allowed exactly once for the ambiguous cases the key protects', () => {
    expect(retryProtectedMutation(0, new ApiError(502, 'bad gateway'))).toBe(true);
    expect(retryProtectedMutation(0, new ApiAmbiguousMutationError())).toBe(true);
    // …and only once: a second failure stops, rather than hammering an unreachable server.
    expect(retryProtectedMutation(1, new ApiError(502, 'bad gateway'))).toBe(false);
  });

  test('the reconcile gate blocks further actions until committed state is re-read', () => {
    let state = IDLE_RECONCILE;
    expect(blocksFurtherActions(state)).toBe(false);

    state = beginReconcile(state, 1_000);
    expect(state.phase).toBe('checking');
    // This is the acceptance criterion: no further non-idempotent action while unknown.
    expect(blocksFurtherActions(state)).toBe(true);

    state = completeReconcile(state, 2_000);
    expect(state.phase).toBe('reconciled');
    expect(blocksFurtherActions(state)).toBe(false);

    state = clearReconcile();
    expect(state.phase).toBe('idle');
  });

  test('a burst of ambiguous failures produces ONE reconciliation, not one per click', () => {
    const first = beginReconcile(IDLE_RECONCILE, 1_000);
    const second = beginReconcile(first, 1_500);
    // Same object — the clock is not restarted, so a spammed HP stepper does not
    // livelock the gate by continually re-entering `checking`.
    expect(second).toBe(first);
    expect(second.phase === 'checking' && second.since).toBe(1_000);
  });

  test('completing a reconcile that never started is a no-op', () => {
    expect(completeReconcile(IDLE_RECONCILE, 5).phase).toBe('idle');
  });

  // ---------------------------------------------------------------------------
  // Wiring guards. The logic above is pure and cheap to test; these assert that the
  // combat surfaces actually go through it, since a correct helper nobody calls is
  // exactly the shape this regression would take if someone reverted a call site.
  // ---------------------------------------------------------------------------

  const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
  const TURN_WORKSPACE = resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx');
  const QUERY_CLIENT = resolve(__dirname, '../../src/lib/query.ts');

  test('the HP stepper and both turn controls are keyed mutations', () => {
    const src = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(src).toContain('const hpDelta = useKeyedMutation(');
    expect(src).toContain('const endTurn = useKeyedMutation(');
    expect(src).toContain('const nextTurnMut = useKeyedMutation(');
    // next-turn must also carry the cross-device CAS, not only the retry key.
    expect(src).toContain('expectedCurrentCombatantId');
    // Issue #1456: end-turn now lives once in the parent and is passed down.
    expect(readFileSync(TURN_WORKSPACE, 'utf8')).toContain('onEndTurn');
  });

  test('the combat surfaces route ambiguous failures into the gate, not the error banner', () => {
    const src = readFileSync(RUN_SESSION_PAGE, 'utf8');
    // Three call sites: HP stepper, end-turn, next-turn (plus bulk apply-to-all).
    expect(src.match(/isAmbiguousOutcome\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src).toContain('blocksFurtherActions(');
  });

  test('mutations do not auto-retry by default — retry is opt-in with a key', () => {
    const src = readFileSync(QUERY_CLIENT, 'utf8');
    // The whole point of #580's client half: no blanket mutation retry.
    expect(src).toMatch(/mutations:\s*\{[\s\S]*?retry:\s*false/);
  });
});

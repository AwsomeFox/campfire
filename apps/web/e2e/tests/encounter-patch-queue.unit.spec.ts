/**
 * Unit tests for encounter patch queue optimistic rollback (issue #1614).
 */
import { expect, test } from '@playwright/test';
import {
  isAdjacentDuplicateEncounterPatch,
  observedEncounterPatchRevision,
  reconcileEncounterPatchResponse,
  rollbackEncounterPatchError,
  type QueuedEncounterPatch,
} from '../../src/features/encounters/encounterPatchQueue';

test.describe('encounterPatchQueue unit tests — rollbackEncounterPatchError', () => {
  test('isAdjacentDuplicateEncounterPatch identifies adjacent identical pending patch', () => {
    const queue: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: '1:scale:1', pendingKey: '1:scale', patch: { gridScale: 5 } },
    ];
    expect(isAdjacentDuplicateEncounterPatch(queue, 1, '1:scale')).toBe(true);
    expect(isAdjacentDuplicateEncounterPatch(queue, 1, '1:unit')).toBe(false);
  });

  test('observedEncounterPatchRevision returns latest observed revision', () => {
    const queue: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: '1', pendingKey: 'k', observedUpdatedAt: 'rev-1', patch: {} },
    ];
    expect(observedEncounterPatchRevision(queue, 1, 'base')).toBe('rev-1');
  });

  test('reconcileEncounterPatchResponse applies remaining pending patches over updated response', () => {
    const updated = { id: 1, gridScale: 10, name: 'Boss Fight' };
    const pending: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: 'q1', pendingKey: 'k1', patch: { gridUnit: 'ft' } },
      { encounterId: 1, queueId: 'q2', pendingKey: 'k2', patch: { gridScale: 5 } },
    ];
    const reconciled = reconcileEncounterPatchResponse(updated, pending, 'q1', 1);
    expect(reconciled).toEqual({ id: 1, gridScale: 5, name: 'Boss Fight' });
  });

  test('rollbackEncounterPatchError restores previous values when failed patch has no overriding pending patch', () => {
    const current = { id: 1, gridSize: 8, gridScale: 5, gridUnit: 'ft' };
    const failedEntry: QueuedEncounterPatch = {
      encounterId: 1,
      queueId: 'q1',
      pendingKey: '1:scale',
      patch: { gridScale: 5 },
      previousValues: { gridScale: null },
    };
    const rolledBack = rollbackEncounterPatchError(current, failedEntry, [], 1);
    expect(rolledBack).toEqual({ id: 1, gridSize: 8, gridScale: null, gridUnit: 'ft' });
  });

  test('rollbackEncounterPatchError retains overriding pending patch value if present', () => {
    const current = { id: 1, gridSize: 8, gridScale: 5, gridUnit: 'ft' };
    const failedEntry: QueuedEncounterPatch = {
      encounterId: 1,
      queueId: 'q1',
      pendingKey: '1:scale',
      patch: { gridScale: 5 },
      previousValues: { gridScale: null },
    };
    const remaining: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: 'q2', pendingKey: '1:scale', patch: { gridScale: 10 } },
    ];
    const rolledBack = rollbackEncounterPatchError(current, failedEntry, remaining, 1);
    expect(rolledBack).toEqual({ id: 1, gridSize: 8, gridScale: 10, gridUnit: 'ft' });
  });
});

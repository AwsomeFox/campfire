/**
 * Issue #703 — pure-logic unit tests for the storage cleanup preview binding.
 *
 * These exercise the binding helpers (previewSignature / outcomeOf) in Node
 * without booting the server or a browser, complementing the browser e2e in
 * admin-storage-cleanup-preview.spec.ts. They pin the contract that makes the
 * safety guarantee: two previews of the same orphan set produce the same
 * fingerprint, any drift invalidates it, and a real run's per-item failures are
 * surfaced as a non-zero delta rather than reported as clean success.
 */
import { expect, test } from '@playwright/test';
import { previewSignature, outcomeOf } from '../../src/features/admin/StorageCard';
import type { StorageCleanupResult, StorageStats } from '@campfire/schema';

const dry = (rowsWithoutFile: number, filesWithoutRow: number): StorageCleanupResult => ({
  dryRun: true,
  rowsWithoutFile,
  filesWithoutRow,
  rowsDeleted: 0,
  filesDeleted: 0,
  bytesReclaimed: 0,
});

const snap = (fileCount: number, diskBytes: number): Pick<StorageStats, 'fileCount' | 'diskBytes'> => ({
  fileCount,
  diskBytes,
});

test.describe('issue #703: previewSignature binds the deletion set', () => {
  test('identical previews of the same set are stable', () => {
    const a = previewSignature(dry(2, 1), snap(5, 1000));
    const b = previewSignature(dry(2, 1), snap(5, 1000));
    expect(a).toBe(b);
    expect(a).toContain('r=2');
    expect(a).toContain('f=1');
  });

  test('a changed orphan set invalidates the binding', () => {
    const bound = previewSignature(dry(2, 1), snap(5, 1000));
    // Set grew between preview and execute -> must NOT match.
    const drifted = previewSignature(dry(5, 1), snap(5, 1000));
    expect(bound).not.toBe(drifted);
  });

  test('a wider storage change (new upload) invalidates the binding', () => {
    const bound = previewSignature(dry(2, 1), snap(5, 1000));
    // Orphan counts identical, but an upload landed (fileCount + diskBytes
    // moved) -> the snapshot the preview was bound to is stale.
    const afterUpload = previewSignature(dry(2, 1), snap(6, 1500));
    expect(bound).not.toBe(afterUpload);
  });
});

test.describe('issue #703: outcomeOf surfaces partial failures', () => {
  test('a fully successful run reports zero failure deltas', () => {
    const oc = outcomeOf({
      dryRun: false,
      rowsWithoutFile: 2,
      filesWithoutRow: 1,
      rowsDeleted: 2,
      filesDeleted: 1,
      bytesReclaimed: 500,
    });
    expect(oc.rowFailures).toBe(0);
    expect(oc.fileFailures).toBe(0);
  });

  test('an unlink failure is reported, not silently dropped', () => {
    // Server found 1 orphan file but couldn't remove it -> filesDeleted < found.
    const oc = outcomeOf({
      dryRun: false,
      rowsWithoutFile: 2,
      filesWithoutRow: 1,
      rowsDeleted: 2,
      filesDeleted: 0,
      bytesReclaimed: 0,
    });
    expect(oc.fileFailures).toBe(1);
    expect(oc.rowFailures).toBe(0);
  });

  test('a partial row failure is reported', () => {
    const oc = outcomeOf({
      dryRun: false,
      rowsWithoutFile: 3,
      filesWithoutRow: 0,
      rowsDeleted: 1, // two rows survived the delete
      filesDeleted: 0,
      bytesReclaimed: 0,
    });
    expect(oc.rowFailures).toBe(2);
    expect(oc.fileFailures).toBe(0);
  });
});

/**
 * Source-level guards for RegionMap pin drag recovery (#808).
 *
 * Playwright e2e specs in map-pin-drag-recovery.spec.ts cover DOM behavior.
 * These asserts pin the structural fixes that are easy to regress in review:
 * owning pointer id, cancel/lostcapture handlers, page-hide/unmount recovery,
 * and commit-only-from-matching-pointerup.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGION_MAP = resolve(__dirname, '../../src/features/dashboard/RegionMap.tsx');

test.describe('RegionMap pin drag recovery source guards (#808)', () => {
  const src = readFileSync(REGION_MAP, 'utf8');

  test('stores the owning pointer id on an active drag ref', () => {
    expect(src).toMatch(/activeDragRef/);
    expect(src).toMatch(/pointerId:\s*e\.pointerId/);
    expect(src).toMatch(/type ActivePinDrag/);
  });

  test('registers cancellation and capture-loss recovery handlers', () => {
    expect(src).toContain('onPointerCancel={onSurfacePointerCancel}');
    expect(src).toContain('onLostPointerCapture={onSurfaceLostPointerCapture}');
    expect(src).toMatch(/function onSurfacePointerCancel/);
    expect(src).toMatch(/function onSurfaceLostPointerCapture/);
  });

  test('clears drag on visibility hide, pagehide, orientationchange, and unmount', () => {
    expect(src).toContain("addEventListener('visibilitychange'");
    expect(src).toContain("addEventListener('pagehide'");
    expect(src).toContain("addEventListener('orientationchange'");
    expect(src).toMatch(/cancelActiveDrag\(undefined,\s*false\)/);
  });

  test('commits only from a matching successful pointerup', () => {
    expect(src).toMatch(/successfulPointerUpRef/);
    expect(src).toMatch(/drag\.pointerId !== e\.pointerId\) return/);
    expect(src).toMatch(/successfulPointerUpRef\.current = e\.pointerId/);
    expect(src).toMatch(/void savePinPercent\(drag\.locationId/);
  });

  test('cancel path restores preview without calling savePinPercent', () => {
    expect(src).toContain('const cancelActiveDrag = useCallback');
    expect(src).toContain('clearDragPreview()');
    // The cancel helper must never call the PATCH path — only pointerup may.
    const cancelStart = src.indexOf('const cancelActiveDrag = useCallback');
    const nextHook = src.indexOf('useEffect(() => {', cancelStart);
    expect(cancelStart).toBeGreaterThanOrEqual(0);
    expect(nextHook).toBeGreaterThan(cancelStart);
    const cancelFn = src.slice(cancelStart, nextHook);
    expect(cancelFn).not.toMatch(/savePinPercent/);
  });
});

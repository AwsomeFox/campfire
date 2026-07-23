/**
 * Source-level guards for RegionMap keyboard pin UX (#807 closeout).
 *
 * Playwright unit specs already cover DOM behavior in map-pin-keyboard.spec.ts.
 * These asserts pin the structural fixes that are easy to regress in review:
 * integer percent seeding/storage, AbortController/generation cancel of saves,
 * drag gating while kbMovingId is set, focus-on-Move, and announceKb RAF cleanup.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGION_MAP = resolve(__dirname, '../../src/features/dashboard/RegionMap.tsx');

test.describe('RegionMap keyboard pin source guards (#807)', () => {
  const src = readFileSync(REGION_MAP, 'utf8');

  test('seeds kbPos through clampPercentInt (integer percents)', () => {
    expect(src).toMatch(/function clampPercentInt/);
    expect(src).toMatch(/const x = clampPercentInt\(loc\.mapX \?\? 50\)/);
    expect(src).toMatch(/const y = clampPercentInt\(loc\.mapY \?\? 50\)/);
  });

  test('coordinate inputs store clampPercentInt values', () => {
    expect(src).toMatch(/const v = clampPercentInt\(Number\(e\.target\.value\) \|\| 0\)/);
    // Display value is the integer state itself (not Math.round of a fractional store).
    expect(src).toMatch(/value=\{kbPos\.x\}/);
    expect(src).toMatch(/value=\{kbPos\.y\}/);
  });

  test('cancel invalidates in-flight save via generation + AbortController', () => {
    expect(src).toMatch(/kbSaveGen/);
    expect(src).toMatch(/kbSaveAbort/);
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/kbSaveGen\.current \+= 1/);
    expect(src).toMatch(/kbSaveAbort\.current\?\.abort\(\)/);
    expect(src).toMatch(/gen !== kbSaveGen\.current/);
  });

  test('pointer drag is gated while kbMovingId is set', () => {
    expect(src).toMatch(/kbMovingId != null\) return/);
    expect(src).toContain('if (!isDm || !mapImageUrl || kbMovingId != null) return;');
  });

  test('Move focuses the horizontal input so arrows work immediately', () => {
    expect(src).toMatch(/kbXInputRef/);
    expect(src).toMatch(/kbXInputRef\.current\?\.focus\(\)/);
    expect(src).toMatch(/ref=\{kbXInputRef\}/);
  });

  test('announceKb RAF is canceled on unmount', () => {
    expect(src).toMatch(/cancelAnimationFrame\(kbAnnounceRaf\.current\)/);
    // Unmount cleanup effect clears the pending frame.
    expect(src).toMatch(/return \(\) => \{\s*if \(kbAnnounceRaf\.current != null\)/);
  });
});

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
    // Whitespace-tolerant: gate must refuse drag when kbMovingId is set
    // (combined early-return or separate check after isDm/mapImageUrl).
    expect(src).toMatch(/kbMovingId\s*!=\s*null/);
    const combinedGate =
      /if\s*\(\s*!isDm\s*\|\|\s*!mapImageUrl\s*\|\|\s*kbMovingId\s*!=\s*null\s*\)\s*return\s*;/.test(
        src,
      );
    const splitGate =
      /if\s*\(\s*!isDm\s*\|\|\s*!mapImageUrl\s*\)\s*return\s*;/.test(src) &&
      /if\s*\(\s*kbMovingId\s*!=\s*null\s*\)\s*return\s*;/.test(src);
    expect(combinedGate || splitGate).toBe(true);
  });

  test('keyboard save defers onChange until after cancel generation check', () => {
    // refresh:false keeps late PATCH completions from reloading parent data
    // before saveKbMove can honor Cancel/Escape via kbSaveGen.
    expect(src).toMatch(/refresh:\s*false/);
    expect(src).toMatch(/signal\?\.aborted/);
    expect(src).toMatch(/if\s*\(\s*refresh\s*\)\s*onChange\(\)/);
    expect(src).toMatch(
      /gen !== kbSaveGen\.current \|\| controller\.signal\.aborted[\s\S]*?onChange\(\)/,
    );
  });

  test('Move focuses the horizontal input so arrows work immediately', () => {
    expect(src).toMatch(/kbXInputRef/);
    expect(src).toMatch(/kbXInputRef\.current\?\.focus\(\)/);
    expect(src).toMatch(/ref=\{kbXInputRef\}/);
  });

  test('announceKb RAF and in-flight kb save are canceled on unmount', () => {
    expect(src).toMatch(/cancelAnimationFrame\(\s*kbAnnounceRaf\.current\s*\)/);
    // Unmount cleanup clears the pending frame and aborts any keyboard save.
    expect(src).toMatch(
      /return\s*\(\s*\)\s*=>\s*\{[\s\S]*?kbAnnounceRaf\.current[\s\S]*?kbSaveAbort\.current\?\.abort\(\)/,
    );
  });
});

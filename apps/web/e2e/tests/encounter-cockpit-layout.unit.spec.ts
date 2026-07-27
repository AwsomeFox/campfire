/**
 * Encounter cockpit layout contracts (issue #669).
 *
 * Keep the responsive arrangement explicit: mobile retains document-order flow,
 * while `lg` makes the activity rail a fixed-width sticky sibling of the tracker.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('encounter cockpit layout (issue #669)', () => {
  test('uses a two-column sticky activity rail from the lg breakpoint', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toMatch(/data-testid="encounter-cockpit"/);
    expect(source).toMatch(/max-w-4xl lg:max-w-6xl/);
    expect(source).toMatch(/grid gap-4 min-w-0 lg:grid-cols-\[minmax\(0,1fr\)_20rem\]/);
    expect(source).toMatch(/min-w-0 space-y-4 lg:sticky lg:top-4/);
    expect(source).toMatch(/lg:max-h-\[calc\(100vh-1rem\)\] lg:overflow-y-auto lg:overscroll-contain/);
    expect(source).toMatch(/<aside[^>]*aria-label="Encounter activity"[\s\S]*<CombatLog[\s\S]*<SharedDiceLog/);
  });
});

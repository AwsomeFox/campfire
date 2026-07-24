/**
 * Reopen-encounter ConfirmDialog (issues #493 / #466).
 *
 * After #466, reopen no longer warns about a silent overwrite — it surfaces
 * per-character conflicts and requires an explicit resync direction.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('Reopen encounter confirmation (issues #493 / #466)', () => {
  test('requires hp resync choices instead of warning about silent overwrite', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/title="Reopen this encounter\?"/);
    expect(source).toMatch(/data-testid="hp-resync-conflicts"/);
    expect(source).toMatch(/pull_sheet/);
    expect(source).toMatch(/keep_combatant/);
    expect(source).toMatch(/Keep sheet HP/);
    expect(source).toMatch(/Keep combat snapshot/);
    expect(source).toMatch(/choose which\s*\n?\s*HP to keep/i);
    // The pre-#466 silent-overwrite warning must be gone.
    expect(source).not.toMatch(/silently overwritten/);
  });
});
